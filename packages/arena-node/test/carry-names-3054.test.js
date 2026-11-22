// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3054: a replayed game's name records are read from the round's seats (Verifier.carryNames, run after the close) and booked by the season
// only when f + 1 seats hold the same bytes - carried here when this seat missed it, marked held when it holds it too. A record one seat alone holds
// stays unbooked at every seat, so the seats sign one account of the round, not two.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Verifier } from '../src/verify.js';
import { b32, contractFor } from './window-fixture.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { encodeLobbyName, lobbyNameId } from '../../arena-protocol/src/lobby-name.js';
import { matchProofId } from '../../arena-protocol/src/match.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const NOW = Date.UTC(2026, 10, 10);
const P_SECRET = b32(0x41), ID_SECRET = b32(0x42);
const P = schnorr.getPublicKey(P_SECRET), ID = schnorr.getPublicKey(ID_SECRET);

function seat() {
  const round = new Round(openStore(':memory:'), () => NOW, { plugins: HOSTED });
  const contract = { ...contractFor([round.pubkey, b32(0x33)], 3000n, ['wss://r.example']), entryCloseMs: BigInt(NOW) };
  const rid = roundId(contract);
  round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(rid, encodeRoundContract(contract), 1);
  const rec = { roundId: rid, playerPubkey: P, identityPubkey: ID, name: 'Road Owl', atMs: BigInt(NOW - 1000) };
  const bytes = encodeLobbyName(rec);
  const name = { record: toHex(bytes), sig: toHex(schnorr.sign(lobbyNameId(rec), P_SECRET)),
    identitySig: toHex(schnorr.sign(matchProofId({ roundId: rid, entryId: P, identityKey: ID }), ID_SECRET)) };
  return { round, rid, rec, bytes, name };
}

async function carry(s, servedBy, peers) {
  const v = Object.create(Verifier.prototype);
  v.round = s.round;
  v.round.entriesOf = () => [{ entryId: b32(0x60), entry: { playerPubkey: P } }];
  v.peersOf = () => peers;
  const was = globalThis.fetch;
  globalThis.fetch = async (u) => new Response(JSON.stringify({ names: servedBy.some((p) => u.startsWith(`${p}/`)) ? [s.name] : [] }), { status: 200 });
  try { await v.carryNames(s.rid); } finally { globalThis.fetch = was; }
  return s.round.lobbyNames(s.rid);
}

test('#3054 a record two peers serve is carried and held; one peer\'s is not', async () => {
  const peers = ['http://p1', 'http://p2', 'http://p3'];
  const one = seat();
  assert.deepEqual(await carry(one, ['http://p1'], peers), [], 'one peer\'s record is not carried');
  const two = seat();
  const got = await carry(two, ['http://p1', 'http://p2'], peers);
  assert.equal(got.length, 1);
  assert.equal(got[0].held, 2, 'carried with its consent, held');
});

test('#3054 a record this seat holds is marked held only when f + 1 seats hold it, this seat counted', async () => {
  const peers = ['http://p1', 'http://p2', 'http://p3'];
  const alone = seat();
  alone.round.putLobbyName({ roundId: alone.rid, playerPubkey: P, record: alone.bytes, signature: schnorr.sign(lobbyNameId(alone.rec), P_SECRET), atMs: alone.rec.atMs,
    identitySig: schnorr.sign(matchProofId({ roundId: alone.rid, entryId: P, identityKey: ID }), ID_SECRET) });
  assert.equal(alone.round.lobbyNames(alone.rid)[0].held, 0, 'taken at the door: not yet held');
  assert.equal((await carry(alone, [], peers))[0].held, 0, 'no peer holds it: not held');
  const withOne = seat();
  withOne.round.putLobbyName({ roundId: withOne.rid, playerPubkey: P, record: withOne.bytes, signature: schnorr.sign(lobbyNameId(withOne.rec), P_SECRET), atMs: withOne.rec.atMs,
    identitySig: schnorr.sign(matchProofId({ roundId: withOne.rid, entryId: P, identityKey: ID }), ID_SECRET) });
  assert.equal((await carry(withOne, ['http://p1'], peers))[0].held, 2, 'this seat and one peer: f + 1 = 2 of 4 seats hold it');
});
