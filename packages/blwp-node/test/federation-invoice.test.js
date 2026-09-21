// A FEDERATION ROUND'S STAKE: THE INVOICE COMES FIRST (the owner 2026-09-11).
//
// V1's pool is a federation, and an LNv2 invoice's secret is its receiver's -
// the federation's, held threshold-wise - so a player cannot choose it. A node
// asks the federation for the round's invoice before any entry exists; the
// entry commits to that invoice's hash with no dealt shares; and the entry
// door then takes the gateway's hold invoice up, exactly as a second daemon on
// one endpoint already does (lnd-port.js), with `invoiceMatchesEntry` checking
// the hash and the net-stake amount.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HELD } from '../src/custody.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { NO_SHARES } from '../../protocol/src/handout.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { assumeAssigned } from './assignment.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const READY = { preflight: async () => ({ ready: true, why: 'test port' }) };
const session = ed25519.utils.randomSecretKey();
const peer = ed25519.utils.randomSecretKey();
const STAKE = 1000000n;
const NET = STAKE - entryFeeMsat(STAKE);

const contractFor = (nodePubkey, stakeMsat = STAKE, tag = 0x43) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n,
  entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'THRESHOLD_LN',
  slashMinimumServed: 20 + (tag - 0x43), slashRemainder: 'SPLIT', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'] /* a paying round names a relay (§13A); never posted to here */, donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat, bondMinSats: 50000n,
  blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [nodePubkey, schnorr.getPublicKey(peer)],
});

/**
 * A federation that makes one LNv2 invoice, and the committee's lnd that sees
 * it - the gateway's hold invoice - the way a real endpoint does: asked for a
 * hold on a hash it already holds, it takes that invoice up.
 */
function federationAndEndpoint({ skewMsat = 0n } = {}) {
  const fed = { hash: sha256(new Uint8Array(randomBytes(32))), asked: [], amountMsat: null };
  fed.request = `lnbcrt-federation-${toHex(fed.hash).slice(0, 12)}`;
  const federation = {
    async receive({ amountMsat }) { fed.asked.push(amountMsat); fed.amountMsat = amountMsat + skewMsat; return { request: fed.request }; },
  };
  const lightning = {
    async createHeld({ paymentHash, amountMsat }) {
      if (toHex(paymentHash) === toHex(fed.hash))
        return { paymentHash, amountMsat: fed.amountMsat, request: fed.request, already: true, expirySeconds: 3600 };
      return { paymentHash, amountMsat, request: 'lnbcrt-own-hold', expirySeconds: 3600 };
    },
    async look({ paymentHash }) { return { state: HELD, amountMsat: fed.amountMsat, paidMsat: 0n, paymentHash }; },
    async settle() {}, async cancel() {},
    async decode({ request }) {
      if (request !== fed.request) throw new Error('not an invoice this endpoint can read');
      return { paymentHash: fed.hash, amountMsat: fed.amountMsat };
    },
  };
  return { fed, federation, lightning };
}

const get = async (port, path) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await r.text();
  return { status: r.status, body, json: r.status === 200 ? JSON.parse(body) : null };
};

async function paying(node, c) {
  const rid = roundId(c);
  const opened = await fetch(`http://127.0.0.1:${node.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
  assert.equal(opened.status, 201, await opened.text());
  assumeAssigned(node.round, rid, c.nodes);
  return rid;
}

test('a node with no federation makes no federation invoice', async () => {
  const { lightning } = federationAndEndpoint();
  const node = await serve(openStore(':memory:'), { port: 0, funded: () => true, ...READY, lightning });
  try {
    const rid = await paying(node, contractFor(node.round.pubkey));
    const r = await get(node.port, `/federation-invoice?round=${toHex(rid)}`);
    assert.equal(r.status, 409, r.body);
  } finally { await node.close(); }
});

test('a paying round gets the federation\'s invoice for its net stake, and an entry committing to that hash - no shares dealt - is joined and quoted that same invoice', async () => {
  const { fed, federation, lightning } = federationAndEndpoint();
  const node = await serve(openStore(':memory:'), { port: 0, funded: () => true, ...READY, lightning, federation });
  try {
    const c = contractFor(node.round.pubkey);
    const rid = await paying(node, c);
    const r = await get(node.port, `/federation-invoice?round=${toHex(rid)}`);
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(fed.asked, [NET], 'the federation was not asked for the net stake');
    assert.equal(r.json.paymentHash, toHex(fed.hash));
    assert.equal(r.json.amountMsat, String(NET));
    assert.equal(r.json.request, fed.request);

    const entry = {
      roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: fed.hash, stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
      joinTick: 0, worldSecret: b32(0x16), vssSharesRef: NO_SHARES, stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    };
    const joined = await fetch(`http://127.0.0.1:${node.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(joined.status, 201, await joined.text());
    const quote = await get(node.port, `/invoice?entry=${toHex(entryId(entry))}`);
    assert.equal(quote.status, 200, quote.body);
    assert.equal(quote.json.request, fed.request, 'the entry was quoted an invoice other than the federation\'s');
    assert.equal(quote.json.paymentHash, toHex(fed.hash));
    assert.equal(quote.json.amountMsat, String(NET));
  } finally { await node.close(); }
});

// ONE ARITHMETIC AT THIS DOOR TOO (M3.2 6e). The donation comes out of the stake,
// so a 2% donor's hold is the stake less the fee and the donation - `netStakeMsat`,
// which every other door reads. Measured before: this door asked the federation
// for the stake less the fee only, whatever the player donates.
test('a 2% donor\'s federation invoice is for the stake less the fee and the donation, and the donor\'s entry is joined and quoted on it', async () => {
  const DONATION = STAKE * 2n / 100n;
  const { fed, federation, lightning } = federationAndEndpoint();
  const node = await serve(openStore(':memory:'), { port: 0, funded: () => true, ...READY, lightning, federation });
  try {
    const c = contractFor(node.round.pubkey);
    const rid = await paying(node, c);
    const r = await get(node.port, `/federation-invoice?round=${toHex(rid)}&donation=${DONATION}`);
    const entry = {
      roundId: rid, playerPubkey: b32(6), sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: fed.hash, stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: DONATION,
      joinTick: 0, worldSecret: b32(0x17), vssSharesRef: NO_SHARES, stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    };
    const joined = await fetch(`http://127.0.0.1:${node.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    const joinedBody = await joined.text();
    const quote = await get(node.port, `/invoice?entry=${toHex(entryId(entry))}`);
    console.log('  FACTS (2% donor):', JSON.stringify({ asked: fed.asked.map(String), invoice: r.json && r.json.amountMsat,
      entry: joined.status, quote: quote.status, quoted: quote.json ? quote.json.amountMsat : quote.body.trim().slice(0, 200) }));
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(fed.asked, [NET - DONATION], 'the federation was not asked for the stake less the fee and the donation');
    assert.equal(r.json.amountMsat, String(NET - DONATION));
    assert.equal(joined.status, 201, joinedBody);
    assert.equal(quote.status, 200, quote.body);
    assert.equal(quote.json.paymentHash, toHex(fed.hash));
    assert.equal(quote.json.amountMsat, String(NET - DONATION));
  } finally { await node.close(); }
});

test('a donation this door cannot read, or one the stake cannot hold, gets no invoice and asks the federation nothing', async () => {
  const { fed, federation, lightning } = federationAndEndpoint();
  const node = await serve(openStore(':memory:'), { port: 0, funded: () => true, ...READY, lightning, federation });
  try {
    const rid = await paying(node, contractFor(node.round.pubkey));
    for (const bad of ['-1', '1.5', 'abc', '0x10', String(NET + 1n)]) {
      const r = await get(node.port, `/federation-invoice?round=${toHex(rid)}&donation=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 400, `donation ${bad}: ${r.status} ${r.body}`);
    }
    assert.deepEqual(fed.asked, [], 'the federation was asked for an invoice on a donation the door refused');
    const none = await get(node.port, `/federation-invoice?round=${toHex(rid)}`);
    assert.equal(none.status, 200, none.body);
    assert.deepEqual(fed.asked, [NET], 'no donation named is a 0 donation');
  } finally { await node.close(); }
});

test('a free round, and an invoice for any other amount, are refused', async () => {
  const skewed = federationAndEndpoint({ skewMsat: 1000n });
  const node = await serve(openStore(':memory:'), {
    port: 0, funded: () => true, ...READY, lightning: skewed.lightning, federation: skewed.federation,
  });
  try {
    const free = await paying(node, contractFor(node.round.pubkey, 0n, 0x44));
    assert.equal((await get(node.port, `/federation-invoice?round=${toHex(free)}`)).status, 409);
    const rid = await paying(node, contractFor(node.round.pubkey));
    const r = await get(node.port, `/federation-invoice?round=${toHex(rid)}`);
    assert.equal(r.status, 502, `an invoice for net + 1000 msat was handed out: ${r.body}`);
    assert.equal((await get(node.port, `/federation-invoice?round=${'ab'.repeat(32)}`)).status, 404);
  } finally { await node.close(); }
});
