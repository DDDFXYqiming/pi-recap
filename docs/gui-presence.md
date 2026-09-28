# GUI presence integration (0.4.0)

Pi 0.87.1 provides `bindExtensions({ uiContext })`, RPC Extension UI, and
`createEventBus()` / `pi.events`. It does not define browser attention events.
The integration uses those public APIs, not a terminal emulator or simulated
`/recap` command. No Pi core patch is required.

## Host contract

The host creates one official `createEventBus()` per agent session and supplies
it to `resourceLoaderOptions.eventBus`. Browser reports are sent on the existing
pi-web selected-session `/api/agent/[id]/lease` endpoint, as optional `presence`
metadata. Older clients may continue to send empty requests.

The host validates and emits `pi-web:presence` on that session-local bus:

```json
{"version":1,"clientId":"unique-reporter-id","sequence":1,"focused":true}
```

This event name is a **host integration convention**, not an official Pi focus
API. Every mounted chat reporter uses a new ID and an increasing safe-integer
sequence. `focused` means that chat is selected, its document is visible, and
its window has focus. Changing chats or unloading reports `false`. Browser
focus/blur, visibilitychange and pageshow/pagehide trigger immediate reports.
The existing 30-second lease heartbeat refreshes attention; no extra heartbeat
or HTTP server is introduced. Reports never start a stopped agent session.

## Plugin behavior

Until the first valid host report, RPC remains `manual-only`. One focused viewer
is sufficient to suppress automatic recap, even if other windows are away.
Out-of-order/duplicate sequences are ignored. Focused reports expire after
90 seconds without refresh; lost clients therefore cannot pin a session focused
forever. Explicit away reports take effect immediately. Client state is bounded
to 128 entries; expired entries can be evicted. State is cleared on shutdown or
session restoration, and reload requires a fresh report.

The existing minTurns/idleMs/anchor/open-turn gates, cancellation and persistence
are reused. Returning focus cancels queued/running work. `PI_RECAP_FOCUS=0`
disables both terminal and browser tracking. Plain RPC/print clients need no
changes and remain manual-only. TUI behavior is unchanged.

## Deployment

Both the updated plugin and the pi-web host integration are needed. Installing
only this plugin does not make an unmodified pi-web report attention. The host
patch is maintained separately from this repository; do not assume published
pi-web releases include it.

## Verification

`npm test` covers existing terminal/manual behavior, malformed reports,
multi-viewer attention, sequence ordering, disconnection expiry, cleanup,
RPC automatic snapshots, cancellation on focus return and same-anchor deduplication.
Pi 0.87.1 is the development/test runtime. This is not a claim to have tested
every release in the peer range or every terminal's cold-start behavior.
