# Contributing to Cutieboard

Bug reports, sensor improvements, tests, and UI fixes are welcome. Keep changes
focused: Cutieboard is a small VS Code Explorer monitor built with Node builtins
and the VS Code API, with no project dependencies or build step.

## Get started

Use a current Node.js LTS release, npm, and a VS Code version supported by
`engines.vscode` in `package.json`.

```bash
git clone https://github.com/adityasasidhar/cutieboard.git
cd cutieboard
git switch -c your-change
npm run check
npm test
```

There are no dependencies to install. Open the folder in VS Code, press **F5**,
and choose **Run Cutieboard**. In the Extension Development Host, open Explorer
and expand **Cutieboard**.

## Where to make changes

| File | Responsibility |
| --- | --- |
| `src/extension.js` | Activation, sampling lifecycle, metric orchestration, commands |
| `src/monitor-core.js` | CPU math, NVIDIA parsing, power merging, sampling guard, history |
| `src/system-sensors.js` | Optional OS and GPU collectors, parsing, timeouts, backoff |
| `src/monitor-view.js` | Webview HTML, CSS, and inline JavaScript |
| `test/` | Node test suites and the fake webview DOM harness |

Read `AGENTS.md` for detailed collector constraints and platform-specific gotchas.
Follow the existing CommonJS JavaScript style. Do not add dependencies.

## Behavioral constraints

- Missing, unsupported, or inaccessible sensors must degrade to unavailable
  (`--` in the view), never throw or invent a reading. Validate numeric ranges.
- Automatic collection runs only while the view is visible and not paused.
  Explicit Refresh may collect while paused. Reset the CPU baseline across
  hidden or disposed views so hidden workload is not reported as fresh usage.
- Do not wake a runtime-suspended NVIDIA GPU just to query it. Keep subprocess
  timeouts, backoff, and the in-flight sampling guard intact.
- Keep power sources and labels honest: a battery/platform total is different
  from a CPU/GPU component sum. Do not double-count GPU power.
- Keep the webview self-contained under its nonce-based content security policy;
  do not add external scripts, styles, or resources.
- Changes to commands, view IDs, or settings must update the manifest, runtime,
  and contract tests together.

## Test your change

For a bug fix, add a regression test that fails before the fix. Tests use
`node:test` and `node:assert/strict`; inject OS, filesystem, subprocess, and VS Code
fakes rather than reading real sensors or spawning real tools. Exercise webview
rendering through `test/view-harness.js` when changing UI behavior.

```bash
npm run check                         # Syntax-check all source modules
npm test                              # Run the full suite
node --test test/system-sensors.test.js # Run one suite
git diff --check                       # Check whitespace
```

If you add a source module, add it to the hardcoded `check` script in
`package.json`. There is no configured linter or formatter.

Manually check UI/lifecycle changes in the Extension Development Host: pause,
refresh, resume, hide/reopen the view, and check for stale readings or errors.
For platform-specific changes, state which operating systems you tested and
which were covered only by fixtures.

To test installation from a package:

```bash
npm run package
```

This command fetches the VSCE packaging tool via `npx`. Install the generated
`.vsix` using **Extensions → … → Install from VSIX…**. Do not commit VSIX files,
local editor/session state, credentials, or generated artifacts.

## Submit a pull request

Describe the problem, the approach, and how you verified it. Include screenshots
for visual changes and note any platform-specific limitations. Keep unrelated
refactoring separate and update user-facing documentation when behavior changes.

For bug reports, include reproduction steps, expected and actual behavior,
VS Code and extension versions, OS, and relevant hardware. Remove credentials
and personal data from logs or sensor output before sharing them.

Cutieboard is licensed under MIT; see [`LICENSE`](LICENSE).
