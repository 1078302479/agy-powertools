import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/native-ui.js', import.meta.url), 'utf8');

function matchesSimple(el, part) {
  const s = part.trim();
  if (!s) return false;
  const tokens = s.match(/^[a-zA-Z0-9_-]+|\.[a-zA-Z0-9_-]+|\[[^\]]+\]/g) || [];
  if (!tokens.length) return false;
  for (const tok of tokens) {
    if (tok.startsWith('.')) {
      const classes = String(el.className || '').split(/\s+/).filter(Boolean);
      if (!classes.includes(tok.slice(1))) return false;
    } else if (tok.startsWith('[')) {
      const m = /^\[([^=\]]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(tok);
      if (!m) return false;
      const attrVal = el.getAttribute(m[1]);
      if (m[2] === undefined) {
        if (attrVal === null) return false;
      } else if (attrVal !== m[2]) {
        return false;
      }
    } else if (el.tagName.toLowerCase() !== tok.toLowerCase()) {
      return false;
    }
  }
  return true;
}

function matchesSelector(el, selector) {
  return String(selector || '')
    .split(',')
    .some(group => {
      const parts = group.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return false;
      if (!matchesSimple(el, parts[parts.length - 1])) return false;
      let cur = el.parentElement;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (cur && !matchesSimple(cur, parts[i])) cur = cur.parentElement;
        if (!cur) return false;
        cur = cur.parentElement;
      }
      return true;
    });
}

function createEl(tag = 'div', attrs = {}, text = '') {
  const attrMap = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    parentElement: null,
    children: [],
    className: '',
    isConnected: true,
    _text: text,
    dataset: new Proxy({}, {
      get(_, prop) {
        const attr = 'data-' + String(prop).replace(/[A-Z]/g, c => '-' + c.toLowerCase());
        const v = attrMap.get(attr);
        return v === undefined ? undefined : v;
      },
      set(_, prop, val) {
        const attr = 'data-' + String(prop).replace(/[A-Z]/g, c => '-' + c.toLowerCase());
        attrMap.set(attr, String(val));
        return true;
      }
    }),
    get textContent() {
      if (this.children.length === 0) return this._text;
      return this._text + this.children.map(c => c.textContent).join('');
    },
    set textContent(v) {
      this._text = String(v ?? '');
      this.children = [];
    },
    get firstChild() { return this.children[0] || null; },
    get nextSibling() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      return idx >= 0 ? (this.parentElement.children[idx + 1] || null) : null;
    },
    get nextElementSibling() { return this.nextSibling; },
    getAttribute(k) {
      if (k === 'class') return this.className || null;
      return attrMap.has(k) ? attrMap.get(k) : null;
    },
    setAttribute(k, v) {
      if (k === 'class') this.className = String(v);
      else attrMap.set(k, String(v));
    },
    hasAttribute(k) { return k === 'class' ? Boolean(this.className) : attrMap.has(k); },
    removeAttribute(k) { if (k === 'class') this.className = ''; else attrMap.delete(k); },
    append(...nodes) {
      for (const child of nodes) {
        if (child.parentElement) child.remove();
        child.parentElement = this;
        child.isConnected = this.isConnected;
        this.children.push(child);
      }
      return this;
    },
    insertBefore(child, before = null) {
      if (child.parentElement) child.remove();
      child.parentElement = this;
      child.isConnected = this.isConnected;
      const idx = before ? this.children.indexOf(before) : -1;
      if (idx >= 0) this.children.splice(idx, 0, child);
      else this.children.push(child);
      return child;
    },
    remove() {
      if (this.parentElement) {
        const idx = this.parentElement.children.indexOf(this);
        if (idx >= 0) this.parentElement.children.splice(idx, 1);
      }
      this.parentElement = null;
      this.isConnected = false;
    },
    contains(target) {
      for (let cur = target; cur; cur = cur.parentElement) if (cur === this) return true;
      return false;
    },
    matches(sel) { return matchesSelector(this, sel); },
    closest(sel) {
      for (let cur = this; cur; cur = cur.parentElement) if (cur.matches(sel)) return cur;
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = node => {
        for (const c of node.children) {
          if (c.matches(sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    addEventListener() {}
  };
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

async function mountConversation({ bodyChildren, turns, fiberFor, language = 'zh-CN', displayFor = () => 'flex' }) {
  const head = createEl('head');
  const body = createEl('body');
  const html = createEl('html');
  html.append(head, body);
  for (const child of bodyChildren) body.append(child);
  const toggleAttrs = new Set();
  html.toggleAttribute = (name, force) => {
    const on = force === undefined ? !toggleAttrs.has(name) : Boolean(force);
    if (on) { toggleAttrs.add(name); html.setAttribute(name, ''); }
    else { toggleAttrs.delete(name); html.removeAttribute(name); }
    return on;
  };

  const document = {
    readyState: 'complete',
    head,
    body,
    documentElement: html,
    createElement: tag => createEl(tag),
    addEventListener() {},
    querySelectorAll: sel => body.querySelectorAll(sel),
    querySelector: sel => body.querySelector(sel),
    getElementById: id => body.querySelector(`[id="${id}"]`)
  };

  const intervals = [];
  const mounted = [];
  const observers = [];
  const timeouts = [];
  const context = vm.createContext({
    document,
    location: { pathname: '/c/conv-footer' },
    AbortController,
    getComputedStyle: el => ({ display: displayFor(el) }),
    HU: meta => meta?.stepIndex,
    React: {
      Fragment: Symbol('Fragment'),
      createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
      useEffect() {},
      useSyncExternalStore: (_, snap) => snap()
    },
    ReactDOM: {
      createRoot(mount) {
        mounted.push(mount);
        return {
          render(tree) { mount._rendered = tree; },
          unmount() {}
        };
      }
    },
    HC: ({ children }) => ({ type: 'popover', props: {}, children }),
    IC: ({ children }) => ({ type: 'trigger', props: {}, children }),
    JC: props => ({ type: 'dialog', props, children: props.children || [] }),
    Uy: props => ({ type: 'button', props, children: props.children || [] }),
    k0: props => ({ type: 'disclosure', props, children: [props.trigger] }),
    Sy: props => ({ type: 'tooltip', props, children: props.children || [] }),
    dq: props => ({ type: 'icon', props, children: [] }),
    __agyNativeAdapter: {
      wrap: el => el,
      installPage: () => true,
      onEditChange: () => () => {},
      fiber: el => fiberFor(el)
    },
    __agyInitialSettings: {
      enabled: true,
      timing: true,
      responseBranch: true,
      turnMeta: true,
      language
    },
    __agyPowertoolsHost(raw) {
      const req = JSON.parse(raw);
      queueMicrotask(() => {
        const receive = context.__agyPowertoolsReceive;
        if (typeof receive !== 'function') return;
        if (req.method === 'settings.get') {
          receive(req.id, {
            enabled: true,
            timing: true,
            responseBranch: true,
            turnMeta: true,
            language
          });
        } else if (req.method === 'state') {
          receive(req.id, {
            conversationId: 'conv-footer',
            turns,
            requests: []
          });
        } else {
          receive(req.id, { ok: true });
        }
      });
    },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() {}
      disconnect() {}
    },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval() {},
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
    clearTimeout() {}
  });

  vm.runInContext(source, context);
  await new Promise(r => setTimeout(r, 30));
  const triggerMutationMount = () => {
    for (const obs of observers) obs.cb([{ type: 'childList', addedNodes: [createEl('div')], removedNodes: [], target: body }]);
    while (timeouts.length) timeouts.shift().fn();
  };
  return { context, body, mounted, intervals, triggerMutationMount, dispose: () => context.__agyPowertools?.dispose() };
}

function makeTurn(turnNumber = 1, stepIndexStart = 1, stepIndexEnd = 5) {
  return {
    turnNumber,
    stepIndexStart,
    stepIndexEnd,
    status: 'complete',
    completedAtIso: '2026-11-27T10:00:00Z',
    durationMs: 12000,
    toolCalls: [],
    shortModel: 'Carbon',
    totalInputTokens: 12000,
    newInputTokens: 2000,
    cacheReadTokens: 10000,
    outputTokens: 600,
    cacheHitPercent: 83,
    costUsd: 0.05
  };
}

function responseFiber(stepIndex = 1) {
  return { memoizedProps: { container: { steps: [{ step: { case: 'userInput' }, metadata: { stepIndex } }] } }, return: null };
}

test('classic aria-label="Bad response" direct child inside [data-turn-content] mounts both ResponseActions and ResponseTurnMeta', async () => {
  const turnContent = createEl('div', { 'data-turn-content': '' });
  const response = createEl('div', { 'data-testid': 'agent-response' });
  const toolbarOuter = createEl('div', { class: 'flex items-center' });
  const actionRow = createEl('div', { class: 'flex items-center' });
  actionRow.append(
    createEl('button', { 'aria-label': 'Copy' }),
    createEl('button', { 'aria-label': 'Good response' }),
    createEl('button', { 'aria-label': 'Bad response' })
  );
  const timestamp = createEl('span', {}, '10m ago');
  toolbarOuter.append(actionRow, timestamp);
  turnContent.append(response, toolbarOuter);

  const env = await mountConversation({
    bodyChildren: [turnContent],
    turns: [makeTurn(1, 1, 5)],
    fiberFor: el => el === response ? responseFiber(1) : null
  });

  const branchRoots = actionRow.querySelectorAll('[data-agy-powertools-root="response-actions"]');
  const metaRoots = toolbarOuter.querySelectorAll('[data-agy-powertools-root="turn-meta"]');
  assert.equal(branchRoots.length, 1);
  assert.equal(metaRoots.length, 1);
  assert.equal(metaRoots[0].parentElement, toolbarOuter);
  env.dispose();
});

test('Antigravity 2.35.2 outer-wrapper layout mounts footer outside [data-turn-content] / worked-for-collapsible and preserves responseDoneCache', async () => {
  const turnWrapper = createEl('div', { class: 'single-turn-wrapper' });
  const turnContent = createEl('div', { 'data-turn-content': '' });
  const response = createEl('div', { 'data-testid': 'agent-response' });
  const workedBtn = createEl('button', { 'data-testid': 'worked-for-collapsible' });
  workedBtn.append(createEl('span', {}, 'Worked for 12s'));
  response.append(workedBtn);
  turnContent.append(response);

  const fieldset = createEl('fieldset', { 'aria-label': 'Response actions' });
  const toolbar = createEl('div', { 'data-testid': 'cascade-system-message-toolbar' });
  const outerFlex = createEl('div', { class: 'flex items-center' });
  const actionRow = createEl('div', { class: 'flex shrink-0 items-center' });
  actionRow.append(
    createEl('button', { title: '复制', 'data-agy-original-title': 'Copy' }),
    createEl('button', { title: '有帮助', 'data-agy-original-title': 'Good response' }),
    createEl('button', { title: '无帮助', 'data-agy-original-title': 'Bad response' })
  );
  outerFlex.append(actionRow, createEl('span', {}, '10m ago'));
  toolbar.append(outerFlex);
  fieldset.append(toolbar);
  turnWrapper.append(turnContent, fieldset);

  let responseFiberReads = 0;
  const env = await mountConversation({
    bodyChildren: [turnWrapper],
    turns: [makeTurn(1, 1, 5)],
    fiberFor: el => {
      if (el === response) { responseFiberReads++; return responseFiber(1); }
      return null;
    }
  });

  assert.equal(actionRow.querySelectorAll('[data-agy-powertools-root="response-actions"]').length, 1);
  assert.equal(outerFlex.querySelectorAll('[data-agy-powertools-root="turn-meta"]').length, 1);
  const readsAfterInitial = responseFiberReads;
  assert.ok(readsAfterInitial >= 1);

  // Subsequent mutation-triggered mount cycles must hit responseDoneCache without re-walking fiber
  env.triggerMutationMount();
  env.triggerMutationMount();
  assert.equal(responseFiberReads, readsAfterInitial);

  env.context.__agyPowertools.dispose();
  assert.equal(actionRow.querySelectorAll('[data-agy-powertools-root="response-actions"]').length, 0);
});

test('missing aria-label matches icon ligature, data-tooltip-id tooltip text, and React fiber name/tooltip props', async () => {
  // Case 1: child icon ligature (thumb_down / thumb_up / content_copy)
  {
    const turn = createEl('div', { class: 'turn' });
    const response = createEl('div', { 'data-testid': 'agent-response' });
    const actionRow = createEl('div', { class: 'flex items-center' });
    const copyBtn = createEl('button');
    copyBtn.append(createEl('span', { class: 'icon' }, 'content_copy'));
    const badBtn = createEl('button');
    badBtn.append(createEl('span', { class: 'icon' }, 'thumb_down'));
    actionRow.append(copyBtn, badBtn);
    turn.append(response, actionRow);

    const env = await mountConversation({
      bodyChildren: [turn],
      turns: [makeTurn(1, 1, 5)],
      fiberFor: el => el === response ? responseFiber(1) : null
    });
    assert.equal(actionRow.querySelectorAll('[data-agy-powertools-root="response-actions"]').length, 1);
    assert.equal(actionRow.querySelectorAll('[data-agy-powertools-root="turn-meta"]').length, 1);
    env.dispose();
  }

  // Case 2: linked tooltip text via data-tooltip-id
  {
    const turn = createEl('div', { class: 'turn' });
    const response = createEl('div', { 'data-testid': 'agent-response' });
    const actionRow = createEl('div', { class: 'flex items-center' });
    const goodBtn = createEl('button', { 'data-tooltip-id': 'tip-good-1' });
    const copyBtn = createEl('button', { 'data-tooltip-id': 'tip-copy-1' });
    actionRow.append(copyBtn, goodBtn);
    const tipGood = createEl('div', { id: 'tip-good-1', role: 'tooltip' }, '有帮助');
    turn.append(response, actionRow);

    const env = await mountConversation({
      bodyChildren: [turn, tipGood],
      turns: [makeTurn(1, 1, 5)],
      fiberFor: el => el === response ? responseFiber(1) : null
    });
    assert.equal(actionRow.querySelectorAll('[data-agy-powertools-root="response-actions"]').length, 1);
    assert.equal(actionRow.querySelectorAll('[data-agy-powertools-root="turn-meta"]').length, 1);
    env.dispose();
  }

  // Case 3: React fiber tooltip prop and child icon name prop (e.g. Antigravity 2.35.2 Uy + dq)
  for (const mode of ['tooltip-prop', 'child-icon-name']) {
    const turn = createEl('div', { class: 'turn' });
    const response = createEl('div', { 'data-testid': 'agent-response' });
    const actionRow = createEl('div', { class: 'flex items-center' });
    const btn1 = createEl('button');
    const btn2 = createEl('button');
    actionRow.append(btn1, btn2);
    turn.append(response, actionRow);

    const env = await mountConversation({
      bodyChildren: [turn],
      turns: [makeTurn(1, 1, 5)],
      fiberFor: el => {
        if (el === response) return responseFiber(1);
        if (el === btn2) {
          if (mode === 'tooltip-prop') {
            return { memoizedProps: {}, return: { memoizedProps: { tooltip: 'Bad response' }, return: null } };
          }
          return { memoizedProps: {}, return: null, child: { memoizedProps: { name: 'thumb_down' }, child: null, sibling: null } };
        }
        return null;
      }
    });
    assert.equal(actionRow.querySelectorAll('[data-agy-powertools-root="response-actions"]').length, 1, mode);
    assert.equal(actionRow.querySelectorAll('[data-agy-powertools-root="turn-meta"]').length, 1, mode);
    env.dispose();
  }
});

test('single-button tooltip wrapper (<span><button>) unwraps cleanly to the multi-button horizontal actionRow', async () => {
  const turn = createEl('div', { class: 'turn' });
  const response = createEl('div', { 'data-testid': 'agent-response' });
  const outerFlex = createEl('div', { class: 'flex items-center' });
  const actionRow = createEl('div', { class: 'flex shrink-0 items-center' });

  const wrap1 = createEl('span', { class: 'tooltip-trigger' });
  wrap1.append(createEl('button', { 'aria-label': 'Copy' }));
  const wrap2 = createEl('span', { class: 'tooltip-trigger' });
  wrap2.append(createEl('button', { 'aria-label': 'Good response' }));
  const wrap3 = createEl('span', { class: 'tooltip-trigger' });
  wrap3.append(createEl('button', { 'aria-label': 'Bad response' }));

  actionRow.append(wrap1, wrap2, wrap3);
  outerFlex.append(actionRow, createEl('span', {}, '5m ago'));
  turn.append(response, outerFlex);

  const env = await mountConversation({
    bodyChildren: [turn],
    turns: [makeTurn(1, 1, 5)],
    fiberFor: el => el === response ? responseFiber(1) : null
  });

  // Mounted onto actionRow (NOT trapped inside wrap3) and meta mounted onto outerFlex
  assert.equal(wrap3.querySelectorAll('[data-agy-powertools-root="response-actions"]').length, 0);
  assert.equal(actionRow.children.filter(c => c.getAttribute('data-agy-powertools-root') === 'response-actions').length, 1);
  assert.equal(outerFlex.children.filter(c => c.getAttribute('data-agy-powertools-root') === 'turn-meta').length, 1);
  env.dispose();
});

test('guards prevent leaking into sibling turns, [data-markdown-root] code-block Copy buttons, or [data-testid="user-input-step"]', async () => {
  const conversationList = createEl('div', { class: 'turns-list' });

  // Turn 1: has NO response footer, only a user-input-step Copy button and a markdown code-block Copy button
  const turn1 = createEl('div', { class: 'turn-1' });
  const userStep = createEl('div', { 'data-testid': 'user-input-step' });
  const userActions = createEl('div', { class: 'user-actions' });
  userActions.append(createEl('button', { 'aria-label': 'Copy' }), createEl('button', { 'aria-label': 'Bad response' }));
  userStep.append(userActions);

  const response1 = createEl('div', { 'data-testid': 'agent-response' });
  const markdownRoot = createEl('div', { 'data-markdown-root': '' });
  const codeHeader = createEl('div', { class: 'code-header' });
  codeHeader.append(createEl('button', { 'aria-label': 'Copy' }));
  markdownRoot.append(codeHeader);
  response1.append(markdownRoot);
  turn1.append(userStep, response1);

  // Turn 2 (sibling): HAS a real footer
  const turn2 = createEl('div', { class: 'turn-2' });
  const response2 = createEl('div', { 'data-testid': 'agent-response' });
  const actionRow2 = createEl('div', { class: 'flex items-center' });
  actionRow2.append(
    createEl('button', { 'aria-label': 'Copy' }),
    createEl('button', { 'aria-label': 'Good response' }),
    createEl('button', { 'aria-label': 'Bad response' })
  );
  turn2.append(response2, actionRow2);

  conversationList.append(turn1, turn2);

  const env = await mountConversation({
    bodyChildren: [conversationList],
    turns: [makeTurn(1, 1, 5), makeTurn(2, 6, 10)],
    fiberFor: el => {
      if (el === response1) return responseFiber(1);
      if (el === response2) return responseFiber(6);
      return null;
    }
  });

  // Turn 1 must NOT mount on userActions, codeHeader, or leak into turn2's actionRow2
  assert.equal(userActions.querySelectorAll('[data-agy-powertools-root="response-actions"]').length, 0);
  assert.equal(codeHeader.querySelectorAll('[data-agy-powertools-root="response-actions"]').length, 0);
  assert.equal(turn1.querySelectorAll('[data-agy-powertools-root="turn-meta"]').length, 0);

  // Turn 2 mounts exactly once for turn 2 alone
  assert.equal(actionRow2.querySelectorAll('[data-agy-powertools-root="response-actions"]').length, 1);
  assert.equal(actionRow2.querySelectorAll('[data-agy-powertools-root="turn-meta"]').length, 1);
  env.dispose();

  // Single-turn conversation must NOT cross into conversation-view / composer card buttons
  const view = createEl('div', { 'data-testid': 'conversation-view' });
  const soloTurn = createEl('div', { class: 'solo-turn' });
  const soloResp = createEl('div', { 'data-testid': 'agent-response' });
  soloTurn.append(soloResp);
  const composer = createEl('div', { class: 'surface-composer-card' });
  const composerBtns = createEl('div', { class: 'flex items-center' });
  composerBtns.append(createEl('button', { 'aria-label': 'Copy' }), createEl('button', { 'aria-label': 'Bad response' }));
  composer.append(composerBtns);
  view.append(soloTurn, composer);

  const soloEnv = await mountConversation({
    bodyChildren: [view],
    turns: [makeTurn(1, 1, 5)],
    fiberFor: el => el === soloResp ? responseFiber(1) : null
  });
  assert.equal(composerBtns.querySelectorAll('[data-agy-powertools-root="response-actions"]').length, 0);
  assert.equal(composerBtns.querySelectorAll('[data-agy-powertools-root="turn-meta"]').length, 0);
  soloEnv.dispose();
});

test('Vietnamese WORKED_RE ("Đã xử lý") and UPDATES_RE ("cập nhật") match in-place worked-for collapsible label', async () => {
  const turn = createEl('div', { 'data-turn-content': '' });
  const response = createEl('div', { 'data-testid': 'agent-response' });
  const workedBtn = createEl('button', { 'data-testid': 'worked-for-collapsible' });
  const mainSpan = createEl('span', {}, 'Đã xử lý 12s');
  const updSpan = createEl('span', {}, '3 cập nhật');
  workedBtn.append(mainSpan, updSpan);
  response.append(workedBtn);
  turn.append(response);

  const env = await mountConversation({
    bodyChildren: [turn],
    turns: [makeTurn(1, 1, 5)],
    fiberFor: el => el === response ? responseFiber(1) : null,
    language: 'zh-CN'
  });

  assert.equal(mainSpan.textContent, '用时 12秒 3 条进度');
  assert.equal(updSpan.textContent, '');
  assert.doesNotMatch(mainSpan.textContent, /[\u00b7\u2022\u2027\u30fb]/);
  env.dispose();
});
