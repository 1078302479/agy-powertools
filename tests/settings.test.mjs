import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSettingsStore, DEFAULT_SETTINGS } from '../lib/settings.mjs';

test('settings persist, merge safely, and reject unknown options without changing saved data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agy-settings-'));
  try {
    const store = createSettingsStore(directory);
    assert.deepEqual(store.get(), DEFAULT_SETTINGS);
    store.set({ compact: false, timing: false });
    assert.equal(createSettingsStore(directory).get().compact, false);
    assert.equal(store.get().messageEdit, true);
    store.set({ enabled: false }); assert.equal(store.get().enabled, false);
    assert.equal(DEFAULT_SETTINGS.contextLimit, 0);
    store.set({language:'en',contextLimit:1000000});assert.equal(store.get().contextLimit,1000000);assert.equal(store.get().language,'en');
    store.set({contextLimit:256000});assert.equal(store.get().contextLimit,256000);
    store.set({contextLimit:0});assert.equal(store.get().contextLimit,0);
    const before = readFileSync(join(directory, 'settings.json'), 'utf8');
    for (const value of [{ compact: 'false' }, { unknown: true }, { toString: false }, {language:'invalid'}, {contextLimit:999999}, []]) assert.throws(() => store.set(value), /设置/);
    assert.equal(readFileSync(join(directory, 'settings.json'), 'utf8'), before);
    store.set(DEFAULT_SETTINGS); assert.deepEqual(store.get(), DEFAULT_SETTINGS);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
