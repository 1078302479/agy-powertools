import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  validateRelaunchJob,
  parseTasklistPids,
  parseCredentialWriterEntries,
  parseCredentialWriterPids,
  listWindowsImagePids,
  listWindowsCredentialWriters,
  verifiedSwitchProfileDir,
  buildCleanTargetEnv,
  runRelaunchJob
} from '../scripts/relaunch-worker.mjs';
import {
  configureLaunchers,
  inspectWindowsShortcutBytes,
  waitForRelaunchAck,
  recordRelaunchBlocked,
  verifyRelaunchStarted,
  maybeAutoRelaunchProxy,
  recordProxyReady,
  recordDebugPortReady
} from '../lib/launcher.mjs';

test('validateRelaunchJob enforces strict allowlists to prevent LOLBin abuse', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-worker-validate-'));
  try {
    const jobDir = join(root, 'data');
    mkdirSync(jobDir, { recursive: true });
    const target = join(root, 'Antigravity.exe');
    const badExe = join(root, 'cmd.exe');
    writeFileSync(target, '');
    writeFileSync(badExe, '');
    const jobPath = join(jobDir, 'relaunch-job.json');
    const ackPath = join(jobDir, 'relaunch-ack.json');
    const logPath = join(jobDir, 'relaunch-antigravity.log');
    const now = 1_750_000_000_000;

    const validJob = {
      format: 1,
      nonce: '01234567-89ab-cdef-0123-456789abcdef',
      requestedAt: now - 1000,
      target,
      args: [
        '--remote-debugging-port=0',
        '--proxy-server=socks5://127.0.0.1:7897',
        '--proxy-bypass-list=localhost;127.0.0.1;[::1];192.168.0.0/16'
      ],
      proxyEnabled: true,
      forceHttp1: true,
      proxyEnv: {
        HTTP_PROXY: 'socks5h://user:p%40ss@127.0.0.1:7897',
        HTTPS_PROXY: 'socks5h://user:p%40ss@127.0.0.1:7897',
        NO_PROXY: 'localhost,127.0.0.1,::1,192.168.0.0/16',
        AGY_POWERTOOLS_PROXY_SPEC: 'socks5h://user:p%40ss@127.0.0.1:7897|localhost,127.0.0.1,::1|h1',
        GODEBUG: 'http2client=0'
      },
      onboardingSync: {
        email: 'alice@example.com',
        isGcpTos: true,
        appStoragePath: join(root, 'app_storage.json')
      },
      ackPath,
      logPath
    };

    assert.equal(validateRelaunchJob(validJob, { jobPath, now: () => now }).valid, true);

    // Reject bad format & nonce
    assert.equal(validateRelaunchJob({ ...validJob, format: 2 }, { jobPath, now: () => now }).valid, false);
    assert.equal(validateRelaunchJob({ ...validJob, nonce: 'too-short' }, { jobPath, now: () => now }).valid, false);
    assert.equal(validateRelaunchJob({ ...validJob, nonce: '0123456789abcdef;calc' }, { jobPath, now: () => now }).valid, false);

    // Reject expired or far-future requestedAt (> 60s TTL)
    assert.equal(validateRelaunchJob({ ...validJob, requestedAt: now - 61_000 }, { jobPath, now: () => now }).reason, 'expired-job');
    assert.equal(validateRelaunchJob({ ...validJob, requestedAt: now + 61_000 }, { jobPath, now: () => now }).reason, 'expired-job');

    // Reject non-Antigravity.exe targets and missing targets (even if JSON attempts to inject allowAnyTargetForTest)
    assert.equal(validateRelaunchJob({ ...validJob, target: badExe, allowAnyTargetForTest: true }, { jobPath, now: () => now }).reason, 'disallowed-target');
    assert.equal(validateRelaunchJob({ ...validJob, target: join(root, 'missing', 'Antigravity.exe') }, { jobPath, now: () => now }).reason, 'target-not-found');

    // Reject disallowed args & shell injection attempts
    for (const badArg of [
      '--remote-debugging-port=9222',
      '--eval=process.exit()',
      '--proxy-server=http://127.0.0.1:8080;calc.exe',
      '--proxy-bypass-list=localhost&calc',
      '-c'
    ]) {
      assert.equal(validateRelaunchJob({ ...validJob, args: [badArg] }, { jobPath, now: () => now }).reason, 'disallowed-arg');
    }

    // Reject disallowed env vars and non-allowlisted GODEBUG values
    assert.equal(validateRelaunchJob({ ...validJob, proxyEnv: { PATH: 'C:\\evil' } }, { jobPath, now: () => now }).reason, 'disallowed-env-key');
    assert.equal(validateRelaunchJob({ ...validJob, proxyEnv: { NODE_OPTIONS: '--require=x' } }, { jobPath, now: () => now }).reason, 'disallowed-env-key');
    assert.equal(validateRelaunchJob({ ...validJob, proxyEnv: { GODEBUG: 'gctrace=1' } }, { jobPath, now: () => now }).reason, 'disallowed-godebug');

    // Reject path-traversal ackPath / logPath and non-app_storage.json onboardingSync
    assert.equal(validateRelaunchJob({ ...validJob, ackPath: join(root, 'escape-ack.json') }, { jobPath, now: () => now }).reason, 'ack-path-traversal');
    assert.equal(validateRelaunchJob({ ...validJob, ackPath: join(jobDir, '..', 'escape.json') }, { jobPath, now: () => now }).reason, 'ack-path-traversal');
    assert.equal(validateRelaunchJob({ ...validJob, logPath: join(root, 'escape.log') }, { jobPath, now: () => now }).reason, 'log-path-traversal');
    assert.equal(validateRelaunchJob({
      ...validJob,
      onboardingSync: { email: 'alice@example.com', isGcpTos: true, appStoragePath: join(root, 'other.json') }
    }, { jobPath, now: () => now }).reason, 'invalid-onboarding-storage');

    // Accept valid credentialSwitch & clearScopePath and reject unsafe/secret variants (Issue #97)
    assert.equal(validateRelaunchJob({
      ...validJob,
      credentialSwitch: { accountId: 'acct-123_ab', expectedEmail: 'bob@example.com' },
      clearScopePath: join(root, 'Antigravity', 'credential-user-scope')
    }, { jobPath, now: () => now }).valid, true);
    assert.equal(validateRelaunchJob({
      ...validJob,
      credentialSwitch: { accountId: '../evil', expectedEmail: 'bob@example.com' }
    }, { jobPath, now: () => now }).reason, 'invalid-credential-switch-account');
    assert.equal(validateRelaunchJob({
      ...validJob,
      credentialSwitch: { accountId: 'acct-1', expectedEmail: 'not-an-email' }
    }, { jobPath, now: () => now }).reason, 'invalid-credential-switch-email');
    assert.equal(validateRelaunchJob({
      ...validJob,
      credentialSwitch: { accountId: 'acct-1', expectedEmail: 'bob@example.com', refreshToken: 'secret' }
    }, { jobPath, now: () => now }).reason, 'invalid-credential-switch');
    assert.equal(validateRelaunchJob({
      ...validJob,
      clearScopePath: join(root, 'other-file')
    }, { jobPath, now: () => now }).reason, 'invalid-clear-scope-path');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseTasklistPids excludes self/parent PIDs, buildCleanTargetEnv scrubs runtime vars, and runRelaunchJob escalates lingering PIDs safely', async () => {
  const sampleCsv = [
    `"Antigravity.exe","${process.pid}","Console","1","120,000 K"`,
    `"Antigravity.exe","${process.ppid}","Console","1","80,000 K"`,
    '"Antigravity.exe","41001","Console","1","220,000 K"',
    '"Antigravity.exe","41002","Console","1","90,000 K"',
    '"node.exe","41003","Console","1","40,000 K"',
    'INFO: No tasks are running which match the specified criteria.'
  ].join('\r\n');
  const parsed = parseTasklistPids(sampleCsv, { excludePids: new Set([process.pid, process.ppid]) });
  assert.deepEqual(parsed, [41001, 41002]);
  assert.deepEqual(parseTasklistPids('信息: 没有运行的任务匹配指定标准。'), []);

  // Env scrubbing + proxy apply/clear/preserve semantics
  const dirtyBase = {
    PATH: 'C:\\Windows',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--inspect',
    ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1234',
    ANTIGRAVITY_CSRF_TOKEN: 'tok',
    ANTIGRAVITY_AGENTAPI_EXE: 'C:\\ls.exe',
    ANTIGRAVITY_SIDECAR_TOKEN: 'secret',
    HTTP_PROXY: 'http://corp:8080',
    GODEBUG: 'http2client=0'
  };
  const withProxy = buildCleanTargetEnv(dirtyBase, {
    proxyEnabled: true,
    forceHttp1: false,
    proxyEnv: { HTTP_PROXY: 'http://127.0.0.1:7897', AGY_POWERTOOLS_PROXY_SPEC: 'spec' }
  });
  assert.equal(withProxy.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(withProxy.NODE_OPTIONS, undefined);
  assert.equal(withProxy.ANTIGRAVITY_LS_ADDRESS, undefined);
  assert.equal(withProxy.ANTIGRAVITY_SIDECAR_TOKEN, undefined);
  assert.equal(withProxy.HTTP_PROXY, 'http://127.0.0.1:7897');
  assert.equal(withProxy.GODEBUG, undefined);

  // Disabled proxy clears plugin-managed proxy vars when AGY_POWERTOOLS_PROXY_SPEC is present
  const cleared = buildCleanTargetEnv({ ...dirtyBase, AGY_POWERTOOLS_PROXY_SPEC: 'spec' }, { proxyEnabled: false });
  assert.equal(cleared.HTTP_PROXY, undefined);
  assert.equal(cleared.AGY_POWERTOOLS_PROXY_SPEC, undefined);
  assert.equal(cleared.GODEBUG, undefined);

  // Disabled proxy preserves user's own system proxy when AGY_POWERTOOLS_PROXY_SPEC is absent
  const preserved = buildCleanTargetEnv(dirtyBase, { proxyEnabled: false });
  assert.equal(preserved.HTTP_PROXY, 'http://corp:8080');

  // Escalation test: self/ppid excluded, lingering PID escalated from gracefulClosePid to forceKillPid
  const root = mkdtempSync(join(tmpdir(), 'agy-worker-kill-'));
  try {
    const target = join(root, 'Antigravity.exe');
    writeFileSync(target, '');
    const jobPath = join(root, 'relaunch-job.json');
    const ackPath = join(root, 'relaunch-ack.json');
    const logPath = join(root, 'relaunch-antigravity.log');
    const nonce = '11111111-2222-3333-4444-555555555555';
    writeFileSync(jobPath, JSON.stringify({
      format: 1,
      nonce,
      requestedAt: Date.now(),
      target,
      args: ['--remote-debugging-port=0'],
      proxyEnabled: false,
      forceHttp1: false,
      proxyEnv: null,
      onboardingSync: null,
      ackPath,
      logPath
    }));

    let phase = 'initial';
    const gracefulCalls = [];
    const forceCalls = [];
    const spawnedCalls = [];
    const res = await runRelaunchJob(jobPath, {
      listTargetPids: () => {
        if (phase === 'initial') return [process.pid, process.ppid, 55001, 55002];
        if (phase === 'after-graceful') return [process.pid, 55002];
        if (phase === 'after-force') return [process.pid];
        return [55999];
      },
      gracefulClosePid: pid => {
        gracefulCalls.push(pid);
        phase = 'after-graceful';
      },
      forceKillPid: pid => {
        forceCalls.push(pid);
        phase = 'after-force';
      },
      spawnProcess: (cmd, args, opts) => {
        spawnedCalls.push({ cmd, args, opts });
        phase = 'spawned';
        return { pid: process.pid, on() {}, unref() {} };
      },
      settleMs: 10,
      gracefulTimeoutMs: 60,
      forceTimeoutMs: 60,
      postExitSettleMs: 10,
      verifyDelayMs: 10,
      pollMs: 15
    });

    assert.equal(res.ok, true);
    assert.deepEqual(gracefulCalls, [55001, 55002]);
    assert.deepEqual(forceCalls, [55002]);
    assert.equal(spawnedCalls.length, 1);
    assert.equal(spawnedCalls[0].opts.detached, true);
    assert.equal(spawnedCalls[0].opts.stdio, 'ignore');
    assert.equal(spawnedCalls[0].opts.windowsHide, false);
    assert.equal(existsSync(jobPath), false);
    const ack = JSON.parse(readFileSync(ackPath, 'utf8'));
    assert.equal(ack.nonce, nonce);
    assert.equal(ack.state, 'launched');
    assert.equal(ack.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('live Windows relaunch-worker spawns detached target with zero ConPTY leak, verbatim proxy args, env scrubbing, atomic onboarding sync, and intact static scripts', { skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-worker-live-win-'));
  let detachedPid = null;
  try {
    const workerFile = resolve('scripts/relaunch-worker.mjs');
    const cmdFile = resolve('scripts/relaunch-antigravity.cmd');
    assert.equal(existsSync(workerFile), true);
    assert.equal(existsSync(cmdFile), true);

    // Verify static .cmd has zero PowerShell and zero hidden/bypass flags
    const cmdContent = readFileSync(cmdFile, 'utf8');
    assert.equal(/powershell/i.test(cmdContent), false);
    assert.equal(/WindowStyle|ExecutionPolicy|WScript\.Shell/i.test(cmdContent), false);
    assert.ok(cmdContent.includes('relaunch-worker.mjs'));

    const jobDir = join(root, 'data');
    mkdirSync(jobDir, { recursive: true });
    const appStoragePath = join(root, 'app_storage.json');
    writeFileSync(appStoragePath, JSON.stringify({
      'agy.onboarding.lastLoginUsername': 'old@example.com',
      'agy.onboarding.lastLoginIsGcpTos': 'false',
      unrelated: 42
    }), 'utf8');

    const reportPath = join(root, 'target-report.json');
    const fakeTargetScript = join(root, 'fake-target.cjs');
    writeFileSync(fakeTargetScript, [
      "const fs = require('fs');",
      "console.log('SHOULD_NOT_LEAK_TO_PARENT');",
      `fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({`,
      "  pid: process.pid,",
      "  ppid: process.ppid,",
      "  argv: process.argv.slice(2),",
      "  httpProxy: process.env.HTTP_PROXY || null,",
      "  httpsProxy: process.env.HTTPS_PROXY || null,",
      "  noProxy: process.env.NO_PROXY || null,",
      "  godebug: process.env.GODEBUG || null,",
      "  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE || null,",
      "  nodeOptions: process.env.NODE_OPTIONS || null,",
      "  sidecarToken: process.env.ANTIGRAVITY_SIDECAR_TOKEN || null",
      "}));",
      "setTimeout(() => {}, 2500);"
    ].join('\n'), 'utf8');

    const jobPath = join(jobDir, 'relaunch-job.json');
    const ackPath = join(jobDir, 'relaunch-ack.json');
    const logPath = join(jobDir, 'relaunch-antigravity.log');
    const nonce = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    writeFileSync(jobPath, JSON.stringify({
      format: 1,
      nonce,
      requestedAt: Date.now(),
      target: process.execPath,
      args: [
        '--remote-debugging-port=0',
        '--proxy-server=http://127.0.0.1:7897',
        '--proxy-bypass-list=localhost;127.0.0.1;[::1];192.168.0.0/16'
      ],
      proxyEnabled: true,
      forceHttp1: true,
      proxyEnv: {
        HTTP_PROXY: 'http://user:p%40ss@127.0.0.1:7897',
        HTTPS_PROXY: 'http://user:p%40ss@127.0.0.1:7897',
        ALL_PROXY: 'http://user:p%40ss@127.0.0.1:7897',
        http_proxy: 'http://user:p%40ss@127.0.0.1:7897',
        https_proxy: 'http://user:p%40ss@127.0.0.1:7897',
        all_proxy: 'http://user:p%40ss@127.0.0.1:7897',
        NO_PROXY: 'localhost,127.0.0.1,::1,192.168.0.0/16',
        no_proxy: 'localhost,127.0.0.1,::1,192.168.0.0/16',
        AGY_POWERTOOLS_PROXY_SPEC: 'http://user:p%40ss@127.0.0.1:7897|localhost,127.0.0.1,::1,192.168.0.0/16|h1',
        GODEBUG: 'http2client=0'
      },
      onboardingSync: {
        email: 'bob@example.com',
        isGcpTos: true,
        appStoragePath
      },
      ackPath,
      logPath
    }), 'utf8');

    const runnerScript = join(root, 'run-worker.mjs');
    writeFileSync(runnerScript, [
      `import { runRelaunchJob } from ${JSON.stringify(pathToFileURL(workerFile).href)};`,
      `const res = await runRelaunchJob(${JSON.stringify(jobPath)}, {`,
      '  allowAnyTargetForTest: true,',
      `  leadingArgsForTest: [${JSON.stringify(fakeTargetScript)}],`,
      '  listTargetPids: () => [],',
      '  settleMs: 60,',
      '  postExitSettleMs: 40,',
      '  verifyDelayMs: 250',
      '});',
      'if (!res.ok) process.exit(1);'
    ].join('\n'), 'utf8');

    const live = await new Promise((resolvePromise, rejectPromise) => {
      const t0 = Date.now();
      const child = spawn(process.execPath, [runnerScript], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ANTIGRAVITY_SIDECAR_TOKEN: 'must-be-scrubbed'
        }
      });
      let out = '', err = '', exitedAt = 0;
      child.stdout.on('data', chunk => { out += chunk.toString(); });
      child.stderr.on('data', chunk => { err += chunk.toString(); });
      child.on('error', rejectPromise);
      child.on('exit', () => { exitedAt = Date.now() - t0; });
      child.on('close', code => resolvePromise({ code, exitedAt, closedAt: Date.now() - t0, out, err }));
    });

    assert.equal(live.code, 0, `worker failed: ${live.err}`);
    assert.equal(live.out.includes('SHOULD_NOT_LEAK_TO_PARENT'), false);
    assert.ok(live.closedAt - live.exitedAt < 400, `Parent stdout pipe stayed open ${live.closedAt - live.exitedAt}ms after worker exit`);

    for (let i = 0; i < 30 && !existsSync(reportPath); i++) {
      await new Promise(r => setTimeout(r, 80));
    }
    assert.equal(existsSync(reportPath), true);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    detachedPid = report.pid;

    assert.deepEqual(report.argv, [
      '--remote-debugging-port=0',
      '--proxy-server=http://127.0.0.1:7897',
      '--proxy-bypass-list=localhost;127.0.0.1;[::1];192.168.0.0/16'
    ]);
    assert.equal(report.httpProxy, 'http://user:p%40ss@127.0.0.1:7897');
    assert.equal(report.httpsProxy, 'http://user:p%40ss@127.0.0.1:7897');
    assert.equal(report.noProxy, 'localhost,127.0.0.1,::1,192.168.0.0/16');
    assert.equal(report.godebug, 'http2client=0');
    assert.equal(report.electronRunAsNode, null);
    assert.equal(report.nodeOptions, null);
    assert.equal(report.sidecarToken, null);

    // Atomic app_storage.json onboarding sync succeeded
    const syncedStorage = JSON.parse(readFileSync(appStoragePath, 'utf8'));
    assert.equal(syncedStorage['agy.onboarding.lastLoginUsername'], 'bob@example.com');
    assert.equal(syncedStorage['agy.onboarding.lastLoginIsGcpTos'], 'true');
    assert.equal(syncedStorage.unrelated, 42);

    // ACK JSON valid & job JSON cleaned while static scripts stay intact
    const ack = JSON.parse(readFileSync(ackPath, 'utf8'));
    assert.equal(ack.nonce, nonce);
    assert.equal(ack.state, 'launched');
    assert.equal(ack.ok, true);
    assert.equal(ack.childPid, report.pid);
    assert.equal(existsSync(jobPath), false);
    assert.equal(existsSync(workerFile), true);
    assert.equal(existsSync(cmdFile), true);
  } finally {
    if (detachedPid) {
      try { process.kill(detachedPid); } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifyRelaunchStarted confirms valid ACK, fails closed on timeout with lastRelaunchBlockedAt, and pauses auto-relaunch until cleared', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-ack-verify-'));
  try {
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const ackPath = join(dataDir, 'relaunch-ack.json');
    const jobPath = join(dataDir, 'relaunch-job.json');
    const nonce = 'abcdef01-2345-6789-abcd-ef0123456789';

    // 1. Confirmed when ACK appears asynchronously with matching nonce
    writeFileSync(jobPath, '{"format":1}');
    setTimeout(() => {
      writeFileSync(ackPath, JSON.stringify({ nonce, pid: 99123, state: 'ready', at: Date.now() }));
    }, 40);
    const okRes = await verifyRelaunchStarted(
      { scheduled: true, jobPath, ackPath, nonce, target: 'C:\\Antigravity.exe' },
      { dataDir, timeoutMs: 800, pollIntervalMs: 25 }
    );
    assert.equal(okRes.scheduled, true);
    assert.equal(okRes.confirmed, true);
    assert.equal(okRes.manualRestartRequired, false);
    assert.equal(okRes.workerPid, 99123);

    // 2. Mismatched nonce or missing ACK times out -> deletes stale job JSON, clears lastRelaunchAt, records lastRelaunchBlockedAt, returns manualRestartRequired
    writeFileSync(join(dataDir, 'relaunch-state.json'), JSON.stringify({ lastRelaunchAt: 1_759_999_999_000 }));
    writeFileSync(jobPath, '{"format":1}');
    writeFileSync(ackPath, JSON.stringify({ nonce: 'wrong-nonce-value-1234', pid: 111 }));
    const blockedNow = 1_760_000_000_000;
    const blockedRes = await verifyRelaunchStarted(
      { scheduled: true, jobPath, ackPath, nonce, target: 'C:\\Antigravity.exe' },
      { dataDir, timeoutMs: 90, pollIntervalMs: 20, now: blockedNow }
    );
    assert.equal(blockedRes.scheduled, false);
    assert.equal(blockedRes.confirmed, false);
    assert.equal(blockedRes.manualRestartRequired, true);
    assert.equal(blockedRes.reason, 'relaunch-blocked');
    assert.equal(existsSync(jobPath), false);
    const savedState = JSON.parse(readFileSync(join(dataDir, 'relaunch-state.json'), 'utf8'));
    assert.equal(savedState.lastRelaunchBlockedAt, blockedNow);
    assert.equal(savedState.lastRelaunchAt, 0);

    // 3. maybeAutoRelaunchProxy respects lastRelaunchBlockedAt for 24h and resumes once cleared by recordProxyReady / recordDebugPortReady
    const fakeExe = join(root, 'Programs', 'antigravity', 'Antigravity.exe');
    mkdirSync(join(root, 'Programs', 'antigravity'), { recursive: true });
    writeFileSync(fakeExe, '');
    const env = { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:42001', LOCALAPPDATA: root };
    let relaunchCalls = 0;
    const skipped = await maybeAutoRelaunchProxy({
      dataDir,
      home: root,
      platform: 'win32',
      env,
      enabled: true,
      proxyEnabled: true,
      proxyUrl: 'http://127.0.0.1:7897',
      runtimeProxyReason: 'not-applied',
      now: blockedNow + 3600_000,
      checkPort: async () => ({ ok: true }),
      relaunch: () => { relaunchCalls++; return { scheduled: true }; }
    });
    assert.equal(skipped.relaunched, false);
    assert.equal(skipped.reason, 'relaunch-blocked');
    assert.equal(relaunchCalls, 0);

    // recordProxyReady clears lastRelaunchBlockedAt
    recordProxyReady({ dataDir });
    const afterReady = await maybeAutoRelaunchProxy({
      dataDir,
      home: root,
      platform: 'win32',
      env,
      enabled: true,
      proxyEnabled: true,
      proxyUrl: 'http://127.0.0.1:7897',
      runtimeProxyReason: 'not-applied',
      now: blockedNow + 3700_000,
      checkPort: async () => ({ ok: true }),
      relaunch: () => { relaunchCalls++; return { scheduled: true }; }
    });
    assert.equal(afterReady.relaunched, true);
    assert.equal(relaunchCalls, 1);

    // recordDebugPortReady also clears lastRelaunchBlockedAt
    recordRelaunchBlocked({ dataDir, now: blockedNow + 4000_000 });
    recordDebugPortReady({ dataDir });
    const clearedState = JSON.parse(readFileSync(join(dataDir, 'relaunch-state.json'), 'utf8'));
    assert.equal(clearedState.lastRelaunchBlockedAt, 0);

    // Direct waitForRelaunchAck returns null immediately when inputs missing
    assert.equal(await waitForRelaunchAck({}), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pure-Node .lnk pre-filter skips PowerShell completely for already-patched or unrelated shortcuts', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-lnk-prefilter-'));
  try {
    const home = join(root, 'home');
    const dataDir = join(root, 'data');
    const desktop = join(home, 'Desktop');
    mkdirSync(desktop, { recursive: true });

    // 1. Unrelated app shortcut + already-patched Antigravity shortcuts (UTF-16LE even-aligned, odd-aligned, and ASCII)
    const otherLnk = join(desktop, 'OtherApp.lnk');
    const patchedEvenLnk = join(desktop, 'Antigravity.lnk');
    const patchedOddLnk = join(desktop, 'CustomName.lnk');
    writeFileSync(otherLnk, Buffer.from('C:\\Program Files\\Other\\Other.exe', 'utf16le'));
    writeFileSync(patchedEvenLnk, Buffer.concat([
      Buffer.from('L\0\0\0', 'latin1'),
      Buffer.from('C:\\Apps\\Antigravity.exe', 'utf16le'),
      Buffer.from(' --remote-debugging-port=0', 'utf16le')
    ]));
    // Single-byte prefix forces odd byte alignment for UTF-16LE tokens
    writeFileSync(patchedOddLnk, Buffer.concat([
      Buffer.from([0x4c]),
      Buffer.from('C:\\Apps\\Antigravity.exe', 'utf16le'),
      Buffer.from('--remote-debugging-port=9222', 'utf16le')
    ]));

    assert.equal(inspectWindowsShortcutBytes(otherLnk).isAntigravity, false);
    assert.equal(inspectWindowsShortcutBytes(patchedEvenLnk).isAntigravity, true);
    assert.equal(inspectWindowsShortcutBytes(patchedEvenLnk).hasDebugFlag, true);
    assert.equal(inspectWindowsShortcutBytes(patchedOddLnk).isAntigravity, true);
    assert.equal(inspectWindowsShortcutBytes(patchedOddLnk).hasDebugFlag, true);

    const psCalls = [];
    const res1 = configureLaunchers({
      home,
      dataDir,
      platform: 'win32',
      sandbox: true,
      runPowerShell(script, psEnv) {
        psCalls.push({ script, list: JSON.parse(psEnv.AGY_LNK_LIST || '[]') });
        return '[]';
      }
    });
    assert.deepEqual(res1.updated, []);
    assert.equal(psCalls.length, 0);

    // 2. Add one unpatched Antigravity shortcut (renamed, detected by target bytes) -> ONLY that shortcut is sent to PowerShell
    const unpatchedLnk = join(desktop, 'MyEditor.lnk');
    writeFileSync(unpatchedLnk, Buffer.from('C:\\Apps\\Antigravity.exe', 'utf16le'));
    const res2 = configureLaunchers({
      home,
      dataDir,
      platform: 'win32',
      sandbox: true,
      runPowerShell(script, psEnv) {
        const list = JSON.parse(psEnv.AGY_LNK_LIST || '[]');
        psCalls.push({ script, list });
        return JSON.stringify(list);
      }
    });
    assert.equal(psCalls.length, 1);
    assert.deepEqual(psCalls[0].list, [unpatchedLnk]);
    assert.deepEqual(res2.updated, [unpatchedLnk]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('relaunch-worker stops sibling language_server.exe, runs post-exit credentialSwitch & clearScopePath, and fails closed on elevated processes or restore failure (Issue #97)', async () => {
  const lsCsv = [
    '"language_server.exe","61001","Console","1","50,000 K"',
    '"Antigravity.exe","61002","Console","1","100,000 K"'
  ].join('\r\n');
  assert.deepEqual(parseTasklistPids(lsCsv, { imageNames: ['language_server.exe'] }), [61001]);

  // P1 #4: listWindowsImagePids scopes tasklist to current USERNAME and falls back only on non-zero/empty failure
  const tasklistCalls = [];
  const scopedPids = listWindowsImagePids('language_server.exe', {
    env: { USERNAME: 'Alice.Dev' },
    runCommand: (_cmd, args) => {
      tasklistCalls.push(args);
      return { status: 0, stdout: '"language_server.exe","62001","Console","1","40,000 K"\r\n' };
    }
  });
  assert.deepEqual(scopedPids, [62001]);
  assert.equal(tasklistCalls.length, 1);
  assert.ok(tasklistCalls[0].includes('USERNAME eq Alice.Dev'));

  const noMatchCalls = [];
  const noMatchPids = listWindowsImagePids('language_server.exe', {
    env: { USERNAME: 'Alice.Dev' },
    runCommand: (_cmd, args) => {
      noMatchCalls.push(args);
      return { status: 0, stdout: 'INFO: No tasks are running which match the specified criteria.\r\n' };
    }
  });
  assert.deepEqual(noMatchPids, []);
  assert.equal(noMatchCalls.length, 1, 'status=0 non-empty no-tasks output must NOT fall back to other users');

  const fallbackCalls = [];
  const fallbackPids = listWindowsImagePids('Antigravity.exe', {
    env: { USERNAME: 'Alice.Dev' },
    runCommand: (_cmd, args) => {
      fallbackCalls.push(args);
      if (args.includes('USERNAME eq Alice.Dev')) return { status: 1, stdout: '' };
      return { status: 0, stdout: '"Antigravity.exe","63001","Console","1","90,000 K"\r\n' };
    }
  });
  assert.deepEqual(fallbackPids, [63001]);
  assert.equal(fallbackCalls.length, 2);
  assert.equal(fallbackCalls[1].some(a => a.startsWith('USERNAME eq')), false);

  const root = mkdtempSync(join(tmpdir(), 'agy-worker-97-'));
  try {
    const target = join(root, 'Antigravity.exe');
    writeFileSync(target, '');

    // 1. Happy path: Antigravity.exe + language_server.exe exit -> credentialSwitch runs -> clearScopePath deleted -> spawn
    const jobPath1 = join(root, 'job1.json');
    const ackPath1 = join(root, 'ack1.json');
    const logPath1 = join(root, 'log1.log');
    const scopePath1 = join(root, 'credential-user-scope');
    writeFileSync(scopePath1, 'stale-scope');
    const nonce1 = '12345678-1234-1234-1234-1234567890ab';
    writeFileSync(jobPath1, JSON.stringify({
      format: 1,
      nonce: nonce1,
      requestedAt: Date.now(),
      target,
      args: ['--remote-debugging-port=0'],
      proxyEnabled: false,
      forceHttp1: false,
      proxyEnv: null,
      onboardingSync: null,
      credentialSwitch: { accountId: 'acct-beta', expectedEmail: 'beta@example.com' },
      clearScopePath: scopePath1,
      ackPath: ackPath1,
      logPath: logPath1
    }));

    const events = [];
    let appAlive = true;
    let lsAlive = true;
    const res1 = await runRelaunchJob(jobPath1, {
      listTargetPids: () => (appAlive ? [71001] : []),
      listLanguageServerPids: () => (lsAlive ? [72001] : []),
      gracefulClosePid: pid => {
        events.push(`graceful:${pid}`);
        if (pid === 71001) appAlive = false;
      },
      forceKillPid: pid => {
        events.push(`force:${pid}`);
        if (pid === 72001) lsAlive = false;
      },
      restoreCredential: async cs => {
        assert.equal(appAlive, false, 'Antigravity.exe must exit before credentialSwitch');
        assert.equal(lsAlive, false, 'language_server.exe must exit before credentialSwitch');
        events.push(`restore:${cs.accountId}:${cs.expectedEmail}`);
        return { ok: true };
      },
      spawnProcess: () => {
        assert.equal(existsSync(scopePath1), false, 'credential-user-scope must be deleted before spawn');
        events.push('spawn');
        return { pid: process.pid, on() {}, unref() {} };
      },
      settleMs: 5,
      gracefulTimeoutMs: 40,
      forceTimeoutMs: 40,
      postExitSettleMs: 5,
      verifyDelayMs: 5,
      pollMs: 10
    });
    assert.equal(res1.ok, true);
    assert.deepEqual(events, [
      'graceful:71001',
      'graceful:72001',
      'force:72001',
      'restore:acct-beta:beta@example.com',
      'spawn'
    ]);
    assert.equal(existsSync(scopePath1), false);

    // 2a. Elevated / unkillable Antigravity.exe survives force kill -> fail closed with elevated-process-running
    const jobPath2 = join(root, 'job2.json');
    const ackPath2 = join(root, 'ack2.json');
    const scopePath2 = join(root, 'sub', 'credential-user-scope');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(scopePath2, 'keep-on-abort');
    const nonce2 = '22345678-1234-1234-1234-1234567890ab';
    writeFileSync(jobPath2, JSON.stringify({
      format: 1,
      nonce: nonce2,
      requestedAt: Date.now(),
      target,
      args: ['--remote-debugging-port=0'],
      proxyEnabled: false,
      forceHttp1: false,
      proxyEnv: null,
      onboardingSync: null,
      credentialSwitch: { accountId: 'acct-beta', expectedEmail: 'beta@example.com' },
      clearScopePath: scopePath2,
      ackPath: ackPath2
    }));

    let restoreCalled2 = 0;
    let spawnCalled2 = 0;
    const res2 = await runRelaunchJob(jobPath2, {
      listTargetPids: () => [79999],
      listLanguageServerPids: () => [],
      gracefulClosePid: () => {},
      forceKillPid: () => {},
      restoreCredential: async () => { restoreCalled2++; return { ok: true }; },
      spawnProcess: () => { spawnCalled2++; return { pid: process.pid, on() {}, unref() {} }; },
      settleMs: 5,
      gracefulTimeoutMs: 25,
      forceTimeoutMs: 25,
      postExitSettleMs: 5,
      verifyDelayMs: 5,
      pollMs: 10
    });
    assert.equal(res2.ok, false);
    assert.equal(res2.reason, 'elevated-process-running');
    assert.equal(restoreCalled2, 0);
    assert.equal(spawnCalled2, 0);
    assert.equal(existsSync(scopePath2), true);
    const ack2 = JSON.parse(readFileSync(ackPath2, 'utf8'));
    assert.equal(ack2.state, 'launched');
    assert.equal(ack2.ok, false);
    assert.equal(ack2.reason, 'elevated-process-running');

    // 2b. Antigravity.exe exited, only an elevated language_server.exe survived on non-account-switch relaunch -> logs warning and STILL spawns cleanly
    const jobPath2b = join(root, 'job2b.json');
    const ackPath2b = join(root, 'ack2b.json');
    const logPath2b = join(root, 'log2b.log');
    const nonce2b = '2b345678-1234-1234-1234-1234567890ab';
    writeFileSync(jobPath2b, JSON.stringify({
      format: 1,
      nonce: nonce2b,
      requestedAt: Date.now(),
      target,
      args: ['--remote-debugging-port=0'],
      proxyEnabled: false,
      forceHttp1: false,
      proxyEnv: null,
      onboardingSync: null,
      ackPath: ackPath2b,
      logPath: logPath2b
    }));
    let spawnCalled2b = 0;
    const res2b = await runRelaunchJob(jobPath2b, {
      listTargetPids: () => [],
      listLanguageServerPids: () => [79998],
      gracefulClosePid: () => {},
      forceKillPid: () => {},
      spawnProcess: () => { spawnCalled2b++; return { pid: process.pid, on() {}, unref() {} }; },
      settleMs: 5,
      gracefulTimeoutMs: 25,
      forceTimeoutMs: 25,
      postExitSettleMs: 5,
      verifyDelayMs: 5,
      pollMs: 10
    });
    assert.equal(res2b.ok, true);
    assert.equal(spawnCalled2b, 1);
    const ack2b = JSON.parse(readFileSync(ackPath2b, 'utf8'));
    assert.equal(ack2b.ok, true);
    assert.equal(ack2b.restoreFailed, undefined);
    assert.match(readFileSync(logPath2b, 'utf8'), /warn: elevated language_server/);

    // 2c. Antigravity.exe exited, elevated language_server.exe survived during account switch -> skips restore/clearScope, STILL spawns IDE with restoreFailed: true
    const jobPath2c = join(root, 'job2c.json');
    const ackPath2c = join(root, 'ack2c.json');
    const scopePath2c = join(root, 'sub2c', 'credential-user-scope');
    mkdirSync(join(root, 'sub2c'), { recursive: true });
    writeFileSync(scopePath2c, 'keep-when-ls-stuck');
    const nonce2c = '2c345678-1234-1234-1234-1234567890ab';
    writeFileSync(jobPath2c, JSON.stringify({
      format: 1,
      nonce: nonce2c,
      requestedAt: Date.now(),
      target,
      args: ['--remote-debugging-port=0'],
      proxyEnabled: false,
      forceHttp1: false,
      proxyEnv: null,
      onboardingSync: null,
      credentialSwitch: { accountId: 'acct-beta', expectedEmail: 'beta@example.com' },
      clearScopePath: scopePath2c,
      ackPath: ackPath2c
    }));
    let restoreCalled2c = 0;
    let spawnCalled2c = 0;
    const res2c = await runRelaunchJob(jobPath2c, {
      listTargetPids: () => [],
      listLanguageServerPids: () => [79997],
      gracefulClosePid: () => {},
      forceKillPid: () => {},
      restoreCredential: async () => { restoreCalled2c++; return { ok: true }; },
      spawnProcess: () => { spawnCalled2c++; return { pid: process.pid, on() {}, unref() {} }; },
      settleMs: 5,
      gracefulTimeoutMs: 25,
      forceTimeoutMs: 25,
      postExitSettleMs: 5,
      verifyDelayMs: 5,
      pollMs: 10
    });
    assert.equal(res2c.ok, true);
    assert.equal(res2c.restoreFailed, true);
    assert.equal(restoreCalled2c, 0);
    assert.equal(spawnCalled2c, 1);
    assert.equal(existsSync(scopePath2c), true);
    const ack2c = JSON.parse(readFileSync(ackPath2c, 'utf8'));
    assert.equal(ack2c.ok, true);
    assert.equal(ack2c.restoreFailed, true);
    assert.equal(ack2c.reason, 'elevated-process-running');

    // 3a. credentialSwitch restore mismatch -> fail closed without spawning
    const jobPath3 = join(root, 'job3.json');
    const ackPath3 = join(root, 'ack3.json');
    const nonce3 = '32345678-1234-1234-1234-1234567890ab';
    writeFileSync(jobPath3, JSON.stringify({
      format: 1,
      nonce: nonce3,
      requestedAt: Date.now(),
      target,
      args: ['--remote-debugging-port=0'],
      proxyEnabled: false,
      forceHttp1: false,
      proxyEnv: null,
      onboardingSync: null,
      credentialSwitch: { accountId: 'acct-beta', expectedEmail: 'beta@example.com' },
      ackPath: ackPath3
    }));
    let spawnCalled3 = 0;
    const res3 = await runRelaunchJob(jobPath3, {
      listTargetPids: () => [],
      listLanguageServerPids: () => [],
      restoreCredential: async () => ({ ok: false, mismatch: true, error: 'mismatch' }),
      spawnProcess: () => { spawnCalled3++; return { pid: process.pid, on() {}, unref() {} }; },
      settleMs: 5,
      postExitSettleMs: 5,
      verifyDelayMs: 5
    });
    assert.equal(res3.ok, false);
    assert.equal(res3.reason, 'credential-mismatch');
    assert.equal(spawnCalled3, 0);
    const ack3 = JSON.parse(readFileSync(ackPath3, 'utf8'));
    assert.equal(ack3.ok, false);
    assert.equal(ack3.reason, 'credential-mismatch');

    // 3b. credentialSwitch transient (non-mismatch) restore error -> log restore err, STILL spawn IDE so it is never stranded, write restoreFailed: true in ACK
    const jobPath3b = join(root, 'job3b.json');
    const ackPath3b = join(root, 'ack3b.json');
    const logPath3b = join(root, 'log3b.log');
    const scopePath3b = join(root, 'sub3b', 'credential-user-scope');
    mkdirSync(join(root, 'sub3b'), { recursive: true });
    writeFileSync(scopePath3b, 'keep-on-transient-err');
    const nonce3b = '3b345678-1234-1234-1234-1234567890ab';
    writeFileSync(jobPath3b, JSON.stringify({
      format: 1,
      nonce: nonce3b,
      requestedAt: Date.now(),
      target,
      args: ['--remote-debugging-port=0'],
      proxyEnabled: false,
      forceHttp1: false,
      proxyEnv: null,
      onboardingSync: null,
      credentialSwitch: { accountId: 'acct-beta', expectedEmail: 'beta@example.com' },
      clearScopePath: scopePath3b,
      ackPath: ackPath3b,
      logPath: logPath3b
    }));
    let spawnCalled3b = 0;
    const res3b = await runRelaunchJob(jobPath3b, {
      listTargetPids: () => [],
      listLanguageServerPids: () => [],
      restoreCredential: async () => ({ ok: false, error: 'credman transient busy' }),
      spawnProcess: () => { spawnCalled3b++; return { pid: process.pid, on() {}, unref() {} }; },
      settleMs: 5,
      postExitSettleMs: 5,
      verifyDelayMs: 5
    });
    assert.equal(res3b.ok, true);
    assert.equal(res3b.restoreFailed, true);
    assert.equal(spawnCalled3b, 1);
    assert.equal(existsSync(scopePath3b), true);
    const ack3b = JSON.parse(readFileSync(ackPath3b, 'utf8'));
    assert.equal(ack3b.ok, true);
    assert.equal(ack3b.restoreFailed, true);
    assert.match(readFileSync(logPath3b, 'utf8'), /restore err: credman transient busy/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('inspectWindowsShortcutBytes safely scans arbitrary binary/surrogate .lnk payloads at even and odd offsets without utf16le decoding', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-lnk-bytes-'));
  try {
    // 1. Dense arbitrary binary + unpaired UTF-16 surrogates (reproduces Node 24 Windows utf16le.toLowerCase heap crash pattern)
    const noisy = Buffer.alloc(4096);
    for (let i = 0; i < noisy.length; i += 2) {
      noisy[i] = (i * 37 + 0x55) & 0xff;
      noisy[i + 1] = i % 4 === 0 ? 0xd8 : 0xdc;
    }
    const nonAgyPath = join(root, 'OpenCode.lnk');
    writeFileSync(nonAgyPath, noisy);
    const nonAgyRes = inspectWindowsShortcutBytes(nonAgyPath);
    assert.deepEqual(nonAgyRes, {
      isAntigravity: false,
      hasDebugFlag: false,
      hasDefaultDebugFlag: false,
      readable: true
    });

    // 2. Odd-byte-offset UTF-16LE tokens surrounded by unpaired surrogates
    const oddUtf16 = Buffer.concat([
      noisy.subarray(0, 129), // odd offset
      Buffer.from('AnTiGrAvItY.ExE', 'utf16le'),
      Buffer.from([0x00, 0xd8, 0xff]),
      Buffer.from('--Remote-Debugging-Port=0', 'utf16le'),
      noisy.subarray(200, 512)
    ]);
    const oddPath = join(root, 'CustomShortcut.lnk');
    writeFileSync(oddPath, oddUtf16);
    const oddRes = inspectWindowsShortcutBytes(oddPath);
    assert.deepEqual(oddRes, {
      isAntigravity: true,
      hasDebugFlag: true,
      hasDefaultDebugFlag: true,
      readable: true
    });

    // 3. Pure ASCII tokens with custom port (hasDebugFlag true, hasDefaultDebugFlag false)
    const asciiPayload = Buffer.concat([
      noisy.subarray(0, 64),
      Buffer.from('C:\\Program Files\\Antigravity\\ANTIGRAVITY.EXE --remote-debugging-port=9222', 'latin1'),
      noisy.subarray(64, 128)
    ]);
    const asciiPath = join(root, 'Launcher.lnk');
    writeFileSync(asciiPath, asciiPayload);
    const asciiRes = inspectWindowsShortcutBytes(asciiPath);
    assert.deepEqual(asciiRes, {
      isAntigravity: true,
      hasDebugFlag: true,
      hasDefaultDebugFlag: false,
      readable: true
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PR #102: relaunch-worker catches language_server_windows_x64.exe & agy.exe via fail-closed CSV, pins custom profileDir, and emits appliedSwitchId/failedSwitchId without stranding IDE', async () => {
  // 1. parseCredentialWriterPids matches Antigravity.exe, language_server*.exe, and agy.exe and fails closed on diagnostics/truncation
  const rows = [
    'Antigravity.exe',
    'language_server.exe',
    'language_server_windows_x64.exe',
    'agy.exe',
    'node.exe'
  ].map((name, i) => `"${name}","${i + 10}","Console","1","200 K"`);
  assert.deepEqual(parseCredentialWriterPids(rows.join('\r\n'), 10), [11, 12, 13]);
  for (const bad of ['', 'INFO: No tasks are running.', rows[0] + '\ntruncated']) {
    assert.throws(() => parseCredentialWriterPids(bad, 10), /process-list-unavailable/);
  }

  // 2. listWindowsCredentialWriters queries unfiltered CSV first, then narrows per matched IMAGENAME+USERNAME (never USERNAME-only), and fails closed on unfiltered error
  const scopedCalls = [];
  const scoped = listWindowsCredentialWriters({
    excludePids: new Set([10]),
    env: { USERNAME: 'Alice.Dev' },
    runCommand: (_cmd, args) => {
      scopedCalls.push(args);
      if (args.includes('IMAGENAME eq language_server.exe')) {
        return { status: 0, stdout: '"language_server.exe","11","Console","1","200 K"\r\n' };
      }
      if (args.includes('IMAGENAME eq language_server_windows_x64.exe')) {
        return { status: 0, stdout: '"language_server_windows_x64.exe","12","Console","1","200 K"\r\n' };
      }
      if (args.includes('IMAGENAME eq agy.exe')) {
        return { status: 0, stdout: '"agy.exe","13","Console","1","200 K"\r\n' };
      }
      return { status: 0, stdout: rows.join('\r\n') };
    }
  });
  assert.deepEqual(scoped, [11, 12, 13]);
  assert.deepEqual(scopedCalls[0], ['/FO', 'CSV', '/NH']);
  assert.equal(scopedCalls.length, 4);
  for (const callArgs of scopedCalls) {
    if (callArgs.some(a => a.startsWith('USERNAME eq '))) {
      assert.ok(callArgs.some(a => a.startsWith('IMAGENAME eq ')), 'USERNAME eq must never be passed without IMAGENAME eq');
    }
  }

  assert.throws(() => listWindowsCredentialWriters({
    env: { USERNAME: 'Alice.Dev' },
    runCommand: () => ({ status: 1, stdout: '' })
  }), /process-list-unavailable/);

  // 3. profileDir validation, ANTIGRAVITY_USER_DATA_DIR preservation, switchId/expectedHash ACK, and non-stranding launch
  const root = mkdtempSync(join(tmpdir(), 'agy-worker-102-'));
  try {
    const target = join(root, 'Antigravity.exe');
    writeFileSync(target, '');
    const customProfile = join(root, 'custom profile');
    const explorerProfile = join(root, 'Antigravity');
    mkdirSync(customProfile, { recursive: true });
    mkdirSync(explorerProfile, { recursive: true });
    const canonicalProfile = verifiedSwitchProfileDir(customProfile);
    const customScope = join(canonicalProfile, 'credential-user-scope');
    const explorerScope = join(explorerProfile, 'credential-user-scope');
    writeFileSync(customScope, 'stale-custom-scope');
    writeFileSync(explorerScope, 'keep-explorer-scope');

    const switchId = '11111111-2222-3333-4444-555555555555';
    const expectedHash = 'AABBCCDDEEFF';
    const jobPath = join(root, 'relaunch-job.json');
    const ackPath = join(root, 'relaunch-ack.json');
    const accountsPath = join(root, 'accounts.json');
    const seedAccounts = () => writeFileSync(accountsPath, JSON.stringify({
      version: 2,
      activeId: 'acct-alpha',
      pendingSwitch: {
        targetId: 'acct-beta',
        targetEmail: 'beta@example.com',
        atMs: Date.now(),
        switchId,
        profileDir: canonicalProfile
      },
      accounts: [
        { id: 'acct-alpha', email: 'alpha@example.com', credHash: '111111111111', hasCredential: true },
        { id: 'acct-beta', email: 'beta@example.com', credHash: expectedHash, hasCredential: true }
      ]
    }));
    seedAccounts();

    const baseJob = {
      format: 1,
      nonce: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      requestedAt: Date.now(),
      target,
      args: ['--remote-debugging-port=0'],
      proxyEnabled: false,
      forceHttp1: false,
      proxyEnv: null,
      onboardingSync: null,
      profileDir: canonicalProfile,
      credentialSwitch: { accountId: 'acct-beta', expectedEmail: 'beta@example.com', expectedHash, switchId },
      ackPath
    };

    // Validation checks: require valid profileDir when switchId set, reject relative/extra fields
    assert.equal(validateRelaunchJob(baseJob, { jobPath }).valid, true);
    assert.equal(validateRelaunchJob({ ...baseJob, profileDir: undefined }, { jobPath }).reason, 'invalid-switch-profile');
    assert.equal(validateRelaunchJob({ ...baseJob, profileDir: 'relative/dir' }, { jobPath }).reason, 'invalid-switch-profile');
    assert.equal(validateRelaunchJob({ ...baseJob, credentialSwitch: { ...baseJob.credentialSwitch, extra: 'bad' } }, { jobPath }).reason, 'invalid-credential-switch');

    // Happy path: waits for writer exit, verifies expectedHash, deletes customProfile scope, passes ANTIGRAVITY_USER_DATA_DIR, writes appliedSwitchId
    writeFileSync(jobPath, JSON.stringify(baseJob));
    let writerChecks = 0;
    let restoredOpts = null;
    let spawnedEnv = null;
    const okRes = await runRelaunchJob(jobPath, {
      env: { APPDATA: root, ANTIGRAVITY_USER_DATA_DIR: explorerProfile },
      listTargetPids: () => [],
      listLanguageServerPids: () => [],
      listWriterPids: () => (++writerChecks === 1 ? [88001] : []),
      vault: {
        backend: 'win32-credman',
        restoreToActive(accountId, opts) {
          restoredOpts = { accountId, ...opts };
          return { ok: true };
        }
      },
      spawnProcess: (_cmd, _args, opts) => {
        spawnedEnv = opts.env;
        return { pid: process.pid, on() {}, unref() {} };
      },
      settleMs: 5,
      postExitSettleMs: 5,
      writerTimeoutMs: 500,
      verifyDelayMs: 5,
      pollMs: 5
    });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.appliedSwitchId, switchId);
    assert.deepEqual(restoredOpts, { accountId: 'acct-beta', expectedEmail: 'beta@example.com', expectedHash });
    assert.equal(spawnedEnv.ANTIGRAVITY_USER_DATA_DIR, canonicalProfile);
    assert.equal(existsSync(customScope), false);
    assert.equal(readFileSync(explorerScope, 'utf8'), 'keep-explorer-scope');
    assert.equal(JSON.parse(readFileSync(ackPath, 'utf8')).appliedSwitchId, switchId);

    // Post-exit tasklist error (process-list-unavailable): skips restore & scope cleanup, STILL launches IDE (never stranded!), writes failedSwitchId
    writeFileSync(customScope, 'keep-on-tasklist-err');
    writeFileSync(jobPath, JSON.stringify(baseJob));
    let restoreOnErr = 0;
    let spawnOnErr = 0;
    const errRes = await runRelaunchJob(jobPath, {
      env: { APPDATA: root },
      listTargetPids: () => [],
      listLanguageServerPids: () => [],
      listWriterPids: () => { throw new Error('process-list-unavailable'); },
      vault: {
        backend: 'win32-credman',
        restoreToActive() { restoreOnErr++; return { ok: true }; }
      },
      spawnProcess: () => { spawnOnErr++; return { pid: process.pid, on() {}, unref() {} }; },
      settleMs: 5,
      postExitSettleMs: 5,
      verifyDelayMs: 5,
      pollMs: 5
    });
    assert.equal(errRes.ok, true);
    assert.equal(errRes.restoreFailed, true);
    assert.equal(errRes.reason, 'process-list-unavailable');
    assert.equal(errRes.failedSwitchId, switchId);
    assert.equal(restoreOnErr, 0);
    assert.equal(spawnOnErr, 1);
    assert.equal(existsSync(customScope), true);
    const errAck = JSON.parse(readFileSync(ackPath, 'utf8'));
    assert.equal(errAck.failedSwitchId, switchId);
    assert.equal(errAck.appliedSwitchId, undefined);

    // Pre-close cancelled switch aborts cleanly BEFORE closing Antigravity and writes state: 'failed' + failedSwitchId
    writeFileSync(accountsPath, JSON.stringify({ version: 2, activeId: 'acct-alpha', pendingSwitch: null, accounts: [] }));
    writeFileSync(jobPath, JSON.stringify(baseJob));
    let closedOnCancel = 0;
    const cancelRes = await runRelaunchJob(jobPath, {
      listTargetPids: () => { closedOnCancel++; return [999]; },
      settleMs: 5
    });
    assert.equal(cancelRes.ok, false);
    assert.equal(cancelRes.reason, 'switch-cancelled');
    assert.equal(closedOnCancel, 0);
    const cancelAck = JSON.parse(readFileSync(ackPath, 'utf8'));
    assert.equal(cancelAck.state, 'failed');
    assert.equal(cancelAck.failedSwitchId, switchId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Issue #120: parseCredentialWriterPids skips non-matching PID 0, and listWindowsCredentialWriters uses fast unfiltered scan + per-image USERNAME narrowing', () => {
  const win11Csv = [
    '"System Idle Process","0","Services","0","8 K"',
    '"System","4","Services","0","140 K"',
    '"Antigravity.exe","1001","Console","1","250,000 K"',
    '"Antigravity.exe","1002","Console","2","210,000 K"',
    '"language_server_windows_x64.exe","2001","Console","1","80,000 K"',
    '"agy.exe","3001","Console","1","30,000 K"',
    '"node.exe","4001","Console","1","45,000 K"'
  ].join('\r\n');

  // 1. Strict parser skips System Idle Process (PID 0) and extracts unique matched image names
  const entries = parseCredentialWriterEntries(win11Csv);
  assert.deepEqual(entries.pids, [1001, 1002, 2001, 3001]);
  assert.deepEqual(entries.imageNames, ['Antigravity.exe', 'language_server_windows_x64.exe', 'agy.exe']);
  assert.deepEqual(parseCredentialWriterPids(win11Csv, new Set([1002])), [1001, 2001, 3001]);

  // Matching image name claiming PID 0 still fails closed
  assert.throws(
    () => parseCredentialWriterPids('"Antigravity.exe","0","Console","1","8 K"'),
    /process-list-unavailable/
  );
  assert.throws(
    () => parseCredentialWriterPids('"language_server.exe","0","Console","1","8 K"'),
    /process-list-unavailable/
  );

  // 2. 0-writer fast path: returns [] in a single unfiltered tasklist call when no writers are running
  const zeroCalls = [];
  const zeroWriters = listWindowsCredentialWriters({
    env: { USERNAME: 'Alice.Dev' },
    runCommand: (_cmd, args) => {
      zeroCalls.push(args);
      return {
        status: 0,
        stdout: [
          '"System Idle Process","0","Services","0","8 K"',
          '"System","4","Services","0","140 K"',
          '"node.exe","4001","Console","1","45,000 K"'
        ].join('\r\n')
      };
    }
  });
  assert.deepEqual(zeroWriters, []);
  assert.deepEqual(zeroCalls, [['/FO', 'CSV', '/NH']]);

  // 3. Per-image USERNAME narrowing handles localized English/Chinese zero-match text and never sends USERNAME without IMAGENAME
  const narrowCalls = [];
  const narrowed = listWindowsCredentialWriters({
    env: { USERNAME: 'Alice.Dev' },
    runCommand: (_cmd, args) => {
      narrowCalls.push(args);
      if (args.includes('IMAGENAME eq Antigravity.exe')) {
        return { status: 0, stdout: '"Antigravity.exe","1001","Console","1","250,000 K"\r\n' };
      }
      if (args.includes('IMAGENAME eq language_server_windows_x64.exe')) {
        return { status: 0, stdout: 'INFO: No tasks are running which match the specified criteria.\r\n' };
      }
      if (args.includes('IMAGENAME eq agy.exe')) {
        return { status: 0, stdout: '信息: 没有运行的任务匹配指定标准。\r\n' };
      }
      return { status: 0, stdout: win11Csv };
    }
  });
  assert.deepEqual(narrowed, [1001]);
  assert.equal(narrowCalls.length, 4);
  assert.deepEqual(narrowCalls[0], ['/FO', 'CSV', '/NH']);
  for (const callArgs of narrowCalls) {
    const hasUser = callArgs.some(a => a.startsWith('USERNAME eq '));
    const hasImage = callArgs.some(a => a.startsWith('IMAGENAME eq '));
    if (hasUser) assert.equal(hasImage, true, `USERNAME filter without IMAGENAME filter: ${JSON.stringify(callArgs)}`);
  }

  // 4. Per-image query failure falls back safely to unfiltered PIDs for that image (never aborts or drops writers)
  const fallbackCalls = [];
  const fallbackWriters = listWindowsCredentialWriters({
    env: { USERNAME: 'Alice.Dev' },
    runCommand: (_cmd, args) => {
      fallbackCalls.push(args);
      if (args.includes('IMAGENAME eq Antigravity.exe')) {
        return { status: 0, stdout: '"Antigravity.exe","1001","Console","1","250,000 K"\r\n' };
      }
      if (args.includes('IMAGENAME eq language_server_windows_x64.exe')) {
        return { status: 1, stdout: '', error: new Error('ETIMEDOUT') };
      }
      if (args.includes('IMAGENAME eq agy.exe')) {
        return { status: 0, stdout: '   ' };
      }
      return { status: 0, stdout: win11Csv };
    }
  });
  assert.deepEqual(fallbackWriters, [1001, 2001, 3001]);
  assert.equal(fallbackCalls.length, 4);

  // 5. Missing or unsafe USERNAME skips per-image narrowing and returns unfiltered PIDs directly
  const noUserCalls = [];
  const noUserWriters = listWindowsCredentialWriters({
    env: { USERNAME: 'bad;user' },
    runCommand: (_cmd, args) => {
      noUserCalls.push(args);
      return { status: 0, stdout: win11Csv };
    }
  });
  assert.deepEqual(noUserWriters, [1001, 1002, 2001, 3001]);
  assert.deepEqual(noUserCalls, [['/FO', 'CSV', '/NH']]);
});

test('Issue #120: live Windows listWindowsCredentialWriters parses real tasklist.exe CSV without failing on PID 0 or stalling', { skip: process.platform !== 'win32' }, () => {
  const t0 = Date.now();
  const writers = listWindowsCredentialWriters();
  const elapsedMs = Date.now() - t0;
  assert.ok(Array.isArray(writers));
  assert.ok(writers.every(pid => Number.isInteger(pid) && pid > 0));
  assert.ok(elapsedMs < 8000, `listWindowsCredentialWriters took too long: ${elapsedMs}ms`);

  // 0-writer fast path live on Windows
  const none = listWindowsCredentialWriters({ pattern: /^agy_nonexistent_writer_probe_9999\.exe$/i });
  assert.deepEqual(none, []);

  // Per-image USERNAME narrowing with non-existent user yields [] cleanly on live Windows
  const otherUser = listWindowsCredentialWriters({ env: { USERNAME: 'AgyNonExistentUser9999' } });
  assert.deepEqual(otherUser, []);
});

test('Issue #113: validateRelaunchJob accepts safe --wsl-distro and boolean wslMode, and buildCleanTargetEnv manages WSLENV /u propagation & cleanup', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-worker-113-'));
  try {
    const target = join(root, 'Antigravity.exe');
    writeFileSync(target, '');
    const jobPath = join(root, 'relaunch-job.json');
    const ackPath = join(root, 'relaunch-ack.json');
    const baseJob = {
      format: 1,
      nonce: '11311311-2222-3333-4444-555555555555',
      requestedAt: Date.now(),
      target,
      args: ['--remote-debugging-port=0', '--wsl-distro=Ubuntu-24.04'],
      proxyEnabled: true,
      forceHttp1: true,
      wslMode: true,
      proxyEnv: {
        HTTP_PROXY: 'http://127.0.0.1:7897',
        HTTPS_PROXY: 'http://127.0.0.1:7897',
        ALL_PROXY: 'http://127.0.0.1:7897',
        http_proxy: 'http://127.0.0.1:7897',
        https_proxy: 'http://127.0.0.1:7897',
        all_proxy: 'http://127.0.0.1:7897',
        NO_PROXY: 'localhost,127.0.0.1,::1',
        no_proxy: 'localhost,127.0.0.1,::1',
        AGY_POWERTOOLS_PROXY_SPEC: 'http://127.0.0.1:7897|localhost,127.0.0.1,::1|h1',
        GODEBUG: 'http2client=0'
      },
      ackPath
    };

    assert.equal(validateRelaunchJob(baseJob, { jobPath }).valid, true);
    assert.equal(validateRelaunchJob({ ...baseJob, args: ['--remote-debugging-port=0', '--wsl-distro=Arch Linux'] }, { jobPath }).valid, true);
    assert.equal(validateRelaunchJob({ ...baseJob, args: ['--remote-debugging-port=0', '--wsl-distro=a'] }, { jobPath }).valid, true);
    assert.equal(validateRelaunchJob({ ...baseJob, wslMode: false }, { jobPath }).valid, true);
    assert.equal(validateRelaunchJob({ ...baseJob, wslMode: undefined }, { jobPath }).valid, true);

    // Reject shell injection / malformed --wsl-distro values
    for (const badDistroArg of [
      '--wsl-distro=',
      '--wsl-distro= Ubuntu',
      '--wsl-distro=Ubuntu ',
      '--wsl-distro=Ubuntu;calc.exe',
      '--wsl-distro=Ubuntu&whoami',
      '--wsl-distro=Ubuntu|id',
      '--wsl-distro=../evil',
      `--wsl-distro=${'a'.repeat(65)}`
    ]) {
      assert.equal(validateRelaunchJob({ ...baseJob, args: ['--remote-debugging-port=0', badDistroArg] }, { jobPath }).reason, 'disallowed-arg');
    }

    // Reject non-boolean wslMode
    for (const badWslMode of ['true', 1, null, {}]) {
      assert.equal(validateRelaunchJob({ ...baseJob, wslMode: badWslMode }, { jobPath }).reason, 'invalid-wsl-mode');
    }

    // WSLENV propagation with proxy enabled + forceHttp1: preserves user entries, deduplicates by var name before '/', handles case-insensitive WslEnv key
    const wslProxyEnv = buildCleanTargetEnv(
      { PATH: 'C:\\Windows', WslEnv: 'USER_VAR/p:HTTP_PROXY/p' },
      baseJob
    );
    assert.equal(wslProxyEnv.WSLENV, undefined);
    assert.equal(
      wslProxyEnv.WslEnv,
      'USER_VAR/p:HTTP_PROXY/p:HTTPS_PROXY/u:ALL_PROXY/u:http_proxy/u:https_proxy/u:all_proxy/u:NO_PROXY/u:no_proxy/u:AGY_POWERTOOLS_PROXY_SPEC/u:GODEBUG/u'
    );

    // proxyEnabled with forceHttp1=false clears managed GODEBUG and removes GODEBUG from WSLENV
    const noH1Job = {
      ...baseJob,
      forceHttp1: false,
      proxyEnv: {
        HTTP_PROXY: 'http://127.0.0.1:7897',
        http_proxy: 'http://127.0.0.1:7897',
        AGY_POWERTOOLS_PROXY_SPEC: 'http://127.0.0.1:7897|localhost|auto'
      }
    };
    const wslNoH1 = buildCleanTargetEnv(
      { WSLENV: 'USER_VAR/u:GODEBUG/u', GODEBUG: 'http2client=0' },
      noH1Job
    );
    assert.equal(wslNoH1.GODEBUG, undefined);
    assert.equal(wslNoH1.WSLENV, 'USER_VAR/u:HTTP_PROXY/u:http_proxy/u:AGY_POWERTOOLS_PROXY_SPEC/u');

    // proxyEnabled with forceHttp1=false preserves user's own GODEBUG & WSLENV entry
    const wslUserGodebug = buildCleanTargetEnv(
      { WSLENV: 'USER_VAR/u:GODEBUG/u', GODEBUG: 'gctrace=1' },
      noH1Job
    );
    assert.equal(wslUserGodebug.GODEBUG, 'gctrace=1');
    assert.equal(wslUserGodebug.WSLENV, 'USER_VAR/u:GODEBUG/u:HTTP_PROXY/u:http_proxy/u:AGY_POWERTOOLS_PROXY_SPEC/u');

    // proxyEnabled=false with prior plugin proxy spec strips managed proxy keys + GODEBUG from WSLENV while preserving user entries
    const wslDisabledKeepUser = buildCleanTargetEnv(
      {
        HTTP_PROXY: 'http://127.0.0.1:7897',
        http_proxy: 'http://127.0.0.1:7897',
        AGY_POWERTOOLS_PROXY_SPEC: 'spec',
        GODEBUG: 'http2client=0',
        WSLENV: 'USER_VAR/u:HTTP_PROXY/u:http_proxy/u:AGY_POWERTOOLS_PROXY_SPEC/u:GODEBUG/u'
      },
      { wslMode: true, proxyEnabled: false, forceHttp1: false, proxyEnv: null }
    );
    assert.equal(wslDisabledKeepUser.HTTP_PROXY, undefined);
    assert.equal(wslDisabledKeepUser.AGY_POWERTOOLS_PROXY_SPEC, undefined);
    assert.equal(wslDisabledKeepUser.GODEBUG, undefined);
    assert.equal(wslDisabledKeepUser.WSLENV, 'USER_VAR/u');

    // proxyEnabled=false deletes WSLENV completely when all entries were plugin-managed
    const wslDisabledEmpty = buildCleanTargetEnv(
      {
        HTTP_PROXY: 'http://127.0.0.1:7897',
        AGY_POWERTOOLS_PROXY_SPEC: 'spec',
        GODEBUG: 'http2client=0',
        WSLENV: 'HTTP_PROXY/u:AGY_POWERTOOLS_PROXY_SPEC/u:GODEBUG/u'
      },
      { wslMode: true, proxyEnabled: false, forceHttp1: false, proxyEnv: null }
    );
    assert.equal('WSLENV' in wslDisabledEmpty, false);

    // proxyEnabled=false WITHOUT plugin proxy spec removes only AGY_POWERTOOLS_PROXY_SPEC from WSLENV and preserves user proxy
    const wslDisabledUserProxy = buildCleanTargetEnv(
      {
        HTTP_PROXY: 'http://corp:8080',
        WSLENV: 'HTTP_PROXY/u:AGY_POWERTOOLS_PROXY_SPEC/u'
      },
      { wslMode: true, proxyEnabled: false, forceHttp1: false, proxyEnv: null }
    );
    assert.equal(wslDisabledUserProxy.HTTP_PROXY, 'http://corp:8080');
    assert.equal(wslDisabledUserProxy.WSLENV, 'HTTP_PROXY/u');

    // Non-WSL mode leaves WSLENV completely untouched
    const nonWslOn = buildCleanTargetEnv(
      { WSLENV: 'KEEP_ONLY/u' },
      { ...baseJob, wslMode: false }
    );
    assert.equal(nonWslOn.WSLENV, 'KEEP_ONLY/u');
    const nonWslOff = buildCleanTargetEnv(
      { AGY_POWERTOOLS_PROXY_SPEC: 'spec', WSLENV: 'HTTP_PROXY/u:AGY_POWERTOOLS_PROXY_SPEC/u' },
      { proxyEnabled: false }
    );
    assert.equal(nonWslOff.WSLENV, 'HTTP_PROXY/u:AGY_POWERTOOLS_PROXY_SPEC/u');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
