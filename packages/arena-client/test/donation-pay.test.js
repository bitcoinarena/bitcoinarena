// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PLAYER'S DONATION, PAID OVER LNURL TO THE DONATION SET THE SIGNER NODES SERVE
// (M3.2 item 6e; §22A, §24A.2; ruled 2026-09-13).
//
// In process, with the page's own payment code: two local LNURL endpoints at the
// set's fixed address (reached through an injected fetch), each issuing a real
// BOLT11 invoice for what it is asked, and a wallet on a local relay that pays
// whatever reaches it and keeps every invoice it was asked to pay.
//
// Measured before: a 2% donor's 2000 msat was taken by nobody - no LNURL,
// bech32 or BOLT11 code existed, and pay_invoice had one call site, the stake.
// A PAYING ROUND OPENS ONLY ON A SIGNER NODE THAT REACHES A FEDERATION (RULED 2026-09-25): this file's paying-round
// daemons get the lock fixture's port - the test federation, two gateways, zero base fee. Contracts unchanged.
import { lockPort, bondedChainSlot, bondedChainFor } from '../../arena-node/test/lock-fixture.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { test } from 'node:test';
// THE RUN LENGTH IS THE CORE'S. A literal 9000 here is refused by the node as "a
// contract disagreeing with the network it names" - 400, not 201.
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
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
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { openStore } from '../../arena-node/src/store.js';
import { serve } from '../../arena-node/src/server.js';
import { bech32Encode, convertBits, urlOfLnurl } from '../../arena-protocol/src/bech32.js';
import { decodeBolt11 } from '../../arena-protocol/src/bolt11.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST, TEST_DONATION_ENDPOINTS } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId, encodeDonationSet } from '../../arena-protocol/src/donation.js';
import { encodeDonationSetBody, donationSetBodyId, authorityRotationId, encodeAuthorityRotation } from '../../arena-protocol/src/authority.js';
import { pageFunction } from './page-script.js';
import { HOSTED } from '../../arena-node/test/plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { ArenaText, ArenaBits } from './arena-text.js';   // the page's React lines (kanban #564)
import { TRUCK_68E2_HASH } from '../../nextblock/plugin/truck-cores.js';   // the truck versions 1-4 name (kanban #523: the tree now builds a5c5766a)

const b32 = (n) => new Uint8Array(32).fill(n);
const rand = (n) => new Uint8Array(randomBytes(n));
const sha256 = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const SET = TEST_DONATION_SET_REGTEST;
const SET_ID = donationSetId(SET.recipients);
const NOW = 1788700000000;
// A PAYING ROUND NAMES ITS FEDERATION, AND ITS ENTRY ITS LOCK (RULED 2026-09-24, the enum slice's fifth cut, as
// join.test's fixtures): this paying fixture used to be hold-shaped - a stake and no federation - and entryFor now refuses
// that shape. It keeps measuring what it measured, on a real FEDERATION entry: an attested claim key and a stake lock with
// a non-zero outpoint, paying to the dealt stake's point where one is dealt.
const lockedFor = (stakePoint = Uint8Array.of(2, ...new Uint8Array(32).fill(0x6c))) => ({
  claimKey: { ok: true, ref: new Uint8Array(32).fill(0x9a) },
  stakeLock: { outpoint: { txid: new Uint8Array(32).fill(0xd8), outIdx: 0 }, fields: { paymentImage: { kind: 'point', bytes: stakePoint } } },
});
const paying = { id: b32(0x21), stakeMsat: 100000n, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: fromHex(TRUCK_68E2_HASH), federationId: TEST_FEDERATION_ID };
const seed = b32(0x5e);
const entryOf = (donationMsat) => ({ ...entryFor(paying, { seed, curve: feldmanGroup, random: rand, donationMsat, ...lockedFor() }), roundId: b32(0x21) });
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
    client.stakeCommitted = true;   // the signer nodes hold the stake: only then does a donation go (6e)
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

test('the player wallet pays the donation (2026-10-01): payWith gets exactly the recipients\' invoices, no wallet connection needed', async () => {
  const entry = entryOf(2000n);
  const endpoints = await recipients();
  const paidBy = [];
  try {
    const client = new Client({ base: 'http://127.0.0.1:9', core: {}, sign: async () => new Uint8Array(64), verify: () => true });
    client.stakeCommitted = true;
    const said = await client.payDonation(entry, SET, { fetcher: endpoints.fetcher, random: rand,
      payWith: async (invoice) => { paidBy.push(invoice); return { ok: true, preimage: 'cd'.repeat(32) }; } });
    assert.equal(said.ok, true, said.why);
    assert.equal(said.paidMsat, 2000n);
    assert.deepEqual(paidBy, endpoints.issued.map((i) => i.pr), 'the player wallet paid something other than the recipients\' invoices');
  } finally { await endpoints.close(); }
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
  client.stakeCommitted = true;   // the signer nodes hold the stake: only then does a donation go (6e)
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
// against a DOM stubbed down to what it touches, with dist/arena-client.js as
// ARENACLIENT - the way wallet-nwc.test.js drives it.

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const SHIPPED = createRequire(import.meta.url)('../dist/arena-client.js');
const NOTE_IS = { paid: 'paid', unpaid: 'unpaid', asked: 'unknown' };
const A = TEST_DONATION_ENDPOINTS[0];
const B = TEST_DONATION_ENDPOINTS[1];

/** Runs the page's own paintWallet for this entry and answers every element it painted. */
function paintThePage({ round, entry, donationPaid, settlement, spent = SHIPPED.spendLog(), owed = null }) {
  const page = readFileSync(PAGE, 'utf8');
  const body = page.slice(page.indexOf('function paintWallet()'));
  const src = body.slice(0, body.indexOf('\n    }') + 6);
  const made = {};
  // THE FAKE ELEMENT CARRIES WHAT THE PAGE ACTUALLY CALLS. The page clears the
  // deposit box with `replaceChildren()` (index.html 1623 and 1637); without it
  // five of these tests died on "depositEl.replaceChildren is not a function"
  // before reaching a single assertion, so the settlement display they cover was
  // not being checked at all. Appending is recorded the same way the page does it.
  const el = (id) => (made[id] = made[id] || {
    style: {}, textContent: '', placeholder: '', disabled: false, children: [],
    replaceChildren(...kids) { this.children = kids; if (!kids.length) this.textContent = ''; },
    appendChild(kid) { this.children.push(kid); return kid; },
  });
  pageFunction(new URL('../../../src/arena-ui/index.html', import.meta.url), ['document', 'window', 'ARENACLIENT', 'wallet', 'spent', 'owed', 'paying', 'walletWhy', 'budget'],
    src, ' return paintWallet();')(
    { getElementById: el }, { ArenaText, ARENA_ROUND: round, ARENA_ENTRY: entry, ARENA_DONATION_PAID: donationPaid, ARENA_SETTLEMENT: settlement },
    SHIPPED, { connected: false }, spent, owed, false, '', null);
  return made;
}

/**
 * Runs the shipping page's own settlement poll (askTheSettlement, with its flag) against
 * signer nodes that answer `hold`, then its paintWallet - both off the shipped bundle.
 */
async function settleOnThePage({ hold, spent, stakeCommitment, round }) {
  const page = readFileSync(PAGE, 'utf8');
  const from = page.indexOf('    let settlementAsking = false;');
  const fn = page.indexOf('async function askTheSettlement()', from);
  const src = page.slice(from, page.indexOf('\n    }\n', fn) + 6);
  const signerNodeKeys = [b32(0x71), b32(0x72)];
  const fetcher = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/identity') return new Response(signerNodeKeys[u.port === '1' ? 0 : 1], { status: 200 });
    return new Response(JSON.stringify({ entry: 'ee'.repeat(32), hold, holdMsat: '98000', poolMsat: '98000', finality: 'FINAL' }), { status: 200 });
  };
  const client = { joinedEntry: { stakeCommitment }, where: { entryId: 'ee'.repeat(32) } };
  const win = { ARENA_ROUND: round, ARENA_STAKE: { signerNodeKeys, nodes: ['http://127.0.0.1:1', 'http://127.0.0.1:2'] } };
  const BL = { ...SHIPPED, settlementBy: (o) => SHIPPED.settlementBy({ ...o, fetcher }) };
  await pageFunction(new URL('../../../src/arena-ui/index.html', import.meta.url), ['window', 'ARENACLIENT', 'theClient', 'spent', 'paintWallet'], src, ' return askTheSettlement();')(
    win, BL, () => client, spent, () => {});
  return win.ARENA_SETTLEMENT;
}

/** What one page load shows, painted the way the page paints it after payDonation answers. */
function shown(load, round, storage) {
  const state = SHIPPED.donationPaidState(SET, load.said);
  const text = (paintThePage({ round, entry: load.entry, donationPaid: state })['arena-donation'] || {}).textContent || '';
  const rows = state.shares.map((s) => [s.url, s.amountMsat, s.state]);
  const onScreen = state.shares.filter((s) => text.includes(`${s.amountMsat} msat ${({ paid: 'paid', unpaid: 'UNPAID', unknown: 'outcome unknown' })[s.state]} to ${s.url}`)).length;
  // AND THE SCREEN SAYS WHAT THE TAB'S NOTES SAY, share by share.
  const notes = donationPaidRecord(storage, { roundId: load.entry.roundId, playerPubkey: load.entry.playerPubkey });
  const noted = state.shares.map((s) => NOTE_IS[notes.shares[s.lnurl].state]);
  return { state, text, rows, onScreen, noted };
}

/** Runs the shipping page's own showNotedDonation - the failure path's - against a stubbed DOM. */
function showNotedOnThePage({ search, storage }) {
  const page = readFileSync(PAGE, 'utf8');
  const body = page.slice(page.indexOf('function showNotedDonation()'));
  const src = body.slice(0, body.indexOf('\n    }') + 6);
  const made = {};
  const el = (id) => (made[id] = made[id] || { textContent: '', classes: new Set(), classList: { add(c) { made[id].classes.add(c); } } });
  pageFunction(new URL('../../../src/arena-ui/index.html', import.meta.url), ['document', 'window', 'ARENACLIENT', 'location'], src, ' return showNotedDonation();')(
    { getElementById: el }, { ArenaText, sessionStorage: storage, ARENA_CURVE: pageCurve }, SHIPPED, { search });
  return made['arena-donation-noted'];
}

test('a reload whose round link cannot be reached still shows the donation from the tab\'s notes, and asks the wallet nothing', async () => {
  const storage = tabStorage();
  storage.setItem('arena.player.seed', toHex(seed));
  const endpoints = await recipients();
  const wallet = await walletOnARelay({ refuseMsat: 666n });
  try {
    const first = await pageLoad({ storage, endpoints, wallet });
    assert.deepEqual([first.said.paidMsat, first.said.unpaidMsat], [1334n, 666n]);
    const askedBefore = wallet.asked.length;
    const issuedBefore = endpoints.issued.length;

    // THE ROUND LINK OF THAT ROUND, ITS NODES GONE: no signer node, no set, no payDonation.
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
    for (const [k, v] of storage.m) if (k !== 'arena.player.seed') bare.setItem(k, v);
    const noSeed = showNotedOnThePage({ search: `?round=${toHex(b32(0x21))}`, storage: bare });
    assert.deepEqual([noSeed.textContent, noSeed.classes.has('show'), bare.getItem('arena.player.seed')], ['', false, null], 'a seed was minted to read the notes');
    console.log(`  no signer node, round unreachable: "${shown.textContent}"`);
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

// ---- the set, from the signer nodes

const contractFor = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash', startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: SET_ID,
  censusHeight: 900000, censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS, exposureReference: 1000,
  corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});
const signedBytes = (set) => { const body = encodeDonationSetBody(set); const out = new Uint8Array(body.length + 64); out.set(body); out.set(set.signature, body.length); return out; };

test('the page takes the set from every signer node of the round, checked under the network\'s Ed25519 authority', async () => {
  const signerNodes = [];
  // ON A CHAIN THAT BONDS THE ROUND'S TWO SIGNER NODES (RULED 2026-09-25): one chain both daemons read. Only the round's
  // censusRoot changes.
  const slot = bondedChainSlot(lockPort());
  for (let i = 0; i < 2; i++) signerNodes.push(await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, stakeLocks: slot.port, chainFor: slot.chainFor,
    randomnessFor: slot.randomnessFor, funded: () => true, now: () => NOW, donationSets: [SET] }));
  try {
    const drafted = contractFor(signerNodes.map((s) => s.round.pubkey));
    const round = { ...drafted, censusRoot: bondedChainFor(drafted.nodes, drafted, slot,
      { endpoints: signerNodes.map((s) => `ws://127.0.0.1:${s.port}`) }).censusRoot };
    for (const s of signerNodes) assert.equal((await fetch(`http://127.0.0.1:${s.port}/round`, { method: 'POST', body: encodeRoundContract(round) })).status, 201);
    const nodes = signerNodes.map((s) => `http://127.0.0.1:${s.port}`);
    const got = await fetchDonationSet({ round, nodes, verifyEd25519 });
    assert.equal(got.ok, true, got.why);
    assert.deepEqual(got.set.recipients, SET.recipients);
    assert.match(donationRecipientsLine(got.set), /66\.67% to http:\/\/127\.0\.0\.1:18777\/lnurlp\/blwp-test-a, 33\.33% to .*blwp-test-b/);
    console.log(`  ${got.why}; ${donationRecipientsLine(got.set)}`);
  } finally { await Promise.all(signerNodes.map((s) => s.close())); }
});

test('a signer node missing, a signer node serving another set, a forged set, or a set the rotated-away authority signed is refused', async () => {
  const round = contractFor([b32(1), b32(2)]);
  // AND EACH SIGNER NODE SERVES THE ROUND'S GAME'S DONATION SET: nextblock's, unless a test hands another
  const serving = (bySignerNode, rotations = [], gameSet = NEXTBLOCK.donationSet) => async (url) => {
    const u = new URL(url);
    const signerNode = u.port;
    if (u.pathname === '/donation-rotations') return new Response(JSON.stringify({ rotations }), { status: 200 });
    if (u.pathname === '/game-donation-set') return new Response(encodeDonationSet(gameSet), { status: 200 });
    const bytes = bySignerNode[signerNode];
    return bytes ? new Response(bytes, { status: 200 }) : new Response('this signer node holds no signed donation set', { status: 404 });
  };
  const nodes = ['http://127.0.0.1:1', 'http://127.0.0.1:2'];
  const honest = signedBytes(SET);
  const forged = signedBytes({ ...SET, signature: ed25519.sign(donationSetBodyId(SET), ed25519.utils.randomSecretKey()) });
  assert.equal((await fetchDonationSet({ round, nodes, verifyEd25519, fetcher: serving({ 1: honest, 2: honest }) })).ok, true);
  // a game set its manifest does not name is no game set: the game dev's half is never routed to it
  (await import('../src/donation-pay.js')).forgetGameSets();
  const strayGame = [{ recipientPk: Uint8Array.from([0x02, ...b32(0x5e)]), label: 'not the game dev', shareBps: 10000 }];
  assert.match((await fetchDonationSet({ round, nodes, verifyEd25519, fetcher: serving({ 1: honest, 2: honest }, [], strayGame) })).why,
    /not the set the game's manifest names/);
  assert.match((await fetchDonationSet({ round, nodes, verifyEd25519, fetcher: serving({ 1: honest }) })).why, /not every signer node/);
  // A READ THE CONNECTION DROPPED (kanban #803, "Load failed" on a phone) is a node that did not answer, not a refusal - and half must still serve
  const dropping = (ports, f) => async (url) => { if (ports.includes(new URL(url).port)) throw new TypeError('Load failed'); return f(url); };
  assert.equal((await fetchDonationSet({ round, nodes, verifyEd25519, fetcher: dropping(['2'], serving({ 1: honest })) })).ok, true);
  assert.match((await fetchDonationSet({ round, nodes, verifyEd25519, fetcher: dropping(['1', '2'], serving({})) })).why, /only 0 of 2 nodes served/);
  assert.match((await fetchDonationSet({ round, nodes, verifyEd25519, fetcher: serving({ 1: honest, 2: forged }) })).why, /serve different donation sets/);
  assert.match((await fetchDonationSet({ round, nodes, verifyEd25519, fetcher: serving({ 1: forged, 2: forged }) })).why, /not signed by the network's donation authority/);

  // A ROTATION, served by one signer node only: the old authority's set is no set once it is in force.
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
// the signer nodes took the entry - before "Pay the stake" was pressed - so a player
// joined who never paid the stake, or whose wallet refused it, had donated anyway.
test('no donation leaves the wallet before the signer nodes hold the stake: uncommitted, the wallet is asked nothing; committed, 1334 + 666', async () => {
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
    assert.deepEqual([earlyMsat.length, endpoints.issued.length, log.totalMsat], [0, 0, 0n], 'a donation left the wallet before the signer nodes held the stake');
    assert.equal(early.ok, false);
    assert.match(early.why, /stake/);

    client.stakeCommitted = true;
    const late = await ask();
    assert.equal(late.ok, true, late.why);
    assert.deepEqual(wallet.asked.map((pr) => decodeBolt11(pr).amountMsat), [1334n, 666n]);
    assert.equal(log.totalMsat, 2000n);
  } finally { await endpoints.close(); await wallet.close(); }
});

test('the page asks for the donation only once the signer nodes hold the stake', () => {
  // paid through Unity's own Client in the run's line: Tick Tock's page part (kanban #521)
  const page = readFileSync(new URL('../../nextblock/page/unity-page.js', import.meta.url), 'utf8');
  const at = page.indexOf('c.payDonation(c.joinedEntry');
  assert.ok(at > 0, 'the page no longer pays the donation through its Client');
  const guard = page.slice(page.lastIndexOf('if (c && c.joinedEntry', at), at);
  assert.match(guard, /c\.stakeCommitted/, `the page asks for the donation before the signer nodes hold the stake: ${guard.replace(/\s+/g, ' ').slice(0, 200)}`);
});

test('a node that does not answer holds no join, and a set fetched and checked is not fetched again for the next round', async () => {
  const round = contractFor([b32(1), b32(2), b32(3)]);
  const honest = signedBytes(SET);
  let setAsks = 0;
  const fetcher = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/donation-rotations') return new Response(JSON.stringify({ rotations: [] }), { status: 200 });
    if (u.pathname === '/game-donation-set') return new Response(encodeDonationSet(NEXTBLOCK.donationSet), { status: 200 });
    setAsks++;
    if (u.port === '3') return new Promise(() => {});            // a seat behind a link that never answers
    return new Response(honest, { status: 200 });
  };
  const nodes = ['http://127.0.0.1:1', 'http://127.0.0.1:2', 'http://127.0.0.1:3'];
  const t = Date.now();
  const first = await fetchDonationSet({ round, nodes, verifyEd25519, fetcher, keepBySet: true });
  assert.equal(first.ok, true, first.why);
  assert.equal(first.signerNodes, 2, 'the two that answered');
  assert.ok(Date.now() - t < 8000, 'not held past the answer budget');
  const asked = setAsks;
  const next = await fetchDonationSet({ round: { ...round, id: b32(0x22) }, nodes, verifyEd25519, fetcher, keepBySet: true });
  assert.equal(next.ok, true, next.why);
  assert.equal(setAsks, asked, 'the set this round names was not fetched again');
  // without keepBySet (every other caller), nothing is kept: all three asked again, the silent one left out after its budget
  const lone = await fetchDonationSet({ round, nodes: nodes.slice(2), verifyEd25519, fetcher });
  assert.match(lone.why, /only 0 of 1 nodes served/);
});

test('a majority that serves the same set is not held for the slowest node (kanban #625); a refusal in before it waits for all', async () => {
  const { firstMajority } = await import('../src/donation-pay.js');
  const b = new Uint8Array([1, 2, 3]);
  const at = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
  const names = ['a', 'b', 'c', 'd'];
  let t = Date.now();
  const got = await firstMajority([at(5, { node: 'a', bytes: b }), at(10, { node: 'b', bytes: b }), at(15, { node: 'c', bytes: b }), new Promise(() => {})], names, { graceMs: 30 });
  assert.ok(Date.now() - t < 500, 'not held for the hung node');
  assert.deepEqual(got.map((x) => !!x.bytes), [true, true, true, false]);
  assert.equal(got[3].late, true);
  t = Date.now();
  const refused = await firstMajority([at(2, { node: 'a', why: '404 no such round' }), at(5, { node: 'b', bytes: b }), at(5, { node: 'c', bytes: b }), at(80, { node: 'd', bytes: b })], names, { graceMs: 10 });
  assert.ok(Date.now() - t >= 70, 'with a refusal in, every answer is waited for');
  assert.equal(refused[0].why, '404 no such round');
  assert.ok(refused[3].bytes);
  const split = await firstMajority([at(5, { node: 'a', bytes: b }), at(5, { node: 'b', bytes: new Uint8Array([9]) }), at(5, { node: 'c', bytes: b }), at(60, { node: 'd', bytes: b })], names, { graceMs: 10 });
  assert.ok(split.every((x) => x.bytes), 'answers that differ wait for all');
});
