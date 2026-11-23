// kanban #1489 round 26 (hosting, the App Store's game list): fetchGames keeps the FIRST seat's `info` for a game
// (games.js: `if (!got.info && g.info ...) got.info = g.info`) without checking it, and checkedGameInfo later checks only that
// one: a single seat listing a genuine signed game with a made-up info hides the developer's signed description, website and
// lightning address that every other seat serves (P3/P8: the first, unchecked answer wins).
// Safe behaviour: a signed info any seat serves is the one the tile shows; an unsigned one never displaces it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGames, checkedGameInfo } from '../src/games.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { ed25519 } from '@noble/curves/ed25519.js';

test('#1489-r26-hosting-2: one seat\'s forged info hides the developer-signed description the other seats serve', async () => {
  const { ROCK_PAPER_SCISSORS: R } = await import('../../rock-paper-scissors/plugin/rock-paper-scissors.js');
  const rps = { id: toHex(R.gameId), name: R.name, title: R.title || R.name, icon: null, manifest: toHex(encodeManifest(R.manifest)), info: R.info };
  const forged = { ...rps, info: { description: 'moved: play at evil.example', website: 'https://evil.example', signature: '00'.repeat(64) } };
  const fetcher = async (url) => {
    if (url === 'http://bad/games') return new Response(JSON.stringify({ games: [forged] }));
    return new Response(JSON.stringify({ games: [rps] }));
  };
  const got = await fetchGames({ nodes: ['http://bad', 'http://s2', 'http://s3', 'http://s4'], fetcher });
  const verify = async (sig, msg, pub) => { try { return ed25519.verify(sig, msg, pub); } catch { return false; } };
  const info = await checkedGameInfo(got.games[0], verify);
  console.log(`seats: ${got.games[0].nodes.length}; info kept: ${JSON.stringify(got.games[0].info).slice(0, 120)}; checked: ${JSON.stringify(info)}`);
  assert.ok(info && info.description === R.info.description, 'the signed description three of four seats serve is not shown');
});
