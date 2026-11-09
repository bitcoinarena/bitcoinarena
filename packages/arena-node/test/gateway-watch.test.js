// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GUARDIAN WATCHES ITS FEDERATION'S GATEWAYS (spec §23A.9): only signed claims of seated guardians, for this federation,
// stand; a gateway that serves the federation (routing_info not null) counts as up; the ranking follows the probes; a forged or
// foreign claim is ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createGatewayWatch } from '../src/gateway-watch.js';
import { signGatewayClaim, checkGatewayClaim } from '../../arena-protocol/src/gateway-claim.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { signHeldRead } from '../../arena-protocol/src/held-proof.js';

const fid = 'f0'.repeat(32);
const keys = [1, 2, 3, 4].map((n) => { const secret = new Uint8Array(32).fill(n); return { secret, hex: toHex(schnorr.getPublicKey(secret)) }; });
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const claimOf = (i, over = {}) => signGatewayClaim({ node: keys[i].hex, federationId: fid, gatewayUrl: `https://n${i}.example/gateway/`, lightningPubkey: '02' + 'ab'.repeat(32),
  capacitySats: 300000, pegInSats: 60000, atMs: 1, inboundSats: 150000, outboundSats: 150000, outsideInboundSats: 150000, ...over }, (h) => schnorr.sign(h, keys[i].secret));

test('claims: signed by their node, checked; a forged one refused', () => {
  const c = claimOf(0);
  assert.equal(checkGatewayClaim(c, verify).ok, true);
  assert.match(checkGatewayClaim({ ...c, capacitySats: '9000000' }, verify).why, /not signed by its node key/);
  assert.match(checkGatewayClaim({ ...c, gatewayUrl: 'https://n0.example/gateway' }, verify).why, /ending in \//);
});

test('the watch: seated guardians\' claims probed per epoch, ranked; a foreign federation and a forged claim stand nowhere', async () => {
  const claims = { 0: claimOf(0), 1: claimOf(1, { capacitySats: 900000 }), 2: claimOf(2, { federationId: 'aa'.repeat(32) }), 3: { ...claimOf(3), pegInSats: '999999' } };
  const up = { 0: true, 1: false };
  let height = 144 * 10 + 5;
  const entries = keys.map((k, i) => ({ pubkey: Uint8Array.from(Buffer.from(k.hex, 'hex')), bondSats: 50000n, advert: { endpoint: `https://seat${i}.example`, operatorId: `op${i}` } }));
  const fetcher = async (url, o = {}) => {
    const seat = /^https:\/\/seat(\d)\.example\/gateway-claim\?federation=[0-9a-f]{64}$/.exec(url);
    if (seat) return { status: 200, json: async () => claims[seat[1]] };
    const gw = /^https:\/\/n(\d)\.example\/gateway\/routing_info$/.exec(url);
    if (gw) { assert.equal(o.body, JSON.stringify(fid)); return { status: 200, text: async () => (up[gw[1]] ? '{"lightning_public_key":"02.."}' : 'null') }; }
    throw new Error(`unexpected ${url}`);
  };
  const w = createGatewayWatch({ federationId: async () => fid, seated: async () => [keys[0].hex, keys[1].hex, keys[2].hex, keys[3].hex].slice(0, 4), entries: async () => entries,
    tip: async () => height, beaconAt: async () => new Uint8Array(32).fill(7), verify, fetcher });
  for (let i = 0; i < 4; i++) await w.probe();
  up[1] = true; await w.probe();
  const v = await w.view();
  assert.equal(v.measuredEpoch, 'running');
  assert.deepEqual(Object.keys(v.gateways).sort(), [keys[0].hex, keys[1].hex].sort(), 'only the two valid claims for this federation stand');
  assert.deepEqual(v.seated, [keys[0].hex], 'node 2 answered 1 of 5 probes (20 %): not eligible; node 1 was up 5 of 5');
  assert.match(v.ineligible.find((x) => x.node === keys[1].hex).why, /available 20 %/);
  height += 144; await w.probe();
  const next = await w.view();
  assert.deepEqual([next.measuredEpoch, next.epoch], ['whole', 10], 'the last whole epoch is ranked once there is one');
  // kanban #552: AND THE RUNNING EPOCH, as it stands - its own probes ranked, the block it ends at
  assert.deepEqual([next.next.epoch, next.next.fromBlock], [11, 144 * 12]);
  assert.deepEqual(next.next.seated, [keys[0].hex, keys[1].hex].sort((a, b) => next.next.seated.indexOf(a) - next.next.seated.indexOf(b)), 'up in its one probe: both would be seated');
  assert.equal(next.next.seated.length, 2);
  assert.match(next.next.why, /2 of 2 gateway seats filled/);
});

test('a seat that advertises its endpoint as wss:// is read over https (the live adverts do)', async () => {
  // measured 2026-10-19 21:1xZ on testnet4: every seat's advert names wss://test-host.../guardian-N, the watch fetched
  // wss://.../gateway-claim, fetch refused the scheme, and the federation's 2 gateway seats stayed empty all epoch
  const asked = [];
  const entries = keys.map((k, i) => ({ pubkey: Uint8Array.from(Buffer.from(k.hex, 'hex')), bondSats: 50000n, advert: { endpoint: `wss://seat${i}.example/guardian-${i}/`, operatorId: `op${i}` } }));
  const fetcher = async (url) => {
    asked.push(url);
    if (/^wss?:/.test(url)) throw new TypeError('fetch failed: unknown scheme');
    const seat = /^https:\/\/seat(\d)\.example\/guardian-\d\/gateway-claim\?federation=[0-9a-f]{64}$/.exec(url);
    if (seat) return { status: 200, json: async () => claimOf(Number(seat[1])) };
    if (/^https:\/\/n\d\.example\/gateway\/routing_info$/.test(url)) return { status: 200, text: async () => '{"lightning_public_key":"02.."}' };
    throw new Error(`unexpected ${url}`);
  };
  const w = createGatewayWatch({ federationId: async () => fid, seated: async () => [keys[0].hex, keys[1].hex], entries: async () => entries,
    tip: async () => 144 * 10 + 5, beaconAt: async () => new Uint8Array(32).fill(7), verify, fetcher });
  await w.probe();
  assert.ok(asked.some((u) => u.startsWith('https://seat0.example/guardian-0/gateway-claim?federation=')), asked.join(' '));
  // kanban #552: it asks for its own federation's claim - a seat may stand for a gateway in each federation it guards
  assert.ok(asked.filter((u) => u.includes('/gateway-claim')).every((u) => /\?federation=[0-9a-f]{64}$/.test(u)));
  const v = await w.view();
  assert.deepEqual(Object.keys(v.gateways).sort(), [keys[0].hex, keys[1].hex].sort(), 'both claims read and probed');
  assert.equal(v.seated.length, 2);
});

test('the seat gathers signed seatings over https too, never at a wss:// address', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const line = src.split('\n').find((l) => l.includes('/gateway-seating?federation='));
  assert.ok(line && line.includes("replace(/^ws(s?):/, 'http$1:')"), line);
});

test('routed volume: incoming contracts credited to the gateway whose module key funded them, from the second probe on', async () => {
  const claims = { 0: claimOf(0, { capacitySats: 900000 }), 1: claimOf(1, { capacitySats: 300000 }) };
  const mk = { 0: '03' + '11'.repeat(32), 1: '02' + '22'.repeat(32) };
  const height = 144 * 20 + 3;
  const entries = keys.map((k, i) => ({ pubkey: Uint8Array.from(Buffer.from(k.hex, 'hex')), bondSats: 50000n, advert: { endpoint: `https://seat${i}.example`, operatorId: `op${i}` } }));
  const fetcher = async (url) => {
    const seat = /^https:\/\/seat(\d)\.example\/gateway-claim\?federation=[0-9a-f]{64}$/.exec(url);
    if (seat) return claims[seat[1]] ? { status: 200, json: async () => claims[seat[1]] } : { status: 404, json: async () => null };
    const gw = /^https:\/\/n(\d)\.example\/gateway\/routing_info$/.exec(url);
    return { status: 200, text: async () => JSON.stringify({ module_public_key: mk[gw[1]] }) };
  };
  // the stream: history before the watch (never credited), then 3 contracts through gateway 1 and 1 through gateway 0
  const stream = [{ refundPk: mk[0], amountMsat: 9_000_000_000n }, { refundPk: mk[1], amountMsat: 2_000_000n }, { refundPk: mk[1], amountMsat: 3_500_000n }, { refundPk: mk[0], amountMsat: 1_000_000n }, { refundPk: mk[1], amountMsat: 500_000n }];
  let shown = 1; const asked = [];
  const incoming = async (from) => { asked.push(from); return { ok: true, contracts: stream.slice(from, shown), next: shown }; };
  const w = createGatewayWatch({ federationId: async () => fid, seated: async () => [keys[0].hex, keys[1].hex], entries: async () => entries,
    tip: async () => height, beaconAt: async () => new Uint8Array(32).fill(7), verify, fetcher, incoming });
  assert.equal((await w.probe()).credited, 0, 'the first probe takes the index only');
  shown = 5;
  assert.equal((await w.probe()).credited, 4);
  assert.deepEqual(asked, [0, 1]);
  const v = await w.view();
  assert.deepEqual([v.gateways[keys[1].hex].volumeSats, v.gateways[keys[0].hex].volumeSats], ['6000', '1000'], 'msat summed per module key, in sat');
  assert.equal(v.ranked[0].node, keys[1].hex, 'more routed volume ranks first, before the larger capacity of gateway 0');
});

// kanban #552 (2026-10-20: "Shows 0 of 2 again. Why is this so hard to fix?"): every restart cleared the epoch's probes
test('the epoch\'s probes outlive a restart: a new watch reads what the last one kept and seats the same gateway without a probe', async () => {
  const kept = new Map();
  const keep = { load: async (f) => Object.fromEntries([...kept].filter(([k]) => k.startsWith(f)).map(([k, v]) => [k.split(':')[1], v])), save: async (f, e, rows) => { kept.set(`${f}:${e}`, JSON.parse(JSON.stringify(rows))); } };
  const claims = { 0: claimOf(0) };
  const entries = keys.map((k, i) => ({ pubkey: Uint8Array.from(Buffer.from(k.hex, 'hex')), bondSats: 50000n, advert: { endpoint: `https://seat${i}.example`, operatorId: `op${i}` } }));
  const fetcher = async (url) => {
    const seat = /^https:\/\/seat(\d)\.example\/gateway-claim\?federation=[0-9a-f]{64}$/.exec(url);
    if (seat) return claims[seat[1]] ? { status: 200, json: async () => claims[seat[1]] } : { status: 404, json: async () => ({}) };
    if (/routing_info$/.test(url)) return { status: 200, text: async () => '{"module_public_key":"02' + 'cd'.repeat(32) + '"}' };
    throw new Error(`unexpected ${url}`);
  };
  const make = () => createGatewayWatch({ federationId: async () => fid, seated: async () => [keys[0].hex], entries: async () => entries, tip: async () => 144 * 10 + 5,
    beaconAt: async () => new Uint8Array(32).fill(7), verify, fetcher, keep });
  const a = make(); await a.probe(); await a.probe();
  assert.deepEqual((await a.view()).seated, [keys[0].hex]);
  assert.equal(a.lastProbe().claims, 1);
  const b = make();                                   // a restart: no probe yet
  const v = await b.view();
  assert.deepEqual([v.seated, v.gateways[keys[0].hex].probes], [[keys[0].hex], 2], 'seated from the kept probes, 2 of them');
  // a kept claim is checked again: a forged one is dropped
  for (const [k, rows] of kept) for (const r of Object.values(rows)) r.claim = { ...r.claim, pegInSats: '999999999' };
  assert.deepEqual((await make().view()).seated, []);
});

// 2026-10-20, hard rule: "All federations need 2 of 2 gateways, draining gateways at least 1"
test('a draining federation needs one gateway seat: "1 of 1" seated from one operator; an open one still two', async () => {
  const claims = { 0: claimOf(0) };
  const entries = keys.map((k, i) => ({ pubkey: Uint8Array.from(Buffer.from(k.hex, 'hex')), bondSats: 50000n, advert: { endpoint: `https://seat${i}.example`, operatorId: `op${i}` } }));
  const fetcher = async (url) => {
    const seat = /^https:\/\/seat(\d)\.example\/gateway-claim\?federation=[0-9a-f]{64}$/.exec(url);
    if (seat) return claims[seat[1]] ? { status: 200, json: async () => claims[seat[1]] } : { status: 404, json: async () => ({}) };
    if (/routing_info$/.test(url)) return { status: 200, text: async () => '{"lightning_public_key":"02.."}' };
    throw new Error(`unexpected ${url}`);
  };
  const make = (n) => createGatewayWatch({ federationId: async () => fid, seated: async () => [keys[0].hex, keys[1].hex], entries: async () => entries, tip: async () => 144 * 10 + 5,
    beaconAt: async () => new Uint8Array(32).fill(7), verify, fetcher, seatsFor: async () => n });
  const d = make(1); await d.probe();
  const v = await d.view();
  assert.deepEqual([v.seats, v.seated.length, v.empty], [1, 1, 0]); assert.match(v.why, /1 of 1 gateway seats filled/);
  const o = make(2); await o.probe();
  const w = await o.view();
  assert.deepEqual([w.seats, w.seated.length, w.empty], [2, 1, 1]);
});

// kanban #559 (2026-10-20: "Fix all of it. and also rotate the guardians daily every 144 blocks"): the routed volume, the stream's
// index and the seats ranked per epoch outlive a restart; the seats rotate, last epoch's holders stepping back
test('volume, stream index and the seats of each epoch outlive a restart; the seats rotate every epoch', async () => {
  const probes = new Map(); let state = null;
  const keep = { load: async (f) => Object.fromEntries([...probes].filter(([k]) => k.startsWith(f)).map(([k, v]) => [k.split(':')[1], v])),
    save: async (f, e, rows) => { probes.set(`${f}:${e}`, JSON.parse(JSON.stringify(rows))); },
    state: { load: async () => (state ? JSON.parse(state) : null), save: async (f, st) => { state = JSON.stringify(st); } } };
  const claims = { 0: claimOf(0), 1: claimOf(1), 2: claimOf(2), 3: claimOf(3) };
  const mk = { 0: '02' + '10'.repeat(32), 1: '02' + '11'.repeat(32), 2: '02' + '12'.repeat(32), 3: '02' + '13'.repeat(32) };
  const entries = keys.map((k, i) => ({ pubkey: Uint8Array.from(Buffer.from(k.hex, 'hex')), bondSats: 50000n, advert: { endpoint: `https://seat${i}.example`, operatorId: `op${i}` } }));
  const fetcher = async (url) => {
    const seat = /^https:\/\/seat(\d)\.example\/gateway-claim\?federation=[0-9a-f]{64}$/.exec(url);
    if (seat) return { status: 200, json: async () => claims[seat[1]] };
    const gw = /^https:\/\/n(\d)\.example\/gateway\/routing_info$/.exec(url);
    return { status: 200, text: async () => JSON.stringify({ module_public_key: mk[gw[1]] }) };
  };
  const stream = [{ refundPk: mk[0], amountMsat: 1n }, { refundPk: mk[0], amountMsat: 40_000_000n }, { refundPk: mk[1], amountMsat: 30_000_000n }, { refundPk: mk[2], amountMsat: 2_000_000n }];
  let shown = 1; const asked = [];
  const incoming = async (from) => { asked.push(from); return { ok: true, contracts: stream.slice(from, shown), next: shown }; };
  let height = 144 * 30 + 10, signed = {};
  const make = () => createGatewayWatch({ federationId: async () => fid, seated: async () => keys.map((k) => k.hex), entries: async () => entries, tip: async () => height,
    beaconAt: async () => new Uint8Array(32).fill(7), verify, fetcher, incoming, keep, seatingFor: async (f, e) => signed[e] || null });
  const a = make();
  await a.probe(); shown = 3; await a.probe();
  const b = make();                                              // a restart within the epoch
  shown = 4; await b.probe();
  assert.deepEqual(asked, [0, 1, 3], 'the stream is read on from the kept index, not from 0 again');
  const v = await b.view();
  assert.deepEqual([v.gateways[keys[0].hex].volumeSats, v.gateways[keys[1].hex].volumeSats, v.gateways[keys[2].hex].volumeSats], ['40000', '30000', '2000'], 'the volume before the restart counted');
  assert.deepEqual(v.seated, [keys[0].hex, keys[1].hex], 'the running epoch: the two that routed most');
  // epoch 30 ends: ranked as a whole epoch it seats 0 and 1; in epoch 31 they step back for 2 and 3
  height = 144 * 31 + 10; await b.probe(); await b.probe();
  const w31 = await make().view();
  assert.deepEqual([w31.epoch, w31.seated], [30, [keys[0].hex, keys[1].hex]]);
  assert.deepEqual(w31.next.seated.slice().sort(), [keys[2].hex, keys[3].hex].sort(), 'the next epoch rotates: last epoch\'s holders step back');
  // where the guardians' signed seating of epoch 30 stands, its holders step back in the ranking of 31 - not this guardian's own
  height = 144 * 32 + 10; await b.probe();
  signed = { 30: [keys[3].hex] };
  const w32 = await make().view();
  assert.equal(w32.epoch, 31);
  assert.ok(!w32.seated.includes(keys[3].hex) && w32.seated.length === 2, 'the signed holder of epoch 30 steps back in the ranking of 31');
});

// kanban #559/#543 (spec §23A.3a "What counts as the peg-in"): a claimed peg-in outpoint that is one of the federation's own coins is proved
test('proved peg-ins: claimed outpoints among the federation\'s coins count, an outpoint two claims name counts for neither', async () => {
  const o1 = 'aa'.repeat(32) + ':1', o2 = 'bb'.repeat(32) + ':0', shared = 'cc'.repeat(32) + ':2', stranger = 'dd'.repeat(32) + ':0';
  const claims = { 0: claimOf(0, { pegInOutpoints: [o1, shared] }), 1: claimOf(1, { pegInOutpoints: [o2, shared, stranger] }) };
  const entries = keys.map((k, i) => ({ pubkey: Uint8Array.from(Buffer.from(k.hex, 'hex')), bondSats: 50000n, advert: { endpoint: `https://seat${i}.example`, operatorId: `op${i}` } }));
  const fetcher = async (url) => {
    const seat = /^https:\/\/seat(\d)\.example\/gateway-claim\?federation=[0-9a-f]{64}$/.exec(url);
    if (seat) return claims[seat[1]] ? { status: 200, json: async () => claims[seat[1]] } : { status: 404, json: async () => ({}) };
    return { status: 200, text: async () => '{"module_public_key":"02' + 'cd'.repeat(32) + '"}' };
  };
  const coins = new Map([[o1, 60_000n], [o2, 25_000n], [shared, 99_000n]]);
  const make = (federationCoins) => createGatewayWatch({ federationId: async () => fid, seated: async () => [keys[0].hex, keys[1].hex], entries: async () => entries, tip: async () => 144 * 40 + 5,
    beaconAt: async () => new Uint8Array(32).fill(7), verify, fetcher, federationCoins });
  const w = make(async () => coins); await w.probe();
  const v = await w.view();
  assert.deepEqual([v.gateways[keys[0].hex].provedPegInSats, v.gateways[keys[1].hex].provedPegInSats], ['60000', '25000'], 'its own outpoint counts; the shared one for neither; one not among the coins not at all');
  const none = make(undefined); await none.probe();
  assert.equal((await none.view()).gateways[keys[0].hex].provedPegInSats, null, 'no coins read: nothing is proved');
});

test('a guardian whose quick tunnel took a new name is read at its announced address, not its advert\'s dead one (kanban #577)', async () => {
  // measured 2026-10-22 on federation 89ce310e: its three installer guardians updated, their tunnels took new names, the seats held
  // the announcements, and the watch still asked the advert's address - "0 of 2 gateway seats filled from 0 eligible operators"
  const asked = [];
  const entries = keys.map((k, i) => ({ pubkey: Uint8Array.from(Buffer.from(k.hex, 'hex')), bondSats: 50000n, advert: { endpoint: `https://old${i}.example`, operatorId: `op${i}` } }));
  const announced = new Map([[keys[0].hex, 'https://new0.example'], [keys[1].hex, 'https://new1.example']]);
  const fetcher = async (url) => {
    asked.push(url);
    if (/^https:\/\/old\d/.test(url)) throw new TypeError('fetch failed: the tunnel is gone');
    const seat = /^https:\/\/new(\d)\.example\/gateway-claim\?federation=[0-9a-f]{64}$/.exec(url);
    if (seat) return { status: 200, json: async () => claimOf(Number(seat[1])) };
    if (/^https:\/\/n\d\.example\/gateway\/routing_info$/.test(url)) return { status: 200, text: async () => '{"lightning_public_key":"02.."}' };
    throw new Error(`unexpected ${url}`);
  };
  const w = createGatewayWatch({ federationId: async () => fid, seated: async () => [keys[0].hex, keys[1].hex], entries: async () => entries,
    tip: async () => 144 * 10 + 5, beaconAt: async () => new Uint8Array(32).fill(7), verify, fetcher,
    endpointOf: (e) => announced.get(Buffer.from(e.pubkey).toString('hex')) || e.advert.endpoint });
  await w.probe();
  assert.ok(!asked.some((u) => u.startsWith('https://old')), asked.join(' '));
  const v = await w.view();
  assert.deepEqual(Object.keys(v.gateways).sort(), [keys[0].hex, keys[1].hex].sort(), 'both claims read at the announced addresses');
  assert.equal(v.seated.length, 2);
});

test('a gateway whose tunnel took a new name is said at its new address, though the ranking is still the last whole epoch\'s (2026-10-30)', async () => {
  const urls = { 0: 'https://before-reboot.example/', 1: 'https://other.example/' };
  let height = 144 * 10 + 5;
  const live = new Set(['https://before-reboot.example/', 'https://other.example/']);
  const entries = keys.map((k, i) => ({ pubkey: Uint8Array.from(Buffer.from(k.hex, 'hex')), bondSats: 50000n, advert: { endpoint: `https://seat${i}.example`, operatorId: `op${i}` } }));
  const fetcher = async (url) => {
    const seat = /^https:\/\/seat(\d)\.example\/gateway-claim\?federation=[0-9a-f]{64}$/.exec(url);
    if (seat) return urls[seat[1]] ? { status: 200, json: async () => claimOf(Number(seat[1]), { gatewayUrl: urls[seat[1]] }) } : { status: 404 };
    const base = url.replace(/routing_info$/, '');
    if (live.has(base)) return { status: 200, text: async () => '{"lightning_public_key":"02.."}' };
    throw new TypeError('fetch failed: the tunnel is gone');
  };
  const w = createGatewayWatch({ federationId: async () => fid, seated: async () => keys.slice(0, 2).map((k) => k.hex), entries: async () => entries,
    tip: async () => height, beaconAt: async () => new Uint8Array(32).fill(7), verify, fetcher });
  for (let i = 0; i < 3; i++) await w.probe();
  height = 144 * 11 + 5;                                                     // the next epoch: the last whole one is ranked now
  urls[0] = 'https://after-reboot.example/'; live.delete('https://before-reboot.example/'); live.add('https://after-reboot.example/');
  await w.probe();
  const v = await w.view();
  assert.equal(v.ok, true, v.why);
  assert.equal(v.measuredEpoch, 'whole');
  assert.equal(v.gateways[keys[0].hex].url, 'https://after-reboot.example/');
  assert.equal(v.gateways[keys[1].hex].url, 'https://other.example/');
});

// THE AGE OF A PEG-IN (§23A.3a, kanban #999/#1026): from the rules epoch an outpoint counts only at a height its block confirms, at most
// peg_in_max_age old at the epoch's first height. Epoch 40 starts at 5760, so 100 blocks old is height 5660
// THE HELD LOCK OF #998: a claim carries one (signed reads of three of the four guardians); these tests of age show a lock larger than any peg-in
const heldLockOf = (i, { epoch = 40, sat = 1_000_000n, outpoint = `${String(i + 1).repeat(64)}:0`, signers = keys.slice(0, 3) } = {}) => {
  const lock = { outpoint, contractId: '77'.repeat(32), amountMsat: String(sat * 1000n) };
  return { ...lock, reads: signers.map((g) => signHeldRead({ federationId: fid, epoch, gateway: keys[i].hex, ...lock, blocksLeft: 6, tipHeight: epoch * 144 + 72 }, g.hex, (h) => schnorr.sign(h, g.secret))) };
};
function aged({ claim0, claim1 = {}, fees = {}, rulesEpoch = 0, tipAt = 144 * 40 + 5, inBlock = () => true, network = 'regtest', coins, held0 = heldLockOf(0), held1 = heldLockOf(1), heldSet = { seated: keys.map((k) => k.hex), threshold: 3 } }) {
  const claims = { 0: { ...claimOf(0, claim0), ...(held0 ? { heldLock: held0 } : {}) }, 1: { ...claimOf(1, claim1), ...(held1 ? { heldLock: held1 } : {}) } };
  const entries = keys.map((k, i) => ({ pubkey: Uint8Array.from(Buffer.from(k.hex, 'hex')), bondSats: 50000n, advert: { endpoint: `https://seat${i}.example`, operatorId: `op${i}` } }));
  const fetcher = async (url) => {
    const seat = /^https:\/\/seat(\d)\.example\/gateway-claim\?federation=[0-9a-f]{64}$/.exec(url);
    if (seat) return claims[seat[1]] ? { status: 200, json: async () => claims[seat[1]] } : { status: 404, json: async () => ({}) };
    // an LNv2 routing_info, its fees as fedimint's PaymentFee (kanban #1324): 0 % unless the test names a seat's
    const gw = /^https:\/\/n(\d)\.example\/gateway\/routing_info$/.exec(url);
    const f = (gw && fees[gw[1]]) || { base: 0, parts_per_million: 0 };
    return { status: 200, text: async () => JSON.stringify({ module_public_key: '02' + 'cd'.repeat(32), send_fee_default: f, send_fee_minimum: f, receive_fee: f }) };
  };
  const asked = [], w = { tip: tipAt };
  const watch = createGatewayWatch({ federationId: async () => fid, seated: async () => [keys[0].hex, keys[1].hex], entries: async () => entries, tip: async () => w.tip, beaconAt: async () => new Uint8Array(32).fill(7),
    verify, fetcher, federationCoins: async () => coins, heldSetFor: async () => heldSet, rulesNetwork: network, ...(rulesEpoch === 'network' ? {} : { rulesEpoch }), outpointAt: async (h, o) => { asked.push([h, o]); return inBlock(h, o); } });
  return { watch, asked, w };
}
const pa = 'aa'.repeat(32) + ':1', pb = 'bb'.repeat(32) + ':0', pc = 'cc'.repeat(32) + ':2';
const coinsOf = new Map([[pa, 60_000n], [pb, 25_000n], [pc, 15_000n]]);
const provedOf = async (x, node = 0) => { await x.watch.probe(); return (await x.watch.view()).gateways[keys[node].hex].provedPegInSats; };

test('from the rules epoch a peg-in counts at most peg_in_max_age old at the epoch\'s first height; one a block older does not', async () => {
  assert.equal(await provedOf(aged({ claim0: { pegInOutpoints: [`${pa}@5660`, `${pb}@5659`, `${pc}@5764`] }, coins: coinsOf })), '75000', 'exactly 100 old, and one younger than the epoch; not 101');
});

test('an outpoint with no height counts nothing from the rules epoch, and a claim with heights reads as now before it', async () => {
  assert.equal(await provedOf(aged({ claim0: { pegInOutpoints: [pa] }, coins: coinsOf })), '0');
  const before = aged({ claim0: { pegInOutpoints: [pa, `${pb}@1`] }, rulesEpoch: 41, coins: coinsOf });
  assert.equal(await provedOf(before), '85000', 'age not asked, the height ignored');
  assert.deepEqual(before.asked, [], 'no block read');
  assert.equal(await provedOf(aged({ claim0: { pegInOutpoints: [pa] }, rulesEpoch: null, coins: coinsOf })), '60000', 'no rules epoch named: as now');
  const live = aged({ claim0: { pegInOutpoints: [pa] }, rulesEpoch: 'network', network: 'testnet4', coins: coinsOf });
  assert.equal(await provedOf(live), '60000', 'testnet4 today');
  const defaults = aged({ claim0: { pegInOutpoints: [pa] }, rulesEpoch: 'network', network: 'regtest', coins: coinsOf });
  assert.equal(await provedOf(defaults), '0', 'regtest\'s entry is 0');
});

test('a wrong height counts nothing, an unread block counts nothing for now, and only that one block is read', async () => {
  const wrong = aged({ claim0: { pegInOutpoints: [`${pa}@5700`] }, coins: coinsOf, inBlock: () => false });
  assert.equal(await provedOf(wrong), '0');
  assert.deepEqual(wrong.asked.at(-1), [5700, pa]);
  assert.equal(await provedOf(aged({ claim0: { pegInOutpoints: [`${pa}@5700`] }, coins: coinsOf, inBlock: () => null })), '0');
  assert.equal(await provedOf(aged({ claim0: { pegInOutpoints: [`${pa}@5700`] }, coins: coinsOf, inBlock: () => { throw new Error('rpc down'); } })), '0');
  const old = aged({ claim0: { pegInOutpoints: [`${pa}@1`] }, coins: coinsOf });
  assert.equal(await provedOf(old), '0');
  assert.deepEqual(old.asked, [], 'too old: no block read');
});

test('one height for everyone: the same amount at any tip in the epoch, and a deep block is read once', async () => {
  const x = aged({ claim0: { pegInOutpoints: [`${pa}@5660`] }, coins: coinsOf });
  assert.equal(await provedOf(x), '60000');
  x.w.tip = 144 * 40 + 140;
  assert.equal((await x.watch.view()).gateways[keys[0].hex].provedPegInSats, '60000', 'age read at the epoch\'s start, not this guardian\'s tip');
  assert.equal(x.asked.length, 1, 'kept: it is buried');
  const near = aged({ claim0: { pegInOutpoints: [`${pa}@5764`] }, coins: coinsOf });
  await provedOf(near); await near.watch.view();
  assert.ok(near.asked.length >= 2, 'a block near the tip can still move: read again');
});

test('an outpoint two claims name counts for neither, whatever heights they give, and a coin the federation does not hold counts nothing', async () => {
  const both = aged({ claim0: { pegInOutpoints: [`${pa}@5700`] }, claim1: { pegInOutpoints: [`${pa}@5701`] }, coins: coinsOf });
  assert.deepEqual([await provedOf(both, 0), await provedOf(both, 1)], ['0', '0']);
  assert.equal(await provedOf(aged({ claim0: { pegInOutpoints: [`${'dd'.repeat(32)}:0@5700`] }, coins: coinsOf })), '0');
});

// THE HELD PROOF (§23A.3a, kanban #998, rulings #1029/#1030): the count is min(proved, held)
const heldOf = async (x, node = 0) => { await x.watch.probe(); return (await x.watch.view()).gateways[keys[node].hex]; };
const fresh = [`${pa}@5700`];

test('from the rules epoch a peg-in counts up to its held lock: min(proved, held), and no proof counts 0', async () => {
  assert.equal((await heldOf(aged({ claim0: { pegInOutpoints: fresh }, coins: coinsOf }))).provedPegInSats, '60000', 'a lock above the peg-in: the peg-in');
  const small = await heldOf(aged({ claim0: { pegInOutpoints: fresh }, coins: coinsOf, held0: heldLockOf(0, { sat: 25_000n }) }));
  assert.equal(small.provedPegInSats, '25000', 'a lock below it: the lock');
  assert.equal(small.heldLockSats, '25000');
  assert.equal((await heldOf(aged({ claim0: { pegInOutpoints: fresh }, coins: coinsOf, held0: null }))).provedPegInSats, '0', 'no proof counts 0');
  assert.equal((await heldOf(aged({ claim0: {}, coins: coinsOf }))).provedPegInSats, '0', 'a lock with no peg-in proves no peg-in');
});

test('before the rules epoch, and on a network that names none, the held lock is not asked for', async () => {
  const before = await heldOf(aged({ claim0: { pegInOutpoints: [pa] }, rulesEpoch: 41, coins: coinsOf, held0: null }));
  assert.equal(before.provedPegInSats, '60000');
  assert.equal(before.heldLockSats, undefined);
  assert.equal((await heldOf(aged({ claim0: { pegInOutpoints: [pa] }, rulesEpoch: 'network', network: 'testnet4', coins: coinsOf, held0: null }))).provedPegInSats, '60000', 'testnet4 today');
});

test('fewer reads than the threshold, a read of the wrong epoch, or no record to judge by counts 0', async () => {
  assert.equal((await heldOf(aged({ claim0: { pegInOutpoints: fresh }, coins: coinsOf, held0: heldLockOf(0, { signers: keys.slice(0, 2) }) }))).provedPegInSats, '0');
  assert.equal((await heldOf(aged({ claim0: { pegInOutpoints: fresh }, coins: coinsOf, held0: heldLockOf(0, { epoch: 39 }) }))).provedPegInSats, '0');
  assert.equal((await heldOf(aged({ claim0: { pegInOutpoints: fresh }, coins: coinsOf, heldSet: null }))).provedPegInSats, '0');
});

test('a lock two claims name counts for neither', async () => {
  const same = `${'ee'.repeat(32)}:0`;
  const x = aged({ claim0: { pegInOutpoints: fresh }, claim1: { pegInOutpoints: [`${pb}@5700`] }, coins: coinsOf, held0: heldLockOf(0, { outpoint: same }), held1: heldLockOf(1, { outpoint: same }) });
  assert.equal((await heldOf(x, 0)).provedPegInSats, '0');
  assert.equal((await heldOf(x, 1)).provedPegInSats, '0');
});

test('a guardian that never read the lock counts the same amount from the signatures alone', async () => {
  // its coins and claim are all it has: nothing here reads a lock
  const a = aged({ claim0: { pegInOutpoints: fresh }, coins: coinsOf, held0: heldLockOf(0, { sat: 30_000n, signers: keys.slice(0, 3) }) });
  const b = aged({ claim0: { pegInOutpoints: fresh }, coins: coinsOf, held0: heldLockOf(0, { sat: 30_000n, signers: keys.slice(1, 4) }) });
  assert.equal((await heldOf(a)).provedPegInSats, '30000');
  assert.equal((await heldOf(b)).provedPegInSats, '30000');
});

test('peg-in pressure reads the band the record names: 65 % kept in PRESSURE ranks peg-in first, as the load alone would not (kanban #997)', async () => {
  const claims = { 0: claimOf(0), 1: claimOf(1) };
  const entries = keys.map((k, i) => ({ pubkey: Uint8Array.from(Buffer.from(k.hex, 'hex')), bondSats: 50000n, advert: { endpoint: `https://seat${i}.example`, operatorId: `op${i}` } }));
  const fetcher = async (url) => {
    const seat = /^https:\/\/seat(\d)\.example\/gateway-claim\?federation=[0-9a-f]{64}$/.exec(url);
    if (seat) return claims[seat[1]] ? { status: 200, json: async () => claims[seat[1]] } : { status: 404, json: async () => ({}) };
    return { status: 200, text: async () => '{"module_public_key":"02' + 'cd'.repeat(32) + '"}' };
  };
  const view = async (band, status = null) => { const w = createGatewayWatch({ federationId: async () => fid, seated: async () => [keys[0].hex, keys[1].hex], entries: async () => entries, tip: async () => 144 * 40 + 5, beaconAt: async () => new Uint8Array(32).fill(7), verify, fetcher,
    federationCoins: async () => new Map(), seatingFor: async () => [keys[0].hex], pressureFor: async () => ({ reserveSats: 65000n, exposureCapSats: 100000n, ...(band ? { band } : {}), ...(status ? { status } : {}) }) });
    await w.probe(); return w.view(); };
  assert.equal((await view(null)).pegInPressure, undefined, 'no band named: 65 % enters nothing');
  assert.notEqual((await view('PRESSURE')).pegInPressure, undefined, 'as the record says');
  assert.equal((await view('PRESSURE', 'DRAINING')).pegInPressure, undefined, 'only an OPEN federation\'s band has effect (ruling #1028)');
});

test('a peg-in past the cap unseats its gateway: the watch names the outpoint, the seat ranks it ineligible (kanban #1093 part 6)', async () => {
  const o1 = 'aa'.repeat(32) + ':1', o2 = 'bb'.repeat(32) + ':0';
  const claims = { 0: claimOf(0, { pegInOutpoints: [`${o1}@5000`] }), 1: claimOf(1, { pegInOutpoints: [`${o2}@5001`] }) };
  const entries = keys.map((k, i) => ({ pubkey: Uint8Array.from(Buffer.from(k.hex, 'hex')), bondSats: 50000n, advert: { endpoint: `https://seat${i}.example`, operatorId: `op${i}` } }));
  const fetcher = async (url) => {
    const seat = /^https:\/\/seat(\d)\.example\/gateway-claim\?federation=[0-9a-f]{64}$/.exec(url);
    if (seat) return claims[seat[1]] ? { status: 200, json: async () => claims[seat[1]] } : { status: 404, json: async () => ({}) };
    return { status: 200, text: async () => '{"module_public_key":"02' + 'cd'.repeat(32) + '"}' };
  };
  const coins = new Map([[o1, 60_000n], [o2, 60_000n]]);
  const asked = [];
  const w = createGatewayWatch({ federationId: async () => fid, seated: async () => [keys[0].hex, keys[1].hex], entries: async () => entries, tip: async () => 144 * 40 + 5,
    beaconAt: async () => new Uint8Array(32).fill(7), verify, fetcher, federationCoins: async () => coins, rulesEpoch: null,
    pastCapAt: async (f, h) => { asked.push([f, h]); return h === 5000; } });
  await w.probe();
  const v = await w.view();
  assert.ok(asked.some(([f, h]) => f === fid && h === 5000), 'asked at the height the claim names');
  const off = (v.ineligible || []).find((x) => x.node === keys[0].hex);
  assert.match(off && off.why, new RegExp(`pegged in past the cap: ${o1} went in at load >= 1`));
  assert.ok(!v.seated.includes(keys[0].hex), 'not seated, not even as the last gateway');
  assert.ok(!(v.ineligible || []).some((x) => x.node === keys[1].hex && /past the cap/.test(x.why)), 'the other gateway\'s peg-in went in below the cap');
});

test('kanban #1324: from the rules epoch a gateway whose published fee is above the cap is not seated; its fees are said; before it, fees are not read', async () => {
  const dear = { 1: { base: 0, parts_per_million: 3000 } };   // seat 1's gateway: 0.3 %, above the reference 0.1 % + 10 sat
  const x = aged({ claim0: {}, claim1: {}, fees: dear, coins: coinsOf });
  await x.watch.probe();
  const v = await x.watch.view();
  assert.deepEqual(v.gateways[keys[1].hex].fees, { send: { ppm: 3000, baseMsat: 0 }, receive: { ppm: 3000, baseMsat: 0 } });
  assert.ok(!v.seated.includes(keys[1].hex), `seated above the cap: ${JSON.stringify(v.seated)}`);
  assert.ok(v.seated.includes(keys[0].hex));
  assert.match(JSON.stringify(v.ineligible), /fee: its send fee 0.3 %/);
  // before the rules epoch the fee rule does not apply: both are seated as before
  const before = aged({ claim0: {}, claim1: {}, fees: dear, rulesEpoch: 41, coins: coinsOf });
  await before.watch.probe();
  const vb = await before.watch.view();
  assert.ok(vb.seated.includes(keys[1].hex), JSON.stringify(vb.seated));
});
