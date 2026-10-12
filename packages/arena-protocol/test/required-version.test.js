// kanban #349 (the owner 2026-10-12): a game can require a protocol version; a node that did not update drops out.
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
  assert.equal(speaksVersion(PROTOCOL_VERSION + 1), false);
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
