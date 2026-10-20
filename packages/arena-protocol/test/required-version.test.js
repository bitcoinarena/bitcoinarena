// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// (2026-10-12): a game can require a protocol version; a node that did not update drops out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, speaksVersion } from '../src/constants.js';
import { decodeManifest, encodeManifest, gameIdOf, roundFitsManifest, REQUIRED_VERSION_MARKER } from '../src/manifest.js';
import { toHex, fromHex } from '../src/hash.js';
import { KNOWN_GOOD_GAMES } from '../src/known-games.js';
import { KNOWN_GAME as RPS } from '../../rock-paper-scissors/plugin/known.js';
import { KNOWN_GAME as UPDOWN } from '../../btc-updown/plugin/known.js';
import { KNOWN_GAME as NEXTBLOCK } from '../../nextblock/plugin/known.js';

test('this build writes its version and reads the versions it lists', () => {
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(PROTOCOL_VERSION));
  assert.equal(speaksVersion(PROTOCOL_VERSION), true);
  assert.equal(speaksVersion(2), true, '2026.0.2: the round that names no draw');
  assert.equal(speaksVersion(4), true, '2026.0.4: top-N prize splits');
  assert.equal(speaksVersion(5), true, '2026.0.5: the median of signed readings');
  assert.equal(speaksVersion(6), true, '2026.0.6: markets on games (feature 6)');
  assert.equal(speaksVersion(7), true, '2026.0.7: scalar markets (feature 8)');
  assert.equal(speaksVersion(8), true, '2026.0.8: scalar templates');
  assert.equal(speaksVersion(9), true, '2026.0.9: the website that brought the entry');
  assert.equal(speaksVersion(10), true, '2026.0.10: in-game items');
  assert.equal(speaksVersion(11), true, '2026.0.11: the protocol reserves');
  assert.equal(speaksVersion(12), true, '2026.0.12: the leaderboard payout');
  assert.equal(speaksVersion(16), true);
  assert.equal(speaksVersion(17), true, 'the owner\'s emergency key (spec §23A.5a)');
  assert.equal(speaksVersion(19), true, 'add to bond: a node\'s outputs summed (kanban #544)');
  assert.equal(speaksVersion(20), false);
});

test('every live manifest keeps its bytes and its game id: none names a required version', () => {
  for (const g of [RPS, UPDOWN, NEXTBLOCK]) {
    const m = decodeManifest(fromHex(g.manifestHex));
    assert.equal(m.requiredProtocolVersion, undefined);
    assert.equal(toHex(encodeManifest(m)), g.manifestHex.toLowerCase());
    assert.ok(KNOWN_GOOD_GAMES[toHex(gameIdOf(m))], `${m.gameName} is still pinned under its id`);
  }
});

test('a manifest that requires a version carries it last and refuses an older round', () => {
  const base = decodeManifest(fromHex(RPS.manifestHex));
  const m = { ...base, requiredProtocolVersion: PROTOCOL_VERSION + 1 };
  const bytes = encodeManifest(m);
  const old = encodeManifest(base);
  // three bytes more, right before the signature: the marker and the u16
  assert.equal(bytes.length, old.length + 3);
  assert.equal(bytes[old.length - 64], REQUIRED_VERSION_MARKER);
  const back = decodeManifest(bytes);
  assert.equal(back.requiredProtocolVersion, PROTOCOL_VERSION + 1);
  assert.notEqual(toHex(gameIdOf(back)), toHex(gameIdOf(base)));
  const id = gameIdOf(back);
  const round = (v) => ({ gameId: id, protocolVersion: v, simCoreHash: back.cores[0].hash, configHash: back.cores[0].configs[0],
    rankNumerator: back.rankNumerator, rankDenominator: back.rankDenominator, minScore: back.minScore, blockTicks: 1 });
  const older = roundFitsManifest(round(PROTOCOL_VERSION), back, id);
  assert.equal(older.ok, false);
  assert.match(older.why, /requires protocol version 2; that round runs 1/);
  assert.equal(roundFitsManifest(round(PROTOCOL_VERSION + 1), back, id).ok, true);
  // the same round against the manifest that requires nothing: no version asked
  assert.equal(roundFitsManifest({ ...round(PROTOCOL_VERSION), gameId: gameIdOf(base) }, base).ok, true);
});

test('a required version is 1 to 65535', () => {
  const base = decodeManifest(fromHex(RPS.manifestHex));
  assert.throws(() => encodeManifest({ ...base, requiredProtocolVersion: 70000 }), /1 to 65535/);
  assert.throws(() => encodeManifest({ ...base, requiredProtocolVersion: 1.5 }), /1 to 65535/);
});

test('a protocol version is shown as its number (2026-10-19: "Protocol is just protocol 1..16"); old YYYY.x.y names are still read back to the u16', async () => {
  const { protocolVersionName, readProtocolVersionName } = await import('../src/protocol-version.js');
  assert.equal(protocolVersionName(PROTOCOL_VERSION), '1');
  assert.equal(protocolVersionName(2), '2');
  assert.equal(protocolVersionName(4), '4');
  assert.equal(protocolVersionName(5), '5');
  assert.equal(protocolVersionName(6), '6');
  assert.equal(protocolVersionName(7), '7');
  assert.equal(protocolVersionName(8), '8');
  assert.equal(protocolVersionName(9), '9');
  assert.equal(protocolVersionName(10), '10');
  assert.equal(protocolVersionName(12), '12', 'the leaderboard payout');
  assert.equal(protocolVersionName(17), '17', 'a protocol version is shown as its number (2026-10-19)');
  assert.deepEqual(readProtocolVersionName('2026.0.1'), { ok: true, version: 1, known: true });
  assert.deepEqual(readProtocolVersionName('2027.0.20'), { ok: true, version: 20, known: false });
  assert.deepEqual(readProtocolVersionName('19'), { ok: true, version: 19, known: true });
  assert.equal(protocolVersionName(18), '18', 'the tag switch');
  assert.deepEqual(readProtocolVersionName('2026.0.17'), { ok: true, version: 17, known: true });
  assert.deepEqual(readProtocolVersionName('1'), { ok: true, version: 1, known: true });
  assert.match(readProtocolVersionName('2025.0.1').why, /build 1 is 2026\.0\.1/, 'an old YYYY.x.y name is still read, and checked');
  assert.match(readProtocolVersionName('2026.0').why, /YYYY\.x\.y/);
  assert.match(readProtocolVersionName('2026.0.70000').why, /1\.\.65535/);
});
