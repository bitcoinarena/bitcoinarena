// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TWO OFFENCES OF TEMPLATE 3 (spec 5A.3, 5A.3B, kanban #971, #972): a release with no valid proof, and a spend that pays other than its
// table. Real keys and real BIP-341 sighashes: the offence is that the accused signed these bytes, so a stub verifier would measure nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  slashHoldsOnRelease, slashHoldsOnReleaseTable, encodeSlashTable, decodeSlashTable, slashTableId, slashDistribution, encodeSlashProof, decodeSlashProof,
  affectedEntries, RELEASE_WITHOUT_PROOF, RELEASE_OFF_TABLE,
} from '../../arena-protocol/src/slash.js';
import { releaseLeaf, tapLeafHash, slashLeaf } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, serializeSpend, scriptPathWitness } from '../../arena-protocol/src/bond-spend.js';
import { arbitrationCommitment } from '../../arena-protocol/src/arbitration-tx.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
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

const pays = [{ value: 40000000n, script: payee }, { value: 59990000n, script: reserves }];
const table = { roundId, proofId, rows: [{ playerPubkey: b32(0xa1), amountMsat: 40000000000n }], outputs: pays };
const commits = (id = proofId, t = table) => arbitrationCommitment(id, 900, slashTableId(t));
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
  return slashHoldsOnReleaseTable({ proof: proofOf(spend, slashTableId(table)), spend, prevouts, table: encodeSlashTable(table), advert, verify, ...over });
};
const offTable = (outputs, t = table) => {
  const spend = signedRelease({ outputs: [commits(proofId, t), ...outputs] });
  return onTable({ spend, proof: proofOf(spend, slashTableId(t)), table: encodeSlashTable(t) });
};

test('the table has one id whatever order it is written in, and reads back', () => {
  const swapped = { ...table, outputs: [...pays].reverse() };
  assert.equal(toHex(slashTableId(swapped)), toHex(slashTableId(table)));
  const back = decodeSlashTable(encodeSlashTable(table));
  assert.equal(toHex(encodeSlashTable(back)), toHex(encodeSlashTable(table)));
  assert.throws(() => decodeSlashTable(Uint8Array.of(0, 0, 0)), /not a slash payout table/);
});

test('a release that pays its table exactly, in any output order, is no offence', () => {
  assert.match(onTable().why, /pays exactly its table/);
  assert.match(offTable([...pays].reverse()).why, /pays exactly its table/);
});

test('moved money, an extra output or a missing one slashes the signer, and no replay is needed', () => {
  const thief = fromHex(`5120${'99'.repeat(32)}`);
  const cases = {
    'an output to another script': [{ value: 40000000n, script: thief }, pays[1]],
    'a sat moved between outputs': [{ value: 40000001n, script: payee }, { value: 59989999n, script: reserves }],
    'a new output': [...pays, { value: 1000n, script: thief }],
    'an output left out': [pays[1]],
  };
  for (const [name, outputs] of Object.entries(cases)) {
    const r = offTable(outputs);
    assert.equal(r.slashed, true, `${name}: ${r.why}`);
    assert.equal(r.offence, RELEASE_OFF_TABLE);
  }
});

test('the table must be the release\'s: its hash in the OP_RETURN, its round, its fraud proof', () => {
  const other = { ...table, rows: [] };
  assert.match(onTable({ table: encodeSlashTable(other) }).why, /not the one the release committed to/);
  assert.match(onTable({ table: Uint8Array.of(1) }).why, /not a slash payout table/);
  const foreignRound = { ...table, roundId: b32(0x52) };
  assert.match(offTable(pays, foreignRound).why, /different round/);
  const foreignProof = { ...table, proofId: b32(0x53) };
  assert.match(offTable(pays, foreignProof).why, /different fraud proof/);
  const noTable = signedRelease({ outputs: [arbitrationCommitment(proofId, 900), ...pays] });
  assert.match(onTable({ spend: noTable, proof: proofOf(noTable, slashTableId(table)) }).why, /commits to no table/);
});

test('an escrow payout: k-of-m signers named, judged against the release it spends', () => {
  const release = signedRelease({ outputs: [commits(), ...pays] });
  const set = [...A].sort(compare);
  const leaf = slashLeaf(set.map((p) => p.key), 5);
  const input = { txid: parseTransaction(release).txid, vout: 1, sequence: 0xfffffffd };
  const payout = signedRelease({ outputs: [{ value: 39000000n, script: payee }], signers: set.slice(0, 5), leaf, order: set, input });
  const ran = (spend, rel = release) => onTable({ spend, release: rel, proof: proofOf(spend, slashTableId(table)) });
  assert.equal(ran(payout).slashed, true, ran(payout).why);
  const honest = signedRelease({ outputs: pays, signers: set.slice(0, 5), leaf, order: set, input });
  assert.match(ran(honest).why, /pays exactly its table/);
  const elsewhere = signedRelease({ outputs: pays, signers: set.slice(0, 5), leaf, order: set, input: { ...input, txid: b32(3) } });
  assert.match(ran(elsewhere).why, /does not spend the release/);
});

test('a spend signed by the census key names no one: a key-path FROST signature reaches no bond', () => {
  const tx = { version: 2, locktime: 0, inputs: [{ txid: b32(0x66), vout: 0, sequence: 0 }], outputs: [commits(), { value: 1n, script: payee }] };
  const spend = serializeSpend({ ...tx, witnesses: [[new Uint8Array(64).fill(1)]] });
  assert.match(onTable({ spend, proof: proofOf(spend, slashTableId(table)) }).why, /no good signature/);
});

test('panel members take nothing from a slash: there is no census share, only each real loss and the reserves (#976)', () => {
  const contract = { slashRemainder: SLASH_REMAINDERS[0] };
  const split = slashDistribution({ escrowSats: 100000000n, roundId, contract, losses: new Map([['aa'.repeat(32), 5000000n]]) });
  assert.deepEqual([...split.players.keys()], ['aa'.repeat(32)]);
  assert.equal(split.playersMsat + split.reservesMsat, 100000000000n);
  assert.equal(split.burned, 0n);
  assert.deepEqual(Object.keys(split).sort(), ['burned', 'players', 'playersMsat', 'reservesMsat', 'shortMsat']);
});
