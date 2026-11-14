// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1 refute 28 skeptic 2 (kanban #1522, a STRANGER, not a seat): "the committee most seats name stands" counts seat URLs,
// and a URL is not a seat. The page's seat list is the join link's node= list joined with the lobby's (index.html chooseTheGame:
// [...named.nodes, ...testnet.named.nodes]); fetchGames keeps a URL as its own node when its /games answer names a node key it has
// not seen - an unsigned field. One stranger's server at three paths (https://evil/a, /b, /c), each naming its own made-up node key
// and serving the real game's manifest, is three "seats": it lists a real round two honest seats hold, with a committee of one
// made-up key, outvotes them 3 to 2, and that key takes the whole nodes' half; the three nodes that served the round get nothing.
// Reload or retry runs the same steps and pays the same. Safe: a seat counts toward a committee only as a node the network knows
// (its bonded key, an authenticated answer), never by the URL it was reached at.
// DECIDED 2026-11-14 (kanban #1896, "(b) committee nodes only count"): the page passes the node keys of a census it checked; a committee
// naming a key outside it is not taken. The census here bonds the three nodes that served the round and the two honest seats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builds, NOW, MANIFEST, NET, player, verify, wallet, paidTo, json, honest, hijack, SYBIL_KEY, NODE_KEYS, listedGame } from './wf1489-v1-refute-28-s2-common.js';

const EVIL = ['https://evil/a', 'https://evil/b', 'https://evil/c'];
const fetch = async (url) => {
  const m = /^(https:\/\/[^/]+(?:\/[abc])?)\/(games|served\?.*|item-purchase)$/.exec(url);
  if (!m) throw new Error(`no such door ${url}`);
  const [, base, door] = m, evil = base.startsWith('https://evil');
  if (door === 'games') return json({ node: evil ? String(EVIL.indexOf(base) + 0xa1).repeat(32).slice(0, 64) : (base === 'https://good1' ? '01' : '02').repeat(32), games: [listedGame] });
  if (door.startsWith('served')) return json({ held: evil ? [hijack] : [honest] });
  return json({});
};

for (const [name, b] of builds) {
  test(`${name}: one stranger's server at three URLs does not outvote two honest seats`, async () => {
    const got = await b.fetchGames({ nodes: ['https://good1', 'https://good2', ...EVIL], fetcher: fetch });
    const seats = got.games[0].nodes;
    const w = wallet();
    const r = await b.buyItem({ manifest: MANIFEST, itemId: 'large-truck', networkSet: NET, gameSet: NET, wallet: w, federationId: 'fe'.repeat(32),
      player, seats, fetch, verify, nowMs: () => NOW, bondedKeys: [...NODE_KEYS, '01'.repeat(32), '02'.repeat(32)] });
    assert.equal(r.ok, true, r.why);
    const toSybil = paidTo(w.paid, SYBIL_KEY);
    assert.equal(toSybil, 0n, `the stranger's made-up key took ${toSybil} msat; the page counted ${seats.length} "seats": ${seats.join(', ')}`);
    for (const k of NODE_KEYS) assert.ok(paidTo(w.paid, k) > 0n, `node ${k.slice(0, 16)} served the round and is paid nothing`);
  });
}

for (const [name, b] of builds) {
  test(`${name}: with no census checked the page reads no served list and pays nothing`, async () => {
    const w = wallet();
    const r = await b.buyItem({ manifest: MANIFEST, itemId: 'large-truck', networkSet: NET, gameSet: NET, wallet: w, federationId: 'fe'.repeat(32),
      player, seats: ['https://good1', 'https://good2'], fetch, verify, nowMs: () => NOW, bondedKeys: [] });
    assert.equal(r.ok, false); assert.equal(r.step, 'served'); assert.equal(w.paid.length, 0);
  });
}
