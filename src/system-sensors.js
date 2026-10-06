'use strict';

const { parseNvidiaOutput } = require('./monitor-core');

function createLinuxSensorCollector({ readDirectory, readText, now = Date.now }) {
  const previousEnergy = new Map();

  const safeDirectory = async (filePath) => {
    try {
      const entries = await readDirectory(filePath);
      return Array.isArray(entries) ? entries : [];
    } catch {
      return [];
    }
  };

  const safeText = async (filePath) => {
    try {
      const value = await readText(filePath);
      return value === undefined || value === null ? undefined : String(value).trim();
    } catch {
      return undefined;
    }
  };

  const readCpuTemperature = async () => {
    const candidates = [];
    const devices = await safeDirectory('/sys/class/hwmon');

    for (const device of devices) {
      const base = `/sys/class/hwmon/${device}`;
      const driver = (await safeText(`${base}/name`) || '').toLowerCase();
      const cpuDriver = /coretemp|k10temp|zenpower|cpu_thermal|acpitz/.test(driver);
      if (!cpuDriver) continue;

      const files = await safeDirectory(base);
      for (const file of files.filter((name) => /^temp\d+_input$/.test(name))) {
        const temperature = Number(await safeText(`${base}/${file}`)) / 1000;
        if (!Number.isFinite(temperature) || temperature < -20 || temperature > 150) continue;

        const label = (await safeText(`${base}/${file.replace('_input', '_label')}`) || '').toLowerCase();
        const packageReading = /package|tctl|tdie|cpu|soc/.test(label);
        candidates.push({ temperature, priority: packageReading ? 2 : 1 });
      }
    }

    if (candidates.length === 0) return undefined;
    const priority = Math.max(...candidates.map((candidate) => candidate.priority));
    return Math.max(...candidates
      .filter((candidate) => candidate.priority === priority)
      .map((candidate) => candidate.temperature));
  };

  const readRaplPower = async (timestamp) => {
    const devices = await safeDirectory('/sys/class/powercap');
    const readings = [];

    for (const device of devices.filter((name) => /^intel-rapl:\d+$/.test(name))) {
      const base = `/sys/class/powercap/${device}`;
      const name = await safeText(`${base}/name`);
      const energy = Number(await safeText(`${base}/energy_uj`));
      const maxEnergy = Number(await safeText(`${base}/max_energy_range_uj`));
      if (!name || !Number.isFinite(energy)) continue;

      const previous = previousEnergy.get(base);
      previousEnergy.set(base, { energy, maxEnergy, timestamp });
      if (!previous || timestamp <= previous.timestamp) continue;

      let delta = energy - previous.energy;
      if (delta < 0 && Number.isFinite(previous.maxEnergy)) {
        delta = previous.maxEnergy - previous.energy + energy;
      }
      const watts = delta / (timestamp - previous.timestamp) / 1000;
      if (Number.isFinite(watts) && watts >= 0) readings.push({ name, watts });
    }

    const platformReadings = readings.filter((reading) => reading.name === 'psys');
    const packageReadings = readings.filter((reading) => /^package-/.test(reading.name));
    return {
      platformWatts: platformReadings.length
        ? platformReadings.reduce((sum, reading) => sum + reading.watts, 0)
        : undefined,
      cpuWatts: packageReadings.length
        ? packageReadings.reduce((sum, reading) => sum + reading.watts, 0)
        : undefined
    };
  };

  // energy_now moves in coarse steps (~15 mWh every 1-3 s on an HP Victus), so
  // the rate is taken between first observations of each step, over a window.
  const ENERGY_WINDOW_MS = 60000;
  const energyTrails = new Map();

  const estimateFromEnergy = (base, energy, timestamp) => {
    const trail = energyTrails.get(base) || { last: undefined, steps: [] };
    if (trail.last !== undefined && energy > trail.last) trail.steps = [];
    else if (trail.last !== undefined && energy < trail.last) trail.steps.push({ energy, timestamp });
    trail.last = energy;
    trail.steps = trail.steps.filter((step) => timestamp - step.timestamp <= ENERGY_WINDOW_MS);
    energyTrails.set(base, trail);

    if (trail.steps.length < 2) return undefined;
    const first = trail.steps[0];
    const latest = trail.steps.at(-1);
    // µWh × (ms per hour) / ms = µW
    const microwatts = (first.energy - latest.energy) * 3_600_000 / (latest.timestamp - first.timestamp);
    return Number.isFinite(microwatts) && microwatts > 0 ? microwatts / 1_000_000 : undefined;
  };

  const readBatteryPower = async (timestamp) => {
    const supplies = await safeDirectory('/sys/class/power_supply');
    for (const supply of supplies) {
      const base = `/sys/class/power_supply/${supply}`;
      const type = await safeText(`${base}/type`);
      const status = await safeText(`${base}/status`);
      if (type !== 'Battery') continue;
      if (status !== 'Discharging') {
        energyTrails.delete(base);
        continue;
      }

      const microwatts = Number(await safeText(`${base}/power_now`));
      if (Number.isFinite(microwatts) && microwatts >= 0) return microwatts / 1_000_000;

      const microamps = Number(await safeText(`${base}/current_now`));
      const microvolts = Number(await safeText(`${base}/voltage_now`));
      if (Number.isFinite(microamps) && Number.isFinite(microvolts) && microamps !== 0 && microvolts > 0) {
        return Math.abs(microamps) * microvolts / 1e12;
      }

      const energy = Number(await safeText(`${base}/energy_now`));
      if (Number.isFinite(energy)) {
        const watts = estimateFromEnergy(base, energy, timestamp);
        if (watts !== undefined) return watts;
      }
    }
    return undefined;
  };

  return async () => {
    const timestamp = now();
    const [cpuTemperature, rapl, batteryWatts] = await Promise.all([
      readCpuTemperature(),
      readRaplPower(timestamp),
      readBatteryPower(timestamp)
    ]);

    let power = { available: false };
    if (rapl.platformWatts !== undefined) {
      power = {
        available: true,
        watts: rapl.platformWatts,
        ...(rapl.cpuWatts === undefined ? {} : { cpuWatts: rapl.cpuWatts }),
        source: 'platform'
      };
    } else if (batteryWatts !== undefined) {
      power = {
        available: true,
        watts: batteryWatts,
        ...(rapl.cpuWatts === undefined ? {} : { cpuWatts: rapl.cpuWatts }),
        source: 'battery'
      };
    } else if (rapl.cpuWatts !== undefined) {
      power = {
        available: true,
        watts: rapl.cpuWatts,
        cpuWatts: rapl.cpuWatts,
        source: 'cpu'
      };
    }

    return { cpuTemperature, power };
  };
}

function parseOsxCpuTempOutput(stdout) {
  if (typeof stdout !== 'string') return undefined;
  const temperature = Number.parseFloat(stdout.replace(',', '.'));
  if (!Number.isFinite(temperature) || temperature < -20 || temperature > 150) return undefined;
  return temperature;
}

function parsePowermetricsSmcOutput(stdout) {
  if (typeof stdout !== 'string') return undefined;
  const patterns = [
    /CPU die temperature:\s*([\d.]+)\s*C/i,
    /CPU temperature:\s*([\d.]+)\s*C/i,
    /SoC temperature:\s*([\d.]+)\s*C/i
  ];
  for (const pattern of patterns) {
    const match = stdout.match(pattern);
    if (!match) continue;
    const temperature = Number(match[1]);
    if (Number.isFinite(temperature) && temperature >= -20 && temperature <= 150) return temperature;
  }
  return undefined;
}

function parsePowermetricsPowerOutput(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return {};
  const toWatts = (value, unit) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return undefined;
    return /mW/i.test(unit || '') ? number / 1000 : number;
  };
  let platformWatts;
  let cpuWatts;
  let gpuWatts;
  const pattern = /([A-Za-z][A-Za-z +]*?power(?:\s*\([^)]*\))?)\s*:\s*([\d.]+)\s*(mW|W)\b/gi;
  let match;
  while ((match = pattern.exec(stdout)) !== null) {
    const label = match[1].toLowerCase();
    const watts = toWatts(match[2], match[3]);
    if (watts === undefined) continue;
    if (/combined|package|total|processor|system/.test(label)) {
      if (platformWatts === undefined) platformWatts = watts;
    } else if (/gpu/.test(label)) {
      if (gpuWatts === undefined) gpuWatts = watts;
    } else if (/cpu/.test(label)) {
      if (cpuWatts === undefined) cpuWatts = watts;
    }
  }
  return {
    ...(platformWatts === undefined ? {} : { platformWatts }),
    ...(cpuWatts === undefined ? {} : { cpuWatts }),
    ...(gpuWatts === undefined ? {} : { gpuWatts })
  };
}

function parseIoregBatteryOutput(stdout) {
  if (typeof stdout !== 'string') return undefined;
  const voltageMatch = stdout.match(/"Voltage"\s*=\s*(\d+)/);
  const amperageMatch = stdout.match(/"Amperage"\s*=\s*(-?\d+)/);
  if (!voltageMatch || !amperageMatch) return undefined;
  const millivolts = Number(voltageMatch[1]);
  let milliamps = Number(amperageMatch[1]);
  if (!Number.isFinite(millivolts) || !Number.isFinite(milliamps)) return undefined;
  if (milliamps >= 2 ** 63) milliamps -= 2 ** 64;
  else if (milliamps >= 2 ** 31) milliamps -= 2 ** 32;
  const chargingMatch = stdout.match(/"IsCharging"\s*=\s*"?(Yes|No)"?/i);
  if (chargingMatch && /^yes$/i.test(chargingMatch[1])) return undefined;
  if (milliamps >= 0) return undefined;
  const watts = Math.abs(millivolts * milliamps) / 1_000_000;
  if (!Number.isFinite(watts) || watts < 0 || watts > 2000) return undefined;
  return watts;
}

function isPmsetDischarging(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return undefined;
  if (/discharging/i.test(stdout)) return true;
  if (/drawing from 'battery power'/i.test(stdout)) return true;
  if (/charged|charging|finishing charge|AC attached|AC Power/i.test(stdout)) return false;
  return undefined;
}

function createExecRunner(execFile, { keepPartialOutput = false } = {}) {
  return (file, args, timeout) => new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      const child = execFile(file, args, { timeout, windowsHide: true }, (error, stdout) => {
        if (error) {
          // Only marked Windows queries can distinguish completed readings
          // from truncated output. Other tools still discard failed output.
          done(keepPartialOutput && typeof stdout === 'string' && stdout.trim() ? stdout : undefined);
          return;
        }
        done(typeof stdout === 'string' ? stdout : String(stdout ?? ''));
      });
      if (child && typeof child.on === 'function') {
        child.on('error', () => done(undefined));
      }
    } catch {
      done(undefined);
    }
  });
}

// A tool that is missing, needs root, or prints nothing will keep doing so;
// skip it for a while instead of spawning it on every sample.
const TOOL_RETRY_MS = 300000;

function createBackoffRunner(runText, now) {
  const retryAt = new Map();
  return async (file, args, timeout) => {
    const key = [file, ...args].join(' ');
    if (now() < (retryAt.get(key) ?? -Infinity)) return undefined;
    const output = await runText(file, args, timeout);
    if (output === undefined || !output.trim()) retryAt.set(key, now() + TOOL_RETRY_MS);
    else retryAt.delete(key);
    return output;
  };
}

// Node's os.freemem() on macOS counts only completely free pages, so a Mac
// that has been up a while always looks nearly full. Count reclaimable pages
// too (the same definition psutil uses for "available").
function parseVmStatAvailableMemory(stdout) {
  if (typeof stdout !== 'string') return undefined;
  const pageSize = Number(stdout.match(/page size of (\d+) bytes/)?.[1]);
  const pages = (label) => Number(stdout.match(new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, 'm'))?.[1]);
  const free = pages('free');
  const inactive = pages('inactive');
  const speculative = pages('speculative');
  if (![pageSize, free, inactive].every(Number.isFinite) || pageSize <= 0) return undefined;
  return (free + inactive + (Number.isFinite(speculative) ? speculative : 0)) * pageSize;
}

function parseWmiThermalZoneOutput(stdout) {
  if (typeof stdout !== 'string') return undefined;
  const readings = [];
  for (const match of stdout.matchAll(/(\d{4,6})/g)) {
    const celsius = Number(match[1]) / 10 - 273.15;
    if (Number.isFinite(celsius) && celsius >= -20 && celsius <= 150) readings.push(celsius);
  }
  if (readings.length === 0) return undefined;
  return Math.max(...readings);
}

function parseWmiBatteryStatusOutput(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return undefined;
  const field = (block, name) => {
    const match = block.match(new RegExp(`^${name}\\s*:\\s*(.+?)\\s*$`, 'im'));
    return match ? match[1].trim() : undefined;
  };
  const isTrue = (value) => /^true$/i.test(value || '') || value === '1';
  for (const block of stdout.split(/\r?\n\s*\r?\n/)) {
    if (!block.trim()) continue;
    if (!isTrue(field(block, 'Discharging'))) continue;
    const milliwatts = Number(field(block, 'DischargeRate'));
    if (!Number.isFinite(milliwatts) || milliwatts <= 0 || milliwatts > 2_000_000) continue;
    return milliwatts / 1000;
  }
  return undefined;
}

// PowerShell costs hundreds of milliseconds of CPU to start, so all WMI
// queries share one process, run at most every 10 s, and a query that comes
// back empty (no battery, or a thermal zone that needs admin) is dropped from
// the script for 5 minutes instead of being retried every sample.
const WINDOWS_SENSOR_INTERVAL_MS = 10000;
const WINDOWS_SENSOR_RETRY_MS = 300000;
const WINDOWS_QUERIES = {
  thermal: {
    command: 'Get-CimInstance MSAcpi_ThermalZoneTemperature -Namespace root/wmi -ErrorAction Stop | Select-Object -ExpandProperty CurrentTemperature',
    usable: (text) => parseWmiThermalZoneOutput(text) !== undefined
  },
  battery: {
    command: 'Get-CimInstance BatteryStatus -Namespace root/wmi -ErrorAction Stop | Format-List Voltage, ChargeRate, DischargeRate, Charging, Discharging, PowerOnline | Out-String',
    usable: (text) => Boolean(text && text.trim())
  }
};

function splitMarkedSections(stdout) {
  const sections = {};
  let current;
  for (const line of (typeof stdout === 'string' ? stdout : '').split(/\r?\n/)) {
    const marker = line.match(/^@@(\w+)\s*$/);
    if (marker) {
      current = marker[1];
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  return Object.fromEntries(Object.entries(sections).map(([key, lines]) => [key, lines.join('\n')]));
}

function createWindowsSensorCollector({ execFile, now = Date.now }) {
  const runText = createExecRunner(execFile, { keepPartialOutput: true });
  const retryAt = Object.fromEntries(Object.keys(WINDOWS_QUERIES).map((key) => [key, -Infinity]));
  let latest;
  let latestAt = -Infinity;

  return async () => {
    const timestamp = now();
    if (latest && timestamp - latestAt < WINDOWS_SENSOR_INTERVAL_MS) return latest;
    latestAt = timestamp;

    const due = Object.keys(WINDOWS_QUERIES).filter((key) => timestamp >= retryAt[key]);
    const script = due
      .map((key) => `'@@${key}'; try { ${WINDOWS_QUERIES[key].command} } catch {}; '@@${key}_done'`)
      .join('; ');
    const sections = due.length
      ? splitMarkedSections(await runText(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        4000
      ))
      : {};
    const hasSections = Object.keys(sections).length > 0;
    for (const key of due) {
      const started = Object.hasOwn(sections, key);
      const completed = Object.hasOwn(sections, `${key}_done`);
      if (!completed || !WINDOWS_QUERIES[key].usable(sections[key])) {
        // A timed-out query can prevent later queries from even starting.
        // Back off the interrupted query, not its unattempted neighbours.
        if (started || !hasSections) retryAt[key] = timestamp + WINDOWS_SENSOR_RETRY_MS;
        delete sections[key];
      }
    }

    const cpuTemperature = parseWmiThermalZoneOutput(sections.thermal);
    const batteryWatts = parseWmiBatteryStatusOutput(sections.battery);
    latest = {
      cpuTemperature,
      power: batteryWatts === undefined
        ? { available: false }
        : { available: true, watts: batteryWatts, source: 'battery' }
    };
    return latest;
  };
}

const NVIDIA_QUERY = [
  '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit',
  '--format=csv,noheader,nounits'
];
// Waking a runtime-suspended laptop dGPU took ~1.8 s on an RTX 3050 Laptop.
const NVIDIA_SMI_TIMEOUT_MS = 3000;
// Runtime PM suspends an idle dGPU after a few seconds without a client, so
// polling an idle GPU every sample would keep it powered up indefinitely.
const NVIDIA_IDLE_RECHECK_MS = 10000;

function createNvidiaCollector({ execFile, readDirectory, readText, now = Date.now }) {
  const runText = createExecRunner(execFile);
  let lastReading;
  let lastQueryAt = -Infinity;
  let lastName;

  const safe = async (read, filePath) => {
    try {
      return read ? String(await read(filePath)).trim() : undefined;
    } catch {
      return undefined;
    }
  };

  // Linux exposes runtime PM state in sysfs; reading it never wakes the GPU.
  const readPowerStates = async () => {
    let addresses = [];
    try {
      addresses = readDirectory ? await readDirectory('/proc/driver/nvidia/gpus') : [];
    } catch {
      addresses = [];
    }
    return Promise.all((Array.isArray(addresses) ? addresses : []).map(async (address) => {
      const base = `/sys/bus/pci/devices/${address}/power`;
      return {
        control: await safe(readText, `${base}/control`),
        status: await safe(readText, `${base}/runtime_status`)
      };
    }));
  };

  return async () => {
    const states = await readPowerStates();
    const runtimePm = states.length > 0 && states.every((state) => state.control === 'auto');

    if (runtimePm && states.every((state) => state.status === 'suspended')) {
      lastReading = undefined;
      return {
        available: true,
        asleep: true,
        name: lastName || (states.length > 1 ? `${states.length} NVIDIA GPUs` : 'NVIDIA GPU'),
        utilization: 0
      };
    }

    if (runtimePm && lastReading?.utilization === 0 && now() - lastQueryAt < NVIDIA_IDLE_RECHECK_MS) {
      return lastReading;
    }

    const reading = parseNvidiaOutput(await runText('nvidia-smi', NVIDIA_QUERY, NVIDIA_SMI_TIMEOUT_MS));
    lastQueryAt = now();
    lastReading = reading.available ? reading : undefined;
    if (reading.available) lastName = reading.name;
    return reading;
  };
}

function createMacSensorCollector({ execFile, now = Date.now }) {
  const runText = createBackoffRunner(createExecRunner(execFile), now);

  return async () => {
    const [osxTempText, smcText, powerText, ioregText, pmsetText, vmStatText] = await Promise.all([
      runText('osx-cpu-temp', ['-c'], 1500),
      runText('powermetrics', ['--samplers', 'smc', '-n', '1', '-i', '1000'], 3000),
      runText('powermetrics', ['--samplers', 'cpu_power,gpu_power', '-n', '1', '-i', '1000'], 3000),
      runText('ioreg', ['-rn', 'AppleSmartBattery'], 1500),
      runText('pmset', ['-g', 'batt'], 1500),
      runText('vm_stat', [], 1500)
    ]);

    const cpuTemperature = parseOsxCpuTempOutput(osxTempText)
      ?? parsePowermetricsSmcOutput(smcText);

    const powermetrics = parsePowermetricsPowerOutput(powerText);
    const discharging = isPmsetDischarging(pmsetText);
    const batteryWatts = discharging === false
      ? undefined
      : parseIoregBatteryOutput(ioregText);

    let power = { available: false };
    if (powermetrics.platformWatts !== undefined) {
      power = {
        available: true,
        watts: powermetrics.platformWatts,
        ...(powermetrics.cpuWatts === undefined ? {} : { cpuWatts: powermetrics.cpuWatts }),
        ...(powermetrics.gpuWatts === undefined ? {} : { gpuWatts: powermetrics.gpuWatts }),
        source: 'platform'
      };
    } else if (batteryWatts !== undefined) {
      power = {
        available: true,
        watts: batteryWatts,
        ...(powermetrics.cpuWatts === undefined ? {} : { cpuWatts: powermetrics.cpuWatts }),
        ...(powermetrics.gpuWatts === undefined ? {} : { gpuWatts: powermetrics.gpuWatts }),
        source: 'battery'
      };
    } else if (powermetrics.cpuWatts !== undefined || powermetrics.gpuWatts !== undefined) {
      const cpuWatts = powermetrics.cpuWatts;
      const gpuWatts = powermetrics.gpuWatts;
      power = {
        available: true,
        watts: (cpuWatts || 0) + (gpuWatts || 0),
        ...(cpuWatts === undefined ? {} : { cpuWatts }),
        ...(gpuWatts === undefined ? {} : { gpuWatts }),
        source: 'components'
      };
    }

    const availableMemory = parseVmStatAvailableMemory(vmStatText);
    return {
      cpuTemperature,
      power,
      ...(availableMemory === undefined ? {} : { availableMemory })
    };
  };
}

module.exports = {
  createLinuxSensorCollector,
  createNvidiaCollector,
  createMacSensorCollector,
  createWindowsSensorCollector,
  _test: {
    parseOsxCpuTempOutput,
    parsePowermetricsSmcOutput,
    parsePowermetricsPowerOutput,
    parseIoregBatteryOutput,
    parseWmiBatteryStatusOutput,
    parseWmiThermalZoneOutput,
    isPmsetDischarging,
    parseVmStatAvailableMemory
  }
};
