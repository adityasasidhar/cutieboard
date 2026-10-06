# AGENTS.md — Cutieboard

VS Code Explorer system monitor. Zero dependencies — Node builtins + `vscode` API only. Do not add dependencies.

## Layout

All source lives in `src/` (`package.json` `main` is `./src/extension.js`); tests stay in `test/` and require `../src/<module>`.

- `src/extension.js` — activation, metric orchestration, webview provider, commands. Test seams via `module.exports._test` (`createCutieboardRuntime`, `createSystemMetricsCollector`, `createSensorCollector`).
- `src/monitor-core.js` — pure logic: CPU math, NVIDIA parsing, power merging, `AsyncSampler`, `TelemetryStore`.
- `src/system-sensors.js` — OS collectors: Linux hwmon/RAPL/battery, NVIDIA (`createNvidiaCollector`), macOS powermetrics/ioreg/pmset/vm_stat, Windows WMI. All parsing helpers exposed under `_test`.
- `src/monitor-view.js` — webview HTML/CSS/JS via `getWebviewHtml(nonce)`. Single file, inline script only.
- `test/*.test.js` — `node:test` + `node:assert/strict`, no test framework.

## Commands

```bash
npm run check    # node --check on all 4 source files; add new files here too
npm test         # node --test test/*.test.js
node --test test/<name>.test.js  # single suite
npm run package  # vsce build (*.vsix is gitignored; do not commit)
```

Manual run: F5 → "Run Cutieboard" (`.vscode/launch.json`), then open Explorer → Cutieboard in the Extension Development Host.

## Gotchas

- Missing sensors must degrade to "unavailable", never throw. Follow existing patterns: `safeText`/`safeDirectory` return `undefined`/`[]` on error, exec runner resolves `undefined` on error/timeout. Validate ranges (temp −20…150 °C, watts ≥ 0).
- Power merge priority in `mergePowerReadings` (`monitor-core.js`): `platform`/`battery` source wins as system total; otherwise sum available `cpuWatts` + `gpuWatts` with `source: 'components'`; `nvidia-smi powerDraw` beats sensor `gpuWatts`. Keep in sync with the view's `system total` / `battery draw` / `… only · no system total` labels.
- Sampling is visibility-gated in `createCutieboardRuntime`: nothing samples until `resolveWebviewView`, the timer stops on `onDidChangeVisibility` → hidden / `onDidDispose`, and `activationEvents` is `[]` (lazy, no `onStartupFinished`). Do not reintroduce background sampling — each tick spawns `nvidia-smi` (and PowerShell on Windows).
- `createNvidiaCollector` (`system-sensors.js`) reads `/proc/driver/nvidia/gpus` + `/sys/bus/pci/devices/<addr>/power/{control,runtime_status}` first. All GPUs `suspended` under `control=auto` → `{ available, asleep, name, utilization: 0 }` without spawning (nvidia-smi would wake the dGPU). An idle (0%) reading is held for 10 s so the GPU can autosuspend. nvidia-smi timeout is 3 s (a dGPU wake measured ~1.8 s).
- Linux battery power falls back `power_now` → `current_now`×`voltage_now` → `energy_now` drain rate (between first observations of each counter step, 60 s window, reset when not discharging).
- Spawned tools back off: macOS commands via `createBackoffRunner` (5 min after failure/empty output); Windows runs one PowerShell script with `@@<key>` section markers, at most every 10 s, dropping an empty query for 5 min.
- CPU usage window is bounded (`CPU_MIN_WINDOW_MS`/`CPU_MAX_WINDOW_MS` in `extension.js`): a first or post-gap sample re-baselines and waits 250 ms. Collectors take injectable `now`/`sleep` for tests.
- macOS memory uses `availableMemory` from `vm_stat` (free + inactive + speculative) because `os.freemem()` there counts only free pages.
- Apple Silicon (`darwin` + `arm64` in `isUnifiedMemory`): memory is `unified`, VRAM row hides. GPU section hides entirely when `nvidia-smi` is absent.
- `AsyncSampler`: `sample()` skips when paused unless `force: true`; `inFlight` guard prevents overlapping slow-sensor samples. Refresh command uses force; timer loop does not.
- `TelemetryStore(60)`: 60-sample history; GPU/power history reset to `[]` when unavailable (sparse sparklines, not stale data).
- Webview CSP is `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-…'`. No external resources; all JS in the single nonced inline `<script>`. New DOM ids need matching render code + test coverage.
- `package.json` contributions (view id `cutieboard.monitorView`, view-title buttons gated on `cutieboard.paused` context, `cutieboard.refreshInterval` 1000–10000 ms) are enforced by `test/extension-contract.test.js`. Update manifest + `extension.js` + tests together.
- Tests inject fakes (vscode double via `Module._load` intercept, fake `os`/`fs`/`execFile`); never spawn real subprocesses or touch `/sys` in tests. View behavior is tested by running the inline script against a fake DOM in `test/view-harness.js` (`loadView().post({ metrics })`, then `byId(...)`).
- `.vscodeignore` excludes `test/`, `*.vsix`, editor/session dirs from the package. `cutieboard-0.1.0.vsix` in repo root is a stale local build artifact.
