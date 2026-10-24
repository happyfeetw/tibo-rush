# Tibo Rush

English | [中文](README.zh-CN.md)

**One-switch model and tier sprint modes for Oh My Pi and Pi.**
Run one command in any connected session to switch the main model, thinking level and service tier. `off` restores each session to the state it had before the sprint started.

![Tibo Rush CLI demo](assets/tibo-rush-demo.gif)

```text
/tibo-rush regular
/tibo-rush fast
/tibo-rush extreme
/tibo-rush off
/tibo-rush status
```

### Why

Switching models for a whole coding session by hand means touching several settings in every open session, and remembering what each one was before. Tibo Rush does it from one shared switch and remembers each session's original state, so `off` puts things back as they were.

### Quick start

**Oh My Pi**

```sh
omp plugin marketplace add happyfeetw/tibo-rush
omp plugin install tibo-rush-omp@tibo-rush
```

Restart existing OMP sessions once after installing.

**Pi**

```sh
pi install git:github.com/happyfeetw/tibo-rush@v0.2.0
```

Run `/reload` in existing Pi sessions, or resume them.

### Modes

| Mode | What changes | Restores on `off` |
| --- | --- | --- |
| `regular` | Main model, thinking, role and agent routing from the preset | Yes |
| `fast` | Main model and thinking switched to the preset's faster profile | Yes |
| `extreme` | As `fast`, plus priority service tier where the provider supports it | Yes |
| `off` | Restores every session to its pre-sprint state | — |

### What it does not do

- It does not promise faster responses, more quota, or model availability. Priority tiers are decided by the provider and may be billed differently.
- It does not predict or redeem quota resets, and it does not create subscriptions.
- It does not change your persistent host configuration.
- The example preset uses OpenAI Codex models from the author's catalog. Edit `presets/tibo-rush.json` for the models your account has.
- Pi does not expose OMP's role routing, so Pi only applies the main model, thinking and the supported service tier. The status output says which capabilities were applied.
- It runs inside the host process. It is **not a sandbox**. Read the source before installing.

### Status and safety

`status` only counts sessions with a live heartbeat. A session that failed to switch is reported as an error, never as applied. The state directory (`~/.tibo-rush` by default, or `TIBO_RUSH_HOME`) holds session IDs, working directories and restore data. Do not publish it.

Tibo Rush is a community project and is not affiliated with OpenAI, Tibo, Oh My Pi or Pi.

The detailed reference (per-host installation, configuration, state and recovery behaviour, upgrade notes) is currently written in Chinese: [README.zh-CN.md](README.zh-CN.md).
