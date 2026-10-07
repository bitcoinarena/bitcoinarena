// A GAME IS A MANIFEST (§0A.3, kanban #202, the owner 2026-10-06/07). The engine never imports a game's code: what it needs
// from a game - which cores, which configs, how long a run may be, which of the engine's payout rules and with which
// numbers - it reads from the game's manifest, and from the game's core only through the adapter a node installed.
//
//     GameManifest {
//       game_name, game_dev_pubkey, version, parent_manifest_id, result_type,
//       cores[] (each with its configs[]), run_ticks_max, round_period,
//       payout_rule, payout_params (the rank curve's numerator and denominator), min_score,
//       clients[], game_donation_set, signature by game_dev_pubkey
//     }
//     game_id = H(GameManifest)
//
// The developer signs the BODY's id (TAG.gameManifestBody), not the bytes that carry the signature - an object whose
// bytes held its own signature could not be signed - and game_id is the hash of body and signature together
// (TAG.gameManifest), so two signatures over one body are two manifests, never one id for either.
//
// An update is a new manifest: the same key, the old id as its parent, the next version. A round names the exact
// manifest it plays (contracts.js gameId), so an update never changes a round already written.
//
// WHO SIGNS (the owner 2026-10-07 15:40): the game developer's dev client (blwp-donor/src/manifest-sign.js), never a node -
// a node only verifies, through `manifestStands`.
//
// NO CURVE, as everywhere in this package: `verify(signature, digest, key)` is injected (Ed25519, the scheme the
// donation authority signs with), and a manifest with no verifier to check it is not a game.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { PROTOCOL_VERSION, TYPE_GAME_MANIFEST, TAG } from './constants.js';
import { ROUND_PERIOD_MS } from './series.js';

/** What a game's result is. Arena v1 has one: a replayed run (§0A.7); ATTESTED is a later revision (#206). */
export const RESULT_TYPE = Object.freeze({ REPLAY: 1 });
/** The engine's payout rules a manifest may pick (§0A.5). Arena v1 has one: §18A's rank curve. */
export const PAYOUT_RULE = Object.freeze({ RANK_CURVE: 1 });

export const MANIFEST_SIGNATURE_BYTES = 64;
export const NO_PARENT = new Uint8Array(32);

const is32 = (b) => b instanceof Uint8Array && b.length === 32;
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const isZero = (b) => b.every((x) => x === 0);
const compare32 = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const nameOf = (v, r) => Object.keys(r).find((k) => r[k] === v);

/**
 * THE BYTES THE DEVELOPER SIGNS. Cores in hash order, each core's configs in hash order, clients in hash order: the
 * encoder asserts the order rather than sorting, so a manifest has one encoding.
 */
export function encodeManifestBody(m) {
  if (typeof m.gameName !== 'string' || m.gameName.length < 1 || m.gameName.length > 64) throw new Error('a game names itself in 1 to 64 characters');
  if (!is32(m.gameDevPubkey)) throw new Error('a game names a 32-byte developer key');
  if (!Number.isInteger(m.version) || m.version < 1) throw new Error('a manifest version is 1 or more');
  if (!is32(m.parentManifestId)) throw new Error('a manifest names a 32-byte parent (zeros for the first)');
  if (!nameOf(m.resultType, RESULT_TYPE)) throw new Error(`result type ${m.resultType} is not one this engine has (REPLAY)`);
  if (!Array.isArray(m.cores) || m.cores.length < 1) throw new Error('a game names at least one core');
  for (const c of m.cores) {
    if (!is32(c.hash)) throw new Error('a core is named by its 32-byte hash');
    if (!Array.isArray(c.configs) || c.configs.length < 1 || !c.configs.every(is32)) throw new Error(`core ${toHex(c.hash).slice(0, 16)} names no 32-byte config`);
  }
  if (!Number.isInteger(m.runTicksMax) || m.runTicksMax < 1 || m.runTicksMax > 65535) throw new Error('run_ticks_max is 1 to 65535 ticks (a contract\'s blockTicks is a u16)');
  if (typeof m.roundPeriodMs !== 'bigint') throw new Error('round_period is a BigInt of milliseconds');
  if (!nameOf(m.payoutRule, PAYOUT_RULE)) throw new Error(`payout rule ${m.payoutRule} is not one of the engine's (§0A.5)`);
  if (!Number.isInteger(m.rankNumerator) || !Number.isInteger(m.rankDenominator) || m.rankDenominator < 1
      || m.rankNumerator < 1 || m.rankNumerator >= m.rankDenominator || m.rankDenominator > 255)
    throw new Error('the rank curve is a numerator below its denominator, both 1 to 255');
  if (!Number.isInteger(m.minScore) || m.minScore < 0) throw new Error('min_score is a whole number of score units');
  if (!Array.isArray(m.clients) || !m.clients.every(is32)) throw new Error('a client is named by its 32-byte hash');
  if (!is32(m.gameDonationSetId)) throw new Error('a game names its donation set by its 32-byte id');

  const w = new Writer();
  w.u8(TYPE_GAME_MANIFEST);
  w.u16(PROTOCOL_VERSION);
  w.str(m.gameName);
  w.bytes32(m.gameDevPubkey);
  w.u32(m.version);
  w.bytes32(m.parentManifestId);
  w.u8(m.resultType);
  w.vec(m.cores, (c, ww) => { ww.bytes32(c.hash); ww.vec(c.configs, (h, w3) => w3.bytes32(h), { sortedBy: compare32 }); },
    { sortedBy: (a, b) => compare32(a.hash, b.hash) });
  w.u16(m.runTicksMax);
  w.u64(m.roundPeriodMs);
  w.u8(m.payoutRule);
  w.u8(m.rankNumerator);
  w.u8(m.rankDenominator);
  w.u32(m.minScore);
  w.vec(m.clients, (h, ww) => ww.bytes32(h), { sortedBy: compare32 });
  w.bytes32(m.gameDonationSetId);
  return w.finish();
}

function readBody(r) {
  if (r.u8() !== TYPE_GAME_MANIFEST) throw new Error('not a game manifest');
  const version = r.u16();
  if (version !== PROTOCOL_VERSION) throw new Error(`protocol version ${version}, this build speaks ${PROTOCOL_VERSION}`);
  return {
    gameName: r.str(),
    gameDevPubkey: r.bytes32(),
    version: r.u32(),
    parentManifestId: r.bytes32(),
    resultType: r.u8(),
    cores: r.vec((rr) => ({ hash: rr.bytes32(), configs: rr.vec((r3) => r3.bytes32()) })),
    runTicksMax: r.u16(),
    roundPeriodMs: r.u64(),
    payoutRule: r.u8(),
    rankNumerator: r.u8(),
    rankDenominator: r.u8(),
    minScore: r.u32(),
    clients: r.vec((rr) => rr.bytes32()),
    gameDonationSetId: r.bytes32(),
  };
}

/** The digest the developer's key signs. */
export const manifestBodyId = (m) => taggedHash(TAG.gameManifestBody, encodeManifestBody(m));

/** The manifest on the wire: its body, then the 64-byte signature. */
export function encodeManifest(m) {
  if (!(m.signature instanceof Uint8Array) || m.signature.length !== MANIFEST_SIGNATURE_BYTES)
    throw new Error(`a manifest carries its ${MANIFEST_SIGNATURE_BYTES}-byte signature`);
  const body = encodeManifestBody(m);
  const out = new Uint8Array(body.length + MANIFEST_SIGNATURE_BYTES);
  out.set(body, 0); out.set(m.signature, body.length);
  return out;
}

export function decodeManifest(bytes) {
  const r = new Reader(bytes);
  const m = readBody(r);
  m.signature = r.bytes(MANIFEST_SIGNATURE_BYTES);
  r.end();
  encodeManifestBody(m);                                    // bytes from anywhere are held to the encoder's rules
  return m;
}

/** game_id = H(GameManifest): the body and its signature. */
export const gameIdOf = (m) => taggedHash(TAG.gameManifest, encodeManifest(m));

/**
 * IS THIS A GAME (§0A.3)? Its encoding stands, its developer's key signed its body, and its parent rule holds: the first
 * manifest (version 1) names no parent; an update names one, and that parent is a manifest of the SAME key one version
 * below. `parentOf(id)` hands back a manifest this node holds by id, or nothing - a parent it cannot see is refused,
 * since nothing then says the update is the developer's. Answers, never throws: a manifest that is not a game is an
 * ordinary refusal, by name.
 */
export function manifestStands(m, { verify, parentOf = () => null } = {}) {
  let digest, id;
  try { digest = manifestBodyId(m); id = gameIdOf(m); }
  catch (e) { return { ok: false, why: `that manifest does not encode: ${e.message}` }; }
  const name = `game "${m.gameName}" ${toHex(id).slice(0, 16)}`;
  if (typeof verify !== 'function') return { ok: false, why: `${name}: no verifier to check its developer's signature` };
  let signed = false;
  try { signed = verify(m.signature, digest, m.gameDevPubkey) === true; } catch { signed = false; }
  if (!signed) return { ok: false, why: `${name}: its signature is not its developer key ${toHex(m.gameDevPubkey).slice(0, 16)}'s` };
  if (m.version === 1) {
    if (!isZero(m.parentManifestId)) return { ok: false, why: `${name}: version 1 names a parent; the first manifest of a game has none` };
    return { ok: true, gameId: id, why: `${name} v1, signed by ${toHex(m.gameDevPubkey).slice(0, 16)}` };
  }
  if (isZero(m.parentManifestId)) return { ok: false, why: `${name}: version ${m.version} names no parent; an update names the manifest it replaces` };
  const parent = parentOf(m.parentManifestId);
  if (!parent) return { ok: false, why: `${name}: its parent ${toHex(m.parentManifestId).slice(0, 16)} is not a manifest this node holds` };
  if (!same(parent.gameDevPubkey, m.gameDevPubkey))
    return { ok: false, why: `${name}: its parent is a manifest of another developer key - not a game (§0A.3)` };
  if (parent.version + 1 !== m.version)
    return { ok: false, why: `${name}: version ${m.version} after a parent of version ${parent.version}` };
  return { ok: true, gameId: id, why: `${name} v${m.version}, an update of ${toHex(m.parentManifestId).slice(0, 16)} by the same key` };
}

/**
 * MAY THIS ROUND BE PLAYED UNDER THIS MANIFEST (§0A.3, §0A.5; #202): it names the manifest's game, a core the manifest
 * lists, a config the manifest lists for that core, a run no longer than run_ticks_max, the manifest's rank curve, and a
 * min_score no lower than the manifest's (the game's floor; a round may ask more of its runs, never less).
 */
export function roundFitsManifest(contract, m, gameId = gameIdOf(m)) {
  const name = `game "${m.gameName}"`;
  if (!contract || !is32(contract.gameId)) return { ok: false, why: 'that round names no 32-byte game' };
  if (!same(contract.gameId, gameId)) return { ok: false, why: `that round names game ${toHex(contract.gameId).slice(0, 16)}, not ${name} ${toHex(gameId).slice(0, 16)}` };
  if (!is32(contract.simCoreHash)) return { ok: false, why: 'that round names no 32-byte core' };
  const core = m.cores.find((c) => same(c.hash, contract.simCoreHash));
  if (!core) return { ok: false, why: `${name} lists no core ${toHex(contract.simCoreHash).slice(0, 16)}` };
  if (!is32(contract.configHash) || !core.configs.some((h) => same(h, contract.configHash)))
    return { ok: false, why: `${name} lists no config ${is32(contract.configHash) ? toHex(contract.configHash).slice(0, 16) : '(none)'} for core ${toHex(core.hash).slice(0, 16)}` };
  if (!Number.isInteger(contract.blockTicks) || contract.blockTicks < 1 || contract.blockTicks > m.runTicksMax)
    return { ok: false, why: `that round's run is ${contract.blockTicks} ticks; ${name} runs at most ${m.runTicksMax}` };
  if (m.payoutRule !== PAYOUT_RULE.RANK_CURVE) return { ok: false, why: `${name} picks payout rule ${m.payoutRule}, which is not the engine's` };
  if (contract.rankNumerator !== m.rankNumerator || contract.rankDenominator !== m.rankDenominator)
    return { ok: false, why: `that round's rank curve is ${contract.rankNumerator}/${contract.rankDenominator}; ${name} pays ${m.rankNumerator}/${m.rankDenominator}` };
  if (!Number.isInteger(contract.minScore) || contract.minScore < m.minScore)
    return { ok: false, why: `that round's min_score ${contract.minScore} is below ${name}'s ${m.minScore}` };
  // A ROUND OF A SERIES runs on the series' grid, and the game's round_period must be that grid (or 0: it asks none)
  if (contract.seriesId !== undefined && contract.seriesId !== null) {
    const period = seriesPeriodFits(m);
    if (!period.ok) return period;
  }
  return { ok: true };
}

/**
 * MAY THIS GAME RUN ON A SERIES OF `periodMs` (§0A.3 round_period; kanban #202)? Every series of this network runs on
 * the one 90 s grid (series.js ROUND_PERIOD_MS), so a game whose manifest names another period has no series here; one
 * naming 0 asks no period and runs on any.
 */
export function seriesPeriodFits(m, periodMs = ROUND_PERIOD_MS) {
  if (m.roundPeriodMs === 0n || m.roundPeriodMs === BigInt(periodMs)) return { ok: true };
  return { ok: false, why: `game "${m.gameName}" runs every ${m.roundPeriodMs} ms, and this network's series run every ${periodMs} ms` };
}
