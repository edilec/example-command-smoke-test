# Example Command Smoke Test

An offline, read-only reporter for **exported results of a fixed set of synthetic example commands**. It compares captured exit codes, stdout/stderr, elapsed time, and explicit timeout outcomes with expected policies. It does not launch commands, write fixtures, read Markdown, or touch a live system. A trusted external process must produce a complete local capture; the reporter cannot prove the capture was genuine. Node.js 22+; zero dependencies.

## Run

```sh
node bin/example-command-smoke-test.mjs --root examples --suite passing.json --capture passing-capture.json
node bin/example-command-smoke-test.mjs --root examples --suite failing.json --capture failing-capture.json
node bin/example-command-smoke-test.mjs --root examples --suite timeout.json --capture timeout-capture.json
npm run check
```

These exit 0, 1 (unknown command refused), and 1 (captured timeout). `--human` adds a short stderr summary. `--out report.json` also writes the JSON stdout report within the evidence root. Invalid options or refused output destinations exit 2 with empty stdout; ordinary incomplete evidence emits JSON and exits 2.

## Evidence contract

`--suite` and `--capture` are strict UTF-8 JSON files relative to `--root`. Real paths must stay within the root. The suite format is:

```json
{"schemaVersion":"1","cases":[{"command":"print-ok","timeoutMs":1000,"expected":{"exitCode":0,"stdout":"fixture-ok\n"}}]}
```

Each case can also have an opaque `id`; expected `stderr` defaults to empty. Commands are IDs, not shell strings. The fixed allowlist is `print-ok`, `print-max`, `print-overflow`, `wait-250`, `exit-seven`, and `print-env`. These names identify synthetic fixture scenarios only; this tool implements none of their behavior. Unknown IDs are refused before any comparison and cannot be added through input.

The capture format is:

```json
{"schemaVersion":"1","complete":true,"results":[{"command":"print-ok","termination":"exit","exitCode":0,"stdout":"fixture-ok\n","stderr":"","elapsedMs":10}]}
```

Results match suite cases by ordinal and command ID. `termination` is one of `exit`, `timeout`, `signal`, or `unknown`. Only `exit` carries exit code/stdout/stderr. A captured `timeout` or an exited result whose elapsed time exceeds the configured timeout is an evaluated failure with bounded numeric evidence; a signal or unknown termination is incomplete, **not** a timeout. `complete:false`, missing results, identity mismatch, and invalid shapes never pass. Arbitrary Markdown code fences beside the exports are ignored.

## Rules and exits

| Exit | Rules | Meaning |
| --- | --- | --- |
| 0 | none | All allowlisted captured exits exactly match expectations. |
| 1 | `command-not-allowed` | Unknown command ID refused before comparison. |
| 1 | `command-timeout` | Capture explicitly reports a timeout. |
| 1 | `exit-mismatch`, `stdout-mismatch`, `stderr-mismatch` | Captured exit differs from expectation. |
| 2 | `capture-invalid`, `capture-incomplete`, `execution-unavailable` | Missing, partial, inconsistent or non-exit observation. |
| 2 | `input-unreadable`, `input-invalid`, `case-invalid`, `timeout-invalid` | Unusable evidence or policy. |
| 2 | `byte-limit`, `depth-limit`, `record-limit`, `expectation-limit`, `output-limit`, `time-limit` | A declared bound was exceeded. |

Reports use fixed messages and source-ordinal pointers such as `@suite:/cases/0`; no raw command ID, output, expected value, case ID, or filesystem path is emitted. Findings sort by JavaScript code-unit order. Incomplete takes precedence over fail.

## Bounds and non-goals

Each exported JSON file is limited to 1,048,576 bytes; at most 12 cases/results; JSON depth at most 4 (root 0); stdout/stderr at most 4,096 bytes per stream; configured timeout 1–1,000 ms; captured elapsed time 0–10,000 ms; evaluation time at most 10,000 ms. Exact N is accepted, N+1 refused. `--out` rejects symlink destinations, symlinked parent escapes, hard links or path aliases to either input (including named missing inputs); existing normal in-root report files may be atomically replaced.

This is not a command runner, sandbox, shell validator, documentation crawler, or proof that real-world examples work. It does not execute README blocks, package scripts, child processes, or network requests. Only exported local synthetic evidence is evaluated.

MIT licensed; see [LICENSE](./LICENSE).
