import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, parseConfig, saveConfig } from "../config.ts";

const parsed = parseConfig({
  enabled: false,
  idleMs: 10,
  minTurns: 4.6,
  recentMessages: 999,
  maxChars: 999,
  maxInputChars: 20,
  maxOutputTokens: 0,
  timeoutMs: "bad",
  provider: " aliyun-tokenplan ",
  model: " qwen3.8-flash ",
  reasoningEffort: " high ",
});
assert.equal(parsed.enabled, false);
assert.equal(parsed.idleMs, 1_000);
assert.equal(parsed.minTurns, 5);
assert.equal(parsed.recentMessages, 200);
assert.equal(parsed.maxChars, 400);
assert.equal(parsed.maxInputChars, 1_000);
assert.equal(parsed.maxOutputTokens, 16);
assert.equal(parsed.timeoutMs, DEFAULT_CONFIG.timeoutMs);
assert.equal(parsed.provider, "aliyun-tokenplan");
assert.equal(parsed.model, "qwen3.8-flash");
assert.equal(parsed.reasoningEffort, "high");
assert.deepEqual(parseConfig(null), DEFAULT_CONFIG);

const temp = mkdtempSync(join(tmpdir(), "pi-recap-config-"));
const configPath = join(temp, "nested", "pi-recap.json");
saveConfig(parsed, configPath);
assert.deepEqual(loadConfig(configPath), parsed);
assert.equal(existsSync(configPath), true);
assert.deepEqual(readdirSync(join(temp, "nested")), ["pi-recap.json"]);
rmSync(temp, { recursive: true, force: true });
console.log("PASS config parsing, bounds, and atomic save");
