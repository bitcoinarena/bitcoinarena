// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 A44 REFUTE 67 (kanban #1763 / #1578 in the merge): skeptic 2 variants: a peer seat (mirror) or a same-height re-sign rewrites one height of the in-memory history; the store keeps the first body (INSERT OR IGNORE), so a restart reads another run. Header of the original:
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

function rec(height, goneIdx) {
  const guardians = nodes.map((n, i) => ({ peerKey: n.guardianKey, nodePubkey: n.pubkey, operatorId: `op${i}`, bondTxid: new Uint8Array(32).fill(0xa0 + i), bondVout: 0, endpoint: '', bondSats: 50000n }));
  const gone = goneIdx.map((i) => ({ peerKey: nodes[i].guardianKey, sinceHeight: height - 10, kind: GONE.ABANDONED, proofRef: new Uint8Array(32).fill(i) }));
  const r = buildFederationRecord({ federationId: FED, networkId: NET, invite: INVITE, nominal: 7, guardians, gone, height });
  const body = encodeFederationRecord(r);
  const id = federationRecordId(r);
  return joinSignedRecord(body, nodes.slice(0, 5).map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) })));
}

const halted = (h) => rec(h, [4, 5, 6]);
const open = (h) => rec(h, []);
function rig() {
  const saved = new Map(), hist = new Map();
  const store = { load: async () => [...saved].map(([federation, record]) => ({ federation, record })), save: (f, r) => saved.set(f, r),
    saveAt: (f, h, r) => { const k = `${f}:${h}`; if (!hist.has(k)) hist.set(k, { federation: f, height: h, record: r }); },
    loadAt: (f) => [...hist.values()].filter((x) => x.federation === f).sort((x, y) => x.height - y.height).map(({ height, record }) => ({ height, record })) };
  const s = { served: null, hist };
  const fetcher = async () => new Response(JSON.stringify({ federations: [{ federation: toHex(FED), record: toHex(s.served) }] }), { status: 200 });
  s.seat = () => federationRecords({ round: { pubkey: nodes[0].pubkey, identity: { secret: nodes[0].secret } },
    newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => null, networkId: NET, fetcher, store });
  return s;
}
const halt = (x) => { const h = x.haltOf(toHex(FED)); return h ? h.height : null; };


test('a44-refute-67-s2-2: a peer serves a late HALTED body at a height the history holds OPEN - the running seat moves the start down, a restart does not', async () => {
  const s = rig(); const a = s.seat();
  for (const r of [halted(1000), open(1003), halted(1006)]) { s.served = r; await a.gatherAll(inviteFederationId); }
  assert.equal(halt(a), 1006);
  s.served = halted(1003); await a.gatherAll(inviteFederationId);  // older than kept: refused, but remembered over the OPEN 1003 in memory
  assert.equal(a.recordOf(toHex(FED)).height, 1006);
  const b = s.seat(); await b.restore(inviteFederationId);
  console.log(`  MEASURED s2-2: running ${halt(a)} restarted ${halt(b)}`);
  assert.equal(halt(a), 1006, 'a late body at a height already held moved the running halt start');
  assert.equal(halt(b), halt(a), 'the restart moved the halt start');
});
