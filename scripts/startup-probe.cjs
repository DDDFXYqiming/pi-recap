/* Opt-in Node preload. No stdin reads, output capture, network calls or timeouts
 * imposed on Pi. This observer changes timing; compare traced and untraced runs.
 * Activate only through diagnose-startup.ps1 or PI_STARTUP_TRACE_DIR + --require.
 */
"use strict";

const KEY = Symbol.for("pi-recap.startup-trace");
const traceDir = process.env.PI_STARTUP_TRACE_DIR;
if (traceDir && !globalThis[KEY]) {
  const fs = require("node:fs");
  const path = require("node:path");
  const cp = require("node:child_process");
  const { syncBuiltinESMExports } = require("node:module");
  const started = Date.now();
  const filename = path.join(traceDir, `node-${process.pid}-${started}.jsonl`);
  let enabled = true;
  let events = 0;
  let callId = 0;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let pending = new Map();
  const restorers = [];
  const seen = new Set();
  const input = process.stdin;
  const output = process.stdout;
  const errorOutput = process.stderr;
  try {
    fs.mkdirSync(traceDir, { recursive: true });
    fs.writeFileSync(filename, "", { flag: "wx", mode: 0o600 });
  } catch {
    enabled = false;
  }

  function record(event, data = {}) {
    if (!enabled || events >= 2000) return;
    try {
      events += 1;
      fs.appendFileSync(filename, JSON.stringify({
        t: Date.now() - started, pid: process.pid, event, ...data,
      }) + "\n");
    } catch { enabled = false; }
  }
  function state() {
    return {
      stdinTTY: Boolean(input.isTTY), stdoutTTY: Boolean(output.isTTY),
      stdinRaw: Boolean(input.isRaw), stdinPaused: input.isPaused(),
      stdinDataListeners: input.listenerCount("data"),
      stdoutBytes, stderrBytes,
      resources: typeof process.getActiveResourcesInfo === "function"
        ? process.getActiveResourcesInfo() : [],
      pending: [...pending.entries()].map(([id, value]) => ({ id, ...value })),
    };
  }
  function once(event, data) {
    if (seen.has(event)) return;
    seen.add(event);
    record(event, data);
  }
  function errorKind(error) {
    // Do not record messages: providers/commands can put secrets in errors.
    return { errorName: error?.name, code: typeof error?.code === "string" ? error.code : undefined };
  }
  function executable(value) {
    // Arguments and shell command strings are never written to the journal.
    if (typeof value !== "string") return "unknown";
    const leaf = value.split(/[\\/]/).at(-1);
    return /^(?:node|nodejs|pwsh|powershell|cmd|bash|sh|git|npm|npx|rg|fd)(?:\.exe|\.cmd)?$/i.test(leaf)
      ? leaf : "other";
  }
  function replace(object, key, wrapper) {
    const original = object[key];
    if (typeof original !== "function") return;
    const replacement = wrapper(original);
    const custom = Symbol.for("nodejs.util.promisify.custom");
    // Preserve API metadata, but define the custom Promise entry point once.
    for (const property of Reflect.ownKeys(original)) {
      if (property === custom || ["length", "name", "prototype", "arguments", "caller"].includes(property)) continue;
      Object.defineProperty(replacement, property, Object.getOwnPropertyDescriptor(original, property));
    }
    if (typeof original[custom] === "function") {
      const descriptor = Object.getOwnPropertyDescriptor(original, custom);
      Object.defineProperty(replacement, custom, { ...descriptor, value: function (...args) {
        const id = ++callId;
        const api = `${key}:promisified`;
        const data = { api, executable: key === "exec" ? "shell-command-redacted" : executable(args[0]) };
        record(`${api}:begin`, { id, ...data });
        let promise;
        try { promise = Reflect.apply(original[custom], this, args); }
        catch (error) { record(`${api}:throw`, { id, ...errorKind(error) }); throw error; }
        // Node attaches the ChildProcess to this Promise. Observe close instead
        // of adding a rejection handler or replacing the augmented Promise.
        const child = promise?.child;
        record(`${api}:returned`, { id, childPid: child?.pid });
        if (child && typeof child.once === "function") {
          pending.set(id, data);
          child.once("close", (code, signal) => {
            pending.delete(id);
            record(`${api}:close`, { id, code, signal });
          });
        }
        return promise;
      } });
    }
    object[key] = replacement;
    restorers.push(() => { if (object[key] === replacement) object[key] = original; });
  }
  function paired(object, key, details) {
    replace(object, key, (original) => function (...args) {
      const id = ++callId;
      const data = details(args);
      pending.set(id, { api: key, ...data });
      record(`${key}:begin`, { id, ...data });
      try {
        const value = Reflect.apply(original, this, args);
        record(`${key}:end`, { id, status: typeof value?.status === "number" ? value.status : undefined });
        return value;
      } catch (error) {
        record(`${key}:throw`, { id, ...errorKind(error) });
        throw error;
      } finally { pending.delete(id); }
    });
  }

  if (enabled) {
    const sink = (stage) => {
      if (typeof stage === "string" && /^recap:[a-z0-9:_-]{1,100}$/.test(stage)) record(stage);
    };
    globalThis[KEY] = sink;
    record("probe:start", { node: process.version, platform: process.platform, ppid: process.ppid, ...state() });

    paired(input, "setRawMode", (args) => ({ raw: Boolean(args[0]) }));
    paired(process, "dlopen", () => ({}));
    for (const method of ["spawnSync", "execFileSync", "execSync"]) {
      paired(cp, method, (args) => ({ executable: method === "execSync" ? "shell-command-redacted" : executable(args[0]) }));
    }
    for (const method of ["spawn", "execFile", "exec"]) {
      replace(cp, method, (original) => function (...args) {
        const id = ++callId;
        const data = { api: method, executable: method === "exec" ? "shell-command-redacted" : executable(args[0]) };
        record(`${method}:begin`, { id, ...data });
        let child;
        try { child = Reflect.apply(original, this, args); }
        catch (error) { record(`${method}:throw`, { id, ...errorKind(error) }); throw error; }
        pending.set(id, data);
        record(`${method}:returned`, { id, childPid: child.pid });
        // A close listener does not intercept stdout/stderr or consume error events.
        child.once("close", (code, signal) => {
          pending.delete(id);
          record(`${method}:close`, { id, code, signal });
        });
        return child;
      });
    }
    syncBuiltinESMExports();

    const markers = [
      ["bracketed-paste:on", "\x1b[?2004h"],
      ["kitty:query", "\x1b[?u"],
      ["cursor:hide", "\x1b[?25l"],
      ["focus:on", "\x1b[?1004h"],
      ["focus:off", "\x1b[?1004l"],
    ];
    for (const [name, stream] of [["stdout", output], ["stderr", errorOutput]]) {
      replace(stream, "write", (original) => function (...args) {
        // Inspect only bounded chunks for fixed public protocol markers, never
        // persist their contents. Preserve write's return value/callback/this.
        const chunk = args[0];
        const length = typeof chunk === "string" ? Buffer.byteLength(chunk) : (chunk?.byteLength || 0);
        if (name === "stdout") stdoutBytes += length; else stderrBytes += length;
        let labels = [];
        if (typeof chunk === "string" && chunk.length <= 65536) {
          for (const [label, token] of markers) {
            if (chunk.includes(token) && !seen.has(`${name}:${label}:begin`)) labels.push(label);
          }
          if (name === "stderr" && chunk.includes("[pi-recap] loaded")) labels.push("recap-loaded-line");
        }
        for (const label of labels) once(`${name}:${label}:begin`);
        once(`${name}:first-write:begin`);
        const value = Reflect.apply(original, this, args);
        once(`${name}:first-write:end`);
        for (const label of labels) once(`${name}:${label}:end`);
        return value;
      });
    }

    const heartbeat = setInterval(() => record("probe:heartbeat", state()), 1000);
    heartbeat.unref();
    const onExit = (code) => record("probe:exit", { code, ...state() });
    process.once("exit", onExit);
    const stop = setTimeout(() => {
      record("probe:observation-ended", state());
      clearInterval(heartbeat);
      enabled = false;
      for (const restore of restorers.reverse()) restore();
      syncBuiltinESMExports();
      if (globalThis[KEY] === sink) delete globalThis[KEY];
      process.removeListener("exit", onExit);
    }, 120_000);
    stop.unref();
  }
}
