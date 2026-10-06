# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Cutieboard is a VS Code extension: a btop-style system monitor (CPU, memory, GPU, temperature, power) in a webview at the bottom of the Explorer sidebar. Plain CommonJS JavaScript, **zero dependencies** — Node builtins plus the `vscode` API only. Do not add any. The defining idea is graceful degradation: every sensor is optional, and a missing one shows as `--`, never as an error or an invented number.

`AGENTS.md` carries a longer list of per-feature gotchas (battery fallbacks, Windows/macOS back-off timings, power-label rules). Read it before changing `system-sensors.js` or the power-merge logic.

```bash
npm run check                     # node --check on the 4 src files — the list is hardcoded in package.json; add new files there
npm test                          # node --test test/*.test.js (no test framework, no build step)
node --test test/monitor-core.test.js   # single suite
node --test --test-name-pattern="battery" test/system-sensors.test.js   # single test by name
npm run package                   # vsce → cutieboard-<version>.vsix (gitignored; don't commit)
# Manual run: open the folder in VS Code, F5 → "Run Cutieboard", expand Explorer → Cutieboard in the dev host
```

There is no linter, formatter, TypeScript, or CI.

## Architecture

Data flows one way: **collectors → `collectMetrics()` → `AsyncSampler` → `TelemetryStore` → `postMessage` → webview**.

- `src/extension.js` wires everything. `createSystemMetricsCollector` builds one metrics snapshot per tick (CPU delta from two `os.cpus()` snapshots, memory, plus GPU and sensor collectors run in parallel). `createCutieboardRuntime` owns the timer, the webview provider, the commands, and the `cutieboard.paused` context key. The extension host only ever sends `{ type: 'cutieboard.state', metrics, paused, error }` to the view; the view sends nothing back.
- `src/monitor-core.js` is pure logic with no I/O: `calculateCpuUsage`, `parseNvidiaOutput`, `mergePowerReadings`, `AsyncSampler` (pause + in-flight guard), `TelemetryStore` (60-sample history attached to each metrics object).
- `src/system-sensors.js` holds the per-OS collectors — Linux hwmon/RAPL/battery, NVIDIA (`createNvidiaCollector`), macOS `powermetrics`/`ioreg`/`pmset`/`vm_stat`, Windows WMI via one PowerShell process. Collectors are factories that take injected `readDirectory`/`readText`/`execFile`/`now`/`sleep`, which is what makes them testable.
- `src/monitor-view.js` exports `getWebviewHtml(nonce)`: the entire webview (HTML, CSS, one inline `<script>`) as a string. CSP is `default-src 'none'`, so no external resources and no separate JS/CSS files.

## Constraints that aren't obvious from reading one file

- **Sampling is visibility-gated.** Nothing samples until `resolveWebviewView`; the timer stops when the view is hidden or disposed; `activationEvents` is `[]`. Reason: each tick can spawn `nvidia-smi` (and PowerShell on Windows), and querying `nvidia-smi` wakes a runtime-suspended laptop dGPU. Do not add background sampling. `retainContextWhenHidden` keeps the sparkline history in the webview while hidden.
- **Don't wake a sleeping GPU.** `createNvidiaCollector` checks `/proc/driver/nvidia/gpus` and `/sys/bus/pci/devices/*/power/` first and reports `asleep` without spawning `nvidia-smi` when all GPUs are suspended.
- **Never throw on a missing sensor.** Follow the existing helpers (`safeText`/`safeDirectory` return `undefined`/`[]`; the exec runner resolves `undefined` on error or timeout) and range-check values (temperature −20…150 °C, watts ≥ 0).
- **Power labels depend on merge order.** `mergePowerReadings` prefers a platform/battery total, else sums CPU+GPU as `source: 'components'`, with `nvidia-smi` GPU watts beating sensor GPU watts. The view's `system total` / `battery draw` / `… only · no system total` labels must stay in sync with it.
- **Manifest, runtime and tests move together.** `package.json` contributions (view id `cutieboard.monitorView`, title-bar buttons gated on `cutieboard.paused`, `cutieboard.refreshInterval` 1000–10000 ms) are asserted by `test/extension-contract.test.js`.

## Testing approach

Tests never touch `/sys`, spawn real processes, or load the real `vscode` module. They inject fakes — a `vscode` double via a `Module._load` intercept, plus fake `os`/`fs`/`execFile` — and reach internals through `module.exports._test` (`extension.js`) or parser helpers exported from `system-sensors.js`. Webview behavior is tested by running the inline script against a fake DOM in `test/view-harness.js`: `loadView()` returns `{ post({ metrics }), byId(id) }`; `metricsFixture()` builds a metrics object. Any new DOM id in the view needs render code and a test through that harness.
