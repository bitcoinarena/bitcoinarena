// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GAMES FIRST, THEN THE GAME'S CLIENT (2026-10-06: "the lobby lists the games the reachable nodes
// host, then that game's rounds; the page loads the plugin's client by the manifest's hash; one wallet and one seed across
// games").
//
// - `fetchGames` asks every named node GET /games and keeps a game only when the manifest a node served hashes to the game
//   id it named (game_id = H(GameManifest), §0A.3) - a node names games, it never vouches for one. A game the page pins in
//   its known-games list is `known`; any other is shown with its developer key and needs the second confirmation (§0A.6).
// - `gameClientFile` fetches one file of a game's client and hands its bytes back only if their SHA-256 is one of the
//   manifest's clients[] - the same hashes the repo's client list pins and client-hash.mjs checks from outside the page. A
//   file the manifest does not name is never run. The page then runs it in the same origin, so the wallet and the seed
//   (sessionStorage / localStorage) are the one the player already has.
import { gameInfoDigest } from '../../arena-protocol/src/game-info.js';
import { decodeManifest, gameIdOf, isAttested, manifestBodyId } from '../../arena-protocol/src/manifest.js';
import { KNOWN_GOOD_GAMES } from '../../arena-protocol/src/known-games.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const GAMES_ANSWER_MS = 6000;
// ONE SEAT'S ANSWER IS BOUNDED (kanban #2558, audit #1489 r13: one seat listing 2000 made-up manifests cost one games read 2001
// developer-signature checks and 2002 refusals, and - signed under its own throwaway key - would have filled the lobby with tiles):
// at most this many of a seat's games are decoded and checked, the pinned known-good ids first. An honest seat lists every VERSION it
// still hosts: 41 on 2026-11-14 (24 btc-updown-15m, 10 rock-paper-scissors, 7 nextblock) - at 32 the newest versions were cut, and Rock
// Paper Scissors and Up or Down "cannot be loaded" on the live page (feedback #064/#065/#068): their client hashes are named only by
// v6+ / the newest. 256 keeps a flood at a bounded cost (256 signature checks a seat, against 2000) and room for many more versions.
export const GAMES_PER_SEAT = 256;

// ITS DEVELOPER SIGNED IT (kanban #1810): the signature over the manifest body's id (manifest.js manifestStands' first rule), by
// the developer key the manifest names. The client carries no crypto library (the bundle is its own source, nothing from npm): the
// check is the platform's Ed25519 (WebCrypto, as the page's pageEd25519Verify and Node's), or a `verify(sig, msg, key)` handed in
// (sync or async). Each game id is checked once per call, however many seats list it.
const webCryptoEd25519Verify = async (sig, msg, key) => {
  try {
    const k = await globalThis.crypto.subtle.importKey('raw', key, { name: 'Ed25519' }, false, ['verify']);
    return (await globalThis.crypto.subtle.verify({ name: 'Ed25519' }, k, sig, msg)) === true;
  } catch { return false; }
};
const developerSigned = async (m, verify) => { try { return (await verify(m.signature, manifestBodyId(m), m.gameDevPubkey)) === true; } catch { return false; } };

/**
 * THE GAMES THE NAMED NODES HOST: [{ id, name, title, icon, attested, known, manifest, manifestHex, nodes }], the pinned
 * games first, then by how many nodes host each; and the nodes that did not answer or served something that is not a game.
 */
export async function fetchGames({ nodes, fetcher = fetch, answerMs = GAMES_ANSWER_MS, verify = webCryptoEd25519Verify } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) throw new Error('the games are asked of the nodes a lobby was named, and it was named none');
  const unique = [...new Set(nodes.map((n) => String(n).replace(/\/+$/, '')))];
  const byId = new Map();
  const refused = [];
  const signedById = new Map();   // game id -> its developer signed it (kanban #1810), checked once
  // the addresses that answered a list - by address, not by the node key a node says it has: that key is signed by nobody, and
  // a node naming another's key would push the other's title out of the count below (kanban #2033)
  const answered = new Set();
  const answers = await Promise.all(unique.map((node) => fetcher(`${node}/games`, { signal: AbortSignal.timeout(answerMs) })
    .then(async (r) => ({ r, body: r.ok ? await r.json() : null }), (e) => ({ e }))));
  for (const [k, node] of unique.entries()) {
    const { r, body, e } = answers[k];
    if (e) { refused.push(`${node}: ${e.message}`); continue; }
    if (!r.ok) { refused.push(`${node}: answered ${r.status}`); continue; }
    answered.add(node);
    const listed = (body && Array.isArray(body.games)) ? body.games : [];
    const isKnown = (g) => Object.prototype.hasOwnProperty.call(KNOWN_GOOD_GAMES, String(g && g.id).toLowerCase());
    const read = [...listed.filter(isKnown), ...listed.filter((g) => !isKnown(g))].slice(0, GAMES_PER_SEAT);
    if (listed.length > GAMES_PER_SEAT) refused.push(`${node}: listed ${listed.length} games, only ${GAMES_PER_SEAT} are read (kanban #2558)`);
    for (const g of read) {
      const id = String(g && g.id).toLowerCase();
      let manifest;
      try { manifest = decodeManifest(fromHex(String(g.manifest))); } catch (err) { refused.push(`${node}: game ${id.slice(0, 16)}: ${err.message}`); continue; }
      if (toHex(gameIdOf(manifest)) !== id) { refused.push(`${node}: game ${id.slice(0, 16)}: its manifest is another game`); continue; }
      // A MANIFEST ITS DEVELOPER DID NOT SIGN IS NOT A GAME (kanban #1810: one seat listed nextblock's manifest as version + 1 with a
      // zero signature, under the id that copy hashes to, and oneTilePerGame - newest version of "developer key:name" - gave it the
      // nextblock tile on every page, a game id no honest seat hosts): the hash only says the seat served those bytes, the signature
      // says the developer made them
      if (!signedById.has(id)) signedById.set(id, await developerSigned(manifest, verify));
      if (!signedById.get(id)) { refused.push(`${node}: game ${id.slice(0, 16)}: its signature is not its developer key ${toHex(manifest.gameDevPubkey).slice(0, 16)}'s`); continue; }
      if (!byId.has(id)) {
        // the title and icon are settled below, from what the answering nodes agree on (kanban #2033), never from one node
        byId.set(id, { id, name: manifest.gameName, title: manifest.gameName, icon: null, attested: isAttested(manifest),
          known: Object.prototype.hasOwnProperty.call(KNOWN_GOOD_GAMES, id), devKey: toHex(manifest.gameDevPubkey),
          manifest, manifestHex: String(g.manifest).toLowerCase(), nodes: [],
          // ITS SIGNED DESCRIPTION, AS HANDED: checked against the developer key by checkedGameInfo, never taken
          info: g.info && typeof g.info === 'object' ? g.info : null,
          // WHO PLAYS IT NOW: the highest any seat says - the seats of a committee hold the same entries, so a sum would count
          // each player once per seat
          live: { rounds: 0, players: 0 } });
      }
      const got = byId.get(id);
      if (!got.named) Object.defineProperty(got, 'named', { value: [], enumerable: false });
      if (!got.named.some((n) => n.node === node)) got.named.push({ node, title: typeof g.title === 'string' && g.title ? g.title : null, icon: typeof g.icon === 'string' && g.icon ? g.icon : null });
      // ONE NODE, COUNTED ONCE (2026-10-14 07:42Z, a phone off the tailnet: "28 nodes" for 14): a seat reached at two
      // addresses (its Funnel name and its named tunnel) answers both with the same node key; it hosts the game once
      const key = body && /^[0-9a-f]{64}$/i.test(String(body.node)) ? String(body.node).toLowerCase() : node;
      if (!got.nodeKeys) Object.defineProperty(got, 'nodeKeys', { value: new Set(), enumerable: false });
      if (got.nodeKeys.has(key)) continue;
      got.nodeKeys.add(key);
      got.nodes.push(node);
      if (!got.info && g.info && typeof g.info === 'object') got.info = g.info;
      if (g.live && typeof g.live === 'object') {
        got.live.rounds = Math.max(got.live.rounds, Number(g.live.rounds) || 0);
        got.live.players = Math.max(got.live.players, Number(g.live.players) || 0);
      }
    }
  }
  // A GAME'S TITLE AND ICON ARE SIGNED BY NOBODY (kanban #2033, after #1716, #1902, #1541, #1489): the manifest signs only its
  // gameName. One seat in the lobby's node list could list the genuine, pinned Next Block as "Refunds: send sats to evil.example"
  // for every player, so a node's title or icon stands only when more than half of the addresses that answered a list name it
  // byte-identical; otherwise the tile shows the manifest's signed gameName and no icon. The icon is loaded from the first
  // node, in the lobby's order, that named the agreed one.
  const agreed = (named, pick) => {
    const count = new Map();
    for (const n of named) { const v = pick(n); if (v !== null) count.set(v, (count.get(v) || 0) + 1); }
    for (const [v, c] of count) if (c * 2 > answered.size) return v;
    return null;
  };
  for (const got of byId.values()) {
    const named = got.named || [];
    const title = agreed(named, (n) => n.title);
    if (title !== null) got.title = title;
    const icon = agreed(named, (n) => n.icon);
    if (icon !== null) { const from = named.find((n) => n.icon === icon).node; got.icon = `${from}/${icon.replace(/^\/+/, '')}`; }
  }
  const games = [...byId.values()].sort((a, b) => (Number(b.known) - Number(a.known)) || (b.nodes.length - a.nodes.length) || (a.name < b.name ? -1 : 1));
  return { games, refused };
}

/**
 * ONE TILE PER GAME, NOT PER VERSION (measured on the v2 page: each game showed twice - its 2026.0.1 manifest
 * and its 2026.0.2 update, the second "No signed description."). Versions of one game share its developer key and name (an
 * update is a new manifest under the same key, §5). Of each, the newest, always (2026-10-26 08:4xZ, the owner: "Version 24 is the newest
 * btc up or down, why is version 13 open? We should always play the newest version" - an older version's live round no longer takes
 * the tile, kanban #685).
 * The others are kept on the tile as `versions` (newest first), so a link naming an older version's id still finds it.
 */
export function oneTilePerGame(games) {
  const groups = new Map();
  for (const g of games || []) {
    const key = `${g.devKey}:${g.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }
  const out = [];
  for (const versions of groups.values()) {
    versions.sort((a, b) => ((b.manifest && b.manifest.version) || 0) - ((a.manifest && a.manifest.version) || 0));
    const shown = versions[0];
    // `older`: the other versions, each with its own info - a description its developer signed for that version's id, which
    // the tile shows while the shown version carries none that stands (checkedGameInfoOfTile)
    // WHAT THE LOBBY LISTS, THE TILE COUNTS (2026-10-31: "keine Runden fuer next block", while the seats held v6's rounds and hosted v7
    // with none): Next Block's lobby shows every version's rounds (ARENA_GAME_IDS), so its tile adds them up.
    // ROCK PAPER SCISSORS THE SAME (Daniel 2026-11-12 ~06:50Z "Es wird keine rps runde angezeigt": RPS v10 was hosted before any v10 table
    // was posted, its lobby read every version - index.html everyVersion - but the tile counted v10 alone: "14 | 0 | 0" beside 44 open v9 rounds)
    const live = (shown.name === 'nextblock' || shown.name === 'rock-paper-scissors') && shown.live ? { live: versions.reduce((n, g) => ({ rounds: n.rounds + (Number(g.live && g.live.rounds) || 0), players: n.players + (Number(g.live && g.live.players) || 0) }), { rounds: 0, players: 0 }) } : {};
    out.push(Object.assign({}, shown, live, { versions: versions.map((g) => g.id), older: versions.filter((g) => g !== shown) }));
  }
  return out;
}

/** The lobby's rows of one game (each row carries its contract's game id as `game`). */
export const rowsOfGame = (rows, gameIdHex) => (rows || []).filter((r) => String(r && r.game).toLowerCase() === String(gameIdHex).toLowerCase());

/**
 * ONE FILE OF A GAME'S CLIENT, BY THE MANIFEST'S HASH: its bytes and hash, or a refusal naming the file. `digest(bytes)`
 * is SHA-256, injected (WebCrypto in the page, node:crypto in a test).
 */
export async function gameClientFile({ game, url, digest, fetcher = fetch }) {
  if (!game || !game.manifest) throw new Error('a client is loaded for a game whose manifest is held');
  if (typeof digest !== 'function') throw new Error('a client file is checked against its hash, and no digest was injected');
  // EVERY VERSION OF THE GAME ON ITS TILE: a version is a new manifest under the same developer key and name
  // (oneTilePerGame groups only those), so a client file any of them pins is the developer's; the tile may show version 2
  // while the page holds version 3's newer file
  const pinned = new Set([game, ...(Array.isArray(game.older) ? game.older : [])]
    .filter((g) => g && g.manifest && (g === game || (g.name === game.name && toHex(g.manifest.gameDevPubkey || new Uint8Array()) === toHex(game.manifest.gameDevPubkey || new Uint8Array()))))
    .flatMap((g) => (g.manifest.clients || []).map((h) => toHex(h))));
  if (!pinned.size) return { ok: false, why: `${game.name}'s manifest names no client` };
  let r;
  try { r = await fetcher(url, { cache: 'no-store' }); } catch (e) { return { ok: false, why: `${url}: ${e.message}` }; }
  if (!r.ok) return { ok: false, why: `${url}: answered ${r.status}` };
  const bytes = new Uint8Array(await r.arrayBuffer());
  const hash = toHex(new Uint8Array(await digest(bytes)));
  if (!pinned.has(hash)) return { ok: false, why: `${url} hashes to ${hash.slice(0, 16)}, which ${game.name}'s manifest does not name: not run` };
  return { ok: true, bytes, hash };
}

/**
 * A GAME'S SIGNED DESCRIPTION AND WEBSITE (game-info.js): kept only when the manifest's developer key signed
 * them - `verifyEd25519(sig, msg, pub)` may be async (the browser's). Anything else answers null and is not shown.
 */
export async function checkedGameInfo(game, verifyEd25519) {
  const info = game && game.info;
  if (!info || typeof info.description !== 'string' || typeof verifyEd25519 !== 'function') return null;
  let digest, sig;
  try { digest = gameInfoDigest(fromHex(game.id), info); sig = fromHex(String(info.signature || '')); } catch { return null; }
  let good = false;
  try { good = (await verifyEd25519(sig, digest, game.manifest.gameDevPubkey)) === true; } catch { good = false; }
  return good ? { description: info.description, website: typeof info.website === 'string' && info.website ? info.website : null,
    lightning: typeof info.lightning === 'string' && info.lightning ? info.lightning : null } : null;
}

/**
 * A TILE'S DESCRIPTION: its own version's, else the newest other version's that its developer signed - each
 * checked against that version's own id; a tile groups only one developer key's versions (oneTilePerGame).
 */
export async function checkedGameInfoOfTile(tile, verifyEd25519) {
  for (const g of [tile, ...((tile && tile.older) || [])]) {
    const info = await checkedGameInfo(g, verifyEd25519);
    if (info) return info;
  }
  return null;
}
