'use strict';

function calculateCpuUsage(previous, current) {
  if (!Array.isArray(previous) || !Array.isArray(current) || previous.length !== current.length || current.length === 0) {
    return 0;
  }

  let idle = 0;
  let total = 0;

  current.forEach((cpu, index) => {
    const before = previous[index];
    if (!before?.times || !cpu?.times) return;

    for (const key of Object.keys(cpu.times)) {
      const delta = Number(cpu.times[key]) - Number(before.times[key] || 0);
      if (Number.isFinite(delta) && delta > 0) total += delta;
    }

    const idleDelta = Number(cpu.times.idle) - Number(before.times.idle || 0);
    if (Number.isFinite(idleDelta) && idleDelta > 0) idle += idleDelta;
  });

  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, ((total - idle) / total) * 100));
}

function isUnifiedMemory({ platform, arch } = {}) {
  return platform === 'darwin' && arch === 'arm64';
}

function appendSample(history, value, limit = 60) {
  const next = [...history, value];
  return next.slice(Math.max(0, next.length - limit));
}

function parseNvidiaOutput(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return { available: false };

  const cards = stdout.trim().split(/\r?\n/).map((line) => {
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 5) return undefined;

    const [name, utilizationText, usedText, totalText, temperatureText, powerDrawText, powerLimitText] = parts;
    const utilization = Number(utilizationText);
    const memoryUsed = Number(usedText);
    const memoryTotal = Number(totalText);
    const temperature = Number(temperatureText);

    if (!name || ![utilization, memoryUsed, memoryTotal, temperature].every(Number.isFinite) || memoryTotal <= 0) {
      return undefined;
    }

    const powerDraw = Number(powerDrawText);
    const powerLimit = Number(powerLimitText);
    return {
      name,
      utilization,
      memoryUsed,
      memoryTotal,
      temperature,
      ...(Number.isFinite(powerDraw) ? { powerDraw } : {}),
      ...(Number.isFinite(powerLimit) ? { powerLimit } : {})
    };
  }).filter(Boolean);

  if (cards.length === 0) return { available: false };

  const powerDraws = cards.map((card) => card.powerDraw).filter(Number.isFinite);
  const powerLimits = cards.map((card) => card.powerLimit).filter(Number.isFinite);
  return {
    available: true,
    name: cards.length === 1 ? cards[0].name : `${cards.length} NVIDIA GPUs`,
    utilization: cards.reduce((sum, card) => sum + card.utilization, 0) / cards.length,
    memoryUsed: cards.reduce((sum, card) => sum + card.memoryUsed, 0),
    memoryTotal: cards.reduce((sum, card) => sum + card.memoryTotal, 0),
    temperature: Math.max(...cards.map((card) => card.temperature)),
    ...(powerDraws.length ? { powerDraw: powerDraws.reduce((sum, value) => sum + value, 0) } : {}),
    ...(powerLimits.length ? { powerLimit: powerLimits.reduce((sum, value) => sum + value, 0) } : {})
  };
}

function mergePowerReadings(systemPower, gpu) {
  const sensorGpuWatts = systemPower.available && Number.isFinite(systemPower.gpuWatts)
    ? systemPower.gpuWatts
    : undefined;
  const gpuWatts = gpu.available && Number.isFinite(gpu.powerDraw)
    ? gpu.powerDraw
    : sensorGpuWatts;

  if (systemPower.available && ['platform', 'battery'].includes(systemPower.source)) {
    return {
      available: true,
      watts: systemPower.watts,
      ...(Number.isFinite(systemPower.cpuWatts) ? { cpuWatts: systemPower.cpuWatts } : {}),
      ...(gpuWatts === undefined ? {} : { gpuWatts }),
      source: systemPower.source
    };
  }

  const cpuWatts = systemPower.available && Number.isFinite(systemPower.cpuWatts)
    ? systemPower.cpuWatts
    : undefined;
  if (cpuWatts === undefined && gpuWatts === undefined) return { available: false };

  return {
    available: true,
    watts: (cpuWatts || 0) + (gpuWatts || 0),
    ...(cpuWatts === undefined ? {} : { cpuWatts }),
    ...(gpuWatts === undefined ? {} : { gpuWatts }),
    source: 'components'
  };
}

class AsyncSampler {
  constructor({ collect, onSample }) {
    this.collect = collect;
    this.onSample = onSample;
    this.paused = false;
    this.inFlight = false;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  async sample({ force = false } = {}) {
    if ((this.paused && !force) || this.inFlight) return false;

    this.inFlight = true;
    try {
      const result = await this.collect();
      this.onSample(result);
      return true;
    } finally {
      this.inFlight = false;
    }
  }
}

class TelemetryStore {
  constructor(limit = 60) {
    this.limit = limit;
    this.history = { cpu: [], memory: [], gpu: [], power: [] };
    this.latest = undefined;
  }

  record(metrics) {
    const memoryUsage = metrics.memory.total > 0
      ? (metrics.memory.used / metrics.memory.total) * 100
      : 0;

    this.history.cpu = appendSample(this.history.cpu, metrics.cpu.usage, this.limit);
    this.history.memory = appendSample(this.history.memory, memoryUsage, this.limit);
    this.history.gpu = metrics.gpu.available
      ? appendSample(this.history.gpu, metrics.gpu.utilization, this.limit)
      : [];
    if (metrics.power) {
      this.history.power = metrics.power.available
        ? appendSample(this.history.power, metrics.power.watts, this.limit)
        : [];
    }

    const history = {
      cpu: [...this.history.cpu],
      memory: [...this.history.memory],
      gpu: [...this.history.gpu]
    };
    if (metrics.power) history.power = [...this.history.power];

    this.latest = {
      ...metrics,
      memory: { ...metrics.memory, usage: memoryUsage },
      history
    };

    return this.latest;
  }
}

module.exports = {
  AsyncSampler,
  TelemetryStore,
  appendSample,
  calculateCpuUsage,
  isUnifiedMemory,
  mergePowerReadings,
  parseNvidiaOutput
};
