// NEXTBLOCK'S CORES (kanban #202, §0A.2-0A.3; the owner 2026-10-06: the engine is Bitcoin Arena, the game is
// "Tick Tock, Next Block" - `nextblock` in code). What was arena-node/src/cores.js's truck half: the cores a node replays
// nextblock's rounds with (the truck and the four it keeps installed beside it), the configs each plays, the replay
// bundle each round's page runs, and the game's manifest - registered with a node by its launcher (arena-node/src/main.js),
// never imported by the engine. It lives outside core/src, so no core hash moves with it.
//
// The engine reads a core only through its adapter (start, eventsOf, step, stateHash, result, picture, runTicksFits) and
// a game only through its manifest (arena-protocol/src/manifest.js); this file is where nextblock hands it both.
import { CORE as TRUCK_ADAPTER } from '../src/adapter.js';
import { CORE as TRUCK_2069_ADAPTER } from '../frozen/2069b4c2/adapter.js';
import { CORE as TRUCK_DE2F_ADAPTER } from '../frozen/de2f263d/adapter.js';
import { CORE as TRUCK_7E21_ADAPTER } from '../frozen/7e2123d1/adapter.js';
import { coreHashHex } from '../tools/hash-core.js';
import { GENESIS_CONFIG_HASH } from '../../arena-protocol/src/genesis-ids.js';
import { computeCurrentConfigHash, computeDe2fConfigHash, computeConfigV3Hash } from '../config/game-config.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { NO_PARENT, RESULT_TYPE, PAYOUT_RULE } from '../../arena-protocol/src/manifest.js';
import { ROUND_PERIOD_MS } from '../../arena-protocol/src/series.js';

/**
 * THE CONFIG A ROUND ON THE TRUCK NAMES (the owner 2026-10-04, fix 1 of the spec audit; §27A.6 "a round is bound to the config
 * it was created under"): the current core's own rules, hashed from its constants (genesis.js encodeGameConfigV2) - not
 * the founding config, which the network id commits to and which describes 2069b4c2's rounds.
 */
export const TRUCK_CURRENT_CONFIG = toHex(computeCurrentConfigHash());
/**
 * v4 MAKES ONE WORLD PER ROUND (#23): nextblock says so on the config itself, and the engine's seed asks the round's game
 * (kanban #203, plugins.js sharedWorld) instead of keeping a list of nextblock's configs. Every other config: per player.
 */
const CURRENT_CONFIG = Object.freeze({ worldShared: true });
/** 7e2123d1's per-player config (f51759b6), the 10-06 series' (#23): installed beside the current one. */
export const TRUCK_V3_CONFIG = toHex(computeConfigV3Hash());
/**
 * THE ROUNDS de2f263d PLAYED BEFORE ITS CONFIG HAD A HASH OF ITS OWN: from 08:23Z on 2026-10-04 the free pair opened rounds
 * naming de2f263d with the founding config, and they are not rewritten. That one pair stays accepted for a round whose
 * committee time is before the cut-over, and for no round after it.
 */
export const DE2F_HASH = 'de2f263da7ddf892699713ccd43041fb2ea881df9994fbe9f32581904e32e6c8';
export const FOUNDING_CONFIG_ON_DE2F_BEFORE_MS = Date.parse('2026-10-04T13:00:00Z');

/** The truck: the network's title, the current core with the config its rounds name. */
export const TRUCK = Object.freeze({
  name: TRUCK_ADAPTER.name,
  hash: coreHashHex(),
  url: new URL('../src/adapter.js', import.meta.url).href,
  adapter: TRUCK_ADAPTER,
  // TWO CONFIGS ON ONE CORE (#23, the owner 2026-10-04): the current one, v4 - one world per round, shared by its players -
  // which every series published from now names; and v3 (f51759b6), the per-player world the 10-06 series was published
  // on, kept installed so its rounds open and replay exactly as published.
  configs: new Map([[TRUCK_CURRENT_CONFIG, CURRENT_CONFIG], [TRUCK_V3_CONFIG, {}]]),
  // the bundle the replay page runs for this core's rounds (core/tools/bundle-replay.js)
  replayFile: new URL('../dist/blwp-replay-core.js', import.meta.url),
});

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
const FROZEN_DE2F = new URL('../frozen/de2f263d', import.meta.url).pathname;
if (coreHashHex(FROZEN_DE2F) !== DE2F_HASH) throw new Error(`core/frozen/de2f263d hashes to ${coreHashHex(FROZEN_DE2F)}, not the core it keeps`);
export const TRUCK_DE2F = Object.freeze({
  name: `${TRUCK_ADAPTER.name} (de2f263d, exposure by C)`,
  hash: DE2F_HASH,
  url: new URL('../frozen/de2f263d/adapter.js', import.meta.url).href,
  adapter: TRUCK_DE2F_ADAPTER,
  configs: new Map([[toHex(computeDe2fConfigHash()), {}],
    [toHex(GENESIS_CONFIG_HASH), { committeeBeforeMs: FOUNDING_CONFIG_ON_DE2F_BEFORE_MS }]]),
  replayFile: new URL('../dist/blwp-replay-core-de2f263d.js', import.meta.url),
});

/**
 * 7e2123d1 KEPT INSTALLED BESIDE THE TRUCK (kanban #29, 2026-10-07: §4.11's objectives became the chart's HIGH, LOW and
 * OPEN, and the RIDGE cap went, in core 68e2b3d6): every round the seats published on 7e2123d1 is replayed by it, frozen in
 * core/frozen/7e2123d1. It plays the two configs the truck carried while it was the truck: v4 (one world per round) and the
 * per-player v3 (f51759b6) of the 10-06 series.
 */
export const TRUCK_7E21_HASH = '7e2123d1990d1443fcac12dc6c7575059935d89d794822bc69c67b184870ce20';
const FROZEN_7E21 = new URL('../frozen/7e2123d1', import.meta.url).pathname;
if (coreHashHex(FROZEN_7E21) !== TRUCK_7E21_HASH) throw new Error(`core/frozen/7e2123d1 hashes to ${coreHashHex(FROZEN_7E21)}, not the core it keeps`);
export const TRUCK_7E21 = Object.freeze({
  name: `${TRUCK_ADAPTER.name} (7e2123d1, objectives from the relief)`,
  hash: TRUCK_7E21_HASH,
  url: new URL('../frozen/7e2123d1/adapter.js', import.meta.url).href,
  adapter: TRUCK_7E21_ADAPTER,
  configs: new Map([[TRUCK_CURRENT_CONFIG, CURRENT_CONFIG], [TRUCK_V3_CONFIG, {}]]),
  replayFile: new URL('../dist/blwp-replay-core-7e2123d1.js', import.meta.url),
});

export const TRUCK_2069_HASH = '2069b4c2ab39466c79000aac1b091c75b066b814a0952f8037011691538a774e';
const FROZEN_2069 = new URL('../frozen/2069b4c2', import.meta.url).pathname;
if (coreHashHex(FROZEN_2069) !== TRUCK_2069_HASH) throw new Error(`core/frozen/2069b4c2 hashes to ${coreHashHex(FROZEN_2069)}, not the core it keeps`);
export const TRUCK_2069 = Object.freeze({
  name: `${TRUCK_ADAPTER.name} (2069b4c2, C 0.7 and par 65 s)`,
  hash: TRUCK_2069_HASH,
  url: new URL('../frozen/2069b4c2/adapter.js', import.meta.url).href,
  adapter: TRUCK_2069_ADAPTER,
  configs: new Map([[toHex(GENESIS_CONFIG_HASH), {}]]),
  replayFile: new URL('../dist/blwp-replay-core-2069b4c2.js', import.meta.url),
});

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
export const TRUCK_BEFORE_FORK = Object.freeze({ ...TRUCK_2069, name: `${TRUCK.name} (before the 82/90 fork)`, hash: TRUCK_BEFORE_FORK_HASH,
  fixedRunTicks: TRUCK_2069_ADAPTER.RUN_TICKS });


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

/**
 * NEXTBLOCK'S MANIFEST BODY, from this registration (§0A.3): every core above with the configs it plays, a run of at
 * most the truck's RUN_TICKS, §18A's rank curve at 3/4, a floor of one score unit, the client scripts the game serves
 * (`clients`, the nextblock list in arena-client/known-good-clients.json) and the donation set the testnet4 series name.
 * round_period: the 90 s grid its series run on (series.js ROUND_PERIOD_MS). The signed manifest (nextblock-manifest.js) is this body
 * signed by the game's developer with the dev client's signer (nextblock/tools/sign-manifest.mjs); nextblock-manifest.test.js holds the two to the same bytes.
 */
export function nextblockManifestBody({ clients, gameDevPubkey, gameDonationSetId }) {
  const sorted = (hs) => [...hs].sort();
  return {
    gameName: 'nextblock',
    gameDevPubkey,
    version: 1,
    parentManifestId: NO_PARENT,
    resultType: RESULT_TYPE.REPLAY,
    cores: sorted([...NEXTBLOCK_CORES.keys()]).map((h) => ({ hash: fromHex(h), configs: sorted([...NEXTBLOCK_CORES.get(h).configs.keys()]).map(fromHex) })),
    runTicksMax: TRUCK_ADAPTER.RUN_TICKS,
    roundPeriodMs: ROUND_PERIOD_MS,
    payoutRule: PAYOUT_RULE.RANK_CURVE,
    rankNumerator: 3,
    rankDenominator: 4,
    minScore: 1,
    clients: sorted(clients).map(fromHex),
    gameDonationSetId,
  };
}
