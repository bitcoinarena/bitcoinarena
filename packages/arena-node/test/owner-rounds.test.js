// The owner area's Rounds (kanban #715): the rounds a node is drawn for with what it does in each, and - when there is none - the first
// reason that holds, in plain words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { roundsForOwner, dutyOf, auditForOwner } from '../src/owner-rounds.js';

const NOW = 1_800_000_000_000;
const row = (o) => ({ round: 'aa', game: { name: 'btc-updown-15m', title: 'Bitcoin Up or Down', version: 24 }, startMs: NOW - 3600000, endMs: NOW - 3000000,
  phase: 'done', gameSeated: false, settleSeated: false, drawn: false, hostedHere: true, ...o });
const own = { roles: ['game', 'verify', 'settlement', 'relay'], serving: true, bondSats: '50000' };

test('drawn: each round with what the node does there, in the Roles words', () => {
  const r = roundsForOwner({ rows: [row({ gameSeated: true, settleSeated: true }), row({ drawn: true }), row({})], own, nowMs: NOW });
  assert.equal(r.why, null);
  assert.deepEqual(r.rounds.map((x) => x.does), [['Play and check', 'Pay out winners'], ['Reserve (drawn, not seated)']]);
  assert.deepEqual(dutyOf({ settleSeated: true }), ['Pay out winners']);
});

test('none: the first reason that holds, in order', () => {
  const why = (o) => roundsForOwner({ rows: [row({})], own, share: 0.02, nowMs: NOW, ...o }).why;
  assert.equal(why({ own: null }).kind, 'not in the census');
  assert.match(why({ own: { ...own, serving: false } }).says, /stepped out/);
  assert.match(why({ own: { ...own, roles: ['relay'] } }).says, /"Play and check rounds" and "Pay out winners" are both off/);
  assert.equal(roundsForOwner({ rows: [], own, nowMs: NOW }).why.kind, 'no rounds');
  const g = roundsForOwner({ rows: [row({ hostedHere: false })], own, nowMs: NOW }).why;
  assert.deepEqual([g.kind, /Bitcoin Up or Down v24/.test(g.says)], ['no game announced', true], 'the 2026-10-27 case, named');
  const d = why({});
  assert.equal(d.kind, 'not drawn');
  assert.match(d.says, /in the draw for 1 rounds of the last day.*2\.0 % of all bonds.*about 14 of every 100 rounds/);
});

test('upcoming rounds counted; rounds older than a day explain nothing', () => {
  const r = roundsForOwner({ rows: [row({ gameSeated: true, startMs: NOW + 600000, endMs: NOW + 900000, phase: 'upcoming' })], own, nowMs: NOW });
  assert.deepEqual([r.upcoming, r.why], [1, null]);
  const old = roundsForOwner({ rows: [row({ gameSeated: true, startMs: NOW - 3 * 86400000 })], own, nowMs: NOW });
  assert.equal(old.why.kind, 'no rounds', 'a seat from three days ago is listed, but today there was nothing');
});

test('a node holding no round at all says so, not that its bond does not count (kanban #757)', () => {
  const r = roundsForOwner({ rows: [], own: null, nowMs: NOW });
  assert.equal(r.why.kind, 'no rounds held');
  assert.match(r.why.says, /holds none of the network's rounds yet/);
  // a drawn reserve of a round it holds is listed as one
  const d = roundsForOwner({ rows: [row({ drawn: true, startMs: NOW + 600000, endMs: NOW + 900000, phase: 'upcoming' })], own: null, nowMs: NOW });
  assert.deepEqual([d.why, d.upcoming, d.rounds[0].does], [null, 1, ['Reserve (drawn, not seated)']]);
});

test('the auditor\'s line: rounds, objections and what is earned so far, an unread round not guessed (kanban #1002)', () => {
  const a = new Uint8Array(32).fill(1), b = new Uint8Array(32).fill(2);
  const hex = (u) => Buffer.from(u).toString('hex');
  const got = auditForOwner({ work: { audited: 2, objections: 1, rounds: [{ round: a, atMs: 2, contradicted: false }, { round: b, atMs: 1, contradicted: true }] }, earned: new Map([[hex(a), 5000n]]) });
  assert.equal(got.audited, 2);
  assert.equal(got.objections, 1);
  assert.equal(got.earnedMsat, '5000');
  assert.equal(got.unread, 1);
  assert.equal(got.contradicted, 1);
  assert.equal(auditForOwner({ work: null }), null);
});
