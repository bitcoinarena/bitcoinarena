// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A DAY MARKER COUNTS ONLY FROM A DUTY POSTER, AND A FEE RAISE IS WRITTEN BEFORE AND AFTER IT GOES OUT (kanban #1168, the state machine
// audit of 2026-11-06, high). The day's duty engine (src/duty-day.js) on a fake chain, as duty-poster.test.js builds it:
//   A. FIVE NEAR-FREE TRANSACTIONS SUPPRESS A DAY: a bare "ARN" 'D' marker of tomorrow's day in the mempool (and one with a made-up series
//      output). Before the fix the duty node read "posted" and posted nothing - nor did any node after it.
//   B. THE BACKUP THE SAME: a bare "ARN" 'B' marker, and the backup's rank 2 posted nothing.
//   C. FOREIGN EMERGENCY MARKERS: today's posting dead, and three bare emergency markers of today in the mempool. Before the fix they counted
//      as three emergency grids on their way (cap reached, one in flight): no emergency grid, the day without rounds.
//   D. THE REAL POSTINGS STILL COUNT: one whose series line a seat holds, by a node of the day's duty order (a seat's own duty poster); one by
//      the runner's creator key, which is no census node, counted when the operator names it (ARENA_DUTY_CREATORS / the runner's own key).
//   E. A CRASH AFTER bumpfee: the posting file as it stood when the next network call went out. Before the fix it still named the old txid
//      (and no raise): a restart judged the replaced publication conflicted - dead - and posted the day again. And a crash inside bumpfee:
//      the restart finds the new txid from the wallet's replaced_by_txid.
// The facts are printed first (MEASURED), then checked - so the same file run on the old source prints what it did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { seriesPublicationOutput } from '../../arena-protocol/src/series.js';
import { dutyOrder, dutyMarkerOutput, backupMarkerOutput, dayStartMs, itemTag } from '../../arena-protocol/src/duty.js';
import { serializeUnsigned } from '../src/fund-at-rate.js';
import { createDayDuty } from '../src/duty-day.js';

const H = 3600000, MIN = 60000;
const DAY = 20753;
const T0 = dayStartMs(DAY);
const KEYS = [1, 2, 3, 4, 5].map((n) => new Uint8Array(32).fill(n));
const ORDER = dutyOrder({ networkId: NETWORK_ID_TESTNET4, slot: DAY, nodeKeys: KEYS });
const ORDER_Y = dutyOrder({ networkId: NETWORK_ID_TESTNET4, slot: DAY - 1, nodeKeys: KEYS });
const GID = 'c4'.repeat(32), DEV = 'ab'.repeat(32), FED = '33'.repeat(32);
const RUNNER = '43'.repeat(32);   // a runner's creator key: no node of the census

const outBytes = (o) => Buffer.concat([(() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(o.value || 0)); return b; })(), Buffer.from([o.script.length]), Buffer.from(o.script)]);
let nonce = 0;
function txOf(outputs) {
  const hex = serializeUnsigned([{ txid: (++nonce).toString(16).padStart(64, '0'), vout: 0 }], outputs.map(outBytes), null);
  const raw = fromHex(hex);
  return { raw, hex, txid: toHex(Uint8Array.from(parseTransaction(raw).txid).reverse()) };
}
const header = (timeS, n) => { const h = new Uint8Array(80); h[0] = n & 0xff; h[1] = (n >> 8) & 0xff; new DataView(h.buffer).setUint32(68, timeS, true); return h; };
const sid = (n) => new Uint8Array(32).fill(n);

/** The fake chain and node of duty-poster.test.js, with `lines` the series ids (hex) a seat holds -> their creator (hex). */
function world({ nowMs = T0 + 10 * MIN, local = [ORDER[0]], inBlocks = [], mempool = [], wallet = {}, hexes = {}, seatRounds = null, role = 'primary', dir = null,
  lines = {}, creators = [], infos = null } = {}) {
  const firstHeight = 1000, blocks = [];
  for (let t = T0 - 40 * H, i = 0; t <= nowMs; t += 10 * MIN, i++) blocks.push({ header: header(Math.floor(t / 1000), i), transactions: [], t });
  for (const { atMs, raw } of inBlocks) blocks.find((x) => x.t >= atMs).transactions.push(raw);
  const tip = firstHeight + blocks.length - 1;
  const pool = new Map(mempool.map((x) => [x.txid, x.raw]));
  const did = { published: [], bumped: [] };
  const opts = {
    game: 'nextblock', item: 'nextblock-day', role, postedPrimary: async () => false, networkId: NETWORK_ID_TESTNET4, local: new Set(local.map(toHex)), dir: dir || mkdtempSync(join(tmpdir(), 'duty1168-')),
    chain: { view: async () => ({ blocks, firstHeight }), censusKeysAt: async () => KEYS, seatUrls: async () => ['http://s1'] },
    chainCall: async (m, p) => {
      if (m === 'getrawmempool') return [...pool.keys()];
      if (m === 'getrawtransaction') { if (!pool.has(p[0])) throw new Error('gone'); return toHex(pool.get(p[0])); }
      if (m === 'getblockhash') return `hash-${p[0]}`;
      if (m === 'getblockcount') return tip;
      if (m === 'sendrawtransaction') return 'x';
      throw new Error(`no ${m}`);
    },
    walletRpc: async (m, p) => {
      if (m === 'gettransaction') { const w = wallet[p[0]]; if (w === undefined) throw new Error('not the wallet\'s'); return { ...(typeof w === 'object' ? w : { confirmations: w }), ...(hexes[p[0]] ? { hex: hexes[p[0]] } : {}) }; }
      if (m === 'bumpfee') { did.bumped.push(p[0]); return { txid: 'b'.repeat(64) }; }
      throw new Error(`no ${m}`);
    },
    gridBase: async (g, slot, o2 = {}) => ({ ok: true, fields: { gameId: fromHex(GID) }, periodMs: 90000, version: 24, id: GID, censusHeight: tip - (o2.depth || 6), censusHash: `hash-${tip - (o2.depth || 6)}`, donationSetId: new Uint8Array(32) }),
    openGrid: async (kind, o2) => {
      const s = o2.extraOutputs[0].script;
      const m = { kind: String.fromCharCode(s[5]), slot: new DataView(s.buffer, s.byteOffset).getUint32(6, false), tag: toHex(s.subarray(10, 14)) };
      did.published.push({ marker: m });
      return { ok: true, txid: (did.published.length + 1).toString(16).padStart(64, 'e'), series: ['ab'.repeat(32)], lines: ['line'], rounds: o2.slots };
    },
    postSeries: async () => ({ took: 1, of: 1, refused: [] }), fedsNow: async () => [FED],
    seatCatalog: async () => new Map([[GID, { id: GID, name: 'nextblock', version: 24, dev: DEV }]]), devOf: { nextblock: DEV },
    fetchFn: async (url) => ({ ok: true, json: async () => (seatRounds ? seatRounds(url) : { rounds: [0, 1, 2].map((i) => ({ game: { id: GID },
      startTime: new Date(Math.max(T0, nowMs) + 10 * MIN + i * 90000).toISOString(), committee: { drawn: { game: ['k'], settlement: ['k'] } } })) }) }),
    canPay: async () => ({ ok: true }), now: () => nowMs, say: () => {},
    creatorOf: async (id) => lines[id] || null, creators,
    ...(infos ? { seriesInfoOf: async (id) => infos[id] || null } : {}),
  };
  return { opts, did };
}
const tagOf = (item) => toHex(itemTag(item));
const keptPosting = (dir, k) => writeFileSync(join(dir, `nextblock-day-${k.slot}.json`), JSON.stringify({ item: 'nextblock-day', target: new Date(dayStartMs(k.slot + 1)).toISOString(),
  series: ['ab'.repeat(32)], lines: ['line'], posted: [{ took: 1, of: 1 }], emergency: false, gameId: GID, version: 24, ...k }) + '\n');

test('kanban #1168: a day marker counts only from a duty poster, and a fee raise is on disk before and after bumpfee', async () => {
  const facts = {};
  // A. BARE MARKERS OF TOMORROW'S DAY
  const bare = txOf([dutyMarkerOutput(DAY, 'nextblock-day')]);
  const madeUp = txOf([dutyMarkerOutput(DAY, 'nextblock-day'), seriesPublicationOutput(sid(0x99))]);
  const a = world({ local: [ORDER[0]], mempool: [bare, madeUp] });
  const sa = await createDayDuty(a.opts).look();
  // and an hour later the next node in order
  const a2 = world({ local: [ORDER[1]], nowMs: T0 + 70 * MIN, mempool: [bare, madeUp] });
  await createDayDuty(a2.opts).look();
  facts.A = { rank1Published: a.did.published.length, posted: sa.posted, rank2Published: a2.did.published.length, ignored: (sa.ignored || []).map((m) => m.standing) };

  // B. A BARE BACKUP MARKER
  const bareB = txOf([backupMarkerOutput(DAY, 'nextblock-day')]);
  const b = world({ local: [ORDER[1]], nowMs: T0 + 3 * H, role: 'backup', mempool: [bareB] });
  await createDayDuty(b.opts).look();
  facts.B = { backupPublished: b.did.published.length };

  // C. TODAY'S POSTING DEAD (conflicted) AND THREE BARE EMERGENCY MARKERS OF TODAY
  const dirC = mkdtempSync(join(tmpdir(), 'duty1168-'));
  const ems = [1, 2, 3].map(() => txOf([dutyMarkerOutput(DAY - 1, 'nextblock-day-emergency')]));
  const c = world({ local: [ORDER[0]], nowMs: T0 + 30 * MIN, dir: dirC, mempool: ems, wallet: { ['c1'.repeat(32)]: -1 }, seatRounds: () => ({ rounds: [] }) });
  keptPosting(dirC, { slot: DAY - 1, txid: 'c1'.repeat(32), committeeMs: T0 - 12 * H, firstStartMs: T0, postedAtMs: T0 - 10 * H });
  // tomorrow posted by this node already, so the only thing a pass could post is today's emergency grid
  keptPosting(dirC, { slot: DAY, txid: 'd1'.repeat(32), committeeMs: dayStartMs(DAY + 1) - 12 * H, firstStartMs: dayStartMs(DAY + 1) });
  c.opts.walletRpc = ((inner) => async (m, p) => (m === 'gettransaction' && p[0] === 'd1'.repeat(32) ? { confirmations: 0 } : inner(m, p)))(c.opts.walletRpc);
  const sc = await createDayDuty(c.opts).look();
  facts.C = { emergencyPublished: c.did.published.filter((p) => p.marker.slot === DAY - 1 && p.marker.tag === tagOf('nextblock-day-emergency')).length,
    today: sc.days[new Date(T0).toISOString().slice(0, 10)] ? sc.days[new Date(T0).toISOString().slice(0, 10)].emergency : null };

  // D. REAL POSTINGS: a duty-order node's, held as a line; the runner's, named by the operator
  const real = txOf([dutyMarkerOutput(DAY, 'nextblock-day'), seriesPublicationOutput(sid(0x51))]);
  // (the day's duty node: rank 0, due at 00:00 - kanban #1219 counts a duty poster only from its own hour)
  const d1 = world({ local: [ORDER[0]], mempool: [real], lines: { [toHex(sid(0x51))]: toHex(ORDER[0]) } });
  const sd1 = await createDayDuty(d1.opts).look();
  const byRunner = txOf([dutyMarkerOutput(DAY, 'nextblock-day'), seriesPublicationOutput(sid(0x52))]);
  const d2 = world({ local: [ORDER[0]], mempool: [byRunner], lines: { [toHex(sid(0x52))]: RUNNER } });
  await createDayDuty(d2.opts).look();
  const d3 = world({ local: [ORDER[0]], mempool: [byRunner], lines: { [toHex(sid(0x52))]: RUNNER }, creators: [RUNNER] });
  const sd3 = await createDayDuty(d3.opts).look();
  facts.D = { dutyNodePosting: { published: d1.did.published.length, standing: (sd1.markers || []).map((m) => m.standing) },
    runnerUnnamed: { published: d2.did.published.length }, runnerNamed: { published: d3.did.published.length, standing: (sd3.markers || []).map((m) => m.standing) } };

  // E. A CRASH AFTER bumpfee, and one inside it
  const crash = async (at) => {
    const dir = mkdtempSync(join(tmpdir(), 'duty1168-'));
    const pub = txOf([dutyMarkerOutput(DAY, 'nextblock-day')]);
    const raised = txOf([dutyMarkerOutput(DAY, 'nextblock-day')]);
    const w = world({ local: [ORDER[0]], nowMs: T0 + 10 * H, dir, mempool: [pub], wallet: { [pub.txid]: 0, [raised.txid]: 0 }, hexes: { [raised.txid]: raised.hex } });
    keptPosting(dir, { slot: DAY, txid: pub.txid, committeeMs: dayStartMs(DAY + 1) - 12 * H, firstStartMs: dayStartMs(DAY + 1), announcedTxid: pub.txid, announcedTo: ['http://s1'] });
    const file = join(dir, `nextblock-day-${DAY}.json`);
    let onDisk = null;
    w.opts.walletRpc = ((inner) => async (m, p) => {
      if (m !== 'bumpfee') return inner(m, p);
      w.did.bumped.push(p[0]);
      if (at === 'inside') onDisk = readFileSync(file, 'utf8');
      return { txid: raised.txid };
    })(w.opts.walletRpc);
    // the first network call after the raise: the re-announce of the new txid
    w.opts.announce = async () => { if (at === 'after' && onDisk === null) onDisk = readFileSync(file, 'utf8'); return { took: 1, of: 1 }; };
    await createDayDuty(w.opts).look();
    const k = JSON.parse(onDisk);
    // THE RESTART from that file: the old publication replaced (the wallet: conflicted, replaced by the raise), the raise in the mempool
    const dir2 = mkdtempSync(join(tmpdir(), 'duty1168-'));
    writeFileSync(join(dir2, `nextblock-day-${DAY}.json`), onDisk);
    const r = world({ local: [ORDER[0]], nowMs: T0 + 10 * H + 2 * MIN, dir: dir2, mempool: [raised],
      wallet: { [pub.txid]: { confirmations: -1, replaced_by_txid: raised.txid }, [raised.txid]: 0 }, hexes: { [raised.txid]: raised.hex } });
    r.opts.announce = async () => ({ took: 1, of: 1 });
    await createDayDuty(r.opts).look();
    const after = JSON.parse(readFileSync(join(dir2, `nextblock-day-${DAY}.json`), 'utf8'));
    return { fileAtCrash: { txidIsRaise: k.txid === raised.txid, bumped: !!k.bumped, bump: k.bump ? k.bump.state : null },
      restart: { postedAgain: r.did.published.length, bumpedAgain: r.did.bumped.length, txidIsRaise: after.txid === raised.txid, verdict: after.verdict && after.verdict.state } };
  };
  facts.E = { afterBumpfee: await crash('after'), insideBumpfee: await crash('inside') };
  console.log('  MEASURED #1168:', JSON.stringify(facts, null, 1));

  // A: the bare and the made-up markers count for nothing: the duty node posts the day
  assert.equal(facts.A.rank1Published, 1, 'a bare day marker held the duty node back');
  assert.equal(facts.A.posted, false);
  assert.deepEqual(facts.A.ignored.sort(), ['UNREAD', 'UNREAD']);
  // B: the bare backup marker counts for nothing: rank 2 posts the backup
  assert.equal(facts.B.backupPublished, 1, 'a bare backup marker held the backup back');
  // C: foreign bare emergency markers count for nothing: the emergency grid of today is posted
  assert.equal(facts.C.emergencyPublished, 1, `bare emergency markers held the emergency grid back: ${JSON.stringify(facts.C.today)}`);
  // D: a duty node's posting and a named runner's count (nothing posted again); an unnamed runner's does not
  assert.deepEqual(facts.D.dutyNodePosting, { published: 0, standing: ['DUTY'] });
  assert.equal(facts.D.runnerUnnamed.published, 1);
  assert.deepEqual(facts.D.runnerNamed, { published: 0, standing: ['TRUSTED'] });
  // E: the raise is on disk before the next network call; a crash inside bumpfee is found from the wallet; no day posted again
  assert.deepEqual(facts.E.afterBumpfee.fileAtCrash, { txidIsRaise: true, bumped: true, bump: 'DONE' });
  assert.deepEqual(facts.E.afterBumpfee.restart, { postedAgain: 0, bumpedAgain: 0, txidIsRaise: true, verdict: 'pending' });
  assert.deepEqual(facts.E.insideBumpfee.fileAtCrash, { txidIsRaise: false, bumped: false, bump: 'ASKED' });
  assert.deepEqual(facts.E.insideBumpfee.restart, { postedAgain: 0, bumpedAgain: 0, txidIsRaise: true, verdict: 'pending' });
});

// KANBAN #1204 FED-C1 (audit 2): the #1168 fix took ANY series id a seat holds - so one cheap tx with tomorrow's marker beside a copy of a
// REAL held id (yesterday's posting, or another app's) counted as the day's posting at every seat: no primary, no rounds the next day.
// Now a marker speaks only for a series of its own app whose first round closes inside the marker's target day.
test('#1204 FED-C1: a day marker beside a copied real series id (yesterday\'s, another app\'s) counts for nothing; the day\'s own posting still does', async () => {
  const TOMORROW = dayStartMs(DAY + 1), TODAY = T0;
  const yesterday = toHex(sid(0x61)), otherApp = toHex(sid(0x62)), own = toHex(sid(0x63));
  const infos = {
    [yesterday]: { creator: toHex(ORDER[0]), gameId: GID, firstCloseMs: TODAY + 60000 },          // the posting of the day before: plays today
    [otherApp]: { creator: toHex(ORDER[0]), gameId: 'd5'.repeat(32), firstCloseMs: TOMORROW + 60000 },   // tomorrow, but another app
    [own]: { creator: toHex(ORDER[0]), gameId: GID, firstCloseMs: TOMORROW + 60000 },               // tomorrow's own posting
  };
  const lines = Object.fromEntries(Object.entries(infos).map(([k, v]) => [k, v.creator]));
  const copiedY = txOf([dutyMarkerOutput(DAY, 'nextblock-day'), seriesPublicationOutput(sid(0x61))]);
  const copiedO = txOf([dutyMarkerOutput(DAY, 'nextblock-day'), seriesPublicationOutput(sid(0x62))]);
  const f1 = world({ local: [ORDER[0]], mempool: [copiedY, copiedO], lines, infos });
  const s1 = await createDayDuty(f1.opts).look();
  const real = txOf([dutyMarkerOutput(DAY, 'nextblock-day'), seriesPublicationOutput(sid(0x63))]);
  const f2 = world({ local: [ORDER[0]], mempool: [real], lines, infos });
  const s2 = await createDayDuty(f2.opts).look();
  // the same copy, a second time and at another node of the order: still nothing
  const f3 = world({ local: [ORDER[1]], nowMs: T0 + 70 * MIN, mempool: [copiedY, copiedO], lines, infos });
  await createDayDuty(f3.opts).look();
  console.log('  MEASURED FED-C1:', JSON.stringify({ copied: { published: f1.did.published.length, posted: s1.posted, ignored: (s1.ignored || []).map((m) => m.standing) },
    real: { published: f2.did.published.length, standing: (s2.markers || []).map((m) => m.standing) }, rank2: f3.did.published.length }));
  assert.equal(f1.did.published.length, 1, 'a copied held id held the duty node back');
  assert.equal(s1.posted, false);
  assert.equal(f2.did.published.length, 0, 'the day\'s own posting is still seen');
  assert.deepEqual((s2.markers || []).map((m) => m.standing), ['DUTY']);
  assert.equal(f3.did.published.length, 1, 'rank 2 posts too when nothing real is there');
});

// KANBAN #1219 (audit 3 #1210 FIXES-12): every census node is in the duty order, so a node far down it posting its OWN valid grid of the
// day at 00:00Z (or announcing it at /expected), before the nodes whose hour it is, read as the day posted at every node. A duty poster's
// marker counts only from its creator's own hour (dayDueFromMs), as this node first saw it.
test('#1219 a duty marker of a low rank seen before its hour counts for nothing; the same rank in its hour, and rank 0 at once, count', async () => {
  const TOMORROW = dayStartMs(DAY + 1);
  const g = toHex(sid(0x71));
  const infosOf = (creator) => ({ [g]: { creator: toHex(creator), gameId: GID, firstCloseMs: TOMORROW + 60000 } });
  const tx = txOf([dutyMarkerOutput(DAY, 'nextblock-day'), seriesPublicationOutput(sid(0x71))]);
  const look = async (creator, nowMs, local = ORDER[0]) => { const w = world({ local: [local], nowMs, mempool: [tx], lines: { [g]: toHex(creator) }, infos: infosOf(creator) });
    const st = await createDayDuty(w.opts).look(); return { published: w.did.published.length, standing: [...(st.markers || []), ...(st.ignored || [])].map((m) => m.standing) }; };
  const early = await look(ORDER[4], T0 + 5 * MIN);                 // rank 4 at 00:05: its hour is 02:00 + 2 steps
  const rank0 = await look(ORDER[0], T0 + 5 * MIN, ORDER[1]);        // the day's duty node at 00:05, seen by rank 1
  const inHour = await look(ORDER[4], T0 + 2 * H + 10 * MIN);        // rank 4 in its own step of the cap's hour (02:06)
  console.log('  MEASURED #1219:', JSON.stringify({ early, rank0, inHour }));
  assert.equal(early.published, 1, 'a rank-4 marker at 00:05 held the duty node back');
  assert.deepEqual(early.standing, ['FOREIGN']);
  assert.deepEqual(rank0.standing, ['DUTY'], 'the duty node\'s own posting counts at once');
  assert.deepEqual(inHour.standing, ['DUTY'], 'a lower rank in its own hour counts');
  assert.equal(inHour.published, 0);
});
