// WHAT THIS NODE ACTUALLY TYPES AT LIGHTNING.
//
// `custody-lnd.mjs` runs all of this against a real `lnd v0.21.3-beta` on an
// isolated regtest, which is the measurement that matters and takes minutes.
// What is pinned here is the shape of the commands and the translation of
// lnd's vocabulary into 23.2's, because those are the two places a rename in
// either project would go wrong silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lndPort, STATE_OF } from '../src/lnd-port.js';
import { HELD, SETTLED, CANCELLED } from '../../protocol/src/payout.js';

const hash = new Uint8Array(32).fill(0xab);
const preimage = new Uint8Array(32).fill(0xcd);
const hex = (b) => Buffer.from(b).toString('hex');

function fakeLncli(answers) {
  const said = [];
  const port = lndPort({
    lncli: 'lncli', args: ['--network=regtest'],
    run: async (argv) => { said.push(argv); return answers(argv); },
  });
  return { port, said };
}

test('a hold invoice is asked for by hash and amount, then read back', async () => {
  const { port, said } = fakeLncli((argv) => argv[0] === 'addholdinvoice'
    ? JSON.stringify({ payment_request: 'lnbcrt1' })
    : JSON.stringify({ r_hash: hex(hash), value_msat: '100000', state: 'OPEN', amt_paid_msat: '0' }));

  const made = await port.createHeld({ paymentHash: hash, amountMsat: 100000n });
  assert.deepEqual(said[0], ['addholdinvoice', hex(hash), '--amt_msat', '100000', '--expiry', '3600']);
  assert.deepEqual(said[1], ['lookupinvoice', hex(hash)]);

  // THE ANSWER COMES FROM THE LOOKUP, NOT FROM WHAT WAS ASKED FOR. An invoice
  // this node believes in because it asked for it is exactly what
  // `invoiceMatchesEntry` exists to refuse.
  assert.equal(hex(made.paymentHash), hex(hash));
  assert.equal(made.amountMsat, 100000n);
  assert.equal(made.request, 'lnbcrt1');
});

test('a settle sends the preimage and a cancel sends the hash', async () => {
  const { port, said } = fakeLncli(() => '{}');
  await port.settle({ paymentHash: hash, preimage });
  await port.cancel({ paymentHash: hash });

  // Releasing the preimage IS the settlement, which is why 23.4 wants five of
  // seven shares before it can happen. The hash would settle nothing.
  assert.deepEqual(said[0], ['settleinvoice', '--preimage', hex(preimage)]);
  assert.deepEqual(said[1], ['cancelinvoice', hex(hash)]);
});

test('lnd\'s words are read as 23.2\'s, and an unknown one is refused', async () => {
  // OPEN and ACCEPTED are both HELD: money in flight is in nobody's balance
  // whether or not the player has paid yet.
  assert.equal(STATE_OF.OPEN, HELD);
  assert.equal(STATE_OF.ACCEPTED, HELD);
  assert.equal(STATE_OF.SETTLED, SETTLED);
  assert.equal(STATE_OF.CANCELED, CANCELLED);

  for (const [state, expected] of [['ACCEPTED', HELD], ['SETTLED', SETTLED], ['CANCELED', CANCELLED]]) {
    const { port } = fakeLncli(() => JSON.stringify({ state, value_msat: '100000', amt_paid_msat: '100000' }));
    assert.equal((await port.look({ paymentHash: hash })).state, expected);
  }

  const { port } = fakeLncli(() => JSON.stringify({ state: 'PROBABLY FINE', value_msat: '1', amt_paid_msat: '0' }));
  await assert.rejects(() => port.look({ paymentHash: hash }), /not a state a hold can be in/);
});

test('an answer that is not JSON is named, not parsed into nothing', async () => {
  const { port } = fakeLncli(() => '[lncli] could not load TLS cert file');
  await assert.rejects(() => port.createHeld({ paymentHash: hash, amountMsat: 1n }),
    /did not answer JSON/);
});
