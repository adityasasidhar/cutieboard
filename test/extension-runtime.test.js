const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadExtension(vscode) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve('../src/extension')];
  try {
    return require('../src/extension');
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

function createTimerDouble() {
  const pending = new Map();
  let nextId = 1;
  return {
    pending,
    setTimer(callback, delay) {
      const id = nextId++;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    async fireNext() {
      const [id, { callback }] = pending.entries().next().value;
      pending.delete(id);
      await callback();
    }
  };
}

function createWebviewViewDouble({ visible = true } = {}) {
  const messages = [];
  const visibilityListeners = [];
  const disposeListeners = [];
  const view = {
    visible,
    webview: {
      options: {},
      html: '',
      postMessage(message) { messages.push(message); }
    },
    onDidChangeVisibility(listener) {
      visibilityListeners.push(listener);
      return { dispose() {} };
    },
    onDidDispose(listener) {
      disposeListeners.push(listener);
      return { dispose() {} };
    }
  };
  return {
    view,
    messages,
    async setVisible(value) {
      view.visible = value;
      for (const listener of visibilityListeners) await listener();
    },
    async dispose() {
      view.visible = false;
      for (const listener of disposeListeners) await listener();
    }
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const sampleMetrics = {
  host: 'test-host',
  uptime: 3600,
  sampledAt: 1,
  cpu: { usage: 20, cores: 8, model: 'Test CPU', load: [1, 2, 3] },
  memory: { used: 4, total: 8 },
  gpu: { available: false }
};

test('does not sample or schedule anything until the monitor view is shown', async () => {
  const api = createVscodeDouble();
  const extension = loadExtension(api.vscode);
  const timers = createTimerDouble();
  let collections = 0;
  const runtime = extension._test.createCutieboardRuntime({
    vscode: api.vscode,
    collectMetrics: async () => { collections += 1; return sampleMetrics; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });

  await runtime.activate({ subscriptions: [] });

  assert.equal(collections, 0);
  assert.equal(timers.pending.size, 0);
});

test('samples only while the view is visible and resumes with a fresh sample', async () => {
  const api = createVscodeDouble();
  const extension = loadExtension(api.vscode);
  const timers = createTimerDouble();
  let collections = 0;
  const runtime = extension._test.createCutieboardRuntime({
    vscode: api.vscode,
    collectMetrics: async () => { collections += 1; return sampleMetrics; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  await runtime.activate({ subscriptions: [] });
  const panel = createWebviewViewDouble({ visible: true });

  api.registeredViews[0].provider.resolveWebviewView(panel.view);
  await flush();
  assert.equal(collections, 1);
  assert.equal(panel.messages.at(-1).metrics.host, 'test-host');
  assert.equal(timers.pending.size, 1);

  await panel.setVisible(false);
  assert.equal(timers.pending.size, 0);

  await panel.setVisible(true);
  await flush();
  assert.equal(collections, 2);
  assert.equal(timers.pending.size, 1);

  await panel.dispose();
  assert.equal(timers.pending.size, 0);
});

test('a timer tick that fires after the view hides does not reschedule itself', async () => {
  const api = createVscodeDouble();
  const extension = loadExtension(api.vscode);
  const timers = createTimerDouble();
  let collections = 0;
  const runtime = extension._test.createCutieboardRuntime({
    vscode: api.vscode,
    collectMetrics: async () => { collections += 1; return sampleMetrics; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  await runtime.activate({ subscriptions: [] });
  const panel = createWebviewViewDouble({ visible: true });
  api.registeredViews[0].provider.resolveWebviewView(panel.view);
  await flush();

  await timers.fireNext();
  assert.equal(collections, 2);
  assert.equal(timers.pending.size, 1);

  panel.view.visible = false;
  await timers.fireNext();
  assert.equal(collections, 2);
  assert.equal(timers.pending.size, 0);
});

test('keeps native view actions working', async () => {
  const api = createVscodeDouble();
  const extension = loadExtension(api.vscode);
  const timers = createTimerDouble();
  let collections = 0;
  const runtime = extension._test.createCutieboardRuntime({
    vscode: api.vscode,
    collectMetrics: async () => { collections += 1; return sampleMetrics; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  await runtime.activate({ subscriptions: [] });

  assert.equal(api.registeredViews[0].id, 'cutieboard.monitorView');
  assert.deepEqual(api.registeredViews[0].options, {
    webviewOptions: { retainContextWhenHidden: true }
  });

  const panel = createWebviewViewDouble({ visible: true });
  api.registeredViews[0].provider.resolveWebviewView(panel.view);
  await flush();
  assert.match(panel.view.webview.html, /id="cpu-section"/);
  assert.equal(collections, 1);

  await api.commandHandlers.get('cutieboard.pause')();
  assert.equal(panel.messages.at(-1).paused, true);
  await api.commandHandlers.get('cutieboard.refresh')();
  assert.equal(collections, 2);
  assert.equal(panel.messages.at(-1).paused, true);
  await api.commandHandlers.get('cutieboard.resume')();
  assert.equal(collections, 3);
  assert.equal(panel.messages.at(-1).paused, false);

  await api.commandHandlers.get('cutieboard.focusMonitor')();
  assert.deepEqual(api.executed.slice(-2), [
    ['workbench.view.explorer'],
    ['cutieboard.monitorView.focus']
  ]);

  runtime.deactivate();
  assert.equal(timers.pending.size, 0);
});

test('registers only commands the manifest declares', async () => {
  const api = createVscodeDouble();
  const extension = loadExtension(api.vscode);
  const manifest = require('../package.json');
  const runtime = extension._test.createCutieboardRuntime({
    vscode: api.vscode,
    collectMetrics: async () => sampleMetrics,
    setTimer: () => 1,
    clearTimer: () => {}
  });

  await runtime.activate({ subscriptions: [] });

  const declared = manifest.contributes.commands.map((entry) => entry.command).sort();
  assert.deepEqual([...api.commandHandlers.keys()].sort(), declared);
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
    sleep: async () => {},
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
    sleep: async () => {},
    collectSensors: async () => ({ cpuTemperature: undefined, power: { available: false } })
  });

  const metrics = await collect();
  assert.equal(metrics.memory.unified, true);
  assert.equal(metrics.gpu.memoryShared, true);
  assert.equal(metrics.gpu.available, true);
});

test('prefers a platform available-memory reading over os.freemem', async () => {
  const api = createVscodeDouble();
  const extension = loadExtension(api.vscode);
  const fakeOs = {
    cpus: () => [{ model: 'Apple M1', times: { user: 100, nice: 0, sys: 0, idle: 100, irq: 0 } }],
    totalmem: () => 16 * 1073741824,
    freemem: () => 1 * 1073741824,
    hostname: () => 'macbook',
    uptime: () => 7200,
    loadavg: () => [1, 2, 3]
  };
  const collect = extension._test.createSystemMetricsCollector({
    os: fakeOs,
    execFile: (_file, _args, _options, callback) => callback(new Error('no nvidia-smi')),
    sleep: async () => {},
    collectSensors: async () => ({
      cpuTemperature: undefined,
      power: { available: false },
      availableMemory: 10 * 1073741824
    })
  });

  const metrics = await collect();
  assert.equal(metrics.memory.used, 6 * 1073741824);
});

test('measures CPU over a fresh short window on the first sample and after a long gap', async () => {
  const api = createVscodeDouble();
  const extension = loadExtension(api.vscode);
  const cpu = (user, idle) => [{ model: 'Test CPU', times: { user, nice: 0, sys: 0, idle, irq: 0 } }];
  const snapshots = [
    cpu(100, 100), cpu(130, 110), // first sample: 30 busy of 40 → 75%
    cpu(150, 130), // 2 s later: 20 busy of 40 since the last snapshot → 50%
    cpu(10000, 100000), cpu(10010, 100010) // 10 min later: fresh window → 50%
  ];
  let clock = 0;
  const waits = [];
  const collect = extension._test.createSystemMetricsCollector({
    os: {
      cpus: () => snapshots.shift(),
      totalmem: () => 8,
      freemem: () => 4,
      hostname: () => 'host',
      uptime: () => 1,
      loadavg: () => [0, 0, 0]
    },
    execFile: (_file, _args, _options, callback) => callback(new Error('no nvidia-smi')),
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; }
  });

  assert.equal((await collect()).cpu.usage, 75);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 200);

  clock += 2000;
  assert.equal((await collect()).cpu.usage, 50);
  assert.equal(waits.length, 1);

  clock += 600000;
  assert.equal((await collect()).cpu.usage, 50);
  assert.equal(waits.length, 2);
});

test('reopening a paused view leaves collections and history unchanged until explicit refresh', async () => {
  const api = createVscodeDouble();
  const extension = loadExtension(api.vscode);
  const timers = createTimerDouble();
  let collections = 0;
  const runtime = extension._test.createCutieboardRuntime({
    vscode: api.vscode,
    collectMetrics: async () => { collections += 1; return sampleMetrics; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  await runtime.activate({ subscriptions: [] });
  const panel = createWebviewViewDouble();
  api.registeredViews[0].provider.resolveWebviewView(panel.view);
  await flush();
  await api.commandHandlers.get('cutieboard.pause')();
  const history = panel.messages.at(-1).metrics.history;

  await panel.setVisible(false);
  await panel.setVisible(true);
  assert.equal(collections, 1);
  assert.deepEqual(panel.messages.at(-1).metrics.history, history);
  assert.equal(panel.messages.at(-1).paused, true);
  await timers.fireNext();
  assert.equal(collections, 1);

  await api.commandHandlers.get('cutieboard.refresh')();
  assert.equal(collections, 2);
  assert.equal(panel.messages.at(-1).paused, true);
  await api.commandHandlers.get('cutieboard.resume')();
  assert.equal(collections, 3);
  runtime.deactivate();
});

for (const transition of ['hide', 'dispose']) {
  test(`re-baselines CPU after a ten-second ${transition} instead of reporting hidden workload`, async () => {
    const api = createVscodeDouble();
    const extension = loadExtension(api.vscode);
    const timers = createTimerDouble();
    let clock = 0;
    let user = 100;
    let idle = 100;
    const collect = extension._test.createSystemMetricsCollector({
      os: {
        cpus: () => [{ model: 'Test CPU', times: { user, idle, nice: 0, sys: 0, irq: 0 } }],
        totalmem: () => 8, freemem: () => 4, hostname: () => 'host',
        uptime: () => 1, loadavg: () => [0, 0, 0]
      },
      collectGpu: async () => ({ available: false }),
      now: () => clock,
      sleep: async (ms) => { clock += ms; idle += ms; }
    });
    const runtime = extension._test.createCutieboardRuntime({
      vscode: api.vscode, collectMetrics: collect,
      setTimer: timers.setTimer, clearTimer: timers.clearTimer
    });
    await runtime.activate({ subscriptions: [] });
    let panel = createWebviewViewDouble();
    api.registeredViews[0].provider.resolveWebviewView(panel.view);
    await flush();
    assert.equal(panel.messages.at(-1).metrics.cpu.usage, 0);

    if (transition === 'hide') await panel.setVisible(false);
    else await panel.dispose();
    clock += 10000;
    user += 10000;
    if (transition === 'hide') await panel.setVisible(true);
    else {
      panel = createWebviewViewDouble();
      api.registeredViews[0].provider.resolveWebviewView(panel.view);
      await flush();
    }
    assert.equal(panel.messages.at(-1).metrics.cpu.usage, 0);
    assert.equal(clock, 10500);
    runtime.deactivate();
  });
}

test('starts independent collectors during first, rapid-refresh, and post-gap CPU windows', async () => {
  const api = createVscodeDouble();
  const extension = loadExtension(api.vscode);
  let clock = 0;
  let finishWindow;
  const starts = [];
  const collect = extension._test.createSystemMetricsCollector({
    os: {
      cpus: () => [{ model: 'Test CPU', times: { user: 100, idle: 100, nice: 0, sys: 0, irq: 0 } }],
      totalmem: () => 8, freemem: () => 4, hostname: () => 'host',
      uptime: () => 1, loadavg: () => [0, 0, 0]
    },
    now: () => clock,
    sleep: (ms) => new Promise((resolve) => {
      finishWindow = () => { clock += ms; resolve(); };
    }),
    collectGpu: async () => { starts.push('gpu'); return { available: false }; },
    collectSensors: async () => {
      starts.push('sensors');
      return { cpuTemperature: 61, power: { available: true, watts: 24, source: 'battery' } };
    }
  });

  for (const gap of [0, 0, 600000]) {
    clock += gap;
    starts.length = 0;
    const pending = collect();
    await flush();
    const startedBeforeCpuFinished = [...starts];
    finishWindow();
    const metrics = await pending;
    assert.deepEqual(startedBeforeCpuFinished, ['gpu', 'sensors']);
    assert.equal(metrics.cpu.temperature, 61);
    assert.equal(metrics.power.watts, 24);
  }
});

test('a CPU sample already in flight cannot restore an invalidated hidden baseline', async () => {
  const api = createVscodeDouble();
  const extension = loadExtension(api.vscode);
  let clock = 0;
  let user = 100;
  let idle = 100;
  let finishWindow;
  const collect = extension._test.createSystemMetricsCollector({
    os: {
      cpus: () => [{ model: 'Test CPU', times: { user, idle, nice: 0, sys: 0, irq: 0 } }],
      totalmem: () => 8, freemem: () => 4, hostname: () => 'host',
      uptime: () => 1, loadavg: () => [0, 0, 0]
    },
    now: () => clock,
    sleep: (ms) => new Promise((resolve) => {
      finishWindow = () => { clock += ms; idle += ms; resolve(); };
    }),
    collectGpu: async () => ({ available: false })
  });

  const first = collect();
  collect.invalidateCpuBaseline();
  finishWindow();
  await first;
  clock += 10000;
  user += 10000;
  finishWindow = undefined;
  const resumed = collect();
  await flush();
  const neededFreshWindow = typeof finishWindow === 'function';
  finishWindow?.();
  const metrics = await resumed;
  assert.equal(neededFreshWindow, true);
  assert.equal(metrics.cpu.usage, 0);
});
