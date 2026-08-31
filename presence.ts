export const FOCUS_ENABLE = "\x1b[?1004h";
export const FOCUS_DISABLE = "\x1b[?1004l";
export const FOCUS_IN = "\x1b[I";
export const FOCUS_OUT = "\x1b[O";

export interface PresenceTui {
  readonly mode: string;
  readonly terminal: { write(data: string): void };
  addInputListener(listener: (data: string) => { consume?: boolean } | undefined): () => void;
}

export interface PresenceInstallation {
  readonly available: boolean;
  readonly focused: boolean;
  dispose(): void;
}

export function installFocusTracking(
  tui: PresenceTui,
  onFocusChange: (focused: boolean) => void,
): PresenceInstallation {
  if (tui.mode !== "regular") {
    return { available: false, focused: true, dispose() {} };
  }

  let focused = true;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;

  const listener = (data: string) => {
    if (data === FOCUS_OUT) {
      focused = false;
      try {
        onFocusChange(false);
      } catch {
        // Presence callbacks are advisory and must not break terminal input.
      }
      return { consume: true };
    }
    if (data === FOCUS_IN) {
      focused = true;
      try {
        onFocusChange(true);
      } catch {
        // Presence callbacks are advisory and must not break terminal input.
      }
      return { consume: true };
    }
    return undefined;
  };

  try {
    unsubscribe = tui.addInputListener(listener);
    tui.terminal.write(FOCUS_ENABLE);
  } catch {
    unsubscribe?.();
    return { available: false, focused: true, dispose() {} };
  }

  return {
    available: true,
    get focused() {
      return focused;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      try {
        tui.terminal.write(FOCUS_DISABLE);
      } catch {
        // Terminal teardown is best effort.
      }
    },
  };
}
