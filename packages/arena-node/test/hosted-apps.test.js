// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EACH NODE CHOOSES WHICH GAMES IT HOSTS - THE NODE HALF (§0A.4, comment 756; 2026-10-07: a node
// whose advertisement names a game it does not host refuses to start, by name).
//
// Pair A hosts nextblock, pair B hosts tally (ARENA_GAMES' registrations, handed to serve as `plugins`), each with an
// advertisement naming only its own game. Each settles a paying round of its own game. Then, at each: the other game's
// round is refused at /round and an entry into it at /entry, by the game's id; /rounds and /api/rounds list only its own
// game, every row tagged and the listing grouped by game; the dashboard shows earnings only under its own game. And a
// node whose advertisement names a game it does not host does not start, by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32, rand, WINNER, LOSER, opts } from './window-fixture.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { TALLY, TALLY_CORE, TALLY_CORE_HASH, TALLY_CONFIG_HASH, TALLY_GAME_ID } from './plugins/tally/index.js';
import { encodeRoundContract, encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';

const TALLY_ROUND = { gameId: TALLY_GAME_ID, simCoreHash: TALLY_CORE_HASH, configHash: TALLY_CONFIG_HASH, blockTicks: 600, startDeadlineTicks: 300 };
const TALLY_PLAY = { adapter: TALLY_CORE.adapter, config: {} };
const HIGH = { name: 'high', key: b32(0x21), worldSecret: b32(0x31), ticks: 600, words: () => [7, 0, 0, 0, 0] };
const LOW = { name: 'low', key: b32(0x22), worldSecret: b32(0x32), ticks: 600, words: () => [2, 0, 0, 0, 0] };
// what each node's advertisement says it hosts (the check serve() makes at start)
const advertHosting = (game) => ({ hostedGames: [game.gameId] });

const post = async (d, path, body) => { const r = await fetch(`http://127.0.0.1:${d.port}${path}`, { method: 'POST', body }); return { status: r.status, why: (await r.text()).trim() }; };
const json = async (d, path) => (await fetch(`http://127.0.0.1:${d.port}${path}`)).json();
const entryInto = (roundId) => ({ roundId, playerPubkey: b32(0x55), sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
  stakeCommitment: rand(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: b32(0x56),
  vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32),
  stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
  claimKeyAttestationRef: new Uint8Array(32) });

test('two nodes hosting different games: each opens, lists, pays and refuses by its own game only', async () => {
  const A = await lockRound({ serveOpts: { plugins: [NEXTBLOCK], ownAdvert: advertHosting(NEXTBLOCK) } });
  const B = await lockRound({ serveOpts: { plugins: [TALLY], ownAdvert: advertHosting(TALLY) }, round: TALLY_ROUND });
  try {
    // EACH SETTLES A PAYING ROUND OF ITS OWN GAME
    await lockAndPlay(A, WINNER, { address: true }); await lockAndPlay(A, LOSER);
    await lockAndPlay(B, HIGH, { game: TALLY_PLAY, address: true }); await lockAndPlay(B, LOW, { game: TALLY_PLAY });
    await closeRound(A); await closeRound(B);
    const settled = { A: await untilSettled(A), B: await untilSettled(B) };

    // EACH REFUSES THE OTHER'S ROUND AT /round AND AN ENTRY INTO IT AT /entry, BY THE GAME
    const refused = {
      A: { round: await post(A.a, '/round', encodeRoundContract(B.c)), entry: await post(A.a, '/entry', encodeEntryContract(entryInto(B.rid))) },
      B: { round: await post(B.a, '/round', encodeRoundContract(A.c)), entry: await post(B.a, '/entry', encodeEntryContract(entryInto(A.rid))) },
    };
    // EACH LISTS ONLY ITS OWN GAME, TAGGED AND GROUPED
    const listing = { A: await json(A.a, '/api/rounds'), B: await json(B.a, '/api/rounds') };
    const upcoming = { A: await json(A.a, '/rounds'), B: await json(B.a, '/rounds') };
    // EACH DASHBOARD SHOWS EARNINGS ONLY UNDER ITS OWN GAME
    const dash = { A: await json(A.a, '/dashboard.json'), B: await json(B.a, '/dashboard.json') };
    const earned = (g) => BigInt(g.earned.gameVerifyMsat) + BigInt(g.earned.settlementMsat) + BigInt(g.earned.guardianMsat);
    const facts = {
      games: { nextblock: toHex(NEXTBLOCK.gameId).slice(0, 16), tally: toHex(TALLY_GAME_ID).slice(0, 16) },
      settled: { A: settled.A.state, B: settled.B.state },
      refused: Object.fromEntries(Object.entries(refused).map(([k, v]) => [k, { round: [v.round.status, v.round.why.slice(0, 70)], entry: [v.entry.status, v.entry.why.slice(0, 90)] }])),
      listed: Object.fromEntries(Object.entries(listing).map(([k, v]) => [k, { games: v.games.map((g) => `${g.name}:${g.rounds.length}`),
        rowGames: [...new Set([...v.upcoming, ...v.finished].map((r) => r.game && r.game.name))] }])),
      upcomingGames: Object.fromEntries(Object.entries(upcoming).map(([k, v]) => [k, v.games.map((g) => g.name)])),
      dashboard: Object.fromEntries(Object.entries(dash).map(([k, v]) => [k, v.byGame.map((g) => ({ name: g.name, rounds: g.rounds, earnedMsat: String(earned(g)) }))])),
    };
    console.log('  FACTS (hosted games):', JSON.stringify(facts));

    assert.equal(settled.A.state, 'ACCEPTED', settled.A.why);
    assert.equal(settled.B.state, 'ACCEPTED', settled.B.why);
    for (const [k, other] of [['A', TALLY_GAME_ID], ['B', NEXTBLOCK.gameId]]) {
      const id = toHex(other).slice(0, 16);
      assert.equal(refused[k].round.status, 409, refused[k].round.why);
      assert.match(refused[k].round.why, new RegExp(`^this node does not host game ${id}`), `${k} at /round`);
      assert.equal(refused[k].entry.status, 409, refused[k].entry.why);
      assert.match(refused[k].entry.why, new RegExp(`^entry refused: this node does not host game ${id}`), `${k} at /entry`);
    }
    for (const [k, own] of [['A', 'nextblock'], ['B', 'tally']]) {
      const rows = [...listing[k].upcoming, ...listing[k].finished];
      assert.ok(rows.length >= 1, `${k} lists no round`);
      assert.deepEqual([...new Set(rows.map((r) => r.game && r.game.name))], [own], `${k} lists another game`);
      assert.deepEqual(listing[k].games.map((g) => g.name), [own], `${k} groups another game`);
      assert.deepEqual(upcoming[k].games.map((g) => g.name).filter((n) => n !== own), [], `${k}'s /rounds lists another game`);
      assert.deepEqual(dash[k].byGame.map((g) => g.name), [own], `${k}'s dashboard has another game`);
      assert.ok(earned(dash[k].byGame[0]) > 0n, `${k} earned nothing under ${own}`);
    }
  } finally { await A.close(); await B.close(); }
});

test('a node whose advertisement names a game it does not host does not start, by name; a hosted game it does not advertise is only said', async () => {
  await assert.rejects(async () => serve(openStore(':memory:'), { port: 0, ...opts, plugins: [NEXTBLOCK], ownAdvert: { hostedGames: [NEXTBLOCK.gameId, TALLY_GAME_ID] } }),
    new RegExp(`this node's advertisement names game ${toHex(TALLY_GAME_ID).slice(0, 16)} it does not host`));
  const said = [];
  const err = console.error; console.error = (...a) => { said.push(a.join(' ')); };
  let d;
  try { d = await serve(openStore(':memory:'), { port: 0, ...opts, plugins: [NEXTBLOCK, TALLY], ownAdvert: { hostedGames: [NEXTBLOCK.gameId] } }); }
  finally { console.error = err; }
  try {
    assert.ok(said.some((l) => /hosting tally, which this node's advertisement does not name/.test(l)), said.join('\n'));
  } finally { await d.close(); }
});

test('GET /games: every game this node hosts, each with the signed manifest that hashes to its id', async () => {
  const { decodeManifest, gameIdOf } = await import('../../arena-protocol/src/manifest.js');
  const { fromHex } = await import('../../arena-protocol/src/hash.js');
  const d = await serve(openStore(':memory:'), { port: 0, ...opts, plugins: [NEXTBLOCK, TALLY], ownAdvert: { hostedGames: [NEXTBLOCK.gameId, TALLY_GAME_ID] } });
  try {
    const got = await json(d, '/games');
    assert.equal(got.node, toHex(d.round.pubkey));
    assert.deepEqual(got.games.map((g) => [g.name, g.id, toHex(gameIdOf(decodeManifest(fromHex(g.manifest)))) === g.id, g.attested]).sort(),
      [['nextblock', toHex(NEXTBLOCK.gameId), true, false], ['tally', toHex(TALLY_GAME_ID), true, false]]);
  } finally { await d.close(); }
});
