const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../package.json');

test('contributes an initially visible Cutieboard view to Explorer', () => {
  assert.deepEqual(manifest.contributes.views.explorer, [{
    id: 'cutieboard.monitorView',
    name: 'Cutieboard',
    type: 'webview',
    visibility: 'visible'
  }]);
  assert.ok(manifest.activationEvents.includes('onStartupFinished'));
});

test('contributes native monitor actions to the Cutieboard view title', () => {
  const titleCommands = manifest.contributes.menus['view/title']
    .filter((item) => item.when.includes('cutieboard.monitorView'))
    .map((item) => item.command);

  assert.deepEqual(titleCommands.sort(), [
    'cutieboard.pause',
    'cutieboard.refresh',
    'cutieboard.resume'
  ]);
});

test('status bar configuration is no longer exposed', () => {
  assert.equal(
    Object.hasOwn(manifest.contributes.configuration.properties, 'cutieboard.showStatusBar'),
    false
  );
});

test('points its marketplace icon at a shipped PNG logo', () => {
  assert.equal(manifest.icon, 'media/cutieboard.png');
  assert.equal(fs.existsSync(path.join(__dirname, '..', manifest.icon)), true);
});
