import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function resolveTurnExecution(turn, execution, conversationId) {
  if (!turn || !execution || !conversationId || execution.conversationId !== conversationId ||
      !Number.isInteger(execution.turnStartStepIndex) ||
      execution.turnStartStepIndex !== turn.stepIndexStart) return turn;
  // An ERROR_MESSAGE can be a retried request. Only native lifecycle state
  // tells us whether the whole invocation has actually stopped.
  let status;
  if (execution.status === 2 || execution.status === 4) status = 'running';
  else if (execution.status === 3) status = 'canceling';
  else if (execution.status === 1) {
    const reason = execution.terminationReason;
    if (reason === 2) status = 'stopped';
    else if ([1, 3, 6, 11].includes(reason)) status = 'error';
    else if ([4, 8, 10].includes(reason)) status = 'complete';
    else status = turn.status === 'running' || turn.status === 'canceling' ? 'stopped' : turn.status;
  }
  if (!status) return turn;
  return {...turn, status, ...(['running', 'canceling'].includes(status) ? {completedAtMs: null} : {})};
}

export function parseChecklist(markdown) {
  const lines = String(markdown).split('\n');
  const matches = lines.flatMap((line, index) => {
    const match = line.match(/^(\s*)[-*+]\s+\[([ xX/\-])\]\s+(.+)/);
    return match ? [{ index, depth: match[1].length, status: /x/i.test(match[2]) ? 'complete' : /[/\-]/.test(match[2]) ? 'running' : 'pending', title: match[3].replace(/\*\*|`/g, '').trim() }] : [];
  });
  // Count leaf tasks so a parent and its children do not count the same work twice.
  return matches.filter((task, index) => !matches[index + 1] || matches[index + 1].depth <= task.depth).map(({ title, status }) => ({ title, status }));
}

export function readProgress(appDataDir, conversationId, turns, steps, now = Date.now()) {
  const latest = turns.at(-1);
  let tasks = [], updatedAtMs = null, source = '';
  try {
    const path = join(appDataDir, 'brain', conversationId, 'task.md');
    updatedAtMs = statSync(path).mtimeMs;
    tasks = parseChecklist(readFileSync(path, 'utf8')); source = 'task.md';
  } catch { /* No task artifact has been written. */ }
  const boundaries = steps.filter(s => latest && s.step_index >= latest.stepIndexStart).flatMap(s => (s.tool_calls || []).filter(c => /task_boundary$/.test(c.name)).map(c => ({ ...c.args, stepIndex: s.step_index })));
  const boundary = boundaries.at(-1);
  const recentCalls = latest?.toolCalls || [];
  const recentActivity = recentCalls.slice(-4).map(call => {
    const startedAtMs = Date.parse(call.startedAtIso), completedAtMs = Date.parse(call.completedAtIso);
    return { id:call.id, label:call.itemLabel, detail:call.detailTitle, groupKey:call.groupKey,
      status:Number.isFinite(completedAtMs)?'complete':latest?.status==='running'&&Number.isFinite(startedAtMs)?'running':'recorded',
      durationMs:call.durationMs ?? null };
  });
  const active = recentActivity.find(call => call.status === 'running');
  const end = ['running','canceling'].includes(latest?.status) ? now : latest?.completedAtMs;
  const elapsedMs = Number.isFinite(latest?.startedAtMs)&&Number.isFinite(end)?Math.max(0,end-latest.startedAtMs):null;
  const completed = tasks.filter(t => t.status === 'complete').length;
  return {
    tasks, completed, total: tasks.length, percent: tasks.length ? Math.round(completed / tasks.length * 100) : null,
    title: boundary?.TaskName || '', current: boundary?.TaskStatus || active?.label || '',
    status: latest?.status || 'idle', source, updatedAtMs, startedAtMs: latest?.startedAtMs || null,
    toolCount: recentCalls.length, recentActivity, elapsedMs,
    stale: !!(latest?.startedAtMs && updatedAtMs && updatedAtMs < latest.startedAtMs)
  };
}
