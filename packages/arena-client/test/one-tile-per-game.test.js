// kanban #348: each game showed twice on the v2 page - its 2026.0.1 manifest and its 2026.0.2 update
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oneTilePerGame } from '../src/games.js';

const g = (id, name, version, rounds, devKey = 'dev') => ({ id, name, devKey, manifest: { version }, live: { rounds, players: 0 }, nodes: [] });

test('one tile per game: the newest version with a live round, else the newest; the others listed', () => {
  const tiles = oneTilePerGame([g('rps1', 'rock-paper-scissors', 1, 3), g('rps2', 'rock-paper-scissors', 2, 0),
    g('nb1', 'nextblock', 1, 2), g('nb2', 'nextblock', 2, 1), g('ud1', 'btc-updown-15m', 1, 0), g('ud2', 'btc-updown-15m', 2, 0)]);
  const by = Object.fromEntries(tiles.map((t) => [t.name, t]));
  console.log('  TILES:', JSON.stringify(tiles.map((t) => [t.name, t.id, t.versions])));
  assert.equal(tiles.length, 3);
  assert.equal(by['rock-paper-scissors'].id, 'rps1', 'only version 1 has live rounds');
  assert.equal(by.nextblock.id, 'nb2', 'both live: the newest');
  assert.equal(by['btc-updown-15m'].id, 'ud2', 'none live: the newest');
  assert.deepEqual(by.nextblock.versions, ['nb2', 'nb1']);
});

test('another developer\'s game of the same name is its own tile', () => {
  assert.equal(oneTilePerGame([g('a', 'nextblock', 1, 0, 'dev1'), g('b', 'nextblock', 2, 0, 'dev2')]).length, 2);
});

test('a tile without a description of its own shows the one its developer signed for an older version, checked against that id', async () => {
  const { checkedGameInfoOfTile } = await import('../src/games.js');
  const { generateKeyPairSync, sign, verify } = await import('node:crypto');
  const { gameInfoDigest } = await import('../../arena-protocol/src/game-info.js');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const id1 = 'aa'.repeat(32); const id2 = 'bb'.repeat(32);
  const text = { description: 'the game', website: '' };
  const sig1 = sign(null, Buffer.from(gameInfoDigest(Buffer.from(id1, 'hex'), text)), privateKey).toString('hex');
  const ver = async (s, m) => verify(null, Buffer.from(m), publicKey, Buffer.from(s));
  const v1 = { id: id1, name: 'x', devKey: 'd', manifest: { version: 1, gameDevPubkey: pub }, live: { rounds: 0 }, info: { ...text, signature: sig1 } };
  const v2 = { id: id2, name: 'x', devKey: 'd', manifest: { version: 2, gameDevPubkey: pub }, live: { rounds: 0 }, info: { ...text, signature: sig1 } };
  const [tile] = oneTilePerGame([v1, v2]);
  assert.equal(tile.id, id2);
  const got = await checkedGameInfoOfTile(tile, ver);
  console.log('  INFO OF THE v2 TILE:', JSON.stringify(got), '- v2 alone:', JSON.stringify(await checkedGameInfoOfTile({ ...v2, older: [] }, ver)));
  assert.equal(got.description, 'the game');
  assert.equal(await checkedGameInfoOfTile({ ...v2, older: [] }, ver), null, 'v1\'s signature does not stand for v2\'s id');
});
