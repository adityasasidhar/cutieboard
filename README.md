# cutieboard

<img src="media/cutieboard.png" alt="cutieboard icon" width="64" align="left">

A small btop-style system monitor that lives in the Explorer sidebar,
underneath your files. CPU, memory, GPU, temperature, and power —
sampled locally, every two seconds, with nowhere to phone home to.

<br clear="both">

```
host · up 3h12m · 14:02:11 · ● live
CPU  23.4% [██████░░░░] ▂▅▃▇   16T · load 1.20 0.90 0.70 · 61°C
MEM  58.1% [████████░░] ▃▅▅▆   used 9.3G · free 6.7G · 16.0G total
GPU  75.0% [█████████░] ▅▇▆█   vram 4.0G/8.0G · 68°C · 82.5W
PWR  70.0W — cpu 25W · gpu 30W · system total
```

No editor tab. No dashboard. Just glance left.

---

## What it is

An Explorer view that keeps sampling whether you're looking at it or not.
Collapsed, focused elsewhere, mid-debug-session — the 60-sample sparkline
history is still there when you come back.

What you get per row is deliberately spare: a percentage, a bar, a
sparkline, and one line of context. Anything the OS won't tell you shows
as `--`, never as an error and never as a made-up number.

What it isn't: a task manager, a profiler, or a menu-bar widget. It won't
tell you which process is eating RAM. It tells you the machine is warm.

## Install

Build the VSIX and install it — the packaged file is gitignored, so there
is nothing to download from the repo itself:

```bash
npm run package
```

Then in VS Code: **Extensions → … → Install from VSIX…** and pick the
generated `cutieboard-0.1.0.vsix`. The view appears at the bottom of the
Explorer sidebar.

Or run it from source:

```bash
git clone https://github.com/adityasasidhar/cutieboard.git
# open the folder in VS Code, press F5 → "Run Cutieboard"
```

In the Extension Development Host window, expand **Cutieboard** in the
Explorer.

Requirements: VS Code `^1.85.0`. Nothing else — no npm dependencies,
just Node builtins and the VS Code API.

## Use

| Want | Do |
|---|---|
| Open it | Command Palette → **Cutieboard: Focus Monitor** |
| Sample now | **Refresh** button in the view title (fires even while paused) |
| Pause / resume | **Pause** / **Resume** buttons in the view title |
| Slow it down | Set `cutieboard.refreshInterval` |

```jsonc
// settings.json
{
  "cutieboard.refreshInterval": 2000 // ms, clamped to 1000–10000
}
```

The status dot tells you the state at a glance: `● live`, `● paused`,
`● error` (with the message inline, instead of a blank panel).

## Platform notes

CPU and memory work everywhere through Node's `os` module. Everything
else depends on what your OS is willing to expose — missing sensors
degrade to `--`, by design.

| | Linux | macOS | Windows |
|---|---|---|---|
| CPU / memory | yes | yes | yes |
| CPU temp | hwmon (`coretemp`, `k10temp`, `zenpower`…) | needs `osx-cpu-temp` or privileged `powermetrics` | WMI thermal zone, often unexposed — expect `--°C` |
| Power | RAPL / battery discharge / NVIDIA | battery via `ioreg` + `pmset`; CPU/GPU via privileged `powermetrics` | battery discharge via WMI (laptops; desktops show `--`) |
| GPU | `nvidia-smi` | hidden — no public Apple GPU utilization CLI | `nvidia-smi`, if installed |

Two Apple Silicon specifics: memory is labeled `unified` because one pool
serves CPU and GPU, and the VRAM row hides instead of counting the same
gigabytes twice. On machines without `nvidia-smi` the whole GPU section
hides itself.

Power readings have a pecking order: a platform/battery figure wins as the
system total; otherwise CPU + GPU are summed and labeled `components`;
an `nvidia-smi` power draw always beats a sensor guess for the GPU slice.

## How it's built

Four files, no dependencies:

```
extension.js       activation, orchestration, webview provider, commands
system-sensors.js  collectors — hwmon/RAPL/battery, powermetrics/ioreg/pmset, WMI
monitor-core.js    pure logic — CPU math, NVIDIA parsing, power merge, sampler, history
monitor-view.js    the webview — one HTML file, inline script, strict nonce CSP
```

Sampling is a guarded loop: a timer fires every `refreshInterval`, slow
sensors can't overlap thanks to an in-flight guard, and pausing skips
everything except a forced refresh. History holds 60 samples per metric;
GPU and power tracks reset to empty (not stale) when their sensors vanish.

The view inherits your theme — sidebar colors, editor font, terminal
ANSI accents — so it looks native in light mode, dark mode, and whatever
pink-on-black theme you're running at 2am.

## Hacking

```bash
npm run check    # syntax-check all four modules
npm test         # full suite — node:test, no framework
node --test test/<name>.test.js  # one suite
```

Tests inject fakes (a vscode double, stubbed `os`/`fs`/`execFile`) and
never touch `/sys` or spawn real subprocesses. New DOM ids in the webview
need matching render code plus test coverage — the CSP allows no external
resources, so everything stays in the single nonced inline script.

## License

MIT — see [`LICENSE`](LICENSE).
