// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Every listed source's example, read for real: run by hand (node test/market-sources-live.mjs), not in the suite, as it needs the internet.
import { SOURCES } from '../../arena-protocol/src/market-sources.js';
import { MARKET_HOSTS } from '../../arena-protocol/src/market-check.js';
const value = (s, t) => {
  if (s.read === 'text') return t.trim().slice(0, 40);
  if (s.read === 'regex') { const m = new RegExp(s.path).exec(t); return m ? m[1] : null; }
  let v = JSON.parse(t); for (const k of s.path.split('.')) v = v?.[k]; return v === undefined ? null : String(v).slice(0, 40);
};
const seen = new Set();
for (const s of SOURCES) {
  seen.add(new URL(s.url).hostname);
  let line;
  if (s.socket) continue;
  try {
    const r = await fetch(s.url, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'bitcoin-arena-node', origin: 'https://testnet.bitcoin-arena.io' } });
    const t = await r.text(), d = await fetch(s.docs, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0' } }).then((x) => x.status, () => 0);
    line = `${r.status} ${(t.length / 1024).toFixed(0)}KB cors=${r.headers.get('access-control-allow-origin') || '-'} docs=${d} value=${value(s, t)}`;
  } catch (e) { line = `FAILED ${e.message}`; }
  console.log(s.name.padEnd(20), line);
}
console.log('hosts without an example:', MARKET_HOSTS.filter((h) => !seen.has(h) && !h.startsWith('ws-')));
