// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// GUARDIANS SPREAD (kanban #1093 part 4, the owner 2026-11-03: "The founding draw seats at most f guardians that share an operator, or that name the
// same host_group ... the machine or provider, self-declared. It doesn't stop a liar, but it stops honest operators, us included, from stacking one
// federation on one machine.")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAdvert, decodeAdvert, hostGroupOf, HOST_GROUP_MARKER } from '../src/advert.js';
import { drawGuardians, replaceNoShows } from '../src/guardian-founding.js';
import { toHex } from '../src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const advert = (over = {}) => ({
  nodePubkey: b32(1), operatorId: 'op', protocolVersions: [22], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement', 'verify'],
  endpoint: 'wss://seat.example.com/n1', region: 'eu-west', capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: b32(0), bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n,
  guardianCapable: true, guardianEndpoint: 'wss://seat.example.com/n1/guardian', ...over });

test('host_group: the hash of the name, case and spaces aside; through encode and decode beside the other optional fields; none keeps the bytes', () => {
  assert.equal(toHex(hostGroupOf('Hetzner  FSN1 ')), toHex(hostGroupOf('hetzner fsn1')));
  assert.notEqual(toHex(hostGroupOf('hetzner fsn1')), toHex(hostGroupOf('my office')));
  const plain = advert();
  const bytes = encodeAdvert(plain);
  for (const more of [{}, { emergencyPubkey: b32(5) }, { declares: { bondMinSats: 1n, proposalDepositSats: 2n }, serving: false }, { emergencyPubkey: b32(5), serving: false }]) {
    const a = { ...plain, ...more, hostGroup: hostGroupOf('box-1') };
    const enc = encodeAdvert(a);
    assert.equal(enc.length, encodeAdvert({ ...plain, ...more }).length + 33);
    assert.deepEqual(decodeAdvert(enc), a, JSON.stringify(Object.keys(more)));
    assert.deepEqual(decodeAdvert(encodeAdvert({ ...plain, ...more })).hostGroup, undefined);
  }
  assert.deepEqual(encodeAdvert({ ...plain, hostGroup: undefined }), bytes, 'an advertisement without one keeps its bytes');
  assert.equal(HOST_GROUP_MARKER, 0x5b);
  assert.throws(() => encodeAdvert({ ...plain, hostGroup: b32(1).slice(0, 31) }), /32 bytes/);
});

const node = (n, op, group) => ({ pubkey: b32(n), txid: b32(0x40 + n), vout: 0, bondSats: 1000000n,
  advert: { operatorId: op, guardianCapable: true, guardianEndpoint: `wss://g${n}`, ...(group ? { hostGroup: hostGroupOf(group) } : {}) } });

test('the founding draw seats at most f guardians of one host_group; a node naming none is a group of its own', () => {
  // twelve operators: eight on one machine, four elsewhere; a federation of 7 has f = 2
  const entries = [...Array.from({ length: 8 }, (_, i) => node(i + 1, `op${i + 1}`, 'one-box')), ...Array.from({ length: 4 }, (_, i) => node(i + 20, `op${i + 20}`, null))];
  for (const seed of [0x77, 0x78, 0x79, 0x7a]) {
    const d = drawGuardians({ entries, seed: b32(seed), nominal: 7, bondMinGuardian: 500000n });
    if (!d.ok) { assert.match(d.why, /at most 2 guardians per host_group/); continue; }
    const onBox = d.drawn.filter((e) => e.advert.hostGroup).length;
    assert.ok(onBox <= 2, `seed ${seed}: ${onBox} of one host_group drawn`);
  }
  // with only three groups of three and nothing else, 7 seats at 2 per group cannot be filled: said so
  const crowded = Array.from({ length: 9 }, (_, i) => node(i + 1, `op${i + 1}`, `box${i % 3}`));
  const no = drawGuardians({ entries: crowded, seed: b32(0x77), nominal: 7, bondMinGuardian: 500000n });
  assert.equal(no.ok, false); assert.match(no.why, /cannot be filled with at most 2 guardians per host_group: 6 fit/);
  // spread enough: drawn, and no group past 2
  const spread = [...crowded, node(30, 'op30', null), node(31, 'op31', null), node(32, 'op32', null)];
  const ok = drawGuardians({ entries: spread, seed: b32(0x77), nominal: 7, bondMinGuardian: 500000n });
  assert.equal(ok.ok, true, ok.why);
  const per = new Map(); for (const e of ok.drawn) { const g = e.advert.hostGroup ? toHex(e.advert.hostGroup) : toHex(e.pubkey); per.set(g, (per.get(g) || 0) + 1); }
  assert.ok([...per.values()].every((c) => c <= 2), JSON.stringify([...per.values()]));
});

test('a no-show is replaced by the next alternate that keeps its host_group at f or fewer', () => {
  const drawn = [node(1, 'a', 'x'), node(2, 'b', 'x'), node(3, 'c', 'y'), node(4, 'd', null), node(5, 'e', null), node(6, 'f', null), node(7, 'g', null)];
  const alternates = [node(8, 'h', 'x'), node(9, 'i', 'y'), node(10, 'j', null)];
  const r = replaceNoShows({ drawn, alternates, noShows: [toHex(b32(4))] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.seated.map((e) => e.pubkey[0]), [1, 2, 3, 9, 5, 6, 7], 'group x already holds 2: its alternate is passed over for y\'s');
});
