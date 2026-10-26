# Command-completions TUI evidence

Isolated Oh My Pi 18.12.6 and Pi 1.4.0 pane dumps from the feat-branch acceptance pass (2026-10-26). Throwaway HOME, temporary project, `--no-session`, no personal login, no paid model requests.

These files are the durable PR attachments. Full raw tmux captures also remain under `/tmp/tibo-rush-tui-evidence/captures/` until the PR is opened; do not treat `/tmp` as the long-term record.

Each excerpt is trimmed to the input line and the completion list or notify that the row is about.

| File | Host | What it shows |
| --- | --- | --- |
| `omp-space-opens-five.txt` | OMP 18.12.6 | Continuous typing through `/tibo-rush ` opens the five-row argument list |
| `omp-tab-accept-opens-list.txt` | OMP 18.12.6 | Tab-accept of `/tibo-rus` opens the argument list immediately |
| `omp-enter-inserts-regular.txt` | OMP 18.12.6 | Enter on an empty-prefix list inserts `regular` and does not submit |
| `omp-enter-inserts-fast.txt` | OMP 18.12.6 | Enter on a `f` prefix list inserts `fast` |
| `omp-off-restores-sol.txt` | OMP 18.12.6 | After applied `fast` (Astra), `off` restores Sol |
| `pi-space-opens-five.txt` | Pi 1.4.0 | Continuous typing through `/tibo-rush ` opens the five-row argument list |
| `pi-tab-accept-no-list.txt` | Pi 1.4.0 | Tab-accept of `/tibo-rus` leaves `/tibo-rush` without the argument list |
| `pi-tab-then-f.txt` | Pi 1.4.0 | After that Tab-accept, typing `f` shows `fast` |
| `pi-enter-inserts-regular.txt` | Pi 1.4.0 | Enter on an empty-prefix list inserts `regular` and does not submit |

OMP 18.12.5, paste, and history restore were not recorded. Pi isolated `fast` failed to apply for missing openai-codex credentials; do not read the Pi dumps as “applied then restored.”

## Updated picker demonstrations (2026-10-27)

The README GIFs now show both hosts applying `fast` and restoring with `off`. Pi uses an offline test provider, so this does not validate real provider authentication or server-side priority. See [recording provenance and results](picker-demo-2026-10-27.md). The 2026-10-26 notes above describe the original acceptance captures, not these newer demonstrations.
