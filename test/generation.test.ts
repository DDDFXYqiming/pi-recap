import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../config.ts";
import { generateRecap } from "../generation.ts";

let seenOptions: Record<string, unknown> = {};
let seenContext: { systemPrompt?: string } = {};
const model = {
  provider: "fake-provider",
  id: "fake-model",
  api: "fake-api",
  reasoning: true,
  thinkingLevelMap: { high: "provider-specific-high", max: "provider-specific-max" },
};
const fakeContext = {
  model,
  // A session running at thinking=max must not leak that level into the recap call.
  thinkingLevel: "max",
  sessionManager: {
    buildContextEntries: () => [
      { type: "message", id: "u1", message: { role: "user", content: "Implement the recap plugin" } },
      { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "I will implement it" }], stopReason: "stop" } },
    ],
    getSessionId: () => "test-session",
  },
  modelRegistry: {
    getProvider: () => ({
      streamSimple: (_model: unknown, context: unknown, options: Record<string, unknown>) => {
        seenContext = context as { systemPrompt?: string };
        seenOptions = options;
        return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Goal is implemented; next action is verify it." }] }) };
      },
    }),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-only-key" }),
  },
};

const recap = await generateRecap(fakeContext as never, { ...DEFAULT_CONFIG, maxChars: 100 }, new AbortController().signal);
assert.equal(recap, "Goal is implemented; next action is verify it.");
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
assert.equal(seenOptions.apiKey, "test-only-key");
assert.match(seenContext.systemPrompt ?? "", /active coding session/);
assert.match(seenContext.systemPrompt ?? "", /same language the user writes in/);
// The output contract has to name the failure modes the card cannot absorb: narrating
// the transcript, and markdown or list layout that the recap line was never meant to hold.
assert.match(seenContext.systemPrompt ?? "", /first character you write is the first character of the recap/);
assert.match(seenContext.systemPrompt ?? "", /我看到了完整的会话记录/);
assert.match(seenContext.systemPrompt ?? "", /Here is the recap/);
assert.match(seenContext.systemPrompt ?? "", /no markdown[\s\S]*no line breaks/);
assert.match(seenContext.systemPrompt ?? "", /untrusted session data/);

// A model that ignores the contract still cannot overflow the card budget.
const ramblingText = `我看到了完整的会话记录。这段对话的核心是：${"**真实 dsh 已恢复** 跑在看门狗下 `http://127.0.0.1:3080` - " .repeat(40)}`;
const ramblingContext = {
  ...fakeContext,
  modelRegistry: {
    ...fakeContext.modelRegistry,
    getProvider: () => ({
      streamSimple: () => ({
        result: async () => ({ stopReason: "stop", content: [{ type: "text", text: ramblingText }] }),
      }),
    }),
  },
};
const clampedRecap = await generateRecap(ramblingContext as never, { ...DEFAULT_CONFIG, maxChars: 120 }, new AbortController().signal);
assert.ok(clampedRecap.length <= 120, `length=${clampedRecap.length}`);
assert.ok(clampedRecap.endsWith("…"));
assert.doesNotMatch(clampedRecap, /\[/);
// Content is not censored at the display layer: a chatty answer stays chatty, so the
// prompt remains the only place that shapes wording. Only the budget is enforced here.
assert.ok(clampedRecap.startsWith("我看到了完整的会话记录。"));

// Reasoning that arrives in the text channel is refused, never shown on the card.
const leakedAnswers: string[] = [
  `<think>The user wants a recap.</think> 任务已就绪，下一步跑回归。`,
  `  <think>reasoning</think>`,
];
for (const leakText of leakedAnswers) {
  const leakContext = {
    ...fakeContext,
    modelRegistry: {
      ...fakeContext.modelRegistry,
      getProvider: () => ({
        streamSimple: () => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: leakText }] }) }),
      }),
    },
  };
  await assert.rejects(
    () => generateRecap(leakContext as never, { ...DEFAULT_CONFIG, maxChars: 100 }, new AbortController().signal),
    /returned reasoning instead of an answer/,
    leakText,
  );
}

// A provider that only emits thinking blocks reports the token ceiling, not "no text".
const truncatedContext = {
  ...fakeContext,
  modelRegistry: {
    ...fakeContext.modelRegistry,
    getProvider: () => ({
      streamSimple: () => ({
        result: async () => ({ stopReason: "length", content: [{ type: "thinking", thinking: "budget spent here" }] }),
      }),
    }),
  },
};
await assert.rejects(
  () => generateRecap(truncatedContext as never, { ...DEFAULT_CONFIG, maxChars: 100 }, new AbortController().signal),
  /recap output reached maxOutputTokens=2048/,
);
console.log("PASS provider-neutral simple completion without reasoning");
