// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A TEST FAULT FOR THE NAMED CLAIM'S OFFENCES, OFF BY DEFAULT, REGTEST ONLY (kanban #1044 B1 phase 4, rulings #1131 4, #1135 2). It makes this seat sign
// what an honest seat refuses, so that five seats so started commit offence (a) or (b) on a private regtest and the honest seats file it:
//
//   ARENA_TEST_NAMED_OFFENCE_FILE  a file read again at most every 2 s, so a seat is armed for a round or an entry that did not exist when it started.
//                                  Each line is one of
//     off-table <round hex>         (a) this seat's named batch for that round signs a claim whose payout with the most msat (not a send) is paid to
//                                   OFF_TABLE_KEY instead: a transaction that is not the rebuild of the table it acked. It still acks the honest table.
//     forfeit-lost <entry hex>      (b) this seat signs the forfeit of that entry's stake lock although it signed the entry non-qualifying itself.
//
// Refused off regtest: a seat started with the variable on any other network (ARENA_DONATION_NETWORK not 'regtest') does not start (main.js asks
// namedOffenceSwitch first). Unset - every seat's default - nothing reads the file and every answer below is false.
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

const ENV = 'ARENA_TEST_NAMED_OFFENCE_FILE';
const hex = (b) => Buffer.from(b).toString('hex');

/** THE KEY AN OFF-TABLE CLAIM PAYS: 02 || x of a secret the harness knows (sha256 of a fixed text), on no table of any round. */
export const OFF_TABLE_SECRET = sha256(new TextEncoder().encode('ARENA/test/NamedOffenceThief'));
export const OFF_TABLE_KEY = Uint8Array.from([0x02, ...schnorr.getPublicKey(OFF_TABLE_SECRET)]);

/**
 * THE SWITCH AT START: { file } when set on regtest, null when unset; throws when set on any other network. `env` the process environment.
 */
export function namedOffenceSwitch(env = process.env) {
  const file = env[ENV];
  if (!file) return null;
  const net = env.ARENA_DONATION_NETWORK || '';
  if (net !== 'regtest') throw new Error(`${ENV} is a regtest test switch, and this seat runs on ${net || 'no named network'}: refused`);
  return { file };
}

let armed = null;
try { armed = namedOffenceSwitch(); } catch { armed = null; }   // main.js refuses the start; a module loaded elsewhere off regtest stays off
let readAt = 0, lines = [];
const named = () => {
  if (!armed) return [];
  if (Date.now() - readAt > 2000) {
    readAt = Date.now();
    try { lines = readFileSync(armed.file, 'utf8').split('\n').map((l) => l.trim().toLowerCase().split(/\s+/)).filter((w) => w.length >= 2); } catch { lines = []; }
  }
  return lines;
};
const on = (word, id) => !!id && named().some(([w, x]) => w === word && x === hex(id));

/** (a): this seat signs round `roundIdBytes`'s claim off its table. */
export const offTableOn = (roundIdBytes) => on('off-table', roundIdBytes);
/** (b): this seat forfeits entry `entryIdBytes`'s stake lock although it signed the entry lost. */
export const forfeitLostOn = (entryIdBytes) => on('forfeit-lost', entryIdBytes);

/**
 * THE OFF-TABLE PAYOUTS: the plan's payouts with the largest non-send payout paid to OFF_TABLE_KEY - same amounts, so the guardians take it.
 * The payout's key field is the 33-byte payoutPk the tool writes.
 */
export function offTablePayouts(payouts) {
  let at = -1;
  (payouts || []).forEach((p, i) => { if (!p.sent && p.payoutPk && (at < 0 || BigInt(p.msat) > BigInt(payouts[at].msat))) at = i; });
  if (at < 0) return null;
  return payouts.map((p, i) => (i === at ? { ...p, payoutPk: OFF_TABLE_KEY, kind: 'off-table' } : p));
}
