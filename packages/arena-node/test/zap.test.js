// ZAPS AND TIPS (kanban #362 item 14, NIP-57): the request and receipt rules, the zap-taking Lightning address, the page's
// client paying it, the receipt read back from the game's relay, and the developer's signed tip address beside a manifest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { zapRequestTemplate, zapRequestStands, zapReceiptStands, zapReceiptTemplate, zapInvoiceStands, zapTotals, payRequestTakesZaps,
  nostrEventSigned, ZAP_REQUEST_KIND, ZAP_RECEIPT_KIND } from '../../arena-protocol/src/zap.js';
import { lnurlFor } from '../../arena-protocol/src/bech32.js';
import { gameInfoDigest, gameInfoFits, gameInfoStands, gameInfoJson } from '../../arena-protocol/src/game-info.js';
import { Writer } from '../../arena-protocol/src/encode.js';
import { taggedHash } from '../../arena-protocol/src/hash.js';
import { TAG } from '../../arena-protocol/src/constants.js';
import { serveZapAddresses, signNostr, addressMetadata } from '../src/zap-address.js';
import { startRelay, eventRefusal, RELAY_KINDS } from '../src/nostr-relay.js';
import { sendToRelay } from '../src/nostr-results.js';
import { testInvoice } from './bolt11-fixture.js';
import { sendZap, zapsReceived, playerLightningAddress, zapProfileEvent, zapTarget } from '../../arena-client/src/zap.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const verify = curve.verify;
const keyPair = () => { const secret = schnorr.utils.randomSecretKey(); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const RELAY = 'wss://relay.example';

/** The Lightning node, standing in: invoices as BOLT11 bytes of what was asked; `settle(hash)` marks one paid. */
function fakeLightning() {
  const made = new Map();
  return {
    made,
    invoice: async ({ amountMsat, descriptionHash }) => {
      const preimage = randomBytes(32);
      const paymentHash = sha(preimage);
      const request = testInvoice({ amountMsat, paymentHash, descriptionHash });
      made.set(hex(paymentHash), { request, preimage: hex(preimage), settled: false, amountMsat, descriptionHash: hex(descriptionHash) });
      return { request, paymentHash: hex(paymentHash) };
    },
    lookup: async ({ paymentHash }) => { const m = made.get(paymentHash); return { settled: !!(m && m.settled), preimage: m && m.preimage, settledAtS: 1790000100 }; },
    payByRequest(request) { for (const m of made.values()) if (m.request === request) { m.settled = true; return m.preimage; } return null; },
  };
}

const signedRequest = (payer, opts) => signNostr(zapRequestTemplate(opts), { secret: payer.secret, curve, nowS: 1790000000 });

test('a zap request names one recipient, the amount and the relays, and stands only signed and for the amount asked', () => {
  const payer = keyPair(); const to = keyPair();
  const t = zapRequestTemplate({ recipient: to.pubkey, amountMsat: 21000n, relays: [RELAY, RELAY], payRequestUrl: 'https://zap.example/.well-known/lnurlp/bob', comment: 'gg' });
  assert.equal(t.kind, ZAP_REQUEST_KIND);
  assert.deepEqual(t.tags.map((x) => x[0]), ['relays', 'amount', 'lnurl', 'p']);
  assert.deepEqual(t.tags[0], ['relays', RELAY], 'a relay named twice is named once');
  const r = signNostr(t, { secret: payer.secret, curve });
  assert.ok(nostrEventSigned(r, { verify }).ok);
  const ok = zapRequestStands(r, { amountMsat: 21000n, verify });
  assert.deepEqual([ok.ok, ok.recipient, ok.relays, ok.amountMsat], [true, to.pubkey, [RELAY], 21000n]);
  assert.match(zapRequestStands(r, { amountMsat: 21001n, verify }).why, /is for 21000 msat, and the callback was asked 21001/);
  assert.match(zapRequestStands({ ...r, content: 'tampered' }, { amountMsat: 21000n, verify }).why, /not the hash of its own fields/);
  const twoP = signNostr({ ...t, tags: [...t.tags, ['p', payer.pubkey]] }, { secret: payer.secret, curve });
  assert.match(zapRequestStands(twoP, { verify }).why, /exactly one recipient/);
  const noRelays = signNostr({ ...t, tags: t.tags.filter((x) => x[0] !== 'relays') }, { secret: payer.secret, curve });
  assert.match(zapRequestStands(noRelays, { verify }).why, /relays its receipt goes to/);
  const forged = { ...r, sig: hex(schnorr.sign(Buffer.from(r.id, 'hex'), to.secret)) };
  assert.match(zapRequestStands(forged, { verify }).why, /signature is not/);
  assert.throws(() => zapRequestTemplate({ recipient: to.pubkey, amountMsat: 999n, relays: [RELAY] }), /at least 1 sat/);
  assert.throws(() => zapRequestTemplate({ recipient: to.pubkey, amountMsat: 1000n, relays: [] }), /names 1 to 8 relays/);
  assert.throws(() => zapRequestTemplate({ recipient: to.pubkey, amountMsat: 1000n, relays: [RELAY], comment: 'x'.repeat(281) }), /at most 280/);
});

test('a receipt counts only when the recipient\'s server signed it, for its request\'s amount under that request\'s hash', () => {
  const payer = keyPair(); const to = keyPair(); const server = keyPair(); const other = keyPair();
  const request = signedRequest(payer, { recipient: to.pubkey, amountMsat: 100000n, relays: [RELAY], comment: 'nice run' });
  const description = JSON.stringify(request);
  const preimage = randomBytes(32);
  const invoice = testInvoice({ amountMsat: 100000n, paymentHash: sha(preimage), descriptionHash: sha(description) });
  assert.ok(zapInvoiceStands({ invoice, amountMsat: 100000n, description, network: 'regtest' }).ok);
  assert.match(zapInvoiceStands({ invoice, amountMsat: 100000n, description: `${description} ` }).why, /description hash is not the zap request's/);
  assert.match(zapInvoiceStands({ invoice, amountMsat: 100000n, description, network: 'bitcoin' }).why, /for regtest, not bitcoin/);
  const receipt = signNostr(zapReceiptTemplate({ request, description, invoice, preimage: hex(preimage), paidAtS: 1790000050 }), { secret: server.secret, curve });
  assert.equal(receipt.kind, ZAP_RECEIPT_KIND);
  const s = zapReceiptStands(receipt, { nostrPubkey: server.pubkey, verify });
  assert.deepEqual([s.ok, s.sender, s.recipient, s.amountMsat, s.comment, s.paidAtS], [true, payer.pubkey, to.pubkey, 100000n, 'nice run', 1790000050]);
  assert.match(zapReceiptStands(receipt, { nostrPubkey: other.pubkey, verify }).why, /not the recipient's server/);
  const byOther = signNostr(zapReceiptTemplate({ request, description, invoice, paidAtS: 1 }), { secret: other.secret, curve });
  assert.match(zapReceiptStands(byOther, { nostrPubkey: server.pubkey, verify }).why, /not the recipient's server/);
  const cheaper = testInvoice({ amountMsat: 1000n, paymentHash: sha(preimage), descriptionHash: sha(description) });
  const lie = signNostr(zapReceiptTemplate({ request, description, invoice: cheaper, paidAtS: 1 }), { secret: server.secret, curve });
  assert.match(zapReceiptStands(lie, { nostrPubkey: server.pubkey, verify }).why, /asks 1000 msat, and the zap is 100000/);
  const badPre = signNostr(zapReceiptTemplate({ request, description, invoice, preimage: hex(randomBytes(32)), paidAtS: 1 }), { secret: server.secret, curve });
  assert.match(zapReceiptStands(badPre, { nostrPubkey: server.pubkey, verify }).why, /preimage is not the invoice's/);
  const t = zapTotals([receipt, receipt, { ...receipt, id: 'x' }, lie], { nostrPubkey: server.pubkey, verify });
  assert.deepEqual([t.count, t.msat], [1, 100000n], 'one invoice counts once; a forged or cheaper receipt not at all');
  assert.equal(RELAY_KINDS.includes(9735), true);
  assert.equal(eventRefusal(receipt, { nowS: 1790000060 }), null, 'the game\'s relay keeps zap receipts');
});

test('the zap address answers a zap pay request, invoices under the request\'s hash, and publishes the receipt once paid', async () => {
  const ln = fakeLightning();
  const server = keyPair();
  const published = [];
  const dir = mkdtempSync(join(tmpdir(), 'zap-'));
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: server.secret, curve, invoice: ln.invoice,
    lookup: ln.lookup, publish: async (e, relays) => published.push({ e, relays }), statePath: join(dir, 'state.json'), watchMs: 50 });
  const local = `http://127.0.0.1:${z.port}`;
  const pr = await (await fetch(`${local}/.well-known/lnurlp/bob`)).json();
  assert.deepEqual([pr.tag, pr.allowsNostr, pr.nostrPubkey, pr.callback, pr.commentAllowed], ['payRequest', true, server.pubkey, 'https://zap.example/lnurlp/bob/cb', 280]);
  assert.ok(payRequestTakesZaps(pr).ok);
  assert.equal(pr.metadata, addressMetadata('bob', 'zap.example'));
  assert.equal((await fetch(`${local}/.well-known/lnurlp/alice`)).status, 404);

  const payer = keyPair(); const to = keyPair();
  const request = signedRequest(payer, { recipient: to.pubkey, amountMsat: 21000n, relays: [RELAY], payRequestUrl: 'https://zap.example/.well-known/lnurlp/bob' });
  const cb = (amount, nostr, extra = '') => `${local}/lnurlp/bob/cb?amount=${amount}${nostr ? `&nostr=${encodeURIComponent(nostr)}` : ''}${extra}`;
  const said = await (await fetch(cb(21000, JSON.stringify(request), `&lnurl=${lnurlFor('https://zap.example/.well-known/lnurlp/bob')}`))).json();
  assert.ok(said.pr, JSON.stringify(said));
  assert.ok(zapInvoiceStands({ invoice: said.pr, amountMsat: 21000n, description: JSON.stringify(request) }).ok);
  assert.match((await (await fetch(cb(22000, JSON.stringify(request)))).json()).reason, /is for 21000 msat/);
  assert.match((await (await fetch(cb(21000, JSON.stringify({ ...request, content: 'x' })))).json()).reason, /not the hash of its own fields/);
  assert.match((await (await fetch(cb(21000, JSON.stringify(request), `&lnurl=${lnurlFor('https://other.example/x')}`))).json()).reason, /not this address/);
  // THE CALLBACK UNDER A PATH (measured live: publicBase https://host/zap): the request names the address's well-known URL
  const based = await serveZapAddresses({ port: 0, publicHost: 'zap.example', publicBase: 'https://zap.example/zap', names: ['bob'], secret: server.secret, curve,
    invoice: ln.invoice, lookup: ln.lookup, publish: async () => {}, watchMs: 50 });
  const bpr = await (await fetch(`http://127.0.0.1:${based.port}/.well-known/lnurlp/bob`)).json();
  assert.equal(bpr.callback, 'https://zap.example/zap/lnurlp/bob/cb');
  const via = await (await fetch(`http://127.0.0.1:${based.port}/lnurlp/bob/cb?amount=21000&nostr=${encodeURIComponent(JSON.stringify(request))}&lnurl=${lnurlFor('https://zap.example/.well-known/lnurlp/bob')}`)).json();
  assert.ok(via.pr, JSON.stringify(via));
  await based.close();
  const tip = await (await fetch(cb(5000, null))).json();
  assert.equal(ln.made.get([...ln.made.keys()].pop()).descriptionHash, hex(sha(pr.metadata)), 'a plain tip is invoiced under the address\'s metadata');
  assert.ok(tip.pr);
  assert.equal(z.pending.size, 1, 'only the zap waits for a receipt');

  await z.close();
  const z2 = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: server.secret, curve, invoice: ln.invoice,
    lookup: ln.lookup, publish: async (e, relays) => published.push({ e, relays }), statePath: join(dir, 'state.json'), watchMs: 50 });
  assert.equal(z2.pending.size, 1, 'a restart keeps the zap it still owes a receipt for');
  ln.payByRequest(said.pr);
  for (let i = 0; i < 100 && !published.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].relays, [RELAY]);
  const s = zapReceiptStands(published[0].e, { nostrPubkey: server.pubkey, lnurl: lnurlFor('https://zap.example/.well-known/lnurlp/bob'), verify });
  assert.deepEqual([s.ok, s.sender, s.recipient, s.amountMsat, s.paidAtS], [true, payer.pubkey, to.pubkey, 21000n, 1790000100]);
  assert.equal(z2.pending.size, 0);
  await z2.close();
});

test('the page zaps a player from its own wallet, and reads the receipt and the player\'s address back from the relay', async () => {
  const ln = fakeLightning();
  const server = keyPair();
  const relay = await startRelay({ port: 0 });
  const relayUrl = `ws://127.0.0.1:${relay.port}`;
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: server.secret, curve, invoice: ln.invoice,
    lookup: ln.lookup, publish: async (e, relays) => { for (const r of relays) await sendToRelay(r, [e]); }, watchMs: 50 });
  const fetcher = (url, o) => fetch(String(url).replace('https://zap.example', `http://127.0.0.1:${z.port}`), o);
  const payer = keyPair(); const bob = keyPair();
  const WebSocketImpl = WebSocket;

  const profile = await zapProfileEvent({ name: 'bob', lud16: 'Bob@Zap.Example', secret: bob.secret, curve });
  assert.ok(profile.ok);
  assert.equal(JSON.parse(profile.event.content).lud16, 'bob@zap.example');
  assert.equal((await sendToRelay(relayUrl, [profile.event])).get(profile.event.id).ok, true);
  const address = await playerLightningAddress(bob.pubkey, { relays: [relayUrl], curve, WebSocketImpl });
  assert.equal(address, 'bob@zap.example');
  assert.equal((await zapProfileEvent({ name: 'x', lud16: 'not an address', secret: bob.secret, curve })).ok, false);

  const target = await zapTarget(address, 21000n, { fetcher });
  assert.deepEqual([target.ok, target.zaps, target.nostrPubkey], [true, true, server.pubkey]);
  let asked = null;
  const sent = await sendZap({ address, recipient: bob.pubkey, amountMsat: 21000n, comment: 'gg', relays: [relayUrl], secret: payer.secret, curve,
    network: 'regtest', fetcher, pay: async (inv) => { asked = inv; return { ok: true, preimage: ln.payByRequest(inv) }; } });
  assert.equal(sent.ok, true, sent.why);
  assert.equal(sent.zapped, true);
  assert.equal(sent.invoice, asked);
  let got = { count: 0 };
  for (let i = 0; i < 100 && got.count === 0; i++) {
    await new Promise((r) => setTimeout(r, 30));
    got = await zapsReceived(bob.pubkey, { relays: [relayUrl], nostrPubkey: server.pubkey, curve, WebSocketImpl, timeoutMs: 2000 });
  }
  assert.deepEqual([got.count, got.msat, got.zaps[0].sender, got.zaps[0].comment], [1, 21000n, payer.pubkey, 'gg']);

  const wrongNet = await sendZap({ address, recipient: bob.pubkey, amountMsat: 21000n, relays: [relayUrl], secret: payer.secret, curve,
    network: 'bitcoin', fetcher, pay: async () => assert.fail('an invoice for another network is never paid') });
  assert.match(wrongNet.why, /for regtest, not bitcoin/);
  const tip = await sendZap({ address, amountMsat: 5000n, fetcher, pay: async (inv) => ({ ok: true, preimage: ln.payByRequest(inv) }) });
  assert.deepEqual([tip.ok, tip.zapped], [true, false], 'a tip with no recipient key is a plain LNURL payment');
  const liar = await sendZap({ address, amountMsat: 5000n, fetcher, pay: async () => ({ ok: true, preimage: hex(randomBytes(32)) }) });
  assert.match(liar.why, /preimage is not the invoice's/);
  await z.close();
  await relay.close();
});

test('a developer\'s tip address is signed beside the manifest, and an info signed without one keeps its digest', () => {
  const gameId = new Uint8Array(32).fill(7);
  const info = { description: 'A game', website: 'https://game.example' };
  const w = new Writer(); w.bytes32(gameId); w.str(info.description); w.str(info.website);
  const before = taggedHash(TAG.gameInfo, w.finish());
  assert.equal(hex(gameInfoDigest(gameId, info)), hex(before), 'no address: the digest every signed info already carries');
  assert.equal(hex(gameInfoDigest(gameId, { ...info, lightning: '' })), hex(before));
  const withTip = gameInfoDigest(gameId, { ...info, lightning: 'dev@tips.example' });
  assert.notEqual(hex(withTip), hex(before));
  assert.match(gameInfoFits({ lightning: 'Dev@Tips.example' }).why, /lower case/);
  assert.match(gameInfoFits({ lightning: 'not-an-address' }).why, /tip address/);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const devPub = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const manifest = { gameDevPubkey: devPub };
  const edv = (sig, msg, pub) => edVerify(null, Buffer.from(msg), { key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pub)]), format: 'der', type: 'spki' }, Buffer.from(sig));
  const signed = { ...info, lightning: 'dev@tips.example', signature: hex(edSign(null, Buffer.from(withTip), privateKey)) };
  const s = gameInfoStands(signed, { gameId, manifest, verify: edv });
  assert.deepEqual([s.ok, s.lightning], [true, 'dev@tips.example']);
  assert.equal(gameInfoStands({ ...signed, lightning: 'thief@tips.example' }, { gameId, manifest, verify: edv }).ok, false, 'another address is not the developer\'s');
  assert.equal(gameInfoJson(signed).lightning, 'dev@tips.example');
  assert.equal('lightning' in gameInfoJson(info), false);
});
