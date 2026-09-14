// ENTER, ASK WHAT IS OWED, CHECK IT, PLAY.
//
// M3.2 item 5 is "`@blwp/client`: the session flow: enter, pay, play, settle".
// This file was written as the measurement of the missing fourth - 0 methods
// that could ask what a seat owes - and it is the pin after it.
//
// THE CLIENT ASKS AND CHECKS. IT STILL DOES NOT PAY, and that is the split:
// the wallet is item 6, and it is item 6 because the client is what defines
// the question it will be asked. `invoice()` fetches the quote and runs the
// protocol's own rule over it; there is no method here that sends a satoshi.
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
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
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
// 6e: the hold is the NET stake - 100000 committed, the 2% fee out of it (22A).
const NET = STAKE - entryFeeMsat(STAKE);
const session = ed25519.utils.randomSecretKey();

const contractFor = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1),
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'THRESHOLD_LN', slashMinimumServed: 20,
  slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'] /* a paying round names a relay (§13A); never posted to here */, donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
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
    port: 0, funded: () => true, now: () => NOW, preflight: async () => ({ ready: true, why: "test port" }), lightning: port,
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
    joinTick: 0, worldSecret: rand(32), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
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
test('the client can enter, ask what it owes, and play - and cannot send a satoshi', async () => {
  const c = await seated();
  try {
    for (const m of ['openRound', 'join', 'entryFor'])
      assert.equal(typeof c.client[m], 'function', `ENTER is missing ${m}`);
    for (const m of ['connect', 'record', 'drain', 'markNow', 'resume', 'reconnect'])
      assert.equal(typeof c.client[m], 'function', `PLAY is missing ${m}`);

    // ASK: one method, and it is the whole pay surface of this letter.
    assert.equal(typeof c.client.invoice, 'function', 'the client cannot ask what it owes');

    // AND EXACTLY TWO THINGS THAT SEND MONEY: the stake (item 6) and the
    // player's donation (M3.2 6e, ruled 2026-09-13, pick A) - each a method of
    // this Client, each taking an entry and never an invoice. While item 5
    // stood alone this was 0; from item 6 until the donation was paid it was 1.
    //
    // `send` IS NOT ON THIS LIST and was, wrongly: `Client.send` puts a
    // protocol message on the play socket and has since the first batch went
    // out. A probe that cannot tell a websocket write from a payment would
    // fail on every future letter for the wrong reason.
    const sends = ['pay', 'payInvoice', 'sendPayment', 'nwc', 'wallet', 'payStake', 'payDonation']
      .filter((m) => typeof c.client[m] === 'function');
    assert.deepEqual(sends, ['payStake', 'payDonation'],
      `methods that move a satoshi: ${sends.join(', ') || 'none'}`);
    console.log('  enter: 3 methods · ask: 1 · play: 6 · moves a satoshi: 2 (payStake, payDonation)');

    // AND THE FOURTH WORD IS NOT A NAME COLLISION ANY MORE. `settle()` waited
    // for two promises and settled nothing; 9.4's settle is a stake moving
    // after a round is final.
    assert.equal(typeof c.client.settle, 'undefined',
      'settle() is back, and it does not settle anything');
    assert.equal(typeof c.client.awaitPublishes, 'function');

    // AND THE WORD IS IN THE CODE NOW, IN ONE FILE. Before this letter
    // `invoice`, `bolt11` and `paymentHash` appeared in `blwp-client/src` only
    // inside comments explaining that a wallet was M3.2 - 0 files named one in
    // code. One does: the file that asks and checks.
    const dir = new URL('../src/', import.meta.url);
    const code = readdirSync(dir).filter((f) => f.endsWith('.js'))
      .map((f) => ({ f, text: readFileSync(new URL(f, dir), 'utf8') }));
    const speaks = code.filter((s) => s.text.split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .some((l) => /invoice|bolt11|payment_request|paymentHash/i.test(l)));
    // page-lock.js (W1b) names one too: the deposit invoice the player's OWN
    // lock client makes, which the player's wallet pays into their own
    // federation wallet. No node quotes it - so the rule that matters is kept
    // below, exactly: only client.js asks a node what a player owes.
    assert.deepEqual(speaks.map((s) => s.f).sort(), ['client.js', 'nwc.js', 'page-lock.js'],
      'the ask moved out of client.js, or a second file learned to quote a player');
    const asksANode = code.filter((s) => s.text.split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .some((l) => /\/invoice\?/.test(l)));
    assert.deepEqual(asksANode.map((s) => s.f), ['client.js'],
      'a second file asks a node to quote a player');
    console.log(`  files in blwp-client/src that name an invoice in code: `
      + `${speaks.length} (${speaks.map((s) => s.f).join(', ')})`);
  } finally { await c.close(); }
});

/**
 * AND THE RULE FOR CHECKING ONE IS ON THE WRONG SIDE.
 *
 * `server.js` says at its own `/invoice` door that `invoiceMatchesEntry` "lives
 * on their side too". It does not: the only callers are the daemon's.
 */
test('the client checks an invoice with the protocol\'s own rule, not a second formula', () => {
  const dir = new URL('../src/', import.meta.url);
  const callers = readdirSync(dir).filter((f) => f.endsWith('.js'))
    .filter((f) => /invoiceMatchesEntry\s*\(/.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.deepEqual(callers, ['client.js'],
    'the client no longer runs the rule, or a second file does');

  // AND IT IS IMPORTED. A copy of the comparison here would be a second
  // opinion about the one number a player is about to part with money over.
  const code = readFileSync(new URL('client.js', dir), 'utf8');
  assert.match(code, /import \{ invoiceMatchesEntry \} from '\.\.\/\.\.\/protocol\/src\/payout\.js'/,
    'the client restates the rule instead of importing it');

  // The rule itself works, and it is the daemon that has been running it.
  const entry = { stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n, stakeCommitment: b32(9) };
  const right = invoiceMatchesEntry({ paymentHash: b32(9), amountMsat: NET, entry });
  assert.equal(right.ok, true, right.why);
  const wrongAmount = invoiceMatchesEntry({ paymentHash: b32(9), amountMsat: NET + 1n, entry });
  assert.equal(wrongAmount.ok, false);
  const wrongHash = invoiceMatchesEntry({ paymentHash: b32(8), amountMsat: NET, entry });
  assert.equal(wrongHash.ok, false);
  console.log(`  invoiceMatchesEntry callers in blwp-client/src: ${callers.length} (${callers.join(', ')}), imported`);
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
    assert.equal(quoted.amountMsat, String(NET), 'the door quoted something other than the net stake (22A)');
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
    console.log('  and invoiceMatchesEntry accepts it - which is what the client now runs');
  } finally { await c.close(); }
});

/**
 * THE ASK, AGAINST A REAL DAEMON - the honest pair accepted.
 */
test('the client asks the node what it owes and the honest quote stands', async () => {
  const c = await seated();
  try {
    const got = await c.client.invoice(c.entry, { entryId: c.eid });
    assert.equal(got.ok, true, got.why);
    assert.equal(got.amountMsat, NET);
    assert.deepEqual(got.paymentHash, c.entry.stakeCommitment,
      'the hash the client accepted is not the one its own entry commits to');
    assert.ok(got.request.startsWith('lnbcrt-'), 'no payment request came back');
    assert.equal(got.state, HELD);
    console.log(`  ${got.amountMsat} msat against this entry's own hash, `
      + `state ${got.state}: "${got.why}"`);

    // AND ASKING DOES NOT PAY. The fake port was asked to CREATE a hold and
    // nothing else - no settle, no cancel.
    const acts = c.port.calls.map((x) => x[0]);
    assert.equal(acts.includes('settle'), false, 'asking for an invoice settled a stake');
    assert.equal(acts.includes('cancel'), false, 'asking for an invoice cancelled a stake');
    console.log(`  the Lightning port saw: ${[...new Set(acts)].join(', ')} - nothing that moves money`);
  } finally { await c.close(); }
});

/**
 * AND A NODE THAT QUOTES SOMETHING ELSE IS REFUSED, BY THE PLAYER.
 *
 * A LYING NODE, NOT A MUTATED ENTRY. These were written by changing the
 * client's own entry - `{ ...entry, stakeMsat: STAKE - 1n }` - which is not the
 * threat and is now caught earlier anyway, because changing an entry changes
 * its id. The threat is a node that answers the RIGHT entry id with the WRONG
 * numbers, so that is what this stands up.
 */
async function liar(quote) {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(quote) + '\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test('a node that quotes a wrong amount or a wrong hash is refused by the player', async () => {
  const c = await seated();
  const honest = {
    entry: toHex(c.eid), paymentHash: toHex(c.entry.stakeCommitment),
    amountMsat: String(NET), state: HELD, request: 'lnbcrt-liar',
  };
  try {
    // ASKS FOR MORE THAN THE ENTRY STAKED.
    const greedy = await liar({ ...honest, amountMsat: String(STAKE * 2n) });
    c.client.base = `http://127.0.0.1:${greedy.port}`;
    const over = await c.client.invoice(c.entry, { entryId: c.eid });
    assert.equal(over.ok, false, 'the client took a quote for twice what its entry staked');
    assert.match(over.why, /asks 200000 msat and this entry holds 98000/);
    console.log(`  wrong amount: ${over.why}`);
    await greedy.close();

    // QUOTES A HASH THIS ENTRY NEVER COMMITTED TO - nobody could ever settle
    // it, so paying would be money gone with no round attached to it.
    const elsewhere = await liar({ ...honest, paymentHash: toHex(b32(0xee)) });
    c.client.base = `http://127.0.0.1:${elsewhere.port}`;
    const stranger = await c.client.invoice(c.entry, { entryId: c.eid });
    assert.equal(stranger.ok, false, 'the client accepted a hash its entry never signed');
    assert.match(stranger.why, /nobody could ever settle it/);
    console.log(`  wrong hash: ${stranger.why.slice(0, 78)}…`);

    // AND A REFUSAL HANDS BACK WHAT WAS QUOTED, so a player can see what they
    // were asked for rather than only that it was wrong.
    assert.ok(stranger.quoted && stranger.quoted.request, 'the refusal hid the quote');
    await elsewhere.close();

    // AND RUBBISH IS NOT A QUOTE. A node answering 200 with nothing useful
    // must not read as an invoice with undefined fields.
    const junk = await liar({ hello: 'there' });
    c.client.base = `http://127.0.0.1:${junk.port}`;
    const bad = await c.client.invoice(c.entry, { entryId: c.eid });
    assert.equal(bad.ok, false);
    assert.match(bad.why, /not an invoice quote|carries no payment request/);
    console.log(`  rubbish: ${bad.why}`);
    await junk.close();
  } finally { await c.close(); }
});

/**
 * AND THE DOOR'S OWN REFUSALS REACH THE PLAYER AS WORDS.
 */
test('a node that seated nobody, and one with no Lightning, are refused by name', async () => {
  const c = await seated();
  try {
    // AN ENTRY THIS NODE NEVER TOOK - and it has to be a REAL entry asking
    // about its OWN id, or the client refuses it before the door is reached.
    // Written first as `invoice(c.entry, { entryId: b32(0x77) })`, which is a
    // crossed pair and is now caught here rather than there.
    const never = { ...c.entry, worldSecret: rand(32), stakeCommitment: sha256(rand(32)) };
    const stranger = await c.client.invoice(never, { entryId: entryId(never) });
    assert.equal(stranger.ok, false);
    assert.equal(stranger.status, 404);
    assert.match(stranger.why, /seated no such entry/);
    console.log(`  an entry the node never took: ${stranger.status} ${stranger.why}`);
  } finally { await c.close(); }

  // A daemon with no Lightning port at all quotes nothing, and says why.
  const dark = await seated({ port: null });
  try {
    const none = await dark.client.invoice(dark.entry, { entryId: dark.eid });
    assert.equal(none.ok, false);
    assert.equal(none.status, 503);
    console.log(`  a node with no Lightning: ${none.status} ${none.why}`);
  } finally { await dark.close(); }
});

test('an invoice cannot be asked for without an entry or an entry id', async () => {
  const c = await seated();
  try {
    assert.match((await c.client.invoice(null, { entryId: c.eid })).why, /no entry to check/);
    assert.match((await c.client.invoice(c.entry)).why, /no entry id to ask about/);
  } finally { await c.close(); }
});

/**
 * AND A CROSSED OR STALE PAIR IS REFUSED AS TWO SEATS, not as two hashes.
 *
 * Measured before this check existed: asking about one seat's id while holding
 * another's contract WAS refused - by the payment hash differing. That is the
 * right answer for the wrong reason, and it stops being the right answer when
 * the two entries share a commitment: a player re-entering one round keeps
 * their preimage and changes their world secret, so two ids, one hash, one
 * amount, and the other seat's quote would be accepted as this one's.
 */
test('an entry that is not the one being asked about is refused as two seats', async () => {
  const c = await seated();
  try {
    // The same player, the same preimage, a second seat: two ids, one hash.
    const again = { ...c.entry, worldSecret: rand(32) };
    const took = await fetch(`http://127.0.0.1:${c.node.port}/entry`,
      { method: 'POST', body: encodeEntryContract(again) });
    assert.equal(took.status, 201, await took.text());
    assert.deepEqual(again.stakeCommitment, c.entry.stakeCommitment, 'the fixture changed the hash');
    assert.notDeepEqual(entryId(again), c.eid, 'the fixture made one entry, not two');

    // Its own id: accepted.
    const own = await c.client.invoice(again, { entryId: entryId(again) });
    assert.equal(own.ok, true, own.why);

    // The OTHER seat's id, with an identical hash and amount - the case the
    // hash check cannot catch.
    const crossed = await c.client.invoice(again, { entryId: c.eid });
    assert.equal(crossed.ok, false, 'a quote for another seat was accepted as this one\'s');
    assert.match(crossed.why, /they are two seats/);
    console.log(`  same hash, same amount, different seat: ${crossed.why}`);
  } finally { await c.close(); }
});
