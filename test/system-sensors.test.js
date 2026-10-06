const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('ships the Linux temperature and power sensor collector', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'system-sensors.js')), true);
});

test('reads CPU package temperature and derives platform and CPU watts from RAPL energy', async () => {
  const { createLinuxSensorCollector } = require('../src/system-sensors');
  let secondSample = false;
  const directories = new Map([
    ['/sys/class/hwmon', ['hwmon0', 'hwmon1']],
    ['/sys/class/hwmon/hwmon0', ['name', 'temp1_input', 'temp1_label']],
    ['/sys/class/hwmon/hwmon1', ['name', 'temp1_input', 'temp1_label']],
    ['/sys/class/powercap', ['intel-rapl:0', 'intel-rapl:1']],
    ['/sys/class/power_supply', []]
  ]);
  const text = new Map([
    ['/sys/class/hwmon/hwmon0/name', 'coretemp'],
    ['/sys/class/hwmon/hwmon0/temp1_input', '61000'],
    ['/sys/class/hwmon/hwmon0/temp1_label', 'Package id 0'],
    ['/sys/class/hwmon/hwmon1/name', 'nvme'],
    ['/sys/class/hwmon/hwmon1/temp1_input', '80000'],
    ['/sys/class/hwmon/hwmon1/temp1_label', 'Composite'],
    ['/sys/class/powercap/intel-rapl:0/name', 'package-0'],
    ['/sys/class/powercap/intel-rapl:0/max_energy_range_uj', '100000000'],
    ['/sys/class/powercap/intel-rapl:1/name', 'psys'],
    ['/sys/class/powercap/intel-rapl:1/max_energy_range_uj', '100000000']
  ]);
  const collector = createLinuxSensorCollector({
    readDirectory: async (filePath) => directories.get(filePath) || [],
    readText: async (filePath) => {
      if (filePath.endsWith('intel-rapl:0/energy_uj')) return secondSample ? '20500000' : '500000';
      if (filePath.endsWith('intel-rapl:1/energy_uj')) return secondSample ? '51000000' : '1000000';
      if (!text.has(filePath)) throw new Error('missing fixture: ' + filePath);
      return text.get(filePath);
    },
    now: () => secondSample ? 2000 : 1000
  });

  assert.deepEqual(await collector(), {
    cpuTemperature: 61,
    power: { available: false }
  });
  secondSample = true;
  assert.deepEqual(await collector(), {
    cpuTemperature: 61,
    power: {
      available: true,
      watts: 50,
      cpuWatts: 20,
      source: 'platform'
    }
  });
});

test('uses battery discharge rate as device power when RAPL is unavailable', async () => {
  const { createLinuxSensorCollector } = require('../src/system-sensors');
  const collector = createLinuxSensorCollector({
    readDirectory: async (filePath) => {
      if (filePath === '/sys/class/power_supply') return ['BAT0'];
      return [];
    },
    readText: async (filePath) => ({
      '/sys/class/power_supply/BAT0/type': 'Battery',
      '/sys/class/power_supply/BAT0/status': 'Discharging',
      '/sys/class/power_supply/BAT0/power_now': '45000000'
    })[filePath]
  });

  assert.deepEqual(await collector(), {
    cpuTemperature: undefined,
    power: {
      available: true,
      watts: 45,
      source: 'battery'
    }
  });
});

test('reports unavailable sensors without failing collection', async () => {
  const { createLinuxSensorCollector } = require('../src/system-sensors');
  const collector = createLinuxSensorCollector({
    readDirectory: async () => { throw new Error('permission denied'); },
    readText: async () => { throw new Error('permission denied'); }
  });

  assert.deepEqual(await collector(), {
    cpuTemperature: undefined,
    power: { available: false }
  });
});

test('converts WMI thermal-zone readings from tenths of Kelvin and takes the hottest', () => {
  const { _test } = require('../src/system-sensors');
  assert.equal(_test.parseWmiThermalZoneOutput('2982\r\n3012\r\n'), 3012 / 10 - 273.15);
  assert.equal(_test.parseWmiThermalZoneOutput('no thermal zones here'), undefined);
  assert.equal(_test.parseWmiThermalZoneOutput('0'), undefined);
  assert.equal(_test.parseWmiThermalZoneOutput(undefined), undefined);
});

test('reads Windows battery discharge rate in milliwatts while discharging', () => {
  const { _test } = require('../src/system-sensors');
  const discharging = [
    'Voltage : 12000',
    'ChargeRate : 0',
    'DischargeRate : 24000',
    'Charging : False',
    'Discharging : True',
    'PowerOnline : False'
  ].join('\r\n');
  const charging = discharging
    .replace('DischargeRate : 24000', 'DischargeRate : 0')
    .replace('Discharging : True', 'Discharging : False')
    .replace('PowerOnline : False', 'PowerOnline : True');

  assert.equal(_test.parseWmiBatteryStatusOutput(discharging), 24);
  assert.equal(_test.parseWmiBatteryStatusOutput(charging), undefined);
  assert.equal(_test.parseWmiBatteryStatusOutput(''), undefined);
});

const WINDOWS_BATTERY_DISCHARGING = [
  'Voltage : 12000',
  'ChargeRate : 0',
  'DischargeRate : 24000',
  'Charging : False',
  'Discharging : True',
  'PowerOnline : False'
].join('\r\n');

// Answers the way PowerShell would: each query section echoes its own marker,
// followed by whatever that query printed.
function createPowerShellDouble({ thermal = '3012', battery = WINDOWS_BATTERY_DISCHARGING } = {}) {
  const scripts = [];
  const execFile = (file, args, _options, callback) => {
    const script = args.at(-1);
    scripts.push({ file, script });
    const out = [];
    if (script.includes('MSAcpi_ThermalZoneTemperature')) {
      out.push('@@thermal', thermal);
      if (script.includes("'@@thermal_done'")) out.push('@@thermal_done');
    }
    if (script.includes('BatteryStatus')) {
      out.push('@@battery', battery);
      if (script.includes("'@@battery_done'")) out.push('@@battery_done');
    }
    callback(null, out.join('\r\n') + '\r\n');
    return { on() {} };
  };
  return { scripts, execFile };
}

test('collects Windows temperature and battery power from one PowerShell process', async () => {
  const { createWindowsSensorCollector } = require('../src/system-sensors');
  const shell = createPowerShellDouble();

  assert.deepEqual(await createWindowsSensorCollector({ execFile: shell.execFile, now: () => 0 })(), {
    cpuTemperature: 3012 / 10 - 273.15,
    power: { available: true, watts: 24, source: 'battery' }
  });
  assert.deepEqual(shell.scripts.map(({ file }) => file), ['powershell.exe']);
});

test('reuses the last Windows sensor reading instead of spawning PowerShell every sample', async () => {
  const { createWindowsSensorCollector } = require('../src/system-sensors');
  const shell = createPowerShellDouble();
  let clock = 0;
  const collect = createWindowsSensorCollector({ execFile: shell.execFile, now: () => clock });

  const first = await collect();
  clock = 2000;
  assert.deepEqual(await collect(), first);
  clock = 8000;
  await collect();
  assert.equal(shell.scripts.length, 1);

  clock = 10000;
  await collect();
  assert.equal(shell.scripts.length, 2);
});

test('stops querying a Windows sensor that returns nothing and retries it later', async () => {
  const { createWindowsSensorCollector } = require('../src/system-sensors');
  const shell = createPowerShellDouble({ thermal: '' });
  let clock = 0;
  const collect = createWindowsSensorCollector({ execFile: shell.execFile, now: () => clock });

  assert.equal((await collect()).cpuTemperature, undefined);
  clock = 10000;
  await collect();
  assert.equal(shell.scripts.length, 2);
  assert.equal(shell.scripts[1].script.includes('MSAcpi_ThermalZoneTemperature'), false);
  assert.equal(shell.scripts[1].script.includes('BatteryStatus'), true);

  clock = 300000;
  await collect();
  assert.equal(shell.scripts.length, 3);
  assert.equal(shell.scripts[2].script.includes('MSAcpi_ThermalZoneTemperature'), true);
});

test('spawns nothing on a Windows machine whose sensors all came back empty', async () => {
  const { createWindowsSensorCollector } = require('../src/system-sensors');
  const shell = createPowerShellDouble({ thermal: '', battery: '' });
  let clock = 0;
  const collect = createWindowsSensorCollector({ execFile: shell.execFile, now: () => clock });

  await collect();
  clock = 10000;
  assert.deepEqual(await collect(), { cpuTemperature: undefined, power: { available: false } });
  assert.equal(shell.scripts.length, 1);
});

test('keeps polling a present Windows battery while it is on AC power', async () => {
  const { createWindowsSensorCollector } = require('../src/system-sensors');
  const onAc = WINDOWS_BATTERY_DISCHARGING
    .replace('DischargeRate : 24000', 'DischargeRate : 0')
    .replace('Discharging : True', 'Discharging : False');
  const shell = createPowerShellDouble({ battery: onAc });
  let clock = 0;
  const collect = createWindowsSensorCollector({ execFile: shell.execFile, now: () => clock });

  assert.equal((await collect()).power.available, false);
  clock = 10000;
  await collect();
  assert.equal(shell.scripts[1].script.includes('BatteryStatus'), true);
});

test('reports unavailable Windows sensors when WMI queries fail', async () => {
  const { createWindowsSensorCollector } = require('../src/system-sensors');
  const execFile = (_file, _args, _options, callback) => {
    callback(new Error('WMI class not found'));
    return { on() {} };
  };

  assert.deepEqual(await createWindowsSensorCollector({ execFile })(), {
    cpuTemperature: undefined,
    power: { available: false }
  });
});

function createNvidiaFixture({ control = 'auto', status = 'suspended', output = 'NVIDIA GeForce RTX 3050 Laptop GPU, 0, 12, 4096, 45, 6.5, 60' } = {}) {
  const state = { control, status, output, clock: 0, calls: [] };
  const sysfs = '/sys/bus/pci/devices/0000:01:00.0/power';
  return {
    state,
    deps: {
      readDirectory: async (filePath) => {
        if (filePath === '/proc/driver/nvidia/gpus') return ['0000:01:00.0'];
        throw new Error('missing directory fixture: ' + filePath);
      },
      readText: async (filePath) => {
        if (filePath === `${sysfs}/control`) return state.control;
        if (filePath === `${sysfs}/runtime_status`) return state.status;
        throw new Error('missing fixture: ' + filePath);
      },
      execFile: (file, args, options, callback) => {
        state.calls.push({ file, args, options });
        callback(null, state.output);
        return { on() {} };
      },
      now: () => state.clock
    }
  };
}

test('reports a runtime-suspended NVIDIA GPU as asleep without waking it', async () => {
  const { createNvidiaCollector } = require('../src/system-sensors');
  const { state, deps } = createNvidiaFixture({ status: 'suspended' });

  assert.deepEqual(await createNvidiaCollector(deps)(), {
    available: true,
    asleep: true,
    name: 'NVIDIA GPU',
    utilization: 0
  });
  assert.equal(state.calls.length, 0);
});

test('queries nvidia-smi while the GPU is awake and remembers its name for sleep', async () => {
  const { createNvidiaCollector } = require('../src/system-sensors');
  const { state, deps } = createNvidiaFixture({ status: 'active' });
  const collect = createNvidiaCollector(deps);

  const awake = await collect();
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].file, 'nvidia-smi');
  assert.equal(awake.name, 'NVIDIA GeForce RTX 3050 Laptop GPU');
  assert.equal(awake.powerDraw, 6.5);

  state.status = 'suspended';
  state.clock = 20000;
  assert.deepEqual(await collect(), {
    available: true,
    asleep: true,
    name: 'NVIDIA GeForce RTX 3050 Laptop GPU',
    utilization: 0
  });
  assert.equal(state.calls.length, 1);
});

test('holds an idle reading so a runtime-PM GPU can reach suspend between queries', async () => {
  const { createNvidiaCollector } = require('../src/system-sensors');
  const { state, deps } = createNvidiaFixture({ status: 'active' });
  const collect = createNvidiaCollector(deps);

  const first = await collect();
  state.clock = 2000;
  assert.deepEqual(await collect(), first);
  state.clock = 8000;
  await collect();
  assert.equal(state.calls.length, 1);

  state.clock = 12000;
  await collect();
  assert.equal(state.calls.length, 2);
});

test('keeps polling a busy GPU on every sample', async () => {
  const { createNvidiaCollector } = require('../src/system-sensors');
  const { state, deps } = createNvidiaFixture({
    status: 'active',
    output: 'NVIDIA GeForce RTX 3050 Laptop GPU, 75, 3000, 4096, 70, 40, 60'
  });
  const collect = createNvidiaCollector(deps);

  await collect();
  state.clock = 2000;
  await collect();
  assert.equal(state.calls.length, 2);
});

test('polls every sample when runtime power management is off', async () => {
  const { createNvidiaCollector } = require('../src/system-sensors');
  const { state, deps } = createNvidiaFixture({ control: 'on', status: 'active' });
  const collect = createNvidiaCollector(deps);

  await collect();
  state.clock = 2000;
  await collect();
  assert.equal(state.calls.length, 2);
});

test('gives nvidia-smi longer than a measured 1.8 s dGPU wake-up to answer', async () => {
  const { createNvidiaCollector } = require('../src/system-sensors');
  const { state, deps } = createNvidiaFixture({ control: 'on', status: 'active' });

  await createNvidiaCollector(deps)();
  assert.ok(state.calls[0].options.timeout >= 2500);
});

test('reports no GPU when nvidia-smi fails and no NVIDIA driver is present', async () => {
  const { createNvidiaCollector } = require('../src/system-sensors');
  const collect = createNvidiaCollector({
    readDirectory: async () => { throw new Error('ENOENT'); },
    readText: async () => { throw new Error('ENOENT'); },
    execFile: (_file, _args, _options, callback) => {
      callback(new Error('spawn nvidia-smi ENOENT'));
      return { on() {} };
    }
  });

  assert.deepEqual(await collect(), { available: false });
});

function createBatteryFixture(files) {
  const state = { clock: 0, files: { ...files } };
  return {
    state,
    collector: require('../src/system-sensors').createLinuxSensorCollector({
      readDirectory: async (filePath) => {
        if (filePath === '/sys/class/power_supply') return ['BAT0'];
        return [];
      },
      readText: async (filePath) => {
        const name = filePath.replace('/sys/class/power_supply/BAT0/', '');
        const value = state.files[name];
        if (value === undefined) throw new Error('ENODEV: ' + filePath);
        return value;
      },
      now: () => state.clock
    })
  };
}

test('derives battery draw from current and voltage when power_now is unreadable', async () => {
  const { collector } = createBatteryFixture({
    type: 'Battery',
    status: 'Discharging',
    current_now: '1500000',
    voltage_now: '12000000'
  });

  assert.deepEqual((await collector()).power, { available: true, watts: 18, source: 'battery' });
});

test('estimates battery draw from energy_now steps when the battery reports no rate', async () => {
  const { state, collector } = createBatteryFixture({
    type: 'Battery',
    status: 'Discharging',
    voltage_now: '15906000',
    energy_now: '46662000'
  });
  const sampleAt = async (clock, energy) => {
    state.clock = clock;
    state.files.energy_now = energy;
    return (await collector()).power;
  };

  assert.deepEqual(await sampleAt(0, '46662000'), { available: false });
  assert.deepEqual(await sampleAt(2000, '46662000'), { available: false });
  assert.deepEqual(await sampleAt(4000, '46646000'), { available: false });
  // 15000 µWh between the first observed steps at 4 s and 8 s: 15 mWh / (4/3600 h) = 13.5 W.
  assert.deepEqual(await sampleAt(8000, '46631000'), { available: true, watts: 13.5, source: 'battery' });
  // 31000 µWh over 8 s = 13.95 W.
  assert.deepEqual(await sampleAt(12000, '46615000'), { available: true, watts: 13.95, source: 'battery' });
});

test('restarts the energy estimate after the battery stops discharging', async () => {
  const { state, collector } = createBatteryFixture({
    type: 'Battery',
    status: 'Discharging',
    energy_now: '46662000'
  });
  const sampleAt = async (clock, energy, status = 'Discharging') => {
    state.clock = clock;
    state.files.energy_now = energy;
    state.files.status = status;
    return (await collector()).power;
  };

  await sampleAt(0, '46662000');
  await sampleAt(2000, '46646000');
  assert.equal((await sampleAt(4000, '46631000')).available, true);

  await sampleAt(6000, '46700000', 'Charging');
  assert.deepEqual(await sampleAt(8000, '46690000'), { available: false });
  assert.deepEqual(await sampleAt(10000, '46680000'), { available: false });
  assert.equal((await sampleAt(12000, '46670000')).available, true);
});

const VM_STAT_OUTPUT = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                               13459.',
  'Pages active:                            336389.',
  'Pages inactive:                          332143.',
  'Pages speculative:                         2512.',
  'Pages throttled:                              0.',
  'Pages wired down:                        140823.',
  'Pages purgeable:                          10637.',
  '"Translation faults":                1234567890.'
].join('\n');

function createMacToolDouble(responses) {
  const calls = [];
  const execFile = (file, args, _options, callback) => {
    calls.push(file);
    const response = responses[file];
    if (response === undefined) callback(new Error(`spawn ${file} ENOENT`));
    else callback(null, response);
    return { on() {} };
  };
  return { calls, execFile, count: (file) => calls.filter((name) => name === file).length };
}

test('reports macOS available memory as free + inactive + speculative pages', async () => {
  const { createMacSensorCollector } = require('../src/system-sensors');
  const tools = createMacToolDouble({ vm_stat: VM_STAT_OUTPUT, pmset: "Now drawing from 'AC Power'" });

  const sensors = await createMacSensorCollector({ execFile: tools.execFile, now: () => 0 })();

  // (13459 + 332143 + 2512) pages × 16384 bytes
  assert.equal(sensors.availableMemory, 5703499776);
});

test('stops spawning macOS tools that are missing or need root, then retries later', async () => {
  const { createMacSensorCollector } = require('../src/system-sensors');
  const tools = createMacToolDouble({ vm_stat: VM_STAT_OUTPUT, pmset: "Now drawing from 'AC Power'" });
  let clock = 0;
  const collect = createMacSensorCollector({ execFile: tools.execFile, now: () => clock });

  await collect();
  clock = 2000;
  await collect();
  assert.equal(tools.count('osx-cpu-temp'), 1);
  assert.equal(tools.count('powermetrics'), 2);
  assert.equal(tools.count('ioreg'), 1);
  assert.equal(tools.count('vm_stat'), 2);
  assert.equal(tools.count('pmset'), 2);

  clock = 300000;
  await collect();
  assert.equal(tools.count('osx-cpu-temp'), 2);
  assert.equal(tools.count('powermetrics'), 4);
});

test('uses BAT1 power when BAT0 energy has not produced a usable estimate', async () => {
  const { createLinuxSensorCollector } = require('../src/system-sensors');
  let clock = 0;
  const collect = createLinuxSensorCollector({
    readDirectory: async (filePath) => filePath === '/sys/class/power_supply' ? ['BAT0', 'BAT1'] : [],
    readText: async (filePath) => ({
      '/sys/class/power_supply/BAT0/type': 'Battery',
      '/sys/class/power_supply/BAT0/status': 'Discharging',
      '/sys/class/power_supply/BAT0/energy_now': '46662000',
      '/sys/class/power_supply/BAT1/type': 'Battery',
      '/sys/class/power_supply/BAT1/status': 'Discharging',
      '/sys/class/power_supply/BAT1/power_now': '24000000'
    })[filePath],
    now: () => clock
  });

  assert.deepEqual((await collect()).power, { available: true, watts: 24, source: 'battery' });
  clock = 2000;
  assert.deepEqual((await collect()).power, { available: true, watts: 24, source: 'battery' });
});

test('keeps a completed Windows thermal reading when the later battery query times out', async () => {
  const { createWindowsSensorCollector } = require('../src/system-sensors');
  let clock = 0;
  const scripts = [];
  const collect = createWindowsSensorCollector({
    now: () => clock,
    execFile: (_file, args, _options, callback) => {
      scripts.push(args.at(-1));
      if (scripts.length === 1) {
        callback(new Error('PowerShell timed out'), '@@thermal\r\n3012\r\n@@thermal_done\r\n@@battery\r\n');
      } else {
        const battery = scripts.at(-1).includes('BatteryStatus')
          ? `@@battery\r\n${WINDOWS_BATTERY_DISCHARGING}\r\n@@battery_done\r\n`
          : '';
        callback(null, '@@thermal\r\n3012\r\n@@thermal_done\r\n' + battery);
      }
      return { on() {} };
    }
  });

  assert.deepEqual(await collect(), {
    cpuTemperature: 3012 / 10 - 273.15,
    power: { available: false }
  });
  clock = 10000;
  assert.equal((await collect()).cpuTemperature, 3012 / 10 - 273.15);
  assert.equal(scripts.length, 2);
  assert.equal(scripts[1].includes('BatteryStatus'), false);
  assert.equal(scripts[1].includes('MSAcpi_ThermalZoneTemperature'), true);
  clock = 300000;
  assert.deepEqual(await collect(), {
    cpuTemperature: 3012 / 10 - 273.15,
    power: { available: true, watts: 24, source: 'battery' }
  });
});

test('retries an unstarted Windows battery query next interval when the thermal query times out', async () => {
  const { createWindowsSensorCollector } = require('../src/system-sensors');
  let clock = 0;
  const scripts = [];
  const collect = createWindowsSensorCollector({
    now: () => clock,
    execFile: (_file, args, _options, callback) => {
      scripts.push(args.at(-1));
      if (scripts.length === 1) callback(new Error('PowerShell timed out'), '@@thermal\r\n');
      else callback(null, `@@battery\r\n${WINDOWS_BATTERY_DISCHARGING}\r\n@@battery_done\r\n`);
      return { on() {} };
    }
  });

  assert.deepEqual(await collect(), { cpuTemperature: undefined, power: { available: false } });
  clock = 10000;
  assert.deepEqual((await collect()).power, { available: true, watts: 24, source: 'battery' });
  assert.equal(scripts.length, 2);
  assert.equal(scripts[1].includes('MSAcpi_ThermalZoneTemperature'), false);
  assert.equal(scripts[1].includes('BatteryStatus'), true);
});

test('does not treat interrupted Windows query output as a completed reading', async () => {
  const { createWindowsSensorCollector } = require('../src/system-sensors');
  const collect = createWindowsSensorCollector({
    execFile: (_file, _args, _options, callback) => {
      callback(new Error('PowerShell timed out'), '@@thermal\r\n3012\r\n');
      return { on() {} };
    }
  });
  assert.deepEqual(await collect(), { cpuTemperature: undefined, power: { available: false } });
});
