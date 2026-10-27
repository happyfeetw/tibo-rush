# OMP 18.13.1 compatibility — 0.3.1

Acceptance on macOS arm64, 2026-10-27. Real OMP 18.13.1 binary, Bun 1.3.14, isolated HOME/config/state/project directories, synthetic credentials, no real user sessions, and no paid model requests.

## Failure and fix

The installed 0.3.0 adapter displayed its argument list on OMP 18.13.1, but session reconciliation reported:

```text
OMP 18.13.1 session SDK compatibility is not verified; session unchanged
```

The cause was the exact 18.12.5/18.12.6 version gate, not a demonstrated SDK incompatibility. Version 0.3.1 adds only 18.13.1 to that gate. It does not allow every 18.13.x version or change the baseline schema, restore order, persistence checks, or transition vetoes.

## SDK contract inspection

Compared the version-pinned upstream trees for [v18.12.6](https://github.com/can1357/oh-my-pi/tree/v18.12.6) and [v18.13.1](https://github.com/can1357/oh-my-pi/tree/v18.13.1), rather than treating an absent patch in GitHub's 300-file compare view as proof of no changes. Of 146 inspected-path tree entries, 38 changed; the entire SDK is not identical.

The public agent registry, lifecycle event definitions, and settings registry have identical blobs between these tags. The consumed configured-thinking selectors, transition flag, `ensureOnDisk()`, and `flush()` contracts remain available. The extension runner/type delta adds a `reason` field to `before_agent_start`; Tibo Rush's main-session guard does not rely on that field. These source checks were followed by real-binary acceptance, not used as a substitute for it.

Relevant source:

- [SDK session construction](https://github.com/can1357/oh-my-pi/blob/v18.13.1/packages/coding-agent/src/sdk.ts)
- [Agent session](https://github.com/can1357/oh-my-pi/blob/v18.13.1/packages/coding-agent/src/session/agent-session.ts)
- [Session manager durability](https://github.com/can1357/oh-my-pi/blob/v18.13.1/packages/coding-agent/src/session/session-manager.ts)
- [Extension runner](https://github.com/can1357/oh-my-pi/blob/v18.13.1/packages/coding-agent/src/extensibility/extensions/runner.ts)

## Executed checks

| Check | Result |
| --- | --- |
| `bun test` | 30 passed, 0 failed |
| `OMP_BIN=/absolute/path/to/omp bun run smoke` | OMP 18.13.1: 22 checks, 0 model calls |
| `PI_CLI_JS=/absolute/path/to/pi-1.4.0-cli.js bun run smoke:pi` | Pi 1.4.0 passed; network forbidden |
| `npm pack --dry-run --json` | 10 allowlisted files; no public executable or internal controller |
| `bun run pack:hosts` | Each 0.3.1 archive contains 8 allowlisted files and only its own adapter |

OMP lifecycle coverage includes two distinct baselines; regular/fast/extreme; exact OFF restoration of model, configured thinking, tiers, routing and override provenance; malformed policy recovery; cold resume; auto/unset selectors; no-session roots; new/branch/fork vetoes and handoffs; append/rewrite/delete failures; crash recovery; user drift protection; and the real native 30-second before-switch timeout with a delayed model setter.

## Installed-archive TUI

The actual OMP archive was unpacked and linked into another isolated installation. A fresh OMP 18.13.1 TUI loaded its adapter through plugin discovery, without explicitly naming the adapter on startup.

- Continuous typing through `/tibo-rush ` showed all five rows with descriptions.
- `f` and `ex` filtered to fast and extreme.
- Enter on the empty-prefix list inserted regular without changing the requested/applied OFF mode.
- Enter on the fast-prefix list inserted fast; a second Enter actually applied it and selected Astra.
- Fully typed off submitted with one Enter and restored Sol.
- Tab acceptance of `/tibo-rus` opened the argument list.
- Bare-command Enter and Esc-dismissal followed by Enter reported status without changing the requested mode.
- Model/network request attempts: 0.

A separate native-loader probe supplied the simulated SDK version 18.13.2 to the real adapter. It reported the version error and created no restore baseline. This tests rejection of an unverified version; it is not a test of a real 18.13.2 binary.

## Limits

OMP busy model streaming was not exercised: its smoke forbids model turns. Pi's busy/payload checks use a local synthetic provider, not a real external transport. Real provider authentication, server-side priority, speed, billing, remote session storage, Windows/Linux, paste, and history-triggered suggestions are not newly verified. OMP 18.12.6 acceptance is historical; this patch's real-host run targets 18.13.1. The existing GIFs and MP4s remain the accurately labeled 0.3.0-era recordings, not new 18.13.1 recordings.
