// A SEAT'S PART IN A FOUNDING (spec §23A.2, kanban #320): a record entering DRAINING at 200 triggers a succession; every seat reads the
// same beacon (block 201) and census and draws the same four; only nodes whose guardian waits in setup take part; a seat whose post
// was lost picks the codes up from a peer's GET /founding; the CLI setup is called with the guardian's own socket and password.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { createFoundingSeat, cliSetup } from '../src/founding-seat.js';

const key = (s) => { const secret = taggedHash('TEST/fseat', new TextEncoder().encode(s)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const verify = (sig, m, k) => { try { return schnorr.verify(sig, m, k); } catch { return false; } };
const keys = Array.from({ length: 6 }, (_, i) => key(`n${i}`));
const entries = keys.map((k, i) => ({ pubkey: k.pub, txid: taggedHash('TEST/tx', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
  advert: { operatorId: `op${i}`, guardianCapable: true, guardianEndpoint: `wss://g${i}` } }));
const clocks = { abandonBlocks: 10, foundingWindow: 10 };

function world({ draining = true, lossy = new Set() } = {}) {
  const w = { tip: 200, log: [] };
  const recs = [{ federation: 'aa'.repeat(32), status: draining ? 'DRAINING' : 'OPEN', height: 200 }];
  const seats = [];
  for (let i = 0; i < 6; i++) {
    const setup = { localParams: async ({ leader }) => { w.log.push(['params', i, leader]); return `code-${i}`; }, addPeer: async (c) => { w.log.push(['add', i, c]); },
      startDkg: async () => { w.log.push(['dkg', i]); }, invite: async () => null };
    seats.push(createFoundingSeat({ records: () => recs, entriesAt: async (h) => (h === 200 ? entries : null),
      beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip,
      guardianInSetup: async () => true, setup, nominal: 4, bondMinGuardian: 500000n, clocks, ownKey: keys[i].pub,
      sign: (h) => schnorr.sign(h, keys[i].secret), verify,
      post: async (m) => { for (let j = 0; j < 6; j++) if (!lossy.has(j)) seats[j].take(m); },
      peers: () => [0, 1, 2, 3, 4, 5].filter((j) => j !== i).map((j) => `seat${j}`),
      fetchJson: async (u) => seats[parseInt(u.slice(4), 10)].state() }));
  }
  return { w, seats };
}

test('no founding without a trigger, and none before the beacon after it is in the chain', async () => {
  const { seats } = world({ draining: false });
  assert.equal((await seats[0].tick()).ok, false);
  const b = world();
  const r = await b.seats[0].tick();
  assert.equal(r.ok, false); assert.match(r.why, /beacon after 200/);
});

test('a succession: every seat draws the same four on block 201; a seat that missed every post reads the codes from its peers', async () => {
  const { w, seats } = world({ lossy: new Set([2, 5]) });
  w.tip = 201;
  for (const s of seats) await s.tick();
  for (const s of seats) await s.tick();
  const st = seats.map((s) => s.state());
  for (const x of st) assert.deepEqual(x.seated.map((y) => y.node), st[0].seated.map((y) => y.node));
  assert.equal(st[0].trigger.kind, 'succession');
  const seated = st[0].seated.map((y) => keys.findIndex((k) => toHex(k.pub) === y.node));
  for (const i of seated) assert.ok(w.log.some((l) => l[0] === "dkg" && l[1] === i), `seat ${i} ran the DKG: ${JSON.stringify({ seated, codes: st[i].seated.map((y) => y.code), log: w.log.filter((l) => l[1] === i) })}`);
});

test('the CLI setup names the guardian\'s own socket and password, and the leader names the federation', async () => {
  const calls = [];
  const s = cliSetup({ run: async (a) => { calls.push(a); return '"code-x"\n'; }, apiPort: 32221, password: 'pw', guardianName: 'node-1' });
  assert.equal(await s.localParams({ leader: true, name: 'arena', size: 4 }), 'code-x');
  await s.addPeer('code-y'); await s.startDkg();
  assert.deepEqual(calls[0], ['--password', 'pw', 'admin', 'setup', 'ws://127.0.0.1:32221', 'set-local-params', 'node-1', '--federation-name', 'arena', '--federation-size', '4']);
  assert.deepEqual(calls[1].slice(5), ['add-peer', 'code-y']);
  assert.deepEqual(calls[2].slice(5), ['start-dkg']);
});

test('whether the guardian waits in setup is asked of the setup API (kanban #320, rehearsal 20b: a setup-mode guardian has no admin status)', async () => {
  const said = (answer) => cliSetup({ run: async (a) => { if (a.includes('status')) { if (answer instanceof Error) throw answer; return `"${answer}"\n`; } return '""'; }, apiPort: 32221, password: 'pw', guardianName: 'n' });
  assert.equal(await said('AwaitingLocalParams').inSetup(), true);
  assert.equal(await said('SharingConnectionCodes').inSetup(), true);
  assert.equal(await said('ConsensusIsRunning').inSetup(), false, 'a running federation: not in setup');
  assert.equal(await said(new Error('Method not found')).inSetup(), false, 'no answer: not taken for setup');
});

// THE GENESIS AND LOAD TRIGGERS, FROM THE HISTORY THE SEAT KEEPS AT EACH TICK (kanban #320)
function triggerSeat({ recs, w }) {
  const setup = { localParams: async () => 'code', addPeer: async () => {}, startDkg: async () => {}, invite: async () => null };
  return createFoundingSeat({ records: () => recs(), entriesAt: async () => entries,
    beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip,
    guardianInSetup: async () => true, setup, nominal: 4, bondMinGuardian: 500000n, clocks, ownKey: keys[0].pub,
    sign: (h) => schnorr.sign(h, keys[0].secret), verify });
}

test('genesis: no federation and six guardian-capable operators in the census - the first federation is drawn on the block after', async () => {
  const w = { tip: 300 };
  const seat = triggerSeat({ recs: () => [], w });
  const first = await seat.tick();
  assert.equal(first.ok, false); assert.match(first.why, /beacon after 300/);
  w.tip = 301;
  const r = await seat.tick();
  assert.equal(r.ok, true, r.why); assert.deepEqual([r.trigger.kind, r.trigger.height], ['genesis', 300]);
});

test('load: every OPEN federation at or above 80 % of its cap for abandon_blocks triggers a new federation; one dip restarts the count', async () => {
  const w = { tip: 400 };
  let load = 0.85;
  const seat = triggerSeat({ recs: () => [{ federation: 'aa'.repeat(32), status: 'OPEN', height: 390, load }, { federation: 'bb'.repeat(32), status: 'OPEN', height: 390, load: 0.9 }], w });
  for (; w.tip < 405; w.tip++) assert.equal((await seat.tick()).ok, false);
  load = 0.5; await seat.tick(); load = 0.85;                       // a dip at 405
  for (w.tip = 406; w.tip < 416; w.tip++) assert.equal((await seat.tick()).ok, false, `no trigger at ${w.tip}: 10 blocks from 406 not yet complete`);
  const at416 = await seat.tick();                                  // 416 - 406 = abandon_blocks: the trigger, its beacon still to come
  assert.equal(at416.ok, false); assert.match(at416.why, /beacon after 416/);
  w.tip = 417;
  const r = await seat.tick();
  assert.equal(r.ok, true, r.why); assert.deepEqual([r.trigger.kind, r.trigger.height], ['load', 416]);
});
