// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TRYING A MARKET'S CODE IN THE BROWSER (kanban #920): the reads as a node makes them, and the code in a worker of its own with the network taken away, stopped
// after 2 s as the node's sandbox stops it. A try for the owner: the market's result is the nodes' own run.
import { MARKET_SOURCE_KIND, MARKET_READ, MARKET_RULE } from '../../../arena-protocol/src/manifest.js';
import { codeOfSource } from '../../../arena-protocol/src/market-rule.js';

const WORKER = `self.onmessage = (e) => {
  const { code, reads, market } = e.data;
  try {
    for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'navigator', 'location']) { try { self[k] = undefined; } catch (x) { /* read-only here */ } }
    const decide = new Function('"use strict";\\n' + code + '\\nreturn decide;')();
    self.postMessage({ ok: true, out: decide(reads, market) });
  } catch (x) { self.postMessage({ ok: false, why: String((x && x.message) || x) }); }
};`;

export function runCode({ code, reads, market }, limitMs = 2000) {
  return new Promise((done) => {
    const url = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }));
    const w = new Worker(url);
    const end = (r) => { clearTimeout(t); w.terminate(); URL.revokeObjectURL(url); done(r); };
    const t = setTimeout(() => end({ ok: false, why: `Stopped after ${limitMs / 1000} s` }), limitMs);
    w.onmessage = (e) => end(e.data);
    w.onerror = (e) => end({ ok: false, why: e.message || 'The code failed' });
    w.postMessage({ code, reads, market });
  });
}

const parsed = (text) => { try { return JSON.parse(text); } catch { return text; } };

function readSocket(r, most = 5, waitMs = 5000) {
  return new Promise((done, fail) => {
    const got = []; const ws = new WebSocket(r.url);
    const end = () => { clearTimeout(t); try { ws.close(); } catch { /* closed */ } done(got); };
    const t = setTimeout(end, waitMs);
    ws.onopen = () => { if (r.subscribe) ws.send(r.subscribe); };
    ws.onmessage = (e) => { got.push(parsed(e.data)); if (got.length >= most) end(); };
    ws.onerror = () => { clearTimeout(t); fail(new Error('the socket refused')); };
  });
}

/** A proposed source's example, read in this browser where the page has no node to ask. */
export async function tryExample(e) {
  const got = await readAll([{ id: 'page', kind: String(e.url).startsWith('wss:') ? 'ws' : 'http', url: e.url }]);
  if (got.why) return { ok: false, why: got.why };
  const out = await runCode({ code: codeOfSource({ kind: MARKET_SOURCE_KIND.URL, reads: [{ id: 'page' }], read: { json: MARKET_READ.JSON, regex: MARKET_READ.PATTERN, text: MARKET_READ.TEXT }[e.read], path: e.path, rule: MARKET_RULE.EQUALS, level: '' }), reads: got.reads, market: { outcomes: [] } });
  if (!out.ok) return { ok: false, why: out.why };
  return out.out === '' ? { ok: false, why: 'The example found nothing' } : { ok: true, value: String(out.out).slice(0, 120) };
}

/** Every declared read now: { reads: { id: value }, why } */
export async function readAll(list) {
  const reads = {};
  for (const r of list) {
    try {
      if (r.kind === 'ws') { reads[r.id] = await readSocket(r); continue; }
      const a = await fetch(r.url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!a.ok) throw new Error(`answered ${a.status}`);
      reads[r.id] = parsed(await a.text());
    } catch (e) { return { reads, why: `${r.id}: ${e.message}` }; }
  }
  return { reads, why: null };
}
