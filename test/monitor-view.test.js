const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadView, metricsFixture } = require('./view-harness');

test('ships the Explorer monitor view renderer', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'monitor-view.js')), true);
});

test('renders the compact CPU, memory, optional GPU, and system regions', () => {
  const { getWebviewHtml } = require('../src/monitor-view');
  const html = getWebviewHtml('test-nonce');

  assert.match(html, /id="cpu-section"/);
  assert.match(html, /id="memory-section"/);
  assert.match(html, /id="gpu-section"[^>]*hidden/);
  assert.match(html, /id="system-strip"/);
  assert.equal((html.match(/role="progressbar"/g) || []).length, 4);
});

test('renders a nonce-protected script and accessible live state', () => {
  const { getWebviewHtml } = require('../src/monitor-view');
  const html = getWebviewHtml('test-nonce');

  assert.match(html, /script-src 'nonce-test-nonce'/);
  assert.match(html, /<script nonce="test-nonce">/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-label="CPU utilization"/);
  assert.match(html, /aria-label="Memory utilization"/);
});

test('renders telemetry as compact btop rows with supporting detail lines', () => {
  const { getWebviewHtml } = require('../src/monitor-view');
  const html = getWebviewHtml('test-nonce');

  assert.equal((html.match(/class="metric-row"/g) || []).length, 5);
  assert.equal((html.match(/class="sparkline"/g) || []).length, 4);
  assert.doesNotMatch(html, /class="submetric"/);
  assert.match(html, /class="details"/);
});

test('renders CPU and GPU temperatures plus a power row', () => {
  const { getWebviewHtml } = require('../src/monitor-view');
  const html = getWebviewHtml('test-nonce');

  assert.match(html, /id="cpu-temp"/);
  assert.match(html, /id="gpu-temp"/);
  assert.match(html, /id="power-row"/);
  assert.match(html, /id="power-value"/);
});

test('uses continuous meters and vertical micro-history bars', () => {
  const { getWebviewHtml } = require('../src/monitor-view');
  const html = getWebviewHtml('test-nonce');

  assert.doesNotMatch(html, /repeating-linear-gradient/);
  assert.doesNotMatch(html, /▁▂▃▄▅▆▇█/);
  assert.match(html, /document\.createElement\('i'\)/);
});

test('labels a component-only power reading so it is not read as a system total', () => {
  const view = loadView();
  view.post({
    paused: false,
    metrics: metricsFixture({
      power: { available: true, watts: 15.3, gpuWatts: 15.3, source: 'components' },
      history: { cpu: [21.2], memory: [50], gpu: [], power: [15.3] }
    })
  });

  assert.equal(view.byId('power-value').textContent, '15.3W');
  assert.equal(view.byId('power-details').hidden, false);
  assert.match(view.byId('power-source').textContent, /gpu only/i);
  assert.notEqual(view.byId('power-source').textContent, 'system total');
});

test('names both components when a reading sums CPU and GPU without a system sensor', () => {
  const view = loadView();
  view.post({
    paused: false,
    metrics: metricsFixture({
      power: { available: true, watts: 40, cpuWatts: 25, gpuWatts: 15, source: 'components' }
    })
  });

  assert.equal(view.byId('power-details').hidden, false);
  assert.match(view.byId('power-source').textContent, /cpu \+ gpu/i);
});

test('keeps platform readings labeled as the system total', () => {
  const view = loadView();
  view.post({
    paused: false,
    metrics: metricsFixture({
      power: { available: true, watts: 70, cpuWatts: 25, gpuWatts: 30, source: 'platform' }
    })
  });

  assert.equal(view.byId('power-source').textContent, 'system total');
});

test('shows a runtime-suspended GPU as asleep without inventing readings', () => {
  const view = loadView();
  view.post({
    paused: false,
    metrics: metricsFixture({
      gpu: { available: true, asleep: true, name: 'NVIDIA GeForce RTX 3050 Laptop GPU', utilization: 0 },
      history: { cpu: [21.2], memory: [50], gpu: [0], power: [] }
    })
  });

  assert.equal(view.byId('gpu-section').hidden, false);
  assert.equal(view.byId('gpu-value').textContent, 'sleep');
  assert.equal(view.byId('vram-row').hidden, true);
  assert.equal(view.byId('gpu-sleep-note').hidden, false);
  assert.equal(view.byId('gpu-temp').textContent, '--°C');
  assert.equal(view.byId('gpu-power').textContent, '--W');
});

test('restores the full GPU rows when the GPU wakes up', () => {
  const view = loadView();
  view.post({
    paused: false,
    metrics: metricsFixture({ gpu: { available: true, asleep: true, name: 'GPU', utilization: 0 } })
  });
  view.post({
    paused: false,
    metrics: metricsFixture({
      gpu: {
        available: true,
        name: 'GPU',
        utilization: 40,
        memoryUsed: 1024,
        memoryTotal: 4096,
        temperature: 60,
        powerDraw: 20
      },
      history: { cpu: [21.2], memory: [50], gpu: [0, 40], power: [] }
    })
  });

  assert.equal(view.byId('gpu-value').textContent, '40.0%');
  assert.equal(view.byId('vram-row').hidden, false);
  assert.equal(view.byId('gpu-sleep-note').hidden, true);
  assert.equal(view.byId('gpu-temp').textContent, '60°C');
});
