import assert from "node:assert/strict";
import {
  completedTurnCount,
  contentText,
  conversationMessages,
  findLatestCompletedTurn,
  frameTranscript,
  formatRecapLine,
  hasOpenTurn,
  isSnapshotCurrent,
  loadRecapState,
  normalizeRecapState,
  STATE_ENTRY_TYPE,
  type SessionEntryLike,
} from "../core.ts";

const message = (id: string, role: string, content: unknown, stopReason?: string): SessionEntryLike => ({
  type: "message",
  id,
  timestamp: new Date(1_700_000_000_000 + Number(id.slice(1)) * 1000).toISOString(),
  message: { role, content, stopReason, timestamp: 1_700_000_000_000 + Number(id.slice(1)) * 1000 },
});

let checks = 0;
function check(name: string, fn: () => void) {
  fn();
  checks += 1;
  console.log(`PASS ${name}`);
}

check("content extraction keeps text and tool names", () => {
  assert.equal(contentText([
    { type: "text", text: "goal" },
    { type: "thinking", thinking: "hidden" },
    { type: "toolCall", name: "read", arguments: {} },
    { type: "toolResult", content: [{ type: "text", text: "ok" }] },
  ]), "goal [tool: read] ok");
});

const entries = [
  message("u1", "user", "Build a recap plugin"),
  message("a2", "assistant", [{ type: "toolCall", name: "write", arguments: {} }], "toolUse"),
  message("a3", "assistant", [{ type: "text", text: "first complete" }], "stop"),
  message("u4", "user", "Add persistence"),
  message("a5", "assistant", [{ type: "text", text: "second complete" }], "length"),
];

check("completed turns count only terminal assistant responses", () => {
  assert.equal(completedTurnCount(entries), 2);
  assert.equal(findLatestCompletedTurn(entries)?.entryId, "a5");
  assert.equal(hasOpenTurn(entries), false);
});

check("open user turn suppresses current recap", () => {
  const open = [...entries, message("u6", "user", "Continue")];
  assert.equal(hasOpenTurn(open), true);
  assert.equal(findLatestCompletedTurn(open)?.entryId, "a5");
});

check("Pi 0.84.4 compaction summaries and kept suffix stay ordered", () => {
  const compaction: SessionEntryLike = {
    type: "compaction",
    id: "c1",
    timestamp: new Date(1_700_000_010_000).toISOString(),
    summary: "Earlier work implemented the first milestone.",
    firstKeptEntryId: "u4",
    tokensBefore: 12_345,
  };
  const fullBranch: SessionEntryLike[] = [...entries, compaction];
  const contextEntries: SessionEntryLike[] = [compaction, message("u4", "user", "Add persistence"), message("a5", "assistant", "second complete", "length")];
  const compactedMessages = conversationMessages(contextEntries);
  assert.equal(compactedMessages.length, 3);
  assert.match(String(compactedMessages[0]?.content), /Earlier work/);
  assert.equal(findLatestCompletedTurn(fullBranch)?.entryId, "a5");
  assert.equal(completedTurnCount(fullBranch), 2);
  assert.equal(conversationMessages([
    { type: "compaction", id: "c2", summary: "Second summary", firstKeptEntryId: "u7", tokensBefore: 50_000 },
    { type: "branch_summary", id: "b1", summary: "Abandoned branch context" },
    message("u7", "user", "Keep going"),
  ]).length, 3);
});

check("transcript keeps opening goal and obeys UTF-8 byte bound", () => {
  const transcript = frameTranscript([
    { role: "user", content: "总体目标：修复持久化并发布" },
    { role: "assistant", content: [{ type: "text", text: "已完成第一阶段" }] },
    { role: "user", content: "下一步继续验证" },
  ], 1, 160);
  assert.ok(Buffer.byteLength(transcript, "utf8") <= 160);
  const parsed = JSON.parse(transcript) as { goal: string; recent: Array<{ text: string }> };
  assert.equal(parsed.goal, "总体目标：修复持久化并发布");
  assert.equal(parsed.recent.length, 1);
});

check("tiny transcript budgets stay valid and bounded", () => {
  const emptyJson = frameTranscript([{ role: "user", content: "很长的目标" }], 10, 23);
  assert.deepEqual(JSON.parse(emptyJson), { goal: "", recent: [] });
  assert.equal(frameTranscript([{ role: "user", content: "很长的目标" }], 10, 1), "");
});

const state = normalizeRecapState({
  snapshot: {
    version: 1,
    anchorEntryId: "a5",
    text: "已完成持久化，下一步运行回归。",
    generatedAt: 1_700_000_000_000,
    source: "manual",
    dismissed: false,
  },
});

check("custom entry state validates and restores from latest branch entry", () => {
  assert.ok(state);
  const withState = [...entries, { type: "custom", id: "s1", customType: STATE_ENTRY_TYPE, data: { snapshot: state } }];
  assert.deepEqual(loadRecapState(withState), state);
  assert.equal(isSnapshotCurrent(state, withState), true);
  assert.equal(isSnapshotCurrent(state, [...entries, { type: "compaction", id: "c-state", summary: "Compacted", firstKeptEntryId: "u4", tokensBefore: 1 }]), true);
});

check("state is branch-bound and dismissed state is hidden", () => {
  assert.equal(isSnapshotCurrent(state, [...entries, message("u6", "user", "new work")]), false);
  assert.equal(isSnapshotCurrent({ ...state!, dismissed: true }, [...entries]), false);
  assert.equal(normalizeRecapState({ ...state, text: "" }), undefined);
});

check("recap line is one compact display line", () => {
  assert.equal(formatRecapLine("已完成\n下一步验证"), "↩ recap: 已完成 下一步验证");
});

console.log(`PASS all ${checks} core checks`);
