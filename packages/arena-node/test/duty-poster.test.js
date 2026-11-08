// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE POSTS THE ROUNDS ITSELF (kanban #702, 2026-10-26: "The round runners must be an integrated part of the node. Who decides what
// round is posted today? There is something in the spec"): the day's duty engine (src/duty-day.js) and the node's poster (src/duty-poster.js)
// on a fake chain - who is on duty, who posts, the missed day, the node that cannot pay, the newest version, no double posting, the backup
// grid, and every reorg and fork of 2026-10-26 posted again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { seriesPublicationOutput } from '../../arena-protocol/src/series.js';
import { dutyDrawOrder, dutyMarkerOutput, backupMarkerOutput, dayStartMs, itemTag, playedOfWindow, dayMarkersOf, postedSeriesOf,
  DUTY_BACKUP_COMMITTEE_LEAD_MS } from '../../arena-protocol/src/duty.js';
import { serializeUnsigned } from '../src/fund-at-rate.js';
import { createDayDuty, createGridBase } from '../src/duty-day.js';
import { walletVerdict, dutySetting, planFederations, posterOf, dayTemplate, DUTY_TEMPLATE, esploraSender } from '../src/duty-poster.js';
import { catalogOf } from '../src/duty-guard.js';

const H = 3600000, MIN = 60000;
const DAY = 20753;                                   // 2026-10-27: its duty posts the rounds of 10-28
const T0 = dayStartMs(DAY);
const KEYS = [1, 2, 3, 4, 5].map((n) => new Uint8Array(32).fill(n));
// the census as entries: each key its own bond (kanban #1325: the duty order is drawn by bond outpoint, bond-weighted)
const ENTRIES = KEYS.map((k, i) => ({ pubkey: k, txid: new Uint8Array(32).fill(0x40 + i), vout: 0, bondSats: 1_000_000n }));
const ORDER = dutyDrawOrder({ networkId: NETWORK_ID_TESTNET4, slot: DAY, entries: ENTRIES });
const ORDER_Y = dutyDrawOrder({ networkId: NETWORK_ID_TESTNET4, slot: DAY - 1, entries: ENTRIES });
// kanban #1219: a marker counts only from its creator's own hour - these worlds' markers are the day's duty node's (rank 0, due at once)
const RANK0 = async () => toHex(ORDER[0]);
const GID = 'c4'.repeat(32);
const DEV = 'ab'.repeat(32);
const FED = '33'.repeat(32);

const outBytes = (o) => Buffer.concat([(() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(o.value || 0)); return b; })(), Buffer.from([o.script.length]), Buffer.from(o.script)]);
let nonce = 0;
/** A transaction carrying `outputs` (a marker, a series publication): its bytes and its txid as sendrawtransaction names it. */
function txOf(outputs) {
  const raw = fromHex(serializeUnsigned([{ txid: (++nonce).toString(16).padStart(64, '0'), vout: 0 }], outputs.map(outBytes), null));
  return { raw, txid: toHex(Uint8Array.from(parseTransaction(raw).txid).reverse()) };
}
const header = (timeS, n) => { const h = new Uint8Array(80); h[0] = n & 0xff; h[1] = (n >> 8) & 0xff; new DataView(h.buffer).setUint32(68, timeS, true); return h; };

/**
 * A FAKE CHAIN AND NODE: blocks every 10 min from 40 h before the day until `nowMs`, transactions placed at given times, a mempool, a
 * wallet. -> the engine's options and what it did (published grids, fee raises).
 */
function world({ nowMs = T0 + 10 * MIN, local = [ORDER[0]], inBlocks = [], mempool = [], wallet = {}, blockHash = {}, seats = ['http://s1'], seatRounds = null,
  canPay = async () => ({ ok: true }), role = 'primary', postedPrimary = async () => false, game = 'nextblock', view = null, dir = null,
  census = async () => ENTRIES, mempoolFails = false, hexes = {},
  // WHO A MARKER'S SERIES IS FROM (kanban #1168: only a posting by a node of the day's duty order counts): every series here is held, its
  // creator the census key its first byte names
  creatorOf = async (id) => toHex(KEYS[parseInt(String(id).slice(0, 2), 16) % KEYS.length]) } = {}) {
  const firstHeight = 1000;
  const blocks = [];
  for (let t = T0 - 40 * H, i = 0; t <= nowMs; t += 10 * MIN, i++) blocks.push({ header: header(Math.floor(t / 1000), i), transactions: [], t });
  for (const { atMs, raw } of inBlocks) { const b = blocks.find((x) => x.t >= atMs); b.transactions.push(raw); }
  const tip = firstHeight + blocks.length - 1;
  const pool = new Map(mempool.map((x) => [x.txid, x.raw]));
  const did = { published: [], bumped: [], gridBase: [], sent: [] };
  const opts = {
    game, item: `${game}-day`, role, postedPrimary, networkId: NETWORK_ID_TESTNET4, local: new Set(local.map(toHex)), dir: dir || mkdtempSync(join(tmpdir(), 'duty-')),
    chain: { view: view || (async () => ({ blocks, firstHeight })), censusEntriesAt: census, seatUrls: async () => seats },
    chainCall: async (m, p) => {
      if (m === 'getrawmempool') { if (mempoolFails) throw new Error('bitcoind did not answer getrawmempool'); return [...pool.keys()]; }
      if (m === 'getrawtransaction') { if (!pool.has(p[0])) throw new Error('gone'); return toHex(pool.get(p[0])); }
      if (m === 'getblockhash') return blockHash[p[0]] || `hash-${p[0]}`;
      if (m === 'sendrawtransaction') { const id = toHex(Uint8Array.from(parseTransaction(fromHex(p[0])).txid).reverse()); did.sent.push(id); if (pool.has(id)) throw new Error('txn-already-in-mempool'); pool.set(id, fromHex(p[0])); return id; }
      if (m === 'getblockcount') return tip;
      throw new Error(`no ${m}`);
    },
    walletRpc: async (m, p) => {
      if (m === 'gettransaction') { if (!(p[0] in wallet)) throw new Error('not the wallet\'s'); return { confirmations: wallet[p[0]], ...(hexes[p[0]] ? { hex: hexes[p[0]] } : {}) }; }
      if (m === 'bumpfee') { did.bumped.push(p[0]); return { txid: 'b'.repeat(64) }; }
      throw new Error(`no ${m}`);
    },
    gridBase: async (g, slot, o2 = {}) => { did.gridBase.push({ g, slot, ...o2 }); return { ok: true, fields: { gameId: fromHex(GID) }, periodMs: 90000, version: 24, id: GID,
      censusHeight: tip - (o2.depth || 6), censusHash: `hash-${tip - (o2.depth || 6)}`, donationSetId: new Uint8Array(32) }; },
    openGrid: async (kind, o2) => {
      const s = o2.extraOutputs[0].script;
      const m = { kind: String.fromCharCode(s[5]), slot: new DataView(s.buffer, s.byteOffset).getUint32(6, false), tag: toHex(s.subarray(10, 14)) };
      const txid = (did.published.length + 1).toString(16).padStart(64, 'e');
      did.published.push({ marker: m, committeeTimeMs: Number(o2.committeeTimeMs), firstCloseMs: Number(o2.firstCloseMs), slots: o2.slots, kind });
      return { ok: true, txid, series: ['ab'.repeat(32)], lines: ['line'], rounds: o2.slots };
    },
    postSeries: async () => ({ took: 1, of: 1, refused: [] }), fedsNow: async () => [FED],
    seatCatalog: async () => new Map([[GID, { id: GID, name: 'nextblock', version: 24, dev: DEV }]]), devOf: { nextblock: DEV },
    // THE SEATS DRAW TODAY'S ROUNDS (the day before this duty's is covered), unless a test says otherwise
    fetchFn: async (url) => ({ ok: true, json: async () => (seatRounds ? seatRounds(url) : { rounds: [0, 1, 2].map((i) => ({ game: { id: GID },
      startTime: new Date(Math.max(T0, nowMs) + 10 * MIN + i * 90000).toISOString(), committee: { drawn: { game: ['k'], settlement: ['k'] } } })) }) }),
    canPay, now: () => nowMs, say: () => {}, creatorOf,
  };
  return { opts, did, tip, blocks, firstHeight };
}
const tagOf = (item) => toHex(itemTag(item));

test('every node computes the same duty order, whatever order it read the census in, and knows its own rank', async () => {
  const shuffled = [ENTRIES[3], ENTRIES[0], ENTRIES[4], ENTRIES[2], ENTRIES[1], ENTRIES[0]];
  assert.deepEqual(dutyDrawOrder({ networkId: NETWORK_ID_TESTNET4, slot: DAY, entries: shuffled }).map(toHex), ORDER.map(toHex));
  const a = world({ local: [ORDER[0]] }), b = world({ local: [ORDER[1]] });
  const sa = await createDayDuty(a.opts).look(), sb = await createDayDuty(b.opts).look();
  assert.deepEqual(sa.order.map(toHex), sb.order.map(toHex));
  assert.deepEqual(sa.order.map(toHex), ORDER.map(toHex));
  assert.equal(sa.rank, 0); assert.equal(sb.rank, 1);
  // and yesterday's duty, whose grid covers today, for GET /duty
  assert.deepEqual(sa.orders[DAY - 1].order.map(toHex), ORDER_Y.map(toHex));
});

test('only the duty node posts: rank 1 publishes the next day with the day marker, rank 2 posts nothing in the first hour', async () => {
  const a = world({ local: [ORDER[0]] });
  await createDayDuty(a.opts).look();
  assert.equal(a.did.published.length, 1);
  assert.deepEqual(a.did.published[0].marker, { kind: 'D', slot: DAY, tag: tagOf('nextblock-day') });
  assert.equal(a.did.published[0].committeeTimeMs, dayStartMs(DAY + 1) - 12 * H);
  const b = world({ local: [ORDER[1]] });
  await createDayDuty(b.opts).look();
  assert.equal(b.did.published.length, 0);
});

test('a missed day falls to the next node: rank 2 posts it an hour into the day when no marker is seen, rank 3 still waits', async () => {
  const b = world({ local: [ORDER[1]], nowMs: T0 + 70 * MIN });
  await createDayDuty(b.opts).look();
  assert.equal(b.did.published.length, 1);
  assert.equal(b.did.published[0].marker.slot, DAY);
  const c = world({ local: [ORDER[2]], nowMs: T0 + 70 * MIN });
  await createDayDuty(c.opts).look();
  assert.equal(c.did.published.length, 0);
});

test('no double posting: the day marker in the mempool, or in a block, stops the duty node', async () => {
  const marked = txOf([dutyMarkerOutput(DAY, 'nextblock-day'), seriesPublicationOutput(new Uint8Array(32).fill(9))]);
  const inPool = world({ creatorOf: RANK0, local: [ORDER[0]], nowMs: T0 + 70 * MIN, mempool: [marked] });
  await createDayDuty(inPool.opts).look();
  assert.equal(inPool.did.published.length, 0);
  const inChain = world({ creatorOf: RANK0, local: [ORDER[0]], nowMs: T0 + 70 * MIN, inBlocks: [{ atMs: T0 + 20 * MIN, raw: marked.raw }] });
  const st = await createDayDuty(inChain.opts).look();
  assert.equal(inChain.did.published.length, 0);
  assert.equal(st.posted, true);
  // and the posting's series are read off it, for who posted it
  assert.deepEqual(st.markers.filter((m) => m.slot === DAY)[0].series, ['09'.repeat(32)]);
});

test('a node that cannot pay skips and says why; the wallet\'s word covers Electrum, no wallet, two wallets and no confirmed coins', async () => {
  const a = world({ local: [ORDER[0]], canPay: async () => ({ ok: false, why: 'the wallet "arena" holds no confirmed coins' }) });
  const st = await createDayDuty(a.opts).look();
  assert.equal(a.did.published.length, 0);
  assert.match(st.wouldPost[0].why, /no confirmed coins/);
  assert.match(walletVerdict({ listed: new Error('getwalletinfo is not served in Electrum mode') }).why, /Electrum/);
  assert.match(walletVerdict({ listed: new Error('Method not found (-32601)') }).why, /without a wallet/);
  assert.match(walletVerdict({ listed: [] }).why, /no wallet loaded/);
  assert.match(walletVerdict({ listed: ['a', 'b'] }).why, /duty_wallet/);
  assert.match(walletVerdict({ listed: ['arena'], unspent: [{ amount: 0.001, confirmations: 0, spendable: true }] }).why, /no confirmed coins/);
  const ok = walletVerdict({ listed: ['arena'], unspent: [{ amount: 0.0012345, confirmations: 3, spendable: true }, { amount: 1, confirmations: 0 }] });
  assert.deepEqual(ok, { canPay: true, wallet: 'arena', confirmedSats: 123450, why: null });
  assert.equal(dutySetting(''), 'auto'); assert.equal(dutySetting('off'), 'off'); assert.equal(dutySetting('1'), 'on');
});

test('the newest version the census can draw is posted (v24 over v13), on the census the seats\' chains hold', async () => {
  const hdr = header(1793000000, 7);
  const censusHash = toHex(Uint8Array.from(blockHashOf(hdr)).reverse());
  const v = (n) => ({ id: String(n).padStart(2, '0').repeat(32), m: { gameName: 'nextblock', version: n, gameDevPubkey: fromHex(DEV), requiredProtocolVersion: 2,
    cores: [{ hash: 'cc'.repeat(32), configs: [] }] } });
  const games = [v(13), v(24)];
  const entry = (hosts) => ({ roles: ['game', 'verify', 'settlement'], hostedGames: hosts.map((g) => fromHex(g.id)) });
  const seats = ['http://s1', 'http://s2', 'http://s3'];
  const gb = createGridBase({ chainCall: async (m) => (m === 'getblockcount' ? 2000 : censusHash),
    censusEntriesAt: async () => [entry(games), entry(games), entry([games[1]])], contractAt: () => ({ networkId: NETWORK_ID_TESTNET4 }),
    catalogSeats: async () => seats, chainSeats: async () => seats, localCount: 1, devOf: { nextblock: DEV }, donationSetAt: () => new Uint8Array(32),
    decode: (bytes) => games.find((g) => g.id === toHex(bytes)).m, idOf: (m) => fromHex(games.find((g) => g.m === m).id), blockHashOf,
    fetchFn: async (url) => (url.endsWith('/games') ? { ok: true, json: async () => ({ games: games.map((g) => ({ id: g.id, manifest: g.id })) }) }
      : { ok: true, arrayBuffer: async () => hdr.buffer.slice(0) }) });
  const base = await gb.gridBase('nextblock', DAY);
  assert.equal(base.ok, true, base.why);
  assert.equal(base.version, 24);
  assert.equal(base.censusHeight, 2000 - 6);
  // the backup's census, deeper
  assert.equal((await gb.gridBase('nextblock', DAY, { depth: 12 })).censusHeight, 2000 - 12);
  // a census block the seats do not hold is refused
  const off = createGridBase({ chainCall: async (m) => (m === 'getblockcount' ? 2000 : 'ff'.repeat(32)), censusEntriesAt: async () => [], contractAt: () => ({}),
    catalogSeats: async () => seats, chainSeats: async () => seats, localCount: 0, donationSetAt: () => null, blockHashOf, decode: () => null, idOf: () => null,
    fetchFn: async () => ({ ok: true, arrayBuffer: async () => hdr.buffer.slice(0) }) });
  const refused = await off.gridBase('nextblock', DAY);
  assert.equal(refused.ok, false);
  assert.match(refused.why, /a branch the seats do not follow/);
});

test('the backup grid: rank 2 posts it from 02:00 even when rank 1 is down, with its own marker, a deeper census and a later committee', async () => {
  const b = world({ local: [ORDER[1]], nowMs: T0 + 2 * H + 10 * MIN, role: 'backup' });
  await createDayDuty(b.opts).look();
  assert.equal(b.did.published.length, 1);
  assert.deepEqual(b.did.published[0].marker, { kind: 'B', slot: DAY, tag: tagOf('nextblock-day') });
  assert.equal(b.did.published[0].committeeTimeMs, dayStartMs(DAY + 1) - DUTY_BACKUP_COMMITTEE_LEAD_MS);
  assert.ok(b.did.published[0].committeeTimeMs > dayStartMs(DAY + 1) - 12 * H);
  assert.equal(b.did.gridBase[0].depth, 12);
  // not before 02:00, never from the day's duty node, never from the node that posted the primary, not twice
  const early = world({ local: [ORDER[1]], nowMs: T0 + 90 * MIN, role: 'backup' });
  await createDayDuty(early.opts).look(); assert.equal(early.did.published.length, 0);
  const first = world({ local: [ORDER[0]], nowMs: T0 + 5 * H, role: 'backup' });
  await createDayDuty(first.opts).look(); assert.equal(first.did.published.length, 0);
  const own = world({ local: [ORDER[1]], nowMs: T0 + 3 * H, role: 'backup', postedPrimary: async () => true });
  await createDayDuty(own.opts).look(); assert.equal(own.did.published.length, 0);
  const seen = txOf([backupMarkerOutput(DAY, 'nextblock-day'), seriesPublicationOutput(new Uint8Array(32).fill(4))]);
  const twice = world({ local: [ORDER[2]], nowMs: T0 + 4 * H, role: 'backup', mempool: [seen] });
  await createDayDuty(twice.opts).look(); assert.equal(twice.did.published.length, 0);
  // and the primary engine does not take a backup marker for the day's own
  const primary = world({ local: [ORDER[0]], mempool: [seen] });
  await createDayDuty(primary.opts).look(); assert.equal(primary.did.published.length, 1);
  assert.deepEqual(dayMarkersOf(seen.raw), [{ slot: DAY, tag: tagOf('nextblock-day'), kind: 'B' }]);
});

test('one grid played per window: primary while drawn, backup when the primary is dead, backup never offered beside a drawn primary', () => {
  const ids = (rows) => [...playedOfWindow(rows)].sort();
  // both alive: the primary is played, the backup never offered
  assert.deepEqual(ids([{ id: 'p', backup: false, drawn: true, entries: 0 }, { id: 'b', backup: true, drawn: true, entries: 0 }]), ['p']);
  // the primary dead (not drawable): the backup is played
  assert.deepEqual(ids([{ id: 'p', backup: false, drawn: false, entries: 0 }, { id: 'b', backup: true, drawn: true, entries: 0 }]), ['b', 'p']);
  // no backup: the primary alone
  assert.deepEqual(ids([{ id: 'p', backup: false, drawn: true, entries: 0 }]), ['p']);
  // a backup that took a stake keeps it, and the primary takes none beside it
  assert.deepEqual(ids([{ id: 'p', backup: false, drawn: true, entries: 0 }, { id: 'b', backup: true, drawn: true, entries: 2 }]), ['b']);
  // a role not read yet counts as a primary
  assert.deepEqual(ids([{ id: 'p', backup: null, drawn: true, entries: 0 }, { id: 'b', backup: true, drawn: true, entries: 0 }]), ['p']);
});

test('kanban #1119: a primary whose entry opened without its seating certificate leaves the window to its seated backup, at every seat alike', () => {
  const ids = (rows) => [...playedOfWindow(rows)].sort();
  // 2026-11-04 10:30Z: primary b3f22953 drawn but never certified, backup 7ac5dbc0 seated - every seat answered the backup played: false
  assert.deepEqual(ids([{ id: 'p', backup: false, drawn: true, entries: 0, unseated: true }, { id: 'b', backup: true, drawn: true, entries: 0, unseated: false }]), ['b', 'p']);
  // before its entry opens an uncertified primary still holds the window (its seating may close yet)
  assert.deepEqual(ids([{ id: 'p', backup: false, drawn: true, entries: 0, unseated: false }, { id: 'b', backup: true, drawn: true, entries: 0, unseated: false }]), ['p']);
  // once the backup took an entry it keeps the window, even if the primary is certified late
  assert.deepEqual(ids([{ id: 'p', backup: false, drawn: true, entries: 0, unseated: false }, { id: 'b', backup: true, drawn: true, entries: 1, unseated: false }]), ['b']);
});

// THE REORGS AND FORKS OF 2026-10-26 (the owner: "The hardened round poster must also check for reorgs and forks and repost automatically as
// needed. We may never be without a valid round on a day")
const keptPosting = (dir, k) => writeFileSync(join(dir, `nextblock-day-${k.slot}.json`), JSON.stringify({ item: 'nextblock-day', target: new Date(dayStartMs(k.slot + 1)).toISOString(),
  series: ['ab'.repeat(32)], lines: ['line'], posted: [{ took: 1, of: 1 }], emergency: false, gameId: GID, version: 24, ...k }) + '\n');

test('(a) a posting whose census block the chain left (our nodes on their own branch from 157625) is dead and the day is posted again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'duty-'));
  const pub = txOf([dutyMarkerOutput(DAY, 'nextblock-day'), seriesPublicationOutput(new Uint8Array(32).fill(5))]);
  const w = world({ local: [ORDER[0]], nowMs: T0 + 3 * H, dir, inBlocks: [{ atMs: T0 + 20 * MIN, raw: pub.raw }], blockHash: { 1100: 'the-branch-the-chain-follows' } });
  keptPosting(dir, { slot: DAY, txid: pub.txid, censusHeight: 1100, censusHash: 'the-branch-we-left', committeeMs: dayStartMs(DAY + 1) - 12 * H, firstStartMs: dayStartMs(DAY + 1) });
  await createDayDuty(w.opts).look();
  assert.equal(w.did.published.length, 1);
  assert.deepEqual(w.did.published[0].marker, { kind: 'D', slot: DAY, tag: tagOf('nextblock-day-emergency') });
  // covering the whole next day, from its start
  assert.equal(w.did.published[0].firstCloseMs - 45000, dayStartMs(DAY + 1));
});

test('(b) a reorg drops the publication back to the mempool: watched, its fee raised near its committee, reposted once its beacon passed it', async () => {
  // today's grid (posted yesterday): its committee (00:00 less 12 h) is long past, the beacon came, the publication is in the mempool again
  const dir = mkdtempSync(join(tmpdir(), 'duty-'));
  const pub = txOf([dutyMarkerOutput(DAY - 1, 'nextblock-day'), seriesPublicationOutput(new Uint8Array(32).fill(6))]);
  const w = world({ local: [ORDER[0]], nowMs: T0 + 30 * MIN, dir, mempool: [pub], inBlocks: [], seatRounds: () => ({ rounds: [] }) });
  keptPosting(dir, { slot: DAY - 1, txid: pub.txid, committeeMs: T0 - 12 * H, firstStartMs: T0, postedAtMs: T0 - 10 * H });
  await createDayDuty(w.opts).look();
  const em = w.did.published.find((p) => p.marker.slot === DAY - 1);
  assert.ok(em, 'an emergency grid for the rest of today');
  assert.equal(em.marker.tag, tagOf('nextblock-day-emergency'));
  // tomorrow's, unconfirmed with its committee less than 3 h ahead of the chain's median: its fee is raised, once
  const dir2 = mkdtempSync(join(tmpdir(), 'duty-'));
  const pub2 = txOf([dutyMarkerOutput(DAY, 'nextblock-day')]);
  const w2 = world({ local: [ORDER[0]], nowMs: T0 + 10 * H, dir: dir2, mempool: [pub2], wallet: { [pub2.txid]: 0 } });
  keptPosting(dir2, { slot: DAY, txid: pub2.txid, committeeMs: dayStartMs(DAY + 1) - 12 * H, firstStartMs: dayStartMs(DAY + 1) });
  const d2 = createDayDuty(w2.opts);
  await d2.look(); await d2.look();
  assert.deepEqual(w2.did.bumped, [pub2.txid]);
});

test('(c) a publication conflicted by a fee raise elsewhere (d2a9c0c7 / 094e6875) is dead at once and the day is posted again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'duty-'));
  const w = world({ local: [ORDER[0]], nowMs: T0 + 40 * MIN, dir, wallet: { ['c1'.repeat(32)]: -1 } });
  keptPosting(dir, { slot: DAY, txid: 'c1'.repeat(32), committeeMs: dayStartMs(DAY + 1) - 12 * H, firstStartMs: dayStartMs(DAY + 1) });
  await createDayDuty(w.opts).look();
  assert.equal(w.did.published.length, 1);
  assert.equal(w.did.published[0].marker.slot, DAY);
});

test('(d) a day not drawable on the seats for the newest version gets an emergency grid for the rest of it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'duty-'));
  const pub = txOf([dutyMarkerOutput(DAY - 1, 'nextblock-day'), seriesPublicationOutput(new Uint8Array(32).fill(7))]);
  const undrawn = () => ({ rounds: [0, 1, 2].map((i) => ({ game: { id: GID }, startTime: new Date(T0 + 3 * H + i * 90000).toISOString(), committee: { drawn: false, why: 'no committee: 0 game nodes' } })) });
  const w = world({ local: [ORDER[0]], nowMs: T0 + 30 * MIN, dir, inBlocks: [{ atMs: T0 - 20 * H, raw: pub.raw }], seats: ['http://s1', 'http://s2', 'http://s3'], seatRounds: undrawn });
  keptPosting(dir, { slot: DAY - 1, txid: pub.txid, committeeMs: T0 - 12 * H, firstStartMs: T0, postedAtMs: T0 - 8 * H });
  const st = await createDayDuty(w.opts).look();
  const em = w.did.published.find((p) => p.marker.slot === DAY - 1);
  assert.ok(em, JSON.stringify(st.days));
  assert.equal(em.marker.tag, tagOf('nextblock-day-emergency'));
});

// SEAT 4, 2026-10-26 11:38-11:43Z (ARENA_DUTY_POST=on, dry): old rounds' views timed out every few seconds, every census read was held "a
// block read failed less than a minute ago", the day's anchor census never read - GET /duty "anchor: null, order: []" - and its first pass
// saw no seat and planned emergency grids for days that were posted and drawn
test('seat 4: a census at the anchor that does not read gives no order, says why, and posts nothing - the next pass that reads it does', async () => {
  let reads = 0;
  const w = world({ local: [ORDER[0]], census: async () => { reads++; if (reads <= 2) throw new Error('a block read failed less than a minute ago: read again after it'); return ENTRIES; } });
  const d = createDayDuty(w.opts);
  const st = await d.look();
  assert.equal(w.did.published.length, 0);
  assert.equal(st.order.length, 0);
  assert.equal(st.ready.ok, false);
  assert.match(st.ready.why, /no census at the day's anchor \d+ yet: a block read failed/);
  assert.ok(Number.isInteger(st.orders[DAY].anchor), 'the anchor is said even while its census is not read');
  await d.look();
  assert.equal(w.did.published.length, 1);
  assert.equal(w.did.published[0].marker.slot, DAY);
});

test('seat 4: no emergency grid on the word of seats that did not answer, nor before the mempool was read; an empty answer is not kept', async () => {
  // today's grid posted by another node, its rounds drawn - but no seat answers yet: no emergency grid, and the next pass asks again
  const pub = txOf([dutyMarkerOutput(DAY - 1, 'nextblock-day'), seriesPublicationOutput(new Uint8Array(32).fill(8))]);
  let answering = false, asked = 0;
  const w = world({ creatorOf: RANK0, local: [ORDER[0]], nowMs: T0 + 30 * MIN, inBlocks: [{ atMs: T0 - 20 * H, raw: pub.raw }], seats: ['http://s1', 'http://s2', 'http://s3'],
    seatRounds: () => { asked++; if (!answering) throw new Error('fetch failed'); return { rounds: [0, 1, 2].map((i) => ({ game: { id: GID }, startTime: new Date(T0 + H + i * 90000).toISOString(),
      committee: { drawn: { game: ['k'], settlement: ['k'] } } })) }; } });
  // tomorrow's posted too, so the only thing a pass could post is an emergency grid
  w.opts.chain.view = (await (async () => { const v = await w.opts.chain.view(); v.blocks[v.blocks.length - 3].transactions.push(txOf([dutyMarkerOutput(DAY, 'nextblock-day'), seriesPublicationOutput(new Uint8Array(32).fill(10))]).raw); return async () => v; })());
  const d = createDayDuty(w.opts);
  const st = await d.look();
  assert.equal(w.did.published.length, 0, JSON.stringify(st.days));
  assert.match(st.ready.why, /0 of 3 seats answered/);
  answering = true;
  const before = asked;
  const st2 = await d.look();
  assert.ok(asked > before, 'the empty answer was not kept');
  assert.equal(w.did.published.length, 0);
  assert.equal(st2.ready.ok, true);
  assert.equal(st2.days[new Date(T0).toISOString().slice(0, 10)].state, 'drawable');
  // a pass that cannot read the mempool posts no day
  const m = world({ creatorOf: RANK0, local: [ORDER[0]], mempoolFails: true });
  const sm = await createDayDuty(m.opts).look();
  assert.equal(m.did.published.length, 0);
  assert.match(sm.wouldPost[0].why, /mempool could not be read/);
});

test('an anchor at the bottom of a short chain view is not taken: the view is widened and the day waits', async () => {
  const w = world({ local: [ORDER[0]] });
  const all = await w.opts.chain.view();
  const cut = all.blocks.findIndex((b) => b.t >= T0 - 20 * H);          // the view starts 20 h before the day: yesterday's anchor is older
  let widened = 0;
  w.opts.chain.view = async () => ({ blocks: all.blocks.slice(cut), firstHeight: all.firstHeight + cut });
  w.opts.chain.widen = () => { widened++; };
  const st = await createDayDuty(w.opts).look();
  assert.equal(widened, 1);
  assert.equal(st.orders[DAY - 1].anchor, null);
  assert.match(st.orders[DAY - 1].why, /older than the \d+ blocks/);
  // today's own anchor (03:00 less) is in the view: its order stands and the day is posted
  assert.deepEqual(st.order.map(toHex), ORDER.map(toHex));
  assert.equal(w.did.published.length, 1);
});

test('a seat or a chain read that fails never stops the poster: the pass says why and the next one tries again', async () => {
  const w = world({ view: async () => { throw new Error('fetch failed: connect ETIMEDOUT 198.51.100.106:6281'); } });
  const d = createDayDuty(w.opts);
  const st = await d.look();
  assert.match(st.error.why, /ETIMEDOUT/);
  await d.look();
});

test('who posted a day: the creator key of the series its marked transaction publishes, its rank, and whether a fallback posted it', () => {
  const t = { creatorPubkey: ORDER[1] };
  const p = posterOf({ series: ['aa'], templateOf: (id) => (id === 'aa' ? t : null), order: ORDER });
  assert.deepEqual(p, { poster: toHex(ORDER[1]), posterRank: 2, fallback: true });
  assert.deepEqual(posterOf({ series: ['zz'], templateOf: () => null, order: ORDER }), { poster: null, posterRank: null, fallback: false });
  const pub = txOf([dutyMarkerOutput(DAY, 'x'), seriesPublicationOutput(new Uint8Array(32).fill(3))]);
  assert.deepEqual(postedSeriesOf(pub.raw), ['03'.repeat(32)]);
});

test('the federations a node posts in are the OPEN ones its records list, a draining one replaced by its OPEN successor', () => {
  const A = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32);
  assert.deepEqual(planFederations([{ federation: A, status: 'OPEN' }, { federation: B, status: 'DRAINING', successor: C }, { federation: C, status: 'OPEN' }]), [A, C]);
  assert.deepEqual(planFederations([{ federation: A, status: 'CLOSED' }]), []);
  // SEAT 4, 2026-10-26: four OPEN records, two of them throwaway test federations no day was posted in - the days go where the last days went
  const T2 = '99'.repeat(32), E = 'e2'.repeat(32);
  const live = [{ federation: A, status: 'OPEN' }, { federation: B, status: 'OPEN' }, { federation: T2, status: 'OPEN' }, { federation: E, status: 'OPEN' }];
  assert.deepEqual(planFederations(live, { played: [A, B] }), [A, B]);
  assert.deepEqual(planFederations(live, { named: [A], played: [A, B] }), [A]);
  assert.deepEqual(planFederations([{ federation: A, status: 'DRAINING', successor: C }, { federation: C, status: 'OPEN' }], { played: [A] }), [C]);
});

test('the day\'s template is the last one this node holds of the app, else the built-in shape', () => {
  const held = [{ seriesGrid: true, networkId: NETWORK_ID_TESTNET4, gameId: fromHex(GID), startTimeMs: 5n, stakeMsat: 100000n, protocolVersion: 16, creatorPubkey: ORDER[0], censusRoot: new Uint8Array(32) }];
  const t = dayTemplate({ held, family: new Set([GID]), networkId: NETWORK_ID_TESTNET4, game: 'rps' });
  assert.equal(t.from, 'held'); assert.equal(t.contract.protocolVersion, 16); assert.equal(t.contract.creatorPubkey, undefined); assert.equal(t.contract.censusRoot, undefined);
  const b = dayTemplate({ held: [], family: new Set(), networkId: NETWORK_ID_TESTNET4, game: 'rps', ownRelay: 'https://n.example' });
  assert.equal(b.from, 'built-in'); assert.equal(b.contract.blockTicks, 600); assert.deepEqual(b.contract.publicationRelays, ['https://n.example']);
  assert.equal(DUTY_TEMPLATE.stakeMsat, 100000n);
  void catalogOf;
});

test('the node\'s poster: off says so on GET /duty and runs nothing; auto on an Electrum chain says why it cannot pay', async () => {
  const { createDutyPoster } = await import('../src/duty-poster.js');
  const base = { walletCall: () => async () => { throw new Error('no wallet'); }, networkIdHex: () => toHex(NETWORK_ID_TESTNET4),
    censusEntriesAt: async () => [], dutyCensus: async () => ({ ok: false, why: 'none' }), chainBlocks: async () => ({ blocks: [] }),
    dir: mkdtempSync(join(tmpdir(), 'duty-')), nodeSecret: new Uint8Array(32).fill(7), log: () => {}, fetchFn: async () => ({ ok: false, status: 404 }) };
  const seat = { port: 1, host: '127.0.0.1', endpoint: null, heldTemplates: () => [], nameFunded: () => {}, donationSetAt: () => new Uint8Array(32), nodeKey: KEYS[0] };
  const off = createDutyPoster({ ...base, call: async () => { throw new Error('not asked'); }, env: { ARENA_DUTY_POST: 'off' } });
  off.attach(seat);
  await off.pass();
  const s1 = off.status();
  assert.equal(s1.setting, 'off'); assert.equal(s1.on, false); assert.equal(s1.days.length, 2);
  assert.deepEqual(s1.days.map((d) => d.period), ['today', 'next']);
  off.stop();
  const electrum = createDutyPoster({ ...base, call: async (m) => { if (m === 'listwallets') throw new Error('listwallets is not served in Electrum mode'); throw new Error('no'); }, env: {} });
  electrum.attach(seat);
  await electrum.pass();
  const s2 = electrum.status();
  assert.equal(s2.setting, 'auto'); assert.equal(s2.on, false); assert.equal(s2.wallet.canPay, false);
  assert.match(s2.wallet.why, /Electrum/);
  assert.equal(s2.node, toHex(KEYS[0]));
  electrum.stop();
});

// kanban #791: the chain index is made once per chain view and shared by every day duty; a view grown in place is indexed anew
test('one chain view, two day duties: both see the posted marker; a block appended to the same view in place is indexed again', async () => {
  const marked = txOf([dutyMarkerOutput(DAY, 'nextblock-day'), seriesPublicationOutput(new Uint8Array(32).fill(9))]);
  const base = world({ creatorOf: RANK0, local: [ORDER[0]], nowMs: T0 + 70 * MIN });
  const shared = { blocks: base.blocks, firstHeight: base.firstHeight };       // one object, as the duty poster's chainView hands out
  const a = world({ creatorOf: RANK0, local: [ORDER[0]], nowMs: T0 + 70 * MIN, view: async () => shared });
  const st0 = await createDayDuty(a.opts).look();
  assert.equal(a.did.published.length, 1, 'no marker yet: the duty node posts');
  assert.equal(st0.markers.filter((m) => m.slot === DAY && m.txid === marked.txid).length, 0);
  // the marker arrives in a new block, appended to the same view object
  shared.blocks.push({ header: header(Math.floor((T0 + 71 * MIN) / 1000), shared.blocks.length), transactions: [marked.raw], t: T0 + 71 * MIN });
  const b = world({ creatorOf: RANK0, local: [ORDER[0]], nowMs: T0 + 72 * MIN, view: async () => shared });
  const c = world({ creatorOf: RANK0, local: [ORDER[1]], nowMs: T0 + 72 * MIN, view: async () => shared });
  const sb = await createDayDuty(b.opts).look(), sc = await createDayDuty(c.opts).look();
  for (const [s, who] of [[sb, 'rank 0'], [sc, 'rank 1']]) {
    assert.equal(s.posted, true, `${who} sees the day posted`);
    assert.deepEqual(s.markers.filter((m) => m.slot === DAY && m.txid === marked.txid)[0].series, ['09'.repeat(32)], `${who} reads its series`);
  }
  assert.equal(b.did.published.length + c.did.published.length, 0, 'and neither posts again');
});

test('dayTemplate: named relays replace a held template\'s and the built-in one (kanban #808)', () => {
  const r = dayTemplate({ held: [], family: new Set(), networkId: new Uint8Array(32), game: 'rps', ownRelay: 'http://own', relays: ['https://a/1', 'https://a/2'] });
  assert.deepEqual([r.from, r.contract.publicationRelays], ['built-in', ['https://a/1', 'https://a/2']]);
  assert.deepEqual(dayTemplate({ held: [], family: new Set(), networkId: new Uint8Array(32), game: 'rps', ownRelay: 'http://own', relays: [] }).contract.publicationRelays, ['http://own']);
});


// ---------------------------------------------------------------- kanban #1126: a fee raise re-announced, a dropped publication sent again
/** A transaction spending `parent` (display txid) with `outputs`: its hex and txid. */
function spendOf(parent, outputs = [{ value: 1000, script: Uint8Array.from([0x51]) }]) {
  const hex = serializeUnsigned([{ txid: parent, vout: 0 }], outputs.map(outBytes), null);
  return { hex, raw: fromHex(hex), txid: toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()) };
}

test('kanban #1126: a fee raise is announced again with its new txid, to the seats the first announcement reached, until every seat took it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'duty-'));
  const pub = txOf([dutyMarkerOutput(DAY, 'nextblock-day')]);
  const bumped = spendOf('77'.repeat(32), [dutyMarkerOutput(DAY, 'nextblock-day')]);
  let nowMs = T0 + 10 * H;
  const w = world({ local: [ORDER[0]], nowMs, dir, mempool: [pub], wallet: { [pub.txid]: 0, [bumped.txid]: 0 }, hexes: { [bumped.txid]: bumped.hex } });
  w.opts.walletRpc = ((inner) => async (m, p) => (m === 'bumpfee' ? (w.did.bumped.push(p[0]), { txid: bumped.txid }) : inner(m, p)))(w.opts.walletRpc);
  w.opts.now = () => nowMs;
  const said = []; w.opts.say = (o) => said.push(o);
  const announced = []; let takes = [3, 4];
  w.opts.announce = async (a) => { announced.push(a); return { took: takes.shift(), of: 4 }; };
  keptPosting(dir, { slot: DAY, txid: pub.txid, committeeMs: dayStartMs(DAY + 1) - 12 * H, firstStartMs: dayStartMs(DAY + 1), announcedTxid: pub.txid, announcedTo: ['http://s1', 'http://s2'] });
  const d = createDayDuty(w.opts);
  await d.look();
  assert.deepEqual(w.did.bumped, [pub.txid]);
  assert.equal(announced.length, 1, 'the new txid announced in the pass that raised the fee');
  assert.deepEqual([announced[0].tx, announced[0].lines, announced[0].targets], [bumped.hex, ['line'], ['http://s1', 'http://s2']]);
  const line = said.find((o) => o.dutyDay === 're-announced');
  assert.deepEqual([line.txid, line.replaced, line.seats], [bumped.txid.slice(0, 16), [pub.txid.slice(0, 16)], '3/4']);
  // one seat did not take it: not asked again within 10 min, asked again after - then all took it and it is not asked again
  nowMs += 5 * MIN; await d.look(); assert.equal(announced.length, 1);
  nowMs += 6 * MIN; await d.look(); assert.equal(announced.length, 2);
  nowMs += 11 * MIN; await d.look(); assert.equal(announced.length, 2);
  const kept = JSON.parse(readFileSync(join(dir, `nextblock-day-${DAY}.json`), 'utf8'));
  assert.deepEqual([kept.txid, kept.announcedTxid, kept.replaced, kept.announce.took], [bumped.txid, bumped.txid, [pub.txid], 4]);
});

test('kanban #1126: a publication in no block and no mempool is sent again, parents first, to our bitcoind and to the public chain, once per 10 min', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'duty-'));
  const parent = spendOf('66'.repeat(32));                               // the unconfirmed funding it spends
  const pub = spendOf(parent.txid, [dutyMarkerOutput(DAY, 'nextblock-day')]);
  let nowMs = T0 + 2 * H;
  const w = world({ local: [ORDER[0]], nowMs, dir, mempool: [], wallet: { [pub.txid]: 0, [parent.txid]: 0, ['66'.repeat(32)]: 3 },
    hexes: { [pub.txid]: pub.hex, [parent.txid]: parent.hex, ['66'.repeat(32)]: '00' } });
  w.opts.now = () => nowMs;
  const said = []; w.opts.say = (o) => said.push(o);
  const pub2 = [];
  w.opts.publicSend = async (hex) => { pub2.push(hex); return hex === parent.hex ? { ok: false, status: 400, text: 'sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}', base: 'https://mempool.space/testnet4/api' }
    : { ok: true, status: 200, text: pub.txid, base: 'https://mempool.space/testnet4/api' }; };
  keptPosting(dir, { slot: DAY, txid: pub.txid, committeeMs: dayStartMs(DAY + 1) - 12 * H, firstStartMs: dayStartMs(DAY + 1) });
  const d = createDayDuty(w.opts);
  await d.look(); await d.settled();
  assert.deepEqual(w.did.sent, [parent.txid, pub.txid], 'parents first, the confirmed grandparent not sent');
  assert.deepEqual(pub2, [parent.hex, pub.hex]);
  const local = said.find((o) => o.dutyDay === 'rebroadcast'), web = said.find((o) => o.dutyDay === 'sent to the public chain');
  assert.deepEqual(local.answers.map((a) => a.ok), [true, true]);
  assert.deepEqual(web.answers.map((a) => [a.ok, a.status]), [[false, 400], [true, 200]]);
  assert.match(web.answers[0].answer, /already in block chain/);
  // in the mempool now: within 10 min nothing is sent; after it, only the public chain is asked (our bitcoind holds it)
  nowMs += 5 * MIN; await d.look(); await d.settled();
  assert.equal(w.did.sent.length, 2); assert.equal(pub2.length, 2);
  nowMs += 6 * MIN; await d.look(); await d.settled();
  assert.equal(w.did.sent.length, 2); assert.equal(pub2.length, 4);
  // a dead posting (conflicted) is never sent
  const dir2 = mkdtempSync(join(tmpdir(), 'duty-'));
  const w2 = world({ local: [ORDER[0]], nowMs: T0 + 2 * H, dir: dir2, wallet: { [pub.txid]: -1 }, hexes: { [pub.txid]: pub.hex } });
  const sent2 = []; w2.opts.publicSend = async (h) => { sent2.push(h); return { ok: true, status: 200, text: '' }; };
  keptPosting(dir2, { slot: DAY, txid: pub.txid, committeeMs: dayStartMs(DAY + 1) - 12 * H, firstStartMs: dayStartMs(DAY + 1) });
  const d2 = createDayDuty(w2.opts); await d2.look(); await d2.settled();
  assert.deepEqual([w2.did.sent.filter((x) => x === pub.txid), sent2], [[], []]);
});

test('kanban #1126: the Esplora sender tries mempool.space, then blockstream.info, and benches a base that does not answer', async () => {
  const asked = [];
  let t = 0;
  const send = esploraSender({ bases: ['https://a/api', 'https://b/api'], now: () => t, fetchFn: async (url, o) => {
    asked.push(url);
    if (url.startsWith('https://a')) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    assert.equal(o.method, 'POST'); return { ok: true, status: 200, text: async () => 'ab'.repeat(32) };
  } });
  const r = await send('0200');
  assert.deepEqual([r.ok, r.status, r.base], [true, 200, 'https://b/api']);
  await send('0200');
  assert.deepEqual(asked, ['https://a/api/tx', 'https://b/api/tx', 'https://b/api/tx'], 'a benched base is asked last');
});
