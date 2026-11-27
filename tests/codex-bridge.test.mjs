import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildCodexArgs,
  buildCodexEnv,
  inspectCodexHealth,
  parseCodexJsonl,
  resolveCodexBinary,
  runCodexTask
} from '../lib/codex-bridge.mjs';
import { collectPackage } from '../lib/package.mjs';

function makeStubCodex(dir) {
  const stubPath = join(dir, 'codex-stub.mjs');
  writeFileSync(stubPath, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli 0.171.0-stub');
  process.exit(0);
}
const prompt = readFileSync(0, 'utf8').trim();
const outIdx = args.indexOf('-o');
const outFile = outIdx >= 0 ? args[outIdx + 1] : '';
const isResume = args[1] === 'resume';
const isReview = args[1] === 'review';
const sessionId = isResume ? args[2] : 'sess-stub-42';
console.log(JSON.stringify({ type: 'thread.started', thread_id: sessionId }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'lib/example.mjs', kind: 'update' }] } }));
const reply = JSON.stringify({ mode: isReview ? 'review' : isResume ? 'resume' : 'run', args, prompt, proxy: process.env.HTTPS_PROXY || '' });
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reply } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 30 } }));
if (outFile) writeFileSync(outFile, reply, 'utf8');
`, 'utf8');
  chmodSync(stubPath, 0o755);
  return stubPath;
}

test('buildCodexArgs builds exact flags for run, resume, and review modes', () => {
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
  assert.deepEqual(resumeArgs, ['exec', 'resume', 'sess-123', '--json', '-o', '/tmp/out.txt', '-']);

  const reviewArgs = buildCodexArgs({
    mode: 'review',
    base: 'main',
    model: 'gpt-5-codex',
    hasPrompt: false
  });
  assert.deepEqual(reviewArgs, ['exec', 'review', '--base', 'main', '-m', 'gpt-5-codex', '--json']);
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
  const dir = mkdtempSync(join(tmpdir(), 'agy-codex-test-'));
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

    const runRes = await runCodexTask({
      mode: 'run',
      prompt: 'Implement feature X',
      cwd: dir,
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
      uncommitted: true,
      settings,
      dataDir: dir
    });
    assert.equal(reviewRes.ok, true);
    assert.equal(JSON.parse(reviewRes.message).mode, 'review');

    const historyFile = join(dir, 'codex-runs.json');
    assert.equal(existsSync(historyFile), true);
    const history = JSON.parse(readFileSync(historyFile, 'utf8'));
    assert.equal(history.length, 3);
    assert.equal(history[0].mode, 'review');

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

test('codex-mcp.mjs speaks Stdio JSON-RPC 2.0 (initialize, tools/list, tools/call) and is included in package', async () => {
  const bundle = collectPackage(resolve('.'));
  const paths = new Set(bundle.files.map(f => f.path));
  assert.equal(paths.has('mcp_config.json'), true);
  assert.equal(paths.has('scripts/codex-mcp.mjs'), true);
  assert.equal(paths.has('lib/codex-bridge.mjs'), true);
  assert.equal(paths.has('skills/codex-cli/SKILL.md'), true);

  const dir = mkdtempSync(join(tmpdir(), 'agy-codex-mcp-'));
  try {
    const stub = makeStubCodex(dir);
    const child = spawn(process.execPath, [resolve('scripts/codex-mcp.mjs')], {
      env: { ...process.env, CODEX_BIN: stub },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const responses = [];
    let buf = '';
    const waitForCount = count => new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`Timeout waiting for ${count} MCP responses; got ${responses.length}`)), 5000);
      const check = () => {
        if (responses.length >= count) { clearTimeout(timer); res(); }
      };
      child.stdout.on('data', chunk => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) responses.push(JSON.parse(line));
        }
        check();
      });
      check();
    });

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'codex_doctor', arguments: {} } }) + '\n');
    child.stdin.end();

    await waitForCount(3);
    const initMsg = responses.find(r => r.id === 1);
    const listMsg = responses.find(r => r.id === 2);
    const docMsg = responses.find(r => r.id === 3);
    assert.equal(initMsg.result.serverInfo.name, 'agy-codex');
    assert.deepEqual(listMsg.result.tools.map(t => t.name), ['codex_doctor', 'codex_run', 'codex_resume', 'codex_review']);
    assert.equal(docMsg.result.isError, false);
    const doctorPayload = JSON.parse(docMsg.result.content[0].text);
    assert.equal(doctorPayload.found, true);
    assert.equal(doctorPayload.version, 'codex-cli 0.171.0-stub');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
