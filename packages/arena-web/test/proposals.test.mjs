// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PROPOSALS FORUM'S READING VIEWS IN REACT (kanban #564): the thread list with its PIPs, amounts, replies and stages; one thread with
// the proposal's own HTML, its facts, the replies nested by depth with a Reply each, and the reply form - a reply to the post whose
// Reply was pressed, the form emptied when the nodes took it, kept with the reason when they did not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProposalList, ProposalThread } from '../dist/test/proposals.mjs';

const who = (name) => ({ name, npub: 'npub1' + name, avatar: { colour: 'hsl(10 70% 62%)', initial: name[0].toUpperCase() } });

test('the list: PIP, title, by, amount, replies, stage; nothing yet; still reading', () => {
  const h = renderToStaticMarkup(React.createElement(ProposalList, { status: '1 proposal · 5 of 5 nodes answered · block 157205',
    items: [{ pip: 3, href: '#pip=3', title: 'A leaderboard for Tick Tock', by: 'satoshi · block 157001 · to pay@x.example', amount: '50,000 sat', replies: '2', stage: { cls: 'on', text: 'Signalling' } }] }));
  assert.match(h, /<a class="topic" href="#pip=3"><span class="t"><span class="pip">PIP-3<\/span> A leaderboard for Tick Tock<span class="by">satoshi · block 157001 · to pay@x.example<\/span><\/span><span class="amt">50,000 sat<\/span><span class="n">2<\/span><span class="stage on">Signalling<\/span><\/a>/);
  assert.match(h, /<a class="btn primary grow" href="#new">New proposal<\/a>/);
  assert.match(renderToStaticMarkup(React.createElement(ProposalList, { status: 'x', items: [] })), /No proposals yet/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(ProposalList, { status: 'Reading the nodes…', items: null })), /No proposals yet/);
});

const THREAD = { heading: 'PIP-3 · A leaderboard', amount: '50,000 sat', lnurl: 'pay@x.example', stage: { cls: 'ok', text: 'Passed' }, stageLine: 'Vote until block 157400: YES 70%',
  post: { ...who('satoshi'), head: 'proposed at block 157001 · held by 5 nodes', html: '<p>The <b>plan</b></p>' },
  comments: [{ id: 'c1', depth: 1, ...who('hal'), head: 'block 157010', text: 'Why <b>now</b>?' }, { id: 'c2', depth: 2, ...who('nick'), head: 'block 157012', text: 'Because.' }] };

test('a thread: the proposal\'s HTML and facts, replies nested by depth as text, a Reply each, the form', () => {
  const h = renderToStaticMarkup(React.createElement(ProposalThread, { thread: THREAD, status: '', onReply: async () => ({ ok: true }) }));
  assert.match(h, /<h1>PIP-3 · A leaderboard<\/h1>/);
  assert.match(h, /<div class="body md"><p>The <b>plan<\/b><\/p><\/div><div class="facts"><span><b>50,000 sat<\/b> to pay@x.example<\/span><span class="stage ok">Passed<\/span>/);
  assert.match(h, /<article class="post reply" style="--depth:1">[\s\S]*<b title="npub1hal">hal<\/b> · block 157010[\s\S]*<div class="body">Why &lt;b&gt;now&lt;\/b&gt;\?<\/div>/, 'a reply is text');
  assert.match(h, /style="--depth:2"/);
  assert.equal((h.match(/>Reply<\/button>/g) || []).length, 2);
  assert.match(h, /placeholder="Write a reply"/);
  assert.match(renderToStaticMarkup(React.createElement(ProposalThread, { thread: null, status: 'That proposal is not held by five nodes.' })), /<div class="empty">That proposal is not held by five nodes\.<\/div>/);
});

test('a reply goes to the post whose Reply was pressed; taken: the form empties; refused: kept with why', async () => {
  const sent = []; let ok = false;
  const t = new ProposalThread({ thread: THREAD, onReply: async (text, parent) => { sent.push([text, parent]); return ok ? { ok: true, say: 'Posted to 5 of 5 nodes.' } : { ok: false, say: 'Not taken: too long' }; } });
  t.setState = (u) => Object.assign(t.state, typeof u === 'function' ? u(t.state) : u);
  Object.assign(t.state, { text: 'Agreed', replyTo: 'c1', replyName: 'hal' });
  assert.match(renderToStaticMarkup(t.render()), /placeholder="Reply to hal"/);
  await t.send({ preventDefault() {} });
  assert.deepEqual(sent, [['Agreed', 'c1']]); assert.deepEqual([t.state.text, t.state.bad, t.state.say], ['Agreed', true, 'Not taken: too long']);
  ok = true; await t.send({ preventDefault() {} });
  assert.deepEqual([t.state.text, t.state.replyTo, t.state.bad, t.state.say], ['', null, false, 'Posted to 5 of 5 nodes.']);
  t.state.text = '  '; await t.send({ preventDefault() {} }); assert.equal(sent.length, 2, 'nothing to send');
});
