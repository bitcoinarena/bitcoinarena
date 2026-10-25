// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE KEY FROM THE 24 WORDS (kanban #650): shown only while the node still signs with a key its words cannot give (2026-10-25:
// "Only display the option to switch when we still have a node.db otherwise it won't show") - checked on load, the move on its button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KeySwitchPanel } from '../dist/test/keyswitch.mjs';

const plan = { keyNow: 'aa'.repeat(32), keyNext: 'bb'.repeat(32), bondSats: '50000', fees: '420', oldBonds: [{ txid: '77'.repeat(32), vout: 0, sats: '50000', maturity: 157057 }] };
const panel = (answers) => {
  const sent = [];
  const api = { signed: async (a, args) => ({ a, args }), post: async (p, b) => { sent.push([p, b.a, b.args.post]); return answers.shift(); } };
  const c = new KeySwitchPanel({ api });
  c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); };
  return { c, sent, html: () => renderToStaticMarkup(React.createElement(KeySwitchPanel, { initial: { ...c.state } })) };
};

test('nothing shown while it checks, when the key is the words\' already, or the move is not open to this node', async () => {
  for (const answer of [{ ok: true, already: true, key: 'bb'.repeat(32) }, { ok: false, why: 'this node runs on your Nostr key: its key is your nsec, not your 24 words' },
    { ok: false, why: 'a guardian keeps its key while it holds a seat' }]) {
    const p = panel([answer]);
    assert.equal(p.html(), '', 'checking: nothing');
    await p.c.componentDidMount();
    assert.equal(p.c.state.step, 'hidden', 'checked');
    assert.equal(p.html(), '', `nothing for: ${answer.why || 'already'}`);
  }
});

test('a node with its own random key: the plan, then the move, signed; a short wallet says what it needs', async () => {
  const p = panel([{ ok: true, plan }, { ok: true, bond: { txid: 'cc'.repeat(32) }, restarting: true }]);
  await p.c.componentDidMount();
  assert.match(p.html(), /A new bond of <b>50,000 sat<\/b>[\s\S]*until block 157,057[\s\S]*Move to the key from my words/);
  await p.c.move();
  assert.deepEqual(p.sent, [['/owner/key-from-words', 'key-from-words', false], ['/owner/key-from-words', 'key-from-words', true]]);
  assert.match(p.html(), /Done\. Your node now uses the key from your 24 words[\s\S]*cccccccccccccccc…/);
  const short = panel([{ ok: false, why: 'the wallet holds no coins yet - the new bond needs 50000 sat plus fees in the node\'s wallet (tb1qx)' }]);
  await short.c.componentDidMount();
  assert.match(short.html(), /needs 50000 sat plus fees in the node&#x27;s wallet \(tb1qx\)/);
});
