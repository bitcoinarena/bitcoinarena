// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2562: the ballot binding (ruled 2026-11-12, #2125 votes + deposits, #2012 the chain check). A bound deposit carries
// OP_RETURN "ARN" 'D' || proposer x-only key || H(proposal body without its deposit txid); the bound vote is 80 bytes and signs
// H(proposal_id || choice || seq). Closes #1491 (one deposit, many proposals) and #1739 (deposit squatting) at the deposit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { depositOf, depositOutputsExpected, depositCommitmentScript, encodeDepositCommitment, DEPOSIT_COMMIT_BYTES } from '../src/ballot-chain.js';
import { encodeVote, decodeVote, voteMessage, proposalBodyId, proposalCommitment, CHOICE, CLASS, configHashOf,
  BALLOT_BIND_HEIGHT, ballotBindHeight, VOTE_BOUND_BYTES, VOTE_BYTES } from '../src/ballot.js';
import { parseTransaction } from '../src/tx.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const NET = new Uint8Array(32).fill(0x4e);
const alice = key(1), mallory = key(9);
const body = (proposer, config) => ({ networkId: NET, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(config), config,
  class: CLASS.DESIGN, activationHeight: 300, proposer: proposer.pubkey });
/** A deposit paying the set, with the given extra outputs (commitments). */
const deposit = (extra) => tx([...depositOutputsExpected(1000, SET).outputs.map((o) => ({ sats: o.sats, script: o.script })), ...extra.map((script) => ({ sats: 0, script }))]);
const named = (p, raw) => ({ ...p, depositTxid: Uint8Array.from(parseTransaction(raw).txid) });

test('#2562 the gate: regtest 0, testnet4 161400, mainnet (and any other network) from its first block', () => {
  assert.deepEqual({ ...BALLOT_BIND_HEIGHT }, { regtest: 0, testnet4: 161400, mainnet: 0 });
  assert.equal(ballotBindHeight('testnet4'), 161400); assert.equal(ballotBindHeight('regtest'), 0); assert.equal(ballotBindHeight('signet'), 0);
});

test('#2562 the bound vote: 80 bytes, H(proposal_id || choice || seq), told apart from the 77-byte vote by length', () => {
  const id = new Uint8Array(32).map((_, i) => i + 1);
  const sig = schnorr.sign(voteMessage(id, CHOICE.NO, 0x01020304), alice.secret);
  const v = encodeVote({ proposalId: id, choice: CHOICE.NO, seq: 0x01020304, signature: sig });
  assert.equal(v.length, VOTE_BOUND_BYTES); assert.equal(VOTE_BOUND_BYTES, 80);
  const d = decodeVote(v);
  assert.deepEqual({ bound: d.bound, seq: d.seq, choice: d.choice, prefix: [...d.idPrefix] }, { bound: true, seq: 0x01020304, choice: CHOICE.NO, prefix: [1, 2, 3, 4, 5, 6, 7] });
  assert.equal(schnorr.verify(d.signature, voteMessage(id, d.choice, d.seq), alice.pubkey), true);
  assert.notEqual(Buffer.from(voteMessage(id, CHOICE.NO, 0)).toString('hex'), Buffer.from(voteMessage(id, CHOICE.NO)).toString('hex'), 'seq 0 is not the unbound message');
  const old = encodeVote({ proposalId: id, choice: CHOICE.NO, signature: sig });
  assert.equal(old.length, VOTE_BYTES); assert.equal(decodeVote(old).bound, false);
  assert.throws(() => encodeVote({ proposalId: id, choice: CHOICE.NO, seq: 2 ** 32, signature: sig }));
});

test('#2562 a bound deposit is taken for the proposal it commits to, and refused for any other (closes #1491, #1739)', () => {
  const pa = body(alice, Uint8Array.of(1, 2, 3));
  const raw = deposit([depositCommitmentScript(pa)]);
  assert.equal(encodeDepositCommitment(pa).length, DEPOSIT_COMMIT_BYTES);
  const mine = named(pa, raw);
  // proposalCommitment does not depend on the deposit txid (which hashes it)
  assert.equal(Buffer.from(proposalCommitment(mine)).toString('hex'), Buffer.from(proposalCommitment(pa)).toString('hex'));
  const ok = depositOf({ raw, height: 120, proposal: mine, recipients: SET, bound: true });
  assert.equal(ok.ok, true, ok.why); assert.equal(ok.depositSats, 1000n);
  // SQUATTING (#1739): another proposer names alice's confirmed deposit - before the binding it was taken
  const squat = named(body(mallory, Uint8Array.of(9, 9)), raw);
  assert.equal(depositOf({ raw, height: 120, proposal: squat, recipients: SET }).ok, true, 'old reading: the squat was taken (the hole)');
  const s = depositOf({ raw, height: 120, proposal: squat, recipients: SET, bound: true });
  console.log('  SQUAT:', s.why);
  assert.equal(s.ok, false); assert.match(s.why, /another proposer key/);
  // ONE DEPOSIT, MANY PROPOSALS (#1491): alice's own second config on the one deposit
  const second = named(body(alice, Uint8Array.of(4, 5, 6)), raw);
  assert.equal(depositOf({ raw, height: 120, proposal: second, recipients: SET }).ok, true, 'old reading: a second proposal was taken (the hole)');
  const t = depositOf({ raw, height: 120, proposal: second, recipients: SET, bound: true });
  assert.equal(t.ok, false); assert.match(t.why, /another proposal/);
  // the signature is not committed, but only alice can sign: the proposal with her signature stands
  const signed = { ...mine, signature: schnorr.sign(proposalBodyId(mine), alice.secret) };
  assert.equal(depositOf({ raw, height: 120, proposal: signed, recipients: SET, bound: true }).ok, true);
});

test('#2562 a bound deposit carries exactly one 68-byte commitment', () => {
  const pa = body(alice, Uint8Array.of(1, 2, 3));
  const none = deposit([]);
  const r0 = depositOf({ raw: none, height: 120, proposal: named(pa, none), recipients: SET, bound: true });
  assert.equal(r0.ok, false); assert.match(r0.why, /exactly one/);
  assert.equal(depositOf({ raw: none, height: 120, proposal: named(pa, none), recipients: SET }).ok, true, 'below the gate: no commitment needed, as before');
  const pb = body(alice, Uint8Array.of(7));
  const two = deposit([depositCommitmentScript(pa), depositCommitmentScript(pb)]);
  const r2 = depositOf({ raw: two, height: 120, proposal: named(pa, two), recipients: SET, bound: true });
  assert.equal(r2.ok, false); assert.match(r2.why, /exactly one/);
  const short = deposit([Uint8Array.from([0x6a, 36, ...encodeDepositCommitment(pa).subarray(0, 36)])]);
  assert.equal(depositOf({ raw: short, height: 120, proposal: named(pa, short), recipients: SET, bound: true }).ok, false);
});
