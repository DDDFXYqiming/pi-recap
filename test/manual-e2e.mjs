#!/usr/bin/env node
/**
 * Manual /recap E2E through an isolated Pi RPC session.
 * The automatic focus path is intentionally covered by offline unit tests and
 * a real interactive TUI check; this test only exercises manual generation.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.join(tmpdir(), `pi-recap-manual-e2e-${process.pid}`);
const WORKSPACE = path.join(ROOT, "workspace");
const SESSIONS = path.join(ROOT, "sessions");
const EXT = path.join(PKG, "index.ts");
const PI_JS = process.env.PI_E2E_PI_JS ?? path.join(PKG, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const MODEL = process.env.PI_E2E_MODEL ?? "aliyun-tokenplan/qwen3.8-flash";
const THINKING = process.env.PI_E2E_THINKING ?? "high";
const TIMEOUT = Number(process.env.PI_E2E_TIMEOUT_MS ?? 300_000);

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(WORKSPACE, { recursive: true });
mkdirSync(SESSIONS, { recursive: true });

const results = [];
const events = [];
let buffer = "";
let runs = 0;
let settled = 0;
let extensionErrors = 0;
let startupState;
let manualResponse;
let child;
const startedAt = Date.now();
const stamp = () => `+${Math.round((Date.now() - startedAt) / 1000)}s`;

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function sessionFile() {
  const files = readdirSync(SESSIONS).filter((name) => name.endsWith(".jsonl"));
  if (files.length === 0) return undefined;
  return files
    .map((name) => ({ file: path.join(SESSIONS, name), mtime: statSync(path.join(SESSIONS, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.file;
}

function sessionEntries() {
  const file = sessionFile();
  if (!file) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
}

function latestRecap() {
  return sessionEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === "pi-recap/state")
    .at(-1)?.data?.snapshot;
}

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate()) return resolve(true);
      if (Date.now() >= deadline) {
        console.log(`[${stamp()}] timeout: ${label}`);
        return resolve(false);
      }
      setTimeout(check, 250);
    };
    check();
  });
}

function send(message, id) {
  child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
  console.log(`[${stamp()}] → ${message}`);
}

function sendCommand(command) {
  child.stdin.write(`${JSON.stringify(command)}\n`);
}

function waitForSettled(target) {
  return waitFor(() => settled >= target, TIMEOUT, `agent_settled ${target}`);
}

let stopping;
function stopChild() {
  if (!child) return Promise.resolve();
  if (stopping) return stopping;
  stopping = new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, 5_000);
    child.once("exit", finish);
    try { child.stdin.end(); } catch {}
    if (process.platform === "win32" && child.pid && child.exitCode === null) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    }
    if (child.exitCode === null) child.kill();
  });
  return stopping;
}

async function cleanupRoot() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  console.warn(`[${stamp()}] temporary E2E directory could not be removed: ${ROOT}`);
  return false;
}

const piArgs = [
  "--mode", "rpc",
  "--offline",
  "--no-extensions",
  "--no-tools",
  "--model", MODEL,
  "--thinking", THINKING,
  "--session-dir", SESSIONS,
  "-e", EXT,
];
child = spawn(process.execPath, [PI_JS, ...piArgs], { cwd: WORKSPACE, shell: false, stdio: ["pipe", "pipe", "pipe"] });

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      events.push(event);
      if (event.type === "response" && event.id === "startup-state" && event.success) {
        startupState = event.data;
      }
      if (event.type === "response" && event.id === "manual-recap") {
        manualResponse = event;
      }
      if (event.type === "agent_start") {
        runs += 1;
        console.log(`[${stamp()}] agent_start #${runs}`);
      }
      if (event.type === "agent_settled") {
        settled += 1;
        console.log(`[${stamp()}] agent_settled #${settled}`);
      }
      if (event.type === "extension_error") {
        extensionErrors += 1;
        console.log(`[${stamp()}] extension_error ${JSON.stringify(event).slice(0, 500)}`);
      }
    } catch {
      console.log(`[${stamp()}] non-json stdout: ${line.slice(0, 200)}`);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  for (const line of chunk.split(/\r?\n/)) if (line.trim()) console.log(`  [pi] ${line.trim()}`);
});

let teardownPromise;
function teardown() {
  if (teardownPromise) return teardownPromise;
  teardownPromise = (async () => {
    await stopChild();
    return cleanupRoot();
  })();
  return teardownPromise;
}

async function main() {
  let cleaned = true;
  try {
    sendCommand({ id: "startup-state", type: "get_state" });
    const stateReady = await waitFor(() => startupState !== undefined, TIMEOUT, "startup state");
    if (!stateReady) throw new Error("Pi did not return startup state");

    const prompts = [
      "请只用一句简短中文回答：本回合记录目标是实现一个 Pi TUI 会话 recap 插件。不要调用工具。",
      "请只用一句简短中文回答：当前进展是已经完成核心逻辑和手动命令设计。不要调用工具。",
      "请只用一句简短中文回答：下一步是验证持久化和 CLI 端到端行为。不要调用工具。",
    ];
    for (let index = 0; index < prompts.length; index += 1) {
      send(prompts[index], `turn-${index + 1}`);
      const ok = await waitForSettled(index + 1);
      if (!ok) throw new Error(`turn ${index + 1} did not settle`);
    }

    send("/recap", "manual-recap");
    const commandReady = await waitFor(() => manualResponse !== undefined, TIMEOUT, "manual recap response");
    const widgetReady = commandReady && events.some((event) => event.type === "extension_ui_request" && event.method === "setWidget" && event.widgetKey === "pi-recap/card" && Array.isArray(event.widgetLines) && event.widgetLines.some((line) => typeof line === "string" && line.startsWith("↩ recap:")));
    const state = latestRecap();
    const entries = sessionEntries();
    const recapEntries = entries.filter((entry) => entry.type === "custom" && entry.customType === "pi-recap/state");
    const recapContextMessages = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "pi-recap/state");
    const selectedModel = startupState?.model;
    const selectedModelText = selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : "unknown";
    record("requested-model-selected", selectedModel?.provider === "aliyun-tokenplan" && selectedModel?.id === "qwen3.8-flash", `${selectedModelText}`);
    record("requested-thinking-level-applied", startupState?.thinkingLevel === THINKING || (THINKING === "high" && startupState?.thinkingLevel === "xhigh"), `requested=${THINKING}, effective=${startupState?.thinkingLevel ?? "unknown"}`);
    record("manual-command-completed", manualResponse?.success === true && manualResponse?.command === "prompt", manualResponse ? `success=${manualResponse.success}` : "no response");
    record("manual-command-does-not-start-agent", runs === 3, `runs=${runs}, settled=${settled}`);
    record("manual-recap-widget", widgetReady, `runs=${runs}, settled=${settled}`);
    record("manual-recap-persisted", Boolean(state?.text && state?.source === "manual" && state?.anchorEntryId), state ? `source=${state.source}` : "no custom state entry");
    record("recap-is-tui-only-entry", recapEntries.length === 1 && recapContextMessages.length === 0, `custom=${recapEntries.length}, context=${recapContextMessages.length}`);
    record("no-extension-errors", extensionErrors === 0, `count=${extensionErrors}`);
  } finally {
    cleaned = await teardown();
  }
  if (!cleaned) record("temporary-directory-cleanup", false, ROOT);
  const passed = results.filter((result) => result.pass).length;
  console.log(`\n=== MANUAL RECAP E2E: ${passed}/${results.length} passed ===`);
  process.exitCode = passed === results.length ? 0 : 1;
}

const watchdog = setTimeout(() => {
  console.error("GLOBAL WATCHDOG");
  void teardown().then(() => { process.exit(2); });
}, TIMEOUT * 2);
watchdog.unref();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.error(`INTERRUPTED (${signal})`);
    void teardown().then(() => { process.exit(2); });
  });
}

main().catch(async (error) => {
  console.error(error);
  await teardown();
  process.exitCode = 2;
});
