#!/usr/bin/env node
/**
 * PLAYERS WHOSE RUNS THE CORE ITSELF SAYS DELIVER (or wreck), for probes that need several distinct qualifiers.
 *
 *   node packages/blwp-node/tools/find-players.mjs <delivered|wrecked> <count> [minScore=1]
 *
 * Real secp256k1 x-only keys (even y, so a refund key is a valid point), each with the world secret whose last byte
 * the fixture's driver (window-fixture wordsAt, WINNER's ticks) delivers with a DISTINCT score of at least minScore -
 * or wrecks within LOSER's ticks. Printed one JSON line per player: { key, worldSecret, ticks, state, score }. It
 * searches; it decides nothing. Run several in parallel and join their lines: deliveries are rare (measured
 * 2026-09-23: 2 of 5 fixed keys delivered anywhere in 256 last bytes).
 */
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { init, step } from '../../core/src/sim.js';
import { O_SCORE, S_STATE, S_DELIVERED } from '../../core/src/state.js';
import { RUN_LIVE, RUN_DELIVERED, RUN_WRECKED } from '../../core/src/rules/gate.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { WINNER, LOSER, RANDOMNESS, wordsAt } from '../test/window-fixture.js';
import { toHex } from '../../protocol/src/hash.js';

const want = process.argv[2] === 'wrecked' ? RUN_WRECKED : RUN_DELIVERED;
const count = Number(process.argv[3] || 1);
const minScore = Number(process.argv[4] || 1);
const who = want === RUN_DELIVERED ? WINNER : LOSER;
const scores = new Set();
let found = 0;
while (found < count) {
  let k; do { k = secp256k1.utils.randomSecretKey(); } while (secp256k1.getPublicKey(k, true)[0] !== 0x02);
  const key = schnorr.getPublicKey(k);
  for (let last = 0; last < 256; last++) {
    const worldSecret = Uint8Array.from(who.worldSecret); worldSecret[31] = last;
    const st = init(seedWordForEntry({ playerPubkey: key, worldSecret, joinTick: 0 }, RANDOMNESS));
    for (let t = 0; t < who.ticks; t++) { step(st, ...wordsAt(t)); if (st.i32[O_SCORE + S_STATE] !== RUN_LIVE) break; }
    if (st.i32[O_SCORE + S_STATE] !== want) continue;
    const score = st.i32[O_SCORE + S_DELIVERED];
    if (want === RUN_DELIVERED && (score < minScore || scores.has(score))) continue;
    scores.add(score);
    console.log(JSON.stringify({ key: toHex(key), worldSecret: toHex(worldSecret), ticks: who.ticks, state: want === RUN_DELIVERED ? 'DELIVERED' : 'WRECKED', score }));
    found++;
    break;
  }
}
