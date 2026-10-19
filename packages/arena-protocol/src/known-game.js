// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PAYING ROUND PLAYS A GAME THIS CLIENT KNOWS, ON A CORE AND CONFIG THAT GAME LISTS, OR IT IS REFUSED (§5, §0A.6;
//).
//
// Section 5 (v4.6): "The sim_wasm_hash is chosen by the round creator, so the client must not accept it blindly. For
// real-money rounds the client MUST verify the hash against its known-good list of reproducibly built core versions,
// and MUST refuse ... for unknown hashes." Since games are plugins the list is per game: a round names its game
// (game_id, §0A.3), and a core is known only as a core of the game the round names, under a config that game lists for
// it. This client refuses. There is no override: no flag, no query parameter, nothing that lets an unknown game through.
// (§0A.6's confirmed stake on an unlisted game, shown with its developer key and manifest id, is the lobby's,.)
//
// F2's second clause rests on it (FEDERATION.md): the player's key is theirs only if the code that decides the round is
// code they can know.
import { toHex, taggedHash } from './hash.js';
import { KNOWN_GOOD_GAMES } from './known-games.js';
import { speaksVersion, TAG } from './constants.js';
import { protocolVersionName } from './protocol-version.js';

const isGameBytes32 = (b) => b instanceof Uint8Array && b.length === 32;

/** The configs (hex) the round's game shares one world under, as this client knows the game - none for a game it does not. */
export function sharedWorldOf(gameId) {
  const game = isGameBytes32(gameId) ? KNOWN_GOOD_GAMES[toHex(gameId)] : null;
  return game && Array.isArray(game.sharedWorld) ? [...game.sharedWorld] : [];
}

/** The id of the game dev's donation set its manifest names (§0A.8), as this client knows the game - or null. */
export function gameDonationSetIdOf(gameId) {
  const game = isGameBytes32(gameId) ? KNOWN_GOOD_GAMES[toHex(gameId)] : null;
  return game && typeof game.gameDonationSetId === 'string' ? game.gameDonationSetId : null;
}

/**
 * THE MARKET THIS CLIENT PINS FOR A GAME (§0A.7a): an attested game's outcomes, attestor keys (hex),
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
export function gameIsKnownGood(gameId, simCoreHash, configHash, { networkId = null, confirmed = null, protocolVersion } = {}) {
  if (!isGameBytes32(gameId)) return { ok: false, why: 'that round names no 32-byte game, so nothing says which game decides it' };
  const game = KNOWN_GOOD_GAMES[toHex(gameId)];
  // THE VERSION THE GAME REQUIRES (manifest.js REQUIRED_VERSION_MARKER): this build must speak it, and the
  // round must run it or a later one. A pinned game that requires none passes as before.
  if (game && game.requiredProtocolVersion) {
    if (!speaksVersion(game.requiredProtocolVersion))
      return { ok: false, why: `${game.name} requires protocol version ${protocolVersionName(game.requiredProtocolVersion)}, which this client does not speak: update the page` };
    if (!(Number.isInteger(protocolVersion) && protocolVersion >= game.requiredProtocolVersion))
      return { ok: false, why: `${game.name} requires protocol version ${protocolVersionName(game.requiredProtocolVersion)}; that round runs ${Number.isInteger(protocolVersion) ? protocolVersionName(protocolVersion) : 'none'}` };
  }
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

/**
 * THE NODE FEE AND DONATION A PINNED GAME CHARGES: a market's own (its manifest's terms), else the market default
 * 0.5 % + 0.5 % (2026-10-09), else a game's network 5 % and the player's donation choice (null). null for a game this
 * client does not pin - the caller then knows its rate another way (an unpinned market the player confirmed: its manifest).
 */
export function feeOfKnownGame(gameId) {
  const game = isGameBytes32(gameId) ? KNOWN_GOOD_GAMES[toHex(gameId)] : null;
  if (!game) return null;
  if (game.fee) return { nodeBps: game.fee.nodeBps, donationBps: game.fee.donationBps, reserveBps: game.fee.reserveBps || 0 };   // the reserve inside the donation
  return game.attested ? { nodeBps: 50, donationBps: 50 } : { nodeBps: 500, donationBps: null };
}

/**
 * A PINNED MARKET'S TERMS: its resolution delay and void deadline as the generator wrote them (decimal ms), the
 * ones its rounds' lock span is checked by on the page (lock-expiry.js); null for a game, or a market pinned without terms.
 */
export function termsOfKnownGame(gameId) {
  const game = isGameBytes32(gameId) ? KNOWN_GOOD_GAMES[toHex(gameId)] : null;
  if (!game || !game.terms) return null;
  return { resolveAfterCloseMs: BigInt(game.terms.resolveAfterCloseMs), deadlineAfterResolveMs: BigInt(game.terms.deadlineAfterResolveMs) };
}

/**
 * A TABLE'S ANCHOR (2026-10-13 pick (c): "A waiting player gets one committee and one key for that table, then
 * 8-second rounds on that key until the table is empty"). For a round of a game whose known entry says `seatsPerTable` - a v2 round of
 * a grid series, one series being one table - the round the table is drawn and seated by: its series' round 0. Every round of the
 * table draws its committee on that round's id (beacon.js committeeSeedFromBeacon) and takes that round's seating certificate, so
 * all of them name one committee and one claim key (the seats' DKG is per committee). null for every other round: it draws and seats
 * itself, as before.
 */
export function tableAnchorOf(contract) {
  if (!contract || !(contract.seriesId instanceof Uint8Array) || !Number.isInteger(contract.roundIndex)) return null;
  if (!(Number.isInteger(contract.protocolVersion) && contract.protocolVersion >= 2)) return null;
  const known = KNOWN_GOOD_GAMES[toHex(contract.gameId)];
  if (!known || known.seatsPerTable !== true) return null;
  const body = new Uint8Array(36); body.set(contract.seriesId, 0);      // round 0's id: H(series_id || 0), as contracts.js roundId
  return { anchorId: taggedHash(TAG.seriesRound, body), first: contract.roundIndex === 0 };
}
