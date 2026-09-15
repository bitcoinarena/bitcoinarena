// THE PLAYER'S DONATION, PAID OVER LNURL TO THE DONATION SET THE SEATS SERVE
// (M3.2 item 6e; §22A, §24A.2; ruled 2026-09-13).
//
// In process, with the page's own payment code: two local LNURL endpoints at the
// set's fixed address (reached through an injected fetch), each issuing a real
// BOLT11 invoice for what it is asked, and a wallet on a local relay that pays
// whatever reaches it and keeps every invoice it was asked to pay.
//
// Measured before: a 2% donor's 2000 msat was taken by nobody - no LNURL,
// bech32 or BOLT11 code existed, and pay_invoice had one call site, the stake.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../../blwp-node/src/cores.js';
import { test } from 'node:test';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { ed25519 } from '@noble/curves/ed25519.js';
import { fetchDonationSet, donationRecipientsLine, noteDonationShare, donationPaidRecord } from '../src/donation-pay.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Client } from '../src/client.js';
import { chooseDonation } from '../src/donation-choice.js';
import { entryFor } from '../src/join.js';
import { spendLog, spentLine, nip04Decrypt, nip04Encrypt, signEvent, NWC_REQUEST, NWC_RESPONSE } from '../src/nwc.js';
import { pageCurve } from '../src/page-curve.js';
import { feldmanGroup } from '../../blwp-node/src/curve.js';
import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { bech32Encode, convertBits, urlOfLnurl } from '../../protocol/src/bech32.js';
import { decodeBolt11 } from '../../protocol/src/bolt11.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { coreHashHex } from '../../core/tools/hash-core.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST, TEST_DONATION_ENDPOINTS } from '../../protocol/src/test-donation-sets.js';
import { donationSetId } from '../../protocol/src/donation.js';
import { encodeDonationSetBody, donationSetBodyId, authorityRotationId, encodeAuthorityRotation } from '../../protocol/src/authority.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const rand = (n) => new Uint8Array(randomBytes(n));
const sha256 = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const SET = TEST_DONATION_SET_REGTEST;
const SET_ID = donationSetId(SET.recipients);
const NOW = 1788700000000;
const paying = { id: b32(0x21), stakeMsat: 100000n, settlementSlots: 7, simCoreHash: fromHex(coreHashHex()) };
const seed = b32(0x5e);
const entryOf = (donationMsat) => ({ ...entryFor(paying, { seed, curve: feldmanGroup, random: rand, donationMsat }), roundId: b32(0x21) });
const verifyEd25519 = async (sig, msg, pub) => { try { return ed25519.verify(sig, msg, pub); } catch { return false; } };

/** A BOLT11 invoice for tests: the real encoding, an all-zero signature (the wallet checks that, not the page). */
function invoiceFor({ amountMsat, paymentHash, descriptionHash }) {
  const amount = amountMsat % 100n === 0n ? `${amountMsat / 100n}n` : `${amountMsat * 10n}p`;
  const ts = 1788700000;
  const words = [];
  for (let i = 6; i >= 0; i--) words.push(Math.floor(ts / 32 ** i) % 32);
  const field = (type, bytes) => { const w = convertBits([...bytes], 8, 5, true); words.push(type, w.length >> 5, w.length & 31, ...w); };
  field(1, paymentHash);
  field(23, descriptionHash);
  for (let i = 0; i < 104; i++) words.push(0);
  return bech32Encode(`lnbcrt${amount}`, words);
}

/** The two local recipients. `behave[name]`: honest | wrong-amount | wrong-hash | down | short-comment. */
async function recipients(behave = {}) {
  const issued = [];
  const seen = [];
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://local');
    seen.push(u.pathname + u.search);
    const m = u.pathname.match(/^\/lnurlp\/(blwp-test-[ab])(\/cb)?$/);
    const who = m && m[1];
    const how = behave[who] || 'honest';
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!m || how === 'down') { res.writeHead(503); return res.end('down'); }
    const metadata = JSON.stringify([['text/plain', `BLWP test donation to ${who}`]]);
    if (!m[2]) return json({ tag: 'payRequest', callback: `http://127.0.0.1:18777/lnurlp/${who}/cb`, metadata,
      minSendable: 1, maxSendable: 1000000000, commentAllowed: how === 'short-comment' ? 63 : 64 });
    const amountMsat = BigInt(u.searchParams.get('amount'));
    const paymentHash = rand(32);
    const pr = invoiceFor({ amountMsat: how === 'wrong-amount' ? amountMsat + 1n : amountMsat, paymentHash,
      descriptionHash: sha256(how === 'wrong-hash' ? 'not the metadata' : metadata) });
    issued.push({ who, amountMsat, paymentHash: toHex(paymentHash), comment: u.searchParams.get('comment'), pr });
    json({ pr, routes: [] });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return { issued, seen, fetcher: (url) => fetch(String(url).replace('http://127.0.0.1:18777', `http://127.0.0.1:${port}`)),
    close: () => new Promise((r) => srv.close(r)) };
}

/**
 * A NIP-47 wallet on a local relay that pays whatever reaches it and keeps every invoice it was asked.
 * `refuseMsat`: an invoice of that amount fails as lnd's NO_ROUTE does (the 666 msat share under a
 * 1000 msat min_htlc, measured live).
 */
async function walletOnARelay({ refuseMsat = null } = {}) {
  const walletSecret = rand(32);
  const walletPubkey = pageCurve.pointX(walletSecret);
  const asked = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (sock) => {
    const subs = new Set();
    sock.on('message', async (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      if (frame[0] === 'REQ') { subs.add(frame[1]); return; }
      if (frame[0] !== 'EVENT') return;
      const event = frame[1];
      sock.send(JSON.stringify(['OK', event.id, true, '']));
      if (event.kind !== NWC_REQUEST) return;
      const opened = await nip04Decrypt(event.content, { secret: walletSecret, theirPubkey: fromHex(event.pubkey), curve: pageCurve });
      if (!opened.ok) return;
      const said = JSON.parse(opened.plaintext);
      if (said.method === 'pay_invoice') asked.push(said.params.invoice);
      const refused = refuseMsat !== null && said.method === 'pay_invoice' && decodeBolt11(said.params.invoice).amountMsat === refuseMsat;
      const content = await nip04Encrypt(JSON.stringify(refused
        ? { result_type: 'pay_invoice', error: { code: 'PAYMENT_FAILED', message: 'FAILURE_REASON_NO_ROUTE' } }
        : { result_type: 'pay_invoice', result: { preimage: 'ab'.repeat(32), fees_paid: 0 } }),
        { secret: walletSecret, theirPubkey: fromHex(event.pubkey), curve: pageCurve, random: rand });
      const reply = await signEvent({ kind: NWC_RESPONSE, tags: [['p', event.pubkey], ['e', event.id]], content, secret: walletSecret, curve: pageCurve });
      for (const sub of subs) sock.send(JSON.stringify(['EVENT', sub, reply]));
    });
  });
  return { asked, uri: `nostr+walletconnect://${toHex(walletPubkey)}?relay=ws://127.0.0.1:${wss.address().port}&secret=${toHex(rand(32))}`,
    close: () => new Promise((r) => wss.close(r)) };
}

async function pay(entry, behave) {
  const endpoints = await recipients(behave);
  const wallet = await walletOnARelay();
  const log = spendLog();
  try {
    // THE PLAYER'S OWN CLIENT PAYS IT - the page calls this method, never a free function.
    const client = new Client({ base: 'http://127.0.0.1:9', core: {}, sign: async () => new Uint8Array(64), verify: () => true });
    client.stakeCommitted = true;   // the seats hold the stake: only then does a donation go (6e)
    const said = await client.payDonation(entry, SET, { connection: wallet.uri, curve: pageCurve, fetcher: endpoints.fetcher, log, random: rand, timeoutMs: 5000 });
    return { said, issued: endpoints.issued, seen: endpoints.seen, asked: wallet.asked, log };
  } finally { await endpoints.close(); await wallet.close(); }
}

test('a 2% donor pays 1334 msat and 666 msat to the two recipients the set names, exactly the invoices they issued', async () => {
  const entry = entryOf(2000n);
  const { said, issued, asked, log } = await pay(entry);
  assert.equal(said.ok, true, said.why);
  assert.equal(said.paidMsat, 2000n);
  assert.deepEqual(issued.map((i) => [i.who, i.amountMsat]), [['blwp-test-a', 1334n], ['blwp-test-b', 666n]]);
  assert.deepEqual(asked, issued.map((i) => i.pr), 'the wallet was asked to pay exactly the invoices the recipients issued');
  assert.deepEqual(asked.map((pr) => decodeBolt11(pr).amountMsat), [1334n, 666n]);
  assert.deepEqual(said.paid.map((p) => [p.url, p.amountMsat]), [[TEST_DONATION_ENDPOINTS[0], 1334n], [TEST_DONATION_ENDPOINTS[1], 666n]]);
  assert.deepEqual(issued.map((i) => i.comment), [toHex(entry.playerPubkey), toHex(entry.playerPubkey)], 'the comment is the player key as hex');
  assert.deepEqual([log.count, log.totalMsat], [2, 2000n], 'both payments are in the spend log');
  console.log(`  2% donor: ${said.paid.map((p) => `${p.amountMsat} msat to ${p.url}`).join(', ')}; wallet asked ${asked.length}`);
});

test('a 0% donor pays nothing and asks nobody', async () => {
  const { said, seen, asked } = await pay(entryOf(0n));
  assert.deepEqual([said.ok, said.paidMsat, seen.length, asked.length], [true, 0n, 0, 0]);
});

test('an unconfirmed choice above 5% and an over-cap one write 0, and 0 pays nothing', async () => {
  const storage = { m: new Map(), getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }, setItem(k, v) { this.m.set(k, v); } };
  let n = 0;
  const unconfirmed = chooseDonation({ roundIdHex: 'u', stakeMsat: 100000n, ask: () => ['6', null][n++], confirm: () => false, storage });
  const overCap = chooseDonation({ roundIdHex: 'o', stakeMsat: 100000n, ask: () => '99', confirm: () => true, storage });
  assert.deepEqual([unconfirmed.donationMsat, overCap.donationMsat], [0n, 0n]);
  for (const choice of [unconfirmed, overCap]) {
    const { said, seen, asked } = await pay(entryOf(choice.donationMsat));
    assert.deepEqual([said.paidMsat, seen.length, asked.length], [0n, 0, 0]);
  }
});

test('a share whose invoice is wrong, or whose endpoint is down, is not paid and not redirected to the other recipient', async () => {
  for (const [how, why] of [['wrong-amount', /asks 1335 msat, and this recipient's share is 1334/], ['wrong-hash', /description hash/], ['down', /did not answer/]]) {
    const { said, asked } = await pay(entryOf(2000n), { 'blwp-test-a': how });
    assert.equal(said.ok, false, how);
    assert.deepEqual(said.failed.map((f) => [urlOfLnurl(f.lnurl), f.amountMsat]), [[TEST_DONATION_ENDPOINTS[0], 1334n]], how);
    assert.match(said.failed[0].why, why, how);
    assert.deepEqual(asked.map((pr) => decodeBolt11(pr).amountMsat), [666n], `${how}: the wallet paid only the other recipient's own share`);
    assert.deepEqual([said.paidMsat, said.unpaidMsat], [666n, 1334n], how);
  }
});

test('an endpoint that takes fewer than 64 characters gets no comment', async () => {
  const { said, issued } = await pay(entryOf(2000n), { 'blwp-test-a': 'short-comment', 'blwp-test-b': 'short-comment' });
  assert.equal(said.ok, true);
  assert.deepEqual(issued.map((i) => i.comment), [null, null]);
});

// ---- a reload (M3.2 6e): the page's memory goes, the tab's sessionStorage stays
//
// Measured before, from the code: the page's once-only flag (`donationPaying`,
// index.html) and its spend log are page memory, while the lock, the chosen
// donation and the wallet connection survive a reload in sessionStorage - so a
// reload over a kept lock met the pay condition again and paid the shares again.

const tabStorage = () => ({ m: new Map(), getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }, setItem(k, v) { this.m.set(k, String(v)); } });

/**
 * ONE PAGE LOAD. Everything a reload loses is new - the Client, the spend log,
 * and the entry: "a reload keeps the player's key (sessionStorage) and draws a
 * NEW entry" (client.js, join). What it keeps is the tab's storage, and the
 * wallet and recipients, which live outside the page.
 */
async function pageLoad({ storage, endpoints, wallet, donationMsat = 2000n, log = spendLog() }) {
  const entry = entryOf(donationMsat);
  const client = new Client({ base: 'http://127.0.0.1:9', core: {}, sign: async () => new Uint8Array(64), verify: () => true });
  client.stakeCommitted = true;   // the seats hold the stake: only then does a donation go (6e)
  const askedBefore = wallet.asked.length;
  const issuedBefore = endpoints.issued.length;
  const said = await client.payDonation(entry, SET, { storage, connection: wallet.uri, curve: pageCurve, fetcher: endpoints.fetcher, log, random: rand, timeoutMs: 5000 });
  const asked = wallet.asked.slice(askedBefore);
  return { entry, said, log, asked, askedMsat: asked.reduce((t, pr) => t + decodeBolt11(pr).amountMsat, 0n), issued: endpoints.issued.slice(issuedBefore) };
}

test('a reload over a kept lock does not pay the donation twice: the second load sends 0 msat and asks the wallet nothing', async () => {
  const storage = tabStorage();
  const endpoints = await recipients();
  const wallet = await walletOnARelay();
  try {
    const first = await pageLoad({ storage, endpoints, wallet });
    assert.equal(first.said.ok, true, first.said.why);
    assert.deepEqual(first.asked.map((pr) => decodeBolt11(pr).amountMsat), [1334n, 666n]);
    assert.equal(first.log.totalMsat, 2000n);

    const second = await pageLoad({ storage, endpoints, wallet });
    assert.notEqual(toHex(second.entry.worldSecret), toHex(first.entry.worldSecret), 'the reload drew the same entry, so this says nothing about a new one');
    assert.deepEqual(second.entry.playerPubkey, first.entry.playerPubkey);
    assert.deepEqual([second.asked.length, second.issued.length, second.log.totalMsat], [0, 0, 0n],
      `the reload asked the wallet ${second.asked.length} more time(s), for ${second.askedMsat} msat`);
    assert.deepEqual([second.said.ok, second.said.paidMsat, second.said.kept], [true, 2000n, 2], 'the reload reports what the first load paid');
    console.log(`  reload: first load sent ${first.log.totalMsat} msat in ${first.asked.length} payments; `
      + `second load sent ${second.log.totalMsat} msat, wallet asked ${second.asked.length}, recipients invoiced ${second.issued.length}`);
  } finally { await endpoints.close(); await wallet.close(); }
});

test('a part-paid donation stays part-paid across a reload: the 666 msat share that did not route is not asked again, and 1334 is not paid again', async () => {
  const storage = tabStorage();
  const endpoints = await recipients();
  const wallet = await walletOnARelay({ refuseMsat: 666n });
  try {
    const first = await pageLoad({ storage, endpoints, wallet });
    assert.deepEqual([first.said.ok, first.said.paidMsat, first.said.unpaidMsat, first.log.totalMsat], [false, 1334n, 666n, 1334n]);
    assert.match(first.said.failed[0].why, /NO_ROUTE/);

    const second = await pageLoad({ storage, endpoints, wallet });
    assert.deepEqual([second.asked.length, second.issued.length, second.log.totalMsat], [0, 0, 0n],
      `the reload asked the wallet ${second.asked.length} more time(s), for ${second.askedMsat} msat`);
    assert.deepEqual([second.said.ok, second.said.paidMsat, second.said.unpaidMsat], [false, 1334n, 666n]);
    assert.deepEqual(second.said.failed.map((f) => [urlOfLnurl(f.lnurl), f.amountMsat]), [[TEST_DONATION_ENDPOINTS[1], 666n]]);
    assert.match(second.said.failed[0].why, /NO_ROUTE/, 'the reload lost why the share was unpaid');
    console.log(`  part-paid reload: first load sent ${first.log.totalMsat} msat (666 unpaid); second load sent ${second.log.totalMsat} msat, wallet asked ${second.asked.length}`);
  } finally { await endpoints.close(); await wallet.close(); }
});

test('a share the wallet was asked for before the tab died is not asked again - its outcome is unknown, not unpaid', async () => {
  const storage = tabStorage();
  const before = entryOf(2000n);
  assert.equal(noteDonationShare(storage, { roundId: before.roundId, playerPubkey: before.playerPubkey }, SET.recipients[0].lnurl,
    { state: 'asked', amountMsat: 1334n }), true);
  const endpoints = await recipients();
  const wallet = await walletOnARelay();
  try {
    const load = await pageLoad({ storage, endpoints, wallet });
    assert.deepEqual(load.asked.map((pr) => decodeBolt11(pr).amountMsat), [666n], 'only the share nobody asked for yet is paid');
    assert.deepEqual([load.said.ok, load.said.paidMsat, load.said.unpaidMsat, load.said.unknownMsat], [false, 666n, 0n, 1334n]);
    assert.deepEqual(load.said.unknown.map((u) => [urlOfLnurl(u.lnurl), u.amountMsat]), [[TEST_DONATION_ENDPOINTS[0], 1334n]]);
  } finally { await endpoints.close(); await wallet.close(); }
});

// ---- what the player SEES: the shipped paintWallet, off the shipped bundle
//
// Driven, not grepped: `paintWallet` is pulled out of the shipping page and run
// against a DOM stubbed down to what it touches, with dist/blwp-client.js as
// BLWPCLIENT - the way wallet-nwc.test.js drives it.

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/index.html', import.meta.url);
const SHIPPED = createRequire(import.meta.url)('../dist/blwp-client.js');
const NOTE_IS = { paid: 'paid', unpaid: 'unpaid', asked: 'unknown' };
const A = TEST_DONATION_ENDPOINTS[0];
const B = TEST_DONATION_ENDPOINTS[1];

/** Runs the page's own paintWallet for this seat and answers every element it painted. */
function paintThePage({ round, entry, donationPaid, settlement, spent = SHIPPED.spendLog(), owed = null }) {
  const page = readFileSync(PAGE, 'utf8');
  const body = page.slice(page.indexOf('function paintWallet()'));
  const src = body.slice(0, body.indexOf('\n    }') + 6);
  const made = {};
  const el = (id) => (made[id] = made[id] || { style: {}, textContent: '', placeholder: '', disabled: false });
  new Function('document', 'window', 'BLWPCLIENT', 'wallet', 'spent', 'owed', 'paying', 'walletWhy', 'budget',
    `${src}\n return paintWallet();`)(
    { getElementById: el }, { BLWP_ROUND: round, BLWP_ENTRY: entry, BLWP_DONATION_PAID: donationPaid, BLWP_SETTLEMENT: settlement },
    SHIPPED, { connected: false }, spent, owed, false, '', null);
  return made;
}

test('a hold that has ended does not read HELD: the stake line takes the seats\' end state - SETTLED, CANCELLED, EXPIRED - and stays HELD only while it is', () => {
  // BEFORE (bundle e9f22a89, live on the daily page): every one read "... · the wallet is
  // asked 98 sat · HELD" - the quote is asked once, at payment - beside "Settled: ...".
  const round = contractFor([b32(1), b32(2)]);
  const entry = { stakeMsat: 100000n, feeMsat: 2000n, donationMsat: 0n };
  const owed = { amountMsat: 98000n, state: 'HELD' };
  const base = '100 sat round: 2 sat fee and 0 sat donation out of it, 98 sat staked · the wallet is asked 98 sat · ';
  for (const [hold, finality, want] of [['SETTLED', 'FINAL', 'SETTLED'], ['CANCELLED', 'FINAL', 'CANCELLED'], ['EXPIRED', 'FINAL', 'EXPIRED'],
    ['HELD', 'PROVISIONALLY_FINAL', 'HELD']]) {
    const s = { answered: 2, of: 2, hold, holdMsat: 98000n, poolMsat: 98000n, finality };
    const made = paintThePage({ round, entry, donationPaid: undefined, settlement: s, owed });
    assert.equal(made['blwp-owed'].textContent, base + want, `seats say ${hold}`);
    console.log(`  seats say ${hold.padEnd(9)} -> "${made['blwp-owed'].textContent.slice(-40)}" beside "${made['blwp-settled'].textContent.slice(0, 40)}…"`);
  }
  // NO ANSWER FROM THE SEATS YET: the quote's own state, as before.
  assert.equal(paintThePage({ round, entry, donationPaid: undefined, settlement: undefined, owed })['blwp-owed'].textContent, base + 'HELD');
});

/**
 * Runs the shipping page's own settlement poll (askTheSettlement, with its flag) against
 * seats that answer `hold`, then its paintWallet - both off the shipped bundle.
 */
async function settleOnThePage({ hold, spent, stakeCommitment, round }) {
  const page = readFileSync(PAGE, 'utf8');
  const from = page.indexOf('    let settlementAsking = false;');
  const fn = page.indexOf('async function askTheSettlement()', from);
  const src = page.slice(from, page.indexOf('\n    }\n', fn) + 6);
  const seatKeys = [b32(0x71), b32(0x72)];
  const fetcher = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/identity') return new Response(seatKeys[u.port === '1' ? 0 : 1], { status: 200 });
    return new Response(JSON.stringify({ entry: 'ee'.repeat(32), hold, holdMsat: '98000', poolMsat: '98000', finality: 'FINAL' }), { status: 200 });
  };
  const client = { seatEntry: { stakeCommitment }, where: { entryId: 'ee'.repeat(32) } };
  const win = { BLWP_ROUND: round, BLWP_STAKE: { seatKeys, nodes: ['http://127.0.0.1:1', 'http://127.0.0.1:2'] } };
  const BL = { ...SHIPPED, settlementBy: (o) => SHIPPED.settlementBy({ ...o, fetcher }) };
  await new Function('window', 'BLWPCLIENT', 'theClient', 'spent', 'paintWallet', `${src}\n return askTheSettlement();`)(
    win, BL, () => client, spent, () => {});
  return win.BLWP_SETTLEMENT;
}

test('a winner is shown what the round owes it: the seats\' own payout-table row, 194000 msat beside its returned 96000 msat stake and the 98000 msat pool', async () => {
  // BEFORE (bundle 675d62d1): the seats served hold and pool only, and a winner's line
  // read "Returned: this seat's 96000 msat stake was cancelled back to the wallet · the
  // round's pool 98000 msat" - no winnings figure. Round 1's D2: hold 96000, row 194000.
  const seatKeys = [b32(0x71), b32(0x72)];
  const nodes = ['http://127.0.0.1:1', 'http://127.0.0.1:2'];
  const answers = (owed) => async (url) => {
    const u = new URL(url);
    const i = u.port === '1' ? 0 : 1;
    if (u.pathname === '/identity') return new Response(seatKeys[i], { status: 200 });
    return new Response(JSON.stringify({ entry: 'ee'.repeat(32), hold: 'CANCELLED', holdMsat: '96000', poolMsat: '98000', owedMsat: owed[i], finality: 'FINAL' }), { status: 200 });
  };
  const won = await SHIPPED.settlementBy({ entryId: 'ee'.repeat(32), seats: seatKeys, nodes, fetcher: answers(['194000', '194000']) });
  assert.deepEqual([won.hold, won.holdMsat, won.owedMsat, won.poolMsat], ['CANCELLED', 96000n, 194000n, 98000n]);
  const made = paintThePage({ round: contractFor([b32(1), b32(2)]), entry: entryOf(2000n), donationPaid: undefined, settlement: won });
  assert.equal(made['blwp-settled'].textContent,
    'Returned: this seat\'s 96000 msat stake was cancelled back to the wallet · the round\'s payout table: 194000 msat for this seat · the round\'s pool 98000 msat');
  // SEATS THAT DISAGREE ON THE ROW SHOW NO ROW - the page never picks one.
  const split = await SHIPPED.settlementBy({ entryId: 'ee'.repeat(32), seats: seatKeys, nodes, fetcher: answers(['194000', '193999']) });
  assert.equal(split.owedMsat, null);
  assert.doesNotMatch(SHIPPED.settledLine(split), /payout table/);
  // A LOSER'S ROW IS 0 AND ADDS NOTHING: its line reads as before.
  assert.equal(SHIPPED.settledLine({ answered: 2, hold: 'SETTLED', holdMsat: 98000n, poolMsat: 98000n, owedMsat: 0n }),
    'Settled: this seat\'s 98000 msat stake went into the pool · the round\'s pool 98000 msat');
  console.log(`  winner: "${made['blwp-settled'].textContent}"`);
});

test('a stake that came back is not counted as spent: a cancelled winner and an expired refund read nothing spent, a settled loser still reads its stake', async () => {
  // BEFORE (measured on the bundle the daily page ran, 915f64c9): all three read
  // "98 sat over 1 stake in 1 round", beside "Returned: ..." / "Expired: ..." / "Settled: ...".
  const round = contractFor([b32(1), b32(2)]);
  const want = {
    CANCELLED: 'nothing spent this session · 98 sat came back (1 stake cancelled)',
    EXPIRED: 'nothing spent this session · 98 sat came back (1 stake expired)',
    SETTLED: '98 sat over 1 stake in 1 round',
  };
  for (const [hold, line] of Object.entries(want)) {
    const storage = tabStorage();
    const spent = SHIPPED.spendLog({ storage });
    const stakeCommitment = b32(0x61);
    spent.record({ amountMsat: 98000n, paymentHash: stakeCommitment, roundId: b32(0x21), kind: 'stake' });
    const s = await settleOnThePage({ hold, spent, stakeCommitment, round });
    assert.equal(s.hold, hold);
    const made = paintThePage({ round, entry: entryOf(0n), donationPaid: undefined, settlement: s, spent });
    assert.equal(made['blwp-spent'].textContent, line, `${hold}: the running total the page paints`);
    assert.deepEqual([spent.totalMsat, spent.returnedMsat], hold === 'SETTLED' ? [98000n, 0n] : [0n, 98000n], `${hold}: what the log holds`);
    // AND A RELOAD KEEPS IT: the tab's log reads the same after the page is gone.
    assert.equal(SHIPPED.spentLine(SHIPPED.spendLog({ storage })), line, `${hold}: after a reload`);
    console.log(`  ${hold.padEnd(9)}: "${made['blwp-spent'].textContent}" beside "${made['blwp-settled'].textContent.slice(0, 60)}…"`);
  }
  // A STAKE THE PAGE NEVER PAID, or a donation share, is not marked: only this seat's stake.
  const other = SHIPPED.spendLog();
  other.record({ amountMsat: 1334n, paymentHash: b32(0x62), roundId: b32(0x21), kind: 'donation' });
  assert.equal(SHIPPED.noteSettlement(other, { hold: 'CANCELLED' }, b32(0x62)), false);
  assert.equal(SHIPPED.spentLine(other), '1334 msat over 1 donation share in 1 round');
});

/** What one page load shows, painted the way the page paints it after payDonation answers. */
function shown(load, round, storage) {
  const state = SHIPPED.donationPaidState(SET, load.said);
  const text = (paintThePage({ round, entry: load.entry, donationPaid: state })['blwp-donation'] || {}).textContent || '';
  const rows = state.shares.map((s) => [s.url, s.amountMsat, s.state]);
  const onScreen = state.shares.filter((s) => text.includes(`${s.amountMsat} msat ${({ paid: 'paid', unpaid: 'UNPAID', unknown: 'outcome unknown' })[s.state]} to ${s.url}`)).length;
  // AND THE SCREEN SAYS WHAT THE TAB'S NOTES SAY, share by share.
  const notes = donationPaidRecord(storage, { roundId: load.entry.roundId, playerPubkey: load.entry.playerPubkey });
  const noted = state.shares.map((s) => NOTE_IS[notes.shares[s.lnurl].state]);
  return { state, text, rows, onScreen, noted };
}

test('the page shows each donation share as paid, unpaid or outcome unknown, matching the tab\'s notes, before and after a reload', async () => {
  const holdRound = contractFor([b32(1), b32(2)]);
  const lockRound = { ...holdRound, custody: 'FEDERATION', federationId: TEST_FEDERATION_ID };
  assert.equal(SHIPPED.roundLocks(holdRound), false);
  assert.equal(SHIPPED.roundLocks(lockRound), true);
  const report = [];

  // 1. FULLY PAID, THEN A RELOAD.
  {
    const storage = tabStorage();
    const endpoints = await recipients();
    const wallet = await walletOnARelay();
    try {
      for (const [n, load] of [[1, await pageLoad({ storage, endpoints, wallet })], [2, await pageLoad({ storage, endpoints, wallet })]]) {
        const s = shown(load, holdRound, storage);
        assert.deepEqual(s.rows, [[A, 1334n, 'paid'], [B, 666n, 'paid']], `fully paid, load ${n}`);
        assert.equal(s.onScreen, 2, `fully paid, load ${n}: the page shows ${s.onScreen} of 2 shares: "${s.text}"`);
        assert.deepEqual(s.noted, ['paid', 'paid'], `fully paid, load ${n}: the screen and the notes disagree`);
        assert.doesNotMatch(s.text, /unpaid stays/);
        if (n === 2) assert.equal(load.asked.length, 0, 'the reload asked the wallet again');
        report.push(`fully paid, load ${n}: "${s.text}"`);
      }
    } finally { await endpoints.close(); await wallet.close(); }
  }

  // 2. PART-PAID - the 666 msat share under a 1000 msat min_htlc - THEN A RELOAD,
  // on a hold round and on a lock round (whose panel returns early).
  {
    const storage = tabStorage();
    const endpoints = await recipients();
    const wallet = await walletOnARelay({ refuseMsat: 666n });
    try {
      for (const [n, load] of [[1, await pageLoad({ storage, endpoints, wallet })], [2, await pageLoad({ storage, endpoints, wallet })]]) {
        for (const round of [holdRound, lockRound]) {
          const s = shown(load, round, storage);
          const kind = round === lockRound ? 'lock round' : 'hold round';
          assert.deepEqual(s.rows, [[A, 1334n, 'paid'], [B, 666n, 'unpaid']], `part-paid, load ${n}, ${kind}`);
          assert.equal(s.onScreen, 2, `part-paid, load ${n}, ${kind}: the page shows ${s.onScreen} of 2 shares: "${s.text}"`);
          assert.deepEqual(s.noted, ['paid', 'unpaid'], `part-paid, load ${n}: the screen and the notes disagree`);
          assert.match(s.text, /666 msat UNPAID to \S+blwp-test-b \(.*NO_ROUTE\)/, 'the page does not say why the share is unpaid');
          assert.match(s.text, /666 msat unpaid stays in your wallet, sent nowhere else/);
          assert.equal(s.state.state, 'part');
        }
        if (n === 2) assert.equal(load.asked.length, 0, 'the reload asked the wallet again');
        report.push(`part-paid, load ${n}: "${shown(load, holdRound, storage).text}"`);
      }
    } finally { await endpoints.close(); await wallet.close(); }
  }

  // 3. THE TAB CLOSED WHILE THE WALLET WAS ASKED FOR 1334: unknown, and only 666 is asked.
  {
    const storage = tabStorage();
    const before = entryOf(2000n);
    noteDonationShare(storage, { roundId: before.roundId, playerPubkey: before.playerPubkey }, SET.recipients[0].lnurl, { state: 'asked', amountMsat: 1334n });
    const endpoints = await recipients();
    const wallet = await walletOnARelay();
    try {
      const load = await pageLoad({ storage, endpoints, wallet });
      assert.deepEqual(load.asked.map((pr) => decodeBolt11(pr).amountMsat), [666n], 'only the remaining share is asked');
      const s = shown(load, holdRound, storage);
      assert.deepEqual(s.rows, [[A, 1334n, 'unknown'], [B, 666n, 'paid']]);
      assert.equal(s.onScreen, 2, `mid-ask: the page shows ${s.onScreen} of 2 shares: "${s.text}"`);
      assert.deepEqual(s.noted, ['unknown', 'paid'], 'mid-ask: the screen and the notes disagree');
      assert.doesNotMatch(s.text, /unpaid stays/, 'an unknown share was called unpaid');
      report.push(`mid-ask reload: "${s.text}"`);
    } finally { await endpoints.close(); await wallet.close(); }
  }

  // AND BEFORE AND WHILE: nothing before a donation is under way, "paying" while it is.
  assert.equal((paintThePage({ round: holdRound, entry: entryOf(2000n), donationPaid: undefined })['blwp-donation'] || {}).textContent, '');
  assert.match(paintThePage({ round: holdRound, entry: entryOf(2000n), donationPaid: { state: 'paying' } })['blwp-donation'].textContent, /paying/);

  // AND THE PAGE STORES THE CLIENT'S STATE AND REPAINTS when payDonation answers.
  const page = readFileSync(PAGE, 'utf8');
  assert.match(page, /id="blwp-donation"/, 'the page has nowhere to show the donation');
  assert.match(page, /window\.BLWP_DONATION_PAID = BLWPCLIENT\.donationPaidState\(window\.BLWP_DONATION_SET, said\);\s*paintWallet\(\);/,
    'the page does not store the client\'s donation state and repaint when payDonation answers');
  for (const line of report) console.log(`  ${line}`);
});

/** Runs the shipping page's own showNotedDonation - the failure path's - against a stubbed DOM. */
function showNotedOnThePage({ search, storage }) {
  const page = readFileSync(PAGE, 'utf8');
  const body = page.slice(page.indexOf('function showNotedDonation()'));
  const src = body.slice(0, body.indexOf('\n    }') + 6);
  const made = {};
  const el = (id) => (made[id] = made[id] || { textContent: '', classes: new Set(), classList: { add(c) { made[id].classes.add(c); } } });
  new Function('document', 'window', 'BLWPCLIENT', 'location', `${src}\n return showNotedDonation();`)(
    { getElementById: el }, { sessionStorage: storage, BLWP_CURVE: pageCurve }, SHIPPED, { search });
  return made['blwp-donation-noted'];
}

test('a reload whose round link cannot be reached still shows the donation from the tab\'s notes, and asks the wallet nothing', async () => {
  const storage = tabStorage();
  storage.setItem('blwp.player.seed', toHex(seed));
  const endpoints = await recipients();
  const wallet = await walletOnARelay({ refuseMsat: 666n });
  try {
    const first = await pageLoad({ storage, endpoints, wallet });
    assert.deepEqual([first.said.paidMsat, first.said.unpaidMsat], [1334n, 666n]);
    const askedBefore = wallet.asked.length;
    const issuedBefore = endpoints.issued.length;

    // THE ROUND LINK OF THAT ROUND, ITS NODES GONE: no seat, no set, no payDonation.
    const shown = showNotedOnThePage({ search: `?round=${toHex(b32(0x21))}&node=http://127.0.0.1:1,http://127.0.0.1:2`, storage });
    assert.equal(shown.classes.has('show'), true, `the loading screen shows no donation: "${shown.textContent}"`);
    assert.match(shown.textContent, /1334 msat paid to http:\/\/127\.0\.0\.1:18777\/lnurlp\/blwp-test-a/);
    assert.match(shown.textContent, /666 msat UNPAID to \S+blwp-test-b \(.*NO_ROUTE\)/);
    assert.match(shown.textContent, /666 msat unpaid stays in your wallet, sent nowhere else/);
    assert.deepEqual([wallet.asked.length - askedBefore, endpoints.issued.length - issuedBefore], [0, 0], 'showing the notes asked the wallet or a recipient');

    // AND ONLY THIS TAB'S OWN DONATION TO THIS ROUND: another round, or a tab with no seed, shows nothing.
    const other = showNotedOnThePage({ search: `?round=${toHex(b32(0x22))}`, storage });
    assert.deepEqual([other.textContent, other.classes.has('show')], ['', false]);
    const bare = tabStorage();
    for (const [k, v] of storage.m) if (k !== 'blwp.player.seed') bare.setItem(k, v);
    const noSeed = showNotedOnThePage({ search: `?round=${toHex(b32(0x21))}`, storage: bare });
    assert.deepEqual([noSeed.textContent, noSeed.classes.has('show'), bare.getItem('blwp.player.seed')], ['', false, null], 'a seed was minted to read the notes');
    console.log(`  no seat, round unreachable: "${shown.textContent}"`);
  } finally { await endpoints.close(); await wallet.close(); }
});

test('the running total survives a reload and counts a donation share as a donation, not a stake', async () => {
  const storage = tabStorage();
  const endpoints = await recipients();
  const wallet = await walletOnARelay({ refuseMsat: 666n });
  try {
    // WHAT LEFT THE WALLET: the stake hold (recorded as payStake records it) and the settled share.
    const load1 = spendLog({ storage });
    load1.record({ amountMsat: 96000n, paymentHash: b32(0x51), roundId: b32(0x21), kind: 'stake' });
    const first = await pageLoad({ storage, endpoints, wallet, log: load1 });
    assert.deepEqual([first.said.paidMsat, first.said.unpaidMsat], [1334n, 666n]);
    assert.equal(load1.totalMsat, 97334n);
    assert.equal(spentLine(load1), '97334 msat over 1 stake and 1 donation share in 1 round');

    // THE RELOAD: a new page, the same tab.
    const load2 = spendLog({ storage });
    assert.equal(load2.totalMsat, 97334n, 'the reload forgot what left the wallet');
    assert.equal(spentLine(load2), '97334 msat over 1 stake and 1 donation share in 1 round');
    const second = await pageLoad({ storage, endpoints, wallet, log: load2 });
    assert.deepEqual([second.asked.length, second.issued.length], [0, 0], 'the reload asked the wallet or a recipient again');
    assert.deepEqual([load2.totalMsat, load2.count], [97334n, 2], 'the reload counted a payment twice');
    assert.deepEqual(load2.entries().map((p) => [p.kind, p.amountMsat]), [['stake', 96000n], ['donation', 1334n]]);
    // A donation share alone is a donation, never "1 stake".
    const only = spendLog();
    only.record({ amountMsat: 1334n, paymentHash: b32(0x52), roundId: b32(0x21), kind: 'donation' });
    assert.equal(spentLine(only), '1334 msat over 1 donation share in 1 round');
    console.log(`  reload: "${spentLine(load2)}" (was "nothing paid this session"); wallet asked ${second.asked.length}`);
  } finally { await endpoints.close(); await wallet.close(); }
});

test('after settlement the page shows where the stake went and the round\'s pool, as the seats say them', async () => {
  // THE SEATS' OWN ANSWERS, as /settlement serves them after a 2% donor lost:
  // the hold settled, its amount, and custody's holdSettlement pool.
  const seatKeys = [b32(0x71), b32(0x72)];
  const answers = (over = {}) => async (url) => {
    const u = new URL(url);
    const i = u.port === '1' ? 0 : 1;
    if (u.pathname === '/identity') return new Response(seatKeys[i], { status: 200 });
    return new Response(JSON.stringify({ entry: 'ee'.repeat(32), hold: 'SETTLED', holdMsat: '96000', poolMsat: '96000',
      finality: 'FINAL', windowClosesAtMs: null, refundHeight: null, ...(over[i] || {}) }), { status: 200 });
  };
  const nodes = ['http://127.0.0.1:1', 'http://127.0.0.1:2'];
  const settled = await SHIPPED.settlementBy({ entryId: 'ee'.repeat(32), seats: seatKeys, nodes, fetcher: answers() });
  assert.deepEqual([settled.hold, settled.holdMsat, settled.poolMsat, settled.finality], ['SETTLED', 96000n, 96000n, 'FINAL']);
  const made = paintThePage({ round: contractFor([b32(1), b32(2)]), entry: entryOf(2000n), donationPaid: undefined, settlement: settled });
  assert.equal(made['blwp-settled'].textContent, 'Settled: this seat\'s 96000 msat stake went into the pool · the round\'s pool 96000 msat');

  // SEATS THAT DISAGREE ON THE POOL SHOW NO POOL - the page never picks one.
  const split = await SHIPPED.settlementBy({ entryId: 'ee'.repeat(32), seats: seatKeys, nodes, fetcher: answers({ 1: { poolMsat: '98000' } }) });
  assert.equal(split.poolMsat, null);
  assert.equal(SHIPPED.settledLine(split), 'Settled: this seat\'s 96000 msat stake went into the pool');
  // AND BEFORE SETTLEMENT: held, with the result's standing; nothing before anyone answered.
  const held = await SHIPPED.settlementBy({ entryId: 'ee'.repeat(32), seats: seatKeys, nodes,
    fetcher: answers({ 0: { hold: 'HELD', poolMsat: null, finality: 'PROVISIONALLY_FINAL' }, 1: { hold: 'HELD', poolMsat: null, finality: 'PROVISIONALLY_FINAL' } }) });
  assert.equal(SHIPPED.settledLine(held), 'Settlement: this seat\'s 96000 msat stake is held, the result PROVISIONALLY_FINAL');
  assert.equal(SHIPPED.settledLine(undefined), '');
  console.log(`  after settlement: "${made['blwp-settled'].textContent}"`);
});

test('a tab that cannot keep the record does not ask the wallet at all', async () => {
  const cannot = { getItem: () => null, setItem() { throw new Error('QuotaExceededError'); } };
  const endpoints = await recipients();
  const wallet = await walletOnARelay();
  try {
    const load = await pageLoad({ storage: cannot, endpoints, wallet });
    assert.deepEqual([load.asked.length, load.log.totalMsat, load.said.paidMsat, load.said.unpaidMsat], [0, 0n, 0n, 2000n]);
    for (const f of load.said.failed) assert.match(f.why, /could not keep a record/);
  } finally { await endpoints.close(); await wallet.close(); }
});

// ---- the set, from the seats

const contractFor = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash', startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n, objectionWindowMs: 600000n, custody: 'THRESHOLD_LN', slashMinimumServed: 20,
  slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: SET_ID,
  censusHeight: 900000, censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000, exposureReference: 1000,
  corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});
const signedBytes = (set) => { const body = encodeDonationSetBody(set); const out = new Uint8Array(body.length + 64); out.set(body); out.set(set.signature, body.length); return out; };

test('the page takes the set from every seat of the round, checked under the network\'s Ed25519 authority', async () => {
  const seats = [];
  for (let i = 0; i < 2; i++) seats.push(await serve(openStore(':memory:'), { port: 0, funded: () => true, now: () => NOW, donationSets: [SET] }));
  try {
    const round = contractFor(seats.map((s) => s.round.pubkey));
    for (const s of seats) assert.equal((await fetch(`http://127.0.0.1:${s.port}/round`, { method: 'POST', body: encodeRoundContract(round) })).status, 201);
    const nodes = seats.map((s) => `http://127.0.0.1:${s.port}`);
    const got = await fetchDonationSet({ round, nodes, verifyEd25519 });
    assert.equal(got.ok, true, got.why);
    assert.deepEqual(got.set.recipients, SET.recipients);
    assert.match(donationRecipientsLine(got.set), /66\.67% to http:\/\/127\.0\.0\.1:18777\/lnurlp\/blwp-test-a, 33\.33% to .*blwp-test-b/);
    console.log(`  ${got.why}; ${donationRecipientsLine(got.set)}`);
  } finally { await Promise.all(seats.map((s) => s.close())); }
});

test('a seat missing, a seat serving another set, a forged set, or a set the rotated-away authority signed is refused', async () => {
  const round = contractFor([b32(1), b32(2)]);
  const serving = (bySeat, rotations = []) => async (url) => {
    const u = new URL(url);
    const seat = u.port;
    if (u.pathname === '/donation-rotations') return new Response(JSON.stringify({ rotations }), { status: 200 });
    const bytes = bySeat[seat];
    return bytes ? new Response(bytes, { status: 200 }) : new Response('this seat holds no signed donation set', { status: 404 });
  };
  const nodes = ['http://127.0.0.1:1', 'http://127.0.0.1:2'];
  const honest = signedBytes(SET);
  const forged = signedBytes({ ...SET, signature: ed25519.sign(donationSetBodyId(SET), ed25519.utils.randomSecretKey()) });
  assert.equal((await fetchDonationSet({ round, nodes, verifyEd25519, fetcher: serving({ 1: honest, 2: honest }) })).ok, true);
  assert.match((await fetchDonationSet({ round, nodes, verifyEd25519, fetcher: serving({ 1: honest }) })).why, /not every seat/);
  assert.match((await fetchDonationSet({ round, nodes, verifyEd25519, fetcher: serving({ 1: honest, 2: forged }) })).why, /serve different donation sets/);
  assert.match((await fetchDonationSet({ round, nodes, verifyEd25519, fetcher: serving({ 1: forged, 2: forged }) })).why, /not signed by the network's donation authority/);

  // A ROTATION, served by one seat only: the old authority's set is no set once it is in force.
  const oldKey = ed25519.utils.randomSecretKey();
  const newKey = ed25519.utils.randomSecretKey();
  const recovery = ed25519.utils.randomSecretKey();
  const keys = { authority: ed25519.getPublicKey(oldKey), recovery: ed25519.getPublicKey(recovery) };
  const body = { networkId: NETWORK_ID_REGTEST, serial: 1n, validFrom: 0, recipients: SET.recipients };
  const byOld = signedBytes({ ...body, signature: ed25519.sign(donationSetBodyId(body), oldKey) });
  const byNew = signedBytes({ ...body, signature: ed25519.sign(donationSetBodyId(body), newKey) });
  const rotationBody = { networkId: NETWORK_ID_REGTEST, serial: 1n, newAuthority: ed25519.getPublicKey(newKey), validFrom: 10 };
  const rotation = { body: toHex(encodeAuthorityRotation(rotationBody)), signature: toHex(ed25519.sign(authorityRotationId(rotationBody), recovery)) };
  assert.equal((await fetchDonationSet({ round, nodes, verifyEd25519, keys, fetcher: serving({ 1: byOld, 2: byOld }) })).ok, true, 'no rotation: the old authority signs');
  const stale = await fetchDonationSet({ round, nodes, verifyEd25519, keys, fetcher: serving({ 1: byOld, 2: byOld }, [rotation]) });
  assert.match(stale.why, /not signed/, 'after the rotation the old authority\'s set is refused');
  const fresh = await fetchDonationSet({ round, nodes, verifyEd25519, keys, fetcher: serving({ 1: byNew, 2: byNew }, [rotation]) });
  assert.deepEqual([fresh.ok, fresh.rotated], [true, true]);
});

// NO DONATION BEFORE THE STAKE IS IN (M3.2 6e, §22A). The donation is part of one
// wallet commitment, and the fee base and the donation count financially
// activated entries only. Measured before: the page paid the donation as soon as
// the seats took the entry - before "Pay the stake" was pressed - so a player
// seated who never paid the stake, or whose wallet refused it, had donated anyway.
test('no donation leaves the wallet before the seats hold the stake: uncommitted, the wallet is asked nothing; committed, 1334 + 666', async () => {
  const endpoints = await recipients();
  const wallet = await walletOnARelay();
  const log = spendLog();
  try {
    const client = new Client({ base: 'http://127.0.0.1:9', core: {}, sign: async () => new Uint8Array(64), verify: () => true });
    const entry = entryOf(2000n);
    const ask = () => client.payDonation(entry, SET, { connection: wallet.uri, curve: pageCurve, fetcher: endpoints.fetcher, log, random: rand, timeoutMs: 5000 });

    const early = await ask();
    const earlyMsat = wallet.asked.map((pr) => decodeBolt11(pr).amountMsat);
    console.log(`  stake not committed: wallet asked ${earlyMsat.length} time(s) for ${earlyMsat.reduce((t, a) => t + a, 0n)} msat, `
      + `recipients invoiced ${endpoints.issued.length}, spent ${log.totalMsat} msat - ${early.why || 'paid'}`);
    assert.deepEqual([earlyMsat.length, endpoints.issued.length, log.totalMsat], [0, 0, 0n], 'a donation left the wallet before the seats held the stake');
    assert.equal(early.ok, false);
    assert.match(early.why, /stake/);

    client.stakeCommitted = true;
    const late = await ask();
    assert.equal(late.ok, true, late.why);
    assert.deepEqual(wallet.asked.map((pr) => decodeBolt11(pr).amountMsat), [1334n, 666n]);
    assert.equal(log.totalMsat, 2000n);
  } finally { await endpoints.close(); await wallet.close(); }
});

test('the page asks for the donation only once the seats hold the stake', () => {
  const page = readFileSync(PAGE, 'utf8');
  const at = page.indexOf('c.payDonation(c.seatEntry');
  assert.ok(at > 0, 'the page no longer pays the donation through its Client');
  const guard = page.slice(page.lastIndexOf('if (c && c.seatEntry', at), at);
  assert.match(guard, /c\.stakeCommitted/, `the page asks for the donation before the seats hold the stake: ${guard.replace(/\s+/g, ' ').slice(0, 200)}`);
});
