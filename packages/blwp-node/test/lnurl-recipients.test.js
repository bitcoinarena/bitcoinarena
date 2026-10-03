// THE DONATION SET'S TWO LOCAL TEST RECIPIENTS, ANSWERING (M3.2 6e). What a
// paid round's launcher binds at 127.0.0.1:18777 - bound here on a free port.
// Measured before: nothing listened there, and both shares came back "the
// recipient's endpoint did not answer".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { serveDonationRecipients, recipientMetadata, TEST_RECIPIENT_PORT, TEST_RECIPIENT_NAMES } from '../src/lnurl-recipients.js';
import { lndPort } from '../src/node-start.js';
import { bech32Encode, convertBits } from '../../protocol/src/bech32.js';
import { decodeBolt11 } from '../../protocol/src/bolt11.js';
import { payRequestStands, invoiceAnswersPayRequest } from '../../protocol/src/lnurl-pay.js';
import { TEST_DONATION_ENDPOINTS } from '../../protocol/src/test-donation-sets.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());

/** The Lightning node's half, standing in: a real BOLT11 encoding of what it was asked (unsigned). */
function invoiceMaker(asked) {
  return async ({ amountMsat, descriptionHash }) => {
    asked.push({ amountMsat, descriptionHash: hex(descriptionHash) });
    const amount = amountMsat % 100n === 0n ? `${amountMsat / 100n}n` : `${amountMsat * 10n}p`;
    const words = [];
    for (let i = 6; i >= 0; i--) words.push(Math.floor(1788700000 / 32 ** i) % 32);
    const field = (type, bytes) => { const w = convertBits([...bytes], 8, 5, true); words.push(type, w.length >> 5, w.length & 31, ...w); };
    field(1, new Uint8Array(32).fill(asked.length));
    field(23, descriptionHash);
    for (let i = 0; i < 104; i++) words.push(0);
    return { request: bech32Encode(`lnbcrt${amount}`, words) };
  };
}

test('the recipients are the two the signed set names, at its fixed port', () => {
  assert.equal(TEST_RECIPIENT_PORT, 18777);
  assert.deepEqual(TEST_RECIPIENT_NAMES.map((n) => `http://127.0.0.1:${TEST_RECIPIENT_PORT}/lnurlp/${n}`), TEST_DONATION_ENDPOINTS);
});

test('each recipient answers its pay request and invoices exactly the share, under its own metadata hash', async () => {
  const asked = [];
  const r = await serveDonationRecipients({ port: 0, invoice: invoiceMaker(asked) });
  try {
    for (const [name, share] of [['blwp-test-a', 1334n], ['blwp-test-b', 666n]]) {
      const first = await fetch(`${r.base}/lnurlp/${name}`);
      assert.equal(first.headers.get('access-control-allow-origin'), '*', 'a page on another origin cannot read it');
      const said = await first.json();
      assert.deepEqual([said.tag, said.callback, said.metadata, said.commentAllowed], ['payRequest', `${r.base}/lnurlp/${name}/cb`, recipientMetadata(name), 64]);
      const stands = payRequestStands(said, share);
      assert.equal(stands.ok, true, stands.why);
      const cb = new URL(stands.callback);
      cb.searchParams.set('amount', String(share));
      cb.searchParams.set('comment', 'ab'.repeat(32));
      const { pr } = await (await fetch(cb)).json();
      const d = decodeBolt11(pr);
      assert.deepEqual([d.network, d.amountMsat, hex(d.descriptionHash)], ['regtest', share, hex(sha(recipientMetadata(name)))]);
      assert.equal(invoiceAnswersPayRequest({ invoice: pr, amountMsat: share, metadata: said.metadata, network: 'regtest' }).ok, true);
    }
    assert.deepEqual(r.issued.map((i) => [i.name, i.amountMsat, i.comment]), [['blwp-test-a', 1334n, 'ab'.repeat(32)], ['blwp-test-b', 666n, 'ab'.repeat(32)]]);
    assert.deepEqual(asked.map((a) => a.amountMsat), [1334n, 666n]);
  } finally { await r.close(); }
});

test('with no Lightning node, a bad amount or an unknown recipient, nothing is invoiced and the refusal says why', async () => {
  const bare = await serveDonationRecipients({ port: 0 });
  const asked = [];
  const r = await serveDonationRecipients({ port: 0, invoice: invoiceMaker(asked), maxSendable: 5000 });
  try {
    assert.equal((await (await fetch(`${bare.base}/lnurlp/blwp-test-a`)).json()).tag, 'payRequest', 'it still answers the pay request');
    assert.match((await (await fetch(`${bare.base}/lnurlp/blwp-test-a/cb?amount=1334`)).json()).reason, /no Lightning node to invoice from/);
    assert.match((await (await fetch(`${r.base}/lnurlp/blwp-test-a/cb?amount=x`)).json()).reason, /whole number/);
    assert.match((await (await fetch(`${r.base}/lnurlp/blwp-test-a/cb?amount=5001`)).json()).reason, /outside 1\.\.5000/);
    assert.equal((await fetch(`${r.base}/lnurlp/blwp-test-z`)).status, 404);
    assert.deepEqual([bare.issued.length, r.issued.length, asked.length], [0, 0, 0]);
  } finally { await bare.close(); await r.close(); }
});

test('the Lightning port makes a plain invoice for exactly the amount, under the description hash', async () => {
  const calls = [];
  const port = lndPort({ lncli: 'lncli', run: async (argv) => { calls.push(argv); return JSON.stringify({ r_hash: 'cd'.repeat(32), payment_request: 'lnbcrt13340p1test' }); } });
  const made = await port.invoice({ amountMsat: 1334n, descriptionHash: sha('m') });
  assert.deepEqual(calls[0], ['addinvoice', '--amt_msat', '1334', '--description_hash', hex(sha('m')), '--expiry', '3600']);
  assert.deepEqual([made.request, hex(made.paymentHash)], ['lnbcrt13340p1test', 'cd'.repeat(32)]);
});
