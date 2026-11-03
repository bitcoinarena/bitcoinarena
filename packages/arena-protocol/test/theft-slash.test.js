// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARK OF THEFT TO A SLASH OF EVERY SEATED GUARDIAN'S BOND (kanban #1093 part 2, rulings #1106, #1109): the proof carries its sessions, who is taken, what a checker holds the verifier's
// answer to, the spend on its own chain, its three answers, and where the slash is owed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTheftProof, decodeTheftProof, isTheftProof, theftProofId, theftTakes, theftOutputs, theftSlashStands, sessionsShowMark, spendStands, slashedGuardianPays,
  theftVerifyInput, THEFT_PROOF_HEAD_BYTES } from '../src/theft-slash.js';
import { GONE } from '../src/federation-record.js';
import { TAG, TYPE_THEFT_PROOF } from '../src/constants.js';
import { serializeSpend } from '../src/bond-spend.js';
import { parseTransaction } from '../src/tx.js';
import { taggedHash, toHex } from '../src/hash.js';

const FED = new Uint8Array(32).fill(0x37), NODE = new Uint8Array(32).fill(0x11), OTHER = new Uint8Array(32).fill(0x22), GONE_NODE = new Uint8Array(32).fill(0x33);
const PEER = new Uint8Array(33).fill(2), PEER2 = new Uint8Array(33).fill(3), PEER3 = new Uint8Array(33).fill(4);
const BOND = new Uint8Array(32).fill(0xb1), RECORD = Uint8Array.of(9, 9, 9, 9), CONFIG = Uint8Array.of(7, 7, 7);
const sessions = (n) => Array.from({ length: n }, (_, i) => Uint8Array.of(0xee, i, i + 1));
const RESERVE = { txid: new Uint8Array(32).fill(0xd0), vout: 1 };
const spendTx = serializeSpend({ version: 2, locktime: 0, inputs: [{ txid: Uint8Array.from(RESERVE.txid).reverse(), vout: 1, sequence: 0xfffffffd }], outputs: [{ value: 90000n, script: Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(5)) }], witnesses: [[new Uint8Array(64)]] });
const SPEND = Uint8Array.from(parseTransaction(spendTx).txid).reverse();
const inflation = (over = {}) => ({ federationId: FED, nodePubkey: NODE, txid: BOND, vout: 2, mark: { kind: 'inflation', height: 700, session: 4 }, record: RECORD, config: CONFIG, firstSession: 0, sessions: sessions(5), ...over });
const unbacked = (over = {}) => ({ federationId: FED, nodePubkey: NODE, txid: BOND, vout: 2, mark: { kind: 'unbacked-spend', height: 710, session: 12, spendTxid: SPEND }, record: RECORD, config: CONFIG,
  firstSession: 10, sessions: sessions(3), reserve: RESERVE, spendTx, ...over });

test('a theft\'s proof carries its record, the config and every session as bytes, and reads back whole; its id is the slash-proof hash of its bytes', () => {
  const b = encodeTheftProof(inflation());
  assert.equal(b[0], TYPE_THEFT_PROOF);
  assert.equal(isTheftProof(b), true);
  assert.equal(toHex(theftProofId(b)), toHex(taggedHash(TAG.slashProof, b)));
  const p = decodeTheftProof(b);
  assert.deepEqual([toHex(p.federationId), toHex(p.nodePubkey), toHex(p.txid), p.vout, p.mark, toHex(p.record), toHex(p.config), p.firstSession, p.sessions.map(toHex)],
    [toHex(FED), toHex(NODE), toHex(BOND), 2, { kind: 'inflation', height: 700, session: 4 }, toHex(RECORD), toHex(CONFIG), 0, sessions(5).map(toHex)]);
  assert.ok(b.length > THEFT_PROOF_HEAD_BYTES);
  const u = decodeTheftProof(encodeTheftProof(unbacked()));
  assert.deepEqual([u.mark.kind, toHex(u.mark.spendTxid), u.firstSession, u.sessions.length, toHex(u.reserve.txid), u.reserve.vout, toHex(u.spendTx)], ['unbacked-spend', toHex(SPEND), 10, 3, toHex(RESERVE.txid), 1, toHex(spendTx)]);
  assert.notEqual(toHex(theftProofId(b)), toHex(theftProofId(encodeTheftProof(inflation({ sessions: [...sessions(4), Uint8Array.of(1)] })))), 'one session byte moves the hash');
  assert.deepEqual(theftVerifyInput(u), { federationId: toHex(FED), config: toHex(CONFIG), firstSession: 10, sessions: sessions(3).map(toHex), spendTxid: toHex(SPEND), reserve: `${toHex(RESERVE.txid)}:1` });
});

test('the history is the proof: an inflation from session 0 to the mark, an unbacked spend with its outpoint and transaction; nothing less encodes or decodes', () => {
  assert.throws(() => encodeTheftProof(inflation({ firstSession: 1, sessions: sessions(4) })), /start at 0/);
  assert.throws(() => encodeTheftProof(inflation({ sessions: sessions(4) })), /up to the mark/);
  assert.throws(() => encodeTheftProof(inflation({ sessions: [] })), /signed sessions/);
  assert.throws(() => encodeTheftProof(inflation({ config: new Uint8Array(0) })), /config/);
  assert.throws(() => encodeTheftProof(unbacked({ spendTx: null })), /spending transaction/);
  assert.throws(() => encodeTheftProof(unbacked({ reserve: null })), /reserve outpoint/);
  assert.throws(() => encodeTheftProof(inflation({ mark: { kind: 'theft', height: 1, session: 4 } })), /one of inflation, unbacked-spend/);
  const b = encodeTheftProof(inflation());
  assert.throws(() => decodeTheftProof(b.subarray(0, b.length - 1)), /ran off the end/);
  assert.throws(() => decodeTheftProof(Uint8Array.from([...b, 0])), /.+/, 'trailing bytes are no proof');
  assert.throws(() => decodeTheftProof(Uint8Array.of(0x42, ...b.subarray(1))), /not a proof of a theft/);
});

test('who a theft takes: every guardian the record still seats, a lapsing one too; a DEPARTED one left by notice and is not taken', () => {
  const record = { federationId: FED, guardians: [{ peerKey: PEER, nodePubkey: NODE }, { peerKey: PEER2, nodePubkey: OTHER }, { peerKey: PEER3, nodePubkey: GONE_NODE }],
    gone: [{ peerKey: PEER3, kind: GONE.DEPARTED, sinceHeight: 500, proofRef: new Uint8Array(32) }] };
  assert.deepEqual(theftTakes(record).map(toHex), [toHex(NODE), toHex(OTHER)]);
  assert.deepEqual(theftTakes({ ...record, gone: [] }).map(toHex), [NODE, OTHER, GONE_NODE].map(toHex));
});

const bond = (byte, extra = {}) => ({ pubkey: NODE, txid: new Uint8Array(32).fill(byte), vout: 2, bondSats: 80000n, height: 400, advert: { nodePubkey: NODE, bondScriptTemplateVersion: 3 }, ...extra });
const RECORD_D = { federationId: FED, height: 650, guardians: [{ peerKey: PEER, nodePubkey: NODE }, { peerKey: PEER2, nodePubkey: OTHER }], gone: [] };
const verified = (p, over = {}) => ({ federationMatches: true, sessions: p.sessions.length, verified: p.sessions.length, unverified: [], firstSession: p.firstSession, lastSession: p.mark.session,
  firstInflationSession: p.mark.kind === 'inflation' ? p.mark.session : null, cumulativeIssuedMsat: 1000, cumulativeRedeemedMsat: 1500, signedPegOutTxids: [], outpointCreatedAt: p.firstSession, coversHeight: 715, ...over });

test('only template-3 outputs a guardian still holds are taken', () => {
  const got = theftOutputs([bond(0xb1), bond(0xb2, { advert: { nodePubkey: NODE, bondScriptTemplateVersion: 2 } }), bond(0xb3, { hold: { txid: 'x' } }), bond(0xb4, { height: 900 })], NODE, 800);
  assert.deepEqual(got.map((o) => o.txid), [toHex(new Uint8Array(32).fill(0xb1))]);
});

test('the verifier\'s answer is held to the proof: every session verified, the mark where it says, the spend never named', () => {
  const p = decodeTheftProof(encodeTheftProof(inflation())), u = decodeTheftProof(encodeTheftProof(unbacked()));
  assert.equal(sessionsShowMark(p, verified(p)).ok, true);
  assert.match(sessionsShowMark(p, verified(p, { federationMatches: false })).why, /not the federation/);
  assert.match(sessionsShowMark(p, verified(p, { unverified: [3], verified: 4 })).why, /session 3 does not verify/);
  assert.match(sessionsShowMark(p, verified(p, { firstInflationSession: null })).why, /never passes/);
  assert.match(sessionsShowMark(p, verified(p, { firstInflationSession: 2 })).why, /at session 2, not 4/);
  assert.match(sessionsShowMark(p, null).why, /no answer/);
  assert.equal(sessionsShowMark(u, verified(u), { spendHeight: 710 }).ok, true);
  assert.match(sessionsShowMark(u, verified(u, { signedPegOutTxids: [toHex(SPEND)] }), { spendHeight: 710 }).why, /own peg-out/);
  assert.match(sessionsShowMark(u, verified(u, { outpointCreatedAt: 9 }), { spendHeight: 710 }).why, /created the reserve outpoint/);
  assert.match(sessionsShowMark(u, verified(u, { coversHeight: 700 }), { spendHeight: 710 }).why, /do not reach/);
});

test('the spend on the checker\'s own chain: the transaction named, spending the reserve outpoint, 6 deep', () => {
  const u = decodeTheftProof(encodeTheftProof(unbacked()));
  assert.equal(spendStands(u, { confirmations: 6 }).ok, true);
  assert.deepEqual([spendStands(u, { confirmations: 5 }).wait, spendStands(u, { confirmations: null }).wait], [true, true]);
  assert.match(spendStands({ ...u, reserve: { ...RESERVE, vout: 0 } }, { confirmations: 9 }).why, /does not spend the reserve/);
  assert.match(spendStands({ ...u, mark: { ...u.mark, spendTxid: new Uint8Array(32) } }, { confirmations: 9 }).why, /not the spend it names/);
});

test('a checker\'s three answers: true on its own verification, false on bytes that do not show it, undefined where it cannot say', () => {
  const p = decodeTheftProof(encodeTheftProof(inflation({ txid: new Uint8Array(32).fill(0xb1) })));
  const base = { record: RECORD_D, proof: p, bonds: [bond(0xb1)], atHeight: 800 };
  const yes = theftSlashStands({ ...base, shown: sessionsShowMark(p, verified(p)) });
  assert.deepEqual([yes.verdict, yes.output.sats], [true, 80000n], yes.why);
  assert.equal(theftSlashStands({ ...base, shown: sessionsShowMark(p, verified(p, { firstInflationSession: null })) }).verdict, false, 'bytes that show no mark: the start was false');
  assert.equal(theftSlashStands({ ...base, shown: undefined }).verdict, undefined, 'no verifier here: no word, the node stays in its hold');
  assert.match(theftSlashStands({ ...base, shown: { ok: true }, record: { ...RECORD_D, guardians: [{ peerKey: PEER2, nodePubkey: OTHER }] } }).why, /does not seat that node/);
  assert.equal(theftSlashStands({ ...base, shown: { ok: true }, newest: { ...RECORD_D, height: 660, gone: [{ peerKey: PEER, kind: GONE.DEPARTED }] } }).verdict, false, 'departed by the newest record');
  assert.match(theftSlashStands({ ...base, shown: { ok: true }, bonds: [bond(0xb1, { spent: true })] }).why, /no unspent template-3 bond output/);
  assert.match(theftSlashStands({ ...base, shown: { ok: true }, record: { ...RECORD_D, federationId: new Uint8Array(32) } }).why, /another federation/);
  const u = decodeTheftProof(encodeTheftProof(unbacked({ txid: new Uint8Array(32).fill(0xb1) })));
  const ub = { ...base, proof: u, shown: sessionsShowMark(u, verified(u), { spendHeight: 710 }) };
  assert.equal(theftSlashStands({ ...ub, spend: spendStands(u, { confirmations: 7 }) }).verdict, true);
  assert.equal(theftSlashStands({ ...ub, spend: spendStands(u, { confirmations: 2 }) }).verdict, undefined, 'not 6 deep here yet');
  assert.equal(theftSlashStands({ ...ub, spend: null }).verdict, undefined);
});

test('a slashed guardian bond is owed to the liquidation escrow of a federation that is liquidating, else to the reserves: one rule for a theft and an abandonment', () => {
  assert.deepEqual(slashedGuardianPays({ federation: toHex(FED), halt: { height: 700, alarm: { kind: 'inflation' } } }), { to: 'liquidation', federation: toHex(FED), haltHeight: 700 });
  assert.deepEqual(slashedGuardianPays({ federation: toHex(FED), halt: { height: 650, bytes: RECORD } }), { to: 'liquidation', federation: toHex(FED), haltHeight: 650 });
  assert.deepEqual(slashedGuardianPays({ federation: toHex(FED), halt: null }), { to: 'reserves' });
});
