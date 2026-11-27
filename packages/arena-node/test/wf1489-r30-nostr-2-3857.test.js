// kanban #1489 r30-nostr-2 (attacker audit, find-only): THE ROUND BADGES RE-READ A GAME'S WHOLE HISTORY ON EVERY SETTLED ROUND.
// nostr-badges.js awardRounds: each tick, for every game a newly ACCEPTED round touched, q.ledger.all(name) reads EVERY ledger row of that
// game ever kept (nostr_badge_rounds is never pruned; lookbackMs bounds only which new rounds are picked up), JSON.parses each one and runs
// badgesEarned -> season() over all of them - synchronously, on the seat's one event loop, inside the tick. The header says "a game's history is
// read once, never on every settlement"; in fact it is read whole on every tick that settles one round of the game. Rounds and entries are made
// by play (free rounds, entries under fresh keys), so the cost grows with the game's life and any stranger who enters many rounds grows it.
// Safe behaviour: settling ONE new round costs the badge book a bounded amount of work, not a pass over every round the game ever had.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { nostrBadges } from '../src/nostr-badges.js';
import { seasonRoundsToJson } from '../../arena-protocol/src/season.js';

const SECRET = new Uint8Array(32).fill(7);
const keyOf = (n) => Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(n))).toString('hex');
const GAME = 'a'.repeat(64);

function settlementsDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE lock_settlements (round_id BLOB PRIMARY KEY, txid TEXT, message BLOB, signature BLOB, state TEXT, why TEXT, made_ms INTEGER);
    CREATE TABLE fed_lock_settlements (round_id BLOB, federation_id TEXT, txid TEXT, message BLOB, signature BLOB, state TEXT, why TEXT, made_ms INTEGER, PRIMARY KEY (round_id, federation_id));`);
  return db;
}

test('settling one round does not make the badge book re-read every round the game ever had', async () => {
  const now = Date.UTC(2026, 9, 20, 12);
  const db = settlementsDb();
  const players = Array.from({ length: 8 }, (_, i) => keyOf(0x30 + i));
  const roundAt = (n) => ({ roundId: n.toString(16).padStart(64, '0'), gameId: GAME, startMs: BigInt(now - 80 * 86400000 + n * 1000), entries:
    players.map((p, i) => ({ player: p, roundKey: keyOf(0x90 + ((n + i) % 100)), name: null, stakeMsat: 1000n, payoutMsat: i === 0 ? 8000n : 0n, outcome: 'DELIVERED', score: 10 + i })) });
  const fresh = roundAt(999999);
  const roundOf = (rid) => (rid === fresh.roundId ? { ok: true, game: { name: 'nextblock', id: GAME }, round: fresh } : { ok: false, status: 404 });
  const book = nostrBadges({ db, secret: SECRET, on: true, roundOf, now: () => now, log: () => {}, apps: () => [] });
  // THE GAME'S HISTORY: 20,000 earlier rounds already in the ledger (about 140 days of a round every 10 minutes, or fewer days of busy play)
  const put = db.prepare('INSERT INTO nostr_badge_rounds (round_id, game, round, made_ms) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let n = 1; n <= 20000; n++) { const r = roundAt(n); const [j] = seasonRoundsToJson([r]); put.run(r.roundId, 'nextblock', JSON.stringify(j), now - 1000); }
  db.exec('COMMIT');
  // ONE NEW ROUND IS ACCEPTED
  db.prepare('INSERT INTO lock_settlements VALUES (?, ?, ?, ?, ?, ?, ?)').run(Buffer.from(fresh.roundId, 'hex'), '9'.repeat(64), Buffer.alloc(1), Buffer.alloc(64), 'ACCEPTED', '', now);
  const t0 = performance.now();
  await book.tick();
  const ms = performance.now() - t0;
  // the event loop is held for the whole of this (no await inside awardRounds)
  assert.ok(ms < 250, `one settled round held the seat's event loop ${ms.toFixed(0)} ms (a pass over all 20,000 rounds of the game)`);
});

// kanban #3857: the marks hand badgesEarned only the new round's players' earliest marked rounds - the awards must be the ones a
// read of the whole ledger names, evidence included, and a ledger kept before the marks is marked at the start
test('marked rounds award what the whole ledger awards, with the same evidence (#3857)', async () => {
  const { badgesEarned, BADGES } = await import('../../arena-protocol/src/badges.js');
  const { seasonRoundsFromJson } = await import('../../arena-protocol/src/season.js');
  const now = Date.UTC(2026, 9, 20, 12);
  const db = settlementsDb();
  const ps = Array.from({ length: 6 }, (_, i) => keyOf(0x30 + i));
  const roundAt = (n, who, winner, score) => ({ roundId: n.toString(16).padStart(64, '0'), gameId: GAME, startMs: BigInt(now - 10 * 86400000 + (n % 7) * 1000 + Math.floor(n / 7) * 60000), entries:
    who.map((p, i) => ({ player: p, roundKey: keyOf(0x90 + ((n * 3 + i) % 100)), name: null, stakeMsat: n % 5 === 0 ? 0n : 1000n,
      payoutMsat: i === winner ? 2000n * BigInt(who.length) : 0n, outcome: 'DELIVERED', score })) });
  const rows = [];
  for (let n = 1; n <= 40; n++) rows.push(roundAt(n, [ps[n % 6], ps[(n + 1) % 6], ps[(n + 3) % 6]], n % 4 === 1 ? 0 : 7, n % 9 === 0 ? 100000000 : 10 + n));
  const fresh = roundAt(1001, [ps[0], ps[2], ps[4]], 1, 100000001);   // 1001: a staked round (every fifth is free)
  // the history kept before the book had marks: the tables made by a first book, the rows written, then a book started over them
  nostrBadges({ db, secret: SECRET, on: true, roundOf: () => ({ ok: false }), now: () => now, log: () => {}, apps: () => [] });
  const put = db.prepare('INSERT INTO nostr_badge_rounds (round_id, game, round, made_ms) VALUES (?, ?, ?, ?)');
  for (const r of rows) { const [j] = seasonRoundsToJson([r]); j.entries = j.entries.map((e, i) => ({ ...e, roundKey: r.entries[i].roundKey })); put.run(r.roundId, 'nextblock', JSON.stringify(j), now - 1000); }
  const roundOf = (rid) => (rid === fresh.roundId ? { ok: true, game: { name: 'nextblock', id: GAME }, round: fresh } : { ok: false, status: 404 });
  const book = nostrBadges({ db, secret: SECRET, on: true, roundOf, now: () => now, log: () => {}, apps: () => [] });
  db.prepare('INSERT INTO lock_settlements VALUES (?, ?, ?, ?, ?, ?, ?)').run(Buffer.from(fresh.roundId, 'hex'), '9'.repeat(64), Buffer.alloc(1), Buffer.alloc(64), 'ACCEPTED', '', now);
  await book.tick();
  const got = db.prepare('SELECT d, player, evidence FROM nostr_badges ORDER BY d, player').all().map((r) => `${r.d} ${r.player} ${r.evidence}`);
  const all = [...rows, fresh];
  const want = badgesEarned({ game: { name: 'nextblock', ids: [GAME] }, rounds: all }, BADGES.filter((b) => b.rule !== 'season-top')).awards
    .filter((a) => fresh.entries.some((e) => e.player === a.player))
    .map((a) => `${a.d} ${a.player} ${JSON.stringify(a.evidence)}`).sort();
  assert.ok(want.length >= 4, `the case awards something (${want.length})`);
  assert.deepEqual(got.sort(), want);
  void seasonRoundsFromJson;
});
