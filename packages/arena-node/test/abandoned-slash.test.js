// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARBITRATION SET ON AN ABANDONED ROW (§23A.5, RULED 2026-11-02, kanban #1058, #1059, #1062). A proof and a seat's listing are believed for nothing: a record short of its threshold, a row the
// record does not hold, and an output the node has no more are refused. A true one gives path B on the proof's hash, the federation in the hint, into the liquidation escrow, 5 of 7 signing.
// decideReturn takes the proof as any slash proof, and a seat serves it, the signed record in it, by that hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { arbitrationMembers, judgeAbandoned, buildAbandonedSlash, memberSign, assemble } from '../src/arbiter.js';
import { federationRecords } from '../src/federation-records.js';
import { slashEvent } from '../src/arbitration-events.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord, GONE } from '../../arena-protocol/src/federation-record.js';
import { startsByCensusKey, encodeAbandonedProof, abandonedProofId } from '../../arena-protocol/src/abandoned-slash.js';
import { decideReturn, abandonedProofChecks, proofChecksOf } from '../src/hold-return.js';
import { createProofJudge } from '../src/proof-judge.js';
import { arbitrationCommitmentIn, escrowOutput } from '../../arena-protocol/src/arbitration-tx.js';
import { bondOutputKey, bondInternalKey } from '../../arena-protocol/src/bond-script.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tweakPoint, combine } from '../src/curve.js';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { inviteForGuardians } from '../src/invite.js';
import { HOSTED } from './plugins/hosted.js';

const set = arbitrationMembers('regtest');
const FED = new Uint8Array(32).fill(0x37), INVITE = `fed:${toHex(FED)}`, inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);
const SPEND = new Uint8Array(32).fill(0xcd), SINCE = 300, HEIGHT = 306, MATURITY = 250;
const nodes = Array.from({ length: 4 }, (_, i) => { const secret = new Uint8Array(32).fill(0x20 + i); return { secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]) }; });
const advertOf = (n, i) => ({ nodePubkey: n.pubkey, operatorId: `op${i}`, bondScriptTemplateVersion: 2, bondMaturityHeight: MATURITY, endpoint: `wss://seat-${i}.example`, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] });
const census = nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 100000n, height: 120, advert: advertOf(n, i) }));
const seated = census.slice(0, 3);

function signed({ gone = [{ peerKey: nodes[3].guardianKey, sinceHeight: SINCE, kind: GONE.ABANDONED, proofRef: SPEND }], signers = nodes.slice(0, 3), invite = INVITE } = {}) {
  const guardians = nodes.map((n, i) => ({ nodePubkey: n.pubkey, peerKey: n.guardianKey, operatorId: `op${i}`, bondTxid: new Uint8Array(32).fill(0xa0 + i), bondVout: 0, bondSats: i === 3 ? 0n : 100000n, endpoint: `wss://g${i}.example` }));
  const record = buildFederationRecord({ federationId: FED, networkId: NETWORK_ID_REGTEST, invite, nominal: 4, guardians, gone, height: HEIGHT, reserveSats: 0n });
  const id = federationRecordId(record);
  return joinSignedRecord(encodeFederationRecord(record), signers.map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) })));
}
const LEFT = { pubkey: nodes[3].pubkey, txid: new Uint8Array(32).fill(0xb3), vout: 1, bondSats: 20000n, height: 150, advert: advertOf(nodes[3], 3), why: 'that node\'s bonds sum to 20000' };
const SPENT = { pubkey: nodes[3].pubkey, txid: new Uint8Array(32).fill(0xa3), vout: 0, bondSats: 100000n, height: 120, spent: true, spentBy: { txid: toHex(SPEND), height: SINCE } };
const SIGNED = signed();
const proofOf = ({ federationId = FED, node = nodes[3], proofRef = SPEND, txid = LEFT.txid, vout = 1, record = SIGNED } = {}) => encodeAbandonedProof({ federationId, nodePubkey: node.pubkey, proofRef, txid, vout, record });
const judge = ({ record = SIGNED, ...over } = {}) => judgeAbandoned({ proofBytes: proofOf({ ...over, record }), census: seated, bonds: [...seated, SPENT, LEFT], networkId: NETWORK_ID_REGTEST, inviteFederationId, ...over });

test('a true row: judged on the record\'s signatures and this set\'s census, and the spend read as the chain\'s proof', () => {
  const v = judge();
  assert.equal(v.slashed, true, v.why);
  assert.deepEqual([v.offence, v.proofRef, v.federation, v.node, v.bondSpent, v.output.sats], ['ABANDONED', toHex(SPEND), toHex(FED), toHex(nodes[3].pubkey), true, 20000n]);
  assert.equal(toHex(v.proofId), toHex(abandonedProofId(proofOf())), 'what the slash commits to is the proof\'s hash, not its proof_ref');
  assert.notEqual(toHex(v.proofId), toHex(SPEND));
});

test('a record is believed for nothing: short of its threshold, of another network, or naming nobody', () => {
  assert.match(judge({ record: signed({ signers: nodes.slice(0, 2) }) }).why, /does not stand: 2 of its bonded guardians/);
  assert.match(judge({ networkId: new Uint8Array(32).fill(1) }).why, /another network/);
  assert.match(judge({ record: signed({ gone: [] }) }).why, /no ABANDONED row/);
  assert.match(judge({ node: nodes[1] }).why, /no ABANDONED row/);
  assert.match(judge({ proofRef: new Uint8Array(32).fill(0x55) }).why, /no ABANDONED row/);
  assert.match(judge({ federationId: new Uint8Array(32).fill(0x38) }).why, /another federation/, 'a true record of another federation is no evidence for this proof');
  assert.match(judgeAbandoned({ proofBytes: Uint8Array.of(1, 2, 3), evidence: SIGNED, census: seated, bonds: [], networkId: NETWORK_ID_REGTEST, inviteFederationId }).why, /no proof of an abandonment/);
  assert.match(judge({ bonds: [...seated, SPENT] }).why, /no output of that node left/, 'the seat named an output this set does not read');
  assert.match(judge({ from: SINCE + 1 }).why, /no ABANDONED row/, 'a row from before the point moves no money');
  assert.match(judge({ record: signed({ signers: [nodes[3], ...nodes.slice(0, 2)] }) }).why, /does not stand/, 'a node the census no longer holds signs nothing');
});

test('a template-3 output comes back judged, its presig the census key\'s: path B is not the set\'s on it', () => {
  const v = judge({ bonds: [...seated, SPENT, { ...LEFT, advert: { ...LEFT.advert, bondScriptTemplateVersion: 3 } }] });
  assert.deepEqual([v.slashed, v.output.template, startsByCensusKey(v.output.template)], [true, 3, true]);
});

test('path B on the proof\'s hash: the federation in the hint, the whole output less the fee into the escrow, 5 of 7 signing, and nothing below k', () => {
  const nodeKey = nodes[3].pubkey;
  const tree = bondOutputKey({ nodeKey, arbitrationKeys: set.keys, arbitrationK: set.k, bondMaturity: MATURITY, internalKey: bondInternalKey({ nodeKey, arbitrationKeys: set.keys }, { combine }).internalKey }, { tweakPoint, combine });
  const bond = { txid: LEFT.txid, vout: 1, value: 20000n, script: Uint8Array.from([0x51, 0x20, ...tree.outputKey]) };
  const slash = buildAbandonedSlash({ verdict: judge(), bond, slashHeight: 320, tipHeight: 320, recordHeight: HEIGHT, set, feeSats: 2000n });
  assert.equal(slash.ok, true, slash.why);
  const said = arbitrationCommitmentIn(slash.built.tx.outputs);
  assert.deepEqual([toHex(said.proofId), said.slashHeight, toHex(said.hint)], [toHex(abandonedProofId(proofOf())), 320, toHex(FED)]);
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
function seat({ bonds = async () => [...seated, SPENT, LEFT], record = signed(), tip = 340, ...over } = {}) {
  const n = nodes[0];
  const s = federationRecords({ round: { pubkey: n.pubkey, identity: { secret: n.secret }, db: { prepare: () => ({ all: () => [], get: () => ({ m: 0 }) }) } }, roster: { censusFor: () => ({ ok: false, why: 'none' }) }, inviteFor: () => null, networkId: NETWORK_ID_REGTEST,
    censusAt: async () => census, chainTip: async () => tip, bondsAt: bonds, store: { load: () => [{ federation: toHex(FED), record: toHex(record) }], save: () => {} }, ...over });
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
  const bytes = s.abandonedProof(rows[0].proof);
  assert.equal(toHex(abandonedProofId(bytes)), rows[0].proof, 'the seat serves the bytes by the hash it lists');
  assert.equal(judgeAbandoned({ proofBytes: bytes, census: seated, bonds: [...seated, SPENT, LEFT], networkId: NETWORK_ID_REGTEST, inviteFederationId }).slashed, true, 'and they check for anyone');
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

test('a row from before the network\'s point is not listed, and its output is not read as owed', async () => {
  const s = seat({ abandonedFrom: SINCE + 1 });
  await s.restore(inviteFederationId);
  assert.equal(s.list().length, 1, 'the record stands');
  assert.deepEqual(await s.abandonedSlashes(), []);
});

test('the proof outlives its listing: a seat with a store serves it once the output is gone, and what is not an abandonment\'s is nobody\'s', async () => {
  const store = new Map();
  let left = [...seated, SPENT, LEFT];
  const s = seat({ bonds: async () => left, keepProof: (id, bytes) => store.set(id, bytes), proofOf: (id) => store.get(id) || null });
  store.set('ee'.repeat(32), Uint8Array.of(0x0c, ...new Uint8Array(200)));
  await s.restore(inviteFederationId);
  const [row] = await s.abandonedSlashes();
  assert.equal(store.size, 2);
  left = [...seated, SPENT];
  assert.equal(toHex(abandonedProofId(s.abandonedProof(row.proof))), row.proof);
  assert.equal(s.abandonedProof('ff'.repeat(32)), null);
  assert.equal(s.abandonedProof('ee'.repeat(32)), null, 'what else the relay keeps is not served as a proof');
});

test('a proof handed to a seat is kept only when it is that hash, its record stands and its row is there', async () => {
  const s = seat();
  await s.restore(inviteFederationId);
  const bytes = proofOf(), id = toHex(abandonedProofId(bytes));
  assert.equal((await s.takeAbandonedProof('00'.repeat(32), bytes, inviteFederationId)).status, 409);
  const take = (b) => s.takeAbandonedProof(toHex(abandonedProofId(b)), b, inviteFederationId);
  assert.equal((await take(bytes.subarray(0, 135))).status, 400, 'a proof with no record is no proof');
  assert.match((await take(proofOf({ record: signed({ signers: nodes.slice(0, 2) }) }))).why, /does not stand/);
  assert.match((await take(proofOf({ record: signed({ gone: [] }) }))).why, /no such ABANDONED row/);
  assert.match((await take(proofOf({ federationId: new Uint8Array(32).fill(0x38) }))).why, /another federation/);
  assert.equal(s.abandonedProof(id), null);
  assert.deepEqual(await s.takeAbandonedProof(id, bytes, inviteFederationId), { ok: true, status: 201 });
  assert.equal(toHex(s.abandonedProof(id)), toHex(bytes), 'and the record is in the bytes served');
});

test('the hash covers the signatures: one record under two signature sets is two proofs, each whole, and a cut copy is no copy of the true one (ruling #1065)', () => {
  const otherSigners = signed({ signers: [nodes[1], nodes[2], nodes[0]] });
  assert.notEqual(toHex(abandonedProofId(proofOf({ record: otherSigners }))), toHex(abandonedProofId(proofOf())), 'two valid proofs of one offence');
  assert.equal(judge({ record: otherSigners }).slashed, true);
  assert.equal(toHex(judge({ record: otherSigners }).proofId), toHex(abandonedProofId(proofOf({ record: otherSigners }))), 'each judged under its own hash');
  assert.notEqual(toHex(abandonedProofId(proofOf({ record: signed({ signers: nodes.slice(0, 2) }) }))), toHex(abandonedProofId(proofOf())), 'a record cut under its threshold has its own hash');
});

test('a seat judges an abandonment\'s proof on its own chain, and a started output at the block before its start (ruling #1065)', async () => {
  let at = null;
  const s = seat({ bonds: async (h) => { at = h; return h < 339 ? [...seated, SPENT, LEFT] : [...seated, SPENT]; } });
  await s.restore(inviteFederationId);
  const judgeSeat = createProofJudge({ committeeOf: () => ({ ok: false, why: 'no round' }), censusOf: () => ({ ok: false, why: 'no round' }), coreOf: () => null, beaconOf: () => ({ ok: false }), replayRunOf: () => undefined, abandoned: (bytes, before) => s.abandonedVerdict(bytes, inviteFederationId, before) });
  const bytes = proofOf(), read = judgeSeat.read(bytes);
  assert.deepEqual([read.ok, read.kind, read.roundId, read.floorHeight, toHex(read.bond.txid), read.bond.vout], [true, 'abandoned', null, HEIGHT, toHex(LEFT.txid), 1]);
  const atTip = await judgeSeat(bytes);
  assert.equal(at, 340);
  assert.deepEqual([atTip.verdict, /no output of that node left/.test(atTip.why)], [false, true], 'the output is gone at the tip');
  const started = await judgeSeat(bytes, { startHeight: 339 });
  assert.equal(at, 338, 'a node reading its own hold looks before the start');
  assert.equal(started.verdict, true, started.why);
  assert.equal((await judgeSeat(proofOf({ record: signed({ signers: nodes.slice(0, 2) }) }), { startHeight: 339 })).verdict, false, 'a record short of its threshold');
  assert.equal((await judgeSeat(Uint8Array.of(0x42, 1, 2))).verdict, false, 'bytes that are no proof');
  const noChain = seat({ chainTip: null });
  assert.equal((await noChain.abandonedVerdict(bytes, inviteFederationId)).verdict, undefined, 'a seat with no chain read cannot say');
});

test('decideReturn takes an abandonment\'s proof as any slash proof: a true one keeps the slash, a false one takes the return (ruling #1062)', async () => {
  const bytes = proofOf(), bond = { txid: LEFT.txid, vout: 1 };
  const decide = (over = {}, proof = bytes, checks = {}) => decideReturn({ start: { proofId: abandonedProofId(proof) }, startHeight: 400, bondMaturity: 100, returnBlocks: 6, tip: 410, fetchProof: async () => proof,
    proofChecks: proofChecksOf({ replay: async () => { throw new Error('nothing to replay'); },
      abandoned: (b) => abandonedProofChecks({ bytes: b, nodePubkey: nodes[3].pubkey, bond, bonds: [...seated, SPENT, LEFT], censusAt: async () => seated, networkId: NETWORK_ID_REGTEST, inviteFederationId, ...checks }) }), ...over });
  assert.equal((await decide()).action, 'keep');
  assert.equal((await decide({ start: { proofId: SPEND } })).action, 'return', 'a bare proof_ref, as rehearsal 14 had it, retrieves nothing that hashes to it');
  assert.equal((await decide({}, proofOf({ record: signed({ signers: nodes.slice(0, 2) }) }))).action, 'return', 'a record short of its threshold');
  assert.equal((await decide({}, proofOf({ record: signed({ gone: [] }) }))).action, 'return', 'no row');
  assert.equal((await decide({}, proofOf({ record: Uint8Array.of(1, 2, 3) }))).action, 'return', 'bytes that are no record');
  assert.equal((await decide({}, proofOf({ node: nodes[1] }))).action, 'return', 'another node\'s row');
  assert.equal((await decide({}, proofOf({ txid: new Uint8Array(32).fill(0xee) }))).action, 'return', 'another output than the start spent');
  assert.equal((await decide({}, bytes, { from: SINCE + 1 })).action, 'return', 'a row from before the point');
  assert.equal((await decide({}, bytes, { censusAt: async () => null })).action, 'wait', 'no census there yet: as a replay that has not answered');
  assert.equal((await decide({ fetchProof: async () => null })).action, 'return', 'nobody serves the bytes');
});

test('the real doors: a proof is taken at PUT /slash/<hash> and anyone fetches it at GET /slashes?proof=<hash>', async () => {
  const invite = inviteForGuardians(FED, [{ url: 'ws://guardian.invalid', peer: 0 }]);
  const record = signed({ invite }), bytes = proofOf({ record }), id = toHex(abandonedProofId(bytes));
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, chain: 'bitcoin-regtest', chainTip: async () => 340, ballot: { censusEntriesAt: async () => census } });
  const at = `http://127.0.0.1:${node.port}`;
  try {
    assert.equal((await fetch(`${at}/slashes?proof=${id}`)).status, 404, 'nothing kept yet');
    assert.equal((await fetch(`${at}/slashes?proof=abc`)).status, 400);
    assert.equal((await fetch(`${at}/slash/${'00'.repeat(32)}`, { method: 'PUT', body: bytes })).status, 409, 'not the proof that hash names');
    const short = proofOf({ record: signed({ invite, signers: nodes.slice(0, 2) }) });
    assert.equal((await fetch(`${at}/slash/${toHex(abandonedProofId(short))}`, { method: 'PUT', body: short })).status, 409, 'a record short of its threshold');
    assert.equal((await fetch(`${at}/slash/${id}`, { method: 'PUT', body: bytes })).status, 201);
    const got = await fetch(`${at}/slashes?proof=${id}`);
    assert.equal(got.status, 200);
    assert.equal(toHex(new Uint8Array(await got.arrayBuffer())), toHex(bytes), 'the very bytes: their hash is the name');
    assert.deepEqual((await (await fetch(`${at}/slashes`)).json()).abandonedSlashes, [], 'the listing is the records\', and a served proof is no filing');
  } finally { await node.close(); }
});
