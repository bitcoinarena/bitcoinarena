// A FOUNDING CEREMONY AS THE SEATS RUN IT (spec §23A.2, kanban #320): eight guardian-capable nodes of eight operators; four drawn, three
// alternates. Every seat computes the same draw; the seated post signed setup codes, a code from anyone else is refused; with all
// four codes in, each seated guardian adds the other three and starts the DKG (position 0 leads). A drawn node that posts nothing
// within founding_window is a no-show: the first alternate takes its position, a new window opens, and the DKG runs with it.
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

function network({ offline = new Set() } = {}) {
  const log = [];
  const seats = [];
  const fake = (i) => ({
    localParams: async ({ leader, name, size }) => { log.push(['params', i, leader, leader ? name : null, leader ? size : null]); return `code-${i}`; },
    addPeer: async (code) => { log.push(['add', i, code]); },
    startDkg: async () => { log.push(['dkg', i]); },
    invite: async () => 'fed11invite',
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

test('a drawn node silent for founding_window is replaced by the first alternate in its position; the DKG runs with it', async () => {
  const probe = network().seats[0].state();
  const silent = idx(probe.seated[1].node), alt = idx(probe.alternates[0]);
  const n = network({ offline: new Set([silent]) });
  await n.round(101); await n.round(105);
  assert.ok(!n.log.some((l) => l[0] === 'dkg'), 'no DKG while a seat has no code');
  await n.round(110);                                   // the window (10) is over: the no-show is replaced, the alternate posts
  await n.round(111);
  const st = n.seats[0].state();
  assert.deepEqual(st.noShows, [toHex(keys[silent].pub)]);
  assert.equal(st.seated[1].node, toHex(keys[alt].pub), 'the alternate takes the no-show\'s position');
  assert.equal(st.windowFrom, 110);
  const seated = st.seated.map((x) => idx(x.node));
  for (const i of seated) assert.ok(n.log.some((l) => l[0] === 'dkg' && l[1] === i), `seat ${i} started the DKG`);
  assert.ok(!n.log.some((l) => l[1] === silent), 'the no-show never took part');
  // a late code from the no-show is refused: it is no longer seated
  const id = Uint8Array.from(Buffer.from(st.id, 'hex'));
  assert.equal(n.seats[0].take({ id: st.id, node: toHex(keys[silent].pub), code: 'late', signature: toHex(schnorr.sign(setupDigest(id, keys[silent].pub, 'late'), keys[silent].secret)) }).status, 409);
});

test('more no-shows than alternates: no federation from this trigger', async () => {
  const probe = network().seats[0].state();
  const silent = new Set([...probe.seated.slice(0, 2).map((x) => x.node), ...probe.alternates].map(idx));
  const n = network({ offline: silent });
  await n.round(101); await n.round(110); await n.round(111); await n.round(120);
  const st = n.seats[[...Array(8).keys()].find((i) => !silent.has(i))].state();
  assert.match(String(st.failed), /more no-shows than alternates/, JSON.stringify({ seated: st.seated.map((x) => [idx(x.node), x.code]), noShows: st.noShows.map(idx), windowFrom: st.windowFrom, silent: [...silent] }));
  assert.ok(!n.log.some((l) => l[0] === 'dkg'));
});
