// ENTER, PAY, PLAY, SETTLE - AND THE CLIENT CANNOT PAY.
//
// M3.2 item 5 is "`@blwp/client`: the session flow: enter, pay, play, settle".
// Three of those four are in and measured elsewhere. This file is the fourth,
// and it starts as the measurement of its absence.
//
// WHAT THE CLIENT CAN DO TODAY, by method: `openRound`, `join` and `entryFor`
// are ENTER; `connect`, `record`, `drain`, `markNow`, `resume` and `reconnect`
// are PLAY. There is no method that asks what this seat owes, and the words
// invoice, bolt11 and payment_request appear in `blwp-client/src` only inside
// comments explaining that a wallet is M3.2.
//
// AND THE RULE THAT CHECKS AN INVOICE LIVES ONLY ON THE NODE. `server.js` says
// it in its own words at the `/invoice` door - "the player's wallet checks the
// invoice against their own contract before paying; `invoiceMatchesEntry` is
// that rule and it lives on their side too" - and it does not. Zero callers in
// `blwp-client/src`. A player who cannot check what they are asked to pay is a
// player paying whatever a node says.
//
// The daemon's half is ready: `/invoice` answers the payment hash, the amount
// and the request. What is missing is a client that asks, and checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { Client } from '../src/client.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../protocol/src/contracts.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { invoiceMatchesEntry, HELD } from '../../protocol/src/payout.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { sha256, toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const rand = (n) => new Uint8Array(randomBytes(n));
const NOW = 1788700000000;
const STAKE = 100000n;
const session = ed25519.utils.randomSecretKey();

const contractFor = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1),
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});

/** A Lightning node that keeps a call log and no money. */
function fakePort() {
  const calls = [];
  return {
    calls,
    async createHeld({ paymentHash, amountMsat, entryId: id }) {
      calls.push(['createHeld', toHex(paymentHash)]);
      return { paymentHash, amountMsat, request: 'lnbcrt-' + toHex(id).slice(0, 12) };
    },
    async look({ paymentHash }) { calls.push(['look', toHex(paymentHash)]); return { state: HELD }; },
    async settle({ paymentHash }) { calls.push(['settle', toHex(paymentHash)]); },
    async cancel({ paymentHash }) { calls.push(['cancel', toHex(paymentHash)]); },
  };
}

/** A daemon with a Lightning port, one round open, and one seat taken. */
async function seated({ port = fakePort() } = {}) {
  const node = await serve(openStore(':memory:'), {
    port: 0, funded: () => true, now: () => NOW, lightning: port,
  });
  const contract = contractFor([node.round.pubkey]);
  const rid = roundId(contract);
  await fetch(`http://127.0.0.1:${node.port}/round`,
    { method: 'POST', body: encodeRoundContract(contract) });

  const preimage = rand(32);
  const entry = {
    roundId: rid, playerPubkey: schnorr.getPublicKey(rand(32)),
    sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(preimage),
    stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: rand(32), vssSharesRef: new Uint8Array(32),
  };
  const took = await fetch(`http://127.0.0.1:${node.port}/entry`,
    { method: 'POST', body: encodeEntryContract(entry) });
  assert.equal(took.status, 201, await took.text());

  const client = new Client({
    base: `http://127.0.0.1:${node.port}`, core: {},
    sign: async (m) => ed25519.sign(m, session), verify: () => true,
  });
  return { node, contract, rid, entry, eid: entryId(entry), client, port,
    close: () => node.close() };
}

/**
 * THE FOUR WORDS OF ITEM 5, COUNTED AGAINST THE CLIENT'S OWN SURFACE.
 */
test('the client can enter and play, and has no way to pay', async () => {
  const c = await seated();
  try {
    for (const m of ['openRound', 'join', 'entryFor'])
      assert.equal(typeof c.client[m], 'function', `ENTER is missing ${m}`);
    for (const m of ['connect', 'record', 'drain', 'markNow', 'resume', 'reconnect'])
      assert.equal(typeof c.client[m], 'function', `PLAY is missing ${m}`);

    // PAY: there is no method at all.
    const pays = ['invoice', 'quote', 'owed', 'pay', 'amountOwed']
      .filter((m) => typeof c.client[m] === 'function');
    assert.deepEqual(pays, [],
      `the client can pay now (${pays.join(', ')}) - item 5 has moved, update this pin`);
    console.log('  enter: 3 methods · play: 6 methods · pay: 0 methods');

    // AND THE WORD APPEARS IN THE SOURCE ONLY IN COMMENTS.
    const dir = new URL('../src/', import.meta.url);
    const code = readdirSync(dir).filter((f) => f.endsWith('.js'))
      .map((f) => ({ f, text: readFileSync(new URL(f, dir), 'utf8') }));
    const speaks = code.filter((s) => s.text.split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .some((l) => /invoice|bolt11|payment_request|paymentHash/i.test(l)));
    assert.deepEqual(speaks.map((s) => s.f), [],
      'a source file says invoice outside a comment - item 5 has moved, update this pin');
    console.log('  files in blwp-client/src that name an invoice outside a comment: 0');
  } finally { await c.close(); }
});

/**
 * AND THE RULE FOR CHECKING ONE IS ON THE WRONG SIDE.
 *
 * `server.js` says at its own `/invoice` door that `invoiceMatchesEntry` "lives
 * on their side too". It does not: the only callers are the daemon's.
 */
test('the rule a player checks an invoice with has no caller on the player\'s side', () => {
  const dir = new URL('../src/', import.meta.url);
  const callers = readdirSync(dir).filter((f) => f.endsWith('.js'))
    .filter((f) => /invoiceMatchesEntry\s*\(/.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.deepEqual(callers, [],
    'the client checks its own invoice now - item 5 has moved, update this pin');

  // The rule itself works, and it is the daemon that has been running it.
  const entry = { stakeMsat: STAKE, stakeCommitment: b32(9) };
  const right = invoiceMatchesEntry({ paymentHash: b32(9), amountMsat: STAKE, entry });
  assert.equal(right.ok, true, right.why);
  const wrongAmount = invoiceMatchesEntry({ paymentHash: b32(9), amountMsat: STAKE + 1n, entry });
  assert.equal(wrongAmount.ok, false);
  const wrongHash = invoiceMatchesEntry({ paymentHash: b32(8), amountMsat: STAKE, entry });
  assert.equal(wrongHash.ok, false);
  console.log('  invoiceMatchesEntry callers in blwp-client/src: 0');
  console.log(`  and the rule holds: right pair stands, wrong amount "${wrongAmount.why}"`);
});

/**
 * THE DAEMON'S HALF IS READY, which is what makes this a client letter.
 *
 * The door answers the payment hash, the amount and the request, and the hash
 * is the entry's own `stakeCommitment` - so a player CAN check it, once they
 * have something that asks.
 */
test('the door already quotes what this seat owes', async () => {
  const c = await seated();
  try {
    // ONE READ OF THE BODY. `assert.equal(r.status, 200, await r.text())` then
    // `r.json()` throws "Body is unusable" - a test failing for its own reason
    // and hiding what the door actually said. `handout-accept.test.js` has the
    // same note; this made the same mistake anyway.
    const r = await fetch(`http://127.0.0.1:${c.node.port}/invoice?entry=${toHex(c.eid)}`);
    const said = await r.text();
    assert.equal(r.status, 200, said);
    const quoted = JSON.parse(said);

    assert.equal(quoted.paymentHash, toHex(c.entry.stakeCommitment),
      'the node quoted a hash that is not the entry\'s own commitment');
    assert.equal(quoted.amountMsat, String(STAKE));
    assert.ok(quoted.request.startsWith('lnbcrt-'), 'no payment request came back');
    console.log(`  /invoice: ${quoted.amountMsat} msat against hash `
      + `${quoted.paymentHash.slice(0, 16)}…, state ${quoted.state}`);

    // AND THE RULE ACCEPTS IT - so what is missing is only the asking.
    const checked = invoiceMatchesEntry({
      paymentHash: c.entry.stakeCommitment,
      amountMsat: BigInt(quoted.amountMsat),
      entry: c.entry,
    });
    assert.equal(checked.ok, true, checked.why);
    console.log('  and invoiceMatchesEntry accepts it - the client just cannot ask');
  } finally { await c.close(); }
});
