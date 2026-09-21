import assert from "node:assert/strict";
import {
  completedTurnCount,
  contentText,
  conversationMessages,
  findLatestCompletedTurn,
  frameTranscript,
  formatRecapLine,
  formatStatusLine,
  completeSentences,
  framedTranscriptHasContent,
  historyCheckpoint,
  languageSamples,
  stripThink,
  trimToSentence,
  withRecapPrefix,
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
  // A checkpoint is trusted context, not something the human typed: it must never show
  // up among the messages, because that is where the language samples get picked from.
  const compactedMessages = conversationMessages(contextEntries);
  assert.equal(compactedMessages.length, 2);
  assert.ok(!compactedMessages.some((entry) => String(entry.content).includes("Earlier work")));
  assert.equal(historyCheckpoint(contextEntries), "Earlier work implemented the first milestone.");
  assert.equal(findLatestCompletedTurn(fullBranch)?.entryId, "a5");
  assert.equal(completedTurnCount(fullBranch), 2);
  assert.equal(conversationMessages([
    { type: "compaction", id: "c2", summary: "Second summary", firstKeptEntryId: "u7", tokensBefore: 50_000 },
    { type: "branch_summary", id: "b1", summary: "Abandoned branch context" },
    message("u7", "user", "Keep going"),
  ]).length, 1);
  // The newest checkpoint wins, and an empty one stays empty.
  assert.equal(historyCheckpoint([
    { type: "compaction", id: "c3", summary: "Older checkpoint", firstKeptEntryId: "u1", tokensBefore: 1 },
    { type: "branch_summary", id: "b2", summary: "Newer checkpoint" },
  ]), "Newer checkpoint");
  assert.equal(historyCheckpoint([message("u8", "user", "nothing compacted yet")]), "");
  const framed = frameTranscript([{ role: "user", content: "继续" }], "旧进展", 5, 4000);
  assert.equal((JSON.parse(framed) as { historySummary: string }).historySummary, "旧进展");
  assert.equal(framedTranscriptHasContent(framed), true);
  assert.equal(framedTranscriptHasContent(JSON.stringify({ historySummary: "", goal: "", recent: [] })), false);
  assert.equal(framedTranscriptHasContent("not json"), false);
});

check("language samples take the newest human messages, oldest first", () => {
  const samples = languageSamples([
    { role: "user", content: "第一条" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "   " },
    { role: "user", content: "第二条" },
    { role: "user", content: "第三条" },
    { role: "user", content: "第四条" },
    { role: "toolResult", content: "tool noise" },
  ]);
  assert.deepEqual(samples, ["第二条", "第三条", "第四条"]);
  assert.deepEqual(languageSamples([{ role: "assistant", content: "only model output" }]), []);
});

check("reasoning written into the answer channel is stripped", () => {
  const open = "<" + "think";
  const close = "<" + "/think" + ">";
  assert.equal(stripThink(`${open}>推导过程${close} 结论是已修复。`), " 结论是已修复。");
  // An answer cut off before closing the tag has nothing visible left.
  assert.equal(stripThink(`${open}>还没想完`), "");
  assert.equal(stripThink("正常回答"), "正常回答");
});

check("transcript anchors on the newest request and obeys UTF-8 byte bound", () => {
  const transcript = frameTranscript([
    { role: "user", content: "总体目标：修复持久化并发布" },
    { role: "assistant", content: [{ type: "text", text: "已完成第一阶段" }] },
    { role: "user", content: "下一步继续验证" },
  ], "", 1, 160);
  assert.ok(Buffer.byteLength(transcript, "utf8") <= 160);
  const parsed = JSON.parse(transcript) as { goal: string; recent: Array<{ text: string }> };
  // The newest request is already inside the window, so it must not be duplicated as goal.
  assert.equal(parsed.goal, "");
  assert.equal(parsed.recent.length, 1);
  assert.equal(parsed.recent[0]?.text, "下一步继续验证");
});

check("a drifting session never resurfaces the opening request as the goal", () => {
  const transcript = frameTranscript([
    { role: "user", content: "把 OpenRouter 模型改成 glm5.3flash" },
    { role: "assistant", content: [{ type: "text", text: "已改完并验证" }] },
    { role: "user", content: "回退 dsh 并修复失效插件" },
    { role: "assistant", content: [{ type: "text", text: "已推送三个仓库" }] },
    { role: "assistant", content: [{ type: "text", text: "在补回归测试" }] },
  ], "", 2, 4000);
  const parsed = JSON.parse(transcript) as { goal: string; recent: Array<{ text: string }> };
  assert.ok(!parsed.goal.includes("glm5.3flash"), "stale opening must never become the goal");
  assert.ok(parsed.goal.includes("回退"), "goal must carry the current request");
  assert.ok(!parsed.recent.some((entry) => entry.text.includes("glm5.3flash")));
});

check("tool result bodies stay out of the recap window", () => {
  const transcript = frameTranscript([
    { role: "user", content: "查一下版本" },
    { role: "assistant", content: [{ type: "toolCall", name: "bash", id: "c1" }] },
    { role: "toolResult", content: "x".repeat(5000) },
    { role: "assistant", content: [{ type: "text", text: "0.1.1-rc.2" }] },
  ], "", 3, 4000);
  const parsed = JSON.parse(transcript) as { recent: Array<{ role: string; text: string }> };
  assert.ok(!transcript.includes("xxxx"), "raw tool output must not be framed");
  assert.deepEqual(parsed.recent.map((entry) => entry.role), ["user", "assistant", "assistant"]);
});

check("tiny transcript budgets stay valid and bounded", () => {
  // The smallest frame the model can be sent is the empty one; below that the helper
  // returns "" and generateRecap refuses instead of shipping invalid JSON.
  const emptyFrame = JSON.stringify({ historySummary: "", goal: "", recent: [] });
  const emptyJson = frameTranscript([{ role: "user", content: "很长的目标" }], "", 10, emptyFrame.length);
  assert.equal(emptyJson, emptyFrame);
  assert.equal(frameTranscript([{ role: "user", content: "很长的目标" }], "", 10, emptyFrame.length - 1), "");
  assert.equal(framedTranscriptHasContent(emptyJson), false);
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

check("an over-budget answer keeps only finished sentences", () => {
  const long = "排查 dsh web 静默闪退，看门狗已挂上并抓到退出码。地址是 127.0.0.1:3080，会话数据完好。下一步确认进程是否还活着，然后再看日志尾部。";
  const cut = trimToSentence(long.slice(0, 40));
  assert.ok(cut.length <= 40);
  assert.ok(/[。！？；]$/.test(cut), cut);
  assert.doesNotMatch(cut, /…|truncated/);
  // A decimal point is not a sentence end, so "127.0.0.1" never splits the answer.
  assert.equal(trimToSentence("版本 1.2.3 已发布"), "版本 1.2.3 已发布");
  assert.equal(trimToSentence("The watchdog caught exit code 1. Then the host"), "The watchdog caught exit code 1.");
  // A finished answer is never shortened just because it holds several sentences.
  assert.equal(trimToSentence("The watchdog caught exit code 1. Then the host restarted."), "The watchdog caught exit code 1. Then the host restarted.");
  assert.equal(completeSentences("没有标点的半句话"), undefined);
  assert.equal(completeSentences("已修复。还有半"), "已修复。");
});

check("status line carries the last automatic failure once", () => {
  assert.equal(formatStatusLine(true, "focused"), "recap on · focused");
  assert.equal(formatStatusLine(false, "manual-only"), "recap off · manual-only");
  assert.equal(
    formatStatusLine(true, "away", "could not persist recap: boom"),
    "recap on · away · failed: could not persist recap: boom",
  );
  assert.equal(withRecapPrefix("pi-recap: already prefixed"), "pi-recap: already prefixed");
  assert.equal(withRecapPrefix("bare message"), "pi-recap: bare message");
});

console.log(`PASS all ${checks} core checks`);
