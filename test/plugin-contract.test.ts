import assert from "node:assert/strict";
import piRecap from "../index.ts";
import { FOCUS_DISABLE, FOCUS_ENABLE, FOCUS_IN, FOCUS_OUT } from "../presence.ts";
import { STATE_ENTRY_TYPE, type SessionEntryLike } from "../core.ts";

const events = new Map<string, (...args: any[]) => unknown>();
const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
const entries: SessionEntryLike[] = [
  { type: "message", id: "u1", message: { role: "user", content: "Build the recap plugin" } },
  { type: "message", id: "a1", message: { role: "assistant", content: "Core logic is ready", stopReason: "stop" } },
  { type: "message", id: "u2", message: { role: "user", content: "Verify persistence" } },
  { type: "message", id: "a2", message: { role: "assistant", content: "Persistence is next", stopReason: "stop" } },
  { type: "message", id: "u3", message: { role: "user", content: "Run the CLI test" } },
  { type: "message", id: "a3", message: { role: "assistant", content: "The CLI test is next", stopReason: "stop" } },
];
const terminalWrites: string[] = [];
const statusWrites: string[] = [];
const notifications: string[] = [];
const managedListeners = new Set<(data: string) => { consume?: boolean } | undefined>();
let registeredInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
let currentCard: string[] | undefined;
let presenceComponent: { dispose?(): void } | undefined;
let appendCount = 0;
let failAppend = false;

const fakeTui = {
  mode: "regular",
  terminal: { write: (data: string) => terminalWrites.push(data) },
  addInputListener: () => { throw new Error("direct TUI listener should not be used"); },
};

const ui = {
  onTerminalInput(listener: (data: string) => { consume?: boolean } | undefined) {
    registeredInput = listener;
    managedListeners.add(listener);
    return () => {
      managedListeners.delete(listener);
      if (registeredInput === listener) registeredInput = undefined;
    };
  },
  setWidget(key: string, content: unknown) {
    if (key === "pi-recap/presence" && typeof content === "function") {
      presenceComponent = content(fakeTui, {});
      return;
    }
    if (key === "pi-recap/presence" && content === undefined) {
      presenceComponent?.dispose?.();
      presenceComponent = undefined;
      return;
    }
    if (key === "pi-recap/card") currentCard = Array.isArray(content) ? content : undefined;
  },
  setStatus(_key: string, text: string | undefined) {
    if (text) statusWrites.push(text);
  },
  notify(message: string) {
    notifications.push(message);
  },
};

const model = { provider: "fake-provider", id: "fake-model", api: "fake-api", reasoning: false };
const context = {
  mode: "tui",
  hasUI: true,
  cwd: process.cwd(),
  model,
  thinkingLevel: "off",
  isIdle: () => true,
  hasPendingMessages: () => false,
  sessionManager: {
    getBranch: () => entries,
    buildContextEntries: () => entries,
    getSessionId: () => "contract-session",
  },
  modelRegistry: {
    find: () => model,
    hasConfiguredAuth: () => true,
    getProvider: () => ({
      streamSimple: () => ({
        result: async () => ({
          stopReason: "stop",
          content: [{ type: "text", text: "已完成持久化验证，下一步运行 CLI 回归。" }],
        }),
      }),
    }),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-only-key" }),
  },
  ui,
};

const fakePi = {
  on(name: string, handler: (...args: any[]) => unknown) { events.set(name, handler); },
  registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, options); },
  appendEntry(type: string, data: unknown) {
    appendCount += 1;
    if (failAppend) throw new Error("test persistence failure");
    entries.push({ type: "custom", id: `s${appendCount}`, customType: type, data });
  },
};

piRecap(fakePi as never);
assert.equal(events.size, 16);
assert.ok(events.has("session_start"));
assert.ok(events.has("session_tree"));
assert.ok(events.has("session_shutdown"));
assert.ok(commands.has("recap"));

await events.get("session_start")?.({}, context);
assert.deepEqual(terminalWrites, [FOCUS_ENABLE]);
assert.equal(managedListeners.size, 1);
assert.ok(registeredInput);
assert.equal(registeredInput!(FOCUS_OUT)?.consume, true);
assert.match(statusWrites.at(-1) ?? "", /away/);
// Pi can rebind the same managed handler to a replacement renderer.
assert.equal(registeredInput!(FOCUS_IN)?.consume, true);
assert.match(statusWrites.at(-1) ?? "", /focused/);

await commands.get("recap")!.handler("", context);
assert.ok(currentCard?.[0]?.startsWith("↩ recap:"));
assert.equal(entries.at(-1)?.type, "custom");
assert.equal(entries.at(-1)?.customType, STATE_ENTRY_TYPE);
assert.equal(appendCount, 1);

await commands.get("recap")!.handler("dismiss", context);
assert.equal(currentCard, undefined);
assert.equal((entries.at(-1)?.data as { snapshot?: { dismissed?: boolean } })?.snapshot?.dismissed, true);
assert.equal(appendCount, 2);
assert.equal(notifications.length, 0);

failAppend = true;
await commands.get("recap")!.handler("", context);
assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE).length, 2);
assert.match(notifications.at(-1) ?? "", /could not persist recap/);

await events.get("session_shutdown")?.({}, context);
assert.deepEqual(terminalWrites, [FOCUS_ENABLE, FOCUS_DISABLE]);
assert.equal(managedListeners.size, 0);
console.log(`PASS lifecycle contract (${events.size} events, ${commands.size} command, ${entries.filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE).length} persisted states)`);
