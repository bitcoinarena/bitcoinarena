// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM2 FEDERATION 1, kanban #1763 (state-machine audit, crash-restart): the halt a liquidation counts from is "the lowest-height signed HALTED
// record of the run of HALTED records this seat holds" (federation-records.js `halted`). That Map lives in memory only; the store keeps
// the NEWEST record per federation, and restore() keeps that one - so a seat restarted during a halt counts the liquidation from the
// newest HALTED record's height, not the run's first. Two seats (one restarted) then list different haltHeight / liquidatesAt / claim
// windows for the same halt at GET /liquidations, and the arbiter takes the first seat that lists it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord, GONE } from '../../arena-protocol/src/federation-record.js';
import { federationRecords } from '../src/federation-records.js';
import { createLiquidations } from '../src/liquidations.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { TESTNET_CLOCKS } from '../../arena-protocol/src/federation-slash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const FED = new Uint8Array(32).fill(0x37);
const NET = new Uint8Array(32).fill(0x10);
const INVITE = `fed:${toHex(FED)}`;
const inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);
const CLOCKS = TESTNET_CLOCKS;

const nodes = Array.from({ length: 7 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret),
  guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]), endpoint: `wss://seat-${i}.example` }; });
const census = { ok: true, entries: nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 50000n,
  advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } })) };

/** A HALTED record at `height`: three of seven gone, signed by five listed guardians. */
function halted(height) {
  const guardians = nodes.map((n, i) => ({ peerKey: n.guardianKey, nodePubkey: n.pubkey, operatorId: `op${i}`, bondTxid: new Uint8Array(32).fill(0xa0 + i), bondVout: 0, endpoint: '', bondSats: 50000n }));
  const gone = [4, 5, 6].map((i) => ({ peerKey: nodes[i].guardianKey, sinceHeight: height - 10, kind: GONE.ABANDONED, proofRef: new Uint8Array(32).fill(i) }));
  const r = buildFederationRecord({ federationId: FED, networkId: NET, invite: INVITE, nominal: 7, guardians, gone, height });
  const body = encodeFederationRecord(r);
  const id = federationRecordId(r);
  return joinSignedRecord(body, nodes.slice(0, 5).map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) })));
}

test('wf1489-sm2-federation-1 (#1763): a seat restarted during a halt run counts the liquidation from the same height as before the restart', async () => {
  // the seat's store as server.js builds it: federation_records (the newest record per federation) and federation_record_history
  // (every verified record by height, INSERT OR IGNORE)
  const saved = new Map(), hist = new Map();
  const store = { load: async () => [...saved].map(([federation, record]) => ({ federation, record })), save: (f, r) => saved.set(f, r),
    saveAt: (f, h, r) => { const k = `${f}:${h}`; if (!hist.has(k)) hist.set(k, { federation: f, height: h, record: r }); },
    loadAt: (f) => [...hist.values()].filter((x) => x.federation === f).sort((x, y) => x.height - y.height).map(({ height, record }) => ({ height, record })) };
  let served = null;   // what the guardians' nodes serve at GET /federations
  const fetcher = async () => new Response(JSON.stringify({ federations: [{ federation: toHex(FED), record: toHex(served) }] }), { status: 200 });
  const seat = () => federationRecords({ round: { pubkey: nodes[0].pubkey, identity: { secret: nodes[0].secret } },
    newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => null, networkId: NET, fetcher, store });

  const a = seat();
  served = halted(1000);
  await a.gatherAll(inviteFederationId);
  assert.equal(a.recordOf(toHex(FED)).status, 'HALTED');
  served = halted(1006);   // the next pass: the guardians signed the federation HALTED again at a later height
  await a.gatherAll(inviteFederationId);
  assert.equal(a.recordOf(toHex(FED)).height, 1006);
  assert.equal(a.haltOf(toHex(FED)).height, 1000, 'before the restart: the halt counts from the run\'s first HALTED record');

  // THE RESTART: a new seat on the same store
  const b = seat();
  const r = await b.restore(inviteFederationId);
  assert.equal(r.restored, 1);
  const la = createLiquidations({ records: a, clocks: CLOCKS, verify }).list()[0];
  const lb = createLiquidations({ records: b, clocks: CLOCKS, verify }).list()[0];
  console.log(`  MEASURED: seat kept running haltHeight ${la.haltHeight} liquidatesAt ${la.liquidatesAt} claimWindowCloses ${la.claimWindowCloses}; restarted seat haltHeight ${lb.haltHeight} liquidatesAt ${lb.liquidatesAt} claimWindowCloses ${lb.claimWindowCloses}`);
  assert.equal(b.haltOf(toHex(FED)).height, 1000, 'after the restart the halt height moved to the newest HALTED record');
  assert.deepEqual([lb.haltHeight, lb.liquidatesAt, lb.claimWindowCloses], [la.haltHeight, la.liquidatesAt, la.claimWindowCloses], 'two seats list different liquidation clocks for one halt');
});
