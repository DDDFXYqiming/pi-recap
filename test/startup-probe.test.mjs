import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const probe = fileURLToPath(new URL('../scripts/startup-probe.cjs', import.meta.url));
const KEY = 'pi-recap.startup-trace';
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-startup-probe-test-'));
  const traces = path.join(root, 'traces');
  const env = { ...process.env, PI_STARTUP_TRACE_DIR: traces };
  delete env.NODE_OPTIONS;
  return { root, traces, env, clean: () => rmSync(root, { recursive: true, force: true }) };
}
function journal(dir) {
  try {
    return readdirSync(dir).filter(f => f.endsWith('.jsonl')).flatMap(f =>
      readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
function run(source, f, preload = true) {
  const r = spawnSync(process.execPath, [...(preload ? ['--require', probe] : []), '-e', source], {
    env: f.env, encoding: 'utf8', timeout: 6000,
  });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  return r;
}

test('disabled preload leaves functions and stdin listeners untouched', () => {
  const f = fixture();
  delete f.env.PI_STARTUP_TRACE_DIR;
  try {
    run(`const assert=require('node:assert/strict'), cp=require('node:child_process');
      const w=process.stdout.write, s=cp.spawnSync, n=process.stdin.listenerCount('data');
      require(${JSON.stringify(probe)});
      assert.equal(process.stdout.write,w); assert.equal(cp.spawnSync,s);
      assert.equal(process.stdin.listenerCount('data'),n);
      assert.equal(globalThis[Symbol.for(${JSON.stringify(KEY)})],undefined);`, f, false);
    assert.equal(journal(f.traces).length, 0);
  } finally { f.clean(); }
});

test('enabled observer preserves stdout/callbacks, does not add stdin readers or record content', () => {
  const f = fixture();
  try {
    const source = `const assert=require('node:assert/strict');
      assert.equal(process.stdin.listenerCount('data'),0);
      const phase=globalThis[Symbol.for(${JSON.stringify(KEY)})];
      phase('recap:session-start:enter'); phase('secret with spaces');
      process.stdout.write('PRIVATE_OUTPUT_123');
      process.stderr.write('PRIVATE_ERROR_456');
      process.stdout.write('\\x1b[?1004h',()=>phase('recap:callback:done'));
      process.stdout.write('\\x1b[?1004l');`;
    const r = run(source, f);
    assert.equal(r.stdout, 'PRIVATE_OUTPUT_123\x1b[?1004h\x1b[?1004l');
    assert.equal(r.stderr, 'PRIVATE_ERROR_456');
    const rows = journal(f.traces);
    assert.ok(rows.some(x => x.event === 'recap:session-start:enter'));
    assert.ok(rows.some(x => x.event === 'recap:callback:done'));
    assert.ok(rows.some(x => x.event === 'stdout:focus:on:end'));
    assert.ok(rows.some(x => x.event === 'stdout:focus:off:end'));
    assert.ok(rows.some(x => x.event === 'probe:exit'));
    assert.equal(rows.find(x => x.event === 'probe:start').stdinDataListeners, 0);
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_|secret with spaces/);
  } finally { f.clean(); }
});

test('sync subprocess returns and exceptions are preserved; command arguments stay private', () => {
  const f = fixture();
  try {
    run(`const assert=require('node:assert/strict'),cp=require('node:child_process');
      assert.equal(cp.execFileSync(process.execPath,['-e','process.stdout.write("SECRET_ARG_789")'],{encoding:'utf8'}),'SECRET_ARG_789');
      assert.throws(()=>cp.execFileSync(process.execPath,['-e','process.exit(7)']), e=>e.status===7);
      const result=cp.spawnSync(process.execPath,['-e','process.exit(3)']);
      assert.equal(result.status,3);`, f);
    const rows = journal(f.traces);
    assert.ok(rows.some(x => x.event === 'execFileSync:begin'));
    assert.ok(rows.some(x => x.event === 'execFileSync:throw'));
    assert.ok(rows.some(x => x.event === 'spawnSync:end' && x.status === 3));
    assert.doesNotMatch(JSON.stringify(rows), /SECRET_ARG_789|process\.exit\(7\)/);
  } finally { f.clean(); }
});

test('ESM imports and promisified execFile keep their original result shape', () => {
  const f = fixture();
  try {
    run(`(async()=>{
      const assert=require('node:assert/strict');
      const {execFile}=await import('node:child_process');
      const {promisify}=await import('node:util');
      const result=await promisify(execFile)(process.execPath,['-e','process.stdout.write("ok");process.stderr.write("err")']);
      assert.deepEqual(result,{stdout:'ok',stderr:'err'});
    })().catch(e=>{console.error(e);process.exitCode=1;});`, f);
    assert.ok(journal(f.traces).some(x => x.event === 'execFile:promisified:begin'));
  } finally { f.clean(); }
});

test('heartbeat exists without reading stdin and timers do not hold a process open', () => {
  const f = fixture();
  try {
    run(`setTimeout(()=>{},1100);`, f);
    const rows = journal(f.traces);
    assert.ok(rows.some(x => x.event === 'probe:heartbeat' && x.stdinDataListeners === 0));
    assert.ok(rows.some(x => x.event === 'probe:exit'));
  } finally { f.clean(); }
});

test('unwritable trace destination fails open without modifying process functions', () => {
  const f = fixture();
  writeFileSync(f.traces, 'not a directory');
  try {
    run(`const assert=require('node:assert/strict'),w=process.stdout.write;
      require(${JSON.stringify(probe)});
      assert.equal(process.stdout.write,w);
      assert.equal(globalThis[Symbol.for(${JSON.stringify(KEY)})],undefined);
      console.log('ok');`, f, false);
  } finally { f.clean(); }
});

test('a synchronous stall leaves a begin checkpoint before the call returns', async () => {
  const f = fixture();
  const child = spawn(process.execPath, ['-e', `
    const cp=require('node:child_process');
    cp.spawnSync=()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);return {status:0};};
    require(${JSON.stringify(probe)});
    cp.spawnSync('node',['SECRET_NOT_LOGGED']);
  `], { env: f.env, stdio: 'ignore' });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  try {
    let rows = [];
    const limit = Date.now() + 3000;
    do {
      rows = journal(f.traces);
      if (rows.some(x => x.event === 'spawnSync:begin')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < limit);
    assert.ok(rows.some(x => x.event === 'spawnSync:begin'));
    assert.ok(!rows.some(x => x.event === 'spawnSync:end'));
    assert.equal(await done, 0);
    assert.ok(journal(f.traces).some(x => x.event === 'spawnSync:end'));
  } finally {
    if (child.exitCode === null) { child.kill(); await done; }
    f.clean();
  }
});

test('real extension checkpoints distinguish registration, session_start and deferred presence (mock host)', async () => {
  const { stripTypeScriptTypes } = await import('node:module');
  const { runInNewContext } = await import('node:vm');
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?\sfrom\s"[^"]+";\n/gm, '')
    .replace('export default function piRecap', 'function piRecap')
    .replace('export const FOCUS_INSTALL_DELAY_MS', 'const FOCUS_INSTALL_DELAY_MS');
  const events = new Map();
  const phases = [];
  const tasks = [];
  let installs = 0;
  const sandbox = {
    process: { env: {} }, console: { error() {} },
    loadConfig: () => ({ enabled: true, maxChars: 400 }),
    loadRecapState: () => undefined, isSnapshotCurrent: () => false,
    formatStatusLine: () => 'status',
    setTimeout: callback => { tasks.push(callback); return 1; }, clearTimeout() {},
    installFocusTracking: () => { installs++; return { available: true, focused: true, dispose() {} }; },
  };
  sandbox[Symbol.for(KEY)] = phase => phases.push(phase);
  runInNewContext(stripTypeScriptTypes(source) + '\nthis.plugin = piRecap;', sandbox);
  sandbox.plugin({ on: (name, handler) => events.set(name, handler), registerCommand() {} });
  assert.ok(phases.includes('recap:factory:return'));
  assert.ok(!phases.includes('recap:session-start:enter'));
  const context = {
    mode: 'tui', hasUI: true,
    sessionManager: { getBranch: () => [] },
    ui: { setStatus() {}, setWidget: (_key, factory) => {
      if (typeof factory === 'function') factory({ mode: 'regular', terminal: { write() {} } });
    } },
  };
  events.get('session_start')({}, context);
  assert.ok(phases.includes('recap:session-start:done'));
  assert.equal(installs, 0);
  tasks.shift()();
  assert.equal(installs, 1);
  assert.ok(phases.includes('recap:presence:install-ok'));
  assert.ok(phases.indexOf('recap:factory:return') < phases.indexOf('recap:session-start:enter'));
  assert.ok(phases.indexOf('recap:session-start:done') < phases.indexOf('recap:presence:install-begin'));
  // A broken sink is ignored, not promoted to an extension error.
  sandbox[Symbol.for(KEY)] = () => { throw new Error('sink unavailable'); };
  events.get('session_start')({}, context);
});
