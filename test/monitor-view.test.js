const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('ships the Explorer monitor view renderer', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'monitor-view.js')), true);
});

test('renders the compact CPU, memory, optional GPU, and system regions', () => {
  const { getWebviewHtml } = require('../monitor-view');
  const html = getWebviewHtml('test-nonce');

  assert.match(html, /id="cpu-section"/);
  assert.match(html, /id="memory-section"/);
  assert.match(html, /id="gpu-section"[^>]*hidden/);
  assert.match(html, /id="system-strip"/);
  assert.equal((html.match(/role="progressbar"/g) || []).length, 4);
});

test('renders a nonce-protected script and accessible live state', () => {
  const { getWebviewHtml } = require('../monitor-view');
  const html = getWebviewHtml('test-nonce');

  assert.match(html, /script-src 'nonce-test-nonce'/);
  assert.match(html, /<script nonce="test-nonce">/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-label="CPU utilization"/);
  assert.match(html, /aria-label="Memory utilization"/);
});

test('renders telemetry as compact btop rows with supporting detail lines', () => {
  const { getWebviewHtml } = require('../monitor-view');
  const html = getWebviewHtml('test-nonce');

  assert.equal((html.match(/class="metric-row"/g) || []).length, 5);
  assert.equal((html.match(/class="sparkline"/g) || []).length, 4);
  assert.doesNotMatch(html, /class="submetric"/);
  assert.match(html, /class="details"/);
});

test('renders CPU and GPU temperatures plus a power row', () => {
  const { getWebviewHtml } = require('../monitor-view');
  const html = getWebviewHtml('test-nonce');

  assert.match(html, /id="cpu-temp"/);
  assert.match(html, /id="gpu-temp"/);
  assert.match(html, /id="power-row"/);
  assert.match(html, /id="power-value"/);
});

test('uses continuous meters and vertical micro-history bars', () => {
  const { getWebviewHtml } = require('../monitor-view');
  const html = getWebviewHtml('test-nonce');

  assert.doesNotMatch(html, /repeating-linear-gradient/);
  assert.doesNotMatch(html, /▁▂▃▄▅▆▇█/);
  assert.match(html, /document\.createElement\('i'\)/);
});
