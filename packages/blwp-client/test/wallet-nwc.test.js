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
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { Client } from '../src/client.js';
import { pageCurve } from '../src/page-curve.js';
import {
  parseConnection, nip04Encrypt, nip04Decrypt, signEvent, payInvoice,
  NWC_REQUEST, NWC_RESPONSE,
} from '../src/nwc.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../protocol/src/contracts.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { HELD } from '../../protocol/src/payout.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { sha256, toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const rand = (n) => new Uint8Array(randomBytes(n));
const NOW = 1788700000000;
const STAKE = 100000n;
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

      const body = answer
        ? answer(said)
        : { result_type: 'pay_invoice', result: { preimage: PREIMAGE, fees_paid: 0 } };
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
  slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});

/** A daemon with Lightning, a round open, and one seat taken. */
async function seated() {
  const port = fakePort();
  const node = await serve(openStore(':memory:'), {
    port: 0, funded: () => true, now: () => NOW, lightning: port,
  });
  const contract = contractFor([node.round.pubkey]);
  const rid = roundId(contract);
  await fetch(`http://127.0.0.1:${node.port}/round`,
    { method: 'POST', body: encodeRoundContract(contract) });
  const entry = {
    roundId: rid, playerPubkey: schnorr.getPublicKey(rand(32)),
    sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(rand(32)),
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
    assert.equal(paid.amountMsat, STAKE);
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
    amountMsat: String(STAKE), state: HELD, request: 'lnbcrt1-liar',
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
