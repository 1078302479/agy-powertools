import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExchangeRateStore, DEFAULT_CNY_RATE, parseExchangeRate } from '../lib/pricing.mjs';
import { nativeSource, startNativeIntegration } from '../lib/native-host.mjs';
import { createSettingsStore } from '../lib/settings.mjs';

test('parseExchangeRate validates primary and secondary FX payloads and rejects bogus values', () => {
  assert.equal(DEFAULT_CNY_RATE, 6.7);
  assert.equal(parseExchangeRate({ result: 'success', base_code: 'USD', rates: { USD: 1, CNY: 7.1234 } }), 7.1234);
  assert.equal(parseExchangeRate({ amount: 1, base: 'USD', date: '2026-11-27', rates: { CNY: 7.05 } }), 7.05);
  assert.equal(parseExchangeRate({ rates: { CNY: 3 } }), 3);
  assert.equal(parseExchangeRate({ rates: { CNY: 15 } }), 15);
  for (const invalid of [
    null,
    undefined,
    '7.2',
    [],
    {},
    { rates: {} },
    { result: 'error', rates: { CNY: 7.1 } },
    { rates: { CNY: '7.1' } },
    { rates: { CNY: Number.NaN } },
    { rates: { CNY: Number.POSITIVE_INFINITY } },
    { rates: { CNY: 0 } },
    { rates: { CNY: -7.1 } },
    { rates: { CNY: 2.99 } },
    { rates: { CNY: 15.01 } }
  ]) {
    assert.equal(parseExchangeRate(invalid), null);
  }
});

test('createExchangeRateStore fetches primary API, caches for 24h, and deduplicates concurrent refreshes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-fx-primary-'));
  try {
    let calls = [];
    let resolvePrimary;
    const store = createExchangeRateStore(dir, {
      fetcher: async (url) => {
        calls.push(url);
        if (calls.length === 1) {
          await new Promise(r => { resolvePrimary = r; });
          return { ok: true, status: 200, text: async () => JSON.stringify({ result: 'success', rates: { CNY: 7.18 } }) };
        }
        return { ok: true, status: 200, json: async () => ({ result: 'success', rates: { CNY: 7.21 } }) };
      }
    });

    assert.deepEqual(store.get(), { rate: 6.7, source: 'fallback', updatedAt: null });
    assert.equal(store.isStale(), true);

    // Concurrent refreshes deduplicate into one network request
    const p1 = store.refresh();
    const p2 = store.refresh();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'https://open.er-api.com/v6/latest/USD');
    resolvePrimary();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.rate, 7.18);
    assert.equal(r2.rate, 7.18);
    assert.equal(r1.source, 'https://open.er-api.com/v6/latest/USD');
    assert.ok(Number.isFinite(r1.updatedAt) && r1.updatedAt > 0);

    // Persisted cleanly in fx-rate.json
    const disk = JSON.parse(readFileSync(join(dir, 'fx-rate.json'), 'utf8'));
    assert.equal(disk.usdToCny, 7.18);
    assert.equal(disk.source, 'https://open.er-api.com/v6/latest/USD');
    assert.equal(disk.updatedAt, r1.updatedAt);

    // Within 24h TTL: zero repeat network calls even on a fresh store instance
    const reloaded = createExchangeRateStore(dir, {
      fetcher: async () => { throw new Error('should not fetch while fresh'); }
    });
    assert.equal(reloaded.isStale(), false);
    assert.equal(reloaded.get().rate, 7.18);
    const cached = await reloaded.refresh();
    assert.equal(cached.rate, 7.18);
    assert.equal(calls.length, 1);

    // Force refresh bypasses TTL
    const forced = await store.refresh({ force: true });
    assert.equal(forced.rate, 7.21);
    assert.equal(calls.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createExchangeRateStore falls back to secondary API when primary fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-fx-secondary-'));
  try {
    const requested = [];
    const store = createExchangeRateStore(dir, {
      fetcher: async (url) => {
        requested.push(url);
        if (url.includes('open.er-api.com')) throw new Error('network down');
        return { ok: true, status: 200, text: async () => JSON.stringify({ amount: 1, base: 'USD', rates: { CNY: 7.09 } }) };
      }
    });
    const res = await store.refresh();
    assert.deepEqual(requested, [
      'https://open.er-api.com/v6/latest/USD',
      'https://api.frankfurter.app/latest?from=USD&to=CNY'
    ]);
    assert.equal(res.rate, 7.09);
    assert.equal(res.source, 'https://api.frankfurter.app/latest?from=USD&to=CNY');
    assert.equal(store.get().rate, 7.09);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createExchangeRateStore silently falls back to 6.7 or existing cache when APIs fail or cache is corrupted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-fx-fallback-'));
  try {
    // 1. Both endpoints fail or return bogus rates -> silent fallback to 6.7 without throwing
    const offlineStore = createExchangeRateStore(dir, {
      fetcher: async (url) => {
        if (url.includes('open.er-api.com')) return { ok: true, status: 200, text: async () => JSON.stringify({ rates: { CNY: 999 } }) };
        return { ok: false, status: 503, text: async () => 'unavailable' };
      }
    });
    const offlineRes = await offlineStore.refresh();
    assert.deepEqual(offlineRes, { rate: 6.7, source: 'fallback', updatedAt: null });

    // 2. Corrupted cache file (invalid JSON, then invalid range) -> silent fallback to 6.7
    writeFileSync(join(dir, 'fx-rate.json'), '{broken json', 'utf8');
    assert.deepEqual(offlineStore.get(), { rate: 6.7, source: 'fallback', updatedAt: null });
    assert.deepEqual(await offlineStore.refresh(), { rate: 6.7, source: 'fallback', updatedAt: null });

    writeFileSync(join(dir, 'fx-rate.json'), JSON.stringify({ usdToCny: 0.5, updatedAt: Date.now(), source: 'bad' }), 'utf8');
    assert.deepEqual(offlineStore.get(), { rate: 6.7, source: 'fallback', updatedAt: null });

    // 3. Stale valid cache is preserved silently when a subsequent refresh goes offline
    const staleTs = Date.now() - 48 * 60 * 60 * 1000;
    writeFileSync(join(dir, 'fx-rate.json'), JSON.stringify({ usdToCny: 7.12, updatedAt: staleTs, source: 'https://open.er-api.com/v6/latest/USD' }), 'utf8');
    const kept = await offlineStore.refresh();
    assert.equal(kept.rate, 7.12);
    assert.equal(kept.updatedAt, staleTs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nativeSource injects __agyFxRate and startNativeIntegration refreshes and broadcasts live FX silently on CNY', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-fx-host-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const portFile = join(dir, 'DevToolsActivePort');
  writeFileSync(portFile, '12355\n/devtools/browser/test\n');
  const originalFetch = globalThis.fetch;
  const target = { id: 'fx-win', type: 'page', title: 'Local - Antigravity', url: 'https://127.0.0.1:5055/c/conv-fx', webSocketDebuggerUrl: 'ws://127.0.0.1:12355/devtools/page/fx-win' };
  globalThis.fetch = async () => ({ ok: true, json: async () => [target] });

  let capturedClient = null;
  const evaluatedExprs = [];
  let fxFetchCount = 0;
  let stop;
  try {
    // Default nativeSource without cache injects 6.7
    const bootDefault = nativeSource('https://127.0.0.1:5055', [], { dataDir });
    assert.ok(bootDefault.includes('globalThis.__agyFxRate=6.7;'));

    const settingsStore = createSettingsStore(dataDir);
    settingsStore.set({ enabled: true, currency: 'USD' });

    const fxStore = createExchangeRateStore(dataDir, {
      fetcher: async () => {
        fxFetchCount++;
        return { ok: true, status: 200, text: async () => JSON.stringify({ result: 'success', rates: { CNY: 7.15 } }) };
      }
    });

    stop = startNativeIntegration({
      portFile,
      dataDir,
      fxStore,
      wsl: false,
      onStatus() {},
      parseSessionData: () => ({ conversationId: 'conv-fx', requests: [], turns: [], errors: [] }),
      discover: async () => ['sampleNativeName'],
      connect: async () => {
        const listeners = new Set();
        const replies = [];
        const client = {
          listeners,
          replies,
          onEvent(fn) { listeners.add(fn); },
          emit(event) { return Promise.all([...listeners].map(fn => fn(event))); },
          socket: { addEventListener() {}, close() {} },
          async send(method, params = {}) {
            if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
            if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-fx' };
            if (method === 'Runtime.evaluate') {
              const expr = String(params.expression || '');
              evaluatedExprs.push(expr);
              if (expr.includes('navigator.userAgent')) return { result: { value: { ua: 'Antigravity/2.35.2', sshKind: '', sshHost: '', title: target.title } } };
              if (expr.includes('globalThis.__agyPowertoolsReceive')) {
                const match = expr.match(/globalThis\.__agyPowertoolsReceive\?\.\((\d+),([\s\S]+)\)$/);
                if (match) replies.push({ id: Number(match[1]), payload: JSON.parse(match[2]) });
                return { result: { value: true } };
              }
              return { result: { value: false } };
            }
            return {};
          }
        };
        capturedClient = client;
        return client;
      }
    });

    await stop.ready;
    assert.equal(fxFetchCount, 0, 'USD boot must not fetch FX rate');
    await capturedClient.emit({ method: 'Runtime.executionContextCreated', params: { context: { id: 20, origin: 'https://127.0.0.1:5055', auxData: { isDefault: true, frameId: 'main-frame' } } } });
    const rpc = async (id, body) => {
      await capturedClient.emit({
        method: 'Runtime.bindingCalled',
        params: { name: '__agyPowertoolsHost', executionContextId: 20, payload: JSON.stringify({ id, ...body }) }
      });
      return capturedClient.replies.find(r => r.id === id)?.payload;
    };

    // Switch currency to CNY -> triggers non-blocking background fetch + live broadcast
    const setReply = await rpc(1, { method: 'settings.set', settings: { currency: 'CNY' } });
    assert.equal(setReply.currency, 'CNY');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(fxFetchCount, 1);
    assert.ok(evaluatedExprs.some(expr => expr.includes('globalThis.__agyPowertoolsSetFxRate?.(7.15)')));

    // Subsequent state and dashboard replies carry live fxRate and nativeSource embeds cached rate
    const stateReply = await rpc(2, { method: 'state', conversationId: 'conv-fx' });
    assert.equal(stateReply.fxRate, 7.15);
    const dashReply = await rpc(3, { method: 'dashboard', force: false });
    assert.equal(dashReply.fxRate, 7.15);
    assert.equal(fxFetchCount, 1, 'Fresh cache must not trigger repeat fetches');
    const bootCached = nativeSource('https://127.0.0.1:5055', [], { dataDir });
    assert.ok(bootCached.includes('globalThis.__agyFxRate=7.15;'));
  } finally {
    await stop?.();
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
