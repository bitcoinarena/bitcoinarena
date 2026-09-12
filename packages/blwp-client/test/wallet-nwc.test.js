// A CONNECTED WALLET PAYS THE HOLD INVOICE THIS SEAT OWES, AND NOTHING ELSE.
//
// M3.2 item 6. The client could already ask what a seat owes and refuse a quote
// its own entry did not sign; `payStake` is the one method in it that moves a
// satoshi.
//
// A FAKE RELAY AND A FAKE WALLET THAT RECORD EVERY REQUEST, the same shape the
// node side uses for Lightning. What is measured is not "did some payment
// happen" but WHICH bolt11 reached the wallet, and how many requests reached it
// when the quote was one the entry did not sign - the answer there has to be
// zero, and zero is a thing you can only see by counting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';
import { roundLocks } from '../src/join.js';
import { lockLine } from '../src/page-lock.js';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { Client } from '../src/client.js';
import { pageCurve } from '../src/page-curve.js';
import {
  parseConnection, nip04Encrypt, nip04Decrypt, signEvent, payInvoice,
  tabWallet, spendLog, spentLine, walletBudget, budgetLine,
  NWC_REQUEST, NWC_RESPONSE,
} from '../src/nwc.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../protocol/src/contracts.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { HELD } from '../../protocol/src/payout.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { sha256, toHex } from '../../protocol/src/hash.js';
import { owedLine } from '../src/nwc.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const rand = (n) => new Uint8Array(randomBytes(n));
const NOW = 1788700000000;
const STAKE = 100000n;
// 6e: the hold is the NET stake - 100000 committed, the 2% fee out of it (22A).
const NET = STAKE - entryFeeMsat(STAKE);
const PREIMAGE = 'ab'.repeat(32);
const session = ed25519.utils.randomSecretKey();

/**
 * A NOSTR RELAY AND A WALLET BEHIND IT.
 *
 * The relay is NIP-01's own three frames - REQ, EVENT, OK - and the wallet
 * opens the request the way a real one does: NIP-04 with the connection's
 * shared secret. `asked` is every invoice it was told to pay, which is the
 * number this file is really about.
 */
async function walletOnARelay({ answer = null, secret = rand(32) } = {}) {
  const walletSecret = secret;
  const walletPubkey = pageCurve.pointX(walletSecret);
  const asked = [];
  const wss = new WebSocketServer({ port: 0 });

  wss.on('connection', (sock) => {
    const filters = new Map();
    sock.on('message', async (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      if (frame[0] === 'REQ') { filters.set(frame[1], frame[2]); return; }
      if (frame[0] !== 'EVENT') return;
      const event = frame[1];
      sock.send(JSON.stringify(['OK', event.id, true, '']));
      if (event.kind !== NWC_REQUEST) return;

      // The wallet opens it with ITS key against the client's pubkey - the
      // other side of the same agreement.
      const opened = await nip04Decrypt(event.content, {
        secret: walletSecret, theirPubkey: Uint8Array.from(Buffer.from(event.pubkey, 'hex')),
        curve: pageCurve,
      });
      if (!opened.ok) return;
      const said = JSON.parse(opened.plaintext);
      if (said.method === 'pay_invoice') asked.push(said.params.invoice);
      asked.methods = (asked.methods || []).concat(said.method);

      const body = answer
        ? answer(said)
        : { result_type: 'pay_invoice', result: { preimage: PREIMAGE, fees_paid: 0 } };
      if (!body) return;
      const content = await nip04Encrypt(JSON.stringify(body), {
        secret: walletSecret,
        theirPubkey: Uint8Array.from(Buffer.from(event.pubkey, 'hex')),
        curve: pageCurve, random: rand,
      });
      const reply = await signEvent({
        kind: NWC_RESPONSE,
        tags: [['p', event.pubkey], ['e', event.id]],
        content, secret: walletSecret, curve: pageCurve,
      });
      for (const [sub] of filters) sock.send(JSON.stringify(['EVENT', sub, reply]));
    });
  });

  const port = wss.address().port;
  const connectionSecret = rand(32);
  return {
    asked, walletPubkey,
    uri: `nostr+walletconnect://${toHex(walletPubkey)}`
      + `?relay=ws://127.0.0.1:${port}&secret=${toHex(connectionSecret)}`,
    close: () => new Promise((r) => wss.close(r)),
  };
}

/** A Lightning node that keeps a call log and no money. */
function fakePort() {
  const calls = [];
  return {
    calls,
    async createHeld({ paymentHash, amountMsat, entryId: id }) {
      calls.push('createHeld');
      return { paymentHash, amountMsat, request: 'lnbcrt1-' + toHex(id).slice(0, 20) };
    },
    async look() { return { state: HELD }; },
    async settle() { calls.push('settle'); },
    async cancel() { calls.push('cancel'); },
  };
}

const contractFor = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1),
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'] /* a paying round names a relay (§13A); never posted to here */, donationSetId: b32(0xd0), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});

/** A daemon with Lightning, a round open, and one seat taken. */
async function seated() {
  const port = fakePort();
  const node = await serve(openStore(':memory:'), {
    port: 0, funded: () => true, now: () => NOW, preflight: async () => ({ ready: true, why: "test port" }), lightning: port,
  });
  const contract = contractFor([node.round.pubkey]);
  const rid = roundId(contract);
  await fetch(`http://127.0.0.1:${node.port}/round`,
    { method: 'POST', body: encodeRoundContract(contract) });
  const entry = {
    roundId: rid, playerPubkey: schnorr.getPublicKey(rand(32)),
    sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(rand(32)),
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
  return { node, entry, eid: entryId(entry), client, port, close: () => node.close() };
}

const pays = { curve: pageCurve, random: rand, WebSocketImpl: (await import('ws')).WebSocket };

test('a connection string is taken apart, and a broken one is refused by name', () => {
  const secret = toHex(rand(32));
  const wallet = toHex(rand(32));
  const good = parseConnection(
    `nostr+walletconnect://${wallet}?relay=wss://relay.example&secret=${secret}`);
  assert.equal(good.ok, true, good.why);
  assert.equal(toHex(good.walletPubkey), wallet);
  assert.equal(toHex(good.secret), secret);
  assert.match(good.relay, /^wss:\/\/relay\.example/);

  const bad = [
    ['', /no connection string/],
    ['lnbc1...', /not a wallet connection string|is lnbc1/],
    [`https://x?relay=wss://r&secret=${secret}`, /a wallet connection is nostr\+walletconnect/],
    [`nostr+walletconnect://zz?relay=wss://r&secret=${secret}`, /no 32-byte wallet key/],
    [`nostr+walletconnect://${wallet}?secret=${secret}`, /no relay/],
    [`nostr+walletconnect://${wallet}?relay=http://r&secret=${secret}`, /a relay is ws or wss/],
    [`nostr+walletconnect://${wallet}?relay=wss://r`, /no 32-byte secret/],
  ];
  for (const [uri, why] of bad) {
    const said = parseConnection(uri);
    assert.equal(said.ok, false, `"${uri}" was accepted`);
    assert.match(said.why, why);
  }
  console.log(`  1 connection parsed, ${bad.length} broken ones refused by name`);
});

test('NIP-04 goes both ways over the shared secret, and only for the pair it was sealed to', async () => {
  const mine = rand(32);
  const theirs = rand(32);
  const stranger = rand(32);
  const sealed = await nip04Encrypt('pay_invoice', {
    secret: mine, theirPubkey: pageCurve.pointX(theirs), curve: pageCurve, random: rand,
  });
  assert.match(sealed, /\?iv=/, 'NIP-04 carries its iv on the content');

  const theirSide = await nip04Decrypt(sealed, {
    secret: theirs, theirPubkey: pageCurve.pointX(mine), curve: pageCurve,
  });
  assert.equal(theirSide.ok, true, theirSide.why);
  assert.equal(theirSide.plaintext, 'pay_invoice');

  const nosy = await nip04Decrypt(sealed, {
    secret: stranger, theirPubkey: pageCurve.pointX(mine), curve: pageCurve,
  });
  assert.equal(nosy.ok, false, 'a third key opened an envelope it was not sealed to');
  console.log(`  the pair opens it; a stranger gets "${nosy.why}"`);
});

/**
 * THE NUMBER THAT CLOSES THE LETTER: the wallet is asked to pay the invoice
 * this seat's own quote produced, and that one only.
 */
test('a connected wallet pays the hold invoice this seat owes', async () => {
  const c = await seated();
  const w = await walletOnARelay();
  try {
    const quoted = await c.client.invoice(c.entry, { entryId: c.eid });
    assert.equal(quoted.ok, true, quoted.why);

    const paid = await c.client.payStake(c.entry, { connection: w.uri, entryId: c.eid, ...pays });
    assert.equal(paid.ok, true, paid.why);
    assert.equal(paid.paid, true);
    assert.equal(paid.preimage, PREIMAGE);
    assert.equal(paid.amountMsat, NET);
    assert.deepEqual(paid.paymentHash, c.entry.stakeCommitment,
      'the hash paid against is not the one this entry commits to');

    // THE WALLET WAS ASKED FOR EXACTLY ONE INVOICE, AND IT IS THE QUOTE'S.
    assert.equal(w.asked.length, 1, `the wallet was asked ${w.asked.length} times`);
    assert.equal(w.asked[0], quoted.request,
      'the wallet was asked to pay something other than this seat\'s quote');
    console.log(`  ${paid.amountMsat} msat, 1 request to the wallet, and it is the quote: `
      + `${w.asked[0]}`);

    // AND THE NODE REPORTS THE HOLD.
    const after = await c.client.invoice(c.entry, { entryId: c.eid });
    assert.equal(after.ok, true, after.why);
    assert.equal(after.state, HELD);
    console.log(`  the node now reports the hold: ${after.state}`);
  } finally { await w.close(); await c.close(); }
});

/**
 * AND A QUOTE THE ENTRY DID NOT SIGN NEVER REACHES THE WALLET AT ALL.
 *
 * Not "the wallet declines it" - the wallet is never asked. Counted, because
 * zero requests is the only way to see the difference.
 */
test('a quote for another seat sends nothing to the wallet', async () => {
  const c = await seated();
  const w = await walletOnARelay();
  try {
    // A second seat: same round, same player, a different entry.
    const other = { ...c.entry, worldSecret: rand(32) };
    await fetch(`http://127.0.0.1:${c.node.port}/entry`,
      { method: 'POST', body: encodeEntryContract(other) });

    const crossed = await c.client.payStake(other, { connection: w.uri, entryId: c.eid, ...pays });
    assert.equal(crossed.ok, false);
    assert.equal(crossed.asked, false, 'the wallet was asked about a crossed pair');
    assert.match(crossed.why, /they are two seats/);
    assert.equal(w.asked.length, 0, `${w.asked.length} requests reached the wallet`);
    console.log(`  crossed seats: ${w.asked.length} requests to the wallet - "${crossed.why}"`);
  } finally { await w.close(); await c.close(); }
});

test('a lying node sends nothing to the wallet either', async () => {
  const c = await seated();
  const w = await walletOnARelay();
  const http = await import('node:http');
  const honest = {
    entry: toHex(c.eid), paymentHash: toHex(c.entry.stakeCommitment),
    amountMsat: String(NET), state: HELD, request: 'lnbcrt1-liar',
  };
  const liars = [
    [{ ...honest, amountMsat: String(STAKE * 3n) }, /asks 300000 msat/, 'a wrong amount'],
    [{ ...honest, paymentHash: toHex(b32(0xee)) }, /nobody could ever settle it/, 'a wrong hash'],
    [{ nothing: true }, /not an invoice quote|no payment request/, 'rubbish'],
  ];
  try {
    for (const [quote, why, what] of liars) {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(quote) + '\n');
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      c.client.base = `http://127.0.0.1:${server.address().port}`;

      const said = await c.client.payStake(c.entry, { connection: w.uri, entryId: c.eid, ...pays });
      assert.equal(said.ok, false, `${what} was paid`);
      assert.equal(said.asked, false);
      assert.match(said.why, why);
      await new Promise((r) => server.close(r));
    }
    assert.equal(w.asked.length, 0, `${w.asked.length} requests reached the wallet`);
    console.log(`  ${liars.length} lying quotes: ${w.asked.length} requests to the wallet`);
  } finally { await w.close(); await c.close(); }
});

/**
 * A WALLET THAT SAYS NO IS REPORTED IN ITS OWN WORDS.
 *
 * "quota exceeded" is something a player can act on; a client that flattened
 * it to "payment failed" would hide the one sentence that says what to do.
 */
test('a wallet that refuses is reported by name, and nothing is invented', async () => {
  const c = await seated();
  const w = await walletOnARelay({
    answer: () => ({ error: { code: 'QUOTA_EXCEEDED', message: 'budget spent for this hour' } }),
  });
  try {
    const said = await c.client.payStake(c.entry, { connection: w.uri, entryId: c.eid, ...pays });
    assert.equal(said.ok, false);
    assert.equal(said.paid, false);
    assert.equal(said.asked, true, 'the wallet was never asked');
    assert.equal(said.code, 'QUOTA_EXCEEDED');
    assert.match(said.why, /budget spent for this hour/);
    assert.equal(said.preimage, undefined, 'a refusal carried a preimage');
    assert.equal(w.asked.length, 1);
    console.log(`  ${said.why}`);
  } finally { await w.close(); await c.close(); }
});

test('a wallet that claims it paid and shows no preimage is not believed', async () => {
  const c = await seated();
  const w = await walletOnARelay({
    answer: () => ({ result_type: 'pay_invoice', result: { fees_paid: 0 } }),
  });
  try {
    const said = await c.client.payStake(c.entry, { connection: w.uri, entryId: c.eid, ...pays });
    assert.equal(said.ok, false);
    assert.match(said.why, /said it paid and produced no preimage/);
    console.log(`  ${said.why}`);
  } finally { await w.close(); await c.close(); }
});

/**
 * AND THERE IS NO METHOD THAT PAYS AN ARBITRARY INVOICE.
 *
 * `payStake` takes an ENTRY. That is a signature and not a check: no caller can
 * walk this client into paying a bolt11 somebody handed it, because there is no
 * argument to put one in.
 */
test('the client has one method that moves a satoshi, and it takes an entry', () => {
  const p = Client.prototype;
  const moves = ['payStake', 'pay', 'payInvoice', 'sendPayment', 'nwc', 'wallet']
    .filter((m) => typeof p[m] === 'function');
  assert.deepEqual(moves, ['payStake'], `methods that move a satoshi: ${moves.join(', ')}`);

  // The first argument is the entry, and there is no invoice parameter.
  const src = p.payStake.toString();
  assert.match(src, /^async payStake\(entry, \{/, 'payStake no longer takes an entry first');
  assert.equal(/\binvoice\s*[,)]/.test(src.slice(0, src.indexOf('{', 20))), false,
    'payStake takes an invoice as an argument');
  console.log(`  methods that move a satoshi: 1 (${moves[0]}), and it takes an entry`);
});

test('paying needs a connection and a curve, and says which is missing', async () => {
  const c = await seated();
  try {
    assert.match((await c.client.payStake(c.entry, { entryId: c.eid, curve: pageCurve })).why,
      /no wallet connection/);
    assert.match((await c.client.payStake(c.entry, {
      connection: 'nostr+walletconnect://zz?relay=wss://r&secret=x', entryId: c.eid, curve: pageCurve,
    })).why, /no 32-byte wallet key/);
    const w = await walletOnARelay();
    assert.match((await c.client.payStake(c.entry, { connection: w.uri, entryId: c.eid })).why,
      /needs a curve/);
    await w.close();
  } finally { await c.close(); }
});

test('a relay that never answers times out rather than hanging', async () => {
  const c = await seated();
  const wss = new WebSocketServer({ port: 0 });
  try {
    const uri = `nostr+walletconnect://${toHex(pageCurve.pointX(rand(32)))}`
      + `?relay=ws://127.0.0.1:${wss.address().port}&secret=${toHex(rand(32))}`;
    const said = await c.client.payStake(c.entry, {
      connection: uri, entryId: c.eid, ...pays, timeoutMs: 300,
    });
    assert.equal(said.ok, false);
    assert.match(said.why, /did not answer in 300 ms/);
    console.log(`  ${said.why}`);
  } finally { await new Promise((r) => wss.close(r)); await c.close(); }
});

/**
 * A HOLD INVOICE IS PAID LONG BEFORE THE WALLET SAYS SO.
 *
 * A real wallet answers `pay_invoice` when the payment completes, and a hold
 * invoice's payment completes only when the round settles or cancels it -
 * minutes later, and as a FAILURE for every winner, whose stake is cancelled
 * back. So the wallet's silence is the normal case, and the fixture above that
 * answers at once with a preimage is the unusual one. What says the stake is
 * held is the node (23.1 step 5), which now answers exactly that.
 */
test('a wallet that holds the payment and says nothing is paid once the node sees the stake held', async () => {
  const c = await seated();
  const w = await walletOnARelay({ answer: () => null });
  // The node's Lightning shows the HTLC held in full once the wallet was asked.
  c.port.look = async () => ({ state: HELD, amountMsat: NET, paidMsat: w.asked.length ? NET : 0n });
  const spent = [];
  try {
    const said = await c.client.payStake(c.entry, {
      connection: w.uri, entryId: c.eid, ...pays, timeoutMs: 3000,
      log: { record: (r) => spent.push(r) },
    });
    assert.equal(said.ok, true, `a stake the node sees held was reported unpaid: ${said.why}`);
    assert.equal(said.paid, true);
    assert.equal(said.held, true, 'the answer does not say the node saw it held');
    assert.equal(said.preimage, null, 'a preimage was invented for a wallet that has not answered');
    assert.equal(said.amountMsat, NET);
    assert.equal(w.asked.length, 1);
    assert.equal(spent.length, 1, 'a held stake was not written down as spent');
  } finally { await w.close(); await c.close(); }
});

test('a wallet that says nothing while the node never sees the stake is still not paid', async () => {
  const c = await seated();
  const w = await walletOnARelay({ answer: () => null });
  c.port.look = async () => ({ state: HELD, amountMsat: NET, paidMsat: 0n });
  try {
    const said = await c.client.payStake(c.entry, { connection: w.uri, entryId: c.eid, ...pays, timeoutMs: 400 });
    assert.equal(said.ok, false);
    assert.match(said.why, /did not answer in 400 ms/);
  } finally { await w.close(); await c.close(); }
});

/** A per-tab storage, the same fixture `tabSeed`'s own tests use. */
const tab = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    size: () => m.size,
  };
};

test('a tab holds one wallet connection, and a second tab holds none of it', async () => {
  const w = await walletOnARelay();
  try {
    const one = tab();
    const mine = tabWallet({ storage: one });
    assert.equal(mine.connected, false);
    assert.match(mine.current().why, /no wallet connected/);

    const took = mine.connect(w.uri);
    assert.equal(took.ok, true, took.why);
    assert.equal(mine.connected, true);
    assert.deepEqual(mine.current().walletPubkey, w.walletPubkey);

    // A SECOND TAB IS A SECOND STORAGE. `sessionStorage` is per tab, which is
    // why two tabs are two players and neither spends from the other's wallet.
    const theirs = tabWallet({ storage: tab() });
    assert.equal(theirs.connected, false, 'a second tab inherited the first tab\'s wallet');

    // RUBBISH IS NOT REMEMBERED, or the page would offer to pay with it after
    // every reload.
    const bad = tabWallet({ storage: tab() });
    assert.equal(bad.connect('lnbc1-not-a-connection').ok, false);
    assert.equal(bad.connected, false);

    // And a player closing a wallet does not have to close the tab.
    mine.forget();
    assert.equal(mine.connected, false);
    assert.equal(one.size(), 0, 'forgetting left the credential behind');
    console.log('  one tab connects, a second inherits nothing, rubbish is not kept, forget clears it');
  } finally { await w.close(); }
});

/**
 * THE RUNNING TOTAL §24A.1 REQUIRES, AND WHAT IT WAS SPENT ON.
 *
 * Asserted as ENTRIES and not as a number: "what it was spent on" means a round
 * and a payment hash, and a total nobody can break down is a total a page could
 * have invented.
 */
test('every payment is written down with its hash and its round', async () => {
  const c = await seated();
  const w = await walletOnARelay();
  const log = spendLog();
  try {
    assert.equal(log.count, 0);
    assert.equal(log.totalMsat, 0n);
    assert.equal(spentLine(log), 'nothing paid this session');

    c.client.setRound({ roundId: c.entry.roundId, entryId: c.eid, blockTicks: 9000 });
    const paid = await c.client.payStake(c.entry, {
      connection: w.uri, entryId: c.eid, log, ...pays,
    });
    assert.equal(paid.ok, true, paid.why);

    assert.equal(log.count, 1);
    assert.equal(log.totalMsat, NET);
    const [one] = log.entries();
    assert.equal(one.amountMsat, NET);
    assert.deepEqual(one.paymentHash, c.entry.stakeCommitment,
      'the log recorded a hash that is not the one this seat paid against');
    assert.deepEqual(one.roundId, c.entry.roundId);
    console.log(`  1 payment logged: ${one.amountMsat} msat against `
      + `${toHex(one.paymentHash).slice(0, 16)}… in round ${toHex(one.roundId).slice(0, 16)}…`);
    console.log(`  and the line the page renders: "${spentLine(log)}"`);

    // A REFUSED PAYMENT WRITES NOTHING. A total that counted attempts would be
    // a total that says a player spent money they still have.
    const other = { ...c.entry, worldSecret: rand(32) };
    await fetch(`http://127.0.0.1:${c.node.port}/entry`,
      { method: 'POST', body: encodeEntryContract(other) });
    const refused = await c.client.payStake(other, {
      connection: w.uri, entryId: c.eid, log, ...pays,
    });
    assert.equal(refused.ok, false);
    assert.equal(log.count, 1, 'a refused payment was counted as spent');
    assert.equal(log.totalMsat, NET);
    console.log(`  a refused payment: still ${log.count} entry, still ${log.totalMsat} msat`);
  } finally { await w.close(); await c.close(); }
});

test('the line a page renders counts sats, stakes and rounds', () => {
  const log = spendLog();
  assert.equal(spentLine(log), 'nothing paid this session');
  assert.equal(spentLine(null), 'nothing paid this session');

  log.record({ amountMsat: 100000n, paymentHash: b32(1), roundId: b32(9) });
  assert.equal(spentLine(log), '100 sat over 1 stake in 1 round');

  log.record({ amountMsat: 100000n, paymentHash: b32(2), roundId: b32(9) });
  assert.equal(spentLine(log), '200 sat over 2 stakes in 1 round');

  log.record({ amountMsat: 50000n, paymentHash: b32(3), roundId: b32(8) });
  assert.equal(spentLine(log), '250 sat over 3 stakes in 2 rounds');

  // SATS, NOT MILLISATS. 1000 of them are one satoshi and the conversion is
  // exactly what a screen gets wrong quietly - which is why it is here and not
  // in a template on the page.
  assert.equal(log.totalMsat, 250000n);
  console.log('  "250 sat over 3 stakes in 2 rounds" from 250000 msat');
});

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/index.html', import.meta.url);

/**
 * THE SHIPPING PAGE, READ AS A FILE.
 *
 * Every rule above is measured against a real relay and a real daemon, and none
 * of it does anything unless the page calls it. That has been the shape of the
 * last fault in three of these letters running: a method nothing constructed,
 * green tests all the way down.
 */
test('the page pastes a connection, shows the amount and the total, and calls payStake', () => {
  const page = readFileSync(PAGE, 'utf8');

  // THE FOUR PLAYER-FACING THINGS.
  assert.match(page, /id="blwp-nwc"/, 'there is nowhere to paste a connection');
  assert.match(page, /id="blwp-owed"/, 'the page never shows what this seat owes');
  assert.match(page, /id="blwp-spent"/, 'the page never shows the running total');
  assert.match(page, /BLWPCLIENT\.tabWallet\(/, 'the page does not hold a connection per tab');
  assert.match(page, /window\.sessionStorage/, 'the connection is not held per tab');
  // THE SEATED ENTRY - this seat's own, with its round id and session key. It
  // was `window.BLWP_ENTRY`, which carries neither: measured on the page, every
  // quote and every pay threw "expected 32 bytes, got nothing" in entryId
  // (Client.invoice -> entryId -> encodeEntryContract), so no stake was ever
  // paid through this path.
  assert.match(page, /client\.payStake\(client\.seatEntry/,
    'the page does not pay this seat\'s stake with its own entry');
  assert.match(page, /BLWPCLIENT\.spentLine\(/, 'the page adds up its own total');

  // AND NO SECOND WAY TO PAY. The whole safety property of `payStake` is its
  // signature: it takes an entry. A page carrying a bolt11, or reaching for
  // `payInvoice`, would be a second money path around the check.
  const code = page.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const bad of [/lnbc/i, /bolt11/i, /payInvoice/, /nwcCall/, /pay_invoice/])
    assert.equal(bad.test(code), false, `the page names ${bad} - that is a second payment path`);

  // AND IT STILL NAMES NO CONTRACT FIELD. `roundPays` exists so the page never
  // reads `stakeMsat`; the wallet must not reintroduce it.
  for (const field of ['censusRoot', 'simCoreHash', 'gameVerifySlots', 'stakeMsat',
                       'committeeTimeMs', 'blockTicks'])
    assert.equal(code.includes(field), false,
      `the page writes ${field}, so it is inventing a round rather than joining one`);

  // AND localStorage IS STILL NOT USED. Two tabs are two players, and a
  // spending credential every tab shares is one paste spending from all of
  // them.
  assert.equal(/localStorage/.test(code), false, 'the page keeps the wallet where every tab shares it');
  console.log('  the page: 1 paste field, 1 amount, 1 total, 1 call to payStake, 0 bolt11');
});

/**
 * AND THE ONE THING THE PAGE DECIDES IS DRIVEN, not grepped.
 *
 * `paintWallet` is the page's own function and it decides one thing: whether a
 * round that asks no money gets a payment box. `world-seed-bridge.test.js`
 * drives the shipped jslib through `new Function`; this drives the shipped page
 * function the same way, with a DOM stubbed down to what it touches.
 */
test('a round that asks no money gets no payment box, driven off the shipped page', () => {
  const page = readFileSync(PAGE, 'utf8');
  const body = page.slice(page.indexOf('function paintWallet()'));
  const src = body.slice(0, body.indexOf('\n    }') + 6);
  assert.ok(src.includes('roundPays'), 'paintWallet was not extracted whole');

  const made = {};
  const el = (id) => (made[id] = made[id] || { style: {}, textContent: '', placeholder: '', disabled: false });
  const run = (round, walletState, owedState, budgetState = null, stakeLock = undefined) => new Function(
    'document', 'window', 'BLWPCLIENT', 'wallet', 'spent', 'owed', 'paying', 'walletWhy', 'budget',
    `${src}\n return paintWallet();`,
  )(
    { getElementById: el },
    { BLWP_ROUND: round, BLWP_CURVE: {}, BLWP_STAKE_LOCK: stakeLock,
      BLWP_ENTRY: { stakeMsat: round.stakeMsat, feeMsat: entryFeeMsat(round.stakeMsat), donationMsat: 0n } },
    {
      roundPays: (r) => !!r && BigInt(r.stakeMsat || 0n) > 0n,
      roundLocks,
      lockLine,
      spentLine: () => 'nothing paid this session',
      owedLine,
      budgetLine,
    },
    walletState, null, owedState, false, '', budgetState,
  );

  // A FREE ROUND: the box is hidden and nothing asks the player for money.
  run({ stakeMsat: 0n }, { connected: false }, null);
  assert.equal(made['blwp-wallet'].style.display, 'none', 'a free round showed a payment box');

  // A PAYING ROUND WITH NO QUOTE YET: shown, and the button cannot be pressed.
  run({ stakeMsat: 100000n }, { connected: false }, null);
  assert.equal(made['blwp-wallet'].style.display, 'block');
  assert.match(made['blwp-owed'].textContent, /100 sat round: 2 sat fee and 0 sat donation out of it, 98 sat staked · no quote yet/);
  assert.equal(made['blwp-pay'].disabled, true, 'a player could pay before there was a quote');

  // AND WITH ONE: the amount is in sats, off the client's own quote.
  run({ stakeMsat: 100000n }, { connected: true }, { amountMsat: NET, state: 'HELD' },
    { ok: true, kind: 'budget', totalMsat: 1000000n, usedMsat: 250000n, leftMsat: 750000n });
  // 22A's TRANSPARENCY LIST: the commitment, the fee and the donation OUT of it,
  // the net stake, and what the wallet is asked - which is the net.
  assert.match(made['blwp-owed'].textContent,
    /100 sat round: 2 sat fee and 0 sat donation out of it, 98 sat staked · the wallet is asked 98 sat · HELD/);
  assert.equal(made['blwp-pay'].disabled, false);
  assert.match(made['blwp-nwc'].placeholder, /wallet connected/);

  // AND THE BUDGET IS RENDERED FROM THE CLIENT'S OWN LINE, not assembled here.
  assert.equal(made['blwp-budget'].textContent, '750 of 1000 sat budget left');

  // A DISCONNECTED WALLET SHOWS NO BUDGET LINE AT ALL - "budget not asked for
  // yet" beside a box with nothing connected would be noise.
  run({ stakeMsat: 100000n }, { connected: false }, { amountMsat: NET, state: 'HELD' }, null);
  assert.equal(made['blwp-budget'].textContent, '');

  // AND A WALLET THAT CANNOT SAY SHOWS THE WORDS, never a blank.
  run({ stakeMsat: 100000n }, { connected: true }, { amountMsat: NET, state: 'HELD' },
    { ok: true, kind: 'none' });
  assert.equal(made['blwp-budget'].textContent, 'this wallet does not report a budget');
  console.log(`  free round: hidden · paying, no quote: "${made['blwp-owed'].textContent}" `
    + `is what a quote turns into`);

  // A ROUND WHOSE STAKE GOES INTO A FEDERATION LOCK (W1b) NEVER SHOWS A HOLD
  // INVOICE TO PAY: while the deposit waits the panel points at it, and once
  // the lock is made it shows the lock. Measured on the page before this, the
  // hold panel ("this seat owes", "Pay the stake") stood beside the invoice.
  const lockRound = { stakeMsat: 1000000n, custody: 'FEDERATION', federationId: new Uint8Array(32).fill(0xfe) };
  for (const id of ['blwp-nwc', 'blwp-pay']) el(id).style.display = '';
  run(lockRound, { connected: false }, null);
  assert.equal(made['blwp-wallet'].style.display, 'block');
  assert.equal(made['blwp-owed'].textContent, 'this round\'s stake goes into a federation lock: pay the deposit shown below');
  assert.equal(made['blwp-nwc'].style.display, 'none', 'a lock round offered a wallet connection to pay a hold invoice');
  assert.equal(made['blwp-pay'].style.display, 'none', 'a lock round offered "Pay the stake"');
  const stakeLock = { outpoint: { txid: new Uint8Array(32).fill(0xa2), outIdx: 0n }, fields: { amountMsat: 980000n, expiration: 464 } };
  run(lockRound, { connected: false }, null, null, stakeLock);
  assert.equal(made['blwp-owed'].textContent, lockLine(stakeLock));
  console.log(`  lock round: "${made['blwp-owed'].textContent}"`);
});

/**
 * WHAT THE WALLET WILL STILL LET THIS CONNECTION SPEND - ASKED, NOT PARSED.
 *
 * The field this used to be read off is gone. NIP-47's URI carries `relay`,
 * `secret` and optionally `lud16`; no wallet attaches a budget to it, so the
 * `budget:` line that was in `parseConnection` was blank for every wallet in
 * the world and would have rendered a working-looking screen showing nothing.
 */
test('the connection string carries no budget, because NIP-47 has none', () => {
  const c = parseConnection(
    `nostr+walletconnect://${toHex(rand(32))}?relay=wss://r&secret=${toHex(rand(32))}`
    + '&budget=1000');
  assert.equal(c.ok, true, c.why);
  assert.equal('budget' in c, false,
    'parseConnection carries a budget field again - no wallet puts one there');
  console.log('  parseConnection fields: ' + Object.keys(c).filter((k) => k !== 'ok').join(', '));
});

const wallets = (methods, extra = {}) => ({
  answer: (said) => {
    if (said.method === 'get_info') return { result_type: 'get_info', result: { methods } };
    if (said.method === 'get_budget') return { result_type: 'get_budget', result: extra.budget || {} };
    if (said.method === 'get_balance') return { result_type: 'get_balance', result: extra.balance || {} };
    return { result_type: 'pay_invoice', result: { preimage: PREIMAGE } };
  },
});

test('a wallet that reports a budget is asked for it, and the balance is not asked for', async () => {
  const w = await walletOnARelay(wallets(['pay_invoice', 'get_info', 'get_budget', 'get_balance'],
    { budget: { total_budget: 1000000, used_budget: 250000, renewal_period: 'monthly' } }));
  try {
    const said = await walletBudget(parseConnection(w.uri), pays);
    assert.equal(said.ok, true, said.why);
    assert.equal(said.kind, 'budget');
    assert.equal(said.totalMsat, 1000000n);
    assert.equal(said.usedMsat, 250000n);
    assert.equal(said.leftMsat, 750000n);
    assert.equal(budgetLine(said), '750 of 1000 sat budget left');

    // get_info FIRST, then get_budget, and NO get_balance - a wallet that
    // reports a budget is not asked what it holds.
    assert.deepEqual(w.asked.methods, ['get_info', 'get_budget']);
    assert.equal(w.asked.length, 0, 'asking for a budget paid something');
    console.log(`  ${w.asked.methods.join(' then ')} -> "${budgetLine(said)}"`);
  } finally { await w.close(); }
});

test('a wallet with no get_budget falls back to its balance, and says which it is', async () => {
  const w = await walletOnARelay(wallets(['pay_invoice', 'get_info', 'get_balance'],
    { balance: { balance: 4200000 } }));
  try {
    const said = await walletBudget(parseConnection(w.uri), pays);
    assert.equal(said.ok, true, said.why);
    assert.equal(said.kind, 'balance');
    assert.equal(said.balanceMsat, 4200000n);

    // A BALANCE IS NOT A BUDGET AND THE LINE SAYS SO. A player reading "4200
    // sat left" has to know whether that is this connection's allowance or
    // everything they own.
    assert.equal(budgetLine(said), 'wallet balance 4200 sat');
    assert.equal(budgetLine(said).includes('budget'), false,
      'a balance was rendered as a budget');
    assert.deepEqual(w.asked.methods, ['get_info', 'get_balance']);
    console.log(`  ${w.asked.methods.join(' then ')} -> "${budgetLine(said)}"`);
  } finally { await w.close(); }
});

test('a wallet that reports neither says so in words, never an empty number', async () => {
  const w = await walletOnARelay(wallets(['pay_invoice', 'get_info']));
  try {
    const said = await walletBudget(parseConnection(w.uri), pays);
    assert.equal(said.ok, true, said.why);
    assert.equal(said.kind, 'none');
    assert.equal(budgetLine(said), 'this wallet does not report a budget');
    assert.deepEqual(w.asked.methods, ['get_info'],
      'a method the wallet does not offer was asked for anyway');
    console.log(`  "${budgetLine(said)}" - and ${w.asked.methods.length} call, not a guess`);
  } finally { await w.close(); }
});

test('a connection with no budget set is not the same as a wallet that cannot say', async () => {
  const w = await walletOnARelay(wallets(['get_info', 'get_budget'], { budget: {} }));
  try {
    const said = await walletBudget(parseConnection(w.uri), pays);
    assert.equal(said.ok, true, said.why);
    assert.equal(said.kind, 'none');
    assert.equal(budgetLine(said), 'this connection has no budget set');
  } finally { await w.close(); }
});

test('the budget line never shows an empty number', () => {
  assert.equal(budgetLine(null), 'budget not asked for yet');
  assert.equal(budgetLine({ ok: false, why: 'the wallet did not answer in 300 ms' }),
    'budget unknown: the wallet did not answer in 300 ms');
  assert.equal(budgetLine({ ok: true, kind: 'none' }), 'this wallet does not report a budget');
  // 999 millisats is not 0 sat on a screen somebody spends from... it is, and
  // that is the point of saying which unit: the line is in sats because that
  // is what the player was quoted, and it never renders a bare blank.
  assert.equal(budgetLine({ ok: true, kind: 'balance', balanceMsat: 999n }), 'wallet balance 0 sat');
  for (const line of [budgetLine(null), budgetLine({ ok: true, kind: 'none' })])
    assert.ok(line.length > 0 && /[a-z]/.test(line), 'a budget line came out as a bare number');
  console.log('  every branch is words: not asked, unknown, none, balance, budget');
});

test('asking for a budget cannot move a satoshi', async () => {
  const w = await walletOnARelay(wallets(['pay_invoice', 'get_info', 'get_budget'],
    { budget: { total_budget: 1000000, used_budget: 0 } }));
  try {
    await walletBudget(parseConnection(w.uri), pays);
    assert.equal(w.asked.length, 0, 'a read-only call paid an invoice');
    assert.equal(w.asked.methods.includes('pay_invoice'), false);
    console.log(`  ${w.asked.methods.join(', ')}: 0 invoices paid`);
  } finally { await w.close(); }
});
