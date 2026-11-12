// kanban #1489 / #1541 / #1716 refute (skeptic 2, variant 1): GET /network-games titles a row by the hosted version its
// manifest names as parent (trustedTitle: hosted.get(g.parent)) without checking that parent is the SAME developer's. A stranger
// developer signs a v2 manifest of its own game naming this seat's Rock Paper Scissors as parent; any seat lists it, and this
// seat's store shows the stranger's game as "Rock Paper Scissors" (and as an update of it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { ROCK_PAPER_SCISSORS } from '../../rock-paper-scissors/plugin/rock-paper-scissors.js';
import { MANIFEST_V2 } from '../../rock-paper-scissors/plugin/rock-paper-scissors-v2.js';
import { manifestBodyId, encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const RPS = toHex(ROCK_PAPER_SCISSORS.gameId);
function strangerGame() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(12));
  const body = { ...MANIFEST_V2, gameName: 'free-sats-deposit-here', gameDevPubkey: pub, parentManifestId: ROCK_PAPER_SCISSORS.gameId, version: 2 };
  const signature = new Uint8Array(sign(null, Buffer.from(manifestBodyId(body)), privateKey));
  const m = { ...body, signature };
  return { id: toHex(gameIdOf(m)), manifest: toHex(encodeManifest(m)), devKey: toHex(pub) };
}

test('GET /network-games: a stranger developer\'s game naming a hosted game as parent is shown under the hosted game\'s title', async () => {
  const s = strangerGame();
  // any seat (or a stranger on the peers/census list) listing the stranger developer's game, with an honest-looking row
  const lister = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ games: [{ id: s.id, manifest: s.manifest, name: 'free-sats-deposit-here', title: 'free-sats-deposit-here' }] }));
  }).listen(0);
  const L = `http://127.0.0.1:${lister.address().port}`;
  const b = await serve(openStore(), { plugins: [ROCK_PAPER_SCISSORS], port: 0, peers: [L] });
  try {
    const ng = await (await fetch(`http://127.0.0.1:${b.port}/network-games?fresh=1`)).json();
    const g = ng.games.find((x) => x.id === s.id);
    console.log('network-games row', JSON.stringify({ name: g.name, title: g.title, devKey: g.devKey.slice(0, 16), updateOf: g.updateOf }));
    assert.equal(g.name, 'free-sats-deposit-here');
    assert.notEqual(g.devKey, toHex(ROCK_PAPER_SCISSORS.manifest.gameDevPubkey));
    assert.notEqual(g.title, 'Rock Paper Scissors', 'another developer\'s game is listed under the title this seat gave Rock Paper Scissors');
  } finally { await b.close(); lister.close(); }
});
