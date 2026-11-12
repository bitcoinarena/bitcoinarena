// kanban #1684 refute (a44-43, skeptic 2, the RESTART path after a peer seat's mirror): 1bf6755a6 holds the client to "a record stands only for
// the federation it names", but a seat's own mirror (federation-records.js mirror, the path a seat takes when it has no invite or its gather
// fails - and the census-peer fallback when the guardians hold nothing) files a verified row under the row's `federation` LABEL. One guardian
// seat of B (or one census peer, when B's guardians are down) lists federation A's genuine newer OPEN record under B's id: the mirroring seat
// keeps it as B's, so B - HALTED by its own guardians - is OPEN at that seat (recordOf, list, inviteOf all A's), and it serves that row to
// every client from GET /federations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord, FEDERATION_STATUS } from '../../arena-protocol/src/federation-record.js';
import { federationRecords, guardiansOf } from '../src/federation-records.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const NET = new Uint8Array(32).fill(0x10);
const A = new Uint8Array(32).fill(0x37), B = new Uint8Array(32).fill(0x50);
const inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);

test('wf1489-a44-refute-43-s2-2: a record of A mirrored under B\'s id does not outlive a restart and an honest pass as B\'s', async () => {
  const nodes = Array.from({ length: 7 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `wss://seat-${i}.example` }; });
  const census = { ok: true, entries: nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`,
      guardianOf: [{ federationId: A, guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]) }, { federationId: B, guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x70 + i)]) }] } })) };
  const signed = (fed, height, status) => {
    const r = buildFederationRecord({ federationId: fed, networkId: NET, invite: `fed:${toHex(fed)}`, nominal: 7, height, guardians: guardiansOf(census, fed) });
    if (status != null) r.status = status;
    const id = federationRecordId(r);
    return toHex(joinSignedRecord(encodeFederationRecord(r), nodes.map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) }))));
  };
  const aOpen = signed(A, 156100), bHalted = signed(B, 156050, FEDERATION_STATUS.HALTED);
  const saved = new Map();
  const store = { save: (fid, hex) => saved.set(fid, hex), load: async () => [...saved].map(([federation, record]) => ({ federation, record })),
    loadNow: () => [...saved].map(([federation, record]) => ({ federation, record })) };
  const seat = (liar) => {
    const me = { secret: new Uint8Array(32).fill(0x55) }; me.pubkey = schnorr.getPublicKey(me.secret);
    return federationRecords({
      round: { pubkey: me.pubkey, identity: { secret: me.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
      roster: { censusFor: () => census }, inviteFor: () => null, networkId: NET, store,
      fetcher: async (url) => {
        if (!url.endsWith('/federations')) return new Response('no', { status: 404 });
        // seat-0 is one of B's seven guardians' nodes; with `liar` it lists A's genuine record under B's id
        const rows = liar && url.startsWith('https://seat-0.example')
          ? [{ federation: toHex(A), record: aOpen }, { federation: toHex(B), record: aOpen }]
          : [{ federation: toHex(A), record: aOpen }, { federation: toHex(B), record: bHalted }];
        return new Response(JSON.stringify({ federations: rows }), { status: 200 });
      },
    });
  };
  await seat(true).gatherAll(inviteFederationId);              // one pass with the liar among B's guardian nodes, then the seat restarts
  const after = seat(false);
  after.restoreNow(inviteFederationId); await after.restore(inviteFederationId);
  await after.gatherAll(inviteFederationId);                    // every guardian honest again: B's own HALTED record at 156050
  const b = after.recordOf(toHex(B));
  console.log(`FACTS: stored row for B names federation ${b && toHex(b.record.federationId).slice(0, 8)}; after restart and an honest pass B is ${b && b.status} at height ${b && b.height}, inviteOf(B) = ${after.inviteOf(toHex(B))}`);
  assert.equal(b.status, 'HALTED', `after a restart and an all-honest pass B is still ${b.status}: the label-filed record outlives the restart and the older true record cannot replace it`);
});
