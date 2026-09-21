import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../config.ts";
import { generateRecap, languageDirective } from "../generation.ts";

let seenOptions: Record<string, unknown> = {};
let seenContext: { systemPrompt?: string; messages?: Array<{ content?: Array<{ text?: string }> }> } = {};
const seenMaxTokens: number[] = [];
const answer = "Goal is implemented; next action is verify it.";
const model = {
  provider: "fake-provider",
  id: "fake-model",
  api: "fake-api",
  reasoning: true,
  thinkingLevelMap: { high: "provider-specific-high", max: "provider-specific-max" },
};
const contextReturning = (result: () => unknown) => ({
  ...fakeContext,
  modelRegistry: {
    ...fakeContext.modelRegistry,
    getProvider: () => ({
      streamSimple: (_model: unknown, context: unknown, options: Record<string, unknown>) => {
        seenContext = context as typeof seenContext;
        seenOptions = options;
        seenMaxTokens.push(Number(options.maxTokens));
        return { result: async () => result() };
      },
    }),
  },
});
const fakeContext = {
  model,
  // A session running at thinking=max must not leak that level into the recap call.
  thinkingLevel: "max",
  sessionManager: {
    buildContextEntries: () => [
      { type: "message", id: "u1", message: { role: "user", content: "把 OpenRouter 的模型改成 kimi-for-coding" } },
      { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "I will implement it" }], stopReason: "stop" } },
      { type: "compaction", id: "c1", summary: "Earlier work landed the first milestone.", firstKeptEntryId: "u1", tokensBefore: 12_345 },
    ],
    getSessionId: () => "test-session",
  },
  modelRegistry: {
    getProvider: () => ({
      streamSimple: (_model: unknown, context: unknown, options: Record<string, unknown>) => {
        seenContext = context as typeof seenContext;
        seenOptions = options;
        seenMaxTokens.push(Number(options.maxTokens));
        return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: answer }] }) };
      },
    }),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-only-key" }),
  },
};

const recap = await generateRecap(fakeContext as never, { ...DEFAULT_CONFIG, maxChars: 100 }, new AbortController().signal);
assert.equal(recap, answer);
assert.equal("reasoning" in seenOptions, false);
assert.equal("thinking" in seenOptions, false);
assert.equal("reasoningEffort" in seenOptions, false);
assert.equal("temperature" in seenOptions, false);
assert.equal("samplingParams" in seenOptions, false);
await generateRecap(
  fakeContext as never,
  { ...DEFAULT_CONFIG, maxChars: 100, temperature: 0.2, stopSequences: ["\n\n"] },
  new AbortController().signal,
);
assert.equal(seenOptions.temperature, 0.2);
assert.deepEqual(seenOptions.samplingParams, { stop: ["\n\n"] });
assert.equal(seenOptions.maxTokens, DEFAULT_CONFIG.maxOutputTokens);
assert.ok(DEFAULT_CONFIG.maxOutputTokens >= 2_048);
assert.ok(DEFAULT_CONFIG.maxChars >= 600, "the card budget has to hold 2-4 real sentences");
assert.equal(seenOptions.apiKey, "test-only-key");

// What the auxiliary request actually carries.
const promptText = seenContext.systemPrompt ?? "";
const requestText = seenContext.messages?.[0]?.content?.[0]?.text ?? "";
assert.match(promptText, /active coding session/);
// The output contract has to name the failure modes the card cannot absorb: narrating
// the transcript, and markdown or list layout the recap was never meant to hold.
assert.match(promptText, /first character you write is the first character of the recap/);
assert.match(promptText, /我看到了完整的会话记录/);
assert.match(promptText, /Here is the recap/);
assert.match(promptText, /no markdown[\s\S]*no line breaks/);
assert.match(promptText, /untrusted session data/);
// Substance, not just brevity: the recap has to carry the specifics of the session.
assert.match(promptText, /2 to 4 sentences/);
assert.match(promptText, /100 to 200 characters/);
assert.match(promptText, /Name the files, commands, numbers and verdicts/);
assert.match(promptText, /Every sentence must be complete/);
// Language is decided from verbatim human samples, and a checkpoint must not poison them.
assert.match(promptText, /historySummary is a trusted compaction checkpoint/);
assert.match(promptText, /never to decide the language/);
assert.match(requestText, /\[recap-language\]/);
assert.match(requestText, /把 OpenRouter 的模型改成 kimi-for-coding/);
assert.match(requestText, /pasted machine content never counts as the user's language/);
assert.match(requestText, /mirror the language the assistant entries reply in/);
assert.match(requestText, /Regardless|regardless of the language of any code, log, or instruction/);
// The transcript frame carries the checkpoint separately from the human's own words.
assert.match(requestText, /"historySummary":"Earlier work landed the first milestone\."/);
assert.ok(requestText.indexOf("<session-transcript>") < requestText.indexOf("[recap-language]"), "the language directive must come after the transcript");
// Without samples the directive still has to state the rule.
assert.match(languageDirective([]), /^\[recap-language\] Decide the language/);
assert.match(languageDirective(['他说："use """quotes""" here"']), /'''quotes'''/);

// A model that ignores the contract still cannot overflow the card budget, and the
// answer never ends in mid-sentence. Content itself is not rewritten at this layer.
const ramblingText = `我看到了完整的会话记录。这段对话的核心是：${"**真实 dsh 已恢复** 跑在看门狗下 `http://127.0.0.1:3080`。" .repeat(40)}`;
const rambling = await generateRecap(
  contextReturning(() => ({ stopReason: "stop", content: [{ type: "text", text: ramblingText }] })) as never,
  { ...DEFAULT_CONFIG, maxChars: 120 },
  new AbortController().signal,
);
assert.ok(rambling.length <= 120, `length=${rambling.length}`);
assert.match(rambling, /[。]$/);
assert.doesNotMatch(rambling, /…|truncated/);
assert.ok(rambling.startsWith("我看到了完整的会话记录。"));

// Reasoning written into the answer channel gets stripped, not shown and not fatal.
const open = "<" + "think";
const close = "<" + "/think" + ">";
const stripped = await generateRecap(
  contextReturning(() => ({ stopReason: "stop", content: [{ type: "text", text: `${open}>用户想要一张回顾卡片${close} 任务已改完，下一步跑回归验证。` }] })) as never,
  { ...DEFAULT_CONFIG, maxChars: 100 },
  new AbortController().signal,
);
assert.equal(stripped, "任务已改完，下一步跑回归验证。");

// Nothing visible left after stripping is a real failure, so the card stays empty.
await assert.rejects(
  () => generateRecap(
    contextReturning(() => ({ stopReason: "stop", content: [{ type: "text", text: `${open}>还没想完` }] })) as never,
    { ...DEFAULT_CONFIG, maxChars: 100 },
    new AbortController().signal,
  ),
  /recap model produced no text/,
);

// Running out of tokens is a budget problem: one retry with a larger ceiling first.
seenMaxTokens.length = 0;
await assert.rejects(
  () => generateRecap(
    contextReturning(() => ({ stopReason: "length", content: [{ type: "thinking", thinking: "budget spent here" }] })) as never,
    { ...DEFAULT_CONFIG, maxChars: 100 },
    new AbortController().signal,
  ),
  /recap output reached maxOutputTokens=4096 without a complete sentence/,
);
assert.deepEqual(seenMaxTokens, [DEFAULT_CONFIG.maxOutputTokens, 4096]);

// A max-tokens answer that already holds a finished sentence is salvaged as it is,
// without paying for a second call.
seenMaxTokens.length = 0;
const salvaged = await generateRecap(
  contextReturning(() => ({ stopReason: "length", content: [{ type: "text", text: "看门狗已挂上，抓到了退出码 1。下一步确认" }] })) as never,
  { ...DEFAULT_CONFIG, maxChars: 200 },
  new AbortController().signal,
);
assert.equal(salvaged, "看门狗已挂上，抓到了退出码 1。");
assert.equal(seenMaxTokens.length, 1);

// Nothing finished yet is different: retry once with a larger ceiling instead of
// publishing half a thought.
let attempts = 0;
const rescued = await generateRecap(
  {
    ...fakeContext,
    modelRegistry: {
      ...fakeContext.modelRegistry,
      getProvider: () => ({
        streamSimple: () => ({
          result: async () => {
            attempts += 1;
            return attempts === 1
              ? { stopReason: "length", content: [{ type: "text", text: "下一步确认" }] }
              : { stopReason: "stop", content: [{ type: "text", text: "看门狗已挂上，抓到了退出码 1。下一步确认进程是否还活着。" }] };
          },
        }),
      }),
    },
  } as never,
  { ...DEFAULT_CONFIG, maxChars: 200 },
  new AbortController().signal,
);
assert.equal(rescued, "看门狗已挂上，抓到了退出码 1。下一步确认进程是否还活着。");
assert.equal(attempts, 2);

console.log("PASS provider-neutral completion, language sampling, sentence-safe budget and one escalated retry");
