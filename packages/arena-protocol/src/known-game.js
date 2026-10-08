// A PAYING ROUND PLAYS A GAME THIS CLIENT KNOWS, ON A CORE AND CONFIG THAT GAME LISTS, OR IT IS REFUSED (§5, §0A.6;
// kanban #202).
//
// Section 5 (v4.6): "The sim_wasm_hash is chosen by the round creator, so the client must not accept it blindly. For
// real-money rounds the client MUST verify the hash against its known-good list of reproducibly built core versions,
// and MUST refuse ... for unknown hashes." Since games are plugins the list is per game: a round names its game
// (game_id, §0A.3), and a core is known only as a core of the game the round names, under a config that game lists for
// it. This client refuses. There is no override: no flag, no query parameter, nothing that lets an unknown game through.
// (§0A.6's confirmed stake on an unlisted game, shown with its developer key and manifest id, is the lobby's, #208.)
//
// F2's second clause rests on it (FEDERATION.md): the player's key is theirs only if the code that decides the round is
// code they can know.
import { toHex } from './hash.js';
import { KNOWN_GOOD_GAMES } from './known-games.js';

const isGameBytes32 = (b) => b instanceof Uint8Array && b.length === 32;

/** The configs (hex) the round's game shares one world under, as this client knows the game - none for a game it does not. */
export function sharedWorldOf(gameId) {
  const game = isGameBytes32(gameId) ? KNOWN_GOOD_GAMES[toHex(gameId)] : null;
  return game && Array.isArray(game.sharedWorld) ? [...game.sharedWorld] : [];
}

/** The id of the game dev's donation set its manifest names (§0A.8, kanban #205), as this client knows the game - or null. */
export function gameDonationSetIdOf(gameId) {
  const game = isGameBytes32(gameId) ? KNOWN_GOOD_GAMES[toHex(gameId)] : null;
  return game && typeof game.gameDonationSetId === 'string' ? game.gameDonationSetId : null;
}

/**
 * THE MARKET THIS CLIENT PINS FOR A GAME (§0A.7a, kanban #206 slice 2): an attested game's outcomes, attestor keys (hex),
 * threshold, developer key and the networks it is pinned for - or null for a game it does not pin, or one that is not attested.
 */
export function marketOf(gameId) {
  const game = isGameBytes32(gameId) ? KNOWN_GOOD_GAMES[toHex(gameId)] : null;
  return game && game.attested ? { gameId: toHex(gameId), name: game.name, known: true, ...game.attested } : null;
}

const isZero32 = (b) => isGameBytes32(b) && b.every((x) => x === 0);

// `networkId`: the round's network - a pinned market is good only on the networks it is pinned for. `confirmed`: game ids
// (hex) of ATTESTED games the player confirmed a second time on this page (§0A.6) - an unpinned market is let through only
// then, and only with no core and no config (there is nothing of it to run).
export function gameIsKnownGood(gameId, simCoreHash, configHash, { networkId = null, confirmed = null } = {}) {
  if (!isGameBytes32(gameId)) return { ok: false, why: 'that round names no 32-byte game, so nothing says which game decides it' };
  const game = KNOWN_GOOD_GAMES[toHex(gameId)];
  // A MARKET (§0A.7a): no core, no config; pinned for this network, or confirmed twice by the player
  if ((game && game.attested) || (!game && confirmed && confirmed.has && confirmed.has(toHex(gameId)))) {
    if (!isZero32(simCoreHash) || (configHash !== undefined && !isZero32(configHash)))
      return { ok: false, why: 'that round names a core or a config, and its game is a market: a market has nothing to run (§0A.7a)' };
    if (!game) return { ok: true, game: 'an unpinned market the player confirmed', confirmed: true };
    const nets = game.attested.networks || [];
    if (nets.length && !(networkId instanceof Uint8Array && nets.includes(toHex(networkId))))
      return { ok: false, why: `market ${game.name} is pinned only for network${nets.length === 1 ? '' : 's'} ${nets.map((n) => n.slice(0, 16)).join(', ')}: refused on this one` };
    return { ok: true, game: game.name, market: true };
  }
  if (!game)
    return { ok: false, why: `that round plays game ${toHex(gameId).slice(0, 16)}..., which is not on this client's known-good list `
      + 'of games: a paying round on an unknown game is refused (§5, §0A.6)' };
  if (!isGameBytes32(simCoreHash))
    return { ok: false, why: 'that round names no 32-byte core hash, so nothing says which simulation decides it' };
  const hex = toHex(simCoreHash);
  const configs = game.cores[hex];
  if (!configs)
    return { ok: false, why: `that round runs core ${hex.slice(0, 16)}..., which ${game.name}'s manifest does not list: `
      + 'a paying round on an unknown core is refused (§5)' };
  // AND THE CONFIG IT RUNS, when the caller names one (as coreIsKnownGood had it before games: a round always carries one)
  if (configHash === undefined) return { ok: true, game: game.name };
  if (!isGameBytes32(configHash))
    return { ok: false, why: 'that round names no 32-byte config hash, so nothing says which rules decide it' };
  if (!configs.includes(toHex(configHash)))
    return { ok: false, why: `that round runs core ${hex.slice(0, 16)}... under config ${toHex(configHash).slice(0, 16)}..., which is `
      + `not a config ${game.name} lists for that core: refused, as an unknown core is (§5, §27A.6)` };
  return { ok: true, game: game.name };
}
