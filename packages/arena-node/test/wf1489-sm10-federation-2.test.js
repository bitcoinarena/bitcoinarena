// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state-machine audit round 10, federation 2: a seat's per-height record history (federation_record_history, kanban
// #559/#543) is read back from the store only while the in-memory history of that federation is EMPTY (recordAt). After a restart,
// restore() (20 s after start) keeps the newest saved record - and keep() remembers it in the in-memory history - so the history is never
// empty again and the store's older heights are never read: recordAt(fid, h) for any census height below the newest record answers null.
// signerNodesFor then gives no guardian weights (even split) for every round whose census height is older than the newest record, while
// the seats that did not restart weigh them - one round, two fee tables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { federationRecords } from '../src/federation-records.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(0x42);
const NET = new Uint8Array(32).fill(0x10);
const inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);

test('wf1489-sm10-federation-2: after a restart the record in force at an older census height is gone (recordAt null), though the store holds it', async () => {
  const nodes = Array.from({ length: 4 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 121) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x30 + i)]); n.endpoint = `wss://sm10b-${i}.example`; }
  const census = { ok: true, entries: nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xc0 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g-sm10b-${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } })) };
  // the seat's store as server.js keeps it: the newest per federation, and every record by its height (INSERT OR IGNORE)
  const stores = nodes.map(() => {
    const newest = new Map(), at = new Map();
    return { newest, at, load: async () => [...newest].map(([federation, record]) => ({ federation, record })), save: (f, r) => { newest.set(f, r); },
      saveAt: (f, h, r) => { const k = `${f}:${h}`; if (!at.has(k)) at.set(k, { federation: f, height: h, record: r }); },
      loadAt: (f) => [...at.values()].filter((x) => x.federation === f).sort((x, y) => x.height - y.height).map((x) => ({ height: x.height, record: x.record })) };
  });
  let height = 160000;                       // the newest held round's census height: it moves on as new rounds are posted
  const make = (si, fetcher) => federationRecords({ store: stores[si], round: { pubkey: nodes[si].pubkey, identity: { secret: nodes[si].secret } },
    newest: () => ({ rid: new Uint8Array(32).fill(7), contract: { censusHeight: height, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: (fid) => `fed:${fid}`, networkId: NET, fetcher });
  const seats = nodes.map((n, si) => make(si, async (url) => {
    const u = new URL(url);
    const j = seats[nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')))];
    const hp = u.searchParams.get('height');
    const body = await j.mySignature(u.searchParams.get('federation'), hp === null ? null : Number(hp), u.searchParams.get('reserve'));
    return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
  }));
  const fid = toHex(FED);
  assert.equal((await seats[0].gather(FED, inviteFederationId)).height, 160000);
  height = 160006;
  assert.equal((await seats[0].gather(FED, inviteFederationId)).height, 160006);
  // a round whose census height is 160000 is settled now: the record in force there
  const before = seats[0].recordAt(fid, 160000);
  assert.ok(before && Number(before.height) === 160000, 'before the restart: the record at 160000');
  assert.equal(stores[0].loadAt(fid).length, 2, 'both heights are in the store');
  // RESTART: a new seat on the same store; restore() runs 20 s after start, before the round's settlement asks
  const fresh = make(0, async () => { throw new Error('no network yet'); });
  const r = await fresh.restore(inviteFederationId);
  assert.deepEqual([r.restored, r.of], [1, 1]);
  const after = fresh.recordAt(fid, 160000);
  console.log(`sm10-federation-2 measure: record in force at 160000 before the restart: ${before ? before.height : 'none'}; after it: ${after ? after.height : 'none'} (store holds heights ${stores[0].loadAt(fid).map((x) => x.height).join(', ')})`);
  assert.ok(after && Number(after.height) === 160000, 'the record in force at 160000 survives a restart: the store holds it');
});
