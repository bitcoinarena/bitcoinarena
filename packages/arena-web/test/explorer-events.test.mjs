// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LIQUIDATIONS AND SLASHES IN THE EXPLORER (kanban #723, the owner 2026-10-27: "Sind die Transaktionen alle im Explorer zu sehen als liquidation
// event?" - "Ja soll es"): the arbitration set's events, read from the seats' GET /liquidations, are rows of their own kinds beside the orders,
// found by every transaction they name; T2's liquidation (rehearsal 17) on its page with every payout, payee and transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import worker from '../../../src/website/explorer/worker.js';
import { List, Liquidation, Slash, KINDS } from '../dist/test/explorer.mjs';
import { liquidationEvent, slashEvent } from '../../arena-node/src/arbitration-events.js';

const MIG = new URL('../../../src/website/explorer/migrations/', import.meta.url);
function store() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  const prepare = (sql) => { const st = { b: [], bind: (...b) => { st.b = b; return st; }, all: async () => ({ results: db.prepare(sql).all(...st.b) }),
    first: async () => db.prepare(sql).get(...st.b) ?? null, run: async () => db.prepare(sql).run(...st.b) }; return st; };
  const kv = new Map();
  return { db, env: { DB: { prepare, batch: async (l) => { for (const s of l) await s.run(); } },
    EXPLORER: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => { kv.set(k, v); } } } };
}
const ask = async (env, path) => (await worker.fetch(new Request('https://explorer.bitcoin-arena.io' + path), env, { waitUntil: () => {} })).json();
const T2 = JSON.parse(readFileSync(new URL('../../arena-node/test/fixtures/t2-liquidation-723.json', import.meta.url), 'utf8'));
const FULL = { escrow: 'd96364ecc7f8f75f8fb60e64c9b61e3dfee36fae8390cc30a2c995c0690da72a', payout: 'a6c8636f34b02a12a583599f3c649a211fe9857c28df435c094f239921710f91',
  remainder: '1f10749173eb4a7135a0d059b51ea09a43bae12c2baa73313ebaec73dc0acb62' };
const t2 = (atMs, v = T2.state) => ({ ...liquidationEvent({ network: 'testnet4', fid: T2.federation, v, claims: T2.claims, escrowAt: T2.escrowAt, into: T2.into }), firstMs: T2.firstMs, atMs });
const SLASH = { ...slashEvent({ network: 'testnet4', proof: 'cd'.repeat(32), v: { posted: 'ef'.repeat(32), node: 'aa'.repeat(32), round: '11'.repeat(32), entry: '22'.repeat(32),
  slashHeight: 157000, signers: 5, bondSats: '100000', playersSats: '60000', nodesSats: '30000', developersSats: '10000', escrowTxid: '33'.repeat(32), pegInSats: '59000', claimedMsat: '58000000',
  payouts: [{ round: '11'.repeat(32), entry: '22'.repeat(32), refundPk: '02' + '44'.repeat(32), msat: '58000000', txid: '55'.repeat(32), outIdx: 0 }] } }), firstMs: Date.parse('2026-10-20T10:00:00Z'), atMs: 5000 };

test('the set\'s liquidations and slashes are rows of their own kinds, the newest version any seat holds, found by every transaction they name', async () => {
  const { env } = store();
  // a seat that holds the version before the remainder, the others the newest; a seat before GET /liquidations' events lists none
  const before = { ...T2.state, remainderTxid: undefined, remainderMsat: undefined, remainderPayees: undefined, remainderPayouts: undefined };
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url); asked.push(u.pathname);
    const seat = u.pathname.split('/')[1];
    const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/liquidations')) return ok({ liquidations: [], events: seat === 'guardian-1' ? [{ event: t2(1000, before), signatures: [] }]
      : seat === 'fed2-7' ? undefined : [{ event: t2(2000), signatures: [] }, { event: SLASH, signatures: [] }] });
    if (u.pathname.endsWith('/txs')) return ok({ txs: [] });
    if (u.pathname.endsWith('/payments')) return ok({ gifts: [], items: [] });
    return ok({});
  };
  try { let done; await worker.scheduled({}, env, { waitUntil: (p) => { done = p; } }); await done; } finally { globalThis.fetch = real; }
  assert.equal(asked.filter((p) => p.endsWith('/liquidations')).length, 3, 'three seats a minute, in turn: any seat holds every event');
  const page = await ask(env, '/api/recent');
  assert.deepEqual(page.txs.map((t) => [t.kind, t.id.slice(0, 8), t.stakeMsat, t.status, t.federation && t.federation.slice(0, 8)]),
    [['liquidation', '9919a571', '44999680', 'paid out', '9919a571'], ['slash', 'cdcdcdcd', '100000000', 'paid out', null]]);
  assert.deepEqual(page.facets.kinds.map((k) => k.kind).sort(), ['liquidation', 'slash']);
  assert.deepEqual((await ask(env, '/api/recent?kind=liquidation')).txs.map((t) => t.id), [T2.federation]);
  // the card's search, measured 2026-10-27 with 0 hits: each of the liquidation's transactions now finds it
  for (const q of ['d96364ec', 'a6c8636f', '1f107491', 'b6464f0e']) assert.deepEqual((await ask(env, '/api/recent?q=' + q)).txs.map((t) => t.kind), ['liquidation'], q);
  for (const id of [T2.federation, FULL.escrow, FULL.payout, FULL.remainder]) {
    const tx = await ask(env, '/api/tx/' + id);
    assert.deepEqual([tx.found, tx.kind, tx.event.remainder.txid, tx.event.remainder.payouts.length, tx.storedFirst], [true, 'liquidation', FULL.remainder, 44, '2026-10-24T19:37:24.000Z'], id);
  }
  assert.equal((await ask(env, '/api/tx/' + '55'.repeat(32))).kind, 'slash', 'a slash by its payout\'s transaction');
});

test('T2\'s liquidation on its page: the halt, the escrow into the safe federation, the 47 notes\' payout, and the remainder to each of its 44 payees', () => {
  const h = renderToStaticMarkup(React.createElement(Liquidation, { tx: { id: T2.federation, kind: 'liquidation', event: t2(2000) } }));
  for (const id of [T2.federation, FULL.escrow, FULL.payout, FULL.remainder, T2.into, T2.escrowAt]) assert.ok(h.includes(id), id);
  assert.match(h, /<h1>Liquidation<\/h1>/);
  assert.match(h, /<dt>Status<\/dt><dd><b>Paid out<\/b><\/dd>/);
  assert.match(h, /at height 157,476<span class="dim"> · proven by 27 seats, session 783, 3 guardians abandoned/);
  assert.match(h, /<dt>Escrow<\/dt><dd>47,000 sat/);
  assert.match(h, /<dt>Claimed there<\/dt><dd>44,999.68 sat<span class="dim"> · 2026-10-26 21:48:58 UTC/);
  assert.match(h, /47 notes accepted \(28,994.56 sat, 1 key\) · 0 refused/);
  assert.match(h, /<td class="mono">029b9fb97fa5eec099d821c8f012b7d4ab323da69343bb15713ec46f3ab4139f60<\/td><td class="n nw">28,994.56 sat<\/td><td class="mono">a6c8636f[0-9a-f]{56}<\/td><td>0<\/td>/);
  assert.match(h, /15,994.608 sat to 44 payees<span class="dim"> · 42 nodes 11,995.956 sat, 2 donation sets 3,998.652 sat/);
  // every payee a row: its output, its part, its key and amount
  assert.equal((h.match(/<td>Node<\/td>/g) || []).length, 42);
  assert.equal((h.match(/<td class="n nw">285.618 sat<\/td>/g) || []).length, 42);
  assert.match(h, /<td>Donation set<\/td><td class="mono">[0-9a-f]{66}<\/td><td class="n nw">2,665.902 sat<\/td>/);
  assert.match(h, /<td>43<\/td><td>Donation set<\/td><td class="mono">02ed57f5[0-9a-f]{58}<\/td><td class="n nw">1,332.75 sat<\/td>/);
  for (const p of T2.state.remainderPayouts) assert.ok(h.includes(p.payoutPk), p.payoutPk);
  assert.equal((h.match(/refused:/g) || []).length, 0);
});

test('a slash on its page and both kinds in the list, with their filter', () => {
  const s = renderToStaticMarkup(React.createElement(Slash, { tx: { id: SLASH.proof, kind: 'slash', event: SLASH } }));
  assert.match(s, /<dt>Node slashed<\/dt><dd class="mono">a{64}<\/dd>/);
  assert.match(s, /<dt>Slash transaction<\/dt><dd><span class="mono">(ef){32}<span class="dim"> \(bitcoin\)<\/span><\/span><span class="dim"> · height 157,000, 5 signers<\/span>/);
  assert.match(s, /<dt>Bond<\/dt><dd>100,000 sat<span class="dim"> · players 60,000 sat<\/span><span class="dim"> · nodes 30,000 sat<\/span><span class="dim"> · developers 10,000 sat<\/span>/);
  assert.match(s, /<td class="mono">02(44){32}<\/td><td class="n nw">58,000 sat<\/td><td class="mono">(55){32}<\/td><td>0<\/td>/);
  assert.deepEqual([KINDS.liquidation, KINDS.slash], ['Liquidation', 'Slash']);
  const data = { txs: [{ id: T2.federation, kind: 'liquidation', app: null, federation: T2.federation, storedMs: T2.firstMs, stakeMsat: '44999680', status: 'paid out', result: null }],
    older: null, newer: null, total: 1, facets: { apps: [{ app: '-', n: 1 }], kinds: [{ kind: 'liquidation', n: 1 }, { kind: 'slash', n: 1 }], feds: [] } };
  const h = renderToStaticMarkup(React.createElement(List, { data }));
  assert.match(h, /<option value="liquidation">Liquidation \(1\)<\/option><option value="slash">Slash \(1\)<\/option>/);
  assert.match(h, /<td>Protocol<\/td><td class="nw">Liquidation<\/td><td class="n nw">44,999.68 sat<\/td><td class="nw dim">Paid out<\/td><td class="mono">9919a571<\/td>/);
});
