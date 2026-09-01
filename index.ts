import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig, type RecapConfig } from "./config.ts";
import {
  completedTurnCount,
  findLatestCompletedTurn,
  formatRecapLine,
  formatStatusLine,
  hasOpenTurn,
  hasSnapshotForAnchor,
  isCompletedAssistant,
  isSnapshotCurrent,
  loadRecapState,
  withRecapPrefix,
  STATE_ENTRY_TYPE,
  type RecapSnapshot,
  type SessionEntryLike,
} from "./core.ts";
import { generateRecap } from "./generation.ts";
import { installFocusTracking, type PresenceInstallation, type PresenceTui } from "./presence.ts";

const PRESENCE_WIDGET_KEY = "pi-recap/presence";
const CARD_WIDGET_KEY = "pi-recap/card";
const STATUS_KEY = "pi-recap/status";

interface ActiveCall {
  controller: AbortController;
  generation: number;
  anchorEntryId: string;
}

type RunResult =
  | { ok: true }
  | { ok: false; message: string };

function branch(ctx: ExtensionContext): SessionEntryLike[] {
  return ctx.sessionManager.getBranch() as SessionEntryLike[];
}

function lastAssistant(messages: readonly unknown[]): { stopReason?: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!candidate || typeof candidate !== "object") continue;
    const value = candidate as { role?: unknown; stopReason?: unknown };
    if (value.role === "assistant") {
      return { stopReason: typeof value.stopReason === "string" ? value.stopReason : undefined };
    }
  }
  return undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function piRecap(pi: ExtensionAPI) {
  const config: RecapConfig = loadConfig();
  let currentCtx: ExtensionContext | undefined;
  let snapshot: RecapSnapshot | undefined;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeCall: ActiveCall | undefined;
  let presence: PresenceInstallation | undefined;
  let presenceAvailable = false;
  let focused = true;
  let lastAgentCompleted = false;
  let lastAutomaticError: string | undefined;

  const log = (message: string) => console.error(`[pi-recap] ${message}`);

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  function cancelCall() {
    const call = activeCall;
    activeCall = undefined;
    call?.controller.abort();
  }

  function tryUi(ctx: ExtensionContext | undefined, action: () => void) {
    if (!ctx?.hasUI) return;
    try {
      action();
    } catch {
      // UI is best effort; session and model work must remain independent of it.
    }
  }

  function updateStatus(ctx = currentCtx) {
    tryUi(ctx, () => {
      const mode = ctx?.mode === "tui"
        ? presenceAvailable ? (focused ? "focused" : "away") : "manual-only"
        : "manual-only";
      ctx!.ui.setStatus(STATUS_KEY, formatStatusLine(config.enabled, mode, lastAutomaticError));
    });
  }

  function render(ctx = currentCtx) {
    if (!ctx?.hasUI) return;
    const visible = isSnapshotCurrent(snapshot, branch(ctx));
    tryUi(ctx, () => {
      ctx!.ui.setWidget(
        CARD_WIDGET_KEY,
        visible && snapshot ? [formatRecapLine(snapshot.text)] : undefined,
        { placement: "aboveEditor" },
      );
    });
  }

  function persist(next: RecapSnapshot) {
    try {
      // SessionManager retains custom-entry data by reference in memory.
      pi.appendEntry(STATE_ENTRY_TYPE, { snapshot: structuredClone(next) });
      snapshot = next;
    } catch (error) {
      throw new Error(`could not persist recap: ${errorText(error)}`);
    }
  }

  function installPresence(ctx: ExtensionContext) {
    presence?.dispose();
    presence = undefined;
    presenceAvailable = false;
    focused = true;
    if (ctx.mode !== "tui") {
      tryUi(ctx, () => ctx.ui.setWidget(PRESENCE_WIDGET_KEY, undefined));
      updateStatus(ctx);
      return;
    }
    currentCtx = ctx;
    tryUi(ctx, () => {
      ctx.ui.setWidget(PRESENCE_WIDGET_KEY, (tui: PresenceTui) => {
        const installation = installFocusTracking({
          mode: tui.mode,
          terminal: tui.terminal,
          // Let Pi rebind this listener when it replaces regular/fullscreen TUI renderers.
          addInputListener: (listener) => ctx.ui.onTerminalInput(listener),
        }, (nextFocused) => {
          focused = nextFocused;
          if (nextFocused) {
            clearTimer();
            cancelCall();
            render(currentCtx);
          } else {
            armAutomatic(currentCtx);
          }
          updateStatus(currentCtx);
        });
        presence = installation;
        presenceAvailable = installation.available;
        focused = installation.focused;
        updateStatus(currentCtx);
        return {
          render: () => [],
          invalidate() {},
          dispose() {
            installation.dispose();
            if (presence === installation) {
              presence = undefined;
              presenceAvailable = false;
            }
          },
        };
      });
    });
  }

  function restore(ctx: ExtensionContext) {
    generation += 1;
    clearTimer();
    cancelCall();
    currentCtx = ctx;
    snapshot = loadRecapState(branch(ctx), config.maxChars);
    lastAutomaticError = undefined;
    lastAgentCompleted = false;
    installPresence(ctx);
    render(ctx);
    updateStatus(ctx);
  }

  function armAutomatic(ctx: ExtensionContext | undefined) {
    clearTimer();
    if (!ctx || !config.enabled || !presenceAvailable || focused) return;
    const entries = branch(ctx);
    const anchor = findLatestCompletedTurn(entries);
    if (!anchor || completedTurnCount(entries) < config.minTurns || hasOpenTurn(entries)) return;
    if (hasSnapshotForAnchor(snapshot, anchor.entryId)) return;
    const expectedGeneration = generation;
    const delay = Math.max(0, anchor.timestamp + config.idleMs - Date.now());
    timer = setTimeout(() => {
      timer = undefined;
      if (expectedGeneration !== generation || focused || !presenceAvailable) return;
      const activeCtx = currentCtx;
      if (!activeCtx) return;
      const freshAnchor = findLatestCompletedTurn(branch(activeCtx));
      if (!freshAnchor || freshAnchor.entryId !== anchor.entryId) return;
      void runRecap(activeCtx, "automatic", freshAnchor.entryId);
    }, delay);
  }

  async function runRecap(
    ctx: ExtensionContext,
    source: "automatic" | "manual",
    expectedAnchorId: string,
  ): Promise<RunResult> {
    if (activeCall) return { ok: false, message: "another recap is already generating" };
    const expectedGeneration = generation;
    const controller = new AbortController();
    const call: ActiveCall = { controller, generation: expectedGeneration, anchorEntryId: expectedAnchorId };
    activeCall = call;
    try {
      const text = await generateRecap(ctx, config, controller.signal);
      if (activeCall !== call || expectedGeneration !== generation || controller.signal.aborted) {
        return { ok: false, message: "the session changed while generating" };
      }
      const entries = branch(ctx);
      const anchor = findLatestCompletedTurn(entries);
      if (!anchor || anchor.entryId !== expectedAnchorId || hasOpenTurn(entries)) {
        return { ok: false, message: "the session changed while generating" };
      }
      persist({
        version: 1,
        anchorEntryId: anchor.entryId,
        text,
        generatedAt: Date.now(),
        source,
        dismissed: false,
      });
      lastAutomaticError = undefined;
      render(currentCtx ?? ctx);
      updateStatus(currentCtx ?? ctx);
      return { ok: true };
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, message: "generation was cancelled" };
      const message = errorText(error);
      if (source === "automatic") {
        // The user is away: surface it in the status line instead of interrupting with a notification.
        lastAutomaticError = message;
        log(message);
        updateStatus(ctx);
      }
      return { ok: false, message };
    } finally {
      if (activeCall === call) activeCall = undefined;
    }
  }

  function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") {
    tryUi(ctx, () => ctx.ui.notify(message, type));
  }

  function showStatus(ctx: ExtensionContext) {
    const entries = branch(ctx);
    const anchor = findLatestCompletedTurn(entries);
    const state = snapshot ? `state=${snapshot.dismissed ? "dismissed" : "ready"}` : "state=empty";
    notify(ctx, `pi-recap: ${config.enabled ? "automatic on" : "automatic off"}; ${presenceAvailable ? (focused ? "focused" : "away") : "manual-only"}; turns=${completedTurnCount(entries)}; ${state}${anchor ? `; anchor=${anchor.entryId.slice(0, 12)}` : ""}`);
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_before_switch", (_event, ctx) => {
    generation += 1;
    clearTimer();
    cancelCall();
    render(ctx);
  });
  pi.on("session_before_fork", (_event, ctx) => {
    generation += 1;
    clearTimer();
    cancelCall();
    render(ctx);
  });
  pi.on("session_before_tree", (_event, ctx) => {
    generation += 1;
    clearTimer();
    cancelCall();
    render(ctx);
  });
  pi.on("session_before_compact", (_event, ctx) => {
    clearTimer();
    cancelCall();
    render(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    currentCtx = ctx;
    render(ctx);
    armAutomatic(ctx);
  });
  pi.on("session_compact_failed", (_event, ctx) => {
    currentCtx = ctx;
    render(ctx);
    armAutomatic(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    generation += 1;
    clearTimer();
    cancelCall();
    tryUi(ctx, () => {
      ctx.ui.setWidget(CARD_WIDGET_KEY, undefined);
      ctx.ui.setWidget(PRESENCE_WIDGET_KEY, undefined);
      ctx.ui.setStatus(STATUS_KEY, undefined);
    });
    presence?.dispose();
    presence = undefined;
    presenceAvailable = false;
  });

  pi.on("input", (_event, ctx) => {
    currentCtx = ctx;
    lastAutomaticError = undefined;
    clearTimer();
    cancelCall();
    tryUi(ctx, () => ctx.ui.setWidget(CARD_WIDGET_KEY, undefined));
    updateStatus(ctx);
  });
  pi.on("agent_start", (_event, ctx) => {
    currentCtx = ctx;
    lastAgentCompleted = false;
    clearTimer();
    cancelCall();
  });
  pi.on("agent_end", (event: AgentEndEvent, ctx) => {
    currentCtx = ctx;
    lastAgentCompleted = isCompletedAssistant(lastAssistant(event.messages));
  });
  pi.on("agent_settled", (_event, ctx) => {
    currentCtx = ctx;
    if (lastAgentCompleted) armAutomatic(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    currentCtx = ctx;
    cancelCall();
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    currentCtx = ctx;
    cancelCall();
  });
  pi.on("turn_start", (_event, ctx) => {
    currentCtx = ctx;
    clearTimer();
    cancelCall();
    render(ctx);
  });

  pi.registerCommand("recap", {
    description: "Generate or manage the current session recap",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const input = args.trim().toLowerCase();
      if (input === "on" || input === "off") {
        config.enabled = input === "on";
        clearTimer();
        if (config.enabled && !focused) armAutomatic(ctx);
        try {
          saveConfig(config);
          notify(ctx, `pi-recap automatic mode ${config.enabled ? "enabled" : "disabled"}.`);
        } catch (error) {
          notify(ctx, withRecapPrefix(`could not save configuration: ${errorText(error)}`), "error");
        }
        updateStatus(ctx);
        return;
      }
      if (input === "status") {
        showStatus(ctx);
        return;
      }
      if (input === "dismiss") {
        const entries = branch(ctx);
        if (!snapshot || !isSnapshotCurrent(snapshot, entries)) {
          notify(ctx, "pi-recap: there is no current recap to dismiss.", "warning");
          return;
        }
        try {
          persist({ ...snapshot, dismissed: true, generatedAt: Date.now() });
          render(ctx);
        } catch (error) {
          notify(ctx, withRecapPrefix(errorText(error)), "error");
        }
        return;
      }
      if (!ctx.isIdle()) {
        notify(ctx, "pi-recap: wait for the current turn to finish, then run /recap again.", "warning");
        return;
      }
      const entries = branch(ctx);
      if (hasOpenTurn(entries)) {
        notify(ctx, "pi-recap: wait for the current turn to finish, then run /recap again.", "warning");
        return;
      }
      const anchor = findLatestCompletedTurn(entries);
      if (!anchor) {
        notify(ctx, "pi-recap: no completed conversation turn is available yet.", "warning");
        return;
      }
      clearTimer();
      const result = await runRecap(ctx, "manual", anchor.entryId);
      if (!result.ok) {
        notify(ctx, withRecapPrefix(result.message), "error");
      } else if (ctx.mode !== "tui") {
        notify(ctx, "pi-recap: recap ready.");
      }
    },
  });

  log(`loaded (idleMs=${config.idleMs} minTurns=${config.minTurns} maxChars=${config.maxChars} maxOutputTokens=${config.maxOutputTokens})`);
}
