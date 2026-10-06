'use strict';

// Runs the webview's inline script against a minimal DOM double so view
// behavior can be asserted without a browser or a DOM dependency.
const vm = require('node:vm');
const { getWebviewHtml } = require('../src/monitor-view');

class FakeElement {
  constructor(hidden = false) {
    this.hidden = hidden;
    this.textContent = '';
    this.className = '';
    this.title = '';
    this.attributes = {};
    this.style = {};
    this.children = [];
    this.firstElementChild = { style: {} };
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  appendChild(node) {
    this.children.push(node);
  }

  replaceChildren(...nodes) {
    this.children = nodes.flatMap((node) => (node.isFragment ? node.children : [node]));
  }
}

function loadView() {
  const html = getWebviewHtml('harness');
  const script = html.match(/<script nonce="harness">([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  for (const match of html.matchAll(/<[a-z]+\b([^>]*)>/g)) {
    const id = match[1].match(/\sid="([^"]+)"/);
    if (id) elements.set(id[1], new FakeElement(/\shidden(\s|$)/.test(match[1])));
  }

  let onMessage;
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: () => new FakeElement(),
    createDocumentFragment: () => Object.assign(new FakeElement(), { isFragment: true })
  };
  const window = {
    addEventListener: (type, listener) => {
      if (type === 'message') onMessage = listener;
    }
  };
  vm.runInNewContext(script, { document, window });

  return {
    byId: (id) => elements.get(id),
    post: (data) => onMessage({ data: { type: 'cutieboard.state', ...data } })
  };
}

function metricsFixture(overrides = {}) {
  return {
    host: 'victus',
    uptime: 7200,
    sampledAt: 0,
    cpu: { usage: 21.2, cores: 12, model: 'Test CPU', load: [2.49, 2, 1.5], temperature: 55 },
    memory: { used: 7, total: 14, usage: 50 },
    gpu: { available: false },
    power: { available: false },
    history: { cpu: [21.2], memory: [50], gpu: [], power: [] },
    ...overrides
  };
}

module.exports = { loadView, metricsFixture };
