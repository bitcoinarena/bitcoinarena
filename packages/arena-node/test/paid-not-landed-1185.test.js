// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PAID SEND IS NO PROOF A SETTLEMENT LANDED (kanban #1185, the 2026-11-06 state-machine audit). POST /winnings-paid marked a send PAID on any
// preimage that hashed to its invoice, from anyone - and the payee holds that preimage from the start. federationSaw then read "every claimed lock
// gone + a PAID send" as IN: a SUBMITTING settlement that never landed, whose claimed locks refunded at expiry, went ACCEPTED, and the forfeits
// gated on ACCEPTED moved on false moves. Now IN needs the gateway's claim of one of the txid's contracts read from the federation, and the door
// keeps a preimage only from a seat of the round, signed by its node key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as curve from '../src/curve.js';
import { LockSettlement, SUBMITTING, ACCEPTED } from '../src/settlement.js';
import { PLAN_ASK, signSendPlanAsk, checkSendPlanAsk } from '../src/send-plan-ask.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(0x85);
const T = 'e1'.repeat(32);
const LOCK = `${toHex(b32(0x45))}:0`;

/** A seat SUBMITTING on T (one claimed lock, one payout - the winner's send), its send PAID by a preimage handed to it. */
function seat({ claimed = null } = {}) {
  const round = new Round(openStore(':memory:'));
  round.putSettlementTxid({ roundId: RID, txid: T, message: new Uint8Array(32), claims: [LOCK], payouts: 1 });
  round.putLockSettlement({ roundId: RID, txid: T, message: new Uint8Array(32), signature: new Uint8Array(64), state: SUBMITTING, why: 'handed' });
  round.sendAttemptsOf = () => [{ entryId: b32(1), attempt: 0, state: 'PAID', preimage: '77'.repeat(32), paymentHash: 'aa'.repeat(32) }];
  // THE FEDERATION: T never landed - the claimed lock refunded to its player at expiry (gone), the send contract T:0 never made (not stored)
  const port = { status: async () => ({ blockCount: 2000, stored: null }) };
  if (claimed) port.sendClaimed = async (o) => ({ claimed: claimed.has(`${toHex(o.txid)}:${o.outIdx}`) });
  const ls = new LockSettlement(round, { curve, port, dkg: {}, stakeSecrets: {}, winnings: { sendsFor: () => new Map() } });
  ls.confirmSoon = () => {};
  return { ls, round };
}

test('every claimed lock gone and a send PAID by preimage, no gateway claim at the federation: not IN', async () => {
  const { ls } = seat();
  const saw = await ls.federationSaw(RID, { txid: T });
  assert.notEqual(saw.verdict, 'in', `the old source read this as IN: ${saw.why}`);
});

test('the same with a port that reads the gateway\'s claims: none of T\'s contracts claimed - not IN; a refused submit then is not ACCEPTED', async () => {
  const { ls, round } = seat({ claimed: new Set() });
  assert.equal((await ls.federationSaw(RID, { txid: T })).verdict, 'mixed');
  const state = await ls.recordSubmit(RID, { txid: T, message: new Uint8Array(32), plan: { payouts: [{}] }, claims: [] }, new Uint8Array(64),
    { accepted: false, error: 'The contracts locktime has passed' }, 'claimed');
  assert.notEqual(state, ACCEPTED);
  assert.notEqual(round.lockSettlement(RID).state, ACCEPTED);
});

test('the gateway\'s claim of T:0 held by the federation: IN, and the row goes ACCEPTED', async () => {
  const { ls, round } = seat({ claimed: new Set([`${T}:0`]) });
  const saw = await ls.federationSaw(RID, { txid: T });
  assert.equal(saw.verdict, 'in', saw.why);
  assert.match(saw.why, /gateway's claim/);
  const state = await ls.recordSubmit(RID, { txid: T, message: new Uint8Array(32), plan: { payouts: [{}] }, claims: [] }, new Uint8Array(64),
    { accepted: false, error: 'already spent' }, 'claimed');
  assert.equal(state, ACCEPTED);
  assert.equal(round.lockSettlement(RID).state, ACCEPTED);
});

test('a preimage is kept only from a seat of the round, signed over this round and these bytes', () => {
  const seatSk = b32(0x31), seatPk = schnorr.getPublicKey(seatSk);
  const outsiderSk = b32(0x32);
  const pre = b32(0x77);
  const seats = [seatPk, b32(0x09)];
  assert.equal(PLAN_ASK.PAID, 4);
  const good = signSendPlanAsk({ kind: PLAN_ASK.PAID, roundId: RID, body: pre, secret: seatSk, pubkey: seatPk });
  assert.equal(checkSendPlanAsk(good, { kind: PLAN_ASK.PAID, roundId: RID, body: pre, seats }).ok, true);
  assert.match(checkSendPlanAsk('', { kind: PLAN_ASK.PAID, roundId: RID, body: pre, seats }).why, /no signed ask/);
  const outsider = signSendPlanAsk({ kind: PLAN_ASK.PAID, roundId: RID, body: pre, secret: outsiderSk, pubkey: schnorr.getPublicKey(outsiderSk) });
  assert.match(checkSendPlanAsk(outsider, { kind: PLAN_ASK.PAID, roundId: RID, body: pre, seats }).why, /not one of the round's seats/);
  // a seat's signature over a re-send is not one over a preimage
  const resend = signSendPlanAsk({ kind: PLAN_ASK.RESEND, roundId: RID, body: pre, secret: seatSk, pubkey: seatPk });
  assert.equal(checkSendPlanAsk(resend, { kind: PLAN_ASK.PAID, roundId: RID, body: pre, seats }).ok, false);
  // THE DOOR (server.js POST /winnings-paid) checks it before the preimage reaches the sender, and the proposer signs its push (winnings-send.js)
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const door = server.slice(server.indexOf("if (url.pathname === '/winnings-paid') {"), server.indexOf('const got = sender.paid(r8, eHex, pre);'));
  assert.match(door, /sendPlanAskOf\(req, r8, PLAN_ASK\.PAID, lateHex, pre\)/);
  const sender = readFileSync(new URL('../src/winnings-send.js', import.meta.url), 'utf8');
  assert.match(sender, /kind: PLAN_ASK\.PAID[^\n]*body: said\.preimage/);
});
