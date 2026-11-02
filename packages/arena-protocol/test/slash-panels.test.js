// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TWO PANELS OF 7 FOR EVERY ROUND, BY A FORMULA ANYONE CAN RUN (spec 5A.3B, kanban #972). No curve: this is a selection and a hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { drawPanels, panelSeed, drawCommittee, drawAttestors } from '../src/sortition.js';
import { DRAW_FREE_VERSION } from '../src/constants.js';
import { taggedHash, toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const key = (n) => { const b = b32(0); b[0] = n >> 8; b[1] = n & 255; b[31] = 1; return b; };
const node = (n, bondSats = 100000n) => ({ txid: key(n), vout: 0, pubkey: key(n), bondSats, height: 1, hostedGames: [b32(0x67)], roles: ['game', 'settlement'], spent: false });
const census = (n) => Array.from({ length: n }, (_, i) => node(i + 1));
const contract = { networkId: NETWORK_ID_REGTEST, gameId: b32(0x67), gameVerifySlots: 7, settlementSlots: 7, bondMinSats: 100000n };
const small = { ...contract, gameVerifySlots: 2, settlementSlots: 2 };
const seed = (s) => { const b = b32(0); b[0] = s & 255; b[1] = s >> 8; return b; };
const keys = (list) => list.map((e) => toHex(e.pubkey));

test('panel_seed is the spec\'s tagged hash of the committee seed, and refuses anything but 32 bytes', () => {
  assert.equal(toHex(panelSeed(seed(1))), toHex(taggedHash('ARENA/v1/SlashPanel', seed(1))));
  assert.throws(() => panelSeed(new Uint8Array(31)), /seed its beacon/);
});

test('each round: 7 and 7, no node twice, none drawn for a role (reserves too), no attestor, no player\'s node', () => {
  const entries = census(60);
  const seen = new Set();
  for (let s = 0; s < 200; s++) {
    const committeeSeed = seed(s);
    const player = key(1 + (s % 60));
    const got = drawPanels({ entries, contract, committeeSeed, drawsAttestors: true, playerNodes: [player] });
    assert.equal(got.ok, true, got.why);
    const [a, b] = [keys(got.panelA), keys(got.panelB)];
    assert.deepEqual([a.length, b.length, new Set([...a, ...b]).size], [7, 7, 14]);
    const out = [...drawCommittee({ entries, contract, role: 'game', committeeSeed }), ...drawCommittee({ entries, contract, role: 'settlement', committeeSeed }),
      ...drawAttestors({ entries, contract, committeeSeed })].map((e) => toHex(e.pubkey));
    out.push(toHex(player));
    for (const k of [...a, ...b]) { assert.ok(!out.includes(k), 'a node left out sits on a panel'); seen.add(k); }
  }
  assert.ok(seen.size > 40, 'the draw moves with the seed');
});

test('anyone gets the same panels: the census order does not matter, and panel A is the head of one order', () => {
  const entries = census(50);
  const one = drawPanels({ entries, contract, committeeSeed: seed(9) });
  const two = drawPanels({ entries: [...entries].reverse(), contract, committeeSeed: seed(9) });
  assert.deepEqual(keys(one.order), keys(two.order));
  assert.deepEqual(keys(one.order), [...keys(one.panelA), ...keys(one.panelB)]);
});

test('it is bond-weighted as 5A.6 is, and a key with two bonds takes one seat', () => {
  // A 50x node wins a committee seat on every one of 400 seeds, so it never reaches a panel: the weight is measured at 5x, against a 1x node.
  const entries = [node(1, 500000n), ...census(80).slice(1)];
  const rate = (who) => {
    let sat = 0, free = 0;
    for (let s = 0; s < 400; s++) {
      const drawn = [...drawCommittee({ entries, contract, role: 'game', committeeSeed: seed(s) }), ...drawCommittee({ entries, contract, role: 'settlement', committeeSeed: seed(s) })];
      if (drawn.some((e) => toHex(e.pubkey) === toHex(who))) continue;
      free++;
      if (keys(drawPanels({ entries, contract, committeeSeed: seed(s) }).order).includes(toHex(who))) sat++;
    }
    return { sat, free };
  };
  const heavy = rate(key(1)), light = rate(key(2));
  console.log(`  FACTS: off the committees, a 5x node sits on a panel ${heavy.sat} of ${heavy.free} rounds, a 1x node ${light.sat} of ${light.free}`);
  assert.ok(heavy.sat / heavy.free > 2 * (light.sat / light.free), 'the weight did not count');
  const second = { ...node(3), txid: key(900) };
  const got = drawPanels({ entries: [...census(50), second], contract, committeeSeed: seed(3) });
  assert.equal(new Set(keys(got.order)).size, 14);
});

test('a v2 round draws one list for both roles, so it leaves out 9 and not 18', () => {
  const v2 = { ...contract, protocolVersion: DRAW_FREE_VERSION };
  const out = new Set(drawCommittee({ entries: census(23), contract: v2, role: 'game', committeeSeed: seed(5) }).map((e) => toHex(e.pubkey)));
  assert.equal(out.size, 9);
  const got = drawPanels({ entries: census(23), contract: v2, committeeSeed: seed(5) });
  assert.equal(got.ok, true, got.why);
  assert.ok(![...keys(got.panelA), ...keys(got.panelB)].some((k) => out.has(k)));
});

test('a census that cannot fill both panels is refused by name, never answered with smaller panels', () => {
  const smallest = (c, extra = {}) => { for (let n = 2; n < 80; n++) if (Array.from({ length: 40 }, (_, s) => drawPanels({ entries: census(n), contract: c, committeeSeed: seed(s), ...extra }).ok).every(Boolean)) return n; return null; };
  const facts = {
    'mainnet shape, one draw per role (7 seats)': smallest(contract),
    'the same, drawn attestors': smallest(contract, { drawsAttestors: true }),
    'v2 round (7 seats)': smallest({ ...contract, protocolVersion: DRAW_FREE_VERSION }),
    'v2 round, drawn attestors': smallest({ ...contract, protocolVersion: DRAW_FREE_VERSION }, { drawsAttestors: true }),
    '2 seats, as testnet4 runs': smallest(small),
    'v2 round, 2 seats': smallest({ ...small, protocolVersion: DRAW_FREE_VERSION }),
  };
  console.log('  FACTS (the smallest census that fills both panels on all of 40 seeds):', JSON.stringify(facts));
  assert.equal(facts['v2 round (7 seats)'], 23);
  assert.equal(facts['v2 round, 2 seats'], 17);
  const fifteen = drawPanels({ entries: census(15), contract: { ...small, protocolVersion: DRAW_FREE_VERSION }, committeeSeed: seed(1) });
  console.log(`  FACTS: 15 nodes, 2 seats: ${fifteen.why}`);
  assert.equal(fifteen.ok, false);
  assert.deepEqual([fifteen.have, fifteen.need], [12, 14]);
  assert.match(fifteen.why, /two panels are 14/);
  assert.equal(drawPanels({ entries: census(1), contract, committeeSeed: seed(1) }).ok, false, 'below the census minimum is an answer, not a throw');
});
