// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a45 refute 4 (#1810 variant): THE SHOP OF A GAME IS TAKEN BY ONE SEAT'S SELF-SIGNED MANIFEST OF THE SAME NAME.
// #1810 made fetchGames keep only manifests signed by the developer key each manifest names - but any stranger is a developer of his
// own key. shopOf (item-buy.js) picks "the newest version that sells anything" by gameName ALONE, never by developer key, so one seat
// lists a manifest under its own key, named like the honest game, version + 1, selling the same item at 1000x the price: the page's
// shop (index.html openShop / itemsManifest / buyShopItem) sells the liar's item, priced by the liar, handed to the liar's seat only.
// Safe: the shop of a game is the newest selling version of the SAME developer key as the game's tile (oneTilePerGame's group).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { fetchGames, oneTilePerGame } from '../src/games.js';
import { shopOf } from '../src/item-buy.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { encodeManifest, gameIdOf, manifestBodyId } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const answer = (body) => new Response(JSON.stringify(body), { status: 200 });
const listed = (m) => ({ id: toHex(gameIdOf(m)), name: m.gameName, title: m.gameName, icon: null, manifest: toHex(encodeManifest(m)) });
const dev = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(12));
  return { pub, sign: (m) => { const b = { ...m, gameDevPubkey: pub, signature: new Uint8Array(64) }; b.signature = new Uint8Array(nodeSign(null, manifestBodyId(b), privateKey)); return b; } };
};

test('a stranger key\'s signed manifest of the same game name does not take the game\'s shop', async () => {
  const h = dev(), l = dev();
  const items = (p) => [{ id: 'large-truck', name: 'Larger truck', priceSat: p, unlock: new Uint8Array(32).fill(0xa1) }];
  const honest = h.sign({ ...NEXTBLOCK.manifest, gameName: 'ticktock', version: 4, requiredProtocolVersion: 10, items: items(500n) });
  const liar = l.sign({ ...NEXTBLOCK.manifest, gameName: 'ticktock', version: 5, requiredProtocolVersion: 10, items: items(500000n) });
  const byNode = { 'http://h1': [honest], 'http://h2': [honest], 'http://h3': [honest], 'http://liar': [liar] };
  const fetcher = async (url) => { for (const [n, ms] of Object.entries(byNode)) if (url === `${n}/games`) return answer({ games: ms.map(listed) }); throw new Error('no such node'); };
  const got = await fetchGames({ nodes: Object.keys(byNode), fetcher });
  // the page's pick: the first tile of the name (index.html chooseTheGame), the honest one - 3 seats host it
  const chosen = oneTilePerGame(got.games).find((t) => t.name === 'ticktock');
  assert.equal(chosen.devKey, toHex(h.pub), 'the chosen tile is the honest developer\'s');
  const shop = shopOf(got.games, chosen.name);
  assert.equal(shop.game.devKey, toHex(h.pub),
    `the shop of the honest ticktock tile sells from ${shop.game.devKey.slice(0, 16)} (the liar's key), version ${shop.game.manifest.version}, `
    + `price ${shop.items[0].priceSat} sat, seats ${shop.game.nodes.join(',')} - not the honest developer's v4 at 500 sat`);
});
