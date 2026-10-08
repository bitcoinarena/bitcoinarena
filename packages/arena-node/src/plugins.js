// THE GAMES THIS NODE HOSTS, AND THE CORE A ROUND IS REPLAYED BY (kanban #202, §0A.2-0A.6; M3; the owner 2026-09-15 08:03:
// "the truck game is one use of the federated consensus network, not the network"; 2026-10-06: the engine is Bitcoin
// Arena, a game is a plugin).
//
// The one door between the engine and any game. A game is handed to serve() by the node's launcher as a registration
// - { name, manifest, gameId, cores } (core/plugin/nextblock.js is nextblock's) - and lands here, in a map by game_id,
// only if its manifest is a game (arena-protocol/src/manifest.js manifestStands: its developer's signature, its parent rule)
// and every core the node installed for it is one the manifest lists, with configs the manifest lists. A round is then
// played only on a game this node hosts, on a core it installed for that game, under a config it installed, and only if
// the round fits the manifest (run length, rank curve, min_score). Nothing here imports a game: `replay.js` drives the
// adapter it is handed (start, eventsOf, step, stateHash, result, picture, runTicksFits).
import { toHex } from '../../arena-protocol/src/hash.js';
import { manifestStands, roundFitsManifest, isAttested } from '../../arena-protocol/src/manifest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { verifyEd25519 } from './ed25519.js';

/**
 * THE GAMES A NODE HOSTS, by game_id (hex): the registrations its launcher handed it, each checked here once - a
 * manifest that is not a game, or a core or config installed for it that its manifest does not list, is refused with
 * the reason, and the node does not start on it. A map already made by this function is handed back as it is. None
 * given hosts none (§0A.4: nothing is implied; the reference launcher hands nextblock).
 */
export function hostedPlugins(registrations = [], { verify = verifyEd25519 } = {}) {
  if (registrations instanceof Map) return registrations;
  const byId = new Map(registrations.map((p) => { try { return [toHex(p.gameId), p.manifest]; } catch { return [null, null]; } }));
  const out = new Map();
  for (const p of registrations) {
    if (!p || !p.manifest || !(p.cores instanceof Map)) throw new Error('a game is handed to a node as { name, manifest, gameId, cores }');
    const stands = manifestStands(p.manifest, { verify, parentOf: (id) => byId.get(toHex(id)) || null });
    if (!stands.ok) throw new Error(`that game is not one this node can host: ${stands.why}`);
    const id = toHex(stands.gameId);
    if (p.gameId !== undefined && toHex(p.gameId) !== id) throw new Error(`game "${p.manifest.gameName}" is registered as ${toHex(p.gameId).slice(0, 16)}, and its manifest is ${id.slice(0, 16)}`);
    // THE GAME DEV'S DONATION SET (§0A.8, kanban #205): the recipients its manifest names by id - a registration whose set
    // does not hash to the manifest's game_donation_set is refused, so no node pays a game dev a set its developer did not sign
    let gameSetId;
    try { gameSetId = toHex(donationSetId(p.donationSet)); }
    catch (e) { throw new Error(`game "${p.manifest.gameName}" is handed with no donation set that stands: ${e.message}`); }
    if (gameSetId !== toHex(p.manifest.gameDonationSetId))
      throw new Error(`game "${p.manifest.gameName}" is handed a donation set ${gameSetId.slice(0, 16)}, and its manifest names ${toHex(p.manifest.gameDonationSetId).slice(0, 16)}`);
    for (const [hash, core] of p.cores) {
      const listed = p.manifest.cores.find((c) => toHex(c.hash) === hash);
      if (!listed) throw new Error(`game "${p.manifest.gameName}": core ${hash.slice(0, 16)} is installed for it, and its manifest lists no such core`);
      for (const config of core.configs.keys())
        if (!listed.configs.some((h) => toHex(h) === config))
          throw new Error(`game "${p.manifest.gameName}": config ${config.slice(0, 16)} is installed on core ${hash.slice(0, 16)}, and its manifest lists no such config for it`);
    }
    // `replayPage`: the game's own replay page, when it has one (kanban #202) - the engine serves it, never draws a game
    // `sharedWorld`: the configs the game says make one world per round (a config's `worldShared`), which the engine's
    // seed asks of the round's game (kanban #203) instead of a list of its own
    const sharedWorld = [...new Set([...p.cores.values()].flatMap((c) => [...c.configs].filter(([, cfg]) => cfg && cfg.worldShared).map(([h]) => h)))];
    out.set(id, Object.freeze({ name: p.name || p.manifest.gameName, gameId: stands.gameId, manifest: p.manifest, cores: p.cores,
      replayPage: p.replayPage || null, sharedWorld: Object.freeze(sharedWorld),
      // the game's own check of the round fields only it reads (contracts.js contractWarnings appends it; kanban #203)
      roundWarnings: typeof p.roundWarnings === 'function' ? p.roundWarnings : null,
      // the game dev's donation set, checked above against the manifest
      donationSet: p.donationSet }));
  }
  return out;
}

/**
 * DOES THIS NODE'S ADVERTISEMENT NAME THE GAMES IT HOSTS (§0A.4, kanban #204, the owner 2026-10-07)? An advertised game this
 * node does not host would draw it into game/verify committees it cannot serve: refused, by name - the node does not
 * start. A hosted game the advertisement does not name only means the node is not drawn for it until an advertisement
 * update names it: said, not refused.
 */
export function advertisedGamesCheck(advert, plugins) {
  const hosted = new Set(plugins.keys());
  const advertised = (advert && Array.isArray(advert.hostedGames) ? advert.hostedGames : []).map(toHex);
  const notHosted = advertised.filter((g) => !hosted.has(g));
  const unadvertised = [...hosted].filter((g) => !advertised.includes(g)).map((g) => plugins.get(g).name);
  if (notHosted.length)
    return { ok: false, notHosted, unadvertised,
      why: `this node's advertisement names game${notHosted.length === 1 ? '' : 's'} ${notHosted.map((g) => g.slice(0, 16)).join(', ')} `
        + 'it does not host (ARENA_GAMES): it would be drawn to replay rounds it cannot play - post an advertisement update or host the game' };
  return { ok: true, unadvertised };
}

/** Every core a node installed, over all the games it hosts, by hash: what a stored round's replay page may be served from. */
export function installedCoresOf(plugins) {
  const all = new Map();
  for (const p of plugins.values()) for (const [hash, core] of p.cores) all.set(hash, core);
  return all;
}

/**
 * A CORE'S RUN LENGTH UNDER A CONFIG (M3 R1 R3): its `runTicks(config)` where it has one, else its one RUN_TICKS (the
 * truck's BLOCK_TICKS) - the length of a run whose round names none, and, since the 82/90 fork, the longest one may.
 */
export function runTicksOf(core, config) {
  const a = core && core.adapter;
  if (!a) return null;
  return typeof a.runTicks === 'function' ? a.runTicks(config) : a.RUN_TICKS;
}

/**
 * MAY A ROUND NAME THIS RUN LENGTH ON THIS CORE (the 82/90 fork, the owner 2026-10-01: "The round length must be part of
 * the contract - not a fixed constant")? A core held to one length (the truck before the fork) takes that one; a core
 * that takes the round's length takes any it says fits (1 .. RUN_TICKS for the truck).
 */
export function runLengthFits(core, config, blockTicks) {
  if (!core || !core.adapter) return { ok: false, why: 'no core to check that round\'s run length against' };
  if (!Number.isInteger(blockTicks)) return { ok: false, why: 'that round names no run length' };
  if (Number.isInteger(core.fixedRunTicks))
    return blockTicks === core.fixedRunTicks ? { ok: true }
      : { ok: false, why: `that round says a run is ${blockTicks} ticks and this core ends one at ${core.fixedRunTicks} (${core.name}) - a run is not replayed to a length its core does not stop at` };
  if (typeof core.adapter.runTicksFits !== 'function') {
    // A CORE OF ONE LENGTH UNDER ITS CONFIG (it takes none from the round): that length only.
    const own = runTicksOf(core, config);
    return blockTicks === own ? { ok: true }
      : { ok: false, why: `that round says a run is ${blockTicks} ticks and this core ends one at ${own}` };
  }
  return core.adapter.runTicksFits(blockTicks) ? { ok: true }
    : { ok: false, why: `that round says a run is ${blockTicks} ticks, and ${core.name} runs 1 to ${runTicksOf(core, config)}` };
}

/**
 * THE GAME, CORE AND CONFIG A ROUND IS PLAYED WITH: the game its gameId names among the games this node hosts; the core
 * its simCoreHash names among the cores the node installed for that game; the config its configHash names among that
 * core's; and the round fits the game's manifest. Anything else is refused by name - 27A.7.5: not selectable for that
 * round, it serves nothing there, it is not ejected and not slashed.
 */
export function pluginForRound(contract, plugins) {
  if (!contract || !(contract.gameId instanceof Uint8Array) || contract.gameId.length !== 32)
    return { ok: false, why: 'that round names no 32-byte game (game_id, §0A.3)' };
  const plugin = plugins instanceof Map ? plugins.get(toHex(contract.gameId)) : undefined;
  if (!plugin)
    return { ok: false, why: `this node does not host game ${toHex(contract.gameId).slice(0, 16)}: it plays only the games it hosts `
      + '(§0A.4) - not selectable for that round, it serves nothing there, and is not slashed' };
  // AN ATTESTED GAME (§0A.7a, kanban #206): no core, no config, no run - the round's result is its attestors' signed
  // outcome. Answered with no core at all, so nothing downstream can replay it: a replay asked for such a round finds none.
  if (isAttested(plugin.manifest)) {
    const fits = roundFitsManifest(contract, plugin.manifest, plugin.gameId);
    if (!fits.ok) return { ok: false, why: fits.why };
    return { ok: true, plugin, attested: true, core: null, config: null, runTicks: null };
  }
  const runs = coreOfGame(contract, plugin);
  if (!runs.ok) return runs;
  // AND THE GAME'S OWN TERMS (§0A.3, §0A.5): a run no longer than its manifest allows, its rank curve, its min_score floor.
  const fits = roundFitsManifest(contract, plugin.manifest, plugin.gameId);
  if (!fits.ok) return { ok: false, why: fits.why };
  return { ok: true, plugin, ...runs };
}

/**
 * THE CORE AND CONFIG A ROUND NAMES, AMONG THOSE A NODE INSTALLED FOR ONE GAME (M3 R1): the core its simCoreHash names
 * and the config its configHash names on that core, or a refusal by name. `pluginForRound` asks it once the round's game
 * is found; it reads nothing of the manifest.
 */
export function coreOfGame(contract, plugin) {
  const installed = plugin.cores;
  if (!contract || !(contract.simCoreHash instanceof Uint8Array) || contract.simCoreHash.length !== 32)
    return { ok: false, why: 'that round names no 32-byte core' };
  const core = installed.get(toHex(contract.simCoreHash));
  if (!core)
    return { ok: false, why: `this signer node holds no core ${toHex(contract.simCoreHash).slice(0, 16)}: it is not selectable for `
      + 'that round (27A.7.5) - it serves nothing there, and is not slashed' };
  if (!(contract.configHash instanceof Uint8Array) || !core.configs.has(toHex(contract.configHash)))
    return { ok: false, why: `this signer node runs ${core.name} but not the config `
      + `${contract.configHash instanceof Uint8Array ? toHex(contract.configHash).slice(0, 16) : '(none)'} that round names: `
      + 'not selectable for it (27A.7.5)' };
  // A PAIR KEPT ONLY FOR THE ROUNDS ALREADY MADE WITH IT (de2f263d with the founding config): refused past its cut-over
  const config = core.configs.get(toHex(contract.configHash));
  if (config && config.committeeBeforeMs !== undefined
      && !(typeof contract.committeeTimeMs === 'bigint' && contract.committeeTimeMs < BigInt(config.committeeBeforeMs)))
    return { ok: false, why: `${core.name} runs the config ${toHex(contract.configHash).slice(0, 16)} only for rounds made before `
      + `${new Date(config.committeeBeforeMs).toISOString()}: a round on this core names the config of the rules it plays (27A.6)` };
  // AND THE ROUND'S RUN LENGTH (the 82/90 fork): its contract's blockTicks, carried with the core to every replay of it.
  return { ok: true, core, config, runTicks: contract.blockTicks };
}
