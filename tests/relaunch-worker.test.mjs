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

    // 2. Mismatched nonce or missing ACK times out -> deletes stale job JSON, records lastRelaunchBlockedAt, returns manualRestartRequired
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
