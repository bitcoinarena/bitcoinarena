// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// RESTORE THE SEED IN SETTINGS, OVERWRITING THE CURRENT ONE (2026-10-04 23:48; plan accepted 2026-10-05).
// restoreSeed takes what the player typed - the 24 words or the 64 hex - and REPLACES the tab's one current seed
// (sessionStorage 'arena.player.seed', origin 'imported'). There is never a second active seed. The old phrase stays in the
// browser's kept list (localStorage 'arena.seeds'), inactive, so its wallet and round records are not stranded. Refused
// before anything is written: a wrong word (by name), a seed another open tab holds, and a live run in this tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreSeed } from '../src/join.js';
import { phraseFromSeed } from '../src/bip39.js';
import { readFileSync } from 'node:fs';

const mem = () => { const m = new Map(); return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
  getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
const OLD = '11'.repeat(32);
const NEW = '7f'.repeat(32);
const WORDS = phraseFromSeed(Uint8Array.from(Buffer.from(NEW, 'hex'))).phrase;
const NOW = 1_800_000_000_000;

function browser() {
  const session = mem(), kept = mem();
  session.setItem('arena.player.seed', OLD); session.setItem('arena.player.seed.from', 'minted'); session.setItem('arena.tab.id', 'tab-me');
  kept.setItem('arena.seeds', JSON.stringify([{ hex: OLD, from: 'minted', at: NOW - 60000 }]));
  kept.setItem('arena.seed.held.' + OLD.slice(0, 16), JSON.stringify({ tab: 'tab-me', at: NOW - 1000 }));
  return { session, kept };
}
const seedsIn = (session) => [...session.m.keys()].filter((k) => /^arena\.player\.seed$/.test(k)).map((k) => session.getItem(k));

test('valid 24 words replace the tab\'s one seed (imported); the old phrase stays kept, inactive', () => {
  const { session, kept } = browser();
  const got = restoreSeed({ text: WORDS, session, kept, now: NOW });
  assert.deepEqual({ ok: got.ok, hex: got.hex, from: got.from, previous: got.previous }, { ok: true, hex: NEW, from: 'words', previous: OLD });
  assert.deepEqual(seedsIn(session), [NEW], 'not exactly one seed in the session');
  assert.equal(session.getItem('arena.player.seed.from'), 'imported');
  const list = JSON.parse(kept.getItem('arena.seeds')).map((x) => x.hex);
  assert.ok(list.includes(OLD), 'the old phrase was deleted from the kept list');
  assert.ok(list.includes(NEW), 'the restored phrase is not kept');
});

test('the 64 hex restores the same seed', () => {
  const { session, kept } = browser();
  assert.equal(restoreSeed({ text: NEW.toUpperCase(), session, kept, now: NOW }).hex, NEW);
  assert.equal(session.getItem('arena.player.seed'), NEW);
});

test('a changed last word is refused by name and the seed is unchanged', () => {
  const { session, kept } = browser();
  const words = WORDS.split(' ');
  words[23] = words[23] === 'zoo' ? 'abandon' : 'zoo';
  const got = restoreSeed({ text: words.join(' '), session, kept, now: NOW });
  assert.equal(got.ok, false);
  assert.ok(got.why && got.why.length > 0, 'no reason given');
  assert.equal(session.getItem('arena.player.seed'), OLD);
  assert.equal(session.getItem('arena.player.seed.from'), 'minted');
});

test('a seed another open tab holds is refused, and the seed is unchanged', () => {
  const { session, kept } = browser();
  kept.setItem('arena.seed.held.' + NEW.slice(0, 16), JSON.stringify({ tab: 'tab-other', at: NOW - 2000 }));
  const got = restoreSeed({ text: WORDS, session, kept, now: NOW });
  assert.deepEqual({ ok: got.ok, why: got.why }, { ok: false, why: 'that seed is open in another tab: close it there first' });
  assert.equal(session.getItem('arena.player.seed'), OLD);
  // a heartbeat older than 12 s is a closed tab: the seed is free
  kept.setItem('arena.seed.held.' + NEW.slice(0, 16), JSON.stringify({ tab: 'tab-other', at: NOW - 13000 }));
  assert.equal(restoreSeed({ text: WORDS, session, kept, now: NOW }).ok, true);
});

test('a live run in this tab is refused with "leave the round first", and the seed is unchanged', () => {
  const { session, kept } = browser();
  const got = restoreSeed({ text: WORDS, session, kept, now: NOW, liveRun: true });
  assert.deepEqual({ ok: got.ok, why: got.why }, { ok: false, why: 'leave the round first: the seed cannot change during a run' });
  assert.equal(session.getItem('arena.player.seed'), OLD);
});

// AND THE PAGE ("Move restore into Settings"): the Settings seed card has the field and "use my seed", wired to
// restoreSeed; the round page under the refund fingerprint has no restore field any more.
test('Settings has the restore field wired to restoreSeed; the round page has none', () => {
  const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url).pathname, 'utf8');
  const card = page.slice(page.indexOf('id="arena-set-seed"'), page.indexOf('</section>', page.indexOf('id="arena-set-seed"')));
  assert.match(card, /<input id="arena-seed-restore" type="password"/);
  assert.match(card, /<button id="arena-seed-use" type="button">use my seed<\/button>/);
  assert.match(page, /BLWPCLIENT\.restoreSeed\(\{ text, session: window\.sessionStorage, kept, now: Date\.now\(\), liveRun \}\)/);
  assert.match(page, /getElementById\('arena-seed-use'\)\.addEventListener\('click'/);
  const roundPage = page.slice(page.indexOf("const refundEl = document.getElementById('arena-refund')"), page.indexOf('refundEl.append(backup)') + 40);
  assert.ok(roundPage.length > 40, 'the round page block was not found');
  assert.doesNotMatch(roundPage, /use my seed|createElement\('input'\)|importSeed/, 'the round page still has a restore field');
});
