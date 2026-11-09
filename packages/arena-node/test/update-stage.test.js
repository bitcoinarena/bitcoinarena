// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// UPDATES STAGED PER FEDERATION (kanban #1093 part 3): at most f guardians of one federation on a new release without a healthy hour.
// A SILENT GUARDIAN HOLDS ITS PLACE (kanban #1169): a fellow counts only by its signed answer to this ask; silent or unsigned is on trial;
// the healthy hour is the asking seat's own, kept across its restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import * as stage from '../src/update-stage.js';

const { stageDecision, faultsOf, STAGE_HEALTHY_MS } = stage;
const secrets = [1, 2, 3, 4, 5, 6, 7].map((i) => taggedHash('TEST/stage', Uint8Array.of(i)));
const SEVEN = secrets.map((s) => toHex(schnorr.getPublicKey(s))).sort();
const secretOf = new Map(secrets.map((s) => [toHex(schnorr.getPublicKey(s)), s]));
const verify = (sig, m, k) => { try { return schnorr.verify(sig, m, k); } catch { return false; } };
const NOW = 1_800_000_000_000, V = '2026.2.0', OLD = '2026.1.9.24', NONCE = 'ab'.repeat(16);
const fresh = { version: V, startedAtMs: NOW - 60_000, healthy: true };
const proven = { version: V, startedAtMs: NOW - STAGE_HEALTHY_MS - 1, healthy: true };
const old = { version: OLD, startedAtMs: NOW - 86_400_000, healthy: true };
// each fellow's own signed answer over the nonce, as its seat's GET /release?nonce= says it (the new source); the old source read the same fields
const signed = (k, a) => (stage.signReleaseAnswer ? stage.signReleaseAnswer({ node: k, commit: 'c', ...a, nonce: NONCE, atMs: NOW }, (d) => schnorr.sign(d, secretOf.get(k))) : { node: k, ...a });
const answersOf = (m) => new Map(Object.entries(m).map(([k, a]) => [k, a ? signed(k, a) : null]));
const decide = (o) => stageDecision({ version: V, members: SEVEN, nonce: NONCE, verify, nowMs: NOW, ...o });
// the seat's own clock: each fellow on V healthy seen since its start (the kept rows), as a seat that asked all along holds them
const seenSince = (m) => new Map(Object.entries(m).filter(([, a]) => a && a.version === V).map(([k, a]) => [k, { version: V, sinceMs: a.startedAtMs }]));

test('f of a federation: 7 -> 2, 10 -> 3, 4 -> 1', () => {
  assert.deepEqual([faultsOf(7), faultsOf(10), faultsOf(4), faultsOf(1)], [2, 3, 1, 0]);
});

test('a federation of 7, all on the old release: the two lowest keys go, the others wait', () => {
  const answers = answersOf(Object.fromEntries(SEVEN.map((k) => [k, old])));
  const go = SEVEN.map((k) => decide({ self: k, answers }).go);
  assert.deepEqual(go, [true, true, false, false, false, false, false], 'never more than f at once, even if all ask in the same second');
});

test('two on trial: nobody else goes; one of them proven: the next one goes', () => {
  const m = { [SEVEN[0]]: fresh, [SEVEN[1]]: fresh, ...Object.fromEntries(SEVEN.slice(2).map((k) => [k, old])) };
  const answers = answersOf(m);
  for (const k of SEVEN.slice(2)) assert.equal(decide({ self: k, answers, seen: seenSince(m) }).go, false);
  const w = decide({ self: SEVEN[2], answers, seen: seenSince(m) });
  assert.match(w.why, /wait: 2 guardian\(s\) of 7 on trial for 2026\.2\.0/);
  m[SEVEN[0]] = proven;
  const a2 = answersOf(m);
  assert.deepEqual(SEVEN.slice(2).map((k) => decide({ self: k, answers: a2, seen: seenSince(m) }).go), [true, false, false, false, false]);
});

test('on the new release but not healthy (its federation did not advance, or it says so) still counts as on trial', () => {
  const m = { [SEVEN[0]]: { ...proven, healthy: false }, [SEVEN[1]]: fresh, ...Object.fromEntries(SEVEN.slice(2).map((k) => [k, old])) };
  assert.equal(decide({ self: SEVEN[2], answers: answersOf(m), seen: seenSince(m) }).onTrial, 2);
});

test('#1169 the scenario: A and B take the release and go silent (it crashes them) - C does not take it, the federation keeps five', () => {
  // seven guardians on OLD; A and B (the two lowest keys) go
  const all = answersOf(Object.fromEntries(SEVEN.map((k) => [k, old])));
  assert.deepEqual([0, 1, 2].map((i) => decide({ self: SEVEN[i], answers: all }).go), [true, true, false]);
  // the release crashes them: both silent from now on
  const crashed = answersOf({ [SEVEN[0]]: null, [SEVEN[1]]: null, ...Object.fromEntries(SEVEN.slice(2).map((k) => [k, old])) });
  const c = decide({ self: SEVEN[2], answers: crashed });
  console.log(`#1169 C after A and B went silent on ${V}: go=${c.go} onTrial=${c.onTrial} f=${c.f} - ${c.why}`);
  assert.equal(c.go, false, 'two silent fellows hold both places: C waits');
  assert.equal(c.onTrial, 2);
  for (const k of SEVEN.slice(2)) assert.equal(decide({ self: k, answers: crashed }).go, false, 'nobody else goes: five stay on the old release');
  // a node that guards nothing is not staged
  assert.equal(decide({ self: toHex(schnorr.getPublicKey(taggedHash('TEST/stage', Uint8Array.of(9)))), answers: crashed }).go, true);
});

test('#1169 an unsigned answer, one in another node\'s name, or one over another nonce counts as silent', () => {
  const m = Object.fromEntries(SEVEN.map((k) => [k, old]));
  const answers = answersOf(m);
  // A's seat says "old" unsigned; B's answer is C's signed word; D's is signed over an old nonce (played back)
  answers.set(SEVEN[0], { node: SEVEN[0], ...old });
  answers.set(SEVEN[1], { ...signed(SEVEN[2], old), node: SEVEN[1] });
  answers.set(SEVEN[3], stage.signReleaseAnswer({ node: SEVEN[3], commit: 'c', ...old, nonce: 'cd'.repeat(16), atMs: NOW - 86_400_000 }, (d) => schnorr.sign(d, secretOf.get(SEVEN[3]))));
  const d = decide({ self: SEVEN[4], answers });
  assert.deepEqual([d.fellows.get(SEVEN[0]), d.fellows.get(SEVEN[1]), d.fellows.get(SEVEN[3]), d.fellows.get(SEVEN[2])],
    [stage.FELLOW.SILENT, stage.FELLOW.SILENT, stage.FELLOW.SILENT, stage.FELLOW.ELSEWHERE]);
  assert.equal(d.go, false, 'three places held by answers that do not count');
});

test('#1169 the healthy hour is the asking seat\'s own: a self-reported old start time does not prove a fellow first seen just now', () => {
  // A and B say they run V since two hours; this seat first sees them now
  const m = { [SEVEN[0]]: { ...proven, startedAtMs: NOW - 2 * STAGE_HEALTHY_MS }, [SEVEN[1]]: { ...proven, startedAtMs: NOW - 2 * STAGE_HEALTHY_MS },
    ...Object.fromEntries(SEVEN.slice(2).map((k) => [k, old])) };
  const first = decide({ self: SEVEN[2], answers: answersOf(m) });
  assert.equal(first.go, false, 'first sighting: both on trial');
  assert.deepEqual([first.rows.get(SEVEN[0]), first.rows.get(SEVEN[1])], [{ version: V, sinceMs: NOW }, { version: V, sinceMs: NOW }]);
  // kept in the store; the seat restarts and asks an hour later: both proven
  const db = new DatabaseSync(':memory:');
  const book = stage.createStageBook(db); book.write(first.rows);
  const later = stageDecision({ version: V, members: SEVEN, nonce: NONCE, verify, nowMs: NOW + STAGE_HEALTHY_MS, self: SEVEN[2], answers: answersOf(m), seen: stage.createStageBook(db).read(SEVEN) });
  assert.equal(later.go, true, 'an hour of this seat\'s own sightings: the next one goes');
  // A silent once in between: its hour starts again
  const blip = decide({ self: SEVEN[2], answers: answersOf({ ...m, [SEVEN[0]]: null }), seen: book.read(SEVEN) });
  book.write(blip.rows);
  assert.equal(book.read(SEVEN).has(SEVEN[0]), false, 'the silent reading clears its clock');
  const after = stageDecision({ version: V, members: SEVEN, nonce: NONCE, verify, nowMs: NOW + STAGE_HEALTHY_MS, self: SEVEN[2], answers: answersOf(m), seen: book.read(SEVEN) });
  assert.equal(after.fellows.get(SEVEN[0]), stage.FELLOW.TRIAL);
});

test('#1169 fellowStep: one transition per reading', () => {
  const { fellowStep, FELLOW } = stage;
  assert.deepEqual(fellowStep({ prev: { version: V, sinceMs: NOW - 10 }, reading: null, version: V, nowMs: NOW }), { state: FELLOW.SILENT, row: null });
  assert.deepEqual(fellowStep({ reading: old, version: V, nowMs: NOW }), { state: FELLOW.ELSEWHERE, row: null });
  assert.deepEqual(fellowStep({ prev: { version: V, sinceMs: NOW - STAGE_HEALTHY_MS }, reading: { ...proven, healthy: false }, version: V, nowMs: NOW }), { state: FELLOW.TRIAL, row: null });
  assert.deepEqual(fellowStep({ reading: proven, version: V, nowMs: NOW }), { state: FELLOW.TRIAL, row: { version: V, sinceMs: NOW } });
  assert.deepEqual(fellowStep({ prev: { version: V, sinceMs: NOW - STAGE_HEALTHY_MS }, reading: proven, version: V, nowMs: NOW }).state, FELLOW.PROVEN);
  assert.deepEqual(fellowStep({ prev: { version: V, sinceMs: NOW - STAGE_HEALTHY_MS }, reading: fresh, version: V, nowMs: NOW }).state, FELLOW.TRIAL, 'restarted a minute ago: on trial');
  assert.deepEqual(fellowStep({ prev: { version: OLD, sinceMs: NOW - STAGE_HEALTHY_MS }, reading: proven, version: V, nowMs: NOW }).row, { version: V, sinceMs: NOW }, 'a row of another release does not count');
});

// kanban #1377 (audit 2 #1204 INSTALLER-DOORS-8): an ask naming another release (anyone's GET /update-stage?version=x) never resets a fellow's hour on the real one
test('#1377 a junk version asked between two asks for V leaves A and B\'s healthy hour on V standing', () => {
  const db = new DatabaseSync(':memory:');
  const book = stage.createStageBook(db);
  const m = { [SEVEN[0]]: fresh, [SEVEN[1]]: fresh, ...Object.fromEntries(SEVEN.slice(2).map((k) => [k, old])) };
  const self = SEVEN[2];
  // t0: A and B seen healthy on V for the first time
  const first = stageDecision({ version: V, members: SEVEN, nonce: NONCE, verify, nowMs: NOW, self, answers: answersOf(m), seen: book.read(SEVEN) });
  book.write(first.rows, V);
  // an outsider asks this seat about release 'x': every fellow answers V, so none is on x
  const junk = stageDecision({ version: '2026.9.9', members: SEVEN, nonce: NONCE, verify, nowMs: NOW + 60_000, self, answers: answersOf(m), seen: book.read(SEVEN) });
  book.write(junk.rows, '2026.9.9');
  // an hour later the updater asks for V: A and B are proven, so C may go
  const later = stageDecision({ version: V, members: SEVEN, nonce: NONCE, verify, nowMs: NOW + STAGE_HEALTHY_MS + 1000, self, answers: answersOf(m), seen: book.read(SEVEN) });
  console.log(`#1377 after the junk ask: A ${later.fellows.get(SEVEN[0])}, B ${later.fellows.get(SEVEN[1])}, go ${later.go}`);
  assert.equal(later.fellows.get(SEVEN[0]), stage.FELLOW.PROVEN);
  assert.equal(later.fellows.get(SEVEN[1]), stage.FELLOW.PROVEN);
  assert.equal(later.go, true);
});
