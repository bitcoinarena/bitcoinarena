// WHAT THIS NODE STILL TYPES AT LIGHTNING: `addinvoice` and `decodepayreq`, and nothing that holds money.
//
// This file used to pin the hold invoice's four acts - addholdinvoice, lookupinvoice, settleinvoice,
// cancelinvoice - and the table mapping lnd's invoice states onto 23.2's. They were THRESHOLD_LN's
// custody by one operator and are deleted with it (§23.6, RULED 2026-09-22 22:59). What the port does now
// is read a federation's LNv2 invoice (`decode`) and mint an ordinary invoice for a donation recipient
// (`invoice`), and both are pinned here against a fake `lncli`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lndPort } from '../src/lnd-port.js';

const hex = (b) => Buffer.from(b).toString('hex');

function fakeLncli(answers) {
  const said = [];
  const port = lndPort({
    lncli: 'lncli', args: ['--network=regtest'],
    run: async (argv) => { said.push(argv); return answers(argv); },
  });
  return { port, said };
}

test('the port holds nothing: it reads invoices and mints ordinary ones, and has no hold act left', () => {
  const { port } = fakeLncli(() => '{}');
  assert.deepEqual(Object.keys(port).sort(), ['decode', 'invoice']);
  for (const act of ['createHeld', 'look', 'settle', 'cancel', 'pay'])
    assert.equal(port[act], undefined, `${act} is still on the port`);
});

test('an invoice is decoded to the hash and amount it commits to, read off the invoice', async () => {
  const hash = new Uint8Array(32).fill(0xab);
  const { port, said } = fakeLncli(() => JSON.stringify({ payment_hash: hex(hash), num_msat: '980000' }));
  const read = await port.decode({ request: 'lnbcrt9800n1test' });
  assert.deepEqual(said, [['decodepayreq', 'lnbcrt9800n1test']]);
  assert.equal(hex(read.paymentHash), hex(hash));
  assert.equal(read.amountMsat, 980000n);
});

test('a donation invoice is an ordinary addinvoice, described by its metadata hash', async () => {
  const d = new Uint8Array(32).fill(0x11);
  const { port, said } = fakeLncli(() => JSON.stringify({ payment_request: 'lnbcrt1', r_hash: 'cd'.repeat(32) }));
  const made = await port.invoice({ amountMsat: 2000n, descriptionHash: d, expirySeconds: 60 });
  assert.deepEqual(said, [['addinvoice', '--amt_msat', '2000', '--description_hash', hex(d), '--expiry', '60']]);
  assert.equal(made.request, 'lnbcrt1');
  assert.equal(hex(made.paymentHash), 'cd'.repeat(32));
});

test('an answer that is not JSON is named, not parsed into nothing', async () => {
  const { port } = fakeLncli(() => '[lncli] could not load TLS cert file');
  await assert.rejects(() => port.decode({ request: 'lnbcrt1' }), /did not answer JSON/);
});
