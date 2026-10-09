// THE GAMES FIRST, THEN THE GAME'S CLIENT (kanban #208, the owner 2026-10-06: "the lobby lists the games the reachable nodes
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
import { decodeManifest, gameIdOf, isAttested } from '../../arena-protocol/src/manifest.js';
import { KNOWN_GOOD_GAMES } from '../../arena-protocol/src/known-games.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const GAMES_ANSWER_MS = 6000;

/**
 * THE GAMES THE NAMED NODES HOST: [{ id, name, title, icon, attested, known, manifest, manifestHex, nodes }], the pinned
 * games first, then by how many nodes host each; and the nodes that did not answer or served something that is not a game.
 */
export async function fetchGames({ nodes, fetcher = fetch, answerMs = GAMES_ANSWER_MS } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) throw new Error('the games are asked of the nodes a lobby was named, and it was named none');
  const unique = [...new Set(nodes.map((n) => String(n).replace(/\/+$/, '')))];
  const byId = new Map();
  const refused = [];
  const answers = await Promise.all(unique.map((node) => fetcher(`${node}/games`, { signal: AbortSignal.timeout(answerMs) })
    .then(async (r) => ({ r, body: r.ok ? await r.json() : null }), (e) => ({ e }))));
  for (const [k, node] of unique.entries()) {
    const { r, body, e } = answers[k];
    if (e) { refused.push(`${node}: ${e.message}`); continue; }
    if (!r.ok) { refused.push(`${node}: answered ${r.status}`); continue; }
    for (const g of (body && Array.isArray(body.games)) ? body.games : []) {
      const id = String(g && g.id).toLowerCase();
      let manifest;
      try { manifest = decodeManifest(fromHex(String(g.manifest))); } catch (err) { refused.push(`${node}: game ${id.slice(0, 16)}: ${err.message}`); continue; }
      if (toHex(gameIdOf(manifest)) !== id) { refused.push(`${node}: game ${id.slice(0, 16)}: its manifest is another game`); continue; }
      if (!byId.has(id)) {
        byId.set(id, { id, name: manifest.gameName, title: typeof g.title === 'string' && g.title ? g.title : manifest.gameName,
          icon: typeof g.icon === 'string' && g.icon ? `${node}/${g.icon.replace(/^\/+/, '')}` : null, attested: isAttested(manifest),
          known: Object.prototype.hasOwnProperty.call(KNOWN_GOOD_GAMES, id), devKey: toHex(manifest.gameDevPubkey),
          manifest, manifestHex: String(g.manifest).toLowerCase(), nodes: [] });
      }
      byId.get(id).nodes.push(node);
    }
  }
  const games = [...byId.values()].sort((a, b) => (Number(b.known) - Number(a.known)) || (b.nodes.length - a.nodes.length) || (a.name < b.name ? -1 : 1));
  return { games, refused };
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
  const pinned = new Set((game.manifest.clients || []).map((h) => toHex(h)));
  if (!pinned.size) return { ok: false, why: `${game.name}'s manifest names no client` };
  let r;
  try { r = await fetcher(url, { cache: 'no-store' }); } catch (e) { return { ok: false, why: `${url}: ${e.message}` }; }
  if (!r.ok) return { ok: false, why: `${url}: answered ${r.status}` };
  const bytes = new Uint8Array(await r.arrayBuffer());
  const hash = toHex(new Uint8Array(await digest(bytes)));
  if (!pinned.has(hash)) return { ok: false, why: `${url} hashes to ${hash.slice(0, 16)}, which ${game.name}'s manifest does not name: not run` };
  return { ok: true, bytes, hash };
}
