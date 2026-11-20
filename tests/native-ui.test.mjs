import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/native-ui.js', import.meta.url), 'utf8');

function page(ready = false) {
  const callbacks = new Map();
  const nodes = [];
  const node = () => ({
    dataset: {}, isConnected: false,
    append(child) { child.isConnected = true; },
    setAttribute() {}, addEventListener() {}, remove() { this.isConnected = false; }
  });
  const attrs = new Set();
  const document = {
    readyState: ready ? 'complete' : 'loading',
    head: ready ? node() : null, body: ready ? node() : null,
    documentElement: { toggleAttribute(name, force) { if (force === undefined ? !attrs.has(name) : force) attrs.add(name); else attrs.delete(name); }, removeAttribute(name) { attrs.delete(name); }, hasAttribute(name) { return attrs.has(name); } },
    createElement() { const element = node(); nodes.push(element); return element; },
    addEventListener(event, callback) { if (!callbacks.has(event)) callbacks.set(event, []); callbacks.get(event).push(callback); },
    querySelectorAll() { return []; },
    querySelector() { return null; }
  };
  const context = vm.createContext({
    document, location: { pathname: '/' }, AbortController,
    React: { createElement() { return {}; } }, ReactDOM: { createRoot() { throw new Error('No DOM roots expected'); } }, HC() {},
    __agyNativeAdapter: { wrap() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}
  });
  return { context, document, nodes, callbacks, node };
}

test('new-document injection waits for head and body and initializes exactly once', () => {
  const p = page();
  vm.runInContext(source, p.context);
  vm.runInContext(source, p.context);
  assert.equal(p.nodes.length, 0);
  assert.equal(p.context.__agyPowertools, undefined);
  assert.equal(p.callbacks.get('DOMContentLoaded').length, 1);
  p.document.head = p.node(); p.document.body = p.node();
  p.callbacks.get('DOMContentLoaded')[0]();
  assert.equal(p.context.__agyPowertools.status.healthy, true);
  assert.equal(p.context.__agyPowertoolsPending, undefined);
  assert.equal(p.nodes.length, 1);
  vm.runInContext(source, p.context);
  assert.equal(p.nodes.length, 1);
});

test('already-loaded injection initializes without waiting and disposes cleanly', () => {
  const p = page(true);
  vm.runInContext(source, p.context);
  assert.equal(p.callbacks.has('DOMContentLoaded'), false);
  assert.equal(p.context.__agyPowertools.status.healthy, true);
  assert.equal(p.document.documentElement.hasAttribute('data-agy-keep-outline'), true);
  p.context.__agyPowertools.dispose();
  assert.equal(p.context.__agyPowertools, undefined);
  assert.equal(p.document.documentElement.hasAttribute('data-agy-keep-outline'), false);
  assert.ok(p.nodes.every(n => !n.isConnected));
});

test('multi-pane conversations with multiple composers stay healthy without triggering reload loops', () => {
  const p = page(true);
  p.context.location.pathname = '/c/conv-1';
  const renderedRings = [];
  p.context.ReactDOM = { createRoot(mount) { renderedRings.push(mount); return { render() {}, unmount() {} }; } };
  p.context.getComputedStyle = () => ({ display: 'flex' });
  const makeComposerTrigger = () => {
    const parent = { insertBefore(child) { child.isConnected = true; } };
    return { isConnected: true, parentElement: parent, nextSibling: null, closest: sel => sel === '.surface-composer-card' ? {} : null };
  };
  const twoTriggers = [makeComposerTrigger(), makeComposerTrigger()];
  let ringNodes = [{}, {}];
  p.document.querySelectorAll = sel => {
    if (sel === '[data-testid="model-selector-trigger"]') return twoTriggers;
    if (sel === '[data-testid="agy-context-ring-trigger"]') return ringNodes;
    return [];
  };
  p.context.__agyInitialSettings = { enabled: true, contextRing: true };
  vm.runInContext(source, p.context);
  assert.equal(renderedRings.length, 2);
  assert.equal(p.context.__agyPowertools.status.healthy, true);
  p.context.__agyPowertools.dispose();
});

test('accountSwitcher respects multiAccount master switch, toggles native settings hide attr, and cleans up on dispose', () => {
  const pOff = page(true);
  const offMounts = [];
  const offSettingsBtn = { isConnected: true, parentElement: { insertBefore(node) { node.isConnected = true; offMounts.push(node); } } };
  pOff.context.ReactDOM = { createRoot() { return { render() {}, unmount() {} }; } };
  pOff.context.__agyNativeAdapter.installPage = () => true;
  pOff.context.__agyPanels = () => ({ Page: () => null, Sidebar: () => null, AccountSwitcher: () => null, dispose() {} });
  pOff.document.querySelector = sel => sel === '[data-testid="settings-button"]' ? offSettingsBtn : null;
  pOff.context.__agyInitialSettings = { enabled: true, multiAccount: false, accountSwitcher: true };
  vm.runInContext(source, pOff.context);
  assert.equal(offMounts.length, 0);
  assert.equal(pOff.document.documentElement.hasAttribute('data-agy-account-switcher'), false);
  pOff.context.__agyPowertools.dispose();

  const p = page(true);
  const mountedNodes = [];
  const settingsBtn = {
    isConnected: true,
    parentElement: {
      children: [],
      insertBefore(node, before) {
        node.isConnected = true;
        mountedNodes.push({ node, before });
      }
    }
  };
  p.context.ReactDOM = { createRoot() { return { render() {}, unmount() {} }; } };
  p.context.__agyNativeAdapter.installPage = () => true;
  p.context.__agyPanels = () => ({
    Page: () => null,
    Sidebar: () => null,
    AccountSwitcher: () => null,
    dispose() {}
  });
  p.document.querySelector = sel => sel === '[data-testid="settings-button"]' ? settingsBtn : null;
  p.context.__agyInitialSettings = { enabled: true, multiAccount: true, accountSwitcher: true };
  vm.runInContext(source, p.context);
  assert.equal(mountedNodes.length, 1);
  assert.equal(mountedNodes[0].node.dataset.agyPowertoolsRoot, 'account-switcher');
  assert.equal(mountedNodes[0].before, settingsBtn);
  assert.equal(p.document.documentElement.hasAttribute('data-agy-account-switcher'), true);
  p.context.__agyPowertools.dispose();
  assert.equal(mountedNodes[0].node.isConnected, false);
  assert.equal(p.document.documentElement.hasAttribute('data-agy-account-switcher'), false);
});

test('renderRoot does not repeatedly call insertBefore when before equals existing mount', () => {
  const p = page(true);
  let insertCount = 0;
  const link = { isConnected: true, nextSibling: null };
  const parent = {
    insertBefore(node) {
      insertCount++;
      node.isConnected = true;
      link.nextSibling = node;
    }
  };
  link.parentElement = parent;
  let observerCb = null;
  p.context.MutationObserver = class {
    constructor(cb) { observerCb = cb; }
    observe() {}
    disconnect() {}
  };
  let scheduled = null;
  p.context.setTimeout = cb => { scheduled = cb; return 1; };
  p.context.ReactDOM = { createRoot() { return { render() {}, unmount() {} }; } };
  p.context.__agyNativeAdapter.installPage = () => true;
  p.context.__agyPanels = () => ({ Page: () => null, Sidebar: () => null, dispose() {} });
  p.document.querySelector = sel => sel === 'a[href="/customizations"]' ? link : null;
  p.context.__agyInitialSettings = { enabled: true };
  vm.runInContext(source, p.context);
  assert.equal(insertCount, 1);
  // Trigger a second mount cycle after link.nextSibling points to entry.mount
  observerCb?.([{ target: { closest: () => null } }]);
  scheduled?.();
  assert.equal(insertCount, 1);
  p.context.__agyPowertools.dispose();
});

test('Powertools sidebar entry repositions after /customizations once /customizations mounts later', () => {
  const p = page(true);
  const children = [];
  const syncSiblings = () => {
    for (let i = 0; i < children.length; i++) children[i].nextSibling = children[i + 1] || null;
  };
  let insertCount = 0;
  const navContainer = {
    isConnected: true,
    insertBefore(node, before) {
      insertCount++;
      const existingIdx = children.indexOf(node);
      if (existingIdx >= 0) children.splice(existingIdx, 1);
      node.isConnected = true;
      if (before && children.includes(before)) children.splice(children.indexOf(before), 0, node);
      else children.push(node);
      syncSiblings();
    }
  };
  const newChat = { id: 'new-chat', isConnected: true, parentElement: navContainer, nextSibling: null };
  children.push(newChat);
  let custLink = null;
  let observerCb = null;
  let scheduled = null;
  p.context.MutationObserver = class {
    constructor(cb) { observerCb = cb; }
    observe() {}
    disconnect() {}
  };
  p.context.setTimeout = cb => { scheduled = cb; return 1; };
  p.context.ReactDOM = { createRoot() { return { render() {}, unmount() {} }; } };
  p.context.__agyNativeAdapter.installPage = () => true;
  p.context.__agyPanels = () => ({ Page: () => null, Sidebar: () => null, dispose() {} });
  p.document.querySelector = sel => {
    if (sel === 'a[href="/customizations"]') return custLink;
    if (sel === '[data-testid="sidebar-navigation-items"]') return navContainer;
    return null;
  };
  p.context.__agyInitialSettings = { enabled: true };
  vm.runInContext(source, p.context);
  assert.equal(children.length, 2);
  assert.equal(children[1].dataset.agyPowertoolsRoot, 'management');

  // Now native React mounts Automations and Customizations after Powertools
  const automations = { id: 'auto', isConnected: true, parentElement: navContainer, nextSibling: null };
  custLink = { id: 'cust', isConnected: true, parentElement: navContainer, nextSibling: null };
  children.push(automations, custLink);
  syncSiblings();
  observerCb?.([{ target: { closest: () => null } }]);
  scheduled?.();
  assert.deepEqual(children.map(c => c.id || c.dataset?.agyPowertoolsRoot), ['new-chat', 'auto', 'cust', 'management']);
  const countAfterMove = insertCount;

  // Next mount tick must be a no-op (no flicker loop)
  observerCb?.([{ target: { closest: () => null } }]);
  scheduled?.();
  assert.equal(insertCount, countAfterMove);

  p.context.__agyPowertools.dispose();
  assert.equal(children.find(c => c.dataset?.agyPowertoolsRoot === 'management')?.isConnected, false);
});
