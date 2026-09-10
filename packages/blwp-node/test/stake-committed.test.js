// NO PLAY ON A STAKE NOBODY PAID.
//
// §23.1 step 5: "STAKE_COMMITTED is recorded once >=5 settlement nodes have
// seen the held HTLC. Play begins only after this." §9 step 7 puts the same
// line between the wallet paying and play. Measured before this file: nothing
// gated play on payment - an unpaid OPEN invoice reads HELD, `paidMsat` had no
// caller outside the port, and a seated entry's input batch was taken whether
// or not a satoshi had arrived.
//
// Each node gates its own doors on what ITS lnd shows, so the >=5 in the spec
// is the receipt threshold the client already needs: a node that has not seen
// the stake held signs nothing for that entry's play.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { WebSocket } from 'ws';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HELD } from '../src/custody.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch, decodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { assumeSeated } from './seating.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const FUNDED = { funded: () => true };
const READY = { preflight: async () => ({ ready: true, why: 'test port' }) };
const session = ed25519.utils.randomSecretKey();
const peer = ed25519.utils.randomSecretKey();
const GENESIS_HASH = (await import('../../protocol/src/transcript.js')).GENESIS;

const contractFor = (nodePubkey, stakeMsat) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1), startTimeMs: 60500n,
  entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION',
  slashMinimumServed: 20, slashRemainder: 'BURN', donationSetId: b32(0xd0),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat, bondMinSats: 50000n,
  blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [nodePubkey, schnorr.getPublicKey(peer)],
});
const entryFor = (rid, stakeMsat, n = 5) => ({
  roundId: rid, playerPubkey: b32(n), sessionPubkey: ed25519.getPublicKey(session),
  stakeCommitment: sha256(b32(n + 60)), stakeMsat, feeMsat: entryFeeMsat(stakeMsat),
  donationMsat: 0n, joinTick: 0, worldSecret: b32(0x16), vssSharesRef: new Uint8Array(32),
});

/** A Lightning node whose one invoice is paid when the test says so. */
function payablePort() {
  const port = {
    paid: 0n, looks: 0,
    async createHeld({ paymentHash, amountMsat }) { port.amount = amountMsat; return { paymentHash, amountMsat, request: 'lnbcrt-x' }; },
    async look() { port.looks++; return { state: HELD, amountMsat: port.amount, paidMsat: port.paid }; },
    async settle() {}, async cancel() {},
  };
  return port;
}

async function seatAndPlay(node, stakeMsat) {
  const c = contractFor(node.round.pubkey, stakeMsat);
  const rid = roundId(c);
  await fetch(`http://127.0.0.1:${node.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
  assumeSeated(node.round, rid, c.nodes);
  const entry = entryFor(rid, stakeMsat);
  const seated = await fetch(`http://127.0.0.1:${node.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
  assert.equal(seated.status, 201);
  const ws = new WebSocket(`ws://127.0.0.1:${node.port}/play`);
  await new Promise((r) => ws.once('open', r));
  const send = (m) => new Promise((resolve) => { ws.once('message', (d) => resolve(d.toString())); ws.send(m); });
  const batch = (first) => encodeInputBatch({ roundId: rid, entryId: entryId(entry), previousHash: GENESIS_HASH,
    firstTick: first, ticks: [[45875, 0, 0, 0, 0]], liquidations: [] });
  return { entry, ws, send, batch };
}

test('an input batch for a stake nobody paid is refused by name, and taken once lnd shows it held', async () => {
  const port = payablePort();
  const node = await serve(openStore(':memory:'), { port: 0, ...FUNDED, ...READY, lightning: port });
  const p = await seatAndPlay(node, 100000n);
  try {
    const unpaid = await p.send(p.batch(0));
    assert.match(unpaid, /^error .*not paid/, `play was taken on an unpaid stake: ${unpaid}`);
    assert.match(unpaid, new RegExp(`0 of ${netStakeMsat(p.entry)} msat`));

    port.paid = port.amount;
    assert.equal(await p.send(p.batch(0)), '1', 'a paid, held stake was still refused');

    // SEEN ONCE, REMEMBERED: the next batch is taken without asking Lightning
    // again - even with the port now saying nothing is paid.
    const asked = port.looks;
    port.paid = 0n;
    const second = encodeInputBatch({ roundId: p.entry.roundId, entryId: entryId(p.entry),
      previousHash: batchId(decodeInputBatch(p.batch(0))), firstTick: 1,
      ticks: [[45875, 0, 0, 0, 0]], liquidations: [] });
    assert.equal(await p.send(second), '1', 'a stake already seen held was asked about again and refused');
    assert.equal(port.looks, asked, 'every batch asked Lightning again');
  } finally { p.ws.close(); await node.close(); }
});

test('GET /stake says whether this node has seen an entry\'s stake held, and asks nobody for a stranger', async () => {
  const port = payablePort();
  const node = await serve(openStore(':memory:'), { port: 0, ...FUNDED, ...READY, lightning: port });
  const p = await seatAndPlay(node, 100000n);
  const at = (id) => fetch(`http://127.0.0.1:${node.port}/stake?entry=${id}`);
  try {
    const before = await at(toHex(entryId(p.entry)));
    assert.equal(before.status, 409);
    assert.match(await before.text(), /^stake not seen: .*0 of 98000 msat/);

    port.paid = port.amount;
    const after = await at(toHex(entryId(p.entry)));
    assert.equal(after.status, 200);
    const body = await after.json();
    assert.equal(body.state, HELD);
    assert.equal(body.paidMsat, String(netStakeMsat(p.entry)));

    const looks = port.looks;
    const stranger = await at('ee'.repeat(32));
    assert.equal(stranger.status, 404);
    assert.equal((await at('beef')).status, 400);
    assert.equal(port.looks, looks, 'a stranger made this node ask Lightning');
  } finally { p.ws.close(); await node.close(); }
});

test('a free round plays with no Lightning at all, and a paying round on a node with none is refused', async () => {
  const free = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  const f = await seatAndPlay(free, 0n);
  try { assert.equal(await f.send(f.batch(0)), '1'); }
  finally { f.ws.close(); await free.close(); }

  const bare = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  const b = await seatAndPlay(bare, 100000n);
  try { assert.match(await b.send(b.batch(0)), /^error .*reaches no Lightning/); }
  finally { b.ws.close(); await bare.close(); }
});
