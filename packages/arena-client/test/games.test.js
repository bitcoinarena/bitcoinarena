// THE GAMES FIRST, THEN THE GAME'S CLIENT (kanban #208): the games the named nodes host, each kept only when the manifest a
// node served hashes to the id it named; and a game's client file run only when its SHA-256 is one of that manifest's
// clients[].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fetchGames, gameClientFile, rowsOfGame } from '../src/games.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { MARKET, MARKET_CLIENT_PATH } from '../../arena-node/test/plugins/market/index.js';
import { TALLY } from '../../arena-node/test/plugins/tally/index.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const listed = (p) => ({ id: toHex(p.gameId), name: p.name, title: p.title || p.name, icon: null, manifest: toHex(encodeManifest(p.manifest)) });
const answer = (body, status = 200) => new Response(JSON.stringify(body), { status });
const sha256 = async (b) => createHash('sha256').update(b).digest();

test('the games of the named nodes: both hosted games, pinned first, a manifest that is another game refused', async () => {
  const market = MARKET.registration;
  const fetcher = async (url) => {
    if (url === 'http://a/games') return answer({ games: [listed(market), listed(NEXTBLOCK)] });
    if (url === 'http://b/games') return answer({ games: [listed(NEXTBLOCK), { ...listed(TALLY), id: toHex(NEXTBLOCK.gameId) }] });
    if (url === 'http://c/games') return answer({}, 503);
    throw new Error('no such node');
  };
  const got = await fetchGames({ nodes: ['http://a', 'http://b/', 'http://c', 'http://d'], fetcher });
  assert.deepEqual(got.games.map((g) => [g.name, g.known, g.attested, g.nodes]), [
    ['nextblock', true, false, ['http://a', 'http://b']],
    ['btc-close', true, true, ['http://a']],
  ]);
  assert.equal(got.refused.length, 3, got.refused.join('\n'));
  assert.ok(got.refused.some((r) => /http:\/\/b: game .*its manifest is another game/.test(r)));
  assert.ok(got.refused.some((r) => /http:\/\/c: answered 503/.test(r)));
  assert.ok(got.refused.some((r) => /http:\/\/d: no such node/.test(r)));
  await assert.rejects(fetchGames({ nodes: [], fetcher }), /named none/);
});

test('a game client runs only from bytes whose SHA-256 its manifest names', async () => {
  const bytes = readFileSync(MARKET_CLIENT_PATH);
  const game = { name: 'btc-close', manifest: MARKET.registration.manifest };
  const served = (b) => async () => new Response(b);
  const good = await gameClientFile({ game, url: 'games/btc-close/index.html', digest: sha256, fetcher: served(bytes) });
  assert.equal(good.ok, true);
  assert.equal(good.hash, toHex(createHash('sha256').update(bytes).digest()));
  assert.deepEqual(Buffer.from(good.bytes), bytes);
  // ONE BYTE CHANGED: not run
  const changed = Buffer.from(bytes); changed[changed.length - 2] ^= 1;
  const bad = await gameClientFile({ game, url: 'games/btc-close/index.html', digest: sha256, fetcher: served(changed) });
  assert.equal(bad.ok, false);
  assert.match(bad.why, /which btc-close's manifest does not name: not run/);
  // A MANIFEST NAMING NO CLIENT, A MISSING FILE, NO DIGEST
  assert.match((await gameClientFile({ game: { name: 'tally', manifest: TALLY.manifest }, url: 'x', digest: sha256, fetcher: served(bytes) })).why, /names no client/);
  assert.match((await gameClientFile({ game, url: 'x', digest: sha256, fetcher: async () => new Response('', { status: 404 }) })).why, /answered 404/);
  await assert.rejects(gameClientFile({ game, url: 'x', fetcher: served(bytes) }), /no digest/);
});

test('the lobby rows of one game', () => {
  const rows = [{ id: '1', game: 'AA' }, { id: '2', game: 'bb' }, { id: '3' }];
  assert.deepEqual(rowsOfGame(rows, 'aa').map((r) => r.id), ['1']);
  assert.deepEqual(rowsOfGame(null, 'aa'), []);
});
