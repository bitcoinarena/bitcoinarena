// BADGES ON NOSTR (kanban #362, PLATFORM-RESEARCH item 13): a seat signs NIP-58 events - one Badge Definition (kind 30009) per
// catalogue badge, a Badge Award (kind 8: an `a` tag 30009:<seat>:<d>, a `p` tag the player's x-only identity key) per badge
// earned - each id NIP-01's hash and each signature BIP-340 by the seat's key. An award is issued once, across a restart; a
// round counts once its settlement is ACCEPTED, read as the season reads it; nothing goes to a bare round key; and a real
// node serves the events at /badges and /badge-definitions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { buildDefinitionEvent, buildAwardEvent, nostrBadges, isNostrKey, badgesOn, imageBaseOf, badgeImage,
  BADGE_DEFINITION_KIND, BADGE_AWARD_KIND, BADGES_AT_S, BOARD_GRACE_MS, BOARD_NETWORK_GRACE_MS, BOARD_RETRY_MS,
  BOARD_RETRY_FOR_MS } from '../src/nostr-badges.js';
import { startRelay, eventRefusal, RELAY_KINDS } from '../src/nostr-relay.js';
import { BADGES, PERFECT_RUN_SCORE, WEEK_MS } from '../../arena-protocol/src/badges.js';

const SECRET = new Uint8Array(32).fill(7);
const PUB = Buffer.from(schnorr.getPublicKey(SECRET)).toString('hex');
const h = (c) => c.repeat(64);
const keyOf = (n) => Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(n))).toString('hex');
const ALICE = keyOf(0x21), BOB = keyOf(0x22), CAROL = keyOf(0x23);
const GAME = h('a');
const idOf = (e) => createHash('sha256').update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])).digest('hex');
const verifies = (e) => schnorr.verify(Buffer.from(e.sig, 'hex'), Buffer.from(e.id, 'hex'), Buffer.from(e.pubkey, 'hex'));

test('the definition (kind 30009) and the award (kind 8): tags exactly as NIP-58 names them, the id NIP-01\'s hash, signed by the seat', () => {
  const def = buildDefinitionEvent({ badge: BADGES[0], secret: SECRET, imageBase: 'https://tn4.bitcoin-arena.io/guardian-1/' });
  assert.equal(def.kind, BADGE_DEFINITION_KIND);
  assert.equal(def.kind, 30009);
  assert.equal(def.pubkey, PUB);
  assert.equal(def.created_at, BADGES_AT_S, 'dated by the catalogue, not the start: the same bytes on every start');
  assert.deepEqual(def.tags.slice(0, 4), [['d', 'arena-first-win'], ['name', 'First win'], ['description', BADGES[0].description],
    ['image', 'https://tn4.bitcoin-arena.io/guardian-1/badge-image/arena-first-win.svg']]);
  assert.equal(def.tags[4][0], 'alt');
  assert.equal(def.content, '');
  assert.equal(def.id, idOf(def));
  assert.ok(verifies(def));
  assert.equal(eventRefusal(def), null, 'our relay\'s own check passes it');
  assert.equal(JSON.stringify(buildDefinitionEvent({ badge: BADGES[0], secret: SECRET, imageBase: 'https://tn4.bitcoin-arena.io/guardian-1' })),
    JSON.stringify(def), 'deterministic');
  // NO PUBLIC BASE: no image tag (NIP-58: MAY), never a URL nobody can open
  const bare = buildDefinitionEvent({ badge: BADGES[0], secret: SECRET });
  assert.deepEqual(bare.tags.map((t) => t[0]), ['d', 'name', 'description', 'alt']);
  assert.equal(imageBaseOf('http://plain'), null);

  const award = { d: 'arena-first-win', player: ALICE, game: 'nextblock', scope: 'nextblock', evidence: { rounds: [h('1')] } };
  const a = buildAwardEvent({ award, secret: SECRET, atMs: 1760500000999 });
  assert.equal(a.kind, BADGE_AWARD_KIND);
  assert.equal(a.kind, 8);
  assert.equal(a.created_at, 1760500000);
  assert.deepEqual(a.tags.slice(0, 2), [['a', `30009:${PUB}:arena-first-win`], ['p', ALICE]], 'one a naming the definition, the p the player');
  assert.deepEqual(a.tags.find((t) => t[0] === 'evidence'), ['evidence', h('1')]);
  assert.deepEqual(a.tags.find((t) => t[0] === 't'), ['t', 'nextblock']);
  assert.equal(a.id, idOf(a));
  assert.ok(verifies(a));
  assert.equal(eventRefusal(a), null);
  // the a tag names the definition this seat signed: kind, the definition's pubkey and its d
  assert.equal(a.tags[0][1], `${def.kind}:${def.pubkey}:${def.tags[0][1]}`);
  // a board award names its week and rank, the seats its board was merged from and how many had to agree on a round
  const top = buildAwardEvent({ award: { d: 'arena-season-top-3', player: BOB, game: 'nextblock', scope: 'nextblock@2026-10-05',
    evidence: { window: { fromMs: Date.UTC(2026, 9, 5), toMs: Date.UTC(2026, 9, 12) }, rank: 2, seats: 5, agree: 3 } }, secret: SECRET, atMs: 1760500000000 });
  assert.deepEqual(top.tags.slice(0, 6), [['a', `30009:${PUB}:arena-season-top-3`], ['p', BOB],
    ['window', '2026-10-05T00:00:00.000Z', '2026-10-12T00:00:00.000Z'], ['rank', '2'], ['seats', '5'], ['agree', '3']]);
  assert.equal(eventRefusal(top), null);
  // THE PLAYER IS A NOSTR KEY: 32 bytes x-only, on the curve
  assert.ok(isNostrKey(ALICE));
  for (const no of [h('f'), h('0'), ALICE.slice(2), ALICE.toUpperCase()]) {
    assert.equal(isNostrKey(no), false, no);
    assert.throws(() => buildAwardEvent({ award: { ...award, player: no }, secret: SECRET, atMs: 1 }), /Nostr key/);
  }
  assert.equal(badgesOn(undefined), false, 'off by default');
  assert.equal(badgesOn('1'), true);
  assert.match(badgeImage(BADGES[3]), /^<svg [^>]*>.*Leaderboard top 3<\/text><\/svg>$/);
  assert.ok(!/script|href/i.test(BADGES.map(badgeImage).join('')));
});

test('our relay keeps kinds 30009 and 8: a definition newest per seat and d, the awards found by #p', async () => {
  assert.ok(RELAY_KINDS.includes(30009) && RELAY_KINDS.includes(8));
  const r = await startRelay({ port: 0 });
  const ws = new WebSocket(`ws://127.0.0.1:${r.port}`);
  await new Promise((x) => ws.on('open', x));
  const inbox = [];
  ws.on('message', (m) => inbox.push(JSON.parse(String(m))));
  const next = async (pred) => { for (const t = Date.now(); Date.now() - t < 2000; await new Promise((x) => setTimeout(x, 10))) { const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0]; } return null; };
  try {
    const def = buildDefinitionEvent({ badge: BADGES[0], secret: SECRET });
    const newer = buildDefinitionEvent({ badge: BADGES[0], secret: SECRET, imageBase: 'https://x.example', createdAt: BADGES_AT_S + 1 });
    const a1 = buildAwardEvent({ award: { d: 'arena-first-win', player: ALICE, game: 'g', scope: 'g', evidence: { rounds: [h('1')] } }, secret: SECRET, atMs: 1760500000000 });
    const a2 = buildAwardEvent({ award: { d: 'arena-five-rounds', player: ALICE, game: 'g', scope: 'g', evidence: { rounds: [h('1')] } }, secret: SECRET, atMs: 1760500001000 });
    for (const e of [def, newer, a1, a2]) { ws.send(JSON.stringify(['EVENT', e])); assert.equal((await next((m) => m[0] === 'OK' && m[1] === e.id))[2], true, e.kind); }
    ws.send(JSON.stringify(['REQ', 'p', { kinds: [8], '#p': [ALICE] }]));
    await next((m) => m[0] === 'EOSE' && m[1] === 'p');
    assert.deepEqual(r.events().filter((e) => e.kind === 8).map((e) => e.id).sort(), [a1.id, a2.id].sort(), 'awards are regular events: each kept');
    assert.deepEqual(r.events().filter((e) => e.kind === 30009).map((e) => e.id), [newer.id], 'one definition per seat and d: the newer');
    const info = await (await fetch(`http://127.0.0.1:${r.port}/`, { headers: { accept: 'application/nostr+json' } })).json();
    assert.ok(info.supported_nips.includes(58));
  } finally { ws.close(); await r.close(); }
});

// a relay that counts what it is sent and answers OK
async function fakeRelay() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.on('listening', r));
  const f = { got: [], url: `ws://127.0.0.1:${wss.address().port}`, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }) };
  wss.on('connection', (ws) => ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m[0] !== 'EVENT') return;
    f.got.push(m[1]);
    ws.send(JSON.stringify(['OK', m[1].id, true, '']));
  }));
  return f;
}

// the two settlement tables as the round store has them; a round ACCEPTED in them
function settlementsDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE lock_settlements (round_id BLOB PRIMARY KEY, txid TEXT, message BLOB, signature BLOB, state TEXT, why TEXT, made_ms INTEGER);
    CREATE TABLE fed_lock_settlements (round_id BLOB, federation_id TEXT, txid TEXT, message BLOB, signature BLOB, state TEXT, why TEXT, made_ms INTEGER, PRIMARY KEY (round_id, federation_id));`);
  return db;
}
const accept = (db, rid, atMs, state = 'ACCEPTED') => db.prepare('INSERT OR REPLACE INTO lock_settlements VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(Buffer.from(rid, 'hex'), h('9'), Buffer.alloc(1), Buffer.alloc(64), state, '', atMs);

test('the book: a round counts once ACCEPTED; each award is issued once, across a restart; a round key gets nothing; published once', async () => {
  let now = Date.UTC(2026, 9, 1, 12);            // in the past: an award is dated when it is made, and a relay refuses the future
  const db = settlementsDb();
  // FIVE STAKED ROUNDS of one game: ALICE (an identity) wins each with a perfect run; BOB loses under a bare round key
  const S = 100000n;
  const rounds = new Map();
  const rid = (n) => n.toString(16).padStart(2, '0').repeat(32);
  for (let n = 1; n <= 6; n++) rounds.set(rid(n), { roundId: rid(n), gameId: GAME, startMs: BigInt(now - (10 - n) * 3600000), entries: [
    { player: ALICE, roundKey: keyOf(0x60 + n), name: 'alice', stakeMsat: S, payoutMsat: 2n * S, outcome: 'DELIVERED', score: PERFECT_RUN_SCORE },
    { player: BOB, roundKey: BOB, name: null, stakeMsat: S, payoutMsat: 0n, outcome: 'FAILED', score: 1 }] });
  const read = [];
  const roundOf = (r) => { read.push(r); return rounds.has(r) ? { ok: true, game: { name: 'nextblock', id: GAME }, round: rounds.get(r) } : { ok: false, status: 404 }; };
  const relay = await fakeRelay();
  const make = (more = {}) => nostrBadges({ db, secret: SECRET, on: true, relays: [relay.url], roundOf, timeoutMs: 500, now: () => now, log: () => {},
    games: () => [{ name: 'nextblock', ids: [GAME] }], ...more });
  let book = make();
  try {
    // ROUNDS 1-4 ACCEPTED, round 5 still SUBMITTING, a round of a game this seat does not host ACCEPTED
    for (let n = 1; n <= 4; n++) accept(db, rid(n), now - 1000 + n);
    accept(db, rid(5), now, 'SUBMITTING');
    accept(db, h('e'), now);
    let t = await book.tick();
    assert.equal(t.awarded, 2, 'first win and perfect run: four rounds are not five');
    assert.deepEqual(book.awardsOf(ALICE).map((a) => [a.d, a.evidence.rounds]), [['arena-first-win', [rid(1)]], ['arena-perfect-run', [rid(1)]]]);
    assert.deepEqual(book.awardsOf(BOB), [], 'a bare round key earns nothing');
    assert.ok(!read.includes(rid(5)), 'a round is read once its settlement is ACCEPTED, not before');
    assert.equal(t.sent, 6, 'the four definitions, then the two awards');
    assert.deepEqual(relay.got.slice(0, 4).map((e) => e.kind), [30009, 30009, 30009, 30009]);
    assert.ok(book.definitions().every((d) => d.publishedMs !== null));
    // ROUND 5 ACCEPTED: five rounds played - the first five as evidence
    accept(db, rid(5), now + 1);
    now += 60000;
    t = await book.tick();
    assert.equal(t.awarded, 1);
    assert.deepEqual(book.awardsOf(ALICE).find((a) => a.d === 'arena-five-rounds').evidence, { rounds: [1, 2, 3, 4, 5].map(rid) });
    const before = JSON.stringify(book.awardsOf(ALICE));
    // A RESTART: a new book on the same db - the definitions are the same bytes, nothing is re-awarded or re-sent; round 6 earns no new badge
    book.stop();
    const sent = relay.got.length;
    accept(db, rid(6), now + 2);
    now += 60000;
    book = make();
    read.length = 0;
    t = await book.tick();
    assert.equal(t.awarded, 0, 'each (badge, player, game) once');
    assert.equal(t.sent, 0, 'the definitions were published before the restart: their ids are kept');
    assert.deepEqual(read, [rid(6)], 'only the new round is read: the ledger holds the rest');
    assert.equal(JSON.stringify(book.awardsOf(ALICE)), before, 'the same award events, byte for byte');
    assert.equal(relay.got.length, sent);
    const ids = relay.got.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'every event sent once');
    for (const e of relay.got) assert.equal(eventRefusal(e), null);
    for (const a of relay.got.filter((e) => e.kind === 8)) assert.deepEqual(a.tags[1], ['p', ALICE]);
  } finally { book.stop(); await relay.close(); }
});

// THE WEEKLY BOARD FROM THE NETWORK (kanban #362): a closed week's rounds as several seats hand them in, each entry with its
// round key - in season-read.js's shape, the week before MON
const MON = Date.UTC(2026, 9, 12);
const DUE = MON + BOARD_GRACE_MS + BOARD_NETWORK_GRACE_MS;
const S = 100000n;
const wr = (n, entries) => ({ roundId: n.toString(16).padStart(2, '0').repeat(32), gameId: GAME, startMs: BigInt(MON - WEEK_MS + n * 3600000), entries });
const en = (player, n, payout, roundKey = keyOf(0x70 + n)) => ({ player, roundKey, name: null, stakeMsat: S, payoutMsat: payout, outcome: 'DELIVERED', score: n });
const DAVE = keyOf(0x24), ERIN = keyOf(0x25);
// ALICE, BOB and CAROL's two rounds of the week, which every honest seat holds
const WEEK = [wr(1, [en(ALICE, 1, 3n * S), en(BOB, 2, 0n), en(CAROL, 3, 0n)]), wr(2, [en(BOB, 4, 2n * S), en(CAROL, 5, 0n)])];
const seatsOf = (...accounts) => ({ bySeat: new Map(accounts.map((rounds, i) => [`seat-${i}`, rounds])), asked: 13 });
const boardBook = (accountsOf, more = {}) => nostrBadges({ db: settlementsDb(), secret: SECRET, on: true, roundOf: () => ({ ok: false }),
  log: () => {}, games: () => [{ name: 'nextblock', ids: [GAME] }], accountsOf, ...more });
const podium = (book) => [ALICE, BOB, CAROL, DAVE, ERIN].map((p) => book.awardsOf(p).map((a) => [a.scope, a.evidence.rank]));

test('the board badge: the network\'s week, read once BOARD_GRACE_MS + BOARD_NETWORK_GRACE_MS after it closed; off, nothing', async () => {
  let now = MON + 3600000;                       // an hour into the new week: the last week is not read yet
  const asked = [];
  const accountsOf = async (g, w) => { asked.push([g.name, w.fromMs, w.toMs]); return seatsOf(WEEK, WEEK, WEEK); };
  const book = boardBook(accountsOf, { now: () => now });
  const off = nostrBadges({ db: settlementsDb(), secret: SECRET, on: false, roundOf: () => { throw new Error('read'); }, now: () => now, log: () => {},
    games: () => [{ name: 'nextblock', ids: [GAME] }], accountsOf: () => { throw new Error('read'); } });
  try {
    assert.equal((await book.tick()).awarded, 0);
    assert.deepEqual(asked, [['nextblock', MON - 2 * WEEK_MS, MON - WEEK_MS]], 'within the grace, the week before is the last one read');
    asked.length = 0;
    now = MON + BOARD_GRACE_MS;                  // the rounds have settled, but not every seat need hold them yet
    await book.tick();
    assert.deepEqual(asked, []);
    now = DUE;
    const t = await book.tick();
    assert.deepEqual(asked, [['nextblock', MON - WEEK_MS, MON]]);
    assert.equal(t.awarded, 3);
    assert.deepEqual(podium(book), [[['nextblock@2026-10-05', 1]], [['nextblock@2026-10-05', 2]], [['nextblock@2026-10-05', 3]], [], []]);
    assert.deepEqual(book.awardsOf(ALICE)[0].evidence, { window: { fromMs: MON - WEEK_MS, toMs: MON }, rank: 1, seats: 3, agree: 3 });
    assert.deepEqual(book.awardsOf(ALICE)[0].event.tags.slice(2, 6), [['window', '2026-10-05T00:00:00.000Z', '2026-10-12T00:00:00.000Z'],
      ['rank', '1'], ['seats', '3'], ['agree', '3']]);
    assert.deepEqual(await off.tick(), { awarded: 0, sent: 0 });
    assert.deepEqual(off.awardsOf(ALICE), []);
    off.start();                                 // off: no clock either
  } finally { book.stop(); off.stop(); }
});

test('the board badge counts a round only when 3 seats hand in the same account of it, round keys included', async () => {
  // DAVE's huge win only seat 0 holds, and ERIN's only seats 0 and 1: no podium place for either. Seat 3 hands in round 1
  // with BOB under his own round key - one seat cannot strike BOB's place by naming him a bare key. Round 3, in which ERIN
  // beats BOB, is held by three seats: it counts. And seat 4 hands in rounds of the week after, asked for days back from its
  // clock: not this week's.
  const solo = wr(3, [en(DAVE, 9, 100n * S), en(ALICE, 1, 0n)]);
  const pair = wr(4, [en(ERIN, 9, 50n * S), en(CAROL, 1, 0n)]);
  const three = wr(5, [en(ERIN, 6, 4n * S), en(BOB, 1, 0n)]);
  const bare = { ...WEEK[0], entries: WEEK[0].entries.map((e) => (e.player === BOB ? { ...e, roundKey: BOB } : e)) };
  const later = { ...wr(6, [en(DAVE, 9, 100n * S), en(ERIN, 1, 0n)]), startMs: BigInt(MON + 3600000) };
  const accounts = seatsOf([...WEEK, solo, pair, three], [...WEEK, pair, three], [three, ...WEEK], [bare, WEEK[1]], [later, later]);
  const book = boardBook(async () => accounts, { now: () => DUE });
  const lines = [];
  const loud = boardBook(async () => accounts, { now: () => DUE, log: (l) => lines.push(l) });
  try {
    assert.equal((await book.tick()).awarded, 3);
    // THE AGREED ROUNDS 1, 2 AND 5, as season() ranks them: ERIN +3S net, ALICE +2S, BOB -1S (-1S, +1S, -1S), CAROL -2S
    const ranks = podium(book).map((x) => (x.length ? x[0][1] : null));
    assert.deepEqual(ranks, [2, 3, null, null, 1], 'ALICE 2, BOB 3, CAROL 4th (no badge), DAVE none, ERIN 1');
    assert.equal(ranks[3], null, 'DAVE: a round one seat hands in is no round');
    assert.equal(ranks[4], 1, 'ERIN: a round three seats agree on counts');
    assert.equal(ranks[1], 3, 'BOB keeps his place over one seat naming him a bare round key');
    await loud.tick();
    assert.ok(lines.some((l) => /week of 2026-10-05: 3 agreed rounds from 5 seats/.test(l)), lines.join('\n'));
  } finally { book.stop(); loud.stop(); }
});

test('the board badge: too few seats answer - no award, asked again every 30 min, given up after two days', async () => {
  let now = DUE;
  let answering = 1, calls = 0;
  const lines = [];
  const accountsOf = async () => { calls++; return seatsOf(...Array.from({ length: answering }, () => WEEK)); };
  const book = boardBook(accountsOf, { now: () => now, log: (l) => lines.push(l) });
  try {
    assert.equal((await book.tick()).awarded, 0);
    assert.equal(calls, 1);
    assert.match(lines.at(-1), /week of 2026-10-05: not awarded yet, asked again in 30 min - 1 seat answered \(this one included, 13 asked\), and a round counts only when 3 agree/);
    answering = 2;
    now += BOARD_RETRY_MS - 1;
    await book.tick();
    assert.equal(calls, 1, 'not before the half hour');
    now += 1;
    assert.equal((await book.tick()).awarded, 0);
    assert.equal(calls, 2);
    assert.deepEqual(podium(book), [[], [], [], [], []]);
    // A SEAT THAT CANNOT ASK AT ALL is the same wait
    const failing = boardBook(async () => { throw new Error('no census'); }, { now: () => now, log: (l) => lines.push(l) });
    await failing.tick();
    assert.match(lines.at(-1), /not awarded yet.*the seats could not be asked: no census/);
    failing.stop();
    // THREE SEATS: awarded, and the week is never asked again
    answering = 3;
    now += BOARD_RETRY_MS;
    assert.equal((await book.tick()).awarded, 3);
    assert.equal(calls, 3);
    now += BOARD_RETRY_MS;
    await book.tick();
    assert.equal(calls, 3);
    // TWO DAYS OF TOO FEW: given up, said, and asked no more
    let given = 0;
    const late = [];
    const lone = boardBook(async () => { given++; return seatsOf(WEEK); }, { now: () => now, log: (l) => late.push(l) });
    now = DUE + BOARD_RETRY_FOR_MS - 1;
    await lone.tick();
    assert.match(late.at(-1), /not awarded yet/);
    now = DUE + BOARD_RETRY_FOR_MS + BOARD_RETRY_MS;
    await lone.tick();
    assert.match(late.at(-1), /week of 2026-10-05: given up, no board badge for it - 1 seat answered/);
    now += BOARD_RETRY_MS;
    await lone.tick();
    assert.equal(given, 2);
    assert.deepEqual(podium(lone), [[], [], [], [], []]);
    lone.stop();
  } finally { book.stop(); }
});

test('the board badge: two seats handed the same agreed rounds award the same podium, whatever order the seats answered in', async () => {
  const other = new Uint8Array(32).fill(9);
  const shuffled = (rounds) => [...rounds].reverse().map((r) => ({ ...r, entries: [...r.entries].reverse() }));
  const a = boardBook(async () => seatsOf(WEEK, WEEK, WEEK, [WEEK[1]]), { now: () => DUE });
  const b = boardBook(async () => ({ bySeat: new Map([['x', shuffled(WEEK)], ['y', [WEEK[1]]], ['z', WEEK], ['w', shuffled(WEEK)]]), asked: 4 }),
    { now: () => DUE + 3 * 3600000, secret: other });
  try {
    assert.equal((await a.tick()).awarded, 3);
    assert.equal((await b.tick()).awarded, 3);
    const of = (book) => [ALICE, BOB, CAROL].map((p) => book.awardsOf(p).map((x) => [x.d, x.scope, x.evidence]));
    assert.deepEqual(of(a), of(b), 'the same badge, week, rank and seat count on both');
    assert.notEqual(a.issuer, b.issuer, 'each signed by its own seat');
  } finally { a.stop(); b.stop(); }
});

test('the board badge: a week is fetched once - across ticks and across a restart', async () => {
  let now = DUE;
  let calls = 0;
  const db = settlementsDb();
  const accountsOf = async () => { calls++; return seatsOf(WEEK, WEEK, WEEK); };
  const make = () => nostrBadges({ db, secret: SECRET, on: true, roundOf: () => ({ ok: false }), log: () => {}, now: () => now,
    games: () => [{ name: 'nextblock', ids: [GAME] }, { name: 'rps', ids: [h('b')] }], accountsOf });
  let book = make();
  try {
    // TWO TICKS AT ONCE: the second finds the first still asking, and asks nothing
    const [x, y] = await Promise.all([book.tick(), book.tick()]);
    assert.deepEqual([x.awarded, y.awarded], [3, 0]);
    assert.equal(calls, 2, 'one read per game: nextblock, and rps (whose board is empty: no award, but read)');
    for (let i = 0; i < 5; i++) { now += 3600000; await book.tick(); }
    assert.equal(calls, 2);
    book.stop();
    book = make();
    await book.tick();
    assert.equal(calls, 2, 'the weeks read are kept in nostr_badge_weeks');
    // THE NEXT WEEK, once it has closed: read once more per game
    now = DUE + WEEK_MS;
    await book.tick();
    assert.equal(calls, 4);
  } finally { book.stop(); }
});

// A REAL NODE with badges on: a staked round its settlement holds ACCEPTED, read as the season reads it; the identity its winner's
// lobby record names gets the first-win badge, served at /badges with its definition; the loser's bare round key gets nothing.
test('a real node: /badges and /badge-definitions serve the events it signed; /badge-image the SVG', async () => {
  const { serve } = await import('../src/server.js');
  const { openStore } = await import('../src/store.js');
  const { runId } = await import('../src/verdict.js');
  const { contractFor, b32, opts } = await import('./window-fixture.js');
  const { encodeRoundContract, encodeEntryContract, roundId, entryId } = await import('../../arena-protocol/src/contracts.js');
  const { encodePlayerResult, joinSignedResult, resultId } = await import('../../arena-protocol/src/result.js');
  const { encodeLobbyName } = await import('../../arena-protocol/src/lobby-name.js');
  const { toHex } = await import('../../arena-protocol/src/hash.js');
  const { HOSTED, NEXTBLOCK_GAME_ID } = await import('./plugins/hosted.js');
  const SECRETS = [b32(0x31), b32(0x32)];
  const SEATS = SECRETS.map((s) => schnorr.getPublicKey(s));
  const IDENTITY = schnorr.getPublicKey(b32(0xe1));
  const [P1, P2] = [b32(0x51), b32(0x52)];
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts, nostrBadgesOn: true, nostrBadgesTickMs: 100,
    badgeImageBase: 'https://seat.example/a' });
  try {
    // ONE STAKED ROUND as a seat holds it (season-door.test.js's writeRound, trimmed): P1 under IDENTITY delivers and is paid
    const round = d.round, db = round.db;
    const contract = { ...contractFor(SEATS, 3000n, ['wss://r.example']), gameId: NEXTBLOCK_GAME_ID, stakeMsat: 100000n, startTimeMs: BigInt(Date.now() - 3600000), censusHeight: 900001 };
    const rid = roundId(contract);
    db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(rid, encodeRoundContract(contract), 1);
    round.recordSignerNodes(rid, SEATS);
    [[P1, 'DELIVERED', 500, IDENTITY], [P2, 'FAILED', 200, null]].forEach(([key, outcome, score, identity], i) => {
      const e = { roundId: rid, playerPubkey: key, sessionPubkey: b32(0x60 + i), stakeCommitment: b32(0x70 + i), stakeMsat: 100000n, feeMsat: 2000n,
        donationMsat: 2000n, joinTick: 0, worldSecret: b32(0), vssSharesRef: b32(0x80 + i), stakePoint: Uint8Array.from([2, ...b32(0x90 + i)]),
        feePreimage: b32(0), stakeLockOutpoint: { txid: b32(0xa0 + i), outIdx: 0n }, feeLockOutpoint: { txid: b32(0), outIdx: 0n }, claimKeyAttestationRef: b32(0) };
      const eid = entryId(e);
      db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, ?)').run(eid, rid, encodeEntryContract(e), 1 + i);
      let run = null;
      for (let s = 0; s < 2; s++) {
        const r = { roundId: rid, playerPubkey: key, outcome, score, transcriptHash: b32(0xb0 + i), simCoreHash: contract.simCoreHash, nodePubkey: SEATS[s] };
        run = runId(r);
        db.prepare('INSERT INTO results (round_id, entry_id, node_pubkey, result_id, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)')
          .run(rid, eid, SEATS[s], resultId(r), joinSignedResult(encodePlayerResult(r), schnorr.sign(resultId(r), SECRETS[s])), 2);
      }
      for (let s = 0; s < 2; s++) db.prepare('INSERT INTO final_sigs (round_id, entry_id, run_id, signer_pubkey, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)').run(rid, eid, run, SEATS[s], new Uint8Array(1), 3);
      round.putStakeLock({ entryId: eid, roundId: rid, outpoint: { txid: b32(0xa0 + i), outIdx: 0 }, fields: { amountMsat: '96000' }, contractId: 'c' });
      if (identity) round.putLobbyName({ roundId: rid, playerPubkey: key, signature: new Uint8Array(64), atMs: 5,
        record: encodeLobbyName({ roundId: rid, playerPubkey: key, identityPubkey: identity, name: 'alice', atMs: 5 }) });
    });
    const ask = (q) => fetch(`http://127.0.0.1:${d.port}${q}`);
    const me = toHex(IDENTITY);
    assert.deepEqual((await (await ask(`/badges?player=${me}`)).json()).awards, [], 'nothing before the settlement is ACCEPTED');
    round.putLockSettlement({ roundId: rid, txid: 'ab'.repeat(32), message: b32(1), signature: new Uint8Array(64), state: 'ACCEPTED', why: '' });
    round.putLockSettlementMoves({ roundId: rid, txid: 'ab'.repeat(32), claims: [`${toHex(b32(0xa1))}:0`], payouts: 1 });
    round.putLockSettlementShares(rid, [{ pubkey: P1, msat: 90000n }]);
    let j;
    for (let i = 0; i < 100; i++) { j = await (await ask(`/badges?player=${me}`)).json(); if (j.awards.length) break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(j.node, toHex(round.pubkey));
    assert.equal(j.on, true);
    assert.deepEqual(j.awards.map((a) => [a.d, a.game, a.scope, a.evidence]), [['arena-first-win', 'nextblock', 'nextblock', { rounds: [toHex(rid)] }]]);
    const ev = j.awards[0].event;
    assert.equal(eventRefusal(ev), null);
    assert.deepEqual(ev.tags.slice(0, 2), [['a', `30009:${toHex(round.pubkey)}:arena-first-win`], ['p', me]]);
    assert.equal(j.definitions.length, 1);
    assert.equal(j.definitions[0].event.tags[0][1], 'arena-first-win');
    assert.equal(eventRefusal(j.definitions[0].event), null);
    // the loser's round key, and the winner's round key, hold no badge
    for (const k of [P1, P2]) assert.deepEqual((await (await ask(`/badges?player=${toHex(k)}`)).json()).awards, []);
    assert.equal((await ask('/badges?player=zz')).status, 400);
    assert.equal((await ask('/badges')).status, 400);
    const defs = await ask('/badge-definitions');
    assert.equal(defs.status, 200);
    assert.equal(defs.headers.get('access-control-allow-origin'), '*');
    const dj = await defs.json();
    assert.deepEqual(dj.definitions.map((x) => x.event.tags[0][1]), BADGES.map((b) => b.d));
    assert.ok(dj.definitions.every((x) => x.event.kind === 30009 && x.event.pubkey === toHex(round.pubkey) && eventRefusal(x.event) === null));
    assert.deepEqual(dj.definitions[0].event.tags[3], ['image', 'https://seat.example/a/badge-image/arena-first-win.svg']);
    const img = await ask('/badge-image/arena-first-win.svg');
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/svg+xml');
    assert.match(await img.text(), /^<svg /);
    assert.equal((await ask('/badge-image/nope.svg')).status, 404);
  } finally { await d.close(); }
});

test('a real node with badges off (the default): no awards, the definitions still served', async () => {
  const { serve } = await import('../src/server.js');
  const { openStore } = await import('../src/store.js');
  const { opts } = await import('./window-fixture.js');
  const { HOSTED } = await import('./plugins/hosted.js');
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts, nostrBadgesOn: false });
  try {
    const j = await (await fetch(`http://127.0.0.1:${d.port}/badges?player=${ALICE}`)).json();
    assert.deepEqual([j.on, j.awards], [false, []]);
    const dj = await (await fetch(`http://127.0.0.1:${d.port}/badge-definitions`)).json();
    assert.equal(dj.on, false);
    assert.equal(dj.definitions.length, BADGES.length);
    assert.ok(dj.definitions.every((x) => x.publishedMs === null));
  } finally { await d.close(); }
});
