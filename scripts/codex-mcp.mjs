#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectCodexHealth, runCodexTask } from '../lib/codex-bridge.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
let serverVersion = '0.1.0';
try {
  serverVersion = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version || serverVersion;
} catch {}

const TOOLS = [
  {
    name: 'codex_doctor',
    description: 'Check local Codex CLI installation path (including ChatGPT.app bundled binary), version, ~/.codex config status, and Agy Powertools proxy inheritance.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'codex_run',
    description: 'Delegate a coding, debugging, or analysis task to local OpenAI Codex CLI (non-interactive codex exec --json) and return the sessionId, final response, modified files, and token usage.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Clear task instructions and acceptance criteria for Codex.' },
        cwd: { type: 'string', description: 'Absolute path to the target workspace directory.' },
        sandbox: {
          type: 'string',
          enum: ['read-only', 'workspace-write', 'danger-full-access'],
          description: 'Sandbox permission mode. Defaults to the configured Agy Powertools setting (workspace-write).'
        },
        model: { type: 'string', description: 'Optional model override (defaults to ~/.codex/config.toml or Powertools setting).' },
        worktree: { type: 'boolean', description: 'If true, run Codex inside an isolated managed Git worktree.' },
        addDirs: { type: 'array', items: { type: 'string' }, description: 'Additional writable directories alongside cwd.' },
        skipGitRepoCheck: { type: 'boolean', description: 'Allow running outside a Git repository.' },
        timeoutSeconds: { type: 'integer', minimum: 10, maximum: 1800, description: 'Execution timeout in seconds (default 600).' }
      },
      required: ['prompt'],
      additionalProperties: false
    }
  },
  {
    name: 'codex_resume',
    description: 'Continue an existing Codex CLI session by sessionId for multi-turn follow-up instructions or fixes.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session / thread ID returned by a previous codex_run call.' },
        prompt: { type: 'string', description: 'Follow-up instructions for the existing Codex session.' },
        cwd: { type: 'string', description: 'Absolute path to the workspace directory.' },
        model: { type: 'string', description: 'Optional model override.' },
        timeoutSeconds: { type: 'integer', minimum: 10, maximum: 1800, description: 'Execution timeout in seconds (default 600).' }
      },
      required: ['sessionId', 'prompt'],
      additionalProperties: false
    }
  },
  {
    name: 'codex_review',
    description: 'Run an independent read-only code review using native codex exec review against uncommitted changes, a base branch, or a specific commit.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Absolute path to the Git repository to review.' },
        uncommitted: { type: 'boolean', description: 'Review staged, unstaged, and untracked changes (the default without a target or custom prompt).' },
        base: { type: 'string', description: 'Optional base branch name to diff against.' },
        commit: { type: 'string', description: 'Optional commit SHA to review.' },
        prompt: { type: 'string', description: 'Custom review instructions. Cannot be combined with base, commit, or uncommitted: true.' },
        model: { type: 'string', description: 'Optional model override.' },
        timeoutSeconds: { type: 'integer', minimum: 10, maximum: 1800, description: 'Execution timeout in seconds (default 600).' }
      },
      additionalProperties: false
    }
  }
];

const taskModes = new Map([
  ['codex_run', 'run'],
  ['codex_resume', 'resume'],
  ['codex_review', 'review']
]);
const activeTasks = new Map();

function formatToolResult(payload, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError
  };
}

let useHeaderFraming = false;
function writeMessage(msg) {
  const json = JSON.stringify(msg);
  if (useHeaderFraming) {
    const len = Buffer.byteLength(json, 'utf8');
    process.stdout.write(`Content-Length: ${len}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

async function handleRequest(req) {
  const { id, method, params } = req || {};
  if (typeof method !== 'string') return;
  if (method === 'notifications/cancelled') {
    activeTasks.get(params?.requestId)?.abort();
    return;
  }
  if (method.startsWith('notifications/')) return;

  try {
    if (method === 'initialize') {
      const protocolVersion = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05';
      writeMessage({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'agy-codex', version: serverVersion }
        }
      });
      return;
    }

    if (method === 'ping') {
      writeMessage({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'tools/list') {
      writeMessage({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }

    if (method === 'tools/call') {
      if (id === undefined) return;
      const name = params?.name;
      let result;
      if (name === 'codex_doctor') {
        const health = inspectCodexHealth();
        result = formatToolResult(health, !health.found || !health.enabled);
      } else if (taskModes.has(name)) {
        if (activeTasks.has(id)) {
          writeMessage({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Request ID is already active' } });
          return;
        }
        const properties = TOOLS.find(tool => tool.name === name).inputSchema.properties;
        const args = params.arguments ?? {};
        if (typeof args !== 'object' || Array.isArray(args) ||
            Object.keys(args).some(key => !Object.hasOwn(properties, key))) {
          writeMessage({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Tool arguments must be an object containing only declared properties' } });
          return;
        }
        const taskArgs = Object.fromEntries(Object.keys(properties)
          .filter(key => Object.hasOwn(args, key))
          .map(key => [key, args[key]]));
        const controller = new AbortController();
        activeTasks.set(id, controller);
        try {
          const out = await runCodexTask({ ...taskArgs, mode: taskModes.get(name), signal: controller.signal });
          if (controller.signal.aborted) return;
          result = formatToolResult(out, !out.ok);
        } finally {
          activeTasks.delete(id);
        }
      } else {
        writeMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } });
        return;
      }
      writeMessage({ jsonrpc: '2.0', id, result });
      return;
    }

    if (id !== undefined) {
      writeMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    if (id !== undefined) {
      writeMessage({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: err?.message || 'Internal error' }
      });
    }
  }
}

let buffer = Buffer.alloc(0);
function drainBuffer() {
  while (buffer.length > 0) {
    const startStr = buffer.subarray(0, Math.min(32, buffer.length)).toString('utf8');
    if (/^Content-Length:/i.test(startStr)) {
      useHeaderFraming = true;
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
      const len = Number(match[1]);
      const total = headerEnd + 4 + len;
      if (buffer.length < total) return;
      const body = buffer.subarray(headerEnd + 4, total).toString('utf8');
      buffer = buffer.subarray(total);
      try { void handleRequest(JSON.parse(body)); } catch {}
    } else {
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const line = buffer.subarray(0, nl).toString('utf8').trim();
      buffer = buffer.subarray(nl + 1);
      if (!line) continue;
      try { void handleRequest(JSON.parse(line)); } catch {}
    }
  }
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  drainBuffer();
});
process.stdin.on('end', () => {
  for (const controller of activeTasks.values()) controller.abort();
});
