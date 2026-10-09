// NEXTBLOCK'S GAME CONFIGS (kanban #203; §27A.6, §27A.7.5): the bytes each of nextblock's cores plays by, versioned and
// hashed from the core's own constants - v1 the founding config of 2069b4c2 (its hash is GENESIS_CONFIG_HASH, which the
// network id commits to), v2 de2f263d's, v3 the per-player config, v4 one world per round. Moved here from
// arena-protocol/src/genesis.js: they read the game's rules, and the engine imports no game. A round names a config by hash;
// the engine only compares hashes the game's manifest lists.
import { Writer } from '../../arena-protocol/src/encode.js';
import { taggedHash } from '../../arena-protocol/src/hash.js';
// THE NODE FEE THESE CONFIGS WERE PLAYED UNDER: BLWP's 2.00%, a literal (kanban #205). The engine's fee is now 5% (§0A.8),
// but a config is the frozen bytes of rules already played - its hash is what rounds and the network id name - so the
// fee written into them stays the one they were written with.
const NODE_FEE_BPS = 200;
import {
  EXPOSURE_REFERENCE, APRON_RADIUS, FRONT_SCORE_SPAN, T_FLOOR, T_CEIL,
  REFERENCE_TICKS,
} from '../frozen/2069b4c2/rules/score.js';
import { HALF_MOUTH, BLOCK_TICKS } from '../frozen/2069b4c2/rules/gate.js';
import {
  HEAT_REACH_ARMOUR, HEAT_REACH_RIFLE, HEAT_OUTRANK, HEAT_SHELL,
} from '../frozen/2069b4c2/rules/army.js';

// AND THE LATER CORES', for the configs their rounds name - never for the network id: de2f263d's own (frozen, v2) and the
// current core's (v3)
import * as liveScore from '../src/rules/score.js';
import * as liveGateM from '../src/rules/gate.js';
import * as liveArmyM from '../src/rules/army.js';
import * as liveCargoM from '../src/rules/cargo.js';
import { LEGACY_CARGO as LIVE_LEGACY_CARGO } from '../src/sim.js';
import * as de2fScore from '../frozen/de2f263d/rules/score.js';
import * as de2fGate from '../frozen/de2f263d/rules/gate.js';
import * as de2fArmy from '../frozen/de2f263d/rules/army.js';
import * as de2fCargo from '../frozen/de2f263d/rules/cargo.js';
import { LEGACY_CARGO as DE2F_LEGACY_CARGO } from '../frozen/de2f263d/sim.js';
const LIVE = { score: liveScore, gate: liveGateM, army: liveArmyM, cargo: liveCargoM, sim: { LEGACY_CARGO: LIVE_LEGACY_CARGO } };
const DE2F = { score: de2fScore, gate: de2fGate, army: de2fArmy, cargo: de2fCargo, sim: { LEGACY_CARGO: DE2F_LEGACY_CARGO } };

export const TAG_GAME_CONFIG = 'BLWP/v1/GameConfig';

/** Opening fee and difficulty as the live core plays them. */
export function encodeGameConfig() {
  const w = new Writer();
  w.u32(EXPOSURE_REFERENCE);
  w.u32(HALF_MOUTH);
  w.u32(APRON_RADIUS);
  w.u32(FRONT_SCORE_SPAN);
  w.u32(T_FLOOR);
  w.u32(T_CEIL);
  w.u32(1);
  w.u8(3);
  w.u8(4);
  w.u16(BLOCK_TICKS);
  w.u16(NODE_FEE_BPS);
  w.u32(HEAT_REACH_ARMOUR);
  w.u32(HEAT_REACH_RIFLE);
  w.u32(HEAT_OUTRANK);
  w.u32(HEAT_SHELL);
  w.u32(REFERENCE_TICKS);
  return w.finish();
}

export const computeGenesisConfigHash = () => taggedHash(TAG_GAME_CONFIG, encodeGameConfig());

/**
 * THE CONFIG A ROUND ON THE CURRENT CORE PLAYS (the owner 2026-10-04: fix the config hash). §27A.6: "A round is bound to the
 * config it was created under. The Round Contract carries config_hash" - so a round names the rules it is scored by. The
 * founding config above stays the network's (the network id commits to it, and it describes the rounds of the core it
 * was founded on); the rules after it - par 1800 ticks, T 1.5 to 1200 ticks and 0.25 from 7200, and C the bed fill - are a
 * second config with its own hash, which the rounds on that core name.
 *
 * VERSIONED: it opens with its version byte, where the founding encoding opens with a u32, so the two can never be read
 * as each other. Beyond the founding fields it names what the founding one could not: the time bounds, and the cargo
 * rule (1 = C is room used over the bed, from the load's room; a load that carries none is LEGACY_CARGO).
 */
export const GAME_CONFIG_V2 = 2;
export const CARGO_RULE_BED_FILL = 1;
export function encodeGameConfigV2({ score: live, gate: liveGate, army: liveArmy, cargo: liveCargo, sim: liveSim } = DE2F, version = GAME_CONFIG_V2) {
  const w = new Writer();
  w.u8(version);
  w.u32(live.EXPOSURE_REFERENCE);
  w.u32(liveGate.HALF_MOUTH);
  w.u32(live.APRON_RADIUS);
  w.u32(live.FRONT_SCORE_SPAN);
  w.u32(live.T_FLOOR);
  w.u32(live.T_CEIL);
  w.u32(1);
  w.u8(3);
  w.u8(4);
  w.u16(liveGate.BLOCK_TICKS);
  w.u16(NODE_FEE_BPS);
  w.u32(liveArmy.HEAT_REACH_ARMOUR);
  w.u32(liveArmy.HEAT_REACH_RIFLE);
  w.u32(liveArmy.HEAT_OUTRANK);
  w.u32(liveArmy.HEAT_SHELL);
  w.u32(live.REFERENCE_TICKS);
  w.u32(live.T_TICKS_MIN);
  w.u32(live.T_TICKS_MAX);
  w.u8(CARGO_RULE_BED_FILL);
  w.u32(liveSim.LEGACY_CARGO);
  w.u32(liveCargo.BED_ROOM);
  return w.finish();
}

/** The config de2f263d's rounds name (dbb49344): v2, from that core's own frozen constants. */
export const computeDe2fConfigHash = () => taggedHash(TAG_GAME_CONFIG, encodeGameConfigV2(DE2F));

/**
 * v3 (the owner 2026-10-04, option 1 of the spec audit): the v2 fields, and the exposure weight - 1 = the load's HEAT, as
 * §18A.3 has it (rate = proximity · (1 + heat)). de2f263d weighted exposure by C, which counted a full bed twice once C
 * became the bed fill; the core after it weights by heat, and its rounds name this config.
 */
export const GAME_CONFIG_V3 = 3;
export const EXPOSURE_WEIGHT_HEAT = 1;
export function encodeGameConfigV3() {
  const v2 = encodeGameConfigV2(LIVE, GAME_CONFIG_V3);
  const out = new Uint8Array(v2.length + 1); out.set(v2); out[v2.length] = EXPOSURE_WEIGHT_HEAT;
  return out;
}

/** The config 7e2123d1's rounds named before the world was shared (f51759b6): v3. */
export const computeConfigV3Hash = () => taggedHash(TAG_GAME_CONFIG, encodeGameConfigV3());

/**
 * v4 (the owner 2026-10-04, #23 world grinding): v3's fields and the WORLD RULE - 1 = one world per round, shared by every
 * player (§5A.5 round_seed(i) = H(committee_seed(i) || "world")); the player picks nothing: no secret, no key, no join
 * tick moves it. Same core 7e2123d1; the pair 7e2123d1 + v4 names the rule.
 */
export const GAME_CONFIG_V4 = 4;
export const WORLD_SHARED_PER_ROUND = 1;
export function encodeGameConfigV4() {
  const v3 = encodeGameConfigV3();
  const out = new Uint8Array(v3.length + 1); out.set(v3); out[0] = GAME_CONFIG_V4; out[v3.length] = WORLD_SHARED_PER_ROUND;
  return out;
}

/** The config hash a round on the current core names: computed from the core's own constants, never typed. */
export const computeCurrentConfigHash = () => taggedHash(TAG_GAME_CONFIG, encodeGameConfigV4());
