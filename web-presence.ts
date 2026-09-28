// Optional host integration. Events are scoped to one Pi session's event bus.
export const WEB_PRESENCE_EVENT = "pi-web:presence";
export const WEB_PRESENCE_LEASE_MS = 90_000;

export function createWebPresence(onChange: (focused: boolean) => void) {
  const clients = new Map<string, { sequence: number; focused: boolean; expires: number }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: boolean | undefined;
  let disposed = false;

  function refresh() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    const live = [...clients.values()].filter((client) => client.focused && client.expires > now);
    const focused = live.length > 0;
    if (focused !== last) {
      last = focused;
      onChange(focused);
    }
    if (live.length) {
      timer = setTimeout(refresh, Math.max(1, Math.min(...live.map((client) => client.expires)) - now));
      timer.unref?.();
    }
  }

  return {
    receive(value: unknown) {
      if (disposed || !value || typeof value !== "object") return;
      const data = value as Record<string, unknown>;
      if (data.version !== 1 || typeof data.clientId !== "string" || !/^[\w-]{1,80}$/.test(data.clientId)
        || !Number.isSafeInteger(data.sequence) || (data.sequence as number) < 0 || typeof data.focused !== "boolean") return;
      const previous = clients.get(data.clientId);
      if (previous && (data.sequence as number) <= previous.sequence) return;
      if (!previous && clients.size >= 128) {
        // Bound memory, preserving all still-live viewers.
        for (const [id, client] of clients) if (client.expires <= Date.now()) clients.delete(id);
        if (clients.size >= 128) return;
      }
      clients.set(data.clientId, {
        sequence: data.sequence as number,
        focused: data.focused,
        expires: Date.now() + WEB_PRESENCE_LEASE_MS,
      });
      refresh();
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      clients.clear();
    },
  };
}
