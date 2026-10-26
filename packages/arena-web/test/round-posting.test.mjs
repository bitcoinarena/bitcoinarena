// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ROUND POSTING ON THE OWNER PAGE (kanban #702): one line from the node's own GET /duty - on, off, or on but unable to pay - with this node's
// place in today's duty order, what it posted and the last error; nothing at all from a node that answers no GET /duty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoundPosting, postingWords } from '../dist/test/round-posting.mjs';

const K = (i) => String(i).repeat(64);
const DUTY = { ok: true, node: K(2), nowMs: '1', setting: 'auto', on: true, feeRate: 0.1, maxFeeRate: 1, rankCap: 2,
  wallet: { canPay: true, why: null, confirmedSats: 12345, wallet: 'arena' },
  days: [{ slot: 20751, covers: '2026-10-26', period: 'today', order: [{ rank: 1, key: K(1), self: false }] },
    { slot: 20752, covers: '2026-10-27', period: 'next', order: [{ rank: 1, key: K(1), self: false }, { rank: 2, key: K(2), self: true, dueFrom: '2026-10-26T01:00:00.000Z', backupDueFrom: '2026-10-26T02:00:00.000Z' }] }],
  mine: { posted: [{ app: 'rps', slot: 20751, txid: 'ab'.repeat(32), emergency: false, atMs: '1' }], wouldPost: [] }, lastError: null };

test('on: the wallet can pay, this node\'s rank in today\'s duty, what it posted', () => {
  const html = renderToStaticMarkup(React.createElement(RoundPosting, { initial: { loaded: true, duty: DUTY } }));
  assert.match(html, /Round posting<\/span><b class="ok">on - the wallet &quot;arena&quot; can pay \(12,345 sat confirmed\), at 0\.1 sat\/vB, at most 1<\/b>/);
  // the backup this node owes (the owner's ruling, 2026-10-26 ~11:4xZ: rank 2 posts the day's backup grid from 02:00 UTC)
  assert.match(html, /Today&#x27;s duty \(the rounds of 2026-10-27\): this node is rank 2: it posts today&#x27;s backup grid from 02:00 UTC, and the primary from 01:00 UTC if nobody before it has posted\./);
  assert.match(html, /Posted by this node: rps ababababab\./);
  const day = (me) => ({ ...DUTY, days: [{ ...DUTY.days[1], order: [me] }], mine: { posted: [{ app: 'updown', role: 'backup', txid: 'cd'.repeat(32) }] } });
  const first = postingWords(day({ rank: 1, key: K(2), self: true, dueFrom: '2026-10-26T00:00:00.000Z' }));
  assert.equal(first.more[0], 'Today\'s duty (the rounds of 2026-10-27): this node is rank 1: it posts the primary grid from 00:00 UTC.');
  assert.equal(first.more[1], 'Posted by this node: updown (backup) cdcdcdcdcd.');
  assert.match(postingWords(day({ rank: 3, key: K(2), self: true, dueFrom: '2026-10-26T02:00:00.000Z', backupDueFrom: '2026-10-26T03:00:00.000Z' })).more[0],
    /this node is rank 3: it posts the backup grid from 03:00 UTC if rank 2 has not, and the primary from 02:00 UTC if nobody before it has posted\.$/);
  assert.match(postingWords(day({ rank: 1, key: K(1), self: false })).more[0], /this node is not in the first 3: it posts nothing today\.$/);
});

test('off by the setting, off for want of coins, on but unable to pay, the last error; an old node shows nothing', () => {
  assert.equal(postingWords({ ...DUTY, setting: 'off', on: false }).head, 'off (duty_post=off in arena.conf)');
  assert.equal(postingWords({ ...DUTY, on: false, wallet: { canPay: false, why: 'the wallet holds no confirmed coins' } }).head, 'off: the wallet holds no confirmed coins');
  const w = postingWords({ ...DUTY, setting: 'on', wallet: { canPay: false, why: 'the chain is read through Electrum: no wallet' }, lastError: { atMs: '1', app: 'updown', role: 'backup', why: 'nothing published: census 157600 is on 1 of 7 seats' } });
  assert.equal(w.tone, 'warn');
  assert.match(w.head, /^on, but this node cannot pay: the chain is read through Electrum: no wallet\. When it is on duty the next node posts instead\.$/);
  assert.ok(w.more.includes('Last error (updown, backup): nothing published: census 157600 is on 1 of 7 seats'));
  assert.equal(renderToStaticMarkup(React.createElement(RoundPosting, { initial: { loaded: true, duty: null } })), '');
});

test('read from the node: a 404 (a release before it) leaves the line out', async () => {
  const c = new RoundPosting({ api: { get: async () => { throw new Error('404 no such door'); } } });
  c.setState = (u) => { Object.assign(c.state, u); };
  await c.componentDidMount();
  assert.deepEqual([c.state.loaded, c.state.duty], [true, null]);
  const d = new RoundPosting({ api: { get: async (p) => (p === '/duty' ? DUTY : null) } });
  d.setState = (u) => { Object.assign(d.state, u); };
  await d.componentDidMount();
  assert.equal(d.state.duty.node, K(2));
});
