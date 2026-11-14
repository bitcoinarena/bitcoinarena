// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 refute (skeptic 3) of #1535 / 3f9406bc3. Variant: a forged tap on a REAL OPEN round, from ONE IPv4 address.
// The door is unsigned and so is its `tapped` flag. Every network cap counts rows; none asks whether anybody sits at a row's table. An
// attacker reads GET /rounds (public), posts the next open rock-paper-scissors round with tapped:true, newer than the real page's row. In
// tools/rps-opponent.mjs pass() (3f9406bc3, lines 241-256) that round is real and open, so it counts, and `w.tapped` sends the bot straight
// into go(): busy is set and the real player's tapped table in the same pass is skipped (`if (busy ...) continue`). Repeated each 8 s round,
// the bot plays the attacker's empty tables until MOST_PER_HOUR (400) and locks a stake each time: nobody gets an opponent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opponentWant, opponentWants, ipKey } from '../src/faucet.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { presenceId } from '../../arena-protocol/src/match.js';
// kanban #2087 (Daniel 2026-11-14, a signed tap only): the real page signs its tap with its identity key (presenceProofFor); the attacker's bare tapped:true is no tap
const sk = new Uint8Array(32).fill(9), idKey = schnorr.getPublicKey(sk), hex = (u) => Buffer.from(u).toString('hex');
const signedTap = (round) => ({ key: hex(idKey), sig: hex(schnorr.sign(presenceId({ roundId: Buffer.from(round, 'hex'), identityKey: idKey }), sk)) });

test('#1489 refute-42-s3-1: one IPv4 caller with a forged tap on a real open round keeps the bot from the real player', () => {
  const W = new Map();
  const t = 1_000_000;
  const realRound = 'ab'.repeat(32), emptyRound = 'cd'.repeat(32);   // both real lobby rounds, both open; only realRound has a player
  const seats = new Map([[realRound, { entryCloseMs: t + 6000, players: 1 }], [emptyRound, { entryCloseMs: t + 6000, players: 0 }]]);
  assert.ok(opponentWant(W, realRound, t, signedTap(realRound), ipKey('198.51.100.20')).ok);          // the real page: a signed tap
  assert.ok(opponentWant(W, emptyRound, t + 50, true, ipKey('203.0.113.9')).ok);     // the attacker: one address, one row, a forged tap
  const wants = opponentWants(W, t + 60);
  // tools/rps-opponent.mjs pass() at 3f9406bc3, as written
  const entered = []; let busy = false, real = 0;
  for (const w of wants.slice(0, 16)) {
    if (real >= 4) break;
    const k = seats.get(w.round); if (!k) continue;
    const left = k.entryCloseMs - (t + 60);
    if (left <= 0) continue;
    real++;
    if (busy || left < 900) continue;
    if (w.tapped) { entered.push(w.round); busy = true; continue; }
  }
  const emptyEntered = entered.filter((r) => seats.get(r).players === 0);
  console.log('  MEASURED:', JSON.stringify({ listed: wants.map((w) => `${w.round.slice(0, 4)}${w.tapped ? '*' : ''}`), botEnters: entered.map((r) => r.slice(0, 4)), realEntered: entered.includes(realRound), emptyEntered: emptyEntered.length }));
  assert.ok(entered.includes(realRound), `the bot enters the table the real player tapped: ${JSON.stringify({ botEnters: entered.map((r) => r.slice(0, 4)) })}`);
  assert.equal(emptyEntered.length, 0, 'the bot enters no table where nobody sits');
});
