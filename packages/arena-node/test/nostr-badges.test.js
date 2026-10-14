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
  BADGE_DEFINITION_KIND, BADGE_AWARD_KIND, BADGES_AT_S } from '../src/nostr-badges.js';
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
  // a board award names its week and rank
  const top = buildAwardEvent({ award: { d: 'arena-season-top-3', player: BOB, game: 'nextblock', scope: 'nextblock@2026-10-05',
    evidence: { window: { fromMs: Date.UTC(2026, 9, 5), toMs: Date.UTC(2026, 9, 12) }, rank: 2 } }, secret: SECRET, atMs: 1760500000000 });
  assert.deepEqual(top.tags.slice(0, 4), [['a', `30009:${PUB}:arena-season-top-3`], ['p', BOB],
    ['window', '2026-10-05T00:00:00.000Z', '2026-10-12T00:00:00.000Z'], ['rank', '2']]);
  // THE PLAYER IS A NOSTR KEY: 32 bytes x-only, on the curve
  assert.ok(isNostrKey(ALICE));
  for (const no of [h('f'), h('0'), ALICE.slice(2), ALICE.toUpperCase()]) {
    assert.equal(isNostrKey(no), false, no);
    assert.throws(() => buildAwardEvent({ award: { ...award, player: no }, secret: SECRET, atMs: 1 }), /Nostr key/);
  }
  assert.equal(badgesOn(undefined), false, 'off by default');
  assert.equal(badgesOn('1'), true);
  assert.match(badgeImage(BADGES[3]), /^<svg [^>]*>.*Season top 3<\/text><\/svg>$/);
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
    games: () => [{ name: 'nextblock', ids: [GAME] }], seasonOf: () => [], ...more });
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

test('the board badge: read once per closed week, two hours after it closed; off, the book awards nothing', async () => {
  const MON = Date.UTC(2026, 9, 12);
  let now = MON + 3600000;                       // an hour into the new week: the last week is not read yet
  const db = settlementsDb();
  const S = 100000n;
  const r = (n, entries) => ({ roundId: n.toString(16).padStart(2, '0').repeat(32), gameId: GAME, startMs: BigInt(MON - WEEK_MS + n * 3600000), entries });
  const en = (player, n, payout) => ({ player, roundKey: keyOf(0x70 + n), name: null, stakeMsat: S, payoutMsat: payout, outcome: 'DELIVERED', score: n });
  const week = [r(1, [en(ALICE, 1, 3n * S), en(BOB, 2, 0n), en(CAROL, 3, 0n)]), r(2, [en(BOB, 4, 2n * S), en(CAROL, 5, 0n)])];
  const asked = [];
  const seasonOf = (g, w) => { asked.push([g.name, w.fromMs]); return week; };
  const book = nostrBadges({ db, secret: SECRET, on: true, roundOf: () => ({ ok: false }), now: () => now, log: () => {},
    games: () => [{ name: 'nextblock', ids: [GAME] }], seasonOf });
  const off = nostrBadges({ db: settlementsDb(), secret: SECRET, on: false, roundOf: () => { throw new Error('read'); }, now: () => now, log: () => {},
    games: () => [{ name: 'nextblock', ids: [GAME] }], seasonOf: () => { throw new Error('read'); } });
  try {
    assert.equal((await book.tick()).awarded, 0);
    assert.deepEqual(asked, [['nextblock', MON - 2 * WEEK_MS]], 'within the grace, the week before is the last one read');
    asked.length = 0;
    now = MON + 2 * 3600000;
    const t = await book.tick();
    assert.deepEqual(asked, [['nextblock', MON - WEEK_MS]]);
    assert.equal(t.awarded, 3);
    assert.deepEqual([ALICE, BOB, CAROL].map((p) => book.awardsOf(p).map((a) => [a.scope, a.evidence.rank])),
      [[['nextblock@2026-10-05', 1]], [['nextblock@2026-10-05', 2]], [['nextblock@2026-10-05', 3]]]);
    await book.tick();
    assert.equal(asked.length, 1, 'a week is read once');
    assert.deepEqual(await off.tick(), { awarded: 0, sent: 0 });
    assert.deepEqual(off.awardsOf(ALICE), []);
    off.start();                                 // off: no clock either
  } finally { book.stop(); off.stop(); }
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
