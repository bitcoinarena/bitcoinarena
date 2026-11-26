// kanban #3729 (and #3309): a GET /opponent row names a single tap key only when one key tapped the round, lists every verified tap key, and
// the test opponent learns a tap key as KNOWN only when it is that one key beside the round's one non-bot entry whose stake lock verified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { opponentWant, opponentWants, OPPONENT_TAP_KEYS } from '../src/faucet.js';
import { tapKeysOf, tapKeyToLearn } from '../src/opponent-trigger.js';
import { presenceId } from '../../arena-protocol/src/match.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

const hex = (b) => Buffer.from(b).toString('hex');
const freshKey = () => (schnorr.utils.randomSecretKey ? schnorr.utils.randomSecretKey() : schnorr.utils.randomPrivateKey());
const tapOf = (round, priv = freshKey()) => { const key = hex(schnorr.getPublicKey(priv)); return { key, sig: hex(schnorr.sign(presenceId({ roundId: fromHex(round), identityKey: fromHex(key) }), priv)) }; };
const round = 'ef'.repeat(32);
const rowOf = (wants, at) => opponentWants(wants, at).find((x) => x.round === round);

test('#3729: one key tapping keeps its tap key, re-posts included', () => {
  const wants = new Map(), p = tapOf(round);
  opponentWant(wants, round, 1000, p, '203.0.113.7');
  opponentWant(wants, round, 3000, p, '203.0.113.7');
  opponentWant(wants, round, 4000, null, '203.0.113.7');   // an unsigned re-post keeps the key
  const row = rowOf(wants, 4000);
  assert.equal(row.tapped, true);
  assert.equal(row.tapKey, p.key);
  assert.deepEqual(row.tapKeys, [p.key]);
});

test('#3309: a stranger tapping after the player does not become the tap key', () => {
  const wants = new Map(), p = tapOf(round), s = tapOf(round);
  opponentWant(wants, round, 1000, p, '203.0.113.7');
  opponentWant(wants, round, 1500, s, '198.51.100.9');
  const row = rowOf(wants, 1600);
  assert.notEqual(row.tapKey, s.key);
  assert.equal(row.tapKey, null, 'two keys tapped: no single tap key');
  assert.deepEqual(row.tapKeys.sort(), [p.key, s.key].sort());
});

test('#3729: an unsigned or forged tap adds no key, and a row keeps at most OPPONENT_TAP_KEYS keys', () => {
  const wants = new Map(), p = tapOf(round);
  opponentWant(wants, round, 1000, p, '203.0.113.7');
  opponentWant(wants, round, 1100, { key: tapOf(round).key, sig: p.sig }, '198.51.100.9');
  opponentWant(wants, round, 1200, true, '198.51.100.9');
  assert.equal(rowOf(wants, 1300).tapKey, p.key);
  for (let i = 0; i < OPPONENT_TAP_KEYS + 5; i++) opponentWant(wants, round, 1400 + i, tapOf(round), '198.51.100.9');
  assert.equal(rowOf(wants, 2000).tapKeys.length, OPPONENT_TAP_KEYS);
});

test('#3729: the bot learns only the one tap key beside the one non-bot entry whose lock verified', () => {
  const pk = 'aa'.repeat(32), sk = 'bb'.repeat(32), bot = 'cc'.repeat(32);
  const one = [{ entry: 'e1', player: 'dd'.repeat(32) }], locked = new Map([['e1', 5000]]);
  assert.equal(tapKeyToLearn({ tapKeys: [pk], entries: one, locks: locked }), pk);
  assert.equal(tapKeyToLearn({ tapKeys: [sk, pk], entries: one, locks: locked }), null, 'two tap keys: which one staked is unknown');
  assert.equal(tapKeyToLearn({ tapKeys: [pk], entries: one, locks: new Map() }), null, 'no verified lock');
  assert.equal(tapKeyToLearn({ tapKeys: [pk], entries: [...one, { entry: 'e2', player: 'ee'.repeat(32) }], locks: locked }), null, 'two players: which one tapped is unknown');
  assert.equal(tapKeyToLearn({ tapKeys: [pk], entries: [...one, { entry: 'e3', player: bot }], locks: locked, botKeys: new Set([bot]) }), pk, 'the bot\'s own entry does not count');
  assert.equal(tapKeyToLearn({ tapKeys: [bot], entries: one, locks: locked, botKeys: new Set([bot]) }), null, 'never the bot\'s key');
  assert.equal(tapKeyToLearn({ tapKeys: [], entries: one, locks: locked }), null);
  // an older faucet's row (one tapKey) still reads, a new row's list wins
  assert.deepEqual(tapKeysOf({ tapKey: pk }), [pk]);
  assert.deepEqual(tapKeysOf({ tapKey: null, tapKeys: [pk, sk] }), [pk, sk]);
  assert.deepEqual(tapKeysOf({ tapKeys: ['nope'] }), []);
});

test('#3729: rps-opponent learns a tap key through tapKeyToLearn only, and any known tap key keeps the fast path', () => {
  const src = readFileSync(new URL('../tools/rps-opponent.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /knownAdd\(String\(w\.tapKey\)\)/, 'the row\'s tap key is learnt whenever any entry\'s lock verified');
  assert.match(src, /tapKeyToLearn\(\{ tapKeys: tapKeysOf\(w\)/);
  assert.match(src, /tapKeysOf\(w\)\.some\(\(t\) => KNOWN\.has\(t\)\)/);
});
