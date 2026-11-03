// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TWO OFFENCES OF TEMPLATE 3 (spec 5A.3, 5A.3B, kanban #971, #972): a release with no valid proof, and a spend that pays other than its
// table. Real keys and real BIP-341 sighashes: the offence is that the accused signed these bytes, so a stub verifier would measure nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  slashHoldsOnRelease, slashHoldsOnReleaseTable, slashHoldsOnEscrowSpend, escrowTableSpend, encodeSlashEscrowOutputs, decodeSlashEscrowOutputs, slashEscrowOutputsId, encodeSlashPayoutTable, decodeSlashPayoutTable, slashPayoutTableId, buildSlashPayoutTable, slashDistribution,
  encodeSlashProof, decodeSlashProof, affectedEntries, RELEASE_WITHOUT_PROOF, RELEASE_OFF_TABLE, joinReleaseSlashEvidence, splitReleaseSlashEvidence, encodeFraudProof,
} from '../../arena-protocol/src/slash.js';
import { createProofJudge } from '../src/proof-judge.js';
import { encodeRoundContract, decodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

import { releaseLeaf, tapLeafHash, slashLeaf } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, serializeSpend, scriptPathWitness } from '../../arena-protocol/src/bond-spend.js';
import { arbitrationCommitment, holdSlashSpend } from '../../arena-protocol/src/arbitration-tx.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { carrierEscrowPegInId } from '../../arena-protocol/src/census-key.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { SLASH_REMAINDERS } from '../../arena-protocol/src/constants.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const EMPTY = new Uint8Array(32);
const verify = (signature, digest, key) => schnorr.verify(signature, digest, key);
const person = (n) => { const secret = taggedHash('ARENA/test/Release', Uint8Array.from([n])); return { secret, key: schnorr.getPublicKey(secret) }; };
const A = Array.from({ length: 7 }, (_, i) => person(i + 1));
const B = Array.from({ length: 7 }, (_, i) => person(i + 20));
const panels = { panelA: A.map((p) => p.key), panelB: B.map((p) => p.key) };
const holdBlocks = 6;
const leafScript = releaseLeaf({ ...panels, holdBlocks });
const compare = (x, y) => { for (let i = 0; i < 32; i++) if (x.key[i] !== y.key[i]) return x.key[i] - y.key[i]; return 0; };
const ordered = [...[...A].sort(compare), ...[...B].sort(compare)];
const roundId = b32(0x51);
const holdScript = fromHex(`5120${'33'.repeat(32)}`);
const payee = fromHex(`5120${'44'.repeat(32)}`), reserves = fromHex(`5120${'55'.repeat(32)}`);
const prevouts = [{ value: 100000000n, script: holdScript }];
const accused = A[0];
const advert = { nodePubkey: accused.key, bondTxid: b32(0x77), bondVout: 1 };
const fraudProof = Uint8Array.from([1, 2, 3, 4]);
const proofId = taggedHash('ARENA/v1/SlashProof', fraudProof);

/** A signed spend of the hold: `signers` sign by the default sighash unless `hashType` is named; `leaf` is the leaf revealed. */
function signedRelease({ outputs, signers = [...A.slice(0, 5), ...B.slice(0, 5)], hashType = 0x00, leaf = leafScript, order = ordered, input = { txid: b32(0x66), vout: 0, sequence: holdBlocks } } = {}) {
  const tx = { version: 2, locktime: 0, inputs: [input], outputs };
  const digest = tapSighash({ ...tx, prevouts, inputIndex: 0, leafHash: tapLeafHash(leaf), hashType });
  const stack = order.map((p) => {
    if (!signers.includes(p)) return new Uint8Array(0);
    const sig = schnorr.sign(digest, p.secret);
    return hashType ? Uint8Array.from([...sig, hashType]) : sig;
  }).reverse();
  return serializeSpend({ ...tx, witnesses: [scriptPathWitness({ stack, script: leaf, controlBlock: new Uint8Array(65).fill(0xc0) })] });
}

const pays = [{ value: 40000000n, script: payee, pays: 'player_carrier' }, { value: 59990000n, script: reserves, pays: 'reserves' }];
const table = { networkId: b32(0x10), roundId, proofId, bondTxid: b32(0x66), bondVout: 0,
  entries: [{ entryId: b32(0xe1), playerPubkey: b32(0xa1), lossMsat: 40000000000n }], reserves: [{ federationId: b32(0xf1), msat: 59990000000n }], outputs: pays };
const commits = (id = proofId, t = table) => arbitrationCommitment(id, 900, slashPayoutTableId(t));
const proofOf = (spend, transcriptHash, change = {}) => ({ roundId, playerPubkey: EMPTY, nodePubkey: accused.key, transcriptHash,
  signedResultId: parseTransaction(spend).txid, bondTxid: advert.bondTxid, bondVout: advert.bondVout, ...change });

const onRelease = (over = {}) => {
  const release = over.release || signedRelease({ outputs: [commits(), ...pays] });
  return slashHoldsOnRelease({ proof: over.proof || proofOf(release, proofId), release, prevouts, panels, holdBlocks, fraudProof, proofChecks: false, advert, verify, ...over });
};

test('the body is the ordinary slash proof, and the row is named in the offences', () => {
  const release = signedRelease({ outputs: [commits(), ...pays] });
  const proof = proofOf(release, proofId);
  assert.equal(toHex(encodeSlashProof(decodeSlashProof(encodeSlashProof(proof)))), toHex(encodeSlashProof(proof)));
  assert.deepEqual(affectedEntries({ offence: RELEASE_WITHOUT_PROOF, entries: [{ activated: true }] }).affected, []);
});

test('a release whose committed proof does not check slashes a panel member who signed it, on either panel', () => {
  const r = onRelease();
  assert.equal(r.slashed, true, r.why);
  assert.equal(r.offence, RELEASE_WITHOUT_PROOF);
  assert.deepEqual([toHex(r.bond.txid), r.bond.vout], [toHex(advert.bondTxid), 1]);
  const release = signedRelease({ outputs: [commits(), ...pays] });
  const other = B[0];
  const rb = slashHoldsOnRelease({ proof: proofOf(release, proofId, { nodePubkey: other.key }), release, prevouts, panels, holdBlocks, fraudProof, proofChecks: false,
    advert: { ...advert, nodePubkey: other.key }, verify });
  assert.equal(rb.slashed, true, rb.why);
});

test('a proof that checks, or nobody\'s verdict, leaves the bond alone: the default is the one that costs an honest member nothing', () => {
  assert.match(onRelease({ proofChecks: true }).why, /nobody has replayed/);
  assert.match(onRelease({ proofChecks: undefined }).why, /nobody has replayed/);
  assert.match(onRelease({ proofChecks: 0 }).why, /nobody has replayed/);
});

test('the bytes must hash to the OP_RETURN, and a commitment nobody can open slashes nobody', () => {
  assert.match(onRelease({ fraudProof: Uint8Array.of(9) }).why, /do not hash/);
  assert.match(onRelease({ fraudProof: undefined }).why, /no bytes attached/);
});

test('a release that commits to no proof at all has none: no verdict is needed', () => {
  const release = signedRelease({ outputs: pays });
  const r = slashHoldsOnRelease({ proof: proofOf(release, EMPTY), release, prevouts, panels, holdBlocks, advert, verify });
  assert.equal(r.slashed, true, r.why);
  assert.match(r.why, /commits to no proof/);
  assert.match(slashHoldsOnRelease({ proof: proofOf(release, proofId), release, prevouts, panels, holdBlocks, advert, verify }).why, /commits to nothing/);
});

test('only the signature of the accused counts: a member who refused, a forged slot, a stranger', () => {
  const refused = signedRelease({ outputs: [commits(), ...pays], signers: [...A.slice(1, 6), ...B.slice(0, 5)] });
  assert.match(onRelease({ release: refused, proof: proofOf(refused, proofId) }).why, /no good signature/);
  // another member's signature in the accused's slot
  const forged = parseTransaction(signedRelease({ outputs: [commits(), ...pays] }));
  const w = forged.witnesses[0];
  const slot = 13 - ordered.indexOf(accused);
  const donor = w.findIndex((x, i) => x.length === 64 && i !== slot);
  w[slot] = w[donor];
  const bytes = serializeSpend({ version: 2, locktime: 0, inputs: [{ txid: b32(0x66), vout: 0, sequence: holdBlocks }], outputs: forged.outputs, witnesses: [w] });
  assert.match(onRelease({ release: bytes, proof: proofOf(bytes, proofId) }).why, /no good signature/);
  const stranger = person(90);
  const release = signedRelease({ outputs: [commits(), ...pays] });
  assert.match(onRelease({ release, proof: proofOf(release, proofId, { nodePubkey: stranger.key }), advert: { ...advert, nodePubkey: stranger.key } }).why, /on neither panel/);
});

test('choosing an explicit hash type does not hide a signer', () => {
  for (const hashType of [0x01, 0x81, 0x02]) {
    const release = signedRelease({ outputs: [commits(), ...pays], hashType });
    assert.equal(onRelease({ release, proof: proofOf(release, proofId) }).slashed, true, `0x${hashType.toString(16)}`);
  }
});

test('the leaf must be this round\'s, the transaction the one the proof names, the bond the accused\'s own, every prevout given', () => {
  const others = { panelA: B.map((p) => p.key), panelB: A.map((p) => p.key) };
  assert.match(onRelease({ panels: others }).why, /not this round's release leaf/);
  assert.match(onRelease({ holdBlocks: 7 }).why, /not this round's release leaf/);
  const release = signedRelease({ outputs: [commits(), ...pays] });
  assert.match(onRelease({ release, proof: proofOf(release, proofId, { signedResultId: b32(1) }) }).why, /not the one this proof names/);
  assert.match(onRelease({ advert: { ...advert, bondVout: 2 } }).why, /the node advertised/);
  assert.match(onRelease({ advert: null }).why, /no advertisement/);
  assert.match(onRelease({ prevouts: [] }).why, /every input needs/);
  assert.match(onRelease({ verify: undefined }).why, /needs a verifier/);
  assert.match(onRelease({ release: Uint8Array.of(1, 2), proof: proofOf(release, proofId) }).why, /not a transaction/);
  assert.match(onRelease({ proof: proofOf(release, proofId, { playerPubkey: b32(1) }) }).why, /names no player/);
  assert.match(onRelease({ panels: undefined }).why, /no panels/);
});

const onTable = (over = {}) => {
  const spend = over.spend || signedRelease({ outputs: [commits(), ...pays] });
  return slashHoldsOnReleaseTable({ proof: over.proof || proofOf(spend, slashPayoutTableId(table)), spend, prevouts, table: encodeSlashPayoutTable(table), advert, verify, ...over });
};
const offTable = (outputs, t = table) => {
  const spend = signedRelease({ outputs: [commits(proofId, t), ...outputs] });
  return onTable({ spend, proof: proofOf(spend, slashPayoutTableId(t)), table: encodeSlashPayoutTable(t) });
};

test('the PayoutTable\'s bytes are the ruling\'s, field by field, and its id is the tag over them (kanban #1021)', () => {
  const h = (n, b) => toHex(new Uint8Array(n).fill(b));
  const want = `01${h(32, 0x10)}${h(32, 0x51)}${toHex(proofId)}${h(32, 0x66)}00000000`
    + `0001${h(32, 0xe1)}${h(32, 0xa1)}${(40000000000n).toString(16).padStart(16, '0')}`
    + `0001${h(32, 0xf1)}${(59990000000n).toString(16).padStart(16, '0')}`
    + `0002${(40000000n).toString(16).padStart(16, '0')}0022${toHex(payee)}01${(59990000n).toString(16).padStart(16, '0')}0022${toHex(reserves)}02`;
  assert.equal(toHex(encodeSlashPayoutTable(table)), want);
  assert.equal(toHex(slashPayoutTableId(table)), toHex(taggedHash('ARENA/v1/SlashPayoutTable', fromHex(want))));
  assert.equal(toHex(encodeSlashPayoutTable(decodeSlashPayoutTable(encodeSlashPayoutTable(table)))), want);
  assert.throws(() => decodeSlashPayoutTable(Uint8Array.of(2, 0, 0)), /version 1/);
  assert.throws(() => encodeSlashPayoutTable({ ...table, outputs: [...pays].reverse() }), /pays in order/);
  assert.throws(() => encodeSlashPayoutTable({ ...table, reserves: [{ federationId: b32(2), msat: 1n }, { federationId: b32(1), msat: 1n }] }), /not sorted/);
});

test('a release that pays its table exactly is no offence', () => {
  assert.match(onTable().why, /pays exactly its table/);
});

test('moved money, an extra output, a missing one or another order slashes the signer, and no replay is needed', () => {
  const thief = fromHex(`5120${'99'.repeat(32)}`);
  const cases = {
    'an output to another script': [{ value: 40000000n, script: thief }, pays[1]],
    'a sat moved between outputs': [{ value: 40000001n, script: payee }, { value: 59989999n, script: reserves }],
    'a new output': [...pays, { value: 1000n, script: thief }],
    'an output left out': [pays[1]],
    'the outputs in another order': [...pays].reverse(),
  };
  for (const [name, outputs] of Object.entries(cases)) {
    const r = offTable(outputs);
    assert.equal(r.slashed, true, `${name}: ${r.why}`);
    assert.equal(r.offence, RELEASE_OFF_TABLE);
  }
});

test('the table must be the release\'s: its hash in an OP_RETURN that comes first, its round, its fraud proof', () => {
  const other = { ...table, entries: [] };
  assert.match(onTable({ table: encodeSlashPayoutTable(other) }).why, /not the one the release committed to/);
  assert.match(onTable({ table: Uint8Array.of(1) }).why, /not a slash payout table|bytes/);
  assert.match(offTable(pays, { ...table, roundId: b32(0x52) }).why, /different round/);
  assert.match(offTable(pays, { ...table, proofId: b32(0x53) }).why, /different fraud proof/);
  const noTable = signedRelease({ outputs: [arbitrationCommitment(proofId, 900), ...pays] });
  assert.match(onTable({ spend: noTable, proof: proofOf(noTable, slashPayoutTableId(table)) }).why, /does not open with/);
  const last = signedRelease({ outputs: [...pays, commits()] });
  assert.match(onTable({ spend: last, proof: proofOf(last, slashPayoutTableId(table)) }).why, /does not open with/);
});

test('a spend signed by the census key names no one: a key-path FROST signature reaches no bond', () => {
  const tx = { version: 2, locktime: 0, inputs: [{ txid: b32(0x66), vout: 0, sequence: 0 }], outputs: [commits(), { value: 1n, script: payee }] };
  const spend = serializeSpend({ ...tx, witnesses: [[new Uint8Array(64).fill(1)]] });
  assert.match(onTable({ spend, proof: proofOf(spend, slashPayoutTableId(table)) }).why, /no good signature/);
});

const fed = (n, reserveSats = 0n) => ({ federation: toHex(b32(n)), status: 'OPEN', reserveKey: 'k', reserveSats, exposureCapSats: 100000000000n, script: fromHex(`5120${toHex(b32(n))}`) });
const built = (over = {}) => buildSlashPayoutTable({ networkId: b32(0x10), roundId, proofId, bond: { txid: b32(0x77), vout: 1, value: 100000000n },
  entries: [{ entryId: b32(2), playerPubkey: b32(0xa2), lossMsat: 7000000500n }, { entryId: b32(1), playerPubkey: b32(0xa1), lossMsat: 3000000000n }],
  filer: { script: fromHex(`5120${'aa'.repeat(32)}`), sats: 5000n }, carriers: [{ script: fromHex(`5120${'c1'.repeat(32)}`), bondSats: 6000000n }, { script: fromHex(`5120${'c2'.repeat(32)}`), bondSats: 90000000n }],
  federations: [fed(0xf2), fed(0xf1)], feeSats: 1500n, escrowScript: fromHex(`5120${'ee'.repeat(32)}`), ...over });
const paysOf = (t) => t.outputs.map((o) => [o.pays, o.value]);
const sum = (t) => t.outputs.reduce((a, o) => a + o.value, 0n);

test('the table recomputed: order filer, carriers, reserves, escrow; carriers in score order to their own bond; outputs + fee = the bond (kanban #1021)', () => {
  const r = built();
  assert.equal(r.ok, true, r.why);
  const facts = paysOf(r.table);
  console.log('  FACTS:', JSON.stringify(facts.map(([p, v]) => [p, String(v)])));
  assert.deepEqual(facts.slice(0, 3), [['filer', 5000n], ['player_carrier', 6000000n], ['player_carrier', 4000001n]], 'the first carrier to its bond, the rest to the next, rounded up');
  assert.deepEqual(facts.slice(3).map((x) => x[0]), ['reserves', 'reserves']);
  assert.equal(sum(r.table) + 1500n, 100000000n, 'outputs + fee = the bond');
  assert.deepEqual(r.table.entries.map((e) => e.entryId[0]), [1, 2], 'ascending entry_id');
  assert.deepEqual(r.table.reserves.map((f) => f.federationId[0]), [0xf1, 0xf2], 'ascending federation_id');
  assert.equal(toHex(encodeSlashPayoutTable(built().table)), toHex(encodeSlashPayoutTable(r.table)), 'two members recompute one table, byte-equal');
});

test('the fee comes off the reserves, never the players', () => {
  const low = built({ feeSats: 1000n }), high = built({ feeSats: 91000n });
  const carried = (t) => t.outputs.filter((o) => o.pays === 'player_carrier').reduce((a, o) => a + o.value, 0n);
  const reserved = (t) => t.outputs.filter((o) => o.pays === 'reserves').reduce((a, o) => a + o.value, 0n);
  assert.equal(carried(low.table), carried(high.table));
  assert.equal(reserved(low.table) - reserved(high.table), 90000n);
});

test('what fits no carrier and no federation is the escrow; with no panels, no carrier, the players\' part waits there (kanban #1021)', () => {
  const none = built({ carriers: [] });
  assert.equal(none.ok, true, none.why);
  assert.deepEqual(paysOf(none.table), [['filer', 5000n], ['escrow', 99993500n]], 'no player_carrier output, and all of it waits in escrow');
  assert.deepEqual(none.table.reserves, []);
  assert.equal(sum(none.table) + 1500n, 100000000n);
  assert.deepEqual(paysOf(built({ carriers: [{ script: payee, bondSats: 100n }] }).table).map((x) => x[0]), ['filer', 'escrow'], 'a carrier under dust carries nothing');
  assert.equal(built({ carriers: [], entries: [] }).table.outputs.some((o) => o.pays === 'reserves'), true, 'with no player owed the reserves are paid as ever');
  assert.match(built({ carriers: [], escrowScript: null }).why, /wait for a carrier/);
  const noRoom = built({ federations: [] });
  assert.equal(noRoom.table.outputs[noRoom.table.outputs.length - 1].pays, 'escrow');
  assert.equal(sum(noRoom.table) + 1500n, 100000000n);
  assert.match(built({ federations: [], escrowScript: null }).why, /no escrow script/);
  assert.match(built({ feeSats: 99999999n }).why, /cannot carry/);
});

test('a fallback carries the same OP_RETURN fields and a table of this format; only its wait differs (kanban #1021, #1034 answer 1)', () => {
  const { table: t } = built();
  const hold = { txid: b32(0x66), vout: 0, value: 100000000n, script: holdScript };
  const args = { hold, proofId, slashHeight: 900, table: t, tableId: slashPayoutTableId(t), clocks: { holdBlocks: 6, fallbackBlocks: 288 } };
  const release = holdSlashSpend({ ...args, path: 'release' }), fallback = holdSlashSpend({ ...args, path: 'fallback' });
  assert.equal(release.tx.outputs[0].script[0], 0x6a);
  assert.deepEqual(release.tx.outputs.map((o) => toHex(o.script)), fallback.tx.outputs.map((o) => toHex(o.script)));
  assert.deepEqual(release.tx.outputs.map((o) => o.value), fallback.tx.outputs.map((o) => o.value));
  assert.deepEqual([release.tx.inputs[0].sequence, fallback.tx.inputs[0].sequence], [6, 288]);
  assert.equal(release.fee.sats, 1500n);
  assert.equal(holdSlashSpend({ ...args, path: 'return' }).ok, false);
});

test('a carrier under dust is raised out of the reserves, and merged into the one before it if they cannot cover it (kanban #1031)', () => {
  const small = { entries: [{ entryId: b32(1), playerPubkey: b32(0xa1), lossMsat: 6100000n }], federations: [], escrowScript: null, filer: null,
    carriers: [{ script: fromHex(`5120${'c1'.repeat(32)}`), bondSats: 6000n }, { script: fromHex(`5120${'c2'.repeat(32)}`), bondSats: 90000n }] };
  const raised = built({ ...small, bond: { txid: b32(0x77), vout: 1, value: 6500n }, feeSats: 170n, federations: [fed(0xf1)] });
  assert.deepEqual(paysOf(raised.table).slice(0, 2), [['player_carrier', 6000n], ['player_carrier', 330n]]);
  const tight = built({ ...small, bond: { txid: b32(0x77), vout: 1, value: 6300n }, feeSats: 200n });
  assert.equal(tight.ok, true, tight.why);
  assert.deepEqual(paysOf(tight.table), [['player_carrier', 6100n]], 'the merge pays the player whole');
});

test('an escrow spend answers to the release\'s table: both ids, peg-ins a carrier signed for this table, amounts by pays (kanban #1031, #1034 answer 2)', () => {
  const escrowScript = fromHex(`5120${'ee'.repeat(32)}`), pegIn = fromHex(`5120${'dd'.repeat(32)}`), fedIn = fromHex(`5120${'dc'.repeat(32)}`), thief = fromHex(`5120${'99'.repeat(32)}`);
  const t = { ...table, outputs: [pays[0], { value: 59990000n, script: escrowScript, pays: 'escrow' }],
    entries: [{ entryId: b32(0xe1), playerPubkey: b32(0xa1), lossMsat: 45000000000n }], reserves: [] };   // 5,000,000 sat of the players' part left in escrow
  const id = slashPayoutTableId(t);
  const release = signedRelease({ outputs: [arbitrationCommitment(proofId, 900, id), ...t.outputs] });
  const set = [...A].sort(compare);
  const leaf = slashLeaf(set.map((p) => p.key), 5);
  const input = { txid: parseTransaction(release).txid, vout: 2, sequence: 0xfffffffd };
  const signedBy = (who, tableId, script) => ({ key: who.key, signature: schnorr.sign(carrierEscrowPegInId(tableId, script), who.secret) });
  const carrier = A[3], stranger = person(40);
  const pegs = new Map([[toHex(pegIn), signedBy(carrier, id, pegIn)], [toHex(fedIn), signedBy(carrier, id, fedIn)], [toHex(thief), signedBy(stranger, id, thief)]]);
  const pegInOf = (script) => pegs.get(toHex(script)) || null;
  const isCarrier = (k) => k === toHex(carrier.key);
  const opening = (outs, tid = id) => ({ value: 0n, script: Uint8Array.from([0x6a, 64, ...tid, ...slashEscrowOutputsId({ tableId: tid, outputs: outs })]) });
  const sendOf = (outs) => ({ outputs: encodeSlashEscrowOutputs({ tableId: id, outputs: outs }), spend: signedRelease({ outputs: [opening(outs), ...outs.map((o) => ({ value: o.value, script: o.script }))], signers: set.slice(0, 5), leaf, order: set, input }) });
  const ask = ({ spend, outputs }, over = {}) => slashHoldsOnEscrowSpend({ proof: proofOf(spend, id), spend, outputs, release, prevouts, table: encodeSlashPayoutTable(t), pegInOf, isCarrier, advert, verify, ...over });
  const player = (value, script = pegIn) => ({ value, script, pays: 'player_carrier' }), reserve = (value) => ({ value, script: fedIn, pays: 'reserves' }), back = (value) => ({ value, script: escrowScript, pays: 'escrow' });

  const built2 = escrowTableSpend({ escrow: { txid: input.txid, vout: 2, value: 59990000n, script: escrowScript }, tableId: id, payees: [player(1000n)], feeSats: 500n });
  assert.equal(built2.ok, true, built2.why);
  assert.equal(toHex(built2.tx.outputs[0].script), toHex(opening(built2.outputs.outputs).script), 'OP_RETURN = payout_table_id || its outputs\' id');
  assert.deepEqual(built2.outputs.outputs.map((o) => [o.pays, o.value]), [['player_carrier', 1000n], ['escrow', 59988500n]]);
  assert.deepEqual(decodeSlashEscrowOutputs(encodeSlashEscrowOutputs(built2.outputs)).outputs.map((o) => o.pays), ['player_carrier', 'escrow']);

  assert.match(ask(sendOf([player(1000n), back(59980000n)])).why, /answers to its table/);
  assert.match(ask(sendOf([player(5000000n), reserve(54000000n)])).why, /answers to its table/, 'the players\' part, then the rest placed by load');
  const bare = { outputs: encodeSlashEscrowOutputs({ tableId: id, outputs: [player(1000n)] }), spend: signedRelease({ outputs: [{ value: 1000n, script: pegIn }], signers: set.slice(0, 5), leaf, order: set, input }) };
  assert.match(ask(bare).why, /does not carry payout_table_id/);
  assert.equal(ask(bare).offence, RELEASE_OFF_TABLE);
  const noTable = { ...bare, spend: signedRelease({ outputs: [opening([player(1000n)], b32(1)), { value: 1000n, script: pegIn }], signers: set.slice(0, 5), leaf, order: set, input }) };
  assert.match(ask(noTable).why, /does not carry payout_table_id/);
  const honest = sendOf([player(1000n)]);
  assert.match(ask({ ...honest, outputs: encodeSlashEscrowOutputs({ tableId: id, outputs: [player(1000n), back(5000n)] }) }).why, /not the ones that spend committed to/, 'nobody is slashed on another list');
  const off = [player(1000n)];
  const moved = { outputs: encodeSlashEscrowOutputs({ tableId: id, outputs: off }), spend: signedRelease({ outputs: [opening(off), { value: 2000n, script: pegIn }], signers: set.slice(0, 5), leaf, order: set, input }) };
  assert.match(ask(moved).why, /other than its own outputs/);
  assert.match(ask(sendOf([player(1000n, thief)])).why, /no carrier signed/, 'signed, but not by a carrier');
  assert.match(ask(sendOf([player(1000n)]), { pegInOf: () => null }).why, /no carrier signed/, 'a script nobody signed');
  pegs.set(toHex(pegIn), signedBy(carrier, b32(0x31), pegIn));
  assert.match(ask(sendOf([player(1000n)])).why, /no carrier signed/, 'a peg-in signed for another table');
  pegs.set(toHex(pegIn), signedBy(carrier, id, pegIn));
  assert.match(ask(sendOf([{ value: 1000n, script: thief, pays: 'escrow' }])).why, /no carrier signed/, 'escrow change goes back to the escrow');
  assert.match(ask(sendOf([player(5000001n)])).why, /where the table left 5000000 and 54990000/, 'past the players\' part');
  assert.match(ask(sendOf([reserve(54990001n)])).why, /where the table left/, 'the players\' part is not the reserves\'');
  const first = sendOf([player(4000000n)]), second = sendOf([player(2000000n)]);
  assert.match(ask(second, { earlier: [first] }).why, /where the table left/, 'counted with the spends before it');
  assert.match(ask(sendOf([player(1000000n)]), { earlier: [first] }).why, /answers to its table/);
  const away = { ...honest, spend: signedRelease({ outputs: [opening([player(1000n)]), { value: 1000n, script: pegIn }], signers: set.slice(0, 5), leaf, order: set, input: { ...input, txid: b32(3) } }) };
  assert.match(ask(away).why, /does not spend the release/);
});

test('panel members take nothing from a slash: there is no census share, only each real loss and the reserves (#976)', () => {
  const contract = { slashRemainder: SLASH_REMAINDERS[0] };
  const split = slashDistribution({ escrowSats: 100000000n, roundId, contract, losses: new Map([['aa'.repeat(32), 5000000n]]) });
  assert.deepEqual([...split.players.keys()], ['aa'.repeat(32)]);
  assert.equal(split.playersMsat + split.reservesMsat, 100000000000n);
  assert.equal(split.burned, 0n);
  assert.deepEqual(Object.keys(split).sort(), ['burned', 'players', 'playersMsat', 'reservesMsat', 'shortMsat']);
});

// A SEAT'S OWN WORD ON A RELEASE (kanban #1065): the record is anyone's to write, the release is on the chain, and the panels are redrawn by the reader. Bytes that hash to the release's OP_RETURN and read as no proof do not check.
const contractOf = () => decodeRoundContract(encodeRoundContract({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n,
  custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: 600, exposureReference: 1000, corridorHalfWidth: 40,
  spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 100,
  rankNumerator: 3, rankDenominator: 4, nodes: [],
}));
const seatOn = (over = {}) => createProofJudge({ committeeOf: () => ({ ok: true, committee: [] }), censusOf: () => ({ ok: true, entries: [{ pubkey: accused.key, txid: advert.bondTxid, vout: advert.bondVout, advert }] }), coreOf: () => null, beaconOf: () => ({ ok: false }),
  replayRunOf: () => undefined, panelsOf: () => ({ ok: true, ...panels }), holdBlocksOf: () => holdBlocks, ...over });

test('a release on bytes that do not check, and a release off its table, are judged by a seat from the complete proof alone', async () => {
  const contract = contractOf(), rid = roundIdOf(contract), encoded = encodeRoundContract(contract);
  const release = signedRelease({ outputs: [commits(), ...pays] });
  const proof = proofOf(release, proofId, { roundId: rid });
  const record = joinReleaseSlashEvidence(encodeSlashProof(proof), { release, prevouts, fraudProof });
  const back = splitReleaseSlashEvidence(record);
  assert.deepEqual([toHex(back.release), back.prevouts.length, back.prevouts[0].value, toHex(back.prevouts[0].script), toHex(back.fraudProof), back.table.length], [toHex(release), 1, prevouts[0].value, toHex(holdScript), toHex(fraudProof), 0]);
  assert.throws(() => splitReleaseSlashEvidence(Uint8Array.of(...record, 0)), /trailing|left over|bytes/);
  const complete = encodeFraudProof({ evidence: record, contract: encoded });
  const said = await seatOn()(complete);
  assert.equal(said.verdict, true, said.why);
  assert.equal(seatOn().read(complete).kind, 'release');
  assert.deepEqual([toHex(seatOn().read(complete).bond.txid), seatOn().read(complete).bond.vout], [toHex(advert.bondTxid), advert.bondVout]);
  const stranger = person(99), wrongPanels = { panelA: [stranger.key], panelB: [stranger.key] };
  assert.equal((await seatOn({ panelsOf: () => ({ ok: true, ...wrongPanels }) })(complete)).verdict, false, 'panels the reader drew are the ones that count');
  assert.equal((await seatOn({ panelsOf: () => ({ ok: false, why: 'not read' }) })(complete)).verdict, undefined, 'no panels read: this seat cannot say');

  const off = [{ value: pays[0].value - 1n, script: reserves, pays: 'reserves' }];
  const t2 = { ...table, roundId: rid }, spend = signedRelease({ outputs: [commits(proofId, t2), ...off] });
  const tableRecord = joinReleaseSlashEvidence(encodeSlashProof(proofOf(spend, slashPayoutTableId(t2), { roundId: rid })), { release: spend, prevouts, table: encodeSlashPayoutTable(t2) });
  const offTableSaid = await seatOn()(encodeFraudProof({ evidence: tableRecord, contract: encoded }));
  assert.equal(offTableSaid.verdict, true, offTableSaid.why);
  const paysItsTable = signedRelease({ outputs: [commits(proofId, t2), ...pays] });
  const fine = joinReleaseSlashEvidence(encodeSlashProof(proofOf(paysItsTable, slashPayoutTableId(t2), { roundId: rid })), { release: paysItsTable, prevouts, table: encodeSlashPayoutTable(t2) });
  assert.match((await seatOn()(encodeFraudProof({ evidence: fine, contract: encoded }))).why, /pays exactly its table/);
});
