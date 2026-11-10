// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDERATION NO ENTRY CAN PAY INTO IS NOT OFFERED (2026-10-30, a table of federation A at UI 423: "Order not placed: this round pays the
// protocol reserves, and none of the round's 14 signer nodes names a reserve key"). GET /reserves as seat 1 answered it that minute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keylessFederations, fetchKeylessFederations } from '../src/reserves-page.js';
import { unplayableWindowLine } from '../src/lobby.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32), key = `02${'cd'.repeat(32)}`;
const seat = { federations: [{ federationId: A, key: null, why: 'no reserve key for 0 guardian seats' }, { federationId: B, key }] };

test('a federation the seats list with no key is keyless, one with a key is not', () => {
  assert.deepEqual([...keylessFederations([seat, seat, seat])], [A]);
});

test('one seat naming a key is enough to keep it offered: the entry itself checks the key', () => {
  const late = { federations: [{ federationId: A, key }] };
  assert.deepEqual([...keylessFederations([seat, seat, seat, late])], []);
});

test('too few answers, or none, hold nothing back', () => {
  assert.equal(keylessFederations([seat, seat]).size, 0);
  assert.equal(keylessFederations([null, undefined, {}, seat]).size, 0);
  assert.equal(keylessFederations([]).size, 0);
});

test('the fetch asks each node once, survives one that fails, and never throws', async () => {
  const asked = [];
  const fetcher = async (u) => { asked.push(u); if (u.includes('bad')) throw new Error('down'); return new Response(JSON.stringify(seat)); };
  const k = await fetchKeylessFederations({ nodes: ['wss://a', 'https://b/', 'https://c', 'https://a', 'https://bad'], fetcher });
  assert.deepEqual([...k], [A]);
  assert.deepEqual(asked.sort(), ['https://a/reserves', 'https://b/reserves', 'https://bad/reserves', 'https://c/reserves']);
  assert.equal((await fetchKeylessFederations({ nodes: ['https://bad'], fetcher })).size, 0);
});

test('the line says why such a window is not playable', () => {
  const l = unplayableWindowLine({ unoffered: [{ id: 'x', entryCloseMs: 2000, startTimeMs: 1000, why: 'no reserve key' }], offered: [], nowMs: 0 });
  assert.match(l.text, /its federation has no reserve key yet/);
});

test('the lobby holds such tables back before the wallet\'s own federation is chosen', () => {
  const src = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  assert.match(src, /if \(!keyless\.has\(f\) && !inactive\.has\(f\) && holdsSatIn\(f\) >= stakeSatOf\(r\)\)/, 'a keyless federation is never the wallet\'s federation');
  assert.match(src, /if \(keyless\.has\(f\) \|\| inactive\.has\(f\)\) \{[^\n]*return false; \}\n\s*const mineFeds/, 'and comes before the wallet rule');
});

test('the page can call it: the bundle exports it by name', () => {
  const src = readFileSync(new URL('../tools/bundle.js', import.meta.url), 'utf8');
  assert.match(src, /fetchKeylessFederations: fetchKeylessFederations/);
});

test('a seat that is no member names the key as reserveKey: that federation is playable (measured 12:50Z: UI 424 held back federation B too)', () => {
  const testHost = { federations: [{ federationId: A, key: null, reserveKey: null, why: 'no reserve key for 0 guardian seats' }, { federationId: B, key: null, reserveKey: key }] };
  assert.deepEqual([...keylessFederations([testHost, testHost, testHost])], [A]);
});

test('draw reads the keyless set from the page, not from a helper of paint: out of its scope no table is offered at all (measured 12:53Z, UI 424)', () => {
  const src = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const draw = src.slice(src.indexOf('const draw = (got, got2) =>'), src.indexOf('window.ARENA_LOBBY_ROWS = [...mine, ...theirs]'));
  assert.ok(draw.length > 1000);
  assert.doesNotMatch(draw, /reservesRead/);
  assert.match(draw, /window\.ARENA_RESERVES_READ && window\.ARENA_RESERVES_READ\.keyless/);
});

test('a balance in such a federation says so; one elsewhere says nothing (Alice: "it should say so in a message")', async () => {
  const { keylessFundsLine } = await import('../src/reserves-page.js');
  const keyless = new Set([A]);
  const l = keylessFundsLine({ parts: [{ federation: A, sats: 279 }, { federation: B, sats: 500 }], keyless });
  assert.equal(l.sats, 279);
  assert.match(l.text, /^279 sat of your balance can't be played right now/);
  assert.match(l.text, /aaaaaaaa/);
  assert.equal(keylessFundsLine({ parts: [{ federation: B, sats: 500 }], keyless }), null);
  assert.equal(keylessFundsLine({ parts: [{ federation: A, sats: 0 }], keyless }), null);
  assert.equal(keylessFundsLine({ parts: undefined, keyless }), null);
});

test('the bundle exports the line, and the page shows it', () => {
  assert.match(readFileSync(new URL('../tools/bundle.js', import.meta.url), 'utf8'), /keylessFundsLine: keylessFundsLine/);
  assert.match(readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8'), /ARENACLIENT\.keylessFundsLine\(\{ parts: bal\.parts, keyless: new Set\(\[\.\.\.k\.keyless/);
});

test('the message says from when it will work (Alice: "Sage, ab wann es funktionieren wird")', async () => {
  const { keylessFundsLine } = await import('../src/reserves-page.js');
  const keyless = new Set([A]);
  const l = keylessFundsLine({ parts: [{ federation: A, sats: 279 }], keyless, expected: { [A]: 158325 }, tip: 158234 });
  assert.match(l.text, /Expected to work from block 158,325, in about 15 hours\./);
  assert.match(keylessFundsLine({ parts: [{ federation: A, sats: 1 }], keyless, expected: { [A]: 158325 } }).text, /from block 158,325\./, 'no tip: the block alone');
  assert.doesNotMatch(keylessFundsLine({ parts: [{ federation: A, sats: 1 }], keyless }).text, /Expected/, 'no block named: no promise');
});

test('the whole stuck balance is counted: a part under the federation\'s first 16 hex too ("Er sagt 5 Sats aber es sind 310")', async () => {
  const { keylessFundsLine } = await import('../src/reserves-page.js');
  const l = keylessFundsLine({ parts: [{ federation: A, sats: 5 }, { federation: A.slice(0, 16), sats: 305, merging: 305 }, { federation: B, sats: 40 }], keyless: new Set([A]), expected: { [A]: 158325 } });
  assert.equal(l.sats, 310);
  assert.match(l.text, /^310 sat of your balance/);
  assert.match(l.text, /in federation aaaaaaaa\. Paid rounds there are paused/);
  assert.match(l.text, /block 158,325/);
});

test('a head-to-head move the seats took ends the join, not in a refusal (2026-10-30: "this page did not join that round")', () => {
  const src = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const hidden = src.indexOf("if (window.ARENA_HIDDEN && window.ARENA_HIDDEN.round === id) {"), refusal = src.indexOf("refuse(window.ARENA_JOIN_REFUSED || 'this page did not join that round')");
  assert.ok(hidden > 0 && hidden < refusal, 'read before the refusal');
  assert.match(src.slice(hidden, hidden + 400), /join\.state = 'picked'/);
});

test('a reload in the middle of a join puts no refusal over the page (2026-10-30: "carries no such core")', () => {
  const src = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  assert.match(src, /window\.ARENA_JOIN = coreOnly \? null : window\.ARENA_REFUSED_JOIN/);
});

test('a lock held by notes still arriving says so (2026-10-30: "kommt mit der order nicht weiter")', () => {
  const src = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const at = src.indexOf('is being issued (\\d+) msat more');
  assert.ok(at > 0 && at < src.indexOf('/waiting for the deposit|insufficient funds|less than this round'), 'read before the not-enough line');
  assert.match("the player wallet holds 89000 msat and is being issued 11000 msat more (a restore, a deposit or a payment's change): waiting for those notes", /is being issued (\d+) msat more/);
});

test('a federation not active is not paid into; a failed read holds nothing back (Alice: "soll er in der UI auch nicht versuchen mit der zu bezahlen")', async () => {
  const { inactiveFederations } = await import('../src/reserves-page.js');
  const open = { status: 'OPEN', allows: { join: true } }, unverified = { status: 'unverified', allows: { join: true } }, critical = { status: 'CRITICAL', allows: { join: false } }, draining = { status: 'DRAINING', allows: { join: true } };
  assert.deepEqual([...inactiveFederations(new Map([[A, unverified], [B, open]]))], [A]);
  assert.deepEqual([...inactiveFederations(new Map([[A, critical], [B, open]]))], [A]);
  assert.equal(inactiveFederations(new Map([[A, draining], [B, open]])).size, 0, 'a draining federation still takes entries');
  assert.equal(inactiveFederations(new Map([[A, unverified], [B, unverified]])).size, 0, 'nothing verified at all: the read failed');
  assert.equal(inactiveFederations(undefined).size, 0);
});

test('a refused head-to-head entry says why the seats refused it (2026-10-30: "refused the entry: undefined")', () => {
  const src = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /'the signer nodes refused the entry: ' \+ sent\.why;/);
  assert.match(src, /const saidWhy = sent\.why \|\| \[\.\.\.new Set\(sent\.entries\.map/);
});

test('a round\'s result is read from a seat that holds its players, not the first that answers (2026-10-30: "es gibt kein Ergebnis")', () => {
  const src = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const at = src.indexOf('result: async (id) => {');
  const body = src.slice(at, src.indexOf('// A MARKET\'S CLIENT: place an order', at));
  assert.match(body, /if \(!\(j\.players \|\| \[\]\)\.length\) \{ none = none \|\| \{ entries: \[\], match: null \}; continue; \}/);
  assert.match(body, /return none;/);
  // the seats' answers as measured on round 1b995103: seven seats with no players ahead of the five that signed
  const answers = [...Array(7).fill({ players: [] }), { players: [{ entry: 'a', outcome: 'FAILED' }, { entry: 'b', outcome: 'DELIVERED' }] }];
  let none = null, got = null;
  for (const j of answers) { if (!(j.players || []).length) { none = none || { entries: [] }; continue; } got = j; break; }
  assert.equal(got.players.length, 2);
});

test('a paid round whose donation set could not be read locks nothing and says so (kanban #803: "are 6000 msat, not 0")', () => {
  const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const read = page.indexOf("let ds = await joinStep('fetchDonationSet'");
  const again = page.indexOf("ds = await joinStep('fetchDonationSet', askDonationSet)", read);
  const held = page.indexOf('ARENACLIENT.roundPaysReserves(named.round)) {\n          console.error(\'[arena] no donation set', again);
  const going = page.indexOf("console.error('[arena] no donation: ' + ds.why)", again);
  assert.ok(read > 0 && again > read && held > again && going > held, 'read, asked again, held back before the no-donation path');
  assert.match(page.slice(held, going), /Nothing was locked[^\n]*\n[^\n]*\n\s*return;/);
});

test('the funds note is said once per page load, whatever the amount does after (2026-10-30: "nur einmal ... nach einem Load")', () => {
  const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  assert.match(page, /window\.ARENA_WALLET_STOPPED \? window\.ARENA_FUNDS_NOTE_CLOSED === line\.text : window\.ARENA_FUNDS_NOTE_SAID/);
  assert.match(page, /x\.onclick = \(\) => \{ if \(window\.ARENA_WALLET_STOPPED\)[^\n]*else window\.ARENA_FUNDS_NOTE_SAID = true/);
});

test('only a lost write says the wallet stopped; idle sockets make room below the browser limit (kanban #803)', () => {
  const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  assert.match(page, /\/blwp-lock-client panicked\/\.test\(m\) && \/quota\|Unrecoverable error\/i\.test\(m\)/);
  const made = page.indexOf('makeSocketRoom();'), built = page.indexOf('super(r.url)', made);
  assert.ok(made > 0 && built > made, 'room is made before a socket is opened');
  assert.match(page, /openSockets\.delete\(w\); w\.close\(\)/);
});

test('no strip of settlement facts and fees over a game client (2026-10-30: it covered the options on the iPhone)', () => {
  const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /arena-approval/);
  assert.match(page, /#arena-client \{ height: calc\(100% - 41px - 30px/);
});

test('the collect waits 30 s after a load and gives way to an order between records (2026-10-30, the first 1-2 minutes)', () => {
  const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  assert.match(page, /async function lookThePayout\(\) \{\n\s*if \(performance\.now\(\) < 30000\) return;/);
  assert.match(page, /if \(rescanWanted\) break;\n\s*await orderClear\(\);/);
  assert.match(page, /window\.ARENA_ORDER_AT = Date\.now\(\);/);
});

test('a federation whose wallet did not open holds no other merge for the rest of the load (2026-10-30: minutes instead of seconds)', () => {
  const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  assert.match(page, /mergeDeadFeds\.get\(fedHex\)/);
  assert.match(page, /dead\.misses >= 2/);
});

test('the merge runs four wallets at a time with short waits, and an order waits for it 12 s at most (2026-10-30: "Es darf nicht ewig hängen")', () => {
  const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  assert.match(page, /MERGE_AT_ONCE = 4, MERGE_OPEN_MS = 10000, MERGE_LOCK_MS = 8000, MERGE_RECEIVE_MS = 20000/);
  assert.match(page, /Array\.from\(\{ length: Math\.min\(MERGE_AT_ONCE, mergeQueue\.length\) \}/);
  assert.match(page, /ARENA_MERGE_NOW\(plan\.mergeFirst, 12000,/);
  assert.doesNotMatch(page, /did not open in 30 s/);
});

test('the securing line stays clear of the next round box (2026-10-30: it lay on "exit game")', () => {
  const css = readFileSync(new URL('../../nextblock/page/unity-page.css', import.meta.url), 'utf8');
  assert.match(css, /#arena-securing \{ top: calc\(49px[^}]*bottom: auto !important; \}/);
});


// kanban #1393 (Daniel's playtest 2026-11-09: "Make all messages human readable"): the order strip says no msat, no inner step, and a refused order in one sentence
test('the order strip speaks to the player: no msat or inner steps, a refusal in one sentence, the seats\' words only with Report this', () => {
  const src = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const strip = src.slice(src.indexOf('const plain = (stage) => {'), src.indexOf("window.ARENA_JOIN_STATUS = { line, cls, state: j.state, why: j.why || null };"));
  assert.ok(strip.length > 500, 'the strip code is found');
  assert.ok(!/'Order not placed: ' \+ \(j\.why/.test(strip), 'the raw reason is not the line');
  assert.ok(!/return 'locking your stake: '/.test(strip), 'no inner step on the line');
  assert.match(strip, /if \(j\.state === 'refused'\) \{ line = refusedWords\(j\.why\); cls = 'bad'; \}/);
  for (const words of ['Your order came too late for this round. Tap again to play the next one.', 'Not enough sats in your wallet for this round.', ' Add some with Deposit or Get 300 sats.',
    " sat of your winnings arrive ' + pendingWhen() + '.'"]) assert.ok(strip.includes(words), words);   // #1391: the pending winnings are named, #1398: with their own window
  assert.ok(strip.includes("return mins <= 1 ? 'within about a minute' : 'within about ' + mins + ' minutes'; };"), 'when they arrive, from the seats\' window close');
  const said = strip.match(/return '[^']*'/g) || [];
  assert.ok(said.length >= 8 && said.every((r) => !/msat|signer node|seating|federation lock|census/.test(r)), 'no inner words in what the player reads');
});

// kanban #1394 (Daniel 2026-11-09: "make sure not to accept any orders when the timer is less than 3 seconds away, and don't join rounds that are less
// than 5 seconds to go ... at least 8 seconds out ... after a reveal"): the page refuses an order in a round's last 3 s and offers a head-to-head round
// first with 5 s left, 8 s right after this tab's own round
test('no order in the last 3 s; a head-to-head round is first offered with 5 s left, the round right after its own one skipped', () => {
  const src = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  assert.match(src, /const ORDER_CUTOFF_MS = 3000;/);
  assert.match(src, /if \(closeAt && closeAt - Date\.now\(\) < ORDER_CUTOFF_MS\) \{/);
  assert.match(src, /const skipUntil = now - lastClose < 20000 \? lastClose \+ 12000 : 0;/);
  assert.ok(src.includes('if (close > lastClose && close < skipUntil) return false;') && src.includes('if (close - now < 5000) return false;'));
  assert.match(src, /allRows: \(\) => \(holdForReveal\(\) \? \[\] : fullRounds\(sameVersionPerSlot\(/);
  const cut = src.indexOf('if (closeAt && closeAt - Date.now() < ORDER_CUTOFF_MS)'), pay = src.indexOf('// ANOTHER TAB OF THIS BROWSER IS IN A PAID RUN');
  assert.ok(cut > 0 && cut < pay, 'the cutoff comes before any money is touched');
});

// kanban #1395 / #1391 (Daniel 2026-11-09: "Mach es schneller"; the hold screen between Wait and the reveal): for Rock Paper Scissors client
// 7587b604 only, by its hash, the page sets the winner from the open moves, runs the show 1.6x faster and keeps Wait up to the close
test('client 7587b604: the quick reveal swaps are applied only all together and only to that hash, Wait stands to the close', () => {
  const src = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const at = src.indexOf("if (/^7587b604be5ad153/.test(String(file.hash || '')))");
  assert.ok(at > 0, 'gated by the client hash');
  const block = src.slice(at, src.indexOf('} catch { bytes = file.bytes; }', at));
  for (const x of ["'me.signedBy > 0 && !me.provisional', 'me.signedBy > 0'", "'seq.t += dt;', 'seq.t += dt * 1.6;'",
    "(Date.now() < last.closeMs - CLOSING_MS || (last.them === 0 && company)))\", \"(last.phase === 'wait' && (Date.now() < last.closeMs ||",
    "return window.parent.ARENA_ORDER_WORDS(rec.why);", "return window.parent.ARENA_ORDER_WORDS(j.why);"]) assert.ok(block.includes(x), x);   // #1393: the tap notes in plain words
  assert.match(block, /if \(swaps\.every\(\(\[x\]\) => html\.split\(x\)\.length === 2\)\)/, 'all or none, each found exactly once');
});
