// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a45-refute-22-s2-1 (refutes #1856 as it stands after #2273): #1856's own attack, in pages.
// #1856 bounded one peer seat's GET /season-rounds answer to PEER_LISTING_BYTES (4 MB): past it the seat counts as not answered,
// because each round of the answer is then schnorr-verified in this thread on the badge / payout path (mergeSignedSeasonAccounts).
// #2273 follows `next` up to SEASON_PEER_ANSWER_BYTES (48 MB) / 25,000 rounds per seat. One seat that cuts the same padded answer
// into rising pages of just under 4 MB is read whole again: every round is taken, 12x what #1856 let one seat hand in. Each round
// can carry a signature claimed by each of the 7 seats of its draw, each one verified in this thread.
// Safe: one seat cannot make this seat take more rounds than one 4 MB answer carries unless they are an honest seat's rounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { b32, opts } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { seasonRoundsToJson, seasonRoundsFromJson, mergeSignedSeasonAccounts } from '../../arena-protocol/src/season.js';
import { HOSTED, NEXTBLOCK_GAME_ID } from './plugins/hosted.js';
import { contractRound, drawOf, seatKey } from './signed-season-fixture.js';

const GAME = toHex(NEXTBLOCK_GAME_ID);
const node = toHex(schnorr.getPublicKey(b32(0xa1)));
const base = (x) => `http://127.0.0.1:9/seat-${x}`;
const h = (n) => n.toString(16).padStart(2, '0').repeat(32);
const BOUND = 4 * 1024 * 1024;

test('#1489 a45-refute-22-s2-1: one seat cannot hand in more than one 4 MB answer of rounds by cutting it into pages', async () => {
  const now = Date.now();
  const SEVEN = [1, 2, 3, 4, 5, 6, 7].map(seatKey);
  const bogus = 'ab'.repeat(64);
  const N = 26000;
  const wire = [];
  for (let n = 0; n < N; n++) {
    const r = contractRound({ gameId: GAME, startMs: now - 3 * 86400000 + n, n,
      entries: [{ player: h(0x0e), roundKey: h(0xe1), name: null, stakeMsat: 100000n, payoutMsat: 900000n, outcome: 'DELIVERED', score: 1 }] });
    wire.push({ ...seasonRoundsToJson([r])[0], contract: r.contract, sigs: SEVEN.map((k) => ({ node: k, sig: bogus })) });
  }
  wire.sort((a, b) => (a.roundId < b.roundId ? -1 : 1));
  const per = JSON.stringify(wire[0]).length + 1;
  const fitIn4MB = Math.floor(BOUND / per);
  // the attacker's pages: each just under the 4 MB bound, the cursor rising
  const pages = [];
  for (let i = 0; i < wire.length;) {
    const part = []; let size = 200;
    while (i < wire.length && size + per < BOUND - 4096) { part.push(wire[i]); size += per; i++; }
    pages.push(part);
  }
  let asked = 0, servedBytes = 0;
  const seasonFetch = async (u) => {
    if (!u.startsWith(`${base('a')}/`)) throw new Error('no answer');
    asked++;
    const after = new URL(u.replace(base('a'), 'http://x')).searchParams.get('after') || '';
    const k = after ? pages.findIndex((p) => p[0].roundId > after) : 0;
    const part = k < 0 ? [] : pages[k];
    const next = k >= 0 && k < pages.length - 1 ? part[part.length - 1].roundId : null;
    const body = JSON.stringify({ node, roundKeys: true, signed: true, next, rounds: part });
    servedBytes += body.length;
    return new Response(body, { status: 200 });
  };
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, peers: [base('a')], seasonFetch, ...opts });
  let taken;
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/season?game=nextblock&scope=network&days=7`);
    assert.equal(r.status, 200);
    const j = await r.json();
    taken = j.leftOut;   // every round one seat alone names is left out once: the rounds this seat took from it
    console.log(`one seat: ${asked} pages, ${servedBytes} bytes read, ${taken} rounds taken (one 4 MB answer carries ${fitIn4MB}), seats`, j.seats);
  } finally {
    await d.close?.();
  }
  // WHAT THE TAKEN ROUNDS COST ON THE BADGE / PAYOUT PATH: each claimed seat of the round's draw is schnorr-verified in this thread
  let verifies = 0;
  const SAMPLE = 500;
  const t0 = process.hrtime.bigint();
  mergeSignedSeasonAccounts(new Map([['seat-a', seasonRoundsFromJson(wire.slice(0, SAMPLE))]]),
    { seatsOf: drawOf(new Map(), [1, 2, 3, 4, 5, 6, 7]), verify: (s, m, k) => { verifies++; return schnorr.verify(s, m, k); } });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const perRound = ms / SAMPLE;
  console.log(`signed merge: ${verifies} verifies for ${SAMPLE} rounds in ${ms.toFixed(0)} ms -> ${taken} rounds of one seat hold this thread ~${(perRound * taken / 1000).toFixed(1)} s (one 4 MB answer: ~${(perRound * fitIn4MB / 1000).toFixed(1)} s)`);
  assert.ok(taken <= fitIn4MB, `one seat handed in ${taken} rounds in pages, more than one 4 MB answer carries (${fitIn4MB}) - #1856's bound is gone`);
});

test('#1489 a45-refute-22-s2-1b: a seat whose pages pass the whole-read time keeps what was read (the read is not thrown away)', async () => {
  // an honest seat on a slow link: 5 pages, each answered in 7 s (under the 8 s page timeout); the 32 s whole-seat limit ends the read
  const now = Date.now();
  const pages = [];
  for (let p = 0; p < 5; p++) {
    const part = [];
    for (let n = 0; n < 3; n++) {
      const r = contractRound({ gameId: GAME, startMs: now - 86400000 + p * 10 + n, n: p * 10 + n,
        entries: [{ player: h(0x0a), roundKey: h(0xa1), name: null, stakeMsat: '0', payoutMsat: '0', outcome: 'DELIVERED', score: 1 }] });
      part.push({ ...seasonRoundsToJson([r])[0], contract: r.contract, sigs: [] });
    }
    pages.push(part);
  }
  const all = pages.flat().sort((a, b) => (a.roundId < b.roundId ? -1 : 1));
  const cut = [0, 3, 6, 9, 12, 15].map((i) => i);
  const byPage = [0, 1, 2, 3, 4].map((p) => all.slice(cut[p], cut[p + 1]));
  let asked = 0;
  const seasonFetch = async (u, { signal } = {}) => {
    if (!u.startsWith(`${base('h')}/`)) throw new Error('no answer');
    const after = new URL(u.replace(base('h'), 'http://x')).searchParams.get('after') || '';
    const k = after ? byPage.findIndex((p) => p[0].roundId > after) : 0;
    asked++;
    await new Promise((res, rej) => { const t = setTimeout(res, 7000); signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }); });
    const part = byPage[k];
    const next = k < byPage.length - 1 ? part[part.length - 1].roundId : null;
    return new Response(JSON.stringify({ node, roundKeys: true, signed: true, next, rounds: part }), { status: 200 });
  };
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, peers: [base('h')], seasonFetch, ...opts });
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/season?game=nextblock&scope=network&days=7`);
    assert.equal(r.status, 200);
    const j = await r.json();
    console.log(`slow seat: ${asked} pages asked, seats`, j.seats, 'leftOut', j.leftOut);
    assert.equal(j.seats.answered, 1, 'the pages read before the whole-seat limit are kept, as the #2273 comment says ("keeps what it read")');
  } finally {
    await d.close?.();
  }
});
