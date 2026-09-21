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
const [MODEL_PROVIDER, ...MODEL_ID_PARTS] = MODEL.split("/");
const MODEL_ID = MODEL_ID_PARTS.join("/") || MODEL_PROVIDER;
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
      // The transcript tail has to be as loud as the real sessions that produced bad
      // recaps: a long markdown report with a colon-led framing sentence. If the recap
      // prompt is weak, the model copies that style instead of writing a plain card.
      "不要调用工具。请用中文写一段 200 字以上的进展汇报，必须使用 markdown：至少 3 处 **加粗**、2 处行内代码、1 个有序列表，并以一个冒号引导句开头（例如“现在的状态是：”）。内容是排查 dsh web 静默闪退、看门狗已挂上 PID 24772、日志在 ~/.dsh/logs/dsh-web.log。",
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
    const recapText = state?.text ?? "";
    console.log(`[${stamp()}] recap text: ${JSON.stringify(recapText)}`);
    const recapNotices = events
      .filter((event) => event.type === "extension_ui_request" && event.method === "notify" && String(event.message ?? "").includes("pi-recap"))
      .map((event) => `${event.notifyType ?? "info"}: ${event.message}`);
    for (const notice of recapNotices) console.log(`[${stamp()}] notify ${notice}`);
    record("requested-model-selected", selectedModel?.provider === MODEL_PROVIDER && selectedModel?.id === MODEL_ID, `expected=${MODEL}, got=${selectedModelText}`);
    record("requested-thinking-level-applied", startupState?.thinkingLevel === THINKING || (THINKING === "high" && startupState?.thinkingLevel === "xhigh"), `requested=${THINKING}, effective=${startupState?.thinkingLevel ?? "unknown"}`);
    record("manual-command-completed", manualResponse?.success === true && manualResponse?.command === "prompt", manualResponse ? `success=${manualResponse.success}` : "no response");
    record("manual-command-does-not-start-agent", runs === prompts.length, `runs=${runs}, settled=${settled}`);
    record("manual-recap-widget", widgetReady, `runs=${runs}, settled=${settled}`);
    record("manual-recap-persisted", Boolean(state?.text && state?.source === "manual" && state?.anchorEntryId), state ? `source=${state.source}` : "no custom state entry");
    record("recap-is-tui-only-entry", recapEntries.length === 1 && recapContextMessages.length === 0, `custom=${recapEntries.length}, context=${recapContextMessages.length}`);
    record("no-extension-errors", extensionErrors === 0, `count=${extensionErrors}`);
    // Output contract of the recap prompt, measured against a markdown-heavy transcript.
    record("recap-has-no-markdown", !/\*\*|__|`|\[[^\]]*\]\(|^\s*[-*+•]\s|^\s*\d+[.)]\s/.test(recapText), recapText.slice(0, 80));
    record("recap-is-one-line", !recapText.includes("\n"), JSON.stringify(recapText.slice(0, 80)));
    record("recap-has-no-transcript-preamble", !/^(我看到了|我看到以|这段对话|以上对话|以下是|好的|总结|I see|Here is|Here's|In summary|Sure)/i.test(recapText), recapText.slice(0, 40));
    record("recap-fits-the-card", recapText.length > 0 && recapText.length <= 400, `length=${recapText.length}`);
    // This run's transcript is Chinese. An English answer means the model mirrored the
    // language of the instructions instead of the language the user writes in.
    record("recap-follows-user-language", /[\u3400-\u4dbf\u4e00-\u9fff]/.test(recapText), recapText.slice(0, 40));
    const thinkOpen = "<" + "think";
    record("recap-has-no-reasoning-leak", recapText.length > 0 && !recapText.trimStart().toLowerCase().startsWith(thinkOpen), recapText.slice(0, 40) || "no text was persisted");
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
