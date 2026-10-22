// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 2026.0.3 STEP 7 - A PLAYER JOINS A ROUND THAT TAKES ANY FEDERATION (2026-10-13: "Es muss möglich sein für alle
// Spiele über alle Federation zu zahlen"). The page locks where its wallet covers the stake, the lowest-load such federation
// (lockFederation); the round is resolved to it (inFederation) with its own id kept; the entry names that federation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryFor, inFederation, roundLocks } from '../src/join.js';
import { lockFederation } from '../src/federations.js';
import { decodeEntryContract, encodeEntryContract, entryFederation } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { TRUCK_68E2_HASH } from '../../nextblock/plugin/truck-cores.js';   // the truck versions 1-4 name (kanban #523: the tree now builds a5c5766a)

const A = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32);
const ANY = { id: new Uint8Array(32).fill(7), protocolVersion: 3, stakeMsat: 1000000n, gameId: NEXTBLOCK_GAME_ID, simCoreHash: fromHex(TRUCK_68E2_HASH),
  federationId: new Uint8Array(32) };
const lockedFor = () => ({ claimKey: { ok: true, ref: new Uint8Array(32).fill(0x9a) },
  stakeLock: { outpoint: { txid: new Uint8Array(32).fill(0xd8), outIdx: 0 }, fields: { paymentImage: { kind: 'point', bytes: Uint8Array.of(2, ...new Uint8Array(32).fill(0x6c)) } } } });
const statuses = [
  { federation: A, status: 'OPEN', load: 0.6, invite: 'fed11a' },
  { federation: B, status: 'OPEN', load: 0.2, invite: 'fed11b' },
  { federation: C, status: 'DRAINING', load: 0.1, invite: 'fed11c' },
];

test('the stake is locked where the wallet covers it, the lowest load of those; nowhere covering it says deposit first', () => {
  const both = lockFederation({ stakeMsat: 1000000n, parts: [{ federation: A, msat: 5000000n }, { federation: B, msat: 2000000n }], statuses });
  assert.equal(both.federation, B, both.why);
  const onlyA = lockFederation({ stakeMsat: 1000000n, parts: [{ federation: A, msat: 5000000n }, { federation: B, msat: 999999n }], statuses });
  assert.equal(onlyA.federation, A, 'B does not hold the stake, so A, whatever its load');
  const draining = lockFederation({ stakeMsat: 1000000n, parts: [{ federation: C, msat: 5000000n }], statuses });
  assert.equal(draining.federation, null); assert.match(draining.why, /OPEN/);
  const none = lockFederation({ stakeMsat: 1000000n, parts: [{ federation: A, msat: 10n }], statuses });
  assert.equal(none.federation, null); assert.match(none.why, /deposit first/);
  console.log('  ' + both.why + '\n  ' + none.why);
});

test('the round resolved to that federation keeps its id, locks, and its entry names the federation for the seat', () => {
  assert.equal(roundLocks(ANY), true, 'a paying round that takes any federation goes into a lock');
  const r = inFederation(ANY, B);
  assert.equal(toHex(r.id), toHex(ANY.id), 'the round id is the contract\'s');
  assert.equal(toHex(r.federationId), B);
  const entry = entryFor(r, { seed: new Uint8Array(32).fill(5), curve: feldmanGroup, random: (n) => new Uint8Array(n).fill(9), ...lockedFor() });
  assert.equal(toHex(entry.federationId), B);
  const back = decodeEntryContract(encodeEntryContract({ sessionPubkey: new Uint8Array(32).fill(3), ...entry, roundId: ANY.id }));
  const at = entryFederation(ANY, back);
  assert.equal(at.ok, true, at.why); assert.equal(toHex(at.federationId), B, 'the seat reads the entry\'s federation');
  // a one-federation round is not touched, and its entry names nothing more
  const one = { ...ANY, protocolVersion: 2, federationId: fromHex(A) };
  assert.equal(inFederation(one, B), one);
  assert.equal(entryFor(one, { seed: new Uint8Array(32).fill(5), curve: feldmanGroup, random: (n) => new Uint8Array(n).fill(9), ...lockedFor() }).federationId, undefined);
});

test('a declared operator rides as the entry\'s tail; none declared leaves the entry\'s bytes and id as they were', () => {
  const r = { ...ANY, protocolVersion: 2, federationId: fromHex(A) };
  const make = (more) => ({ sessionPubkey: new Uint8Array(32).fill(3), roundId: ANY.id, ...entryFor(r, { seed: new Uint8Array(32).fill(5), curve: feldmanGroup, random: (n) => new Uint8Array(n).fill(9), ...lockedFor(), ...more }) });
  const plain = make({});
  const op = new Uint8Array(32).fill(0x0c);
  const declared = make({ operatorId: op });
  assert.equal(plain.operatorId, undefined);
  assert.deepEqual(decodeEntryContract(encodeEntryContract(declared)).operatorId, op);
  assert.deepEqual(make({ operatorId: new Uint8Array(32) }).operatorId, undefined, 'all zero is no declaration');
  assert.deepEqual(toHex(encodeEntryContract(make({ operatorId: null }))), toHex(encodeEntryContract(plain)), 'none declared: the same bytes');
  assert.equal(toHex(encodeEntryContract(declared)).startsWith(toHex(encodeEntryContract(plain))), true, 'the declaration is a tail');
});

test('the page\'s website key rides on an entry only into a round of 2026.0.9 or later', () => {
  const site = new Uint8Array(33).fill(0x5e); site[0] = 3;
  const make = (version, more) => ({ sessionPubkey: new Uint8Array(32).fill(3), roundId: ANY.id,
    ...entryFor({ ...ANY, protocolVersion: version, federationId: fromHex(A) }, { seed: new Uint8Array(32).fill(5), curve: feldmanGroup, random: (n) => new Uint8Array(n).fill(9), ...lockedFor(), ...more }) });
  assert.equal(make(8, { frontendPk: site }).frontendPk, undefined, 'a round below 9 pays no website: none is named');
  const v9 = make(9, { frontendPk: site });
  assert.deepEqual(v9.frontendPk, site);
  assert.deepEqual(decodeEntryContract(encodeEntryContract(v9)).frontendPk, site);
  assert.equal(make(9, {}).frontendPk, undefined);
  assert.equal(make(9, { frontendPk: new Uint8Array(33) }).frontendPk, undefined, 'not a compressed key: none is named');
  assert.equal(make(9, { frontendPk: site }).stakeMsat, make(9, {}).stakeMsat, 'the stake is the same');
  assert.equal(make(9, { frontendPk: site }).feeMsat, make(9, {}).feeMsat, 'the fee is the same');
});

test('a bot\'s entry (kanban #581) carries the bot mark; any other entry keeps its bytes as they were', () => {
  const r = { ...ANY, protocolVersion: 2, federationId: fromHex(A) };
  const made = (more) => entryFor(r, { seed: new Uint8Array(32).fill(5), curve: feldmanGroup, random: (n) => new Uint8Array(n).fill(9), ...lockedFor(), ...more });
  const bytes = (e) => encodeEntryContract({ sessionPubkey: new Uint8Array(32).fill(3), ...e, roundId: ANY.id });
  const plain = made({}), human = made({ bot: false }), bot = made({ bot: true });
  assert.equal(plain.bot, undefined);
  assert.equal(toHex(bytes(human)), toHex(bytes(plain)), 'bot: false writes nothing');
  assert.equal(bot.bot, true);
  assert.equal(decodeEntryContract(bytes(bot)).bot, true, 'the seats read the mark back');
  assert.equal(toHex(bytes(bot)).slice(0, toHex(bytes(plain)).length), toHex(bytes(plain)), 'the mark is the entry\'s last byte, the rest unchanged');
});
