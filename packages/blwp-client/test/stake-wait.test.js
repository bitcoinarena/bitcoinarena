// A PLAYER WHOSE PAYMENT IS STILL ON ITS WAY IS WAITING, NOT REFUSED.
//
// The node now signs no batch for a paying round's entry until its own lnd
// shows the stake held (23.1 step 5; blwp-node's stake-committed.test.js). A
// wallet takes seconds to pay, and the page records ticks from the moment the
// player drives. Measured before this file: the first batch came back "not
// paid", the client resynced, the second came back the same, and the run ended
// VOID - a player lost their round for paying at wallet speed.
//
// So "not seen paid yet" is held and asked again, like a dropped link, and
// never counted as a refusal. A stake that is never paid still ends the run:
// the ticks stay held until the hold is full, which is its own rule.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../../blwp-node/src/cores.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { HELD } from '../../blwp-node/src/custody.js';
import { Client } from '../src/client.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';

const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');
const FUNDED = { funded: () => true };
const READY = { preflight: async () => ({ ready: true, why: 'test port' }) };
const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const sign = (id) => ed25519.sign(id, session);
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Lightning node whose one invoice is paid when the test says so. */
function payablePort() {
  const port = {
    paid: 0n,
    async createHeld({ paymentHash, amountMsat }) { port.amount = amountMsat; return { paymentHash, amountMsat, request: 'lnbcrt-x' }; },
    async look() { return { state: HELD, amountMsat: port.amount, paidMsat: port.paid }; },
    async settle() {}, async cancel() {},
  };
  return port;
}

async function drive(client, n) {
  for (let i = 0; i < n; i++) client.record([45875, 22000, 0, 0, 0]);
  for (let i = 0; i < 40; i++) {
    const p = client.drain();
    if (p) { try { await p; } catch { /* the answer is the measurement */ } }
    await wait(2);
    if (!client.hold.length || client.ended) break;
  }
}

test('ticks recorded before the stake is seen are held, and published once it is', async () => {
  const port = payablePort();
  const node = await serve(openStore(), { port: 0, ...FUNDED, ...READY, lightning: port });
  const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
  try {
    const c = {
      networkId: b32(0x4e), configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7,
      settlementSlots: 7, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n,
      objectionWindowMs: 600000n, custody: 'THRESHOLD_LN', slashMinimumServed: 20,
      slashRemainder: 'SPLIT', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'] /* a paying round names a relay (§13A); never posted to here */, donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
      censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
      stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
      exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
      timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
      nodes: [node.round.pubkey],
    };
    const rid = await client.openRound(c);
    const entry = {
      roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n,
      joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    };
    const eid = await client.join(entry);
    await client.connect();
    client.setRound({ roundId: rid, entryId: eid, blockTicks: c.blockTicks });

    // THE WALLET IS STILL PAYING. The player drives anyway.
    await drive(client, 60);
    assert.equal(client.ended, false, `a player paying at wallet speed lost the run: ${client.endingReason}`);
    assert.equal(client.refusals, 0, `waiting for a payment was counted as a refusal: ${client.refusedWhy}`);
    assert.equal(client.nextTick, 0, 'the node took ticks for a stake it has not seen');
    assert.equal(client.hold.length, 60, 'ticks recorded while waiting were not kept');

    // THE PAYMENT LANDS, and the next drain publishes everything held.
    port.paid = port.amount;
    await drive(client, 0);
    assert.equal(client.nextTick, 60, `after the stake was seen the node was owed ${client.nextTick}`);
    assert.equal(client.ended, false);
  } finally { client.close(); await node.close(); }
});
