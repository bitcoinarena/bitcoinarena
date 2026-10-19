// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DONATION THE PAGE SIZES MONEY BY (plan comment 298, Go 2026-10-05). index.html's donationBps() is
// lifted out of the page by its text and run as it is, on a fake window and sessionStorage: Settings keeps
// arena.donation.settings (default 500 bps since - §0A.8's 5%, half protocol devs and half game dev - 0-500 in
// steps of 100). The settings deposit sizes "1 round" with it
// (index.html, before: ctx.roundStake * BigInt(donationBps()) / 10000n; since: depositDonationMsat); the join asks
// chooseDonation with the same percent
// (index.html: ask: () => settingsPct) - and chooseDonation answers a round's KEPT choice (arena.donation.<roundId>) first.
// Both amounts are computed here for the same round, from the page's own expressions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chooseDonation, depositDonationMsat } from '../src/donation-choice.js';
import { pageFunction } from './page-script.js';

const PAGE = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url), 'utf8');
function lift(name) {
  const at = PAGE.indexOf(`    function ${name}(`);
  assert.ok(at > 0, `index.html has no function ${name}`);
  const end = PAGE.indexOf('\n    }\n', at);
  return PAGE.slice(at, end + 6);
}
const storage = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
// a fresh window per page load: donationBps reads the store once and keeps it on window.BLWP_DONATION_BPS
function pageWith(sessionStorage) {
  const window = { sessionStorage };
  const donationBps = pageFunction(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url), ['window'], lift('donationBps'), 'return donationBps;')(window);
  return { window, donationBps };
}
const ROUND = { stakeMsat: 100000n };
const RID = 'ab'.repeat(32);

// THE DEFAULT IS THE RULE'S 5% (§0A.8), which the page states itself
const DEFAULT_BPS = 500;
test('donationBps: 500 by default; a stored 0-500 in steps of 100 is taken; anything else is 500; read once per page', () => {
  assert.equal(pageWith(storage()).donationBps(), DEFAULT_BPS, 'nothing stored');
  for (const n of [0, 100, 200, 300, 400, 500]) assert.equal(pageWith(storage({ 'arena.donation.settings': String(n) })).donationBps(), n, `${n}`);
  for (const bad of ['50', '250', '600', '-100', 'abc', '100.5'])
    assert.equal(pageWith(storage({ 'arena.donation.settings': bad })).donationBps(), DEFAULT_BPS, `"${bad}"`);
  // read as a number: "1e2" is 100 and "" is 0 - neither is a value the page writes (it stores String(n))
  assert.equal(pageWith(storage({ 'arena.donation.settings': '1e2' })).donationBps(), 100);
  assert.equal(pageWith(storage({ 'arena.donation.settings': '' })).donationBps(), 0);
  const s = storage({ 'arena.donation.settings': '300' });
  const p = pageWith(s);
  assert.equal(p.donationBps(), 300);
  s.setItem('arena.donation.settings', '100');
  assert.equal(p.donationBps(), 300, 'kept on window.BLWP_DONATION_BPS: the store is read once per page');
  assert.equal(p.window.BLWP_DONATION_BPS, 300);
  const throws = { getItem: () => { throw new Error('denied'); } };
  assert.equal(pageWith(throws).donationBps(), DEFAULT_BPS, 'a store that throws: the default');
});

// the page's own expressions, checked present in index.html, then computed
const DEPOSIT_EXPR = 'const donationMsat = BLWPCLIENT.depositDonationMsat({ roundIdHex: ctx.roundIdHex, stake: ctx.roundStake,\n            settingsBps: donationBps(), storage: window.sessionStorage });';
const JOIN_EXPR = 'const settingsPct = String(donationBps() / 100);';
const depositDonation = (bps, stake, s) => depositDonationMsat({ roundIdHex: RID, stake, settingsBps: bps, storage: s });
const joinDonation = (bps, s) => chooseDonation({ roundIdHex: RID, round: ROUND, ask: () => String(bps / 100), confirm: () => false, storage: s }).donationMsat;

test('the settings deposit and the join size the same donation for a round with no kept choice', () => {
  assert.ok(PAGE.includes(DEPOSIT_EXPR), 'the deposit expression is the page\'s');
  assert.ok(PAGE.includes(JOIN_EXPR), 'the join expression is the page\'s');
  for (const bps of [0, 100, 200, 300, 400, 500]) {
    const s = storage({ 'arena.donation.settings': String(bps) });
    const { donationBps } = pageWith(s);
    assert.equal(joinDonation(donationBps(), s), depositDonation(donationBps(), ROUND.stakeMsat, s), `${bps} bps`);
  }
});

test('MEASURED: a round with a kept choice (2%) and Settings now at 3% - the deposit and the join size the same donation', () => {
  const s = storage({ 'arena.donation.settings': '300', [`arena.donation.${RID}`]: '200' });
  const { donationBps } = pageWith(s);
  const deposit = depositDonation(donationBps(), ROUND.stakeMsat, s);
  const join = joinDonation(donationBps(), s);
  assert.equal(join, 2000n, 'the join writes the kept 2%');
  assert.equal(deposit, join, `the settings deposit sizes ${deposit} msat of donation, the join locks ${join} msat`);
});

test('the deposit keeps nothing; every kept/Settings pair sizes the deposit as the join locks it', () => {
  for (const [settings, kept] of [[300, 200], [100, 300], [0, 200], [500, 0], [200, 200]]) {
    const s = storage({ 'arena.donation.settings': String(settings), [`arena.donation.${RID}`]: String(kept) });
    const { donationBps } = pageWith(s);
    const deposit = depositDonation(donationBps(), ROUND.stakeMsat, s);
    assert.equal(deposit, joinDonation(donationBps(), s), `Settings ${settings}, kept ${kept}`);
    assert.equal(deposit, 100000n * BigInt(kept) / 10000n, 'the kept choice');
  }
  const fresh = storage({ 'arena.donation.settings': '300' });
  depositDonationMsat({ roundIdHex: RID, stake: 100000n, settingsBps: 300, storage: fresh });
  assert.equal(fresh.getItem(`arena.donation.${RID}`), null, 'a deposit writes no kept choice');
  assert.equal(depositDonationMsat({ roundIdHex: null, stake: 100000n, settingsBps: 300, storage: fresh }), 3000n, 'no round id: Settings');
});

// THE WARM QUOTE (follow-up, 2026-10-05 on comment 312): the lobby warms lock quotes for the
// paying round at a donation; it must be the donation the join will write - the round's kept choice when the tab has one,
// else Settings - or the warm quote is for another donation and the join quotes itself again. The expression is lifted
// out of index.html's warmLockQuotes call and evaluated as written.
const WARM = (() => {
  const at = PAGE.indexOf('BLWPCLIENT.warmLockQuotes({');
  assert.ok(at > 0, 'index.html warms no lock quotes');
  const call = PAGE.slice(at, PAGE.indexOf('\n              .then(', at));
  const from = call.indexOf('donationMsat: ') + 'donationMsat: '.length;
  return call.slice(from, call.lastIndexOf('})')).trim();
})();
const warmDonation = (s, stakeSats = 100) => {
  const { donationBps, window } = pageWith(s);
  window.sessionStorage = s;
  const BLWPCLIENT = { lobbyStakeSats: () => stakeSats, depositDonationMsat };
  return pageFunction(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url), ['BLWPCLIENT', 'r', 'donationBps', 'window'], WARM, ';', 'return ')(BLWPCLIENT, { id: RID, raw: {} }, donationBps, window);
};

test('the warm quote sizes the donation the join will write: a kept choice wins over Settings; none falls back to Settings', () => {
  for (const [settings, kept] of [[300, 200], [100, 300], [0, 200], [500, 0], [200, 200]]) {
    const s = storage({ 'arena.donation.settings': String(settings), [`arena.donation.${RID}`]: String(kept) });
    const { donationBps } = pageWith(s);
    assert.equal(warmDonation(s), joinDonation(donationBps(), s), `Settings ${settings}, kept ${kept}: warm = join (${WARM})`);
  }
  for (const settings of [0, 100, 200, 300, 400, 500]) {
    const s = storage({ 'arena.donation.settings': String(settings) });
    assert.equal(warmDonation(s), 100000n * BigInt(settings) / 10000n, `no kept choice: Settings ${settings}`);
  }
});
