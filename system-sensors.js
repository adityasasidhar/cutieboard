'use strict';

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

  const readBatteryPower = async () => {
    const supplies = await safeDirectory('/sys/class/power_supply');
    for (const supply of supplies) {
      const base = `/sys/class/power_supply/${supply}`;
      const type = await safeText(`${base}/type`);
      const status = await safeText(`${base}/status`);
      if (type !== 'Battery' || status !== 'Discharging') continue;

      const microwatts = Number(await safeText(`${base}/power_now`));
      if (Number.isFinite(microwatts) && microwatts >= 0) return microwatts / 1_000_000;
    }
    return undefined;
  };

  return async () => {
    const timestamp = now();
    const [cpuTemperature, rapl, batteryWatts] = await Promise.all([
      readCpuTemperature(),
      readRaplPower(timestamp),
      readBatteryPower()
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

function createExecRunner(execFile) {
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
          done(undefined);
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

function createWindowsSensorCollector({ execFile }) {
  const runText = createExecRunner(execFile);
  const powershell = (command, timeout) => runText(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    timeout
  );

  return async () => {
    const [thermalText, batteryText] = await Promise.all([
      powershell(
        'Get-CimInstance MSAcpi_ThermalZoneTemperature -Namespace root/wmi | Select-Object -ExpandProperty CurrentTemperature',
        4000
      ),
      powershell(
        'Get-CimInstance BatteryStatus -Namespace root/wmi | Format-List Voltage, ChargeRate, DischargeRate, Charging, Discharging, PowerOnline',
        4000
      )
    ]);

    const cpuTemperature = parseWmiThermalZoneOutput(thermalText);
    const batteryWatts = parseWmiBatteryStatusOutput(batteryText);

    return {
      cpuTemperature,
      power: batteryWatts === undefined
        ? { available: false }
        : { available: true, watts: batteryWatts, source: 'battery' }
    };
  };
}

function createMacSensorCollector({ execFile, now = Date.now }) {
  const runText = createExecRunner(execFile);

  return async () => {
    const [osxTempText, smcText, powerText, ioregText, pmsetText] = await Promise.all([
      runText('osx-cpu-temp', ['-c'], 1500),
      runText('powermetrics', ['--samplers', 'smc', '-n', '1', '-i', '1000'], 3000),
      runText('powermetrics', ['--samplers', 'cpu_power,gpu_power', '-n', '1', '-i', '1000'], 3000),
      runText('ioreg', ['-rn', 'AppleSmartBattery'], 1500),
      runText('pmset', ['-g', 'batt'], 1500)
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

    void now;
    return { cpuTemperature, power };
  };
}

module.exports = {
  createLinuxSensorCollector,
  createMacSensorCollector,
  createWindowsSensorCollector,
  _test: {
    parseOsxCpuTempOutput,
    parsePowermetricsSmcOutput,
    parsePowermetricsPowerOutput,
    parseIoregBatteryOutput,
    parseWmiBatteryStatusOutput,
    parseWmiThermalZoneOutput,
    isPmsetDischarging
  }
};
