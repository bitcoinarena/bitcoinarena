// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CONTRIBUTION AGREEMENTS (spec §27A.4.2, kanban #1346): the records and the reader of his vested share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taggedHash, toHex } from '../src/hash.js';
import {
  MILESTONES, REFERENCE_AGREEMENT, RETENTION_BLOCKS, T4_WINDOW_BLOCKS, agreementStands,
  encodeContributionAgreement, decodeContributionAgreement, contributionAgreementId,
  encodeContributionLeave, decodeContributionLeave, encodeContributionTermination, decodeContributionTermination,
  baseVestedBps, contributionShare, contributionShares, factsFromSeasonRounds,
} from '../src/contribution.js';

const key33 = (i) => Uint8Array.of(0x02, ...taggedHash('TEST/c-rk', Uint8Array.of(i)));
const k32 = (s, i) => taggedHash(`TEST/${s}`, Uint8Array.of(i));
const k33 = (s, i) => Uint8Array.of(0x03, ...k32(s, i));
const SITE = [k33('site', 1), k33('site', 2)], PROJECT = k33('project', 0);
const START = 1000;
const agreement = (over = {}) => ({
  recipientPk: key33(1), siteKeys: SITE, startHeight: START,
  base: { ...REFERENCE_AGREEMENT.base },
  tranches: MILESTONES.map((milestone) => ({ bps: 250, milestone, windowBlocks: 12960, expiresHeight: START + 157680 })),
  attributionFloorBps: 3000, tailBlocks: 52560, ...over,
});
const id = (i) => toHex(k32('id', i % 256)) .slice(0, 56) + String(i).padStart(8, '0');
/** `n` new identities from `from`, one every `step` blocks; `mine` of every `of` carry his site key, the rest the project's. */
function newcomers({ n, from, step = 1, mine = 1, of = 1, base = 0, grossMsat = 100000n }) {
  return Array.from({ length: n }, (_, i) => ({ height: from + i * step, identity: id(base + i), frontendPk: i % of < mine ? SITE[i % 2] : PROJECT, grossMsat }));
}

test('the agreement: bytes round trip, one encoding whatever the site keys\' order, its id; leave and termination', () => {
  const a = agreement();
  assert.equal(agreementStands(a).ok, true);
  assert.equal(agreementStands(a).targetBps, 1250, '12.5 % of the set: 2.5 % for time, 10 % for results');
  const b = decodeContributionAgreement(encodeContributionAgreement(a));
  assert.deepEqual(encodeContributionAgreement(b), encodeContributionAgreement(a));
  assert.deepEqual(contributionAgreementId(agreement({ siteKeys: [SITE[1], SITE[0]] })), contributionAgreementId(a));
  assert.match(agreementStands(agreement({ tranches: agreement().tranches.slice(0, 3) })).why, /4 tranches/);
  assert.match(agreementStands(agreement({ base: { targetBps: 9500, cliffBlocks: 0, days: 1 } })).why, /more than the whole set/);
  assert.match(agreementStands(agreement({ siteKeys: [SITE[0], SITE[0]] })).why, /named twice/);
  const leave = { agreementId: contributionAgreementId(a), atHeight: 5000 };
  assert.deepEqual(decodeContributionLeave(encodeContributionLeave(leave)), leave);
  const term = { agreementId: contributionAgreementId(a), atHeight: 6000, cause: 'breach of the non-compete' };
  assert.deepEqual(decodeContributionTermination(encodeContributionTermination(term)), term);
});

test('the base: nothing before the cliff, the days passed at once at the cliff, then target / days a day', () => {
  const a = agreement();
  assert.equal(baseVestedBps(a, START + 26279), 0);
  assert.equal(baseVestedBps(a, START + 26280), Math.trunc(250 * Math.floor(26280 / 144) / 730), '182 days at once');
  assert.equal(baseVestedBps(a, START + 730 * 144), 250);
  assert.equal(baseVestedBps(a, START + 10 * 730 * 144), 250, 'never past the target');
});

test('T1 and T2: 1,000 identities whose first paid entry carried his keys; 300 of them back 4 weeks later - every seat the same height', () => {
  const a = agreement({ base: { targetBps: 0, cliffBlocks: 0, days: 1 } });
  // 1,200 newcomers through his links, two a block from START; 400 of them play again 4,032 blocks after their first
  const firsts = newcomers({ n: 1200, from: START, step: 1, mine: 1, of: 1 });
  const again = firsts.slice(0, 400).map((f) => ({ ...f, height: f.height + RETENTION_BLOCKS + 10, frontendPk: PROJECT }));
  // an identity that played before the agreement started never counts as his, whatever link it uses later
  const old = [{ height: START - 50, identity: id(5000), frontendPk: PROJECT, grossMsat: 1n }, { height: START + 5, identity: id(5000), frontendPk: SITE[0], grossMsat: 1n }];
  const facts = [...firsts, ...again, ...old];
  const at = (h) => contributionShare(a, { facts, height: h, network: 'testnet4' });
  const t1 = START + 999;   // the 1,000th
  assert.equal(at(t1 - 1).tranches[0].vested, false);
  assert.equal(at(t1).tranches[0].vestedAt, t1);
  assert.equal(at(t1).shareBps, 250);
  const t2 = firsts[299].height + RETENTION_BLOCKS + 10;
  assert.equal(at(t2).tranches[1].vestedAt, t2);
  assert.equal(at(t2).shareBps, 500);
  assert.equal(at(t2).tranches[2].metAt, null, 'T3 is mainnet\'s only');
  // two seats holding the same facts in another order answer the same
  const shuffled = [...facts].reverse();
  for (const h of [t1, t2, t2 + 50000]) assert.deepEqual(contributionShare(a, { facts: shuffled, height: h, network: 'testnet4' }), at(h));
});

test('the attribution floor: a tranche whose window holds under 30 % of new identities from his keys does not vest', () => {
  const a = agreement({ base: { targetBps: 0, cliffBlocks: 0, days: 1 } });
  // 1,000 of his among 4,000 newcomers (25 %) in the window: T1's milestone is met, the floor is not
  const facts = newcomers({ n: 4000, from: START, step: 1, mine: 1, of: 4 });
  const r = contributionShare(a, { facts, height: START + 20000, network: 'testnet4' });
  assert.notEqual(r.tranches[0].metAt, null, 'the milestone is met');
  assert.equal(r.tranches[0].vestedAt, null, 'the floor holds it back');
  assert.equal(r.shareBps, 0);
  // the same 1,000 among 3,000 (33 %): it vests
  const ok = contributionShare(a, { facts: newcomers({ n: 3000, from: START, step: 1, mine: 1, of: 3 }), height: START + 20000, network: 'testnet4' });
  assert.notEqual(ok.tranches[0].vestedAt, null);
});

test('T3 on mainnet: one season window with his entries\' gross at 20 % of all; T4: six 30-day windows with 30 % of the new identities his', () => {
  const a = agreement({ base: { targetBps: 0, cliffBlocks: 0, days: 1 }, attributionFloorBps: 0 });
  // six windows of 4,320 blocks, 10 newcomers each, 4 of them his (40 %); gross per entry equal, so 40 % of the gross too
  const facts = [];
  for (let k = 0; k < 6; k++) facts.push(...newcomers({ n: 10, from: START + k * T4_WINDOW_BLOCKS + 5, step: 100, mine: 4, of: 10, base: 100 * k }));
  const r = contributionShare(a, { facts, height: START + 6 * T4_WINDOW_BLOCKS, network: 'mainnet' });
  assert.equal(r.tranches[3].vestedAt, START + 6 * T4_WINDOW_BLOCKS - 1, 'T4 at the sixth window\'s last block');
  assert.equal(r.tranches[2].vestedAt, START + 12960 - 1, 'T3 at the season window\'s last block');
  // a window under 30 % breaks the run
  const broken = facts.map((f, i) => (i >= 20 && i < 30 ? { ...f, frontendPk: PROJECT } : f));
  assert.equal(contributionShare(a, { facts: broken, height: START + 6 * T4_WINDOW_BLOCKS, network: 'mainnet' }).tranches[3].vestedAt, null);
  assert.equal(contributionShare(a, { facts, height: START + 6 * T4_WINDOW_BLOCKS, network: 'testnet4' }).tranches[2].vestedAt, null, 'T3 not on testnet4');
});

test('leaving: the unvested part lapses, the vested part pays for the tail and ends; a termination ends it at once; a tranche lapses at its expiry', () => {
  const a = agreement({ base: { targetBps: 0, cliffBlocks: 0, days: 1 } });
  const facts = newcomers({ n: 1200, from: START, step: 1 });
  const t1 = START + 999;
  const L = t1 + 100;
  // he leaves after T1; the T2 milestone (retention) would come later and lapses
  const later = facts.slice(0, 400).map((f) => ({ ...f, height: f.height + RETENTION_BLOCKS + 10 }));
  const all = [...facts, ...later];
  assert.equal(contributionShare(a, { facts: all, height: L + 10, network: 'testnet4', leftAt: L }).shareBps, 250, 'the tail pays what was vested');
  assert.equal(contributionShare(a, { facts: all, height: L + 10, network: 'testnet4', leftAt: L }).state, 'tail');
  assert.equal(contributionShare(a, { facts: all, height: L + 52560, network: 'testnet4', leftAt: L }).shareBps, 0, 'then it ends');
  assert.equal(contributionShare(a, { facts: all, height: START + 60000, network: 'testnet4', leftAt: L }).tranches[1].vested, false, 'T2 after the leave lapses');
  const T = t1 + 50;
  assert.equal(contributionShare(a, { facts: all, height: T, network: 'testnet4', terminatedAt: T }).shareBps, 0, 'a termination ends the vested part at once');
  assert.equal(contributionShare(a, { facts: all, height: T - 1, network: 'testnet4', terminatedAt: T }).shareBps, 250);
  const short = agreement({ base: { targetBps: 0, cliffBlocks: 0, days: 1 }, tranches: agreement().tranches.map((t) => ({ ...t, expiresHeight: START + 500 })) });
  assert.equal(contributionShare(short, { facts: all, height: START + 3000, network: 'testnet4' }).shareBps, 0, 'T1 met after its expiry lapses');
});

test('the set pays his vested share; what he has not vested goes to the others in their proportions', () => {
  const r = (i, bps, contribution = null) => ({ recipientPk: key33(i), label: `r${i}`, shareBps: bps, ...(contribution ? { contribution } : {}) });
  const set = [r(2, 6000), r(3, 4000), r(1, 0, agreement())];
  assert.deepEqual(contributionShares(set, () => 0).map((x) => x.shareBps), [6000, 4000, 0]);
  assert.deepEqual(contributionShares(set, () => 500).map((x) => x.shareBps), [5700, 3800, 500]);
  assert.deepEqual(contributionShares(set, () => 1250).map((x) => x.shareBps), [5250, 3500, 1250]);
  assert.equal(contributionShares(set, () => 333).reduce((t, x) => t + x.shareBps, 0), 10000, 'always the whole set');
  const plain = [r(2, 6000), r(3, 4000)];
  assert.equal(contributionShares(plain, () => 999), plain, 'a set without agreements is answered as it is');
});

test('the facts: paid entries booked to a proven identity in counted rounds, at the round\'s census height', () => {
  const idk = toHex(k32('ident', 1)), rk = toHex(k32('rk', 1)), rk2 = toHex(k32('rk', 2));
  const rounds = [
    { roundId: 'aa'.repeat(32), void: false, entries: [
      { player: idk, roundKey: rk, stakeMsat: 100000n, frontendPk: toHex(SITE[0]) },
      { player: rk2, roundKey: rk2, stakeMsat: 100000n },                 // a bare round key: no identity proven
      { player: idk, roundKey: rk, stakeMsat: 100000n, bot: true },       // the test bot
      { player: idk, roundKey: rk, stakeMsat: 0n } ] },                   // free
    { roundId: 'bb'.repeat(32), void: true, entries: [{ player: idk, roundKey: rk, stakeMsat: 1n }] },
    { roundId: 'cc'.repeat(32), void: false, entries: [{ player: idk, roundKey: rk, stakeMsat: 5n }] },   // no height known
  ];
  const facts = factsFromSeasonRounds(rounds, (rid) => (rid === 'aa'.repeat(32) ? 4321 : null));
  assert.deepEqual(facts, [{ height: 4321, identity: idk, frontendPk: toHex(SITE[0]), grossMsat: 100000n }]);
});
