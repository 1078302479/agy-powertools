import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function findPreloadJs(env) {
  const candidates = [
    env.ANTIGRAVITY_APP_DATA_DIR && join(env.ANTIGRAVITY_APP_DATA_DIR, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
    join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js')
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) {
      try { return readFileSync(path, 'utf8'); } catch {}
    }
  }
  return '';
}

export function renderAuxPaneHtml({ version = '', language = 'zh-CN' } = {}) {
  const initialLang = language === 'en' ? 'en' : 'zh-CN';
  return `<!doctype html>
<html lang="${initialLang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Powertools</title>
  <script src="/preload.js"></script>
  <style>
    :root {
      color-scheme: light dark;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      background: var(--background, #fafafa);
      color: var(--foreground, #1f2328);
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .card {
      border: 1px solid var(--border, rgba(127, 127, 127, 0.22));
      background: var(--card, rgba(127, 127, 127, 0.05));
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 500;
      color: var(--muted-foreground, #667085);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #f59e0b;
      flex-shrink: 0;
    }
    .dot[data-healthy="true"] {
      background: #16a34a;
    }
    h1 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      line-height: 1.45;
    }
    p {
      margin: 0;
      font-size: 12px;
      color: var(--muted-foreground, #667085);
      line-height: 1.55;
    }
    button {
      appearance: none;
      border: 0;
      border-radius: 8px;
      padding: 8px 14px;
      font: inherit;
      font-weight: 500;
      cursor: pointer;
      background: var(--primary, #2563eb);
      color: var(--primary-foreground, #ffffff);
      transition: opacity 120ms ease;
      align-self: flex-start;
    }
    button:hover:not(:disabled) { opacity: 0.9; }
    button:disabled { opacity: 0.6; cursor: default; }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    button.secondary {
      background: var(--secondary, rgba(127, 127, 127, 0.14));
      color: var(--foreground, #1f2328);
    }
    .cmd-box {
      font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      padding: 8px 10px;
      border-radius: 8px;
      background: var(--secondary, rgba(127, 127, 127, 0.1));
      color: var(--foreground, #1f2328);
      word-break: break-all;
      user-select: all;
    }
    .meta {
      font-size: 11px;
      color: var(--muted-foreground, #667085);
      font-variant-numeric: tabular-nums;
    }
  </style>
</head>
<body>
  <section class="card" id="root">
    <div class="badge"><span class="dot" id="dot"></span><span id="state-text">Agy Powertools ${version}</span></div>
    <h1 id="title"></h1>
    <p id="desc"></p>
    <div class="actions">
      <button type="button" id="relaunch-btn" hidden></button>
      <button type="button" id="copy-cmd-btn" class="secondary" hidden></button>
    </div>
    <div class="cmd-box" id="cmd-box" hidden></div>
    <div class="meta" id="feedback" hidden></div>
  </section>
  <script>
    (() => {
      const params = new URLSearchParams(location.search);
      const token = params.get('token') || '';
      const dot = document.getElementById('dot');
      const title = document.getElementById('title');
      const desc = document.getElementById('desc');
      const btn = document.getElementById('relaunch-btn');
      const copyBtn = document.getElementById('copy-cmd-btn');
      const cmdBox = document.getElementById('cmd-box');
      const feedback = document.getElementById('feedback');
      let currentLang = ${JSON.stringify(initialLang)};
      let manualCommand = '';
      let busy = false;
      let relaunchTimer = null;

      const copy = {
        'zh-CN': {
          upgradeTitle: '需要重启 Antigravity 以启用 Powertools 插件',
          upgradeDesc: '当前客户端未开启本地调试端口（首次安装、客户端升级或从无参数快捷方式启动时会出现）。后台已尝试自动修复常用快捷方式，点击下方按钮可带参数重启；若无法自动重启，请完全退出客户端后从快捷方式或终端手动启动。',
          activeTitle: 'Powertools 运行正常',
          activeDesc: '原生输入框圆环、紧凑排版、原位消息编辑与左侧栏 Powertools 面板均已启用。',
          disabledTitle: 'Powertools 当前已暂停',
          disabledDesc: '可在左侧栏 Powertools 设置页中重新开启总开关。',
          sshTitle: '当前处于 SSH 远端模式',
          sshDesc: '远端主机上没有本地 Antigravity 桌面调试接口，远端服务无法直接接管本地客户端界面。请在本地桌面端安装 Powertools 以启用界面增强；远端 SSH 会话的本地 SQLite 统计暂不支持。',
          relaunch: '立即重启启用',
          relaunching: '正在重启 Antigravity…',
          relaunchSent: '已触发后台重启，正在关闭并重新打开 Antigravity，请稍候…',
          relaunchTimeout: '等待重启超时，请完全退出 Antigravity（含系统托盘）后从桌面/开始菜单快捷方式重新打开，或在终端运行下方命令。',
          relaunchFailed: '自动重启失败，请完全退出 Antigravity 后手动重新打开，或在终端运行下方命令。',
          copyCmd: '复制启动命令',
          copiedCmd: '已复制命令'
        },
        en: {
          upgradeTitle: 'Restart Antigravity to enable Powertools',
          upgradeDesc: 'Antigravity was launched without its local debugging port (common after a fresh install, client update, or launching from an unpatched shortcut). Click below to relaunch with debugging enabled, or quit Antigravity completely and reopen it from your shortcut or terminal.',
          activeTitle: 'Powertools is active',
          activeDesc: 'Context ring, compact layout, in-place message editing, and the sidebar Powertools dashboard are running.',
          disabledTitle: 'Powertools is paused',
          disabledDesc: 'Re-enable Powertools anytime from the Powertools settings page.',
          sshTitle: 'Running in SSH Remote mode',
          sshDesc: 'No local Antigravity desktop debugging interface is available on the remote SSH host. Install Powertools locally to enhance the desktop UI; remote SSH SQLite telemetry is not yet supported.',
          relaunch: 'Restart to Enable',
          relaunching: 'Restarting Antigravity…',
          relaunchSent: 'Relaunch triggered. Closing and reopening Antigravity, please wait…',
          relaunchTimeout: 'Relaunch timed out. Please quit Antigravity completely (including system tray) and reopen from your shortcut, or run the command below.',
          relaunchFailed: 'Automatic restart failed. Please quit Antigravity completely and reopen it manually, or run the command below.',
          copyCmd: 'Copy launch command',
          copiedCmd: 'Copied'
        }
      };

      function showManualCommand() {
        if (!manualCommand) return;
        cmdBox.hidden = false;
        cmdBox.textContent = manualCommand;
        copyBtn.hidden = false;
        copyBtn.textContent = copy[currentLang].copyCmd;
      }

      function applyStatus(data) {
        currentLang = data.language === 'en' ? 'en' : 'zh-CN';
        if (typeof data.manualCommand === 'string') manualCommand = data.manualCommand;
        const t = copy[currentLang];
        const healthy = Boolean(data.healthy);
        const enabled = data.enabled !== false;
        dot.dataset.healthy = String(healthy);
        if (!enabled) {
          title.textContent = t.disabledTitle;
          desc.textContent = t.disabledDesc;
          btn.hidden = true;
          copyBtn.hidden = true;
          cmdBox.hidden = true;
        } else if (data.mode === 'ssh-remote') {
          title.textContent = t.sshTitle;
          desc.textContent = t.sshDesc;
          btn.hidden = true;
          copyBtn.hidden = true;
          cmdBox.hidden = true;
          feedback.hidden = true;
        } else if (healthy) {
          title.textContent = t.activeTitle;
          desc.textContent = t.activeDesc;
          btn.hidden = true;
          copyBtn.hidden = true;
          cmdBox.hidden = true;
          feedback.hidden = true;
        } else {
          title.textContent = t.upgradeTitle;
          desc.textContent = t.upgradeDesc;
          btn.hidden = false;
          if (!busy) btn.textContent = t.relaunch;
          if (manualCommand && !copyBtn.hidden) copyBtn.textContent = t.copyCmd;
        }
      }

      async function poll() {
        try {
          const headers = token ? { 'x-sidecar-token': token } : {};
          const res = await fetch('/api/status' + (token ? '?token=' + encodeURIComponent(token) : ''), { headers });
          if (res.ok) applyStatus(await res.json());
        } catch {}
      }

      copyBtn.addEventListener('click', async () => {
        if (!manualCommand) return;
        try {
          await navigator.clipboard.writeText(manualCommand);
          copyBtn.textContent = copy[currentLang].copiedCmd;
          setTimeout(() => { copyBtn.textContent = copy[currentLang].copyCmd; }, 1600);
        } catch {}
      });

      btn.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        const t = copy[currentLang];
        btn.disabled = true;
        btn.textContent = t.relaunching;
        feedback.hidden = false;
        feedback.textContent = t.relaunchSent;
        clearTimeout(relaunchTimer);
        relaunchTimer = setTimeout(() => {
          busy = false;
          btn.disabled = false;
          btn.textContent = copy[currentLang].relaunch;
          feedback.textContent = copy[currentLang].relaunchTimeout;
          showManualCommand();
        }, 15000);
        try {
          const headers = { 'Content-Type': 'application/json' };
          if (token) headers['x-sidecar-token'] = token;
          const res = await fetch('/api/relaunch' + (token ? '?token=' + encodeURIComponent(token) : ''), { method: 'POST', headers, body: '{}' });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok || payload.scheduled === false) throw new Error(payload.error || 'failed');
        } catch (err) {
          clearTimeout(relaunchTimer);
          busy = false;
          btn.disabled = false;
          btn.textContent = t.relaunch;
          feedback.textContent = err && err.message && err.message !== 'failed' ? t.relaunchFailed + ' (' + err.message + ')' : t.relaunchFailed;
          showManualCommand();
        }
      });

      applyStatus({ healthy: false, enabled: true, language: currentLang });
      void poll();
      setInterval(poll, 3000);
    })();
  </script>
</body>
</html>`;
}

export function startSidecarWebUi({
  port = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0),
  token = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '',
  version = '',
  getStatus,
  onRelaunch,
  env = process.env
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.resolve(async () => {});
  }
  const preloadJs = findPreloadJs(env);
  const authorized = (req, url) => {
    if (url.pathname === '/preload.js') return true;
    if (!token) return true;
    return (req.headers['x-sidecar-token'] || url.searchParams.get('token')) === token;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (req.method !== 'GET' && !authorized(req, url)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(preloadJs);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const current = (await getStatus?.()) || {};
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderAuxPaneHtml({ version, language: current.language || 'zh-CN' }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      if (!authorized(req, url)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const current = (await getStatus?.()) || { healthy: false, enabled: true, language: 'zh-CN' };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ version, ...current }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/relaunch') {
      try {
        const result = await onRelaunch?.();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(() => new Promise(done => server.close(() => done())));
    });
  });
}
