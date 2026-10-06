'use strict';

const vscode = require('vscode');
const os = require('os');
const fs = require('fs').promises;
const { execFile } = require('child_process');
const {
  AsyncSampler,
  TelemetryStore,
  calculateCpuUsage,
  isUnifiedMemory,
  mergePowerReadings
} = require('./monitor-core');
const { getWebviewHtml } = require('./monitor-view');
const {
  createLinuxSensorCollector,
  createMacSensorCollector,
  createNvidiaCollector,
  createWindowsSensorCollector
} = require('./system-sensors');

const VIEW_ID = 'cutieboard.monitorView';
// CPU usage is a delta between two os.cpus() snapshots. A window of a few
// milliseconds is noise; one spanning a long hidden period is a stale average.
const CPU_MIN_WINDOW_MS = 250;
const CPU_MAX_WINDOW_MS = 20000;

function createSystemMetricsCollector({
  os: systemOs,
  execFile: runFile,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  collectSensors = async () => ({ cpuTemperature: undefined, power: { available: false } }),
  collectGpu = createNvidiaCollector({ execFile: runFile })
}) {
  let previousCpu;
  let previousCpuAt = -Infinity;
  let cpuBaselineVersion = 0;
  const platform = typeof systemOs.platform === 'function' ? systemOs.platform() : undefined;
  const arch = typeof systemOs.arch === 'function' ? systemOs.arch() : undefined;
  const unified = isUnifiedMemory({ platform, arch });

  const sampleCpu = async () => {
    const version = cpuBaselineVersion;
    const age = now() - previousCpuAt;
    let baseline = previousCpu;
    if (!baseline || age < CPU_MIN_WINDOW_MS || age > CPU_MAX_WINDOW_MS) {
      baseline = systemOs.cpus();
      await sleep(CPU_MIN_WINDOW_MS);
    }
    const currentCpu = systemOs.cpus();
    const usage = calculateCpuUsage(baseline, currentCpu);
    // A hidden/disposed view must stay invalidated even if a sample was
    // already waiting for its CPU window when the visibility changed.
    if (version === cpuBaselineVersion) {
      previousCpu = currentCpu;
      previousCpuAt = now();
    }
    return { currentCpu, usage };
  };

  const collect = async () => {
    const [{ currentCpu, usage: cpuUsage }, gpu, sensors] = await Promise.all([
      sampleCpu(), collectGpu(), collectSensors()
    ]);
    const totalMemory = systemOs.totalmem();
    const availableMemory = Number.isFinite(sensors.availableMemory)
      && sensors.availableMemory >= 0
      && sensors.availableMemory <= totalMemory
      ? sensors.availableMemory
      : systemOs.freemem();
    const usedMemory = totalMemory - availableMemory;

    return {
      host: systemOs.hostname(),
      uptime: systemOs.uptime(),
      sampledAt: now(),
      cpu: {
        usage: cpuUsage,
        cores: currentCpu.length,
        model: currentCpu[0]?.model || 'Unknown CPU',
        load: systemOs.loadavg(),
        ...(Number.isFinite(sensors.cpuTemperature) ? { temperature: sensors.cpuTemperature } : {})
      },
      memory: { used: usedMemory, total: totalMemory, ...(unified ? { unified: true } : {}) },
      gpu: gpu.available && unified ? { ...gpu, memoryShared: true } : gpu,
      power: mergePowerReadings(sensors.power, gpu)
    };
  };
  collect.invalidateCpuBaseline = () => {
    cpuBaselineVersion += 1;
    previousCpu = undefined;
    previousCpuAt = -Infinity;
  };
  return collect;
}

function createCutieboardRuntime({
  vscode: vscodeApi,
  collectMetrics,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  const store = new TelemetryStore(60);
  let active = false;
  let timer;
  let view;
  let latestMetrics;
  let latestError;

  const postState = () => {
    view?.webview.postMessage({
      type: 'cutieboard.state',
      metrics: latestMetrics,
      paused: sampler.paused,
      error: latestError
    });
  };

  const sampler = new AsyncSampler({
    collect: collectMetrics,
    onSample: (metrics) => {
      latestMetrics = store.record(metrics);
      latestError = undefined;
      postState();
    }
  });

  const sample = async (force = false) => {
    try {
      return await sampler.sample({ force });
    } catch (error) {
      latestError = error instanceof Error ? error.message : String(error);
      postState();
      return false;
    }
  };

  // Sampling runs only while the view is on screen: every tick spawns
  // nvidia-smi (which keeps a laptop dGPU out of runtime suspend) and, on
  // Windows, PowerShell. Nobody is reading the numbers when it's hidden.
  const isVisible = () => active && Boolean(view?.visible);

  const stopTimer = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };

  const schedule = () => {
    stopTimer();
    if (!isVisible()) return;
    const interval = vscodeApi.workspace
      .getConfiguration('cutieboard')
      .get('refreshInterval', 2000);
    timer = setTimer(async () => {
      timer = undefined;
      if (!isVisible()) return;
      await sample(false);
      schedule();
    }, interval);
  };

  const onVisibilityChanged = async () => {
    if (!isVisible()) {
      stopTimer();
      collectMetrics.invalidateCpuBaseline?.();
      return;
    }
    await sample(false);
    schedule();
  };

  const focusMonitor = async () => {
    await vscodeApi.commands.executeCommand('workbench.view.explorer');
    await vscodeApi.commands.executeCommand(`${VIEW_ID}.focus`);
  };

  const provider = {
    resolveWebviewView(webviewView) {
      view = webviewView;
      const { webview } = webviewView;
      webview.options = { enableScripts: true };
      const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
      webview.html = getWebviewHtml(nonce);
      webviewView.onDidChangeVisibility(onVisibilityChanged);
      webviewView.onDidDispose(() => {
        if (view === webviewView) {
          view = undefined;
          stopTimer();
          collectMetrics.invalidateCpuBaseline?.();
        }
      });
      postState();
      onVisibilityChanged();
    }
  };

  const activate = async (context) => {
    if (active) return;
    active = true;

    context.subscriptions.push(
      vscodeApi.window.registerWebviewViewProvider(
        VIEW_ID,
        provider,
        { webviewOptions: { retainContextWhenHidden: true } }
      ),
      vscodeApi.commands.registerCommand('cutieboard.focusMonitor', focusMonitor),
      vscodeApi.commands.registerCommand('cutieboard.refresh', () => sample(true)),
      vscodeApi.commands.registerCommand('cutieboard.pause', async () => {
        sampler.pause();
        await vscodeApi.commands.executeCommand('setContext', 'cutieboard.paused', true);
        postState();
      }),
      vscodeApi.commands.registerCommand('cutieboard.resume', async () => {
        sampler.resume();
        await vscodeApi.commands.executeCommand('setContext', 'cutieboard.paused', false);
        postState();
        await sample(true);
      }),
      vscodeApi.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('cutieboard.refreshInterval')) schedule();
      })
    );

    await vscodeApi.commands.executeCommand('setContext', 'cutieboard.paused', false);
  };

  const deactivate = () => {
    active = false;
    stopTimer();
    collectMetrics.invalidateCpuBaseline?.();
  };

  return { activate, deactivate };
}

function createSensorCollector(platform, { fs: fileSystem, execFile: runFile } = { fs, execFile }) {
  if (platform === 'linux') {
    return createLinuxSensorCollector({
      readDirectory: (filePath) => fileSystem.readdir(filePath),
      readText: (filePath) => fileSystem.readFile(filePath, 'utf8')
    });
  }
  if (platform === 'darwin') {
    return createMacSensorCollector({ execFile: runFile });
  }
  if (platform === 'win32') {
    return createWindowsSensorCollector({ execFile: runFile });
  }
  return async () => ({ cpuTemperature: undefined, power: { available: false } });
}

const collectSensors = createSensorCollector(os.platform(), { fs, execFile });

const collectGpu = createNvidiaCollector({
  execFile,
  readDirectory: (filePath) => fs.readdir(filePath),
  readText: (filePath) => fs.readFile(filePath, 'utf8')
});

const runtime = createCutieboardRuntime({
  vscode,
  collectMetrics: createSystemMetricsCollector({ os, execFile, collectSensors, collectGpu })
});

function activate(context) {
  return runtime.activate(context);
}

function deactivate() {
  runtime.deactivate();
}

module.exports = {
  activate,
  deactivate,
  _test: { createCutieboardRuntime, createSystemMetricsCollector, createSensorCollector }
};
