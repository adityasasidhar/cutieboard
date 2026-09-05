const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadExtension(vscode) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve('../extension')];
  try {
    return require('../extension');
  } finally {
    Module._load = originalLoad;
  }
}

function createVscodeDouble() {
  const commandHandlers = new Map();
  const executed = [];
  const registeredViews = [];
  const disposable = { dispose() {} };
  const vscode = {
    Uri: { file: (value) => value },
    window: {
      registerWebviewViewProvider(id, provider, options) {
        registeredViews.push({ id, provider, options });
        return disposable;
      }
    },
    commands: {
      registerCommand(id, handler) {
        commandHandlers.set(id, handler);
        return disposable;
      },
      async executeCommand(...args) {
        executed.push(args);
      }
    },
    workspace: {
      getConfiguration() {
        return { get: (_key, fallback) => fallback };
      },
      onDidChangeConfiguration() { return disposable; }
    }
  };
  return { vscode, commandHandlers, executed, registeredViews };
}

test('activates a persistent Explorer monitor with working native actions', async () => {
  const api = createVscodeDouble();
  const extension = loadExtension(api.vscode);
  let collections = 0;
  let timerCleared = false;
  const metrics = {
    host: 'test-host',
    uptime: 3600,
    sampledAt: 1,
    cpu: { usage: 20, cores: 8, model: 'Test CPU', load: [1, 2, 3] },
    memory: { used: 4, total: 8 },
    gpu: { available: false }
  };
  const runtime = extension._test.createCutieboardRuntime({
    vscode: api.vscode,
    collectMetrics: async () => { collections += 1; return metrics; },
    setTimer: () => 99,
    clearTimer: (timer) => { timerCleared = timer === 99; }
  });
  const context = { extensionUri: '/extension', subscriptions: [] };

  await runtime.activate(context);

  assert.equal(collections, 1);
  assert.equal(api.registeredViews[0].id, 'cutieboard.monitorView');
  assert.deepEqual(api.registeredViews[0].options, {
    webviewOptions: { retainContextWhenHidden: true }
  });

  const messages = [];
  const webview = {
    options: {},
    html: '',
    postMessage(message) { messages.push(message); }
  };
  api.registeredViews[0].provider.resolveWebviewView({ webview });
  assert.match(webview.html, /id="cpu-section"/);
  assert.equal(messages.at(-1).metrics.host, 'test-host');

  await api.commandHandlers.get('cutieboard.pause')();
  assert.equal(messages.at(-1).paused, true);
  await api.commandHandlers.get('cutieboard.refresh')();
  assert.equal(collections, 2);
  assert.equal(messages.at(-1).paused, true);
  await api.commandHandlers.get('cutieboard.resume')();
  assert.equal(collections, 3);
  assert.equal(messages.at(-1).paused, false);

  await api.commandHandlers.get('cutieboard.focusMonitor')();
  assert.deepEqual(api.executed.slice(-2), [
    ['workbench.view.explorer'],
    ['cutieboard.monitorView.focus']
  ]);

  runtime.deactivate();
  assert.equal(timerCleared, true);
});

test('collects cross-platform system metrics and parsed NVIDIA telemetry', async () => {
  const api = createVscodeDouble();
  const extension = loadExtension(api.vscode);
  const cpuSamples = [
    [{ model: 'Test CPU', times: { user: 100, nice: 0, sys: 0, idle: 100, irq: 0 } }],
    [{ model: 'Test CPU', times: { user: 160, nice: 0, sys: 0, idle: 140, irq: 0 } }]
  ];
  const fakeOs = {
    cpus: () => cpuSamples.shift(),
    totalmem: () => 16 * 1073741824,
    freemem: () => 6 * 1073741824,
    hostname: () => 'workstation',
    uptime: () => 7200,
    loadavg: () => [1, 2, 3]
  };
  const fakeExecFile = (_file, _args, _options, callback) => {
    callback(null, 'NVIDIA RTX, 75, 4096, 8192, 68, 82.5, 120');
  };
  const collect = extension._test.createSystemMetricsCollector({
    os: fakeOs,
    execFile: fakeExecFile,
    now: () => 1234,
    collectSensors: async () => ({
      cpuTemperature: 61,
      power: { available: true, watts: 70, cpuWatts: 25, source: 'platform' }
    })
  });

  assert.deepEqual(await collect(), {
    host: 'workstation',
    uptime: 7200,
    sampledAt: 1234,
    cpu: { usage: 60, cores: 1, model: 'Test CPU', load: [1, 2, 3], temperature: 61 },
    memory: { used: 10 * 1073741824, total: 16 * 1073741824 },
    gpu: {
      available: true,
      name: 'NVIDIA RTX',
      utilization: 75,
      memoryUsed: 4096,
      memoryTotal: 8192,
      temperature: 68,
      powerDraw: 82.5,
      powerLimit: 120
    },
    power: {
      available: true,
      watts: 70,
      cpuWatts: 25,
      gpuWatts: 82.5,
      source: 'platform'
    }
  });
});

test('flags unified memory and shared GPU memory on Apple Silicon', async () => {
  const api = createVscodeDouble();
  const extension = loadExtension(api.vscode);
  const cpuSamples = [
    [{ model: 'Apple M1', times: { user: 100, nice: 0, sys: 0, idle: 100, irq: 0 } }],
    [{ model: 'Apple M1', times: { user: 160, nice: 0, sys: 0, idle: 140, irq: 0 } }]
  ];
  const fakeOs = {
    cpus: () => cpuSamples.shift(),
    totalmem: () => 16 * 1073741824,
    freemem: () => 6 * 1073741824,
    hostname: () => 'macbook',
    uptime: () => 7200,
    loadavg: () => [1, 2, 3],
    platform: () => 'darwin',
    arch: () => 'arm64'
  };
  const fakeExecFile = (_file, _args, _options, callback) => {
    callback(null, 'Apple M1, 42, 2048, 16384, 60, 8.5, 15');
  };
  const collect = extension._test.createSystemMetricsCollector({
    os: fakeOs,
    execFile: fakeExecFile,
    now: () => 1234,
    collectSensors: async () => ({ cpuTemperature: undefined, power: { available: false } })
  });

  const metrics = await collect();
  assert.equal(metrics.memory.unified, true);
  assert.equal(metrics.gpu.memoryShared, true);
  assert.equal(metrics.gpu.available, true);
});
