// THE DOOR THAT PAYS A QUALIFIER (§24A.2).
//
// "A payout contract to the player's key; the client withdraws it over Lightning through any listed
// gateway." On THRESHOLD_LN the pool IS the committee's Lightning balance, so the withdrawal is an ordinary
// payment - and the only thing standing between a public entry id and the operator's money is the
// signature. Measured on the Daily before this door existed: a settled round left 98000 msat owed to the
// winner with nothing able to carry it, and the 98 sat sat in the committee's own channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { sha256, toHex } from '../../protocol/src/hash.js';
import { contract as CONTRACT } from './winnings-fixture.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();

const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(7), sessionPubkey: ed25519.getPublicKey(session),
  stakeCommitment: sha256(b32(9)),
  stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0,
  worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33),
  feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
  feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});

/** The envelope the door reads: the invoice's own bytes, then 64 of signature over them. */
const signedInvoice = (request, key = session) => {
  const body = new TextEncoder().encode(request);
  const sig = ed25519.sign(body, key);
  const out = new Uint8Array(body.length + sig.length);
  out.set(body, 0); out.set(sig, body.length);
  return Buffer.from(out);
};

async function owedNode({ pay = async () => ({ preimage: 'ab'.repeat(32), feeMsat: 0n }), owed = 98000n } = {}) {
  const paid = [];
  const port = {
    async createHeld({ paymentHash, amountMsat }) { return { paymentHash, amountMsat, request: 'lnbcrt-x' }; },
    async settle() {}, async cancel() {},
    async decode({ request }) { return { amountMsat: request === 'lnbcrtright' ? owed : 1n }; },
    async pay(a) { paid.push(a.request); return pay(a); },
  };
  const node = await serve(openStore(':memory:'), {
    port: 0, funded: () => true, preflight: async () => ({ ready: true, why: 'test port' }), lightning: port,
  });
  const rid = node.round.open(CONTRACT(node.round.pubkey));
  const entry = entryFor(rid);
  node.round.enter(entry);
  const eid = entryIdOf(entry);
  node.round.putWinnings({ entryId: eid, roundId: rid, owedMsat: owed, state: 'OWED', why: 'the table owes it' });
  return { node, eid, paid, at: `http://127.0.0.1:${node.port}` };
}

test('what the pool owes is served, and a signed invoice for exactly that is paid once', async () => {
  const w = await owedNode();
  try {
    const said = await (await fetch(`${w.at}/winnings?entry=${toHex(w.eid)}`)).json();
    assert.equal(said.owedMsat, '98000');
    assert.equal(said.state, 'OWED');

    const ok = await fetch(`${w.at}/winnings?entry=${toHex(w.eid)}`, { method: 'POST', body: signedInvoice('lnbcrtright') });
    const body = await ok.text();
    assert.equal(ok.status, 200, body);
    assert.deepEqual(JSON.parse(body), { entry: toHex(w.eid), state: 'PAID', paidMsat: '98000', already: false });
    assert.deepEqual(w.paid, ['lnbcrtright']);

    // AND ONLY ONCE: the pool does not go out twice because a page asked twice.
    const again = await fetch(`${w.at}/winnings?entry=${toHex(w.eid)}`, { method: 'POST', body: signedInvoice('lnbcrtright') });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).already, true);
    assert.deepEqual(w.paid, ['lnbcrtright'], 'the pool went out a second time');
  } finally { await w.node.close(); }
});

test('an invoice signed by anyone else is refused: an entry id is public', async () => {
  const w = await owedNode();
  try {
    const thief = ed25519.utils.randomSecretKey();
    const no = await fetch(`${w.at}/winnings?entry=${toHex(w.eid)}`, { method: 'POST', body: signedInvoice('lnbcrtright', thief) });
    assert.equal(no.status, 403);
    assert.match(await no.text(), /not signed by the session key this entry was played with/);
    assert.deepEqual(w.paid, [], 'a stranger was paid this player\'s winnings');
    assert.equal(w.node.round.winnings(w.eid).state, 'OWED');
  } finally { await w.node.close(); }
});

test('an invoice for the wrong amount is refused, not part-paid', async () => {
  const w = await owedNode();
  try {
    const no = await fetch(`${w.at}/winnings?entry=${toHex(w.eid)}`, { method: 'POST', body: signedInvoice('lnbcrtwrong') });
    assert.equal(no.status, 402);
    assert.match(await no.text(), /asks 1 msat and this entry is owed 98000/);
    assert.deepEqual(w.paid, []);
  } finally { await w.node.close(); }
});

test('a payment Lightning refuses leaves the winning OWED with Lightning\'s words on it', async () => {
  const w = await owedNode({ pay: async () => { throw new Error('no route to that node'); } });
  try {
    const no = await fetch(`${w.at}/winnings?entry=${toHex(w.eid)}`, { method: 'POST', body: signedInvoice('lnbcrtright') });
    assert.equal(no.status, 402);
    assert.match(await no.text(), /no route/);
    const row = w.node.round.winnings(w.eid);
    assert.equal(row.state, 'OWED', 'a refused payment left the winning stuck mid-act');
    assert.match(row.why, /no route/);
  } finally { await w.node.close(); }
});

test('an entry this node never took is a 404, and one owed nothing says so', async () => {
  const w = await owedNode();
  try {
    const none = await fetch(`${w.at}/winnings?entry=${'aa'.repeat(32)}`);
    assert.equal(none.status, 404);
    const paid = await fetch(`${w.at}/winnings?entry=${'aa'.repeat(32)}`, { method: 'POST', body: signedInvoice('lnbcrtright') });
    assert.equal(paid.status, 404);
  } finally { await w.node.close(); }
});
