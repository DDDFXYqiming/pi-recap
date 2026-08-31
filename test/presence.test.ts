import assert from "node:assert/strict";
import { FOCUS_DISABLE, FOCUS_ENABLE, FOCUS_IN, FOCUS_OUT, installFocusTracking, type PresenceTui } from "../presence.ts";

let checks = 0;
function check(name: string, fn: () => void) {
  fn();
  checks += 1;
  console.log(`PASS ${name}`);
}

function fakeTui(mode: string) {
  const writes: string[] = [];
  const listeners = new Set<(data: string) => { consume?: boolean } | undefined>();
  const tui: PresenceTui = {
    mode,
    terminal: { write: (data) => writes.push(data) },
    addInputListener: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { tui, writes, listeners };
}

check("regular TUI enables focus reporting and consumes focus events", () => {
  const fake = fakeTui("regular");
  const changes: boolean[] = [];
  const installation = installFocusTracking(fake.tui, (focused) => changes.push(focused));
  assert.equal(installation.available, true);
  assert.deepEqual(fake.writes, [FOCUS_ENABLE]);
  const listener = [...fake.listeners][0]!;
  assert.equal(listener(FOCUS_OUT)?.consume, true);
  assert.equal(installation.focused, false);
  assert.equal(listener(FOCUS_IN)?.consume, true);
  assert.equal(installation.focused, true);
  assert.deepEqual(changes, [false, true]);
  installation.dispose();
  assert.deepEqual(fake.writes, [FOCUS_ENABLE, FOCUS_DISABLE]);
});

check("fullscreen TUI remains manual-only", () => {
  const fake = fakeTui("fullscreen");
  const installation = installFocusTracking(fake.tui, () => { throw new Error("not called"); });
  assert.equal(installation.available, false);
  assert.equal(installation.focused, true);
  assert.deepEqual(fake.writes, []);
  assert.equal(fake.listeners.size, 0);
  installation.dispose();
});

check("terminal setup failure cleans the listener", () => {
  const fake = fakeTui("regular");
  fake.tui.terminal.write = () => { throw new Error("terminal unavailable"); };
  const installation = installFocusTracking(fake.tui, () => {});
  assert.equal(installation.available, false);
  assert.equal(fake.listeners.size, 0);
});

console.log(`PASS all ${checks} presence checks`);
