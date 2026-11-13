// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2156, #2224 (#1489 audit44 refute of #1677), adapted to 1.9 by #2536: the name's ADDRESSES are judged, not only its spelling. The
// card's test passed a lookupFn to lnAddressInvoice and imported lnurlFetch, its own fix; 1.9 judges the address in the connection's own
// lookup instead (public-fetch.js guardedLookup, #1919/#1962), so a name is never fetched when any address it resolves to is internal, and
// the socket goes to exactly the address that was checked. The same three cases, driven through the real publicFetch with the system's
// DNS lookup replaced (node:dns lookup, synced into the ESM binding), and a real TCP listener to count connections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { lnAddressInvoice, lnAddressWorks, internalAddress, publicFetch } from '../src/feedback-store.js';

const payReq = { tag: 'payRequest', callback: 'https://wallet.example.com/cb', minSendable: 1000, maxSendable: 1e9 };
const json = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
const realLookup = dns.lookup;

/** dns.lookup answers `answer(hostname)` (a list of addresses) for every name; `asked` records each name looked up. */
function fakeDns(answer, asked = []) {
  dns.lookup = (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    asked.push(hostname);
    const list = answer(hostname).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    if (options && options.all) return process.nextTick(cb, null, list);
    process.nextTick(cb, null, list[0].address, list[0].family);
  };
  syncBuiltinESMExports();
  return asked;
}
function realDns() { dns.lookup = realLookup; syncBuiltinESMExports(); }

test('#2156 (1.9): a name whose lookup answers 10.x / 169.254.169.254 / ::1 ... is never connected to, at send and at payout', async () => {
  let hits = 0;
  const srv = createServer((s) => { hits++; s.destroy(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    for (const bad of ['10.0.0.5', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd12::1', '100.64.1.1', '127.0.0.1']) {
      const asked = fakeDns(() => ['93.184.216.34', bad]);
      const w = await lnAddressWorks('bounty@evil.example.com', { timeoutMs: 3000 });
      const p = await lnAddressInvoice('bounty@evil.example.com', 1000, '', { timeoutMs: 3000 });
      realDns();
      console.log('  MEASURED', bad, JSON.stringify({ w, p, asked }));
      assert.ok(asked.length >= 1, 'the name was never looked up');
      assert.equal(w.ok, false); assert.equal(p.ok, false);
      assert.match(w.why, /public name/); assert.match(p.why, /public name/);
    }
    assert.equal(hits, 0, 'a connection was opened');
  } finally { realDns(); srv.close(); }
});

test('#2156 (1.9): a callback whose name resolves internal is not fetched; a public one still pays (honest path)', async () => {
  // the pay request comes from a stub fetch; the callback's own GET goes through publicFetch, whose lookup answers an internal address
  const asked = fakeDns((h) => [h === 'cb.example.net' ? '192.168.1.10' : '93.184.216.34']);
  try {
    let stubbed = 0;
    const fetchFn = async (u, o) => { if (new URL(String(u)).pathname.startsWith('/.well-known')) { stubbed++; return json({ ...payReq, callback: 'https://cb.example.net/cb' }); } return publicFetch(u, o); };
    const bad = await lnAddressInvoice('bounty@wallet.example.com', 1000, '', { fetchFn, timeoutMs: 3000 });
    console.log('  MEASURED callback', JSON.stringify({ bad, asked }));
    assert.equal(bad.ok, false); assert.equal(stubbed, 1); assert.ok(asked.includes('cb.example.net'));
  } finally { realDns(); }
  const seen = [];
  const fetchFn = async (u) => { seen.push(String(u)); return new URL(String(u)).pathname.startsWith('/.well-known') ? json({ ...payReq, callback: 'https://cb.example.net/cb' }) : json({ pr: 'lnbc10u1xyz' }); };
  const good = await lnAddressInvoice('bounty@wallet.example.com', 1000, '', { fetchFn });
  console.log('  MEASURED honest', JSON.stringify({ good, seen }));
  assert.equal(good.ok, true); assert.equal(good.invoice, 'lnbc10u1xyz'); assert.equal(seen.length, 2);
});

test('#2156 (1.9): publicFetch connects only to a checked address - a public-looking name resolving to 127.0.0.1 (DNS rebinding stand-in) opens no connection', async () => {
  let hits = 0;
  const srv = createServer((s) => { hits++; s.destroy(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    fakeDns(() => ['127.0.0.1']);
    const e = await publicFetch(`https://rebind.example.com/admin/act`, { signal: AbortSignal.timeout(5000) }).then(() => null, (x) => x);
    realDns();
    const l = await publicFetch(`https://localhost:${srv.address().port}/admin/act`, { signal: AbortSignal.timeout(5000) }).then(() => null, (x) => x);
    console.log('  MEASURED connect check', JSON.stringify({ rebind: e && e.code, localhost: l && l.code, hits }));
    assert.ok(e && l, 'publicFetch reached an internal address');
    assert.equal(e.code, 'EINTERNALHOST'); assert.equal(l.code, 'EINTERNALHOST');
    assert.equal(hits, 0, 'a connection was opened to the internal address');
  } finally { realDns(); srv.close(); }
  assert.equal(internalAddress('8.8.8.8'), false); assert.equal(internalAddress('2606:4700::1111'), false);
});
