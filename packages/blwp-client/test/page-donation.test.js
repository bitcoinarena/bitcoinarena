// THE DONATION THE PAGE SIZES MONEY BY (kanban #187 item 2, plan comment 298, Go 2026-10-05). index.html's donationBps() is
// lifted out of the page by its text and run as it is, on a fake window and sessionStorage: Settings keeps
// blwp.donation.settings (default 200 bps, 0-500 in steps of 100). The settings deposit sizes "1 round" with it
// (index.html, before kanban #187: ctx.roundStake * BigInt(donationBps()) / 10000n; since: depositDonationMsat); the join asks
// chooseDonation with the same percent
// (index.html: ask: () => settingsPct) - and chooseDonation answers a round's KEPT choice (blwp.donation.<roundId>) first.
// Both amounts are computed here for the same round, from the page's own expressions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chooseDonation, depositDonationMsat } from '../src/donation-choice.js';

const PAGE = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/index.html', import.meta.url), 'utf8');
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
  const donationBps = new Function('window', `${lift('donationBps')}\nreturn donationBps;`)(window);
  return { window, donationBps };
}
const ROUND = { stakeMsat: 100000n };
const RID = 'ab'.repeat(32);

test('donationBps: 200 by default; a stored 0-500 in steps of 100 is taken; anything else is 200; read once per page', () => {
  assert.equal(pageWith(storage()).donationBps(), 200, 'nothing stored');
  for (const n of [0, 100, 200, 300, 400, 500]) assert.equal(pageWith(storage({ 'blwp.donation.settings': String(n) })).donationBps(), n, `${n}`);
  for (const bad of ['50', '250', '600', '-100', 'abc', '100.5'])
    assert.equal(pageWith(storage({ 'blwp.donation.settings': bad })).donationBps(), 200, `"${bad}"`);
  // read as a number: "1e2" is 100 and "" is 0 - neither is a value the page writes (it stores String(n))
  assert.equal(pageWith(storage({ 'blwp.donation.settings': '1e2' })).donationBps(), 100);
  assert.equal(pageWith(storage({ 'blwp.donation.settings': '' })).donationBps(), 0);
  const s = storage({ 'blwp.donation.settings': '300' });
  const p = pageWith(s);
  assert.equal(p.donationBps(), 300);
  s.setItem('blwp.donation.settings', '100');
  assert.equal(p.donationBps(), 300, 'kept on window.BLWP_DONATION_BPS: the store is read once per page');
  assert.equal(p.window.BLWP_DONATION_BPS, 300);
  const throws = { getItem: () => { throw new Error('denied'); } };
  assert.equal(pageWith(throws).donationBps(), 200, 'a store that throws: 200');
});

// the page's own expressions, checked present in index.html, then computed
const DEPOSIT_EXPR = 'const donationMsat = BLWPCLIENT.depositDonationMsat({ roundIdHex: ctx.roundIdHex, stakeMsat: ctx.roundStake,\n              settingsBps: donationBps(), storage: window.sessionStorage });';
const JOIN_EXPR = 'const settingsPct = String(donationBps() / 100);';
const depositDonation = (bps, stake, s) => depositDonationMsat({ roundIdHex: RID, stakeMsat: stake, settingsBps: bps, storage: s });
const joinDonation = (bps, s) => chooseDonation({ roundIdHex: RID, round: ROUND, ask: () => String(bps / 100), confirm: () => false, storage: s }).donationMsat;

test('the settings deposit and the join size the same donation for a round with no kept choice', () => {
  assert.ok(PAGE.includes(DEPOSIT_EXPR), 'the deposit expression is the page\'s');
  assert.ok(PAGE.includes(JOIN_EXPR), 'the join expression is the page\'s');
  for (const bps of [0, 100, 200, 300, 400, 500]) {
    const s = storage({ 'blwp.donation.settings': String(bps) });
    const { donationBps } = pageWith(s);
    assert.equal(joinDonation(donationBps(), s), depositDonation(donationBps(), ROUND.stakeMsat, s), `${bps} bps`);
  }
});

test('MEASURED: a round with a kept choice (2%) and Settings now at 3% - the deposit and the join size the same donation', () => {
  const s = storage({ 'blwp.donation.settings': '300', [`blwp.donation.${RID}`]: '200' });
  const { donationBps } = pageWith(s);
  const deposit = depositDonation(donationBps(), ROUND.stakeMsat, s);
  const join = joinDonation(donationBps(), s);
  assert.equal(join, 2000n, 'the join writes the kept 2%');
  assert.equal(deposit, join, `the settings deposit sizes ${deposit} msat of donation, the join locks ${join} msat`);
});

test('the deposit keeps nothing; every kept/Settings pair sizes the deposit as the join locks it', () => {
  for (const [settings, kept] of [[300, 200], [100, 300], [0, 200], [500, 0], [200, 200]]) {
    const s = storage({ 'blwp.donation.settings': String(settings), [`blwp.donation.${RID}`]: String(kept) });
    const { donationBps } = pageWith(s);
    const deposit = depositDonation(donationBps(), ROUND.stakeMsat, s);
    assert.equal(deposit, joinDonation(donationBps(), s), `Settings ${settings}, kept ${kept}`);
    assert.equal(deposit, 100000n * BigInt(kept) / 10000n, 'the kept choice');
  }
  const fresh = storage({ 'blwp.donation.settings': '300' });
  depositDonationMsat({ roundIdHex: RID, stakeMsat: 100000n, settingsBps: 300, storage: fresh });
  assert.equal(fresh.getItem(`blwp.donation.${RID}`), null, 'a deposit writes no kept choice');
  assert.equal(depositDonationMsat({ roundIdHex: null, stakeMsat: 100000n, settingsBps: 300, storage: fresh }), 3000n, 'no round id: Settings');
});
