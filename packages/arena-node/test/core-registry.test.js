// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SIGNER NODE OPENS ONLY A ROUND ON A CORE AND CONFIG IT RUNS, AND A RESULT NAMES THE CORE THAT REPLAYED
// (M3 R1 step B; 2026-09-15 08:07: "each round names its sim_wasm_hash and its game_config/
// config_hash. Signer nodes replay what that round names").
//
// Before step B every round was replayed by the one truck core whatever it named, and a result
// took the contract's simCoreHash as its own - a signer node could sign "core X" over a replay of core Y.
// Now the signer node's registry (plugins.js: each game it hosts, with the cores its operator installed for it - since
// a second title is a game of its own) resolves the round's (simCoreHash, configHash); a pair it does not hold is refused at
// the door (27A.7.5: not selectable - it serves nothing there, and is not slashed); and resultFrom
// refuses a replay that ran another core than the round names.
// A FREE ROUND (RULED 2026-09-25): nothing this file asserts depends on the stake, and a paying round opens only
// on a signer node that reaches a federation now.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFrom } from '../src/verdict.js';
import { TRUCK, TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, TRUCK_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { coreOfGame, hostedPlugins, installedCoresOf } from '../src/plugins.js';
import { TRUCK_BEFORE_FORK_HASH, NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testGame } from './plugins/sign.js';

// THE CORE AND CONFIG A ROUND NAMES, WITHIN ITS GAME: nextblock's unless another game is given.
const coreForRound = (c, game = NEXTBLOCK) => coreOfGame(c, game);
import { contractFor, opts, b32 } from './window-fixture.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('the signer node door opens a round on the truck\'s own core and config, and refuses an unknown core or a config it does not run - by name, nothing stored', async () => {
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  try {
    const nodes = [d.round.pubkey, b32(0x33)];
    const post = async (c) => {
      const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
      return { status: r.status, why: (await r.text()).trim(), held: (await fetch(`http://127.0.0.1:${d.port}/round?id=${toHex(roundId(c))}`)).status };
    };
    const truck = { ...contractFor(nodes, 3000n, ['wss://r.example']), gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, configHash: TRUCK_V3_CONFIG_HASH, stakeMsat: 0n };
    const unknownCore = await post({ ...truck, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1) });
    const otherConfig = await post({ ...truck, configHash: b32(0x43) });
    const opened = await post(truck);
    console.log('  FACTS:', JSON.stringify({ unknownCore: { ...unknownCore, why: unknownCore.why.slice(0, 110) },
      otherConfig: { ...otherConfig, why: otherConfig.why.slice(0, 110) }, truck: { status: opened.status, held: opened.held } }));
    assert.equal(unknownCore.status, 409);
    assert.match(unknownCore.why, /this signer node holds no core 0101010101010101: it is not selectable for that round \(27A\.7\.5\)/);
    assert.equal(unknownCore.held, 404, 'a round on an unknown core exists on the signer node');
    assert.equal(otherConfig.status, 409);
    assert.match(otherConfig.why, /runs btc-logistics truck but not the config 4343434343434343/);
    assert.equal(otherConfig.held, 404);
    assert.equal(opened.status, 201, opened.why);
    assert.equal(opened.held, 200);
  } finally { await d.close(); }
});

test('the registry resolves a round by both hashes within its game, holds nextblock\'s cores, and hosts an operator\'s game beside it', () => {
  const round = { gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, configHash: TRUCK_V3_CONFIG_HASH };
  const got = coreForRound(round);
  assert.equal(got.ok, true, got.why);
  assert.equal(got.core, TRUCK);
  const other = { name: 'a second title', hash: 'ab'.repeat(32), url: TRUCK.url, root: TRUCK.root, sourceHash: TRUCK.hash, adapter: TRUCK.adapter, configs: new Map([['cd'.repeat(32), {}]]) };
  // A SECOND TITLE IS A GAME OF ITS OWN, hosted beside nextblock - never a core installed beside the truck
  const otherGame = testGame({ name: 'a second title', cores: new Map([[other.hash, other]]), runTicksMax: 10800 });
  const both = hostedPlugins([NEXTBLOCK, otherGame]);
  // THE TRUCK, 2069b4c2 KEPT BESIDE IT (path A, 2026-10-04), THE TRUCK BEFORE THE 82/90 FORK (its old hash: 2069b4c2 held
  // to 10800), de2f263d and 7e2123d1 - nextblock's - and the operator's game's core.
  assert.deepEqual([...installedCoresOf(both).keys()].sort(), [TRUCK.hash, 'de2f263da7ddf892699713ccd43041fb2ea881df9994fbe9f32581904e32e6c8', '2069b4c2ab39466c79000aac1b091c75b066b814a0952f8037011691538a774e',
    '7e2123d1990d1443fcac12dc6c7575059935d89d794822bc69c67b184870ce20', TRUCK_BEFORE_FORK_HASH, other.hash].sort());
  // the pre-fork core's rounds name the founding config (2026-10-04: a round names the config of the rules it plays)
  const old = coreForRound({ simCoreHash: Uint8Array.from(Buffer.from(TRUCK_BEFORE_FORK_HASH, 'hex')), configHash: GENESIS_CONFIG_HASH, blockTicks: 10800 });
  assert.equal(old.ok, true, old.why);
  assert.deepEqual([old.core.hash === TRUCK_BEFORE_FORK_HASH, old.core.fixedRunTicks, old.runTicks], [true, 10800, 10800]);
  const second = both.get(toHex(otherGame.gameId));
  assert.equal(coreForRound({ simCoreHash: Uint8Array.from(Buffer.from(other.hash, 'hex')), configHash: Uint8Array.from(Buffer.from('cd'.repeat(32), 'hex')) }, second).core, other);
  assert.equal(coreForRound({ simCoreHash: Uint8Array.from(Buffer.from(other.hash, 'hex')), configHash: TRUCK_V3_CONFIG_HASH }, second).ok, false,
    'a core was run under a config it does not carry');
  assert.equal(coreForRound({ simCoreHash: Uint8Array.from(Buffer.from(other.hash, 'hex')), configHash: TRUCK_V3_CONFIG_HASH }).ok, false,
    'nextblock ran a core another game installed');
});

test('a result names the core that replayed the run, and one whose replay ran another core than the round names is refused', () => {
  const contract = { ...contractFor([b32(4), b32(5)], 3000n), gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, configHash: TRUCK_V3_CONFIG_HASH };
  const rid = roundId(contract);
  const entry = { roundId: rid, playerPubkey: b32(7) };
  const transcript = { roundId: rid, entryId: b32(9), hash: b32(0x11) };
  const answer = { ok: true, outcome: 'DELIVERED', score: 5, coreHash: TRUCK.hash };
  const good = resultFrom({ answer, contract, entry, transcript, entryId: b32(9), nodePubkey: b32(8) });
  assert.equal(good.ok, true, good.why);
  assert.equal(toHex(good.result.simCoreHash), TRUCK.hash);
  const other = resultFrom({ answer: { ...answer, coreHash: 'ab'.repeat(32) }, contract, entry, transcript, entryId: b32(9), nodePubkey: b32(8) });
  assert.equal(other.ok, false);
  assert.match(other.why, /that run was replayed under core abababababababab, not the core/);
  const unnamed = resultFrom({ answer: { ...answer, coreHash: undefined }, contract, entry, transcript, entryId: b32(9), nodePubkey: b32(8) });
  assert.equal(unnamed.ok, false, 'a replay that names no core was signed');
});

// 2069b4c2 KEPT INSTALLED BESIDE THE TRUCK (2026-10-04, path A): every round published before C became the bed
// fill and T sank from 20 s names it, and is replayed by it - its frozen source, not the truck that moved on. The pre-fork
// core d15c39bb rides on it too: 2069b4c2 is the core that ran those rounds hash for hash at 10800 ticks.
import { TRUCK_2069, TRUCK_2069_HASH } from '../../nextblock/plugin/nextblock.js';
import { CORE as FROZEN_2069 } from '../../nextblock/frozen/2069b4c2/adapter.js';
import { CORE as NOW } from '../../nextblock/frozen/68e2b3d6/adapter.js';   // the truck (kanban #523: nextblock/src is version 5's a5c5766a)

test('2069b4c2 rounds are replayed by the frozen 2069b4c2 core, the pre-fork core by it held to 10800, the rest by the truck', () => {
  const at = (hex) => coreForRound({ simCoreHash: Uint8Array.from(Buffer.from(hex, 'hex')), configHash: GENESIS_CONFIG_HASH, blockTicks: 4920 });
  const old = at(TRUCK_2069_HASH);
  assert.equal(old.ok, true, old.why);
  assert.equal(old.core.adapter, FROZEN_2069);
  assert.equal(old.core, TRUCK_2069);
  const pre = at(TRUCK_BEFORE_FORK_HASH);
  assert.equal(pre.core.adapter, FROZEN_2069, 'the pre-fork core is still the truck that moved on');
  assert.equal(pre.core.fixedRunTicks, FROZEN_2069.RUN_TICKS);
  const now = coreForRound({ simCoreHash: TRUCK_CORE_HASH, configHash: TRUCK_V3_CONFIG_HASH, blockTicks: 4920 });
  assert.equal(now.core.adapter, NOW);
  assert.notEqual(TRUCK.hash, TRUCK_2069_HASH);
  // and they differ where the rule moved: the same load and drive scores differently under the two
  const drive = (core, loads) => { const st = core.start(0x5eed1234); const ev = core.eventsOf({ loads });
    for (let t = 0; t < 1500; t++) { ev.before(st, t); core.step(st, [65536, 0, 0, 0, 1]); } return core.result(st); };
  const a = drive(FROZEN_2069, [[0, 0, 0]]), b = drive(NOW, [[0, 0, 0, 0]]);
  assert.ok(a.score > 0, `the 2069b4c2 drive scored ${a.score}`);
  assert.equal(b.score, 0, 'an empty bed on the current core scores nothing');
});

// THE CONFIG A ROUND NAMES IS THE RULES IT PLAYS (2026-10-04, fix 1 of the spec audit): de2f263d runs its own
// config, 2069b4c2 the founding one; de2f263d with the founding config only for a round made before the cut-over.
import { TRUCK_CURRENT_CONFIG, FOUNDING_CONFIG_ON_DE2F_BEFORE_MS } from '../../nextblock/plugin/nextblock.js';
import { GENESIS_CONFIG_HASH } from '../../arena-protocol/src/genesis-ids.js';
test('each core runs the config of its own rules; the founding config on de2f263d only before the cut-over', () => {
  const pair = (core, config, committeeTimeMs) => coreForRound({ simCoreHash: Uint8Array.from(Buffer.from(core, 'hex')),
    configHash: config instanceof Uint8Array ? config : Uint8Array.from(Buffer.from(config, 'hex')), blockTicks: 4920, committeeTimeMs });
  const before = BigInt(FOUNDING_CONFIG_ON_DE2F_BEFORE_MS - 60000), after = BigInt(FOUNDING_CONFIG_ON_DE2F_BEFORE_MS + 60000);
  assert.equal(pair(TRUCK.hash, TRUCK_CURRENT_CONFIG, after).ok, true);
  assert.equal(TRUCK_CONFIG_HASH.length, 32);
  assert.equal(Buffer.from(TRUCK_CONFIG_HASH).toString('hex'), TRUCK_CURRENT_CONFIG, 'a round on the truck is made with another config');
  //: the truck runs the per-player config v3 (f51759b6, the 10-06 series') beside the current shared-world v4
  assert.equal(pair(TRUCK.hash, TRUCK_V3_CONFIG_HASH, after).ok, true, 'the 10-06 series\' config no longer opens');
  assert.equal(Buffer.from(TRUCK_V3_CONFIG_HASH).toString('hex').slice(0, 8), 'f51759b6');
  assert.equal(TRUCK_CURRENT_CONFIG.slice(0, 8), '2170f250');
  assert.equal(pair(TRUCK_2069_HASH, GENESIS_CONFIG_HASH, after).ok, true);
  assert.match(pair(TRUCK_2069_HASH, TRUCK_CURRENT_CONFIG, before).why, /not the config/);
  // de2f263d, frozen beside the truck since exposure takes the heat: its own config, and the founding one before the cut-over
  const DE2F = 'de2f263da7ddf892699713ccd43041fb2ea881df9994fbe9f32581904e32e6c8';
  assert.equal(pair(DE2F, 'dbb493445fd56ba099bf8651a444f7c6de4b36add1cb01275bd1857920bd0801', after).ok, true);
  assert.equal(pair(DE2F, GENESIS_CONFIG_HASH, before).ok, true, 'a free round made before the cut-over is refused');
  assert.match(pair(DE2F, GENESIS_CONFIG_HASH, after).why, /only for rounds made before/);
  assert.match(pair(DE2F, TRUCK_CURRENT_CONFIG, before).why, /not the config/);
  assert.match(pair(TRUCK.hash, GENESIS_CONFIG_HASH, before).why, /not the config/);
});

// 7e2123d1 KEPT INSTALLED BESIDE THE TRUCK (2026-10-07): the core before §4.11's objectives became the chart's -
// every round the live seats published on it, with the shared-world v4 or the per-player v3 config, is replayed by its
// frozen source (core/frozen/7e2123d1), not by the truck that moved on to 68e2b3d6.
import { CORE as FROZEN_7E21 } from '../../nextblock/frozen/7e2123d1/adapter.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { HOSTED } from './plugins/hosted.js';
test('7e2123d1 rounds are replayed by the frozen 7e2123d1 core under both its configs, and not by the truck', () => {
  const S7E = '7e2123d1990d1443fcac12dc6c7575059935d89d794822bc69c67b184870ce20';
  assert.notEqual(TRUCK.hash, S7E, 'the truck is still 7e2123d1');
  for (const config of ['2170f25079f5652ba0633f4b44032c1c9b4dac094e6df99dd001e74b5586293d', 'f51759b6bdc6c738e46910816936c84d72d57e33d2cf04816618912557a76a7c']) {
    const got = coreForRound({ simCoreHash: Uint8Array.from(Buffer.from(S7E, 'hex')), configHash: Uint8Array.from(Buffer.from(config, 'hex')), blockTicks: 4920 });
    assert.equal(got.ok, true, `a 7e2123d1 round under ${config.slice(0, 8)}: ${got.why}`);
    assert.equal(got.core.hash, S7E);
    assert.equal(got.core.adapter, FROZEN_7E21, 'a 7e2123d1 round ran on another core than its frozen source');
    assert.notEqual(got.core.adapter, NOW);
    assert.ok(got.core.replayFile.pathname.endsWith('/nextblock/dist/blwp-replay-core-7e2123d1.js'), 'its replay page runs another bundle');
  }
  assert.match(coreForRound({ simCoreHash: Uint8Array.from(Buffer.from(S7E, 'hex')), configHash: GENESIS_CONFIG_HASH, blockTicks: 4920 }).why, /not the config/);
});

// ONE VERSION THAT DOES NOT STAND IS LEFT OUT, THE NODE STILL STARTS (the installer walk of d3b3ddf6: btc-updown-v21's parent missing)
test('a registration that does not stand is left out with its reason; the rest are hosted; none at all still refuses', () => {
  const broken = { ...NEXTBLOCK, gameId: new Uint8Array(32).fill(7) };
  const logs = [];
  const games = hostedPlugins([NEXTBLOCK, broken], { log: (l) => logs.push(l) });
  assert.equal(games.size, 1, 'nextblock hosted');
  assert.equal(games.refused.length, 1);
  assert.match(logs[0], /^\[games\] left out: /);
  assert.throws(() => hostedPlugins([broken], { log: () => {} }), /no game this node can host/);
});
