import { accessSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createSettingsStore } from './settings.mjs';
import { DEFAULT_PROXY_BYPASS, normalizeProxyBypass, normalizeProxyUrl } from './proxy.mjs';

export const CODEX_SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access']);
const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 1800;
const MAX_RUN_HISTORY = 50;

function isExecutable(filePath, platform) {
  if (!filePath || typeof filePath !== 'string') return false;
  try {
    accessSync(filePath, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function nvmCandidates(home) {
  const versionsDir = join(home, '.nvm', 'versions', 'node');
  if (!existsSync(versionsDir)) return [];
  try {
    return readdirSync(versionsDir)
      .filter(name => /^v?\d+/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map(ver => join(versionsDir, ver, 'bin', 'codex'));
  } catch {
    return [];
  }
}

export function resolveCodexBinary({ codexPath = '', env = process.env, platform = process.platform, home = homedir() } = {}) {
  const custom = String(codexPath || '').trim();
  if (custom) {
    if (isExecutable(custom, platform)) return { found: true, path: custom, source: 'settings' };
    return { found: false, path: custom, source: 'settings', error: `Configured codexPath is not executable: ${custom}` };
  }

  const envBin = String(env?.CODEX_BIN || '').trim();
  if (envBin && isExecutable(envBin, platform)) {
    return { found: true, path: envBin, source: 'env' };
  }

  const windows = platform === 'win32';
  const exeNames = windows ? ['codex.exe', 'codex.cmd', 'codex.bat', 'codex'] : ['codex'];
  const pathKey = windows ? Object.keys(env || {}).find(key => key.toUpperCase() === 'PATH') : 'PATH';
  const pathDirs = String(env?.[pathKey] || '').split(windows ? ';' : delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const pathDir = windows ? dir.replace(/^"(.*)"$/, '$1') : dir;
    for (const name of exeNames) {
      const candidate = join(pathDir, name);
      if (isExecutable(candidate, platform)) return { found: true, path: candidate, source: 'path' };
    }
  }

  if (platform === 'darwin') {
    const macAppCandidates = [
      { path: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', source: 'chatgpt-app' },
      { path: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', source: 'chatgpt-app' },
      { path: join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'), source: 'chatgpt-app' },
      { path: '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex', source: 'codex-app' },
      { path: join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'), source: 'codex-app' }
    ];
    for (const item of macAppCandidates) {
      if (isExecutable(item.path, platform)) return { found: true, path: item.path, source: item.source };
    }
  }

  const commonCandidates = windows
    ? [
        join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
        join(home, '.volta', 'bin', 'codex.exe'),
        join(home, '.bun', 'bin', 'codex.exe')
      ]
    : [
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        join(home, '.npm-global', 'bin', 'codex'),
        join(home, '.local', 'bin', 'codex'),
        join(home, '.volta', 'bin', 'codex'),
        join(home, '.bun', 'bin', 'codex'),
        ...nvmCandidates(home)
      ];

  for (const candidate of commonCandidates) {
    if (isExecutable(candidate, platform)) return { found: true, path: candidate, source: 'common' };
  }

  return { found: false, path: '', source: 'none' };
}

export function buildSpawnCommand(bin, args, platform = process.platform) {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(bin)) {
    return { command: bin, args, options: {} };
  }

  if (/["^%\x00-\x1f]/.test(bin)) {
    throw new Error('Windows batch shim path contains characters that cmd.exe cannot safely quote');
  }
  // Use the batch quoting rules from Rust's Windows Command implementation.
  // Quoted pairs survive both cmd.exe and a shim forwarding its arguments with %*.
  // The empty %cd:~,% expansion prevents cmd.exe from interpreting literal percent signs as variables.
  const quotedArgs = args.map(arg => {
    if (/[\0\r\n]/.test(arg)) {
      throw new Error('Windows batch shim arguments cannot contain NULs or line breaks');
    }
    return '"' + arg
      .replace(/(\\*)"/g, '$1$1""')
      .replace(/\\+$/, '$&$&')
      .replace(/%/g, '%%cd:~,%') + '"';
  });
  const commandLine = ['"' + bin + '"', ...quotedArgs].join(' ');
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/e:on', '/v:off', '/s', '/c', '"' + commandLine + '"'],
    options: { windowsVerbatimArguments: true, windowsHide: true }
  };
}

export function buildCodexEnv({ settings = {}, baseEnv = process.env } = {}) {
  const env = { ...baseEnv };
  if (settings.proxyEnabled && settings.proxyUrl) {
    const proxyUrl = normalizeProxyUrl(settings.proxyUrl);
    if (proxyUrl) {
      env.HTTP_PROXY = proxyUrl;
      env.HTTPS_PROXY = proxyUrl;
      env.ALL_PROXY = proxyUrl;
      env.http_proxy = proxyUrl;
      env.https_proxy = proxyUrl;
      env.all_proxy = proxyUrl;
      const bypass = normalizeProxyBypass(settings.proxyBypass || DEFAULT_PROXY_BYPASS) || DEFAULT_PROXY_BYPASS;
      env.NO_PROXY = bypass;
      env.no_proxy = bypass;
    }
  }
  return env;
}

export function parseCodexJsonl(stdoutText = '') {
  const lines = String(stdoutText || '').split(/\r?\n/);
  let sessionId = '';
  const messages = [];
  const filesChanged = new Set();
  const errors = [];
  let usage = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;

    if (!sessionId) {
      const tid = ev.thread_id || ev.session_id || ev.thread?.id || ev.session?.id;
      if (typeof tid === 'string' && tid.trim()) sessionId = tid.trim();
    }

    if (ev.type === 'item.completed' && ev.item && typeof ev.item === 'object') {
      const item = ev.item;
      if ((item.type === 'agent_message' || item.type === 'message') && typeof item.text === 'string' && item.text.trim()) {
        messages.push(item.text.trim());
      } else if (item.type === 'file_change' && Array.isArray(item.changes)) {
        for (const ch of item.changes) {
          if (typeof ch?.path === 'string' && ch.path) filesChanged.add(ch.path);
        }
      }
    } else if (ev.type === 'agent_message' && typeof ev.message === 'string' && ev.message.trim()) {
      messages.push(ev.message.trim());
    } else if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
      usage = {
        inputTokens: Number(ev.usage.input_tokens || 0),
        cachedInputTokens: Number(ev.usage.cached_input_tokens || 0),
        outputTokens: Number(ev.usage.output_tokens || 0)
      };
    } else if (ev.type === 'error' || ev.type === 'turn.failed') {
      const errMsg = ev.error?.message || ev.message || (typeof ev.error === 'string' ? ev.error : '');
      if (errMsg) errors.push(String(errMsg));
    }
  }

  return {
    sessionId,
    lastMessage: messages.length ? messages.at(-1) : '',
    filesChanged: [...filesChanged],
    usage,
    errors
  };
}

export function buildCodexArgs({
  mode = 'run',
  cwd = '',
  sandbox = 'workspace-write',
  model = '',
  worktree = false,
  addDirs = [],
  skipGitRepoCheck = false,
  sessionId = '',
  uncommitted,
  base = '',
  commit = '',
  hasPrompt = mode !== 'review',
  outputLastMessagePath = ''
} = {}) {
  const args = ['exec'];
  if (mode === 'resume') {
    args.push('resume');
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id || id.startsWith('-') || /\p{Cc}/u.test(sessionId)) {
      throw new Error('sessionId must be a non-empty string without a leading dash or control characters');
    }
    if (model) args.push('-m', String(model).trim());
    args.push('--json');
    if (outputLastMessagePath) args.push('-o', outputLastMessagePath);
    args.push('--', id);
    if (hasPrompt) args.push('-');
    return args;
  }

  if (mode === 'review') {
    args.push('review', '-c', 'sandbox_mode="read-only"');
    const reviewCommit = String(commit || '').trim();
    const reviewBase = String(base || '').trim();
    if (hasPrompt && (reviewCommit || reviewBase || uncommitted === true)) {
      throw new Error('A custom review prompt cannot be combined with base, commit, or uncommitted: true');
    }
    if (reviewCommit) args.push('--commit', reviewCommit);
    else if (reviewBase) args.push('--base', reviewBase);
    else if (!hasPrompt && uncommitted !== false) args.push('--uncommitted');
    if (model) args.push('-m', String(model).trim());
    if (skipGitRepoCheck) args.push('--skip-git-repo-check');
    args.push('--json');
    if (outputLastMessagePath) args.push('-o', outputLastMessagePath);
    if (hasPrompt) args.push('-');
    return args;
  }

  if (cwd) args.push('-C', cwd);
  const safeSandbox = CODEX_SANDBOX_MODES.includes(sandbox) ? sandbox : 'workspace-write';
  args.push('-s', safeSandbox);
  if (model) args.push('-m', String(model).trim());
  if (worktree) args.push('--worktree');
  for (const dir of Array.isArray(addDirs) ? addDirs : []) {
    if (typeof dir === 'string' && dir.trim()) args.push('--add-dir', dir.trim());
  }
  if (skipGitRepoCheck) args.push('--skip-git-repo-check');
  args.push('--json');
  if (outputLastMessagePath) args.push('-o', outputLastMessagePath);
  if (hasPrompt) args.push('-');
  return args;
}

export function recordCodexRun(record, dataDir = join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-powertools')) {
  try {
    mkdirSync(dataDir, { recursive: true });
    const filePath = join(dataDir, 'codex-runs.json');
    let list = [];
    if (existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
        if (Array.isArray(parsed)) list = parsed;
      } catch {}
    }
    list.unshift({ ...record, timestamp: new Date().toISOString() });
    if (list.length > MAX_RUN_HISTORY) list = list.slice(0, MAX_RUN_HISTORY);
    writeFileSync(`${filePath}.tmp`, JSON.stringify(list, null, 2) + '\n', 'utf8');
    renameSync(`${filePath}.tmp`, filePath);
  } catch {}
}

export function inspectCodexHealth({ settings, env = process.env, home = homedir() } = {}) {
  const opts = settings || createSettingsStore().get();
  const resolved = resolveCodexBinary({ codexPath: opts.codexPath, env, home });
  const codexHome = env?.CODEX_HOME || join(home, '.codex');
  const hasCodexHome = existsSync(codexHome);
  const hasConfigToml = existsSync(join(codexHome, 'config.toml'));
  const hasAuth = existsSync(join(codexHome, 'auth.json'));
  let version = '';
  let versionError = '';
  if (resolved.found) {
    try {
      const launch = buildSpawnCommand(resolve(resolved.path), ['--version']);
      const res = spawnSync(launch.command, launch.args, {
        ...launch.options,
        env: buildCodexEnv({ settings: opts, baseEnv: env }),
        encoding: 'utf8',
        timeout: 5000
      });
      if (res.status === 0) version = String(res.stdout || res.stderr || '').trim();
      else versionError = String(res.stderr || res.error?.message || `exit ${res.status}`).trim();
    } catch (err) {
      versionError = err.message;
    }
  }
  return {
    enabled: opts.codexEnabled !== false,
    found: resolved.found,
    binaryPath: resolved.path,
    source: resolved.source,
    version,
    versionError: resolved.error || versionError || '',
    codexHome,
    hasCodexHome,
    hasConfigToml,
    hasAuth,
    defaultSandbox: opts.codexDefaultSandbox || 'workspace-write',
    defaultModel: opts.codexDefaultModel || '',
    proxyInherited: Boolean(opts.proxyEnabled && opts.proxyUrl)
  };
}

export function runCodexTask({
  mode = 'run',
  prompt = '',
  cwd = process.cwd(),
  sandbox,
  model,
  worktree = false,
  addDirs = [],
  skipGitRepoCheck = false,
  sessionId = '',
  uncommitted,
  base = '',
  commit = '',
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  settings,
  env = process.env,
  signal,
  dataDir = join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-powertools')
} = {}) {
  if (signal?.aborted) {
    return Promise.resolve({ ok: false, mode, error: 'Codex CLI task cancelled' });
  }
  const opts = settings || createSettingsStore().get();
  if (opts.codexEnabled === false) {
    return Promise.resolve({
      ok: false,
      mode,
      error: 'Codex CLI integration is disabled in Agy Powertools settings (codexEnabled=false).'
    });
  }

  const resolved = resolveCodexBinary({ codexPath: opts.codexPath, env });
  if (!resolved.found) {
    return Promise.resolve({
      ok: false,
      mode,
      error: resolved.error || 'Codex CLI binary not found. Install @openai/codex, install ChatGPT.app, or set codexPath in Agy Powertools settings.'
    });
  }

  const workDir = resolve(String(cwd || process.cwd()));
  if (!existsSync(workDir)) {
    return Promise.resolve({
      ok: false,
      mode,
      error: `Working directory does not exist: ${workDir}`
    });
  }

  const cleanPrompt = String(prompt || '').trim();
  if ((mode === 'run' || mode === 'resume') && !cleanPrompt) {
    return Promise.resolve({ ok: false, mode, error: 'prompt is required' });
  }
  if (mode === 'resume' && !String(sessionId || '').trim()) {
    return Promise.resolve({ ok: false, mode, error: 'sessionId is required for codex_resume' });
  }

  const effectiveSandbox = mode === 'review' ? 'read-only' : (sandbox || opts.codexDefaultSandbox || 'workspace-write');
  const effectiveModel = model != null && String(model).trim() !== '' ? String(model).trim() : (opts.codexDefaultModel || '');
  const timeoutMs = Math.max(10, Math.min(MAX_TIMEOUT_SECONDS, Number(timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS)) * 1000;

  let tempDir;
  let lastMsgPath;
  let child;
  const startedAt = Date.now();
  const windows = process.platform === 'win32';
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'agy-codex-'));
    lastMsgPath = join(tempDir, 'last-message.txt');
    const args = buildCodexArgs({
      mode,
      cwd: mode === 'run' ? workDir : '',
      sandbox: effectiveSandbox,
      model: effectiveModel,
      worktree: Boolean(worktree),
      addDirs,
      skipGitRepoCheck: Boolean(skipGitRepoCheck),
      sessionId,
      uncommitted,
      base,
      commit,
      hasPrompt: Boolean(cleanPrompt),
      outputLastMessagePath: lastMsgPath
    });
    const launch = buildSpawnCommand(resolve(resolved.path), args);
    child = spawn(launch.command, launch.args, {
      ...launch.options,
      cwd: workDir,
      detached: !windows,
      env: buildCodexEnv({ settings: opts, baseEnv: env }),
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
    return Promise.resolve({ ok: false, mode, error: err.message });
  }

  return new Promise(resolvePromise => {
    let stdout = '';
    let stderr = '';
    let terminationError = '';
    let killTimer = null;
    let finished = false;
    let stdinError;

    const terminate = error => {
      if (finished || terminationError) return;
      terminationError = error;
      if (!child.pid) return;
      if (windows) {
        // Killing cmd.exe alone leaves the CLI started by the shim running.
        const taskkill = process.env.SystemRoot
          ? join(process.env.SystemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
        execFile(taskkill, ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true, timeout: 5000
        }, err => {
          if (err && !finished) child.kill();
        });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        killTimer = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        }, 5000);
      }
    };
    const abort = () => terminate('Codex CLI task cancelled');
    const timer = setTimeout(() => {
      terminate(`Codex CLI timed out after ${Math.round(timeoutMs / 1000)}s`);
    }, timeoutMs);

    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', err => { stdinError = err; });

    const finish = (exitCode, spawnErr) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      let fileLastMessage = '';
      try {
        if (existsSync(lastMsgPath)) fileLastMessage = readFileSync(lastMsgPath, 'utf8').trim();
      } catch {}
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}

      const parsed = parseCodexJsonl(stdout);
      const durationMs = Date.now() - startedAt;
      const finalMessage = fileLastMessage || parsed.lastMessage || stdout.trim();
      const error = terminationError || spawnErr?.message || (exitCode !== 0
        ? (parsed.errors.join('; ') || stderr.trim() || stdinError?.message || `Codex exited with code ${exitCode}`)
        : '');
      const ok = !error;

      const result = {
        ok,
        mode,
        sessionId: parsed.sessionId || String(sessionId || ''),
        message: finalMessage,
        filesChanged: parsed.filesChanged,
        usage: parsed.usage,
        durationMs,
        exitCode: exitCode ?? -1,
        binaryPath: resolved.path,
        ...(error ? { error } : {}),
        ...(stderr.trim() && !ok ? { stderr: stderr.trim().slice(-2000) } : {})
      };

      recordCodexRun({
        mode,
        cwd: workDir,
        model: effectiveModel || 'default',
        sandbox: effectiveSandbox,
        ok,
        durationMs,
        sessionId: result.sessionId,
        filesChanged: result.filesChanged.length
      }, dataDir);

      resolvePromise(result);
    };

    child.on('error', err => finish(-1, err));
    child.on('close', code => finish(code, null));

    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.end(cleanPrompt);
  });
}
