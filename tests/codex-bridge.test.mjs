import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildCodexArgs,
  buildCodexEnv,
  buildSpawnCommand,
  inspectCodexHealth,
  listCodexModels,
  parseCodexJsonl,
  resolveCodexBinary,
  runCodexTask
} from '../lib/codex-bridge.mjs';
import { collectPackage } from '../lib/package.mjs';

test('listCodexModels reads the Codex home override and prepends an uncached top-level model', t => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-codex-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.toml');
  writeFileSync(configPath, '# model = "commented-out"\nmodel = "local-model" # default\n[profiles.work]\nmodel = "profile-model"\n');
  writeFileSync(join(dir, 'models_cache.json'), JSON.stringify({
    fetched_at: '2026-11-27T00:00:00Z',
    models: [
      { slug: 'hidden-model', visibility: 'hide' },
      { slug: 'cached-model', display_name: 'Cached Model' },
      { slug: 'cached-model', display_name: 'Duplicate' },
      { slug: 'other-model' }
    ]
  }));
  const options = { env: { CODEX_HOME: dir } };
  const cachedModels = [
    { slug: 'cached-model', displayName: 'Cached Model' },
    { slug: 'other-model', displayName: 'other-model' }
  ];
  assert.deepEqual(listCodexModels(options), {
    models: [{ slug: 'local-model', displayName: 'local-model' }, ...cachedModels],
    configuredModel: 'local-model',
    fetchedAt: '2026-11-27T00:00:00Z'
  });

  writeFileSync(configPath, 'model = "cached-model"\n');
  assert.deepEqual(listCodexModels(options).models, cachedModels);
  writeFileSync(configPath, '# model = "commented-out"\n[profiles.work]\nmodel = "profile-model"\n');
  assert.equal(listCodexModels(options).configuredModel, '');
});

test('listCodexModels falls back to the home directory and handles missing or corrupt files', t => {
  const home = mkdtempSync(join(tmpdir(), 'agy-codex-models-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = { env: {}, home };
  const empty = { models: [], configuredModel: '', fetchedAt: '' };
  assert.deepEqual(listCodexModels(options), empty);

  const dir = join(home, '.codex');
  mkdirSync(dir);
  writeFileSync(join(dir, 'config.toml'), 'model = "unterminated');
  writeFileSync(join(dir, 'models_cache.json'), '{ broken JSON');
  assert.deepEqual(listCodexModels(options), empty);

  writeFileSync(join(dir, 'config.toml'), 'model = "local-model"\n');
  assert.deepEqual(listCodexModels(options), {
    models: [{ slug: 'local-model', displayName: 'local-model' }],
    configuredModel: 'local-model',
    fetchedAt: ''
  });
});

function makeStubCodex(dir) {
  const scriptPath = join(dir, 'codex-stub.mjs');
  writeFileSync(scriptPath, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli 0.171.0-stub');
  process.exit(0);
}
if (args.includes('exit-early')) {
  console.error('fixture exited early');
  process.exit(42);
}
const prompt = readFileSync(0, 'utf8').trim();
if (prompt.startsWith('hold:')) {
  writeFileSync(prompt.slice(5) + '.pid', String(process.pid));
  await new Promise(resolve => setTimeout(resolve, 30_000));
}
const outIdx = args.indexOf('-o');
const outFile = outIdx >= 0 ? args[outIdx + 1] : '';
const isResume = args[1] === 'resume';
const isReview = args[1] === 'review';
const sessionId = isResume ? args[args.indexOf('--') + 1] : 'sess-stub-42';
console.log(JSON.stringify({ type: 'thread.started', thread_id: sessionId }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'lib/example.mjs', kind: 'update' }] } }));
const reply = JSON.stringify({ mode: isReview ? 'review' : isResume ? 'resume' : 'run', args, prompt, proxy: process.env.HTTPS_PROXY || '' });
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reply } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 30 } }));
if (outFile) writeFileSync(outFile, reply, 'utf8');
`, 'utf8');
  if (process.platform === 'win32') {
    const cmdPath = join(dir, 'codex stub.cmd');
    const node = process.execPath.replace(/%/g, '%%');
    writeFileSync(cmdPath, `@"${node}" "%~dp0codex-stub.mjs" %*\r\n`, 'utf8');
    return cmdPath;
  }
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

test('buildCodexArgs builds exact flags for run, resume, and review modes and rejects unsafe inputs', () => {
  const runArgs = buildCodexArgs({
    mode: 'run',
    cwd: '/tmp/repo',
    sandbox: 'read-only',
    model: 'gpt-5-codex',
    worktree: true,
    addDirs: ['/tmp/extra'],
    skipGitRepoCheck: true,
    outputLastMessagePath: '/tmp/out.txt',
    hasPrompt: true
  });
  assert.deepEqual(runArgs, [
    'exec', '-C', '/tmp/repo', '-s', 'read-only', '-m', 'gpt-5-codex',
    '--worktree', '--add-dir', '/tmp/extra', '--skip-git-repo-check',
    '--json', '-o', '/tmp/out.txt', '-'
  ]);

  const resumeArgs = buildCodexArgs({
    mode: 'resume',
    sessionId: 'sess-123',
    outputLastMessagePath: '/tmp/out.txt',
    hasPrompt: true
  });
  assert.deepEqual(resumeArgs, ['exec', 'resume', '--json', '-o', '/tmp/out.txt', '--', 'sess-123', '-']);

  for (const sessionId of ['  --last', '-x', '\nsession', 'sess\x7fid', 'sess\u0085id']) {
    assert.throws(() => buildCodexArgs({ mode: 'resume', sessionId }), /sessionId/);
  }

  const reviewArgs = buildCodexArgs({
    mode: 'review',
    base: 'main',
    model: 'gpt-5-codex',
    hasPrompt: false
  });
  assert.deepEqual(reviewArgs, ['exec', 'review', '-c', 'sandbox_mode="read-only"', '--base', 'main', '-m', 'gpt-5-codex', '--json']);

  const customPromptReview = buildCodexArgs({ mode: 'review', hasPrompt: true });
  assert.deepEqual(customPromptReview, ['exec', 'review', '-c', 'sandbox_mode="read-only"', '--json', '-']);
  assert.deepEqual(buildCodexArgs({ mode: 'review' }), ['exec', 'review', '-c', 'sandbox_mode="read-only"', '--uncommitted', '--json']);
  for (const target of [{ base: 'main' }, { commit: 'abc123' }, { uncommitted: true }]) {
    assert.throws(() => buildCodexArgs({ mode: 'review', hasPrompt: true, ...target }), /cannot be combined/);
  }
});

test('Windows discovery and buildSpawnCommand handle .cmd shims and .exe binaries safely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-codex-win-'));
  try {
    const npmDir = join(dir, 'AppData', 'Roaming', 'npm');
    mkdirSync(npmDir, { recursive: true });
    const cmdFile = join(npmDir, 'codex.cmd');
    writeFileSync(cmdFile, '@echo off\r\n', 'utf8');

    const viaCommon = resolveCodexBinary({ platform: 'win32', env: { Path: '' }, home: dir });
    assert.equal(viaCommon.found, true);
    assert.equal(viaCommon.source, 'common');
    assert.equal(viaCommon.path, cmdFile);

    const viaPath = resolveCodexBinary({ platform: 'win32', env: { Path: `"${npmDir}";C:\\Windows` }, home: join(dir, 'other') });
    assert.equal(viaPath.found, true);
    assert.equal(viaPath.source, 'path');
    assert.equal(viaPath.path, cmdFile);

    const exeFile = join(npmDir, 'codex.exe');
    writeFileSync(exeFile, '');
    assert.deepEqual(resolveCodexBinary({ platform: 'win32', env: { Path: npmDir }, home: dir }),
      { found: true, source: 'path', path: exeFile });

    const args = ['--version', '', 'C:\\a & b\\', 'say "hello" | (world)! ^', '%PATH%'];
    const exe = 'C:\\Tools\\codex.exe';
    assert.deepEqual(buildSpawnCommand(exe, args, 'win32'), { command: exe, args, options: {} });
    for (const extension of ['cmd', 'BAT']) {
      const bin = 'C:\\Program Files (x86) & tools\\codex.' + extension;
      assert.deepEqual(buildSpawnCommand(bin, args, 'win32'), {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/e:on', '/v:off', '/s', '/c',
          '""' + bin + '" "--version" "" "C:\\a & b\\\\" "say ""hello"" | (world)! ^" "%%cd:~,%PATH%%cd:~,%""'],
        options: { windowsVerbatimArguments: true, windowsHide: true }
      });
      for (const value of ['a\nb', 'a\rb', 'a\0b']) {
        assert.throws(() => buildSpawnCommand(bin, [value], 'win32'), /line breaks/);
      }
    }
    assert.throws(() => buildSpawnCommand('C:\\%PATH%\\codex.cmd', [], 'win32'), /shim path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildCodexEnv inherits Powertools proxy settings safely', () => {
  const env = buildCodexEnv({
    settings: { proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7897', proxyBypass: '10.0.0.0/8' },
    baseEnv: { PATH: '/usr/bin' }
  });
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7897');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7897');
  assert.equal(env.ALL_PROXY, 'http://127.0.0.1:7897');
  assert.match(env.NO_PROXY, /127\.0\.0\.1/);
  assert.match(env.NO_PROXY, /10\.0\.0\.0\/8/);
});

test('parseCodexJsonl extracts sessionId, message, filesChanged, usage, and errors', () => {
  const parsed = parseCodexJsonl([
    'not json noise',
    JSON.stringify({ type: 'thread.started', thread_id: 'thr-99' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.js' }, { path: 'b.js' }] } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done!' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 80 } })
  ].join('\n'));
  assert.equal(parsed.sessionId, 'thr-99');
  assert.equal(parsed.lastMessage, 'Done!');
  assert.deepEqual(parsed.filesChanged, ['a.js', 'b.js']);
  assert.deepEqual(parsed.usage, { inputTokens: 500, cachedInputTokens: 200, outputTokens: 80 });
  assert.deepEqual(parsed.errors, []);
});

test('runCodexTask executes stub codex for run, resume, review and records run history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy codex & test-'));
  try {
    const stub = makeStubCodex(dir);
    const settings = {
      codexEnabled: true,
      codexPath: stub,
      codexDefaultSandbox: 'workspace-write',
      codexDefaultModel: '',
      proxyEnabled: true,
      proxyUrl: 'http://127.0.0.1:7897',
      proxyBypass: 'localhost,127.0.0.1,::1'
    };

    const resolved = resolveCodexBinary({ codexPath: stub });
    assert.equal(resolved.found, true);
    assert.equal(resolved.source, 'settings');

    const health = inspectCodexHealth({ settings });
    assert.equal(health.found, true);
    assert.equal(health.version, 'codex-cli 0.171.0-stub');
    assert.equal(health.proxyInherited, true);

    const model = 'model "with quotes" & (symbols) ^! %PATH%';
    const addDir = join(dir, 'more folders') + '\\';
    const runRes = await runCodexTask({
      mode: 'run',
      prompt: 'Implement feature X',
      cwd: dir,
      model,
      addDirs: [addDir],
      settings,
      dataDir: dir
    });
    assert.equal(runRes.ok, true);
    assert.equal(runRes.sessionId, 'sess-stub-42');
    assert.deepEqual(runRes.filesChanged, ['lib/example.mjs']);
    assert.equal(runRes.usage.outputTokens, 30);
    const payload = JSON.parse(runRes.message);
    assert.equal(payload.mode, 'run');
    assert.equal(payload.prompt, 'Implement feature X');
    assert.equal(payload.proxy, 'http://127.0.0.1:7897');
    assert.equal(payload.args[payload.args.indexOf('-m') + 1], model);
    assert.equal(payload.args[payload.args.indexOf('--add-dir') + 1], addDir);

    const resumeRes = await runCodexTask({
      mode: 'resume',
      sessionId: runRes.sessionId,
      prompt: 'Add unit tests',
      cwd: dir,
      settings,
      dataDir: dir
    });
    assert.equal(resumeRes.ok, true);
    assert.equal(resumeRes.sessionId, 'sess-stub-42');
    assert.equal(JSON.parse(resumeRes.message).mode, 'resume');

    const reviewRes = await runCodexTask({
      mode: 'review',
      cwd: dir,
      prompt: 'Review parsing and error handling',
      sandbox: 'danger-full-access',
      settings,
      dataDir: dir
    });
    assert.equal(reviewRes.ok, true);
    const reviewPayload = JSON.parse(reviewRes.message);
    assert.equal(reviewPayload.mode, 'review');
    assert.equal(reviewPayload.args.includes('sandbox_mode="read-only"'), true);
    assert.equal(reviewPayload.prompt, 'Review parsing and error handling');
    assert.equal(reviewPayload.args.includes('--uncommitted'), false);

    const historyFile = join(dir, 'codex-runs.json');
    assert.equal(existsSync(historyFile), true);
    const history = JSON.parse(readFileSync(historyFile, 'utf8'));
    assert.equal(history.length, 3);
    assert.equal(history[0].mode, 'review');
    assert.equal(history[0].sandbox, 'read-only');

    const disabledRes = await runCodexTask({
      mode: 'run',
      prompt: 'Should fail',
      cwd: dir,
      settings: { ...settings, codexEnabled: false },
      dataDir: dir
    });
    assert.equal(disabledRes.ok, false);
    assert.match(disabledRes.error, /disabled/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCodexTask handles early stdin closure without losing the child error', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-codex-early-exit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await runCodexTask({
    prompt: 'x'.repeat(1024 * 1024),
    model: 'exit-early',
    cwd: dir,
    settings: { codexPath: makeStubCodex(dir) },
    dataDir: dir
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 42);
  assert.match(result.error, /fixture exited early/);
});

function startMcp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-codex-mcp-'));
  const child = spawn(process.execPath, [resolve('scripts/codex-mcp.mjs')], {
    env: { ...process.env, HOME: dir, USERPROFILE: dir, CODEX_HOME: join(dir, '.codex'), CODEX_BIN: makeStubCodex(dir) },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  t.after(async () => {
    child.stdin.end();
    await closed;
    rmSync(dir, { recursive: true, force: true });
  });
  const responses = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const response = JSON.parse(buffer.slice(0, index));
      responses.set(response.id, response);
      buffer = buffer.slice(index + 1);
    }
  });
  child.stderr.resume();
  return {
    dir, child, responses, closed,
    send: message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  };
}

async function waitFor(check, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await delay(20);
  }
  assert.fail('Timed out waiting for ' + description);
}

function processExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
    return true;
  }
}

test('codex-mcp.mjs serves JSON-RPC tools and is included in the package', async t => {
  const bundle = collectPackage(resolve('.'));
  const paths = new Set(bundle.files.map(file => file.path));
  for (const path of ['mcp_config.json', 'scripts/codex-mcp.mjs', 'lib/codex-bridge.mjs', 'skills/codex-cli/SKILL.md']) {
    assert.equal(paths.has(path), true, path);
  }

  const { dir, responses, send } = startMcp(t);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  send({ id: 3, method: 'tools/call', params: { name: 'codex_doctor', arguments: {} } });
  const doctor = await waitFor(() => responses.get(3), 'codex_doctor');
  assert.equal(responses.get(1).result.serverInfo.name, 'agy-codex');
  assert.deepEqual(responses.get(2).result.tools.map(tool => tool.name), ['codex_doctor', 'codex_run', 'codex_resume', 'codex_review']);
  assert.equal(doctor.result.isError, false);
  const health = JSON.parse(doctor.result.content[0].text);
  assert.equal(health.found, true);
  assert.equal(health.version, 'codex-cli 0.171.0-stub');
  assert.equal(health.codexHome, join(dir, '.codex'));

  for (const [id, mode] of [[4, 'run'], [5, 'resume'], [6, 'review']]) {
    const args = { cwd: dir, prompt: 'Test tool arguments' };
    if (mode === 'resume') args.sessionId = 'sess-stub-42';
    send({ id, method: 'tools/call', params: { name: 'codex_' + mode, arguments: args } });
    const { result } = await waitFor(() => responses.get(id), mode);
    assert.equal(result.isError, false, result.content[0].text);
    const payload = JSON.parse(JSON.parse(result.content[0].text).message);
    assert.equal(payload.mode, mode);
    assert.equal(payload.prompt, args.prompt);

    const invalidArgs = { ...args, settings: { codexEnabled: false } };
    send({ id: id + 3, method: 'tools/call', params: { name: 'codex_' + mode, arguments: invalidArgs } });
    const { error } = await waitFor(() => responses.get(id + 3), mode + ' argument rejection');
    assert.equal(error?.code, -32602);
  }
});

test('codex-mcp.mjs terminates active Codex children on cancellation and stdin EOF', async t => {
  const { dir, child, closed, responses, send } = startMcp(t);
  for (const [id, name] of [[1, 'cancel'], [2, 'eof']]) {
    send({ id, method: 'tools/call', params: { name: 'codex_run', arguments: { cwd: dir, prompt: 'hold:' + name } } });
  }
  const waitForPid = name => {
    const marker = join(dir, name + '.pid');
    return waitFor(() => existsSync(marker) && Number(readFileSync(marker, 'utf8')), name + ' fixture to start');
  };
  const cancelledPid = await waitForPid('cancel');
  const eofPid = await waitForPid('eof');

  send({ method: 'notifications/cancelled', params: { requestId: 1 } });
  await waitFor(() => processExited(cancelledPid), 'cancelled fixture to exit');
  assert.equal(processExited(eofPid), false);
  send({ id: 3, method: 'ping' });
  await waitFor(() => responses.get(3), 'ping after cancellation');
  assert.equal(responses.has(1), false);

  child.stdin.end();
  await waitFor(() => processExited(eofPid), 'fixture to exit after EOF');
  assert.deepEqual(await closed, [0, null]);
  assert.equal(responses.has(2), false);
});
