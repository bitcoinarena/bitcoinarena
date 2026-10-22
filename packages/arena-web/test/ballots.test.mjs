// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEVELOPERS' BALLOT IN REACT (kanban #564): the set in force; a proposal's state, votes and Accept / Deny only for this node's dev
// clients that are recipients and have not voted; the split proposed from the set in force, its sum and keys checked before it is signed;
// a fee proposal's changes with Approve / Deny for the clients that have not answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BallotsPanel } from '../dist/test/ballots.mjs';

const KA = '02' + 'aa'.repeat(32), KB = '03' + 'bb'.repeat(32);
const donations = { sets: [{ kind: 'protocol', serial: 4, recipients: [{ key: KA, label: 'dev a', shareBps: 6000 }, { key: KB, label: 'dev b', shareBps: 4000 }] }] };
const dev = { clients: [{ slug: 'deva', label: 'dev a', recipientPk: KA }] };
const ballots = { ballots: [{ id: 'p1'.repeat(16), serial: 5, state: 'open', acceptBps: 4000, proposer: KB,
  recipients: [{ key: KA, label: 'dev a', shareBps: 5000 }, { key: KB, label: 'dev b', shareBps: 5000, vesting: { targetBps: 6000, days: 30, startHeight: 158000 } }],
  votes: [{ key: KB, bps: 4000, accept: true, atHeight: 157230 }] }] };
const fees = { proposals: [{ id: 'f1'.repeat(16), needsDevs: true, changes: [{ fee: 'protocolDonationBps', donation: true, from: 200, to: 300 }], activationHeight: 160000, devs: [] }] };
function panel(over = {}) {
  const calls = { vote: [], fee: [], propose: [], reread: 0 };
  const m = new BallotsPanel({ ballots, donations, dev, fees, vote: async (...a) => calls.vote.push(a), feeAnswer: async (...a) => calls.fee.push(a),
    propose: async (...a) => calls.propose.push(a), reread: () => { calls.reread++; }, ...over });
  m.setState = (u) => Object.assign(m.state, typeof u === 'function' ? u(m.state) : u);
  return { m, calls, html: () => renderToStaticMarkup(React.createElement(React.Fragment, null, m.render())) };
}

test('the set in force, a proposal with its votes and vesting, Accept / Deny only for a client that has not voted, a fee proposal', async () => {
  const p = panel();
  const h = p.html();
  assert.match(h, /<h3>In force: serial 4<\/h3><div class="split-bar">.*?<\/div><div class="row"><span>dev a <span class="sub">02aaaaaaaaaa…<\/span><\/span><b>60 %<\/b>/);
  assert.match(h, /<h3>Proposal · serial 5 <span class="sub">p1p1p1p1p1p1<\/span><\/h3><div class="row"><span>State<\/span><b>open · 40 % accepted, more than 50 % needed<\/b>/);
  assert.match(h, /<b>50 % → 60 % over 30 days from block 158000<\/b>/);
  assert.match(h, /<span>dev b \(40 %\)<\/span><b><span class="ok">accepted<\/span> · block 157230<\/b>/);
  assert.match(h, /<button type="button" class="primary">Accept as dev a<\/button><button type="button">Deny as dev a<\/button>/);
  assert.doesNotMatch(h, /Accept as dev b/, 'dev b is no client of this node');
  assert.match(h, /<span>protocol donation <span class="sub">donation<\/span><\/span><b>2 % → 3 %<\/b>/);
  assert.match(h, /Approve as dev a/);
  await p.m.act('x', () => p.m.props.vote('deva', 'p1'.repeat(16), true));
  assert.deepEqual([p.calls.vote, p.calls.reread], [[['deva', 'p1'.repeat(16), true]], 1]);
  await p.m.act('y', async () => { throw new Error('already voted'); });
  assert.equal(p.m.state.said.y, 'already voted');
});

test('propose: starts from the set in force; the shares must make 100 % and every key be a 33-byte key, then it is signed', async () => {
  const p = panel();
  assert.deepEqual(p.m.state.rows.map((r) => [r.key.slice(0, 4), r.share]), [['02aa', '60'], ['03bb', '40']]);
  p.m.state.rows[0].share = '50';
  await p.m.propose();
  assert.equal(p.m.state.proposeWhy, 'the shares add up to 90 %, not 100 %');
  p.m.state.rows.push({ key: 'nothex', label: 'dev c', share: '10', vest: '', days: '' });
  await p.m.propose();
  assert.equal(p.m.state.proposeWhy, 'every key is 66 hex characters starting 02 or 03');
  p.m.state.rows[2] = { key: '02' + 'cc'.repeat(32), label: 'dev c', share: '10', vest: '20', days: '30' };
  await p.m.propose();
  assert.deepEqual(p.calls.propose, [['deva', [{ key: KA, label: 'dev a', shareBps: 5000 }, { key: KB, label: 'dev b', shareBps: 4000 },
    { key: '02' + 'cc'.repeat(32), label: 'dev c', shareBps: 1000, vestBps: 2000, vestDays: 30 }]]]);
  assert.match(panel({ dev: { clients: [] } }).html(), /^<div class="card"><h3>In force/);
  assert.doesNotMatch(panel({ dev: { clients: [] } }).html(), /Propose a new split/, 'no recipient client here, no form');
  assert.equal(renderToStaticMarkup(React.createElement(BallotsPanel, { why: 'no answer' })), '<div class="card"><p class="err">no answer</p></div>');
});

test('the split form, pretty: a row per developer with a select of the known developers, the share in %, vesting optional, the total live as a bar (kanban #578)', () => {
  const p = panel();
  let h = p.html();
  assert.match(h, /<div class="card split"><h3>Propose a new split<\/h3>/);
  assert.match(h, /<div class="split-total ok">Total 100 % ✓<\/div>/);
  assert.match(h, /<select><option value="02a{64}" selected="">dev a<\/option><option value="03b{64}">dev b<\/option><option value="">Another key…<\/option><\/select><small title="02a{64}">02aaaaaaaaaaaaaa…<\/small>/);
  assert.doesNotMatch(h, /placeholder="02… or 03… \(66 hex\)"/, 'a known developer needs no key typed');
  assert.match(h, /<button type="button" class="primary" id="pgo">Propose<\/button>/);
  p.m.state.rows[1].share = '30';
  h = p.html();
  assert.match(h, /<div class="split-total warn">Total 90 % · 10 % left to give<\/div>/);
  assert.match(h, /<button type="button" class="primary" id="pgo" disabled="">Propose<\/button>/, 'Propose waits for 100 %');
  p.m.state.rows.push({ key: '', label: '', share: '10', vest: '', days: '', other: true });
  h = p.html();
  assert.match(h, /<option value="" selected="">Another key…<\/option><\/select><input[^>]*placeholder="02… or 03… \(66 hex\)"/, 'another key: typed, with its label');
  assert.match(h, /<div class="split-total ok">Total 100 % ✓<\/div>/);
  assert.match(h, /<h3>In force: serial 4<\/h3><div class="split-bar"><i title="dev a: 60 %" style="width:60%;background:var\(--st\)"><\/i>/);
});

test('open proposals on top: the open part has only the open ones under its heading, the rest everything else (kanban #578)', () => {
  const open = panel({ part: 'open' }).html(), rest = panel({ part: 'rest' }).html();
  assert.match(open, /^<h3 class="sh open-head">Open proposals · your vote counts<\/h3><div class="card open-prop"><h3>Proposal · serial 5/);
  assert.match(open, /Fee proposal/, 'an undecided fee proposal is open too');
  assert.doesNotMatch(open, /In force: serial|Propose a new split/);
  assert.doesNotMatch(rest, /Proposal · serial 5|Fee proposal/);
  assert.match(rest, /^<div class="card"><h3>In force: serial 4/);
  assert.equal(panel({ part: 'open', ballots: { ballots: [] }, fees: { proposals: [] } }).html(), '', 'nothing open, nothing drawn');
});
