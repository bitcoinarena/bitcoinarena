// NEXTBLOCK'S CORES (kanban #202, §0A.2-0A.3; the owner 2026-10-06: the engine is Bitcoin Arena, the game is
// "Tick Tock, Next Block" - `nextblock` in code). What was arena-node/src/cores.js's truck half: the cores a node replays
// nextblock's rounds with (the truck and the four it keeps installed beside it), the configs each plays, the replay
// bundle each round's page runs, and the game's manifest - registered with a node by its launcher (arena-node/src/main.js),
// never imported by the engine. It lives outside core/src, so no core hash moves with it.
//
// The engine reads a core only through its adapter (start, eventsOf, step, stateHash, result, picture, runTicksFits) and
// a game only through its manifest (arena-protocol/src/manifest.js); this file is where nextblock hands it both.
import { createRequire } from 'node:module';
import { coreHashHex } from '../tools/hash-core.js';
import { fileURLToPath } from 'node:url';
import { GENESIS_CONFIG_HASH } from '../../arena-protocol/src/genesis-ids.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { NO_PARENT, RESULT_TYPE, PAYOUT_RULE } from '../../arena-protocol/src/manifest.js';
import { ROUND_PERIOD_MS } from '../../arena-protocol/src/series.js';

// THE REGISTRATION IMPORTS NO CORE (kanban #328, spec §0A.6). A node loads this module in its own thread (ARENA_GAMES,
// arena-node/src/main.js), and a core imported here would run there with every right the node has. A node runs a core
// only in its sandbox (arena-node/src/core-sandbox.js), from the files `root` names, checked against the core's hash.
// `adapter` is the core imported natively for a PLAYER's own simulation (tests, tools): not enumerable, so no copy of a
// core carries it, and loaded only when something asks for it - the node never does.
const requireCore = createRequire(import.meta.url);
const withAdapter = (core, entry) => {
  Object.defineProperty(core, 'adapter', { get: () => requireCore(entry).CORE, enumerable: false });
  return Object.freeze(core);
};
/** The truck's name, and the longest run any of its cores takes (BLOCK_TICKS of rules/gate.js; truck-cores.test.js checks both against the cores). */
export const TRUCK_NAME = 'btc-logistics truck';
export const TRUCK_RUN_TICKS = 10800;

/**
 * THE CONFIG A ROUND ON THE TRUCK NAMES (the owner 2026-10-04, fix 1 of the spec audit; §27A.6 "a round is bound to the config
 * it was created under"): the current core's own rules, hashed from its constants (genesis.js encodeGameConfigV2) - not
 * the founding config, which the network id commits to and which describes 2069b4c2's rounds.
 */
// THE CONFIG HASHES, WRITTEN OUT (kanban #328): config/game-config.js computes them from the cores' own rule files, and
// importing it here would run those files in the node's thread; test/truck-cores.test.js computes them and checks these.
export const TRUCK_CURRENT_CONFIG = '2170f25079f5652ba0633f4b44032c1c9b4dac094e6df99dd001e74b5586293d';
/**
 * v4 MAKES ONE WORLD PER ROUND (#23): nextblock says so on the config itself, and the engine's seed asks the round's game
 * (kanban #203, plugins.js sharedWorld) instead of keeping a list of nextblock's configs. Every other config: per player.
 */
const CURRENT_CONFIG = Object.freeze({ worldShared: true });
/** 7e2123d1's per-player config (f51759b6), the 10-06 series' (#23): installed beside the current one. */
export const TRUCK_V3_CONFIG = 'f51759b6bdc6c738e46910816936c84d72d57e33d2cf04816618912557a76a7c';
/**
 * THE ROUNDS de2f263d PLAYED BEFORE ITS CONFIG HAD A HASH OF ITS OWN: from 08:23Z on 2026-10-04 the free pair opened rounds
 * naming de2f263d with the founding config, and they are not rewritten. That one pair stays accepted for a round whose
 * committee time is before the cut-over, and for no round after it.
 */
/** de2f263d's own config (computeDe2fConfigHash), written out as the two above. */
export const TRUCK_DE2F_CONFIG = 'dbb493445fd56ba099bf8651a444f7c6de4b36add1cb01275bd1857920bd0801';
export const DE2F_HASH = 'de2f263da7ddf892699713ccd43041fb2ea881df9994fbe9f32581904e32e6c8';
export const FOUNDING_CONFIG_ON_DE2F_BEFORE_MS = Date.parse('2026-10-04T13:00:00Z');

/** The truck: the network's title, the current core with the config its rounds name. */
export const TRUCK = withAdapter({
  name: TRUCK_NAME,
  hash: coreHashHex(),
  url: new URL('../src/adapter.js', import.meta.url).href,
  root: new URL('../src/', import.meta.url).href,
  // TWO CONFIGS ON ONE CORE (#23, the owner 2026-10-04): the current one, v4 - one world per round, shared by its players -
  // which every series published from now names; and v3 (f51759b6), the per-player world the 10-06 series was published
  // on, kept installed so its rounds open and replay exactly as published.
  configs: new Map([[TRUCK_CURRENT_CONFIG, CURRENT_CONFIG], [TRUCK_V3_CONFIG, {}]]),
  // the bundle the replay page runs for this core's rounds (core/tools/bundle-replay.js)
  replayFile: new URL('../dist/blwp-replay-core.js', import.meta.url),
}, '../src/adapter.js');

/**
 * THE TRUCK BEFORE C BECAME THE BED FILL AND T SANK FROM 20 S (the owner 2026-10-04 08:54 and 09:17; accepted path A): core
 * 2069b4c2, kept INSTALLED beside the truck - every round published on it (the day's paid set, the late-join series, the
 * free rounds before the pair moved) is replayed by it, byte for byte the core those rounds were played on. Its source
 * is frozen in core/frozen/2069b4c2 and its hash is computed from those files here, never typed: a frozen tree that
 * drifted would name another core and be refused below.
 */
/**
 * de2f263d KEPT INSTALLED BESIDE THE TRUCK (the owner 2026-10-04, option 1: exposure weighted by heat makes a new core): the
 * free rounds the pair opened on it from 08:23Z are replayed by it, frozen in core/frozen/de2f263d. It plays its own
 * config dbb49344 (v2), and the founding config only for a round made before the 13:00Z cut-over.
 */
const FROZEN_DE2F = fileURLToPath(new URL('../frozen/de2f263d', import.meta.url));
if (coreHashHex(FROZEN_DE2F) !== DE2F_HASH) throw new Error(`core/frozen/de2f263d hashes to ${coreHashHex(FROZEN_DE2F)}, not the core it keeps`);
export const TRUCK_DE2F = withAdapter({
  name: `${TRUCK_NAME} (de2f263d, exposure by C)`,
  hash: DE2F_HASH,
  url: new URL('../frozen/de2f263d/adapter.js', import.meta.url).href,
  root: new URL('../frozen/de2f263d/', import.meta.url).href,
  configs: new Map([[TRUCK_DE2F_CONFIG, {}],
    [toHex(GENESIS_CONFIG_HASH), { committeeBeforeMs: FOUNDING_CONFIG_ON_DE2F_BEFORE_MS }]]),
  replayFile: new URL('../dist/blwp-replay-core-de2f263d.js', import.meta.url),
}, '../frozen/de2f263d/adapter.js');

/**
 * 7e2123d1 KEPT INSTALLED BESIDE THE TRUCK (kanban #29, 2026-10-07: §4.11's objectives became the chart's HIGH, LOW and
 * OPEN, and the RIDGE cap went, in core 68e2b3d6): every round the seats published on 7e2123d1 is replayed by it, frozen in
 * core/frozen/7e2123d1. It plays the two configs the truck carried while it was the truck: v4 (one world per round) and the
 * per-player v3 (f51759b6) of the 10-06 series.
 */
export const TRUCK_7E21_HASH = '7e2123d1990d1443fcac12dc6c7575059935d89d794822bc69c67b184870ce20';
const FROZEN_7E21 = fileURLToPath(new URL('../frozen/7e2123d1', import.meta.url));
if (coreHashHex(FROZEN_7E21) !== TRUCK_7E21_HASH) throw new Error(`core/frozen/7e2123d1 hashes to ${coreHashHex(FROZEN_7E21)}, not the core it keeps`);
export const TRUCK_7E21 = withAdapter({
  name: `${TRUCK_NAME} (7e2123d1, objectives from the relief)`,
  hash: TRUCK_7E21_HASH,
  url: new URL('../frozen/7e2123d1/adapter.js', import.meta.url).href,
  root: new URL('../frozen/7e2123d1/', import.meta.url).href,
  configs: new Map([[TRUCK_CURRENT_CONFIG, CURRENT_CONFIG], [TRUCK_V3_CONFIG, {}]]),
  replayFile: new URL('../dist/blwp-replay-core-7e2123d1.js', import.meta.url),
}, '../frozen/7e2123d1/adapter.js');

/**
 * f0cc7b7b, THE TRUCK THAT KNOWS THE LARGER TRUCK (kanban #369, the first in-game item of #365; the owner 2026-10-15), INSTALLED BESIDE
 * THE TRUCK: the same game with a run's own bed, drive acceleration and top speed, which a run takes when its entry plays with the
 * larger truck (its unlock, frozen/f0cc7b7b/items.js). Only manifest version 3 (plugin/nextblock-v3.js, protocol 10) names it, so a
 * round on it is a version-3 round; versions 1 and 2 and the truck above are exactly as they were. Kept like the cores before the
 * truck - its files in core/frozen/f0cc7b7b, its hash computed from them - until the series' rounds move onto it. The truck's configs.
 */
export const TRUCK_F0CC_HASH = 'f0cc7b7b2e75e350149ff8a6e58a1cc861a3ab4969d1c81b2206564b57ffb7a8';
const FROZEN_F0CC = fileURLToPath(new URL('../frozen/f0cc7b7b', import.meta.url));
if (coreHashHex(FROZEN_F0CC) !== TRUCK_F0CC_HASH) throw new Error(`core/frozen/f0cc7b7b hashes to ${coreHashHex(FROZEN_F0CC)}, not the core it keeps`);
export const TRUCK_F0CC = withAdapter({
  name: `${TRUCK_NAME} (f0cc7b7b, the larger truck)`,
  hash: TRUCK_F0CC_HASH,
  url: new URL('../frozen/f0cc7b7b/adapter.js', import.meta.url).href,
  root: new URL('../frozen/f0cc7b7b/', import.meta.url).href,
  configs: new Map([[TRUCK_CURRENT_CONFIG, CURRENT_CONFIG], [TRUCK_V3_CONFIG, {}]]),
  replayFile: new URL('../dist/blwp-replay-core-f0cc7b7b.js', import.meta.url),
}, '../frozen/f0cc7b7b/adapter.js');

export const TRUCK_2069_HASH = '2069b4c2ab39466c79000aac1b091c75b066b814a0952f8037011691538a774e';
const FROZEN_2069 = fileURLToPath(new URL('../frozen/2069b4c2', import.meta.url));
if (coreHashHex(FROZEN_2069) !== TRUCK_2069_HASH) throw new Error(`core/frozen/2069b4c2 hashes to ${coreHashHex(FROZEN_2069)}, not the core it keeps`);
export const TRUCK_2069 = withAdapter({
  name: `${TRUCK_NAME} (2069b4c2, C 0.7 and par 65 s)`,
  hash: TRUCK_2069_HASH,
  url: new URL('../frozen/2069b4c2/adapter.js', import.meta.url).href,
  root: new URL('../frozen/2069b4c2/', import.meta.url).href,
  configs: new Map([[toHex(GENESIS_CONFIG_HASH), {}]]),
  replayFile: new URL('../dist/blwp-replay-core-2069b4c2.js', import.meta.url),
}, '../frozen/2069b4c2/adapter.js');

/** The truck's hashes as a round names them: its sim_wasm_hash and the config_hash of the rules it plays. */
export const TRUCK_CORE_HASH = fromHex(TRUCK.hash);
export const TRUCK_CONFIG_HASH = fromHex(TRUCK_CURRENT_CONFIG);
// #23: the current config is v4 - one world per round - and the round openers (round-2of2.mjs, the testnet4 series writer)
// name it through TRUCK_CONFIG_HASH. The per-player config v3 (f51759b6), the 10-06 series' and every older round's, is
// TRUCK_V3_CONFIG_HASH; the tests whose rounds carry a world secret of their own name it.
export const TRUCK_V3_CONFIG_HASH = fromHex(TRUCK_V3_CONFIG);
export const TRUCK_SHARED_CONFIG_HASH = TRUCK_CONFIG_HASH;

/**
 * THE TRUCK BEFORE THE 82/90 HARD FORK (the owner 2026-10-01: "Change the core, it's basically a hard fork"): the core every
 * round before the fork names, d15c39bb..., ended every run at its own 10800 ticks. The core after it takes the run length
 * from the round and runs 10800 ticks hash for hash as the old one did (core/test/round-ends.test.js), so the old hash is
 * installed as this same core held to that one length: its rounds replay unchanged, and none of them names another.
 */
export const TRUCK_BEFORE_FORK_HASH = 'd15c39bb83b7cb63ce2b232a7b62b0078d78d9944013ce42799c80a29bf005ef';
// HELD BY 2069b4c2 SINCE THE TRUCK MOVED ON (2026-10-04): 2069b4c2 is the core that ran d15c39bb's rounds hash for hash at
// 10800 ticks; the truck after it does not (C from an empty bed, T from 20 s), so it no longer stands in for them.
export const TRUCK_BEFORE_FORK = withAdapter({ ...TRUCK_2069, name: `${TRUCK.name} (before the 82/90 fork)`, hash: TRUCK_BEFORE_FORK_HASH,
  // its name is not its files' hash: it runs 2069b4c2's files, and the sandbox checks them against that
  sourceHash: TRUCK_2069_HASH, fixedRunTicks: TRUCK_RUN_TICKS }, '../frozen/2069b4c2/adapter.js');


/**
 * NEXTBLOCK'S OWN CHECK OF THE ROUND FIELDS ONLY IT READS (kanban #203: moved out of arena-protocol/src/contracts.js; the
 * contract layout is unchanged): a round whose exposure reference is 0 ignores exposure, and one whose time floor is not
 * below its ceiling has a degenerate time factor. The engine's contractWarnings appends these for a nextblock round.
 */
export function nextblockRoundWarnings(c) {
  const out = [];
  if (c.exposureReference === 0) out.push('exposure_ignored');
  if (c.timeFloor >= c.timeCeil) out.push('time_factor_degenerate');
  return out;
}

/** Every core nextblock's rounds are replayed by, by hash: the truck and the four kept installed beside it. */
export const NEXTBLOCK_CORES = new Map([[TRUCK.hash, TRUCK], [TRUCK_7E21_HASH, TRUCK_7E21], [DE2F_HASH, TRUCK_DE2F],
  [TRUCK_2069_HASH, TRUCK_2069], [TRUCK_BEFORE_FORK_HASH, TRUCK_BEFORE_FORK]]);
/** THE CORES MANIFEST VERSION 3 NAMES (kanban #369): every one above, and the truck that knows the larger truck. */
export const NEXTBLOCK_CORES_V3 = new Map([...NEXTBLOCK_CORES, [TRUCK_F0CC_HASH, TRUCK_F0CC]]);

/**
 * NEXTBLOCK'S MANIFEST BODY, from this registration (§0A.3): every core above with the configs it plays, a run of at
 * most the truck's RUN_TICKS, §18A's rank curve at 3/4, a floor of one score unit, the client scripts the game serves
 * (`clients`, the nextblock list in arena-client/known-good-clients.json) and the donation set the testnet4 series name.
 * round_period: the 90 s grid its series run on (series.js ROUND_PERIOD_MS). The signed manifest (nextblock-manifest.js) is this body
 * signed by the game's developer with the dev client's signer (nextblock/tools/sign-manifest.mjs); nextblock-manifest.test.js holds the two to the same bytes.
 */
export function nextblockManifestBody({ clients, gameDevPubkey, gameDonationSetId, cores = NEXTBLOCK_CORES }) {
  const sorted = (hs) => [...hs].sort();
  return {
    gameName: 'nextblock',
    gameDevPubkey,
    version: 1,
    parentManifestId: NO_PARENT,
    resultType: RESULT_TYPE.REPLAY,
    cores: sorted([...cores.keys()]).map((h) => ({ hash: fromHex(h), configs: sorted([...cores.get(h).configs.keys()]).map(fromHex) })),
    runTicksMax: TRUCK_RUN_TICKS,
    roundPeriodMs: ROUND_PERIOD_MS,
    payoutRule: PAYOUT_RULE.RANK_CURVE,
    rankNumerator: 3,
    rankDenominator: 4,
    minScore: 1,
    clients: sorted(clients).map(fromHex),
    gameDonationSetId,
  };
}

/** WHAT NEXTBLOCK SELLS from manifest version 3 (kanban #369, the first in-game item of #365; the owner 2026-10-15: "a larger truck
 * for 500 satoshis"): the larger truck, by the unlock core f0cc7b7b knows - frozen/f0cc7b7b/items.js LARGE_TRUCK_UNLOCK, written out
 * here because the registration evaluates no core module (test/large-truck.test.js holds the two equal). */
export const LARGE_TRUCK_ITEM_UNLOCK = '10dec674eb2f698400bb775c508e727d9c15734a6e7056889d12bb0ebab54d69';
export const NEXTBLOCK_ITEMS = Object.freeze([
  Object.freeze({ id: 'large-truck', name: 'Large truck', priceSat: 500n, unlock: fromHex(LARGE_TRUCK_ITEM_UNLOCK) }),
]);
