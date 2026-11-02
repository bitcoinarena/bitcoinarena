// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARBITRATION SET ON AN ABANDONED ROW (§23A.5, RULED 2026-11-02, kanban #1058, #1059). A signed record and a seat's listing are believed for nothing: a record short of its threshold, a row the
// record does not hold, and an output the node has no more are refused. A true one gives path B on the row's proof_ref, the federation in the hint, into the liquidation escrow, 5 of 7 signing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { arbitrationMembers, judgeAbandoned, buildAbandonedSlash, memberSign, assemble } from '../src/arbiter.js';
import { federationRecords } from '../src/federation-records.js';
import { slashEvent } from '../src/arbitration-events.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord, GONE } from '../../arena-protocol/src/federation-record.js';
import { startsByCensusKey } from '../../arena-protocol/src/abandoned-slash.js';
import { arbitrationCommitmentIn, escrowOutput } from '../../arena-protocol/src/arbitration-tx.js';
import { bondOutputKey, bondInternalKey } from '../../arena-protocol/src/bond-script.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tweakPoint, combine } from '../src/curve.js';

const set = arbitrationMembers('regtest');
const FED = new Uint8Array(32).fill(0x37), INVITE = `fed:${toHex(FED)}`, inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);
const SPEND = new Uint8Array(32).fill(0xcd), SINCE = 300, HEIGHT = 306, MATURITY = 250;
const nodes = Array.from({ length: 4 }, (_, i) => { const secret = new Uint8Array(32).fill(0x20 + i); return { secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]) }; });
const advertOf = (n, i) => ({ nodePubkey: n.pubkey, operatorId: `op${i}`, bondScriptTemplateVersion: 2, bondMaturityHeight: MATURITY, endpoint: `wss://seat-${i}.example`, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] });
const census = nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 100000n, height: 120, advert: advertOf(n, i) }));
const seated = census.slice(0, 3);

function signed({ gone = [{ peerKey: nodes[3].guardianKey, sinceHeight: SINCE, kind: GONE.ABANDONED, proofRef: SPEND }], signers = nodes.slice(0, 3) } = {}) {
  const guardians = nodes.map((n, i) => ({ nodePubkey: n.pubkey, peerKey: n.guardianKey, operatorId: `op${i}`, bondTxid: new Uint8Array(32).fill(0xa0 + i), bondVout: 0, bondSats: i === 3 ? 0n : 100000n, endpoint: `wss://g${i}.example` }));
  const record = buildFederationRecord({ federationId: FED, networkId: NETWORK_ID_REGTEST, invite: INVITE, nominal: 4, guardians, gone, height: HEIGHT, reserveSats: 0n });
  const id = federationRecordId(record);
  return joinSignedRecord(encodeFederationRecord(record), signers.map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) })));
}
const LEFT = { pubkey: nodes[3].pubkey, txid: new Uint8Array(32).fill(0xb3), vout: 1, bondSats: 20000n, height: 150, advert: advertOf(nodes[3], 3), why: 'that node\'s bonds sum to 20000' };
const SPENT = { pubkey: nodes[3].pubkey, txid: new Uint8Array(32).fill(0xa3), vout: 0, bondSats: 100000n, height: 120, spent: true, spentBy: { txid: toHex(SPEND), height: SINCE } };
const judge = (over = {}) => judgeAbandoned({ recordBytes: signed(), census: seated, bonds: [...seated, SPENT, LEFT], peer: toHex(nodes[3].guardianKey), txid: toHex(LEFT.txid), vout: 1, networkId: NETWORK_ID_REGTEST, inviteFederationId, ...over });

test('a true row: judged on the record\'s signatures and this set\'s census, and the spend read as the chain\'s proof', () => {
  const v = judge();
  assert.equal(v.slashed, true, v.why);
  assert.deepEqual([v.offence, toHex(v.proofId), v.federation, v.node, v.bondSpent, v.output.sats], ['ABANDONED', toHex(SPEND), toHex(FED), toHex(nodes[3].pubkey), true, 20000n]);
});

test('a record is believed for nothing: short of its threshold, of another network, or naming nobody', () => {
  assert.match(judge({ recordBytes: signed({ signers: nodes.slice(0, 2) }) }).why, /does not stand: 2 of its bonded guardians/);
  assert.match(judge({ networkId: new Uint8Array(32).fill(1) }).why, /another network/);
  assert.match(judge({ recordBytes: signed({ gone: [] }) }).why, /no ABANDONED row/);
  assert.match(judge({ peer: toHex(nodes[1].guardianKey) }).why, /no ABANDONED row/);
  assert.match(judge({ bonds: [...seated, SPENT] }).why, /no output of that node left/, 'the seat named an output this set does not read');
  assert.match(judge({ recordBytes: signed({ signers: [nodes[3], ...nodes.slice(0, 2)] }) }).why, /does not stand/, 'a node the census no longer holds signs nothing');
});

test('a template-3 output comes back judged, its presig the census key\'s: path B is not the set\'s on it', () => {
  const v = judge({ bonds: [...seated, SPENT, { ...LEFT, advert: { ...LEFT.advert, bondScriptTemplateVersion: 3 } }] });
  assert.deepEqual([v.slashed, v.output.template, startsByCensusKey(v.output.template)], [true, 3, true]);
});

test('path B on the row\'s proof_ref: the federation in the hint, the whole output less the fee into the escrow, 5 of 7 signing, and nothing below k', () => {
  const nodeKey = nodes[3].pubkey;
  const tree = bondOutputKey({ nodeKey, arbitrationKeys: set.keys, arbitrationK: set.k, bondMaturity: MATURITY, internalKey: bondInternalKey({ nodeKey, arbitrationKeys: set.keys }, { combine }).internalKey }, { tweakPoint, combine });
  const bond = { txid: LEFT.txid, vout: 1, value: 20000n, script: Uint8Array.from([0x51, 0x20, ...tree.outputKey]) };
  const slash = buildAbandonedSlash({ verdict: judge(), bond, slashHeight: 320, tipHeight: 320, recordHeight: HEIGHT, set, feeSats: 2000n });
  assert.equal(slash.ok, true, slash.why);
  const said = arbitrationCommitmentIn(slash.built.tx.outputs);
  assert.deepEqual([toHex(said.proofId), said.slashHeight, toHex(said.hint)], [toHex(SPEND), 320, toHex(FED)]);
  assert.equal(slash.built.tx.locktime, 320);
  assert.equal(slash.built.tx.outputs.length, 2, 'the commitment and one output');
  assert.equal(slash.built.tx.outputs[1].value, 18000n);
  assert.equal(toHex(slash.built.tx.outputs[1].script), toHex(escrowOutput({ arbitrationKeys: set.keys, k: set.k }, { tweakPoint, combine }).script));
  const sigs = set.members.map((m) => ({ key: m.key, sig: memberSign(m, slash.sighash) }));
  assert.equal(assemble({ slash, signatures: sigs.slice(0, set.k), set }).ok, true);
  assert.match(assemble({ slash, signatures: sigs.slice(0, set.k - 1), set }).why, /nothing is posted/);
  assert.match(buildAbandonedSlash({ verdict: judge(), bond, slashHeight: 300, tipHeight: 320, recordHeight: HEIGHT, set }).why, /census|height/);
  assert.match(buildAbandonedSlash({ verdict: judge(), bond: { ...bond, script: Uint8Array.from([0x51, 0x20, ...new Uint8Array(32).fill(7)]) }, slashHeight: 320, tipHeight: 320, recordHeight: HEIGHT, set }).why, /not the bond/);
});

test('its event says the escrow holds it, under the federation and the row\'s proof_ref; a slash of a round reads as before', () => {
  const e = slashEvent({ network: 'regtest', proof: 'ab'.repeat(32), v: { offence: 'ABANDONED', posted: 'ef'.repeat(32), heldFor: toHex(FED), proofRef: toHex(SPEND), node: toHex(nodes[3].pubkey), bondSats: '20000', escrowSats: '18000' } });
  assert.deepEqual([e.status, e.federation, e.proofRef, e.sats.escrow], ['waits in the federation\'s liquidation escrow', toHex(FED), toHex(SPEND), '18000']);
  const plain = slashEvent({ network: 'regtest', proof: 'ab'.repeat(32), v: { posted: 'ef'.repeat(32) } });
  assert.equal(plain.status, 'posted');
  assert.equal('federation' in plain, false);
});

/** A seat holding the signed record, reading the chain's census as server.js wires it. */
function seat({ bonds, record = signed(), tip = 340 }) {
  const n = nodes[0];
  const s = federationRecords({ round: { pubkey: n.pubkey, identity: { secret: n.secret }, db: { prepare: () => ({ all: () => [], get: () => ({ m: 0 }) }) } }, roster: { censusFor: () => ({ ok: false, why: 'none' }) }, inviteFor: () => null, networkId: NETWORK_ID_REGTEST,
    censusAt: async () => census, chainTip: async () => tip, bondsAt: bonds, store: { load: () => [{ federation: toHex(FED), record: toHex(record) }], save: () => {} } });
  return s;
}

test('a seat lists one row per output left, reading the census only once a record names somebody', async () => {
  let reads = 0;
  const s = seat({ bonds: async () => { reads += 1; return [...seated, SPENT, LEFT]; } });
  await s.restore(inviteFederationId);
  assert.equal(s.list().length, 1, 'the record is held');
  const rows = await s.abandonedSlashes();
  assert.deepEqual(rows.map((r) => [r.federation, r.node, r.peer, r.proofRef, r.since, r.recordHeight, r.txid, r.vout, r.sats, r.template]),
    [[toHex(FED), toHex(nodes[3].pubkey), toHex(nodes[3].guardianKey), toHex(SPEND), SINCE, HEIGHT, toHex(LEFT.txid), 1, '20000', 2]]);
  assert.match(rows[0].proof, /^[0-9a-f]{64}$/);
  await s.abandonedSlashes();
  assert.equal(reads, 1, 'one read per census height');

  const none = seat({ bonds: async () => { reads += 1; return []; }, record: signed({ gone: [] }) });
  await none.restore(inviteFederationId);
  assert.deepEqual(await none.abandonedSlashes(), []);
  assert.equal(reads, 1, 'no ABANDONED row, no read');
  const nothingLeft = seat({ bonds: async () => [...seated, SPENT] });
  await nothingLeft.restore(inviteFederationId);
  assert.deepEqual(await nothingLeft.abandonedSlashes(), [], 'nothing left: the record is what stands');
});
