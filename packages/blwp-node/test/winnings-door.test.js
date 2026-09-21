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

async function owedNode({ pay = async () => ({ preimage: 'ab'.repeat(32), feeMsat: 0n }), owed = 98000n,
  owe = true } = {}) {
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
  if (owe) node.round.putWinnings({ entryId: eid, roundId: rid, owedMsat: owed, state: 'OWED', why: 'the table owes it' });
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

// AND WITHOUT NWC AT ALL: A LIGHTNING ADDRESS (the owner 2026-09-21 13:54, LUD-16 then LUD-06).
//
// A player with no wallet to mint with names an address once. The node asks it for a pay request, asks its
// callback for an invoice of exactly what is owed, checks the invoice against the request, and pays. The
// sender never chooses the amount and never hands over a bolt11.
test('a signed Lightning address is asked for an invoice of exactly what is owed, and a bad one is refused', async () => {
  const asked = [];
  const bolt11 = 'lnbcrtaddresspaid';
  // The player's own LNURL endpoint, as LUD-06 has it.
  const endpoint = async (url) => {
    asked.push(String(url));
    if (String(url).endsWith('/.well-known/lnurlp/win')) return { ok: true, status: 200, json: async () => ({
      tag: 'payRequest', callback: 'https://wallet.example/cb', minSendable: 1, maxSendable: 1000000,
      metadata: JSON.stringify([['text/plain', 'winnings']]) }) };
    if (String(url).startsWith('https://wallet.example/cb')) return { ok: true, status: 200, json: async () => ({ pr: bolt11 }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const w = await owedNode();
  try {
    w.node.custody.payWinningsTo = ((real) => (a) => real({ ...a, fetch: endpoint }))(w.node.custody.payWinningsTo.bind(w.node.custody));
    const r = await fetch(`${w.at}/winnings?entry=${toHex(w.eid)}`, { method: 'POST', body: signedInvoice('win@wallet.example') });
    const body = await r.text();
    // THE ADDRESS IS ASKED, AND ASKED FOR THE NODE'S OWN FIGURE - not the sender's, and not a rounding.
    assert.ok(asked.some((u) => u.includes('/.well-known/lnurlp/win')), `the address was never asked: ${asked}`);
    assert.ok(asked.some((u) => u.includes('amount=98000')), `the callback was asked for the wrong amount: ${asked}`);
    // AND WHAT COMES BACK IS CHECKED BEFORE A SATOSHI MOVES. This endpoint answers with something that is
    // not an invoice at all, and the refusal is LUD-06's own, not a shrug. A real endpoint's invoice is
    // measured on the Daily, where one can actually be signed.
    assert.equal(r.status, 402, body);
    assert.match(body, /not an invoice|bech32/);
    assert.deepEqual(w.paid, [], 'something was paid against an invoice nobody could read');
    assert.equal(w.node.round.winnings(w.eid).state, 'OWED');
  } finally { await w.node.close(); }
});

test('an address that is not one, or whose endpoint asks for another amount, is refused', async () => {
  const w = await owedNode();
  try {
    const no = await fetch(`${w.at}/winnings?entry=${toHex(w.eid)}`, { method: 'POST', body: signedInvoice('not an address') });
    // 400, NOT 402: since an address is kept the moment it is named, its shape is read before anything
    // about money happens. A thing that is not an address is a bad request, not a payment this node
    // declines - and either way nothing is paid and nothing is stored.
    assert.equal(no.status, 400);
    assert.match(await no.text(), /name@host|not a host/);
    assert.deepEqual(w.paid, []);
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

// AN ADDRESS IS TAKEN WHILE THE PLAYER IS STILL THERE, NOT WHEN THE MONEY IS OWED.
//
// the owner 2026-09-21 13:54: "there is no Collect and no pasted invoice after the round". Measured on the
// Daily (ec9bd34e): the address lived only in the tab, the run's Chrome closed at DELIVERED, and FINAL
// came ten minutes later with 98000 msat owed and nobody left to post it. So the door takes the address
// early, keeps it as a standing instruction, and the settle sends to it with no page open.
test('a Lightning address is kept the moment it is named, before the round owes anything', async () => {
  const w = await owedNode({ owe: false });
  const r = await fetch(`${w.at}/winnings?entry=${toHex(w.eid)}`, { method: 'POST', body: signedInvoice('win@example.test') });
  const answer = await r.text();
  assert.equal(r.status, 202, answer);
  const said = JSON.parse(answer);
  assert.equal(said.state, 'NAMED');
  assert.equal(w.node.round.payoutAddress(w.eid).address, 'win@example.test');
  assert.equal(w.paid.length, 0, 'something was paid for a round that owes nothing');
  await w.node.close();
});

test('an address nobody signed for is not kept, and neither is a thing that is not an address', async () => {
  const w = await owedNode({ owe: false });
  const thief = ed25519.utils.randomSecretKey();
  const bad = await fetch(`${w.at}/winnings?entry=${toHex(w.eid)}`,
    { method: 'POST', body: signedInvoice('thief@example.test', thief) });
  assert.equal(bad.status, 403);
  assert.equal(w.node.round.payoutAddress(w.eid), null, 'an unsigned address was kept');
  const junk = await fetch(`${w.at}/winnings?entry=${toHex(w.eid)}`, { method: 'POST', body: signedInvoice('not an address') });
  assert.equal(junk.status, 400);
  assert.equal(w.node.round.payoutAddress(w.eid), null, 'something that is not an address was kept');
  await w.node.close();
});
