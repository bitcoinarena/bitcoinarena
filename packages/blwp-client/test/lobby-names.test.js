// THE OTHER PLAYERS' NAMES, AS A PAGE MAKES AND CHECKS THEM (M3.3-34).
//
// A seated tab hands its seats one record, signed with the round key it is
// seated under: the name the player chose, or none. Another page shows a name
// only from a record that decodes, is for this round and verifies under the
// player key it names - the newest of each player's - so a seat can leave a
// name out but cannot write one, and no key is ever shown in place of a name.
//
// MEASURED BEFORE (TASKBOOK, M3.3-34), on the built page: tab 2 saved "Road Owl
// 42"; tab 1's seated view read "2 players in this round · other at -76,-78 m ·
// free seat" and the round's lobby row read only seat counts - fresh, after its
// repaint and after a reload - so the other player never saw the chosen name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { pageCurve } from '../src/page-curve.js';
import { nameRecordFor, namesOf, setPlayerName, tabIdentity, generatedName } from '../src/identity.js';
import { playerFor, tabSeed } from '../src/join.js';
import { playersLine } from '../src/ghost-field.js';
import { encodeLobbyName, decodeLobbyName, lobbyNameId } from '../../protocol/src/lobby-name.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const ROUND = { id: b32(0x5a) };
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
function tab() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

test('the name a tab hands its seats is the name it shows, signed with the round key it is seated under', () => {
  const storage = tab();
  assert.deepEqual(setPlayerName('Road Owl 42', { storage }), { ok: true, custom: true, name: 'Road Owl 42' });
  const signed = nameRecordFor(ROUND, { storage, random, curve: pageCurve, nowMs: 1789200000000 });
  const rec = decodeLobbyName(fromHex(signed.record));
  const player = playerFor(ROUND, { seed: tabSeed({ storage, random }), curve: pageCurve });
  const me = tabIdentity({ storage, random, curve: pageCurve });
  assert.equal(rec.name, 'Road Owl 42');
  assert.equal(rec.name, me.name, 'the others are shown what this tab shows itself');
  assert.equal(toHex(rec.roundId), toHex(ROUND.id));
  assert.equal(toHex(rec.playerPubkey), toHex(player.pubkey));
  assert.equal(toHex(rec.identityPubkey), me.pubkeyHex);
  assert.equal(rec.atMs, 1789200000000n);
  assert.equal(schnorr.verify(fromHex(signed.sig), lobbyNameId(rec), rec.playerPubkey), true);
  setPlayerName('', { storage });
  assert.equal(decodeLobbyName(fromHex(nameRecordFor(ROUND, { storage, random, curve: pageCurve }).record)).name, '',
    'no name chosen: the record carries none, and the others make the generated one from the identity key');
  assert.throws(() => nameRecordFor(ROUND, { storage, random, curve: { pointX: pageCurve.pointX } }), /no signer/);
});

test('the other page shows a name only from a record its player signed for this round - newest wins, never a key', async () => {
  const one = tab();
  setPlayerName('Road Owl 42', { storage: one });
  const first = nameRecordFor(ROUND, { storage: one, random, curve: pageCurve, nowMs: 1000 });
  setPlayerName('Night Hauler 7', { storage: one });
  const second = nameRecordFor(ROUND, { storage: one, random, curve: pageCurve, nowMs: 2000 });
  const oneRec = decodeLobbyName(fromHex(second.record));
  const two = tab();                                          // chose no name
  const plain = nameRecordFor(ROUND, { storage: two, random, curve: pageCurve, nowMs: 1500 });
  const plainRec = decodeLobbyName(fromHex(plain.record));
  // A SEAT'S FORGERY: player one's key named, newest of all, the seat's own signature.
  const forgedRec = { ...oneRec, name: 'Mallory', atMs: 9000n };
  const seat = schnorr.utils.randomSecretKey();
  const forged = { record: toHex(encodeLobbyName(forgedRec)), sig: toHex(schnorr.sign(lobbyNameId(forgedRec), seat)) };
  // AND PLAYER ONE'S OWN RECORD FOR ANOTHER ROUND, moved here.
  const elsewhere = nameRecordFor({ id: b32(0x77) }, { storage: one, random, curve: pageCurve, nowMs: 3000 });
  const byNode = { 'http://a': [first, forged, { record: 'zz', sig: '00' }], 'http://b': [second, plain, elsewhere] };
  const fetcher = async (url) => {
    const u = new URL(url);
    const list = byNode[`${u.protocol}//${u.host}`];
    if (u.pathname !== '/names' || !list || u.searchParams.get('round') !== toHex(ROUND.id)) return new Response('no', { status: 404 });
    return new Response(JSON.stringify({ names: list }), { status: 200 });
  };
  const names = await namesOf({ roundId: ROUND.id, nodes: ['http://a', 'http://b', 'http://down'], fetcher, verify });
  console.log('  FACTS (names the other page is shown):', JSON.stringify(names.map((n) => [n.name, n.chosen])));
  const byPlayer = Object.fromEntries(names.map((n) => [n.player, n]));
  assert.equal(names.length, 2);
  assert.deepEqual(byPlayer[toHex(oneRec.playerPubkey)], { player: toHex(oneRec.playerPubkey), name: 'Night Hauler 7', chosen: true });
  assert.deepEqual(byPlayer[toHex(plainRec.playerPubkey)],
    { player: toHex(plainRec.playerPubkey), name: generatedName(plainRec.identityPubkey), chosen: false });
  for (const n of names) {
    assert.doesNotMatch(n.name, /[0-9a-f]{8}/, 'a key in place of a name');
    assert.equal(n.name.includes(n.player.slice(0, 8)), false);
  }
  await assert.rejects(() => namesOf({ roundId: ROUND.id, nodes: ['http://a'], fetcher }), /no verify/);
});

test('the seated view names the others it holds a checked name for, and counts the rest', () => {
  assert.equal(playersLine({ seated: true, others: 1, names: ['Road Owl 42'] }), '2 players in this round: Road Owl 42');
  assert.equal(playersLine({ seated: true, others: 2, names: ['Road Owl 42'] }), '3 players in this round: Road Owl 42 +1 more');
  assert.equal(playersLine({ seated: true, others: 0, names: ['Road Owl 42'] }), '2 players in this round: Road Owl 42',
    'a seated player who has not driven yet is still in the round');
  assert.equal(playersLine({ seated: true, others: 1, names: ['Road Owl 42'], stake: { free: true } }),
    '2 players in this round: Road Owl 42 · free seat');
  assert.equal(playersLine({ seated: true, others: 1 }), '2 players in this round');
  assert.equal(playersLine({ seated: true, others: 0 }), '1 player · waiting');
});
