# Example Command Smoke Test

Run a fixed allowlist of synthetic example commands in disposable local fixtures and compare exit codes and bounded stdout/stderr. The input selects command IDs; it cannot provide a shell command, script, arguments, environment variables, fixture content, or a directory for child execution. Requires Node.js 22 or newer; no package dependencies or network calls.

## Run

```sh
node bin/example-command-smoke-test.mjs --root . --suite examples/passing.json
node bin/example-command-smoke-test.mjs --root . --suite examples/failing.json
node bin/example-command-smoke-test.mjs --root . --suite examples/timeout.json
npm run check
```

The examples exit `0` (match), `1` (unknown command refused before any execution), and `1` (timeout with `timeoutMs=30` evidence). Add `--human` for a short stderr summary. `--out report.json` additionally writes the same JSON report within `--root`; stdout remains JSON. The output parent must already exist. Input and output names are relative to root; input realpaths must remain inside it. Output symlinks, output-parent escapes, and path or hard-link aliases of the suite input are refused with exit `2` and empty stdout. An ordinary existing output file may be replaced atomically. No report file is written without `--out`.

## Suite format and allowlist

```json
{
  "schemaVersion": "1",
  "cases": [
    { "command": "print-ok", "timeoutMs": 1000, "expected": { "exitCode": 0, "stdout": "fixture-ok\n" } }
  ]
}
```

Each case has only `command`, `timeoutMs`, and `expected`, plus an optional opaque `id` that is never reported. `expected` contains `exitCode` (integer 0–255), `stdout` (exact string), and optional `stderr` (defaults to empty). Extra suite, case, and expected fields are invalid. Every case is validated before any command runs. An unknown command causes an evaluated `fail` with `checked: 0` and no child execution. Arbitrary Markdown files and fenced examples are not read; no Markdown code block can become a command.

| Command ID | Synthetic behavior |
| --- | --- |
| `print-ok` | Reads the generated fixture and prints `fixture-ok` plus newline. |
| `print-max` | Prints exactly 4,096 `x` bytes. |
| `print-overflow` | Prints 4,097 `x` bytes to exercise the output bound. |
| `wait-250` | Waits 250 ms, then prints `done` plus newline. |
| `exit-seven` | Exits with code 7 and no output. |
| `print-env` | Prints only whether the ambient `SMOKE_SECRET` variable is absent; the child environment omits it. |

These are fixed source-code snippets, not templates filled from input. Every case gets a newly generated temporary directory with static fixture content; it is removed after the child exits. Child processes use the current Node executable directly, never a shell, with a restricted environment containing only `LANG`, `TZ`, `HOME`, `TMPDIR`, and an empty `PATH`. They do not inherit `NODE_OPTIONS` or arbitrary host variables. This is a narrow synthetic smoke test, **not** an operating-system sandbox for third-party code; no user-supplied code is executed or tested against real systems.

## Rules and exits

| Rule | Severity | Meaning |
| --- | --- | --- |
| `command-not-allowed` | error, fail | An unknown command ID was refused before execution. |
| `command-timeout` | error, fail | A fixed command exceeded its declared timeout. |
| `stdout-mismatch`, `stderr-mismatch`, `exit-mismatch` | error, fail | Observed output or exit code differs from the declared expectation. |
| `input-invalid`, `input-unreadable`, `case-invalid`, `timeout-invalid` | error, incomplete | Required or supported suite evidence is absent. |
| `byte-limit`, `depth-limit`, `record-limit`, `expectation-limit`, `output-limit`, `time-limit` | error, incomplete | A declared safety bound was exceeded. |
| `execution-unavailable` | error, incomplete | A disposable fixture or child could not be evaluated. |

Exit `0` means `pass`, exit `1` an evaluated `fail`, and exit `2` `incomplete` or invalid invocation. Invalid options/configuration and output refusal leave stdout empty with a generic stderr diagnostic. Unreadable, undecodable, or unparseable input yields an `incomplete` JSON report. The JSON envelope follows catalog v1. `@suite` in finding locations is a fixed logical role for the exact suite file named at invocation, not a filesystem path; `/cases/N` uses zero-based ordinals. No raw child output, expected output, case ID, or untrusted command string is copied into findings. Timeout evidence contains only the configured integer limit. Findings sort by `(location.file, location.pointer, ruleId)` in JavaScript code-unit order; identical inputs produce identical stdout.

## Limits and non-goals

At most 1,048,576 suite bytes, 12 cases, JSON depth 4 (root depth 0), 4,096 bytes per expected or actual stdout/stderr stream, timeout 1–1,000 ms per case, and 10,000 ms total evaluation. Every upper bound accepts exactly N and refuses N+1. A timeout is a failed observation; oversized output or invalid evidence is incomplete, never a pass. The tool does not execute README commands, arbitrary shell blocks, package scripts, external providers, or live production workflows. It does not verify that real-world documentation examples work; only the six synthetic allowlisted behaviors are in scope.

MIT licensed; see [LICENSE](./LICENSE).
