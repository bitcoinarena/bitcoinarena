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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { ed25519 } from '@noble/curves/ed25519.js';
import { fetchDonationSet, donationRecipientsLine } from '../src/donation-pay.js';
import { Client } from '../src/client.js';
import { chooseDonation } from '../src/donation-choice.js';
import { entryFor } from '../src/join.js';
import { spendLog, nip04Decrypt, nip04Encrypt, signEvent, NWC_REQUEST, NWC_RESPONSE } from '../src/nwc.js';
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

/** A NIP-47 wallet on a local relay that pays whatever reaches it and keeps every invoice it was asked. */
async function walletOnARelay() {
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
      const content = await nip04Encrypt(JSON.stringify({ result_type: 'pay_invoice', result: { preimage: 'ab'.repeat(32), fees_paid: 0 } }),
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

// ---- the set, from the seats

const contractFor = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1),
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash', startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
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
