// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2935 (feedback #264): the dashboard's #owner-handoff took an owner seed from ANY page that opened it and wrote it over the key this
// browser kept - the owner page's guards of #1433 were missing here. The handoff runs as the page serves it (dashboardHtml), on fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardHtml } from '../src/dashboard.js';

const html = dashboardHtml();
const a = html.indexOf("if(location.hash==='#owner-handoff'"), b = html.indexOf("window.opener.postMessage({type:'arena-owner-ready'},'*')}", a);
const code = html.slice(a, b) + "window.opener.postMessage({type:'arena-owner-ready'},'*')}";

function run(origin, kept = {}) {
  const store = { ...kept }, opener = { postMessage() {} };
  let on = null;
  const window = { opener }, location = { hash: '#owner-handoff', pathname: '/node/x/dashboard', search: '' };
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  new Function('window', 'location', 'localStorage', 'addEventListener', 'history', code)(window, location, localStorage, (t, f) => { on = f; }, { replaceState() {} });
  on({ source: opener, origin, data: { type: 'arena-owner-key', kind: 'seed', seed: 'ab'.repeat(32) } });
  return store;
}

test('#2935 a seed from a foreign site is never kept', () => {
  assert.deepEqual(run('https://evil.example'), {});
  assert.deepEqual(run('http://127.0.0.1.evil.example'), {});
});

test('#2935 a seed never replaces a key already kept', () => {
  assert.deepEqual(run('http://127.0.0.1:18080', { 'arena-owner-seed:/node/x': 'cd'.repeat(32) }), { 'arena-owner-seed:/node/x': 'cd'.repeat(32) });
});

test('#2935 the installer on this machine still hands the key over', () => {
  assert.deepEqual(run('http://127.0.0.1:18080'), { 'arena-owner-seed:/node/x': 'ab'.repeat(32) });
  assert.deepEqual(run('http://localhost:5173'), { 'arena-owner-seed:/node/x': 'ab'.repeat(32) });
});
