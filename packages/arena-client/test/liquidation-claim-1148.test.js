// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WHOLE WALLET WENT TO A URL ONE SEAT NAMED (kanban #1148, the 2026-11-06 state-machine audit): presentNotes took the liquidation and its
// `claims` URL from the first seat that answered, never checked the claim window, and deleted the kept notes on a refusal's wording. One seat
// listing { federation: <the player's>, claims: "https://attacker" } emptied the wallet into bearer e-cash posted there. Each case below is that
// scenario or one of its guards: a liquidation only k of the chain's arbitration keys signed, the notes only at the door that event names,
// the window from its signed halt height against the page's tip, taken only when a signed event lists the claim, every state written first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { presentNotes, pendingClaimKey, claimStep, liquidationDoors } from '../src/liquidation-claim.js';
import { eventMessage } from '../../arena-protocol/src/arbitration-event.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const FED = 'ab'.repeat(32);
const PK = '02' + '11'.repeat(32);
const secrets = [1, 2, 3, 4].map((n) => new Uint8Array(32).fill(n));
const keys = secrets.map((x) => toHex(schnorr.getPublicKey(x)));
const SET = { keys: keys.slice(0, 3), k: 2 };            // the chain's set: three keys, two signatures; key 4 is no member
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const liquidation = (extra = {}) => ({ kind: 'liquidation', network: 'regtest', federation: FED, status: 'claims open', halt: { height: 1000, proof: null },
  door: 'http://arb.example', firstMs: 1, atMs: 1, ...extra });
const signedBy = (event, idx) => ({ event, signatures: idx.map((i) => ({ key: keys[i], sig: toHex(schnorr.sign(eventMessage(event), secrets[i])) })) });
const signed = (extra) => [signedBy(liquidation(extra), [0, 1])];
const ATTACKER_LIST = [{ federation: FED, claims: 'https://attacker.example/liquidation-claims', liquidatesAt: 0, lateClaimsUntil: 1e9 }];

function rig({ failWrite = null, receive = true } = {}) {
  const store = new Map(), calls = [];
  const storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => { if (failWrite && failWrite(k, v)) throw new Error('QuotaExceededError: the quota has been exceeded'); store.set(k, v); },
    removeItem: (k) => store.delete(k),
  };
  const wallet = {
    sendAllEcash: async () => { calls.push('send'); return JSON.stringify({ msat: 768000, ecash: 'notes-1' }); },
    receiveEcash: async (e) => { calls.push(['receive', e]); if (!receive) throw new Error('the federation is halted'); return '{}'; },
    pendingOutputs: async () => '[]',
  };
  const fetcher = async (url, o) => { calls.push(['post', url, JSON.parse(o.body).ecash || null]); return { ok: true, json: async () => ({ accepted: [1] }) }; };
  const put = (s, k, v) => s.setItem(k, v);
  const base = { network: 'regtest', arbitration: SET, verify, held: [FED], walletFor: async () => wallet, payoutPk: PK, height: 1012, storage, fetcher, put };
  return { store, calls, storage, base };
}
const posts = (calls) => calls.filter((c) => Array.isArray(c) && c[0] === 'post');

test('THE SCENARIO: one seat lists the player\'s federation with its own claims URL and no signed event - nothing leaves the wallet, nothing is posted', async () => {
  const { calls, store, base } = rig();
  const out = await presentNotes({ ...base, events: [], liquidations: ATTACKER_LIST });
  assert.deepEqual(calls, [], 'no sendAllEcash, no post');
  assert.equal(store.size, 0);
  assert.equal(out.length, 0);
});

test('a signed liquidation: the notes go only to the door the set signed, whatever URL a seat listed', async () => {
  const { calls, store, base } = rig();
  const out = await presentNotes({ ...base, events: signed(), liquidations: ATTACKER_LIST });
  assert.deepEqual(posts(calls).map((c) => c[1]), ['http://arb.example/liquidation-claims']);
  assert.ok(!calls.some((c) => Array.isArray(c) && String(c[1]).includes('attacker')));
  assert.equal(JSON.parse(store.get(pendingClaimKey(FED))).state, 'posted');
  assert.equal(out[0].door, 'http://arb.example');
});

test('an event short of k valid member signatures, or of another chain, or naming no door, is not acted on', async () => {
  for (const events of [
    [signedBy(liquidation(), [0])],                         // one signature, k = 2
    [signedBy(liquidation(), [0, 3])],                      // key 4 is not in the set
    [{ ...signedBy(liquidation(), [0, 1]), event: liquidation({ door: 'https://attacker.example' }) }],   // the door changed after signing
    signed({ network: 'testnet4' }),                        // another chain's event
    signed({ door: undefined }),                            // the set named no door
    signed({ door: 'ftp://arb.example' }),
  ]) {
    const { calls, store, base } = rig();
    const out = await presentNotes({ ...base, events });
    assert.deepEqual(calls, [], JSON.stringify(out));
    assert.equal(store.size, 0);
    assert.match(out[0].why, /^nothing handed over/);
  }
});

test('the window: no tip read, nothing handed over; before the window or after it, nothing handed over', async () => {
  for (const [height, why] of [[undefined, /chain tip is not known/], [1005, /claims open at 1010/], [1101, /claims closed/]]) {
    const { calls, base } = rig();
    const out = await presentNotes({ ...base, events: signed(), height });
    assert.deepEqual(calls, []);
    assert.match(out[0].why, why);
  }
});

test('a door\'s answer is no receipt: a refusal saying "claimed before" keeps the notes; a signed event listing this key takes them', async () => {
  const { store, base } = rig();
  const refusing = async () => ({ ok: false, json: async () => ({ refused: [{ why: 'claimed before' }] }) });
  await presentNotes({ ...base, events: signed(), fetcher: refusing });
  assert.equal(JSON.parse(store.get(pendingClaimKey(FED))).state, 'kept');
  const other = await presentNotes({ ...base, events: signed({ atMs: 2, claims: { accepted: [{ nonce: 'n', amountMsat: '1', height: 1012, payoutPk: '02' + '22'.repeat(32) }], refused: [], msat: '1' } }), fetcher: refusing });
  assert.ok(store.has(pendingClaimKey(FED)), 'another key accepted is not this claim');
  assert.ok(!other.some((x) => x.taken));
  const taken = await presentNotes({ ...base, events: signed({ atMs: 3, claims: { accepted: [{ nonce: 'n', amountMsat: '768000', height: 1012, payoutPk: PK }], refused: [], msat: '768000' } }) });
  assert.equal(taken[0].taken, true);
  assert.ok(!store.has(pendingClaimKey(FED)));
});

test('nothing irreversible before its state is written: a refused intent write leaves the wallet untouched', async () => {
  const { calls, store, base } = rig({ failWrite: () => true });
  const out = await presentNotes({ ...base, events: signed() });
  assert.deepEqual(calls, []);
  assert.equal(store.size, 0);
  assert.match(out[0].why, /could not write the claim first/);
});

test('notes handed over that cannot be written go back into the wallet; a halted one that cannot take them has them presented at the signed door at once', async () => {
  const kept = (k, v) => k === pendingClaimKey(FED) && JSON.parse(v).state === 'kept';
  const a = rig({ failWrite: kept });
  const back = await presentNotes({ ...a.base, events: signed() });
  assert.deepEqual(a.calls.filter((c) => Array.isArray(c) && c[0] === 'receive'), [['receive', 'notes-1']]);
  assert.equal(posts(a.calls).length, 0);
  assert.match(back[0].why, /back in the wallet/);
  const b = rig({ failWrite: kept, receive: false });
  const now = await presentNotes({ ...b.base, events: signed() });
  assert.deepEqual(posts(b.calls).map((c) => [c[1], c[2]]), [['http://arb.example/liquidation-claims', 'notes-1']]);
  assert.equal(now.find((x) => x.door).memoryOnly, true);
});

test('one transition function: every step the claim takes, and a step it does not refused', () => {
  let r = claimStep(null, 'intent', { door: 'd' });
  r = claimStep(r, 'kept', { ecash: 'e' });
  r = claimStep(r, 'posted', { postedAtMs: 1 });
  r = claimStep(r, 'posted', { postedAtMs: 2 });
  assert.deepEqual([r.state, r.ecash, r.door, r.postedAtMs], ['posted', 'e', 'd', 2]);
  assert.equal(claimStep(r, 'none'), null);
  assert.throws(() => claimStep(r, 'intent'), /posted -> posted \| none, not -> intent/);
  assert.throws(() => claimStep(null, 'posted'), /none -> intent \| kept, not -> posted/);
});

test('an older page\'s kept notes (a bare string) are read as kept and presented at the signed door', async () => {
  const { store, calls, base } = rig();
  store.set(pendingClaimKey(FED), 'legacy-notes');
  await presentNotes({ ...base, events: signed() });
  assert.deepEqual(posts(calls).map((c) => c[2]), ['legacy-notes']);
  assert.ok(!calls.includes('send'), 'the kept notes are presented, the wallet is not emptied again');
});

test('the doors the payouts are read at: only the signed events\', never a seat\'s', () => {
  assert.deepEqual(liquidationDoors({ events: signed(), network: 'regtest', arbitration: SET, verify }), ['http://arb.example']);
  assert.deepEqual(liquidationDoors({ events: [signedBy(liquidation(), [0])], network: 'regtest', arbitration: SET, verify }), []);
  assert.deepEqual(liquidationDoors({ events: signed(), network: 'regtest', arbitration: SET }), [], 'no signature check, no door');
});

test('with no arbitration set given, the chain\'s own is read (BOND_TERMS arbitrationKeys / arbitrationK): measured live, UI 554 preview, it read none', async () => {
  const { arbitrationOf } = await import('../src/liquidation-claim.js');
  const { BOND_TERMS } = await import('../src/committee.js');
  assert.deepEqual(arbitrationOf('testnet4'), { keys: BOND_TERMS.testnet4.arbitrationKeys, k: BOND_TERMS.testnet4.arbitrationK });
  assert.equal(arbitrationOf('testnet4').k, 5);
  assert.equal(arbitrationOf('nowhere'), null);
  // our two test keys are not the chain's: refused for want of the chain's signatures - not for want of a threshold
  const { calls, base } = rig();
  const { arbitration, ...rest } = base; void arbitration;
  const out = await presentNotes({ ...rest, events: signed() });
  assert.deepEqual(calls, []);
  assert.match(out[0].why, /0 valid signatures of the arbitration set, and an event needs 5/);
});

// KANBAN #1230 (audit 3 #1210 FIXES-2): `taken` is read per payout key, and a notes record whose POST got no answer (kept, never presented) was
// dropped when the set accepted another claim of that key - its pending outputs' record, posted the same pass - and the notes were lost.
test('#1230 notes the door never answered are presented again when the set lists another claim of the key; answered ones are taken', async () => {
  const { store, base } = rig();
  const down = async () => { throw new Error('the request timed out'); };
  await presentNotes({ ...base, events: signed(), fetcher: down });
  assert.equal(JSON.parse(store.get(pendingClaimKey(FED))).state, 'kept');
  // the set now accepts another claim under this key (the pending outputs'), and the door answers again
  const seen = [];
  const ok = async (url, o) => { seen.push(JSON.parse(o.body).ecash || null); return { ok: true, json: async () => ({ accepted: [1] }) }; };
  const out = await presentNotes({ ...base, events: signed({ atMs: 3, claims: { accepted: [{ nonce: 'pending-1', amountMsat: '1000', height: 1012, payoutPk: PK }], refused: [], msat: '1000' } }), fetcher: ok });
  assert.deepEqual(seen, ['notes-1'], 'the notes never presented were dropped instead of presented');
  assert.ok(!out.some((x) => x.taken));
  // a 5xx is no answer either
  const { store: s2, base: b2 } = rig();
  await presentNotes({ ...b2, events: signed(), fetcher: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await presentNotes({ ...b2, events: signed({ atMs: 3, claims: { accepted: [{ nonce: 'pending-1', amountMsat: '1000', height: 1012, payoutPk: PK }], refused: [], msat: '1000' } }), fetcher: ok });
  assert.equal(JSON.parse(s2.get(pendingClaimKey(FED))).state, 'posted', 'a record the door answered 503 was taken unpresented');
});

// KANBAN #1264 (audit 4 #1257 fixesA-2): #1230 counted any non-5xx answer as "the door answered" - also the door's own refusals that take nothing
// (the claim window not open at its tip, not HALTED at any seat yet, not validated, a reissue refused) and a tunnel's 4xx. Once another claim of the key
// was accepted, those notes were dropped unpresented. Only an answer that names the notes it refused counts now.
test('#1264 a refusal that took nothing (window, validation, a tunnel\'s 429) is no answer: the notes are presented again, never dropped', async () => {
  const otherClaim = signed({ atMs: 3, claims: { accepted: [{ nonce: 'pending-1', amountMsat: '1000', height: 1012, payoutPk: PK }], refused: [], msat: '1000' } });
  const facts = {};
  for (const [name, status, body] of [['window', 409, { why: 'the claim window opens at 1013 (halted at 1000 + abandon_blocks); the tip is 1012' }],
                                      ['not validated', 422, { why: 'those notes do not stand: not validated' }], ['tunnel', 429, {}]]) {
    const { store, base } = rig();
    await presentNotes({ ...base, events: signed(), fetcher: async () => ({ ok: false, status, json: async () => body }) });
    const seen = [];
    const ok = async (url, o) => { seen.push(JSON.parse(o.body).ecash || null); return { ok: true, json: async () => ({ accepted: [1] }) }; };
    const out = await presentNotes({ ...base, events: otherClaim, fetcher: ok });
    facts[name] = { firstAnswer: status, presentedAgain: seen.includes('notes-1'), dropped: out.some((x) => x.taken), state: JSON.parse(store.get(pendingClaimKey(FED)) || '{"state":"gone"}').state };
  }
  // and "claimed before" (the notes named as refused) is an answer as before: taken by the set's word
  const { store: s4, base: b4 } = rig();
  await presentNotes({ ...b4, events: signed(), fetcher: async () => ({ ok: false, status: 409, json: async () => ({ refused: [{ nonce: 'n1', why: 'that note was claimed before' }], why: 'none of those notes can be claimed' }) }) });
  const out4 = await presentNotes({ ...b4, events: otherClaim, fetcher: async () => ({ ok: true, json: async () => ({ accepted: [1] }) }) });
  facts.claimedBefore = { taken: out4.some((x) => x.taken), left: s4.has(pendingClaimKey(FED)) };
  console.log('  FACTS #1264:', JSON.stringify(facts));
  for (const name of ['window', 'not validated', 'tunnel']) {
    assert.equal(facts[name].presentedAgain, true, `${name}: the notes were not presented again`);
    assert.equal(facts[name].dropped, false, `${name}: the notes were dropped unpresented`);
    assert.equal(facts[name].state, 'posted');
  }
  assert.deepEqual(facts.claimedBefore, { taken: true, left: false });
});
