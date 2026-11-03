// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE COMMIT DOOR SENDS THE SEAT'S SIGNED WORD (§5A.3 "Stalled in its rounds", kanban #1077). From protocol 26 a seat that commits to a settlement signs its commitment
// (settlement.js commit -> `word`), and the asker reads that word from the answer's x-settlement-commit header (#commitWord): a seat that committed is never named silent in
// the asker's StallNote. server.js's /forfeit-commit sent the header; /settle-commit did not, so on real seats every committed seat read as silent. The harnesses that call
// commit() directly could not see it.
//
// Four real serve() seats on port 0, each with its own node key and its share of a real 6-of-7 FROST key, reached over HTTP by the asker (a LockSettlement on its own store),
// and two seats whose ports answer nothing. Only the settlement's bytes are stubbed (`message`), not the acks, the asks, the commitments or the words. Five acks are the
// threshold of 7 seats, six commitments the key's: the pass stops at the commit with four peers committed, and the StallNote's silent list is the two dead seats only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { schnorr } from '@noble/curves/secp256k1.js';

import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { LockSettlement, decodeCommitments } from '../src/settlement.js';
import * as curve from '../src/curve.js';
import { HOSTED } from './plugins/hosted.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { checkSettlementCommit } from '../../arena-protocol/src/settlement-ack.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const RID = new Uint8Array(32).fill(0x77);
const MSG = new Uint8Array(32).fill(0xc7);
const TXID = toHex(MSG);
const CENSUS = 500;
const GROUP = evenGroupSecret(0x1077n, curve);
const DEAL = trustedDealerSplit({ secret: GROUP.secret, max: 7, min: 6, coefficients: [3n, 5n, 7n, 11n, 13n], curve });
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };

/** A base no seat answers at: a port opened and closed again, so a request is refused at once. */
async function deadBase() {
  const s = net.createServer().listen(0, '127.0.0.1');
  await new Promise((ok) => s.once('listening', ok));
  const port = s.address().port;
  await new Promise((ok) => s.close(ok));
  return `http://127.0.0.1:${port}`;
}

async function world(protocolVersion) {
  const live = [];
  for (let i = 0; i < 4; i++) live.push(await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true }));
  const asker = new Round(openStore(':memory:'));
  const dead = [sha256(Uint8Array.from([0x77, 5])), sha256(Uint8Array.from([0x77, 6]))].map((x) => schnorr.getPublicKey(x));
  const nodes = [asker.pubkey, ...live.map((s) => s.round.pubkey), ...dead];
  const contract = { protocolVersion, networkId: NETWORK_ID_REGTEST, censusHeight: CENSUS, nodes, settlementSlots: 7 };
  const bytesFor = (k) => ({ ok: true, contract, ackTable: { roundId: RID, rows: [] }, txid: TXID, message: MSG, claimPk: DEAL.groupPublicKey, needed: 6, claims: [],
    plan: { payouts: [], claims: [], nonce: new Uint8Array(32), stakeShares: [] }, signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } });
  // each real seat rebuilds the same settlement bytes, with its own share of the key: everything behind the door is the seat's own
  live.forEach((s, i) => { s.settlements.message = async () => bytesFor(i + 1); });
  const bases = [...live.map((s) => `http://127.0.0.1:${s.port}`), await deadBase(), await deadBase()];
  const wire = [];
  let drawn = 0;
  const settlement = new LockSettlement(asker, { curve, random: (n) => sha256(Uint8Array.from([0x77, drawn++, n])),
    port: { settle: async () => { throw new Error('a pass short of commitments never submits'); } },
    peersFor: () => bases,
    fetcher: async (u, o) => {
      const r = await fetch(u, o);
      const url = new URL(u);
      if (url.pathname === '/settle-commit') wire.push({ base: url.origin, status: r.status, word: r.headers.get('x-settlement-commit'), body: new Uint8Array(await r.clone().arrayBuffer()) });
      return r;
    } });
  settlement.message = async () => bytesFor(0);
  const close = async () => { for (const s of live) await s.close(); asker.db.close(); };
  return { live, asker, settlement, nodes, contract, wire, close };
}

test('from protocol 26 a real seat\'s commit door sends its signed word, and the StallNote names only the seats that never answered', async () => {
  const w = await world(26);
  try {
    const got = await w.settlement.settle(RID);
    assert.equal(got.ok, false);
    assert.match(String(got.why), /5 of the 6 signer nodes the settlement needs committed/);
    // FOUR COMMITS OVER HTTP, EACH WITH A WORD SIGNED BY THAT SEAT'S NODE KEY OVER ITS OWN COMMITMENT
    assert.equal(w.wire.length, 4, 'four live seats were asked to commit');
    for (const x of w.wire) {
      assert.equal(x.status, 200);
      assert.ok(x.word, `${x.base} answered a commitment with no x-settlement-commit`);
      const commitment = decodeCommitments(x.body)[0];
      const c = checkSettlementCommit(fromHex(x.word), { seats: w.nodes, commit: { roundId: RID, settlementTxid: MSG, hiding: commitment.hiding, binding: commitment.binding }, verify });
      assert.equal(c.ok, true, c.why);
      const seat = w.live.find((s) => x.base === `http://127.0.0.1:${s.port}`);
      assert.equal(c.who, toHex(seat.round.pubkey), 'the word is signed by the seat that answered');
    }
    // THE PASS KEPT FOR THE StallNote: stopped at the commit, the two dead seats silent, none of the four that committed
    const passes = w.asker.settlePassesOf(RID);
    assert.equal(passes.length, 1);
    assert.equal(passes[0].step, 'commit');
    assert.deepEqual(passes[0].silent, w.nodes.slice(5).map(toHex).sort());
    for (const s of w.live) assert.ok(!passes[0].silent.includes(toHex(s.round.pubkey)), 'a seat that committed over the door was named silent');
    console.log(`  FACTS: protocol 26, 4 live seats + 2 dead: ${w.wire.filter((x) => x.word).length} of ${w.wire.length} commits carried a signed word; silent ${passes[0].silent.length}: ${passes[0].silent.map((k) => k.slice(0, 8)).join(', ')}`);
  } finally { await w.close(); }
});

test('below protocol 26 the commit door answers as before: no word, and no pass is kept', async () => {
  const w = await world(22);
  try {
    const got = await w.settlement.settle(RID);
    assert.equal(got.ok, false);
    assert.equal(w.wire.length, 4);
    for (const x of w.wire) {
      assert.equal(x.status, 200);
      assert.equal(x.word, null, `${x.base} sent a word below protocol 26`);
      assert.equal(decodeCommitments(x.body).length, 1);
    }
    assert.deepEqual(w.asker.settlePassesOf(RID), []);
  } finally { await w.close(); }
});
