// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FOUNDING CEREMONY AS THE SEATS RUN IT (spec §23A.2): eight guardian-capable nodes of eight operators; four drawn, three
// alternates. Every seat computes the same draw; the seated post signed setup codes, a code from anyone else is refused; with all
// four codes in, each seated guardian adds the other three and starts the DKG (position 0 leads). THE WINDOW (comment
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

function network({ offline = new Set(), done = () => true, stale = new Set(), staleError = 'Local parameters have already been set', freshFails = false,
  count = keys.length } = {}) {
  const log = [];
  const seats = [];
  const fake = (i) => ({
    localParams: async ({ leader, name, size }) => {
      // a guardian whose params an earlier founding set (kanban #495): refused until its setup is started again
      if (stale.has(i)) { log.push(['refused', i]); throw new Error(`Config Gen Error: Federation rpc error { method => set_local_params, 1024 => Unspecified server error: ${staleError} }`); }
      log.push(['params', i, leader, leader ? name : null, leader ? size : null]); return `code-${i}`; },
    freshSetup: async () => { log.push(['fresh', i]); if (freshFails) return { ok: false, why: 'the guardian did not start again' }; stale.delete(i); return { ok: true, kept: `database.void-${i}` }; },
    addPeer: async (code) => { log.push(['add', i, code]); },
    startDkg: async () => { log.push(['dkg', i]); },
    invite: async () => 'fed11invite',
    done: async () => log.some((l) => l[0] === 'dkg' && l[1] === i) && done(i),     // consensus once its DKG ran (unless told otherwise)
  });
  for (let i = 0; i < count; i++) {
    seats.push(createFounding({ seed, triggerHeight: 100, entries: entries.slice(0, count), nominal: 4, bondMinGuardian: 500000n, foundingWindow: 10,
      ownKey: keys[i].pub, sign: (h) => schnorr.sign(h, keys[i].secret), verify, setup: fake(i),
      post: async (m) => { for (const s of seats) s.take(m); } }));
  }
  const round = async (tip) => { const off = typeof offline === 'function' ? offline(tip) : offline; for (let i = 0; i < seats.length; i++) if (!off.has(i)) await seats[i].advance(tip); };
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

test('more no-shows than alternates (2026-10-22: ten are enough): the late keep their seats to the window\'s end, then void', async () => {
  const probe = network().seats[0].state();
  const silent = new Set([...probe.seated.slice(0, 2).map((x) => x.node), ...probe.alternates].map(idx));
  const n = network({ offline: silent });
  for (const t of [101, 102, 103, 104, 105, 106, 107]) await n.round(t);
  const mid = n.seats[[...Array(8).keys()].find((i) => !silent.has(i))].state();
  assert.deepEqual([mid.void, mid.failed], [false, null], 'not void while the window runs');
  for (const t of [108, 109, 110, 111]) await n.round(t);
  const st = n.seats[[...Array(8).keys()].find((i) => !silent.has(i))].state();
  assert.match(String(st.failed), /founding window .* passed at 111 without a federation: void/);
  assert.equal(st.void, true);
  assert.ok(st.noShows.length >= 2 && st.noShows.length <= 5, `replaced only as far as the alternates go: ${st.noShows.length}`);
  assert.ok(!n.log.some((l) => l[0] === 'dkg'));
});

test('ten are enough (2026-10-22: "we need 10 nodes not 14"): as many eligible as seats, two late past the fifth - they keep their seats and the federation is founded inside the window', async () => {
  // the measured 3d30afd4 in small: 4 eligible for 4 seats, no alternates; two seated nodes see the draw only after a burst of blocks
  const late = new Set([2, 3]);
  const n = network({ count: 4, offline: (t) => (t < 107 ? late : new Set()) });
  assert.equal(n.seats[0].state().alternates.length, 0, 'no alternates');
  for (const t of [101, 102, 103, 104, 105, 106, 107, 108]) await n.round(t);
  const st = n.seats[0].state();
  assert.deepEqual([st.void, st.failed, st.noShows.length], [false, null, 0], JSON.stringify(st.failed));
  assert.equal(n.log.filter((l) => l[0] === 'dkg').length, 4, 'all four start the key generation');
  await n.round(109);
  assert.equal(n.seats[0].state().federation, true);
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

// SEATED FIRST (§23A.6 step 1): a succession seats the old guardians n0..n2 first, in order - n0 leads - and draws one of the
// others; a seated-first node is held to the same fifth as a drawn one: silent, it is replaced by the next alternate in its position.
function succession({ offline = new Set() } = {}) {
  const log = [];
  const seats = [];
  const first = [entries[0], entries[1], entries[2]];
  for (let i = 0; i < keys.length; i++) {
    seats.push(createFounding({ seed, triggerHeight: 100, entries, nominal: 4, bondMinGuardian: 500000n, foundingWindow: 10, seatedFirst: first,
      guardingOpen: new Set(['op7']), ownKey: keys[i].pub, sign: (h) => schnorr.sign(h, keys[i].secret), verify,
      setup: { localParams: async ({ leader }) => { log.push(['params', i, leader]); return `code-${i}`; }, addPeer: async (c) => { log.push(['add', i, c]); },
        startDkg: async () => { log.push(['dkg', i]); }, invite: async () => null, done: async () => log.some((l) => l[0] === 'dkg' && l[1] === i) },
      post: async (m) => { for (const s of seats) s.take(m); } }));
  }
  const round = async (tip) => { for (let i = 0; i < seats.length; i++) if (!offline.has(i)) await seats[i].advance(tip); };
  return { seats, log, round };
}

test('a succession: the old guardians are seated first in order, position 0 leads, one seat drawn of the others; the DKG runs on the four', async () => {
  const n = succession();
  const st = n.seats[5].state();
  assert.equal(st.seatedFirst, 3);
  const seated = st.seated.map((x) => idx(x.node));
  assert.deepEqual(seated.slice(0, 3), [0, 1, 2]);
  assert.ok(![0, 1, 2, 7].includes(seated[3]), `drawn from n3..n6 (op7 guards an OPEN federation): ${seated[3]}`);
  assert.ok(!st.alternates.map(idx).some((i) => [0, 1, 2, 7].includes(i)));
  await n.round(101); await n.round(102);
  assert.deepEqual(n.log.filter((l) => l[0] === 'params' && l[2]).map((l) => l[1]), [0], 'the first seated-first node leads');
  for (const i of seated) assert.ok(n.log.some((l) => l[0] === 'dkg' && l[1] === i));
});

test('a seated-first node silent for a fifth of the window is replaced by the first alternate in its position', async () => {
  const probe = succession().seats[5].state();
  const alt = idx(probe.alternates[0]);
  const n = succession({ offline: new Set([1]) });
  for (const t of [101, 102]) await n.round(t);
  assert.deepEqual(n.seats[0].state().noShows, []);
  await n.round(103);
  const st = n.seats[0].state();
  assert.deepEqual(st.noShows.map(idx), [1]);
  assert.deepEqual([idx(st.seated[1].node), st.seated[1].since], [alt, 103], 'the alternate takes position 1');
  await n.round(104);
  for (const i of st.seated.map((x) => idx(x.node))) assert.ok(n.log.some((l) => l[0] === 'dkg' && l[1] === i), `seat ${i} started the DKG`);
  assert.ok(!n.log.some((l) => l[1] === 1));
});

test('a seated node whose seat restarts past the fifth posts its own code first and is no no-show of its own (kanban #495, e8741283)', async () => {
  const n = network();
  await n.round(101);                                   // every seated node posted; nobody started yet (one more round would)
  const seated = n.seats[0].state().seated.map((x) => idx(x.node));
  const r = seated[1];
  // its seat restarts at 104 (past beacon 101 + the fifth): a fresh founding, the others' codes read back from their GET /founding first
  const log = [];
  const fresh = createFounding({ seed, triggerHeight: 100, entries, nominal: 4, bondMinGuardian: 500000n, foundingWindow: 10,
    ownKey: keys[r].pub, sign: (h) => schnorr.sign(h, keys[r].secret), verify,
    setup: { localParams: async () => `code-${r}-again`, addPeer: async (c) => { log.push(['add', c]); }, startDkg: async () => { log.push(['dkg']); }, invite: async () => null, done: async () => false },
    post: async (m) => { for (const s of n.seats) s.take(m); } });
  // the others' codes only: its own old one went with the restart (live, every seat restarted, so none held it)
  for (const j of seated) if (j !== r) fresh.takeAll(n.seats[j].state().codes.filter((c) => c.node !== toHex(keys[r].pub)));
  const st = await fresh.advance(104);
  assert.deepEqual(st.noShows, [], 'it does not count itself a no-show');
  assert.equal(st.void, false);
  assert.deepEqual(log.filter((l) => l[0] === 'add').length, 3); assert.ok(log.some((l) => l[0] === 'dkg'), 'it adds the other three and starts its key generation');
});

// PARAMS FROM A FOUNDING THAT WENT VOID (kanban #495, measured 2026-10-21: node 6's guardian kept the params of the voided e8741283 and
// refused 082e74b3's - "Local parameters have already been set" - so its code never came until its setup was reset by hand)
test('a seated guardian holding an earlier founding\'s params starts its setup again once, posts its code, and the DKG runs', async () => {
  const seated = network().seats[0].state().seated.map((x) => idx(x.node));
  const n = network({ stale: new Set([seated[1]]) });
  await n.round(101);
  await n.round(102);
  assert.deepEqual(n.log.filter((l) => l[0] === 'fresh').map((l) => l[1]), [seated[1]], 'that guardian, once');
  assert.ok(n.log.some((l) => l[0] === 'params' && l[1] === seated[1]), 'its params taken after the fresh setup');
  for (const i of seated) assert.ok(n.log.some((l) => l[0] === 'dkg' && l[1] === i), `guardian ${i} started the DKG`);
});

test('another refusal is no reason to start the setup again; a fresh setup that does not help is not tried twice', async () => {
  const seated = network().seats[0].state().seated.map((x) => idx(x.node));
  const other = network({ stale: new Set([seated[2]]), staleError: 'peer unreachable' });
  await other.round(101); await other.round(102);
  assert.deepEqual(other.log.filter((l) => l[0] === 'fresh'), [], 'not for another error');
  const stuck = network({ stale: new Set([seated[2]]), freshFails: true });
  await stuck.round(101); await stuck.round(102); await stuck.round(103);
  assert.deepEqual(stuck.log.filter((l) => l[0] === 'fresh').map((l) => l[1]), [seated[2]], 'once in a founding');
});

test('a seated node started again after its code is out posts that same code - no new params, no fresh setup (kanban #495, 53be35a3)', async () => {
  // the first start: the code is made and kept with the founding's id
  const n = network();
  const seated = n.seats[0].state().seated.map((x) => idx(x.node));
  const kept = new Map();
  const i = seated[1];
  // the node i, started again: a fresh founding object on the same draw, its setup keeping and reading its code
  const log = [];
  const setup = {
    localParams: async () => { log.push('params'); return 'code-new'; },
    freshSetup: async () => { log.push('fresh'); return { ok: true }; },
    addPeer: async (code) => { log.push(['add', code]); }, startDkg: async () => { log.push('dkg'); }, invite: async () => null, done: async () => false,
    savedCode: () => kept.get('saved') || null, saveCode: (id, code) => kept.set('saved', { id, code }),
  };
  const make = () => createFounding({ seed, triggerHeight: 100, entries, nominal: 4, bondMinGuardian: 500000n, foundingWindow: 10,
    ownKey: keys[i].pub, sign: (h) => schnorr.sign(h, keys[i].secret), verify, setup });
  const first = make();
  await first.advance(101);
  assert.deepEqual(log, ['params'], 'the first start makes the code');
  assert.deepEqual(kept.get('saved'), { id: first.id, code: 'code-new' }, 'and keeps it with the founding id');
  const posted = first.state().codes.find((c) => c.node === toHex(keys[i].pub));
  // started again, its guardian kept (guardian.js): the same code, signed again, and neither new params nor a fresh setup
  log.length = 0;
  const again = make();
  await again.advance(102);
  assert.deepEqual(log, [], 'no set-local-params and no fresh setup after the restart');
  const repost = again.state().codes.find((c) => c.node === toHex(keys[i].pub));
  assert.equal(repost.code, posted.code);
  // a code kept for ANOTHER founding is no reason to skip the params: this founding makes its own
  kept.set('saved', { id: 'ff'.repeat(32), code: 'code-old' });
  log.length = 0;
  const other = make();
  await other.advance(101);
  assert.deepEqual(log, ['params']);
  assert.equal(kept.get('saved').code, 'code-new');
});
