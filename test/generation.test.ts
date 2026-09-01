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
assert.equal(seenOptions.maxTokens, DEFAULT_CONFIG.maxOutputTokens);
assert.ok(DEFAULT_CONFIG.maxOutputTokens >= 2_048);
assert.equal(seenOptions.apiKey, "test-only-key");
assert.match(seenContext.systemPrompt ?? "", /active coding session/);
assert.match(seenContext.systemPrompt ?? "", /same language the user writes in/);

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
