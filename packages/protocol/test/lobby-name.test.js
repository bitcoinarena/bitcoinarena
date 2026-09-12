// A SEATED PLAYER'S NAME RECORD (M3.3-34): one canonical encoding, every field
// in the signed id, a name signed only as it is kept, and nothing else decodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeLobbyName, decodeLobbyName, lobbyNameId, lobbyNameIsValid, LOBBY_NAME_MAX } from '../src/lobby-name.js';
import { Writer } from '../src/encode.js';
import { TAG } from '../src/constants.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const base = { roundId: b32(1), playerPubkey: b32(2), identityPubkey: b32(3), name: 'Road Owl 42', atMs: 1789200000000n };

test('every field of a name record is in what the player signs, and it decodes to itself', () => {
  const id = toHex(lobbyNameId(base));
  const changed = [{ roundId: b32(9) }, { playerPubkey: b32(9) }, { identityPubkey: b32(9) }, { name: 'Road Owl 43' },
    { name: '' }, { atMs: base.atMs + 1n }];
  for (const c of changed) assert.notEqual(toHex(lobbyNameId({ ...base, ...c })), id, `${Object.keys(c)[0]} is not signed`);
  const back = decodeLobbyName(encodeLobbyName(base));
  assert.deepEqual(back, base);
  assert.deepEqual(decodeLobbyName(encodeLobbyName({ ...base, name: '' })).name, '');
  assert.equal(Object.values(TAG).filter((t) => t === TAG.lobbyName).length, 1);
});

test('a name is signed only as it is kept; a name that does not stand encodes as nothing', () => {
  assert.deepEqual(lobbyNameIsValid('  Road   Owl 42 '), { ok: true, name: 'Road Owl 42' });
  assert.throws(() => encodeLobbyName({ ...base, name: '  Road   Owl 42 ' }), /signed as it is kept/);
  for (const bad of ['<b>x</b>', 'x'.repeat(LOBBY_NAME_MAX + 1), '-dash first', 'a—b'])
    assert.throws(() => encodeLobbyName({ ...base, name: bad }), /a name is/, JSON.stringify(bad));
  assert.throws(() => encodeLobbyName({ ...base, roundId: b32(1).subarray(1) }), /32-byte round id/);
  assert.throws(() => encodeLobbyName({ ...base, playerPubkey: null }), /32-byte player key/);
  assert.throws(() => encodeLobbyName({ ...base, identityPubkey: b32(3).subarray(2) }), /32-byte identity key/);
  assert.throws(() => encodeLobbyName({ ...base, atMs: -1n }), /not negative/);
});

test('bytes that are not a record do not decode as one: trailing bytes, or a name the rules refuse', () => {
  const bytes = encodeLobbyName(base);
  assert.throws(() => decodeLobbyName(Uint8Array.from([...bytes, 0])), /trailing bytes/);
  const w = new Writer();
  w.bytes32(b32(1)); w.bytes32(b32(2)); w.bytes32(b32(3)); w.u64(1n); w.str('<script>');
  assert.throws(() => decodeLobbyName(w.finish()), /a name is/);
});
