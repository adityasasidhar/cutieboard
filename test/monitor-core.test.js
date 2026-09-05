const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AsyncSampler,
  TelemetryStore,
  appendSample,
  calculateCpuUsage,
  isUnifiedMemory,
  mergePowerReadings,
  parseNvidiaOutput
} = require('../monitor-core');

test('calculates aggregate CPU use from consecutive OS samples', () => {
  const before = [
    { times: { user: 100, nice: 0, sys: 0, idle: 100, irq: 0 } },
    { times: { user: 100, nice: 0, sys: 0, idle: 200, irq: 0 } }
  ];
  const current = [
    { times: { user: 160, nice: 0, sys: 0, idle: 140, irq: 0 } },
    { times: { user: 130, nice: 0, sys: 0, idle: 270, irq: 0 } }
  ];

  assert.equal(calculateCpuUsage(before, current), 45);
});

test('clamps invalid CPU deltas to a safe percentage', () => {
  const sample = [{ times: { user: 1, nice: 0, sys: 0, idle: 1, irq: 0 } }];
  assert.equal(calculateCpuUsage(sample, sample), 0);
  assert.equal(calculateCpuUsage([], sample), 0);
});

test('appends history without mutating input and keeps the newest 60 samples', () => {
  const original = Array.from({ length: 60 }, (_, index) => index);
  const next = appendSample(original, 60);

  assert.deepEqual(original, Array.from({ length: 60 }, (_, index) => index));
  assert.deepEqual(next, Array.from({ length: 60 }, (_, index) => index + 1));
});

test('parses and aggregates multiple NVIDIA GPUs', () => {
  const output = [
    'NVIDIA RTX A, 40, 1000, 8000, 62',
    'NVIDIA RTX B, 60, 2000, 8000, 70'
  ].join('\n');

  assert.deepEqual(parseNvidiaOutput(output), {
    available: true,
    name: '2 NVIDIA GPUs',
    utilization: 50,
    memoryUsed: 3000,
    memoryTotal: 16000,
    temperature: 70
  });
});

test('treats empty or malformed NVIDIA output as unavailable', () => {
  assert.deepEqual(parseNvidiaOutput(''), { available: false });
  assert.deepEqual(parseNvidiaOutput('not, valid'), { available: false });
});

test('parses NVIDIA temperature and live power draw', () => {
  assert.deepEqual(
    parseNvidiaOutput('NVIDIA RTX, 75, 4096, 8192, 68, 82.5, 120'),
    {
      available: true,
      name: 'NVIDIA RTX',
      utilization: 75,
      memoryUsed: 4096,
      memoryTotal: 8192,
      temperature: 68,
      powerDraw: 82.5,
      powerLimit: 120
    }
  );
});

test('avoids double-counting GPU power in a platform-wide reading', () => {
  assert.deepEqual(
    mergePowerReadings(
      { available: true, watts: 70, cpuWatts: 25, source: 'platform' },
      { available: true, powerDraw: 30 }
    ),
    { available: true, watts: 70, cpuWatts: 25, gpuWatts: 30, source: 'platform' }
  );
});

test('combines component power when no platform-wide reading exists', () => {
  assert.deepEqual(
    mergePowerReadings(
      { available: true, watts: 25, cpuWatts: 25, source: 'cpu' },
      { available: true, powerDraw: 30 }
    ),
    { available: true, watts: 55, cpuWatts: 25, gpuWatts: 30, source: 'components' }
  );
  assert.deepEqual(
    mergePowerReadings({ available: false }, { available: false }),
    { available: false }
  );
});

test('detects Apple Silicon unified memory from platform and architecture', () => {
  assert.equal(isUnifiedMemory({ platform: 'darwin', arch: 'arm64' }), true);
  assert.equal(isUnifiedMemory({ platform: 'darwin', arch: 'x64' }), false);
  assert.equal(isUnifiedMemory({ platform: 'linux', arch: 'arm64' }), false);
  assert.equal(isUnifiedMemory({ platform: 'win32', arch: 'x64' }), false);
  assert.equal(isUnifiedMemory({}), false);
  assert.equal(isUnifiedMemory(), false);
});

test('drops overlapping samples instead of starting concurrent collection', async () => {
  let release;
  let calls = 0;
  const firstResult = new Promise((resolve) => { release = resolve; });
  const received = [];
  const sampler = new AsyncSampler({
    collect: () => { calls += 1; return firstResult; },
    onSample: (sample) => received.push(sample)
  });

  const first = sampler.sample();
  assert.equal(await sampler.sample(), false);
  assert.equal(calls, 1);
  release({ cpu: 42 });
  assert.equal(await first, true);
  assert.deepEqual(received, [{ cpu: 42 }]);
});

test('pause blocks automatic samples while force performs one sample', async () => {
  const received = [];
  const sampler = new AsyncSampler({
    collect: async () => ({ cpu: 12 }),
    onSample: (sample) => received.push(sample)
  });

  sampler.pause();
  assert.equal(sampler.paused, true);
  assert.equal(await sampler.sample(), false);
  assert.equal(await sampler.sample({ force: true }), true);
  assert.deepEqual(received, [{ cpu: 12 }]);
  sampler.resume();
  assert.equal(sampler.paused, false);
});

test('records CPU, memory, and available GPU histories in the delivered snapshot', () => {
  const store = new TelemetryStore();
  const snapshot = store.record({
    cpu: { usage: 25 },
    memory: { used: 3, total: 4 },
    gpu: { available: true, utilization: 80 }
  });

  assert.equal(snapshot.memory.usage, 75);
  assert.deepEqual(snapshot.history, {
    cpu: [25],
    memory: [75],
    gpu: [80]
  });
});

test('clears stale GPU history when GPU telemetry becomes unavailable', () => {
  const store = new TelemetryStore();
  store.record({
    cpu: { usage: 1 },
    memory: { used: 1, total: 2 },
    gpu: { available: true, utilization: 10 }
  });

  const snapshot = store.record({
    cpu: { usage: 2 },
    memory: { used: 1, total: 2 },
    gpu: { available: false }
  });

  assert.deepEqual(snapshot.history.gpu, []);
});

test('records power history only while a real wattage is available', () => {
  const store = new TelemetryStore();
  const base = {
    cpu: { usage: 1 },
    memory: { used: 1, total: 2 },
    gpu: { available: false }
  };

  assert.deepEqual(
    store.record({ ...base, power: { available: true, watts: 42 } }).history.power,
    [42]
  );
  assert.deepEqual(
    store.record({ ...base, power: { available: false } }).history.power,
    []
  );
});
