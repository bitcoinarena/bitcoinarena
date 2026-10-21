// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LEAVE IN REACT (kanban #564): before leaving - what changes, the bond's lock in blocks and days (kanban #553), the custody rule, Leave only
// once understood and allowed; leaving - the rounds it still finishes, when it is free, Stay; a refusal said; the read failing said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LeavePanel } from '../dist/test/leave.mjs';

const lock = { maturity: 158000, blocksLeft: 1200, estimatedMs: Date.now() + 50 * 3600000, withdrawable: false };
const leave = { leaving: false, owed: 3, freeNow: false, freeAtMs: Date.UTC(2026, 9, 22, 6), custody: { guardian: false } };
function panel(props) {
  const acts = [];
  const m = new LeavePanel({ leave, bond: { bond: { sats: '50000' }, lock }, act: async (a) => { acts.push(a); if (props && props.refuse) throw new Error('the seat refused'); }, ...props });
  m.setState = (u) => Object.assign(m.state, typeof u === 'function' ? u(m.state) : u);
  return { m, acts, html: () => renderToStaticMarkup(React.createElement(React.Fragment, null, m.render())) };
}

test('before leaving: what changes, the bond locked in blocks and days, Leave only once understood', async () => {
  const p = panel();
  const h = p.html();
  assert.match(h, /<li><b>Your bond is not paid back at once\.<\/b> Your bond stays locked until block <b>158000<\/b>: <b>1,200 blocks<\/b> from now, about <b>2 days 2 h<\/b>/);
  assert.match(h, /Keep the node running until it has finished its rounds \(3 now; free to switch off 2026-10-22 06:00 UTC\)\./);
  assert.match(h, /, and my bond stays locked until block 158000 - 1,200 blocks, about 2 days 2 h\.<\/span><\/label>/);
  assert.match(h, /<button type="button" class="primary" id="go" disabled="">Leave the network<\/button>$/);
  p.m.setState({ ok: true });
  assert.match(p.html(), /<button type="button" class="primary" id="go">Leave the network<\/button>$/);
  await p.m.act('leave');
  assert.deepEqual(p.acts, ['leave']);
});

test('custody: allowed or not by the federation\'s threshold; leaving: what it finishes, Stay; a refusal and a failed read said', async () => {
  const held = panel({ leave: { ...leave, custody: { guardian: true, allowed: false } } });
  held.m.setState({ ok: true });
  assert.match(held.html(), /<b>its federation would not keep enough guardians without it, so it may not leave yet\.<\/b>.*id="go" disabled="">/);
  const going = panel({ leave: { ...leave, leaving: true, leavingAtMs: Date.UTC(2026, 9, 21, 18), freeNow: true } });
  assert.match(going.html(), /^<p class="answer"><b>This node is leaving<\/b> \(since 2026-10-21 18:00 UTC\)\.<\/p><div class="row"><span>Rounds it still finishes<\/span><b>3<\/b><\/div><div class="row"><span>Free to switch off<\/span><b>now<\/b><\/div>/);
  const no = panel({ leave: { ...leave, leaving: true, leavingAtMs: 0 }, refuse: true });
  await no.m.act('stay');
  assert.match(no.html(), /<div class="err" id="lerr">the seat refused<\/div><button type="button" id="stay">Stay: take rounds again<\/button>/);
  assert.equal(renderToStaticMarkup(React.createElement(LeavePanel, { why: 'Failed to fetch', act() {} })), '<p class="err">Failed to fetch</p>');
  assert.match(panel({ bond: { bond: { sats: '1' }, lock: { ...lock, withdrawable: true } } }).html(), /Your bond is already unlocked \(since block 158000\)/);
  assert.match(panel({ bond: null }).html(), /This node has no bond in the census\./);
});
