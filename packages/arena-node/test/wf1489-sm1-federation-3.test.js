// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit (federation): THE HALT HEIGHT A LIQUIDATION COUNTS FROM (§23A.5) is "the lowest-height signed HALTED
// record of the run of HALTED records" (federation-records.js `halted`) - kept in memory only. The store keeps the newest record per
// federation, and restore() keep()s only that one, so after a restart the halt height is the NEWEST HALTED record's: the seat's
// liquidation clock (liquidatesAt, claim window, late-claim tail, remainder split) moves later, and a seat that restarted names other
// clocks than one that did not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { federationRecords } from '../src/federation-records.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(0x37);
const NET = new Uint8Array(32).fill(0x10);
const INVITE = `fed:${toHex(FED)}`;
const inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);

test('wf1489-sm1-federation-3: the halt height a liquidation counts from survives a restart', async () => {
  let height = 156036;
  const leaving = [0, 1, 2];                // three of seven leave: 4 seated -> HALTED
  const nodes = Array.from({ length: 7 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 1) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]); n.endpoint = `wss://seat-${i}.example`; }
  const census = { ok: true, entries: nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } })) };
  // the store as server.js builds it (recordStore): the newest record per federation, and every record by its height (INSERT OR IGNORE)
  const stores = nodes.map(() => { const m = new Map(), at = new Map(); return { m, load: async () => [...m].map(([federation, record]) => ({ federation, record })), save: (f, r) => { m.set(f, r); },
    saveAt: (f, h, r) => { const k = `${f}:${h}`; if (!at.has(k)) at.set(k, { federation: f, height: h, record: r }); },
    loadAt: (f) => [...at.values()].filter((x) => x.federation === f).sort((a, b) => a.height - b.height).map(({ height, record }) => ({ height, record })) }; });
  const make = (i, fetcher) => federationRecords({ store: stores[i],
    round: { pubkey: nodes[i].pubkey, identity: { secret: nodes[i].secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: height, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => INVITE, networkId: NET, leavingAtMs: () => (leaving.includes(i) ? 1 : null), fetcher });
  const seats = nodes.map((_, i) => make(i, async (url) => {
    const j = seats[nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')))];
    const u = new URL(url); const gone = (u.searchParams.get('gone') || '').split(',').filter(Boolean);
    const left = (u.searchParams.get('left') || '').split(',').filter(Boolean);
    const body = await (gone.length ? j.mySignatureWithGone(u.searchParams.get('federation'), gone, null, u.searchParams.get('reserve'), [], [], [], { left }) : j.mySignature(u.searchParams.get('federation'), null, u.searchParams.get('reserve')));
    return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
  }));
  const fid = toHex(FED);
  const first = await seats[0].gather(FED, inviteFederationId);
  assert.deepEqual([first.ok, first.status], [true, 'HALTED'], first.why);
  const firstHalt = seats[0].haltOf(fid).height;
  height = 156040;                          // the next record of the same HALTED run, at a later census height
  const second = await seats[0].gather(FED, inviteFederationId);
  assert.deepEqual([second.ok, second.status], [true, 'HALTED'], second.why);
  const beforeRestart = seats[0].haltOf(fid).height;
  // THE SEAT RESTARTS: a new federationRecords on the same store
  const fresh = make(0, async () => { throw new Error('no network after the restart'); });
  const r = await fresh.restore(inviteFederationId);
  const afterRestart = fresh.haltOf(fid) ? fresh.haltOf(fid).height : null;
  console.log('  MEASURED:', JSON.stringify({ firstHalt, beforeRestart, restored: r, afterRestart, otherSeatNeverRestarted: beforeRestart }));
  assert.equal(beforeRestart, firstHalt, 'the run of HALTED records counts from its lowest height');
  assert.equal(afterRestart, firstHalt, `after a restart the halt (and every liquidation clock) counts from ${afterRestart}, not ${firstHalt}`);
});
