'use strict';

function getWebviewHtml(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    :root {
      color-scheme: light dark;
      --surface: var(--vscode-sideBar-background, var(--vscode-editor-background));
      --ink: var(--vscode-sideBar-foreground, var(--vscode-editor-foreground));
      --muted: var(--vscode-descriptionForeground);
      --line: var(--vscode-sideBar-border, var(--vscode-panel-border, rgba(127, 127, 127, .28)));
      --track: color-mix(in srgb, var(--ink) 12%, transparent);
      --cyan: var(--vscode-terminal-ansiCyan, #58d4ff);
      --cpu: var(--vscode-terminal-ansiGreen, #7ee787);
      --memory: var(--vscode-terminal-ansiMagenta, #ff7bce);
      --gpu: var(--vscode-terminal-ansiYellow, #f2cc60);
      --power: var(--vscode-terminal-ansiBlue, #58a6ff);
      --danger: var(--vscode-errorForeground, #f14c4c);
    }

    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    html, body { width: 100%; margin: 0; padding: 0; }

    body {
      overflow-x: hidden;
      color: var(--ink);
      background: var(--surface);
      font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
      font-size: calc(var(--vscode-editor-font-size, 13px) - 2px);
      line-height: 1.12;
    }

    main { width: 100%; padding: 3px 7px 5px; }

    .system-strip {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto auto;
      align-items: center;
      gap: 7px;
      min-width: 0;
      padding: 1px 0 3px;
      color: var(--muted);
      font-size: .84em;
      font-variant-numeric: tabular-nums;
    }

    .system-strip span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .state::before {
      content: '';
      display: inline-block;
      width: 5px;
      height: 5px;
      margin-right: 4px;
      border-radius: 50%;
      background: var(--cpu);
      box-shadow: 0 0 5px color-mix(in srgb, var(--cpu) 70%, transparent);
      vertical-align: 1px;
    }
    .state.paused::before { background: var(--gpu); box-shadow: none; }
    .state.error::before { background: var(--danger); box-shadow: none; }

    .metric {
      --accent: var(--cpu);
      padding: 3px 0;
      border-top: 1px solid var(--line);
    }
    .metric.memory { --accent: var(--memory); }
    .metric.gpu { --accent: var(--gpu); }
    .metric.power { --accent: var(--power); }

    .metric-row {
      display: grid;
      grid-template-columns: 29px 39px minmax(42px, 1fr) minmax(34px, 54px);
      align-items: center;
      gap: 5px;
      min-width: 0;
      min-height: 14px;
    }

    .metric-row + .metric-row { margin-top: 2px; }

    .label {
      overflow: hidden;
      color: var(--cyan);
      font-weight: 700;
      letter-spacing: .01em;
      white-space: nowrap;
    }

    .value {
      overflow: hidden;
      color: var(--accent);
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      text-align: right;
      white-space: nowrap;
    }

    .meter {
      height: 6px;
      overflow: hidden;
      border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line));
      background: var(--track);
    }

    .meter-fill {
      width: 0;
      height: 100%;
      background: var(--accent);
      transition: width 180ms linear;
    }

    .sparkline {
      display: flex;
      align-items: flex-end;
      gap: 1px;
      height: 14px;
      overflow: hidden;
      border-bottom: 1px solid color-mix(in srgb, var(--accent) 32%, transparent);
    }

    .sparkline > i {
      flex: 1 1 1px;
      min-width: 1px;
      height: 5%;
      background: var(--accent);
      opacity: .78;
    }

    .trail,
    .power-readout {
      min-width: 0;
      overflow: hidden;
      color: var(--muted);
      font-size: .84em;
      font-variant-numeric: tabular-nums;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .trail { text-align: right; }
    .power-readout { color: var(--ink); text-align: center; }

    .details {
      display: flex;
      gap: 0;
      min-width: 0;
      margin-top: 2px;
      padding-left: 34px;
      overflow: hidden;
      color: var(--muted);
      font-size: .79em;
      white-space: nowrap;
    }

    .details span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .details span + span::before {
      content: '·';
      padding: 0 4px;
      color: color-mix(in srgb, var(--muted) 60%, transparent);
    }

    .details b { color: var(--ink); font-weight: 500; font-variant-numeric: tabular-nums; }

    .error-message {
      margin: 0 0 3px;
      padding: 2px 5px;
      border-left: 2px solid var(--danger);
      color: var(--danger);
      background: color-mix(in srgb, var(--danger) 8%, transparent);
      font-size: .8em;
    }

    @media (max-width: 260px) {
      #updated { display: none; }
    }

    @media (max-width: 220px) {
      main { padding-inline: 5px; }
      .metric-row { grid-template-columns: 27px 37px minmax(36px, 1fr); gap: 4px; }
      .sparkline, .trail { display: none; }
      .details { padding-left: 31px; }
    }

    @media (prefers-reduced-motion: reduce) {
      .meter-fill { transition: none; }
    }
  </style>
</head>
<body>
  <main>
    <header class="system-strip" id="system-strip">
      <span id="host">connecting…</span>
      <span id="uptime">up --</span>
      <span id="updated">--:--:--</span>
      <span class="state" id="state" aria-live="polite">sampling</span>
    </header>
    <p class="error-message" id="error" hidden></p>

    <section class="metric cpu" id="cpu-section">
      <div class="metric-row">
        <span class="label">CPU</span>
        <span class="value" id="cpu-value">--%</span>
        <div class="meter" id="cpu-meter" role="progressbar" aria-label="CPU utilization" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="meter-fill"></div></div>
        <div class="sparkline" id="cpu-history" aria-hidden="true"></div>
      </div>
      <div class="details"><span><b id="cpu-cores">--</b>T</span><span>L <b id="cpu-load">--</b></span><span>temp <b id="cpu-temp">--°C</b></span><span id="cpu-model">waiting for sample</span></div>
    </section>

    <section class="metric memory" id="memory-section">
      <div class="metric-row">
        <span class="label">MEM</span>
        <span class="value" id="memory-value">--%</span>
        <div class="meter" id="memory-meter" role="progressbar" aria-label="Memory utilization" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="meter-fill"></div></div>
        <div class="sparkline" id="memory-history" aria-hidden="true"></div>
      </div>
      <div class="details"><span>used <b id="memory-used">--</b></span><span>free <b id="memory-free">--</b></span><span>total <b id="memory-total">--</b></span><span id="memory-kind" hidden>unified</span></div>
    </section>

    <section class="metric gpu" id="gpu-section" hidden>
      <div class="metric-row">
        <span class="label">GPU</span>
        <span class="value" id="gpu-value">--%</span>
        <div class="meter" id="gpu-meter" role="progressbar" aria-label="GPU utilization" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="meter-fill"></div></div>
        <div class="sparkline" id="gpu-history" aria-hidden="true"></div>
      </div>
      <div class="metric-row" id="vram-row">
        <span class="label">VRM</span>
        <span class="value" id="vram-value">--%</span>
        <div class="meter" id="vram-meter" role="progressbar" aria-label="VRAM utilization" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="meter-fill"></div></div>
        <span class="trail" id="vram-ratio">--/--</span>
      </div>
      <div class="details"><span id="gpu-name">NVIDIA GPU</span><span id="gpu-mem-note" hidden>shared memory</span><span>temp <b id="gpu-temp">--°C</b></span><span>power <b id="gpu-power">--W</b></span></div>
    </section>

    <section class="metric power" id="power-section">
      <div class="metric-row" id="power-row" title="Power sensor unavailable">
        <span class="label">PWR</span>
        <span class="value" id="power-value">--W</span>
        <span class="power-readout" id="power-breakdown">sensor unavailable</span>
        <div class="sparkline" id="power-history" aria-hidden="true"></div>
      </div>
      <div class="details" id="power-details"><span id="power-source">OS power sensor unavailable</span></div>
    </section>
  </main>

  <script nonce="${nonce}">
    const byId = (id) => document.getElementById(id);
    const clamp = (value) => Math.max(0, Math.min(100, Number(value) || 0));
    const gib = (bytes) => (Number(bytes) / 1073741824).toFixed(1) + 'G';
    const mibToGib = (mib) => (Number(mib) / 1024).toFixed(1) + 'G';

    function formatUptime(seconds) {
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return days > 0 ? days + 'd' + hours + 'h' : hours + 'h' + minutes + 'm';
    }

    function setMeter(id, value) {
      const meter = byId(id);
      const safeValue = clamp(value);
      meter.setAttribute('aria-valuenow', safeValue.toFixed(1));
      meter.firstElementChild.style.width = safeValue + '%';
    }

    function drawHistory(id, values, maximum = 100) {
      const graph = byId(id);
      const fragment = document.createDocumentFragment();
      for (const value of values || []) {
        const bar = document.createElement('i');
        const height = maximum > 0 ? Number(value) / maximum * 100 : 0;
        bar.style.height = Math.max(5, Math.min(100, height)) + '%';
        fragment.appendChild(bar);
      }
      graph.replaceChildren(fragment);
    }

    function setState(paused, error) {
      const state = byId('state');
      state.className = 'state' + (error ? ' error' : paused ? ' paused' : '');
      state.textContent = error ? 'error' : paused ? 'paused' : 'live';
      byId('error').hidden = !error;
      byId('error').textContent = error || '';
    }

    function render(metrics) {
      byId('host').textContent = metrics.host;
      byId('cpu-value').textContent = metrics.cpu.usage.toFixed(1) + '%';
      byId('cpu-cores').textContent = metrics.cpu.cores;
      byId('cpu-load').textContent = metrics.cpu.load.map((value) => value.toFixed(2)).join('/');
      byId('cpu-temp').textContent = Number.isFinite(metrics.cpu.temperature) ? metrics.cpu.temperature.toFixed(0) + '°C' : '--°C';
      byId('cpu-model').textContent = metrics.cpu.model;
      setMeter('cpu-meter', metrics.cpu.usage);
      drawHistory('cpu-history', metrics.history.cpu);

      byId('memory-value').textContent = metrics.memory.usage.toFixed(1) + '%';
      byId('memory-used').textContent = gib(metrics.memory.used);
      byId('memory-free').textContent = gib(metrics.memory.total - metrics.memory.used);
      byId('memory-total').textContent = gib(metrics.memory.total);
      byId('memory-kind').hidden = !metrics.memory.unified;
      setMeter('memory-meter', metrics.memory.usage);
      drawHistory('memory-history', metrics.history.memory);

      const hasGpu = Boolean(metrics.gpu.available);
      byId('gpu-section').hidden = !hasGpu;
      if (hasGpu) {
        const sharedMemory = Boolean(metrics.gpu.memoryShared || metrics.memory.unified);
        byId('vram-row').hidden = sharedMemory;
        byId('gpu-mem-note').hidden = !sharedMemory;
        const vramUsage = metrics.gpu.memoryTotal > 0 ? metrics.gpu.memoryUsed / metrics.gpu.memoryTotal * 100 : 0;
        byId('gpu-value').textContent = metrics.gpu.utilization.toFixed(1) + '%';
        byId('vram-value').textContent = vramUsage.toFixed(1) + '%';
        byId('vram-ratio').textContent = mibToGib(metrics.gpu.memoryUsed) + '/' + mibToGib(metrics.gpu.memoryTotal);
        byId('gpu-name').textContent = metrics.gpu.name;
        byId('gpu-temp').textContent = metrics.gpu.temperature.toFixed(0) + '°C';
        byId('gpu-power').textContent = Number.isFinite(metrics.gpu.powerDraw) ? metrics.gpu.powerDraw.toFixed(1) + 'W' : '--W';
        setMeter('gpu-meter', metrics.gpu.utilization);
        setMeter('vram-meter', vramUsage);
        drawHistory('gpu-history', metrics.history.gpu);
      }

      const power = metrics.power || { available: false };
      if (power.available) {
        const parts = [];
        if (Number.isFinite(power.cpuWatts)) parts.push('CPU ' + power.cpuWatts.toFixed(0) + 'W');
        if (Number.isFinite(power.gpuWatts)) parts.push('GPU ' + power.gpuWatts.toFixed(0) + 'W');
        const source = power.source === 'platform' ? 'system total' : power.source === 'battery' ? 'battery draw' : '';
        byId('power-value').textContent = power.watts.toFixed(1) + 'W';
        byId('power-breakdown').textContent = parts.join('  ') || source;
        byId('power-source').textContent = source;
        byId('power-details').hidden = !source;
        byId('power-row').title = source + (parts.length ? ' | ' + parts.join(' | ') : '');
        const powerHistory = metrics.history.power || [];
        drawHistory('power-history', powerHistory, Math.max(1, ...powerHistory));
      } else {
        byId('power-value').textContent = '--W';
        byId('power-breakdown').textContent = 'sensor unavailable';
        byId('power-source').textContent = 'OS power sensor unavailable';
        byId('power-details').hidden = false;
        byId('power-row').title = 'Power sensor unavailable or locked by the operating system';
        byId('power-history').replaceChildren();
      }

      byId('uptime').textContent = 'up ' + formatUptime(metrics.uptime);
      byId('updated').textContent = new Date(metrics.sampledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    window.addEventListener('message', ({ data }) => {
      if (data.type !== 'cutieboard.state') return;
      setState(data.paused, data.error);
      if (data.metrics) render(data.metrics);
    });
  </script>
</body>
</html>`;
}

module.exports = { getWebviewHtml };
