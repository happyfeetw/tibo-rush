# Picker demonstrations — 2026-10-27

The README animations were recorded from real Oh My Pi 18.12.6 and Pi 1.4.0 TUIs on macOS, using the `main` source based on `a5dbdcf` plus the extension-only packaging and status-hint changes. Both hosts used isolated HOME/config/state directories, a temporary project, and `--no-session`. No personal authentication or session data was used.

## Recorded flow

1. Start on GPT-6.1 Sol with high thinking.
2. Type `/tibo-rush ` continuously to show all five argument candidates and their descriptions.
3. Type `f` to filter to `fast`.
4. Enter accepts `fast`; a second Enter invokes the command.
5. Wait for the real adapter to report `applied`, with GPT-6 Astra and medium thinking.
6. Type `/tibo-rush o`, accept `off`, and invoke it. Wait for `applied` and restoration to Sol/high.

| Host | Fast result | OFF result | Model request attempts |
| --- | --- | --- | --- |
| OMP 18.12.6 | applied; openai-codex/gpt-6-astra | applied; openai-codex/gpt-6.1-sol | 0 |
| Pi 1.4.0 | applied; openai-codex/gpt-6-astra | applied; openai-codex/gpt-6.1-sol | 0 |

OMP used synthetic credentials and request guards. Pi used an offline test provider with a local model catalog and synthetic credentials; its network transport and model request path were blocked. The captures demonstrate actual host selection, application, and restoration. They do not verify real provider authentication, server-side priority, performance, or billing.

The original 2026-10-26 Pi acceptance capture failed to apply fast because credentials were absent. It remains a historical picker check, not a successful apply/restore demonstration. The new offline-provider recording is separate and successfully applies and restores host settings.

## Media

- `assets/tibo-rush-omp-switch.gif`
- `assets/tibo-rush-pi-switch.gif`
- Release video names: `tibo-rush-omp-picker.mp4`, `tibo-rush-pi-picker.mp4`.

The asciicast-v2 output was rendered with agg using Maple Mono NF CN and converted with ffmpeg to MP4 and optimized GIF. The recordings retain the actual terminal chronology: no replacement notifications, fabricated `applied` state, or reordered input/result frames. MP4s are release attachments rather than large Git objects.

Host differences remain unchanged: OMP chains command-name Tab acceptance into argument suggestions; Pi does not. These demonstrations deliberately use continuous typing. Paste/history behavior and OMP 18.12.5 are not newly claimed.
