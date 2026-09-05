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
  mergePowerReadings,
  parseNvidiaOutput
} = require('./monitor-core');
const { getWebviewHtml } = require('./monitor-view');
const { createLinuxSensorCollector, createMacSensorCollector } = require('./system-sensors');

const VIEW_ID = 'cutieboard.monitorView';

function createSystemMetricsCollector({
  os: systemOs,
  execFile: runFile,
  now = Date.now,
  collectSensors = async () => ({ cpuTemperature: undefined, power: { available: false } })
}) {
  let previousCpu = systemOs.cpus();
  const platform = typeof systemOs.platform === 'function' ? systemOs.platform() : undefined;
  const arch = typeof systemOs.arch === 'function' ? systemOs.arch() : undefined;
  const unified = isUnifiedMemory({ platform, arch });

  const collectGpu = () => new Promise((resolve) => {
    runFile(
      'nvidia-smi',
      [
        '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit',
        '--format=csv,noheader,nounits'
      ],
      { timeout: 1200, windowsHide: true },
      (error, stdout) => {
        resolve(error ? { available: false } : parseNvidiaOutput(stdout));
      }
    );
  });

  return async () => {
    const currentCpu = systemOs.cpus();
    const totalMemory = systemOs.totalmem();
    const usedMemory = totalMemory - systemOs.freemem();
    const cpuUsage = calculateCpuUsage(previousCpu, currentCpu);
    previousCpu = currentCpu;
    const [gpu, sensors] = await Promise.all([collectGpu(), collectSensors()]);

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
  let webview;
  let latestMetrics;
  let latestError;

  const postState = () => {
    webview?.postMessage({
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

  const schedule = () => {
    if (!active) return;
    if (timer !== undefined) clearTimer(timer);
    const interval = vscodeApi.workspace
      .getConfiguration('cutieboard')
      .get('refreshInterval', 2000);
    timer = setTimer(async () => {
      await sample(false);
      schedule();
    }, interval);
  };

  const focusMonitor = async () => {
    await vscodeApi.commands.executeCommand('workbench.view.explorer');
    await vscodeApi.commands.executeCommand(`${VIEW_ID}.focus`);
  };

  const provider = {
    resolveWebviewView(webviewView) {
      webview = webviewView.webview;
      webview.options = { enableScripts: true };
      const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
      webview.html = getWebviewHtml(nonce);
      postState();
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
      vscodeApi.commands.registerCommand('cutieboard.startSession', focusMonitor),
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
    await sample(true);
    schedule();
  };

  const deactivate = () => {
    active = false;
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
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
  return async () => ({ cpuTemperature: undefined, power: { available: false } });
}

const collectSensors = createSensorCollector(os.platform(), { fs, execFile });

const runtime = createCutieboardRuntime({
  vscode,
  collectMetrics: createSystemMetricsCollector({ os, execFile, collectSensors })
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
