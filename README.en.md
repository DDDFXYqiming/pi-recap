[简体中文](README.md) | English

# pi-recap

**A session-recap plugin for the Pi Coding Agent TUI.** Switch to another window and it generates a short recap in the background. When you come back, a single line above the editor summarizes the session's overall goal, completed progress, and the one next action.

Current version: **0.2.0**

## Why it exists

People step away from the screen for all sorts of reasons, and the session is still sitting there when they return. The thread of thought is gone, though, and scrolling back through the message history takes a while. Read a short recap first, then decide where to pick up. This plugin brings that behavior to the interactive Pi TUI. A separate auxiliary model request produces the recap, and the finished text never enters the next LLM context.

## Capabilities

- Generates automatically only while the terminal is unfocused; simple focused-window idleness never spends a model call.
- By default, requires at least three completed turns and three minutes since the latest completed turn, and never generates twice for the same turn. These two gates keep a brief distraction from producing a pointless recap.
- `/recap` works on demand at any time; `/recap off` disables automatic recaps only, never the command.
- Writes the recap in the language the user writes in; the English prompt does not force English output.
- Displays the result as a one-line card above the editor, capped at 400 characters. Typing a new message, starting a new turn, switching sessions, or dismissing the banner hides it.
- Scopes dismissal to the session branch and the completed turn the recap belongs to, so switching away and back does not resurrect a dismissed banner.
- Persists the recap as a Pi custom session entry (`pi-recap/state`) instead of appending messages, so it stays out of the LLM context. State is restored per active branch after resume, tree navigation, fork, and compaction.
- Reuses the session's current model by default, with an optional fixed `provider` + `model` route. The auxiliary call sends no thinking level at all, `maxOutputTokens` is only an output ceiling, and `temperature` / `stopSequences` are optional overrides.
- If a new turn starts, a newer turn completes, or the branch changes while a request is running, the stale result is discarded. What you see on return always matches current progress.
- Keeps a status line such as `recap on · focused` or `recap off · manual-only`, so the active mode is visible without asking. An automatic failure appends `· failed: <reason>` to it, and the next success or new input clears it.

## How it works

1. The presence adapter enables terminal focus reporting (`\x1b[?1004h`) and maps `ESC[I` / `ESC[O` to focused / away, consuming those sequences so normal input is unaffected.
2. A timer is armed only when the session is away, the latest completed turn is at least `idleMs` old, `minTurns` is satisfied, no turn is left open, and that turn has no recap yet. The delay is computed as `anchor.timestamp + idleMs - now`, so leaving early and leaving late land on the same moment.
3. The plugin frames bounded input from the current branch (`recentMessages`, `maxInputChars`): tool-result messages are dropped first because raw command output is not intent, then the newest user request anchors the current task. One independent auxiliary request produces a plain-text recap of at most 40 words in one or two sentences covering the current task, completed progress and the next step.
4. Every generation owns an `AbortController` and a runtime generation counter. Regaining focus, a new turn, a session switch, fork, compaction, or a model change cancels the in-flight request, and the anchor is re-checked before anything is committed.
5. The accepted result is persisted through `pi.appendEntry()` as a custom entry (`structuredClone`d first, because SessionManager retains custom-entry data by reference), then the card and status line are rendered.
6. An automatic failure never interrupts you with a notification: it is recorded in the status line as `recap on · away · failed: <reason>` and logged to stderr as `[pi-recap] ...`. New input or the next success clears it. A manual `/recap` error is reported directly as an error notification.

## Install

```text
pi install git:github.com/DDDFXYqiming/pi-recap
```

For local development:

```powershell
git clone https://github.com/DDDFXYqiming/pi-recap D:\AI_Projects\pi-recap
pi -e D:\AI_Projects\pi-recap\index.ts
```

After editing the source, make the running Pi reload it: `/reload`, or restart `pi`. The load line on stderr tells you which build is in memory:

```text
[pi-recap] loaded (idleMs=180000 minTurns=3 maxChars=400 maxOutputTokens=2048)
```

## Usage

```text
/recap            generate the recap for the current session now
/recap status     print gate state: enabled, focus, completed turns, state, anchor
/recap dismiss    dismiss the current recap banner
/recap on         enable automatic recaps (persisted to the config file)
/recap off        disable automatic recaps (persisted to the config file)
```

On success the card appears above the editor:

```text
↩ recap: Persistence verified; next step is the pre-release regression run.
```

`/recap status` looks like:

```text
pi-recap: automatic on; focused; turns=7; state=ready; anchor=3f2a91c04b7d
```

`state` is one of `empty`, `ready`, `dismissed`. Manual commands only run while the session is idle; during streaming you are asked to wait for the turn to finish.

## Mode support

| Runtime mode | Automatic | Manual `/recap` | Notes |
| --- | --- | --- | --- |
| Regular TUI | ✅ | ✅ | Uses terminal focus reporting to detect away and back |
| Fullscreen TUI | ❌ | ✅ | Pi's fullscreen renderer consumes focus sequences before extensions, so it degrades to manual |
| RPC mode | ❌ | ✅ | Provides the non-blocking UI channel the command needs |
| Print mode (`-p`) | ❌ | ✅ | Same channel; there is no terminal focus concept |

Terminals without 1004 focus reporting degrade to manual as well, and the status line reads `manual-only`.

## Configuration

Config file: `~/.pi/agent/pi-recap.json`. It is written the first time you run `/recap on` or `/recap off`; when it is absent these defaults apply, and unknown keys are ignored.

```jsonc
{
  "enabled": true,         // controls automatic recaps only; /recap always works
  "idleMs": 180000,        // minimum time from the latest completed turn (ms)
  "minTurns": 3,           // completed turns required for an automatic recap
  "recentMessages": 80,    // messages sent to the recap request (1-200, user/assistant only)
  "maxChars": 400,         // recap text ceiling (80-400)
  "maxInputChars": 24000,  // recap input budget in bytes (1000-200000)
  "maxOutputTokens": 2048, // output token ceiling for the auxiliary call (16-16384)
  "timeoutMs": 30000,      // per-request timeout
  "provider": "",          // empty: reuse the session's provider
  "model": "",             // empty: reuse the session's model; fill both to pin a route
  "stopSequences": []      // optional stop sequences, up to 8 entries of 200 characters
}
```

`temperature` is an optional key that is not written by default: leave it out and the field is never sent, so the model or server decides; when present it is clamped to 0–2. `stopSequences` travels through `samplingParams.stop`, which OpenAI-compatible adapters forward and other APIs such as Anthropic ignore.

`provider` and `model` must be set together; setting only one is an error. When both are empty the recap follows the model the session actually uses, so it needs no separate route.

The recap is an auxiliary call that sends **no thinking level**: it never inherits the session's thinking level. Inheriting it lets reasoning tokens consume `maxOutputTokens`, so the response carries only a thinking block with no answer text. `maxOutputTokens` is a runaway guard, not a budget — a 40-word recap measures around 50 tokens and normally never reaches it; if it does, the error names the current ceiling.

## State and persistence

Recaps are stored in the session history as custom entries of type `pi-recap/state`:

| Field | Meaning |
| --- | --- |
| `version` | Snapshot schema version, currently `1` |
| `anchorEntryId` | Id of the completed turn this recap belongs to; used for staleness and dismissal scoping |
| `text` | Recap body, collapsed to one line within `maxChars` |
| `generatedAt` | Generation timestamp |
| `source` | `automatic` or `manual` |
| `dismissed` | Whether the banner was dismissed |

Only the latest valid snapshot on a branch is read back, so each branch keeps exactly one current recap. Because it is a custom entry rather than a message, it never enters the next LLM context, and `/recap` does not inject a new agent turn.

## Compatibility

| Item | Version or range |
| --- | --- |
| pi-recap | `0.2.0` (`package.json`) |
| `@earendil-works/pi-coding-agent` | `>=0.84.4 <0.85.0` (peerDependency) |
| Node.js | `>=22.19.0` (matches the Pi runtime range; offline tests run `.ts` directly with node) |
| Terminal | 1004 focus reporting required for automatic mode (Windows Terminal, xterm, iTerm2, kitty, wezterm, …); otherwise manual |

## Development and verification

```powershell
npm test              # typecheck + 5 offline suites
npm run test:e2e:manual
```

The offline suites cover the state machine, the presence adapter, config parsing with atomic save, auxiliary request construction, and the extension lifecycle contract; none of them need a network or a terminal. The manual CLI E2E uses a temporary session directory and Pi RPC, defaulting to `aliyun-tokenplan/qwen3.8-flash` with `--thinking high`, overridable through `PI_E2E_MODEL` and `PI_E2E_THINKING`. Real window switching is best verified in an interactive local TUI.

| File | Responsibility |
| --- | --- |
| `index.ts` | Extension wiring: command, events, card and status line, timers and cancellation |
| `core.ts` | Pure state machine: branch resolution, turn anchors, snapshot validation and restore, text collapsing |
| `generation.ts` | Bounded auxiliary request: transcript framing, model routing, response extraction |
| `presence.ts` | Focus reporting adapter |
| `config.ts` | Config parsing, bound clamping, atomic write |

## Related

- [Pi Coding Agent](https://github.com/earendil-works/pi) (`packages/coding-agent`)
- [dsh-session-recap](https://github.com/DDDFXYqiming/dsh-session-recap): the same behavior for DeepSeek Harness Web
- [Pi extensions documentation](https://github.com/earendil-works/pi) (`packages/coding-agent/docs/extensions.md`)

## License

MIT License. Copyright (c) 2026 DDDFXYqiming.
