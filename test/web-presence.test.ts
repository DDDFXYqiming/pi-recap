import assert from "node:assert/strict";
import { mock } from "node:test";
import { createWebPresence, WEB_PRESENCE_LEASE_MS } from "../web-presence.ts";

mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
const seen: boolean[] = [];
const presence = createWebPresence((focused) => seen.push(focused));
const send = (clientId: string, sequence: number, focused: boolean) => presence.receive({ version: 1, clientId, sequence, focused });
presence.receive({ focused: false });
assert.deepEqual(seen, []);
send("a", 1, true);
send("b", 1, true);
send("a", 2, false);
assert.deepEqual(seen, [true]); // another viewer still reading
send("b", 2, false);
assert.deepEqual(seen, [true, false]);
send("b", 1, true);
assert.deepEqual(seen, [true, false]); // stale packet ignored
send("a", 3, true);
mock.timers.tick(WEB_PRESENCE_LEASE_MS + 1);
assert.deepEqual(seen, [true, false, true, false]); // disconnected browser
presence.dispose();
send("a", 4, true);
assert.equal(seen.length, 4);
mock.timers.reset();
console.log("PASS GUI presence validation, multi-viewer aggregation, ordering, lease expiry, disposal");
