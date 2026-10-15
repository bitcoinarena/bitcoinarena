// A FOUNDING CEREMONY AS THE SEATS RUN IT (spec §23A.2, kanban #320): eight guardian-capable nodes of eight operators; four drawn, three
// alternates. Every seat computes the same draw; the seated post signed setup codes, a code from anyone else is refused; with all
// four codes in, each seated guardian adds the other three and starts the DKG (position 0 leads). THE WINDOW (kanban #320, comment
// 2258): founding_window blocks from the beacon (trigger 100 -> beacon 101, window 10 -> it ends at 111), one window however many
// replacements; a seated node with no code a FIFTH of the window (2 blocks) after it was seated is a no-show, replaced by the next
// alternate in its position; at the window's end with no federation the founding is void.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { createFounding, setupDigest } from '../src/founding.js';

const key = (s) => { const secret = taggedHash('TEST/founding', new TextEncoder().encode(s)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const verify = (sig, m, k) => { try { return schnorr.verify(sig, m, k); } catch { return false; } };
const keys = Array.from({ length: 8 }, (_, i) => key(`n${i}`));
const entries = keys.map((k, i) => ({ pubkey: k.pub, txid: taggedHash('TEST/tx', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
  advert: { operatorId: `op${i}`, guardianCapable: true, guardianEndpoint: `wss://g${i}` } }));
const seed = taggedHash('TEST/beacon', Uint8Array.of(1));

function network({ offline = new Set(), done = () => true } = {}) {
  const log = [];
  const seats = [];
  const fake = (i) => ({
    localParams: async ({ leader, name, size }) => { log.push(['params', i, leader, leader ? name : null, leader ? size : null]); return `code-${i}`; },
    addPeer: async (code) => { log.push(['add', i, code]); },
    startDkg: async () => { log.push(['dkg', i]); },
    invite: async () => 'fed11invite',
    done: async () => log.some((l) => l[0] === 'dkg' && l[1] === i) && done(i),     // consensus once its DKG ran (unless told otherwise)
  });
  for (let i = 0; i < keys.length; i++) {
    seats.push(createFounding({ seed, triggerHeight: 100, entries, nominal: 4, bondMinGuardian: 500000n, foundingWindow: 10,
      ownKey: keys[i].pub, sign: (h) => schnorr.sign(h, keys[i].secret), verify, setup: fake(i),
      post: async (m) => { for (const s of seats) s.take(m); } }));
  }
  const round = async (tip) => { for (let i = 0; i < seats.length; i++) if (!offline.has(i)) await seats[i].advance(tip); };
  return { seats, log, round };
}
const idx = (hex) => keys.findIndex((k) => toHex(k.pub) === hex);

test('every seat draws the same four; their codes in, each seated guardian adds the other three and starts the DKG', async () => {
  const n = network();
  const st = n.seats.map((s) => s.state());
  for (const s of st) assert.deepEqual(s.seated.map((x) => x.node), st[0].seated.map((x) => x.node));
  const seated = st[0].seated.map((x) => idx(x.node));
  assert.equal(seated.length, 4); assert.equal(st[0].alternates.length, 3);
  await n.round(101);
  await n.round(102);                                   // the codes posted in the first step are all in by the second
  const params = n.log.filter((l) => l[0] === 'params');
  assert.deepEqual(params.map((l) => l[1]).sort(), [...seated].sort(), 'only the seated start a guardian');
  assert.deepEqual(params.filter((l) => l[2]).map((l) => [l[1], l[3], l[4]]), [[seated[0], 'arena', 4]], 'position 0 leads');
  for (const i of seated) {
    assert.deepEqual(n.log.filter((l) => l[0] === 'add' && l[1] === i).map((l) => l[2]).sort(), seated.filter((j) => j !== i).map((j) => `code-${j}`).sort());
    assert.ok(n.log.some((l) => l[0] === 'dkg' && l[1] === i));
  }
  for (const s of n.seats) { const x = s.state(); assert.ok(x.seated.every((y) => y.code)); }
  assert.equal(n.seats[seated[0]].state().invite, 'fed11invite');
});

test('a code from a node not seated, or not signed by it, is refused', async () => {
  const n = network();
  const st = n.seats[0].state();
  const outsider = keys.findIndex((k) => !st.seated.some((x) => x.node === toHex(k.pub)));
  const id = Uint8Array.from(Buffer.from(st.id, 'hex'));
  const m = { id: st.id, node: toHex(keys[outsider].pub), code: 'x', signature: toHex(schnorr.sign(setupDigest(id, keys[outsider].pub, 'x'), keys[outsider].secret)) };
  assert.equal(n.seats[0].take(m).status, 409);
  const s0 = idx(st.seated[0].node);
  const forged = { id: st.id, node: st.seated[0].node, code: 'x', signature: toHex(schnorr.sign(setupDigest(id, keys[s0].pub, 'x'), keys[outsider].secret)) };
  assert.match(n.seats[0].take(forged).why, /not signed by its node/);
});

test('a drawn node silent for a fifth of the window is replaced by the first alternate in its position; the DKG runs with it', async () => {
  const probe = network().seats[0].state();
  assert.deepEqual([probe.beacon, probe.windowEnd, probe.fifth], [101, 111, 2], 'the window from the beacon, its fifth');
  const silent = idx(probe.seated[1].node), alt = idx(probe.alternates[0]);
  const n = network({ offline: new Set([silent]) });
  await n.round(101); await n.round(102);
  assert.deepEqual(n.seats[0].state().noShows, [], 'not before a fifth of the window (beacon 101 + 2)');
  assert.ok(!n.log.some((l) => l[0] === 'dkg'), 'no DKG while a seat has no code');
  await n.round(103);                                   // a fifth of the window: the no-show is replaced (the spec's 103, not 111)
  let st = n.seats[0].state();
  assert.deepEqual(st.noShows, [toHex(keys[silent].pub)]);
  assert.deepEqual([st.seated[1].node, st.seated[1].since], [toHex(keys[alt].pub), 103], 'the alternate takes the no-show\'s position, seated at 103');
  assert.deepEqual([st.beacon, st.windowEnd], [101, 111], 'a replacement opens no new window');
  await n.round(104);
  st = n.seats[0].state();
  const seated = st.seated.map((x) => idx(x.node));
  for (const i of seated) assert.ok(n.log.some((l) => l[0] === 'dkg' && l[1] === i), `seat ${i} started the DKG`);
  assert.ok(!n.log.some((l) => l[1] === silent), 'the no-show never took part');
  await n.round(105);                                   // the seated guardians are in consensus: the federation runs, nothing voids it
  await n.round(111); await n.round(120);
  const end = n.seats[st.seated.map((x) => idx(x.node))[0]].state();
  assert.deepEqual([end.federation, end.void, end.failed], [true, false, null]);
  // a late code from the no-show is refused: it is no longer seated
  const id = Uint8Array.from(Buffer.from(st.id, 'hex'));
  assert.equal(n.seats[0].take({ id: st.id, node: toHex(keys[silent].pub), code: 'late', signature: toHex(schnorr.sign(setupDigest(id, keys[silent].pub, 'late'), keys[silent].secret)) }).status, 409);
});

test('a replacement that is silent too is replaced a fifth after IT was seated, inside the same window', async () => {
  const probe = network().seats[0].state();
  const silent = new Set([idx(probe.seated[2].node), idx(probe.alternates[0])]), alt2 = idx(probe.alternates[1]);
  const n = network({ offline: silent });
  for (const t of [101, 102, 103, 104]) await n.round(t);
  let st = n.seats[[...Array(8).keys()].find((i) => !silent.has(i))].state();
  assert.deepEqual([st.seated[2].node, st.seated[2].since], [probe.alternates[0], 103], 'the first alternate, seated at 103, has no code at 104');
  await n.round(105);                                   // 103 + 2: the silent first alternate is replaced by the second
  st = n.seats[[...Array(8).keys()].find((i) => !silent.has(i))].state();
  assert.deepEqual([st.seated[2].node, st.seated[2].since, st.noShows.length], [probe.alternates[1], 105, 2]);
  await n.round(106);
  assert.ok(n.log.some((l) => l[0] === 'dkg' && l[1] === alt2), 'the DKG runs with the second alternate');
});

test('more no-shows than alternates: void, no federation from this trigger', async () => {
  const probe = network().seats[0].state();
  const silent = new Set([...probe.seated.slice(0, 2).map((x) => x.node), ...probe.alternates].map(idx));
  const n = network({ offline: silent });
  for (const t of [101, 102, 103, 104, 105, 106, 107]) await n.round(t);
  const st = n.seats[[...Array(8).keys()].find((i) => !silent.has(i))].state();
  assert.match(String(st.failed), /more no-shows than alternates: the founding is drawn again at the next trigger: void/, JSON.stringify({ seated: st.seated.map((x) => [idx(x.node), x.code, x.since]), noShows: st.noShows.map(idx), silent: [...silent] }));
  assert.equal(st.void, true);
  assert.ok(st.noShows.length >= 4, 'two drawn, then the alternates that replaced them');
  assert.ok(!n.log.some((l) => l[0] === 'dkg'));
});

test('the window passes without a federation: void at beacon + founding_window, the next trigger draws again', async () => {
  // every code in and the DKG started, but no guardian reaches consensus
  const n = network({ done: () => false });
  for (const t of [101, 102, 103, 110]) await n.round(t);
  const seatedIx = n.seats[0].state().seated.map((x) => idx(x.node));
  assert.ok(seatedIx.every((i) => n.log.some((l) => l[0] === 'dkg' && l[1] === i)), 'the DKG started at every seated guardian');
  assert.deepEqual([n.seats[seatedIx[0]].state().void, n.seats[seatedIx[0]].state().federation], [false, false], 'not void before 111');
  await n.round(111);
  for (const s of n.seats) {
    const x = s.state();
    assert.equal(x.void, true);
    assert.match(String(x.failed), /founding window \(10 blocks from the beacon 101\) passed at 111 without a federation: void, the next trigger draws again/);
  }
  // A SEAT THAT SITS IN NO GUARDIAN: told by a peer that the federation runs, it does not void
  const m = network({ done: () => false });
  const watcher = m.seats.findIndex((s, i) => !s.state().seated.some((x) => idx(x.node) === i));
  for (const t of [101, 102]) await m.round(t);
  m.seats[watcher].federationSeen();
  await m.round(111);
  assert.deepEqual([m.seats[watcher].state().federation, m.seats[watcher].state().void], [true, false]);
});
