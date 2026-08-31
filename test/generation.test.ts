import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../config.ts";
import { effectiveThinkingEffort, generateRecap } from "../generation.ts";

assert.equal(effectiveThinkingEffort({ provider: "local", id: "qwen", reasoning: true, thinkingLevelMap: { high: "high", xhigh: "max" } }, "high"), "high");
assert.equal(effectiveThinkingEffort({ provider: "aliyun", id: "qwen3.8-flash", reasoning: true, thinkingLevelMap: { high: null, xhigh: "xhigh" } }, "high"), "xhigh");
assert.equal(effectiveThinkingEffort({ provider: "local", id: "plain", reasoning: false }, "high"), undefined);
assert.equal(effectiveThinkingEffort({ provider: "local", id: "qwen", reasoning: true }, "off"), undefined);

let seenOptions: Record<string, unknown> = {};
let seenContext: { systemPrompt?: string } = {};
const model = {
  provider: "fake-provider",
  id: "fake-model",
  api: "fake-api",
  reasoning: true,
  thinkingLevelMap: { high: "provider-specific-high" },
};
const fakeContext = {
  model,
  thinkingLevel: "high",
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
assert.equal(seenOptions.reasoning, "high");
assert.equal("reasoningEffort" in seenOptions, false);
assert.equal(seenOptions.apiKey, "test-only-key");
assert.match(seenContext.systemPrompt ?? "", /active coding session/);
console.log("PASS provider-neutral simple completion and thinking mapping");
