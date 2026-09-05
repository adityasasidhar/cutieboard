const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('ships the Linux temperature and power sensor collector', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'system-sensors.js')), true);
});

test('reads CPU package temperature and derives platform and CPU watts from RAPL energy', async () => {
  const { createLinuxSensorCollector } = require('../system-sensors');
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
  const { createLinuxSensorCollector } = require('../system-sensors');
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
  const { createLinuxSensorCollector } = require('../system-sensors');
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
  const { _test } = require('../system-sensors');
  assert.equal(_test.parseWmiThermalZoneOutput('2982\r\n3012\r\n'), 3012 / 10 - 273.15);
  assert.equal(_test.parseWmiThermalZoneOutput('no thermal zones here'), undefined);
  assert.equal(_test.parseWmiThermalZoneOutput('0'), undefined);
  assert.equal(_test.parseWmiThermalZoneOutput(undefined), undefined);
});

test('reads Windows battery discharge rate in milliwatts while discharging', () => {
  const { _test } = require('../system-sensors');
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

test('collects Windows temperature and battery power via PowerShell WMI queries', async () => {
  const { createWindowsSensorCollector } = require('../system-sensors');
  const seen = [];
  const execFile = (file, args, _options, callback) => {
    seen.push([file, args.at(-1)]);
    const command = args.at(-1);
    if (command.includes('MSAcpi_ThermalZoneTemperature')) callback(null, '3012\r\n');
    else callback(null, [
      'Voltage : 12000',
      'ChargeRate : 0',
      'DischargeRate : 24000',
      'Charging : False',
      'Discharging : True',
      'PowerOnline : False'
    ].join('\r\n'));
    return { on() {} };
  };

  assert.deepEqual(await createWindowsSensorCollector({ execFile })(), {
    cpuTemperature: 3012 / 10 - 273.15,
    power: { available: true, watts: 24, source: 'battery' }
  });
  assert.deepEqual(seen.map(([file]) => file), ['powershell.exe', 'powershell.exe']);
});

test('reports unavailable Windows sensors when WMI queries fail', async () => {
  const { createWindowsSensorCollector } = require('../system-sensors');
  const execFile = (_file, _args, _options, callback) => {
    callback(new Error('WMI class not found'));
    return { on() {} };
  };

  assert.deepEqual(await createWindowsSensorCollector({ execFile })(), {
    cpuTemperature: undefined,
    power: { available: false }
  });
});
