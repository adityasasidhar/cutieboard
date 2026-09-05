# AGENTS.md — Cutieboard

VS Code Explorer system monitor. Zero dependencies — Node builtins + `vscode` API only. Do not add dependencies.

## Layout

- `extension.js` — activation, metric orchestration, webview provider, commands. Test seams via `module.exports._test` (`createCutieboardRuntime`, `createSystemMetricsCollector`, `createSensorCollector`).
- `monitor-core.js` — pure logic: CPU math, NVIDIA parsing, power merging, `AsyncSampler`, `TelemetryStore`.
- `system-sensors.js` — OS collectors: Linux hwmon/RAPL/battery, macOS powermetrics/ioreg/pmset, Windows WMI. All parsing helpers exposed under `_test`.
- `monitor-view.js` — webview HTML/CSS/JS via `getWebviewHtml(nonce)`. Single file, inline script only.
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
- Power merge priority in `mergePowerReadings` (`monitor-core.js`): `platform`/`battery` source wins as system total; otherwise sum available `cpuWatts` + `gpuWatts` with `source: 'components'`; `nvidia-smi powerDraw` beats sensor `gpuWatts`. Keep in sync with the view's `system total` / `battery draw` labels.
- Apple Silicon (`darwin` + `arm64` in `isUnifiedMemory`): memory is `unified`, VRAM row hides. GPU section hides entirely when `nvidia-smi` is absent.
- `AsyncSampler`: `sample()` skips when paused unless `force: true`; `inFlight` guard prevents overlapping slow-sensor samples. Refresh command uses force; timer loop does not.
- `TelemetryStore(60)`: 60-sample history; GPU/power history reset to `[]` when unavailable (sparse sparklines, not stale data).
- Webview CSP is `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-…'`. No external resources; all JS in the single nonced inline `<script>`. New DOM ids need matching render code + test coverage.
- `package.json` contributions (view id `cutieboard.monitorView`, view-title buttons gated on `cutieboard.paused` context, `cutieboard.refreshInterval` 1000–10000 ms) are enforced by `test/extension-contract.test.js`. Update manifest + `extension.js` + tests together.
- Tests inject fakes (vscode double via `Module._load` intercept, fake `os`/`fs`/`execFile`); never spawn real subprocesses or touch `/sys` in tests.
- `.vscodeignore` excludes `test/`, `*.vsix`, editor/session dirs from the package. `cutieboard-0.1.0.vsix` in repo root is a stale local build artifact.
