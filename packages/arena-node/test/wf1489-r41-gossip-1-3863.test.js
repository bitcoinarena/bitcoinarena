// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 41 (gossip), finding 1: ONE census seat's GET /served answer makes the reading seat derive a chain census per invented
// round (gap in #3147, the #3258 / #1818 class on a peer pull).
//
// server.js servedRoundsBetween (the funding signal's active-node read) and POST /item-purchase (any stranger's post, before the payment is
// checked) read every network seat's GET /served?finals=1 - up to SERVED_HELD_MAX (20,000) rounds from one answer of up to 32 MiB - and since
// #3147 hand every listed round with a bonded committee to drawnOfServed, which decodes the round's contract as the peer sent it and calls
// roster.committeeFor(rid, role, { posted: c }). A posted contract is drawn on the census at ITS census height, network, protocol, bond_min and
// depth - the census cache key (roster.js censusFor `whose`) - so a seat that lists rounds which name one more bond_min each (or a fresh series
// id each) misses the cache every time and runs censusOfView over the whole chain view for each one (0.26-2.7 s measured on live seats, see
// roster.js), on the seat's main thread, for every pull and every one of the item-purchase door's up to 8 merges. The contract is the
// peer's own invention: roundIdOf(c) is all the id check asks, and its committee is the public bonded keys.
// Safe behaviour: one peer's answer costs a bounded number of census derivations, however many rounds it lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { chainOf as minedChain } from '../../arena-protocol/tools/chainview.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { encodeRoundContract, decodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { mergeServedRounds } from '../../arena-protocol/src/served-nodes.js';
import { Roster, censusOfView } from '../src/roster.js';
import { keyFor, bondFor } from './curve.js';
import { contractFor } from './window-fixture.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const SECRET = (n) => new Uint8Array(32).fill(n);
const HEIGHT = 900000;
const advertFor = (n) => ({
  nodePubkey: keyFor(n), operatorId: `op-${n}`, protocolVersions: [19],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'], endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1,
  softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: schnorr.getPublicKey(b32(0x30 + n)), guardianOf: [], timestamp: 1000n,
});
const signedBond = (n) => {
  const a = advertFor(n);
  return bondTransaction(a, { previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(keyFor(n)), value: 60000, signature: schnorr.sign(advertId(a), SECRET(n)) });
};

test('wf1489 r41 gossip-1: one seat\'s GET /served answer of invented rounds costs a bounded number of census derivations', () => {
  const ids = [0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17];
  const blocks = [];
  for (let h = HEIGHT - 30; h <= HEIGHT + 2; h++) blocks.push({ transactions: h === HEIGHT - 25 ? ids.map(signedBond) : [] });
  const view = minedChain(blocks, HEIGHT - 30);
  const base = { ...contractFor(ids.map(keyFor)), protocolVersion: 19, gameId: NEXTBLOCK_GAME_ID, censusHeight: HEIGHT, censusConfirmations: 6, bondMinSats: 50000n };
  const census = censusOfView(view, base);
  assert.equal(census.ok, true, census.why);
  const bonded = new Set(census.entries.map((e) => toHex(e.pubkey).toLowerCase()));
  assert.equal(bonded.size, ids.length);

  // THE READING SEAT: its roster on its own chain view; a derivation that is not in memory first asks the store (readKeptCensus) - counted
  let derivations = 0;
  const db = { prepare: (sql) => ({ get: () => { if (/FROM census_kept/.test(sql)) derivations++; return undefined; }, run: () => ({ changes: 0 }), all: () => [] }) };
  const round = { contractOf: () => null, get: () => null, openCount: 0, db };
  const roster = new Roster(round, { chainFor: () => view });

  // server.js drawnOfServed, as written there (kanban #3147) - the source is held to it below
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(src, /const drawnOfServed = \(rid, contractBytes\) => \{[\s\S]{0,400}roster\.committeeFor\(rid, role, \{ posted: c \}\)/, 'server.js draws a /served round on its posted contract');
  assert.match(src, /mergeServedRounds\(held\.filter\(Boolean\), \{ bonded: bondedNodeKeys\(\), drawn: drawnOfServed \}\)/, 'servedRoundsBetween merges with drawnOfServed');
  const drawnOfServed = (rid, contractBytes) => {
    if (!(contractBytes instanceof Uint8Array)) return null;
    let c; try { c = decodeRoundContract(contractBytes); } catch { return null; }
    if (toHex(roundIdOf(c)) !== toHex(rid)) return null;
    const out = new Set();
    for (const role of ['game', 'settlement']) {
      const p = roster.committeeFor(rid, role, { posted: c });
      if (!p || !p.ok) return null;
      for (const e of p.drawn || p.committee) out.add(toHex(e.pubkey).toLowerCase());
    }
    return out;
  };

  // THE LYING SEAT'S ANSWER (servedHeldOf's shape): N invented rounds, each its own contract one sat of bond_min apart, the bonded keys as
  // the committee, no FINAL at all - nothing in it has to verify
  const N = 300;
  const committee = census.entries.map((e) => e.pubkey);
  const evil = [];
  for (let i = 0; i < N; i++) {
    const c = { ...base, bondMinSats: 50000n + BigInt(i) };
    evil.push({ roundId: roundIdOf(c), committee, finals: [], contract: encodeRoundContract(c) });
  }
  const t0 = process.hrtime.bigint();
  mergeServedRounds([[], evil], { bonded, drawn: drawnOfServed });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  one seat's /served answer of ${N} invented rounds: ${derivations} census derivations, ${ms.toFixed(0)} ms on the reading seat's thread (a ${blocks.length}-block view; a live view is ~2,080 blocks)`);
  assert.ok(derivations <= 16, `one peer's /served answer made this seat derive ${derivations} censuses (one per invented round)`);
});
