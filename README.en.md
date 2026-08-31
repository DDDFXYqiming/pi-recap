[简体中文](README.md) | English

# pi-recap

> **Session recap for the Pi TUI**: concise, resumable Claude Code-style recaps for the Pi Coding Agent.

## What it does

- Generates a short recap of the current goal, progress, and one next action with `/recap`.
- Uses terminal focus reporting in the regular TUI to detect when the user leaves and returns.
- Automatically generates after three minutes from the last completed turn when at least three turns exist and the terminal is unfocused.
- Stores the recap as a Pi custom session entry, outside the next LLM context.
- Restores state by the active branch after resume, tree navigation, fork, and compaction.
- Uses a bounded auxiliary model request with bounded input, output, and timeout.

## Install

```text
pi install git:github.com/DDDFXYqiming/pi-recap
```

For local development:

```powershell
git clone https://github.com/DDDFXYqiming/pi-recap D:\AI_Projects\pi-recap
pi -e D:\AI_Projects\pi-recap\index.ts
```

## Usage

```text
/recap
/recap status
/recap dismiss
/recap on
/recap off
```

A ready recap appears above the editor:

```text
↩ recap: Persistence is verified; the next action is the release regression.
```

New input hides the current card without creating another agent turn.

## Automatic mode and terminal modes

Automatic recaps run only in the interactive TUI. The regular TUI supports terminal `ESC[I` / `ESC[O` focus-in/out reports. Fullscreen TUI keeps manual `/recap` because Pi's fullscreen renderer consumes focus sequences before extensions see them. RPC and print modes do not trigger automatic away recaps.

## Configuration

Configuration is read from `~/.pi/agent/pi-recap.json`:

```json
{
  "enabled": true,
  "idleMs": 180000,
  "minTurns": 3,
  "recentMessages": 30,
  "maxChars": 400,
  "maxInputChars": 24000,
  "maxOutputTokens": 512,
  "timeoutMs": 30000,
  "provider": "",
  "model": "",
  "reasoningEffort": ""
}
```

The current Pi model is used by default. Set `provider` and `model` together to use a fixed route. An empty `reasoningEffort` follows the current thinking level and maps it to the model's supported capability.

## Verified tests

Offline tests:

```powershell
npm test
```

The manual CLI E2E uses a temporary session directory, Pi RPC, Alibaba Cloud Code Plan `aliyun-tokenplan/qwen3.8-flash`, and `--thinking high`:

```powershell
npm run test:e2e:manual
```

Override the model or thinking level with `PI_E2E_MODEL` and `PI_E2E_THINKING`. Automatic focus behavior is covered by offline state-machine and presence-adapter tests; real window switching is best checked in an interactive local TUI.

## License

MIT License. Copyright (c) 2026 DDDFXYqiming.
