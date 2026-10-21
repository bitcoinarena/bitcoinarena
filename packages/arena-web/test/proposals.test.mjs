// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PROPOSALS FORUM'S READING VIEWS IN REACT (kanban #564): the thread list with its PIPs, amounts, replies and stages; one thread with
// the proposal's own HTML, its facts, the replies nested by depth with a Reply each, and the reply form - a reply to the post whose
// Reply was pressed, the form emptied when the nodes took it, kept with the reason when they did not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProposalList, ProposalThread, SignedIn, ReserveBalance, Empty } from '../dist/test/proposals.mjs';

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

test('a new proposal: the reserves and the cap, the amount checked as typed, the length counted, refused before signing, then published', async () => {
  const { NewProposal, amountCheck } = await import('../dist/test/proposals.mjs');
  const R = { sats: 114000, agreeing: 14, asked: 14 };
  assert.deepEqual(amountCheck({ amount: '20000' }, R, 10), [false, '20,000 sat is more than 10% of the reserves (11,400 sat): it could never be paid.', true]);
  assert.deepEqual(amountCheck({ amount: '1000', lnurl: 'not an address' }, R, 10)[1], 'That is not a Lightning address (you@wallet.example) or an LNURL.');
  assert.deepEqual(amountCheck({ amount: '1140', lnurl: 'you@wallet.example' }, R, 10), [true, 'Within the cap: 1.00% of the reserves.', false]);
  assert.equal(amountCheck({ amount: '5' }, null, 10)[1], 'The reserves could not be read, so the amount cannot be checked yet.');
  const sent = [];
  const props = { reserves: R, capPct: 10, types: [['#new', 'Payout to Lightning address'], ['#new-fees', 'Change fees']], hash: '#new', markdown: (s) => `<p>${s}</p>`, signedIn: true,
    purposeLength: (t, c, i) => `${t}\n\n${c}\n\n${i}`.length, onPublish: async (x) => { sent.push(x); return { ok: true, say: 'Published to 14 of 14 nodes. Its 1-week signal starts now.' }; } };
  const h = renderToStaticMarkup(React.createElement(NewProposal, props));
  assert.match(h, /The protocol reserves hold <b>114,000 sat<\/b> \(14 of 14 nodes agree\)\. A proposal may ask at most <b>10%: 11,400 sat<\/b>\./);
  assert.match(h, /<a class="type on" href="#new" role="radio" aria-checked="true">Payout to Lightning address<\/a><a class="type" href="#new-fees"/);
  assert.match(h, /4 of 4,000 characters/);
  const f = new NewProposal(props); f.setState = (u) => Object.assign(f.state, typeof u === 'function' ? u(f.state) : u);
  await f.submit({ preventDefault() {} });
  assert.equal(f.state.say, 'Fill in the title, what it does, and how it improves Bitcoin Arena.');
  Object.assign(f.state, { title: 'A leaderboard', content: 'Pay the top 3', improves: 'More players', amount: '1140', lnurl: '' });
  await f.submit({ preventDefault() {} });
  assert.equal(f.state.say, 'Name the Lightning address to pay.'); assert.equal(sent.length, 0);
  f.state.lnurl = 'you@wallet.example';
  await f.submit({ preventDefault() {} });
  assert.deepEqual(sent, [{ title: 'A leaderboard', content: 'Pay the top 3', improves: 'More players', amount: 1140, lnurl: 'you@wallet.example' }]);
  assert.deepEqual([f.state.bad, f.state.say], [false, 'Published to 14 of 14 nodes. Its 1-week signal starts now.']);
  const out = new NewProposal({ ...props, signedIn: false }); out.setState = (u) => Object.assign(out.state, u);
  await out.submit({ preventDefault() {} }); assert.match(out.state.say, /^Open the Arena once first/);
});

test('change fees: the fees in force with their limits, only typed fees checked by the page\'s rule, a reason required, then published', async () => {
  const { FeesProposal } = await import('../dist/test/proposals.mjs');
  const feeVal = (k, v) => (k.endsWith('Bps') ? `${Number(v) / 100} %` : `${v} %`);
  const data = { tip: 157205, agreeing: 14, asked: 14, sums: { roundMaxBps: 1000, itemPct: 100, marketMaxBps: 100 }, earliest: 158213,
    keys: ['roundNodeBps', 'roundDonationBps'], names: { roundNodeBps: 'Game round: node fee', roundDonationBps: 'Game round: developers\' donation' }, units: { roundNodeBps: 'bps', roundDonationBps: 'bps' },
    fees: { roundNodeBps: 400, roundDonationBps: 400 }, limits: { roundNodeBps: { min: 100, max: 800 }, roundDonationBps: { min: 1, max: 800, donation: true } },
    proposals: [{ id: 'ab'.repeat(32), changes: [{ fee: 'roundNodeBps', from: 400, to: 500 }], signal: { state: 'open' }, needsDevs: false, purpose: 'More for nodes' }] };
  const checks = [], sent = [];
  const props = { data, types: [['#new', 'Payout'], ['#new-fees', 'Change fees']], hash: '#new-fees', feeVal, markdown: (s) => `<p>${s}</p>`, signedIn: true,
    check: (typed, activation, purpose) => { checks.push([typed, activation]); return typed.roundNodeBps ? { changes: [{ fee: 'roundNodeBps', to: Number(typed.roundNodeBps) }], say: '1 fee in one proposal.', bad: false } : { changes: null, say: 'Change at least one fee.', bad: false }; },
    onPublish: async (x) => { sent.push(x); return { ok: true, say: 'Published to 14 of 14 nodes. Its signal starts now.' }; } };
  const h = renderToStaticMarkup(React.createElement(FeesProposal, props));
  assert.match(h, /Fees in force at block 157205 \(14 of 14 nodes agree\)\. Fill in only the fees to change/);
  assert.match(h, /<td>Game round: developers&#x27; donation<span class="hint"> donation<\/span><\/td><td>4 %<\/td><td>0.01 % – 8 %<\/td>/);
  assert.match(h, /<input[^>]*name="activation"[^>]*>/); assert.match(h.match(/<input[^>]*name="activation"[^>]*>/)[0], /min="158213"/); assert.match(h.match(/<input[^>]*name="activation"[^>]*>/)[0], /value="158213"/);
  assert.match(h, /<li>Game round: node fee: 4 % → 5 %<\/li>/);
  assert.equal(checks.length, 0, 'nothing typed: nothing checked');
  const f = new FeesProposal(props); f.setState = (u) => Object.assign(f.state, typeof u === 'function' ? u(f.state) : u);
  await f.submit({ preventDefault() {} }); assert.equal(f.state.say, 'Change at least one fee.');
  f.state.typed = { roundNodeBps: '500' }; await f.submit({ preventDefault() {} });
  assert.equal(f.state.say, 'Say why: a proposal always gives its reason.'); assert.equal(sent.length, 0);
  f.state.purpose = 'More for nodes'; await f.submit({ preventDefault() {} });
  assert.deepEqual(sent, [{ changes: [{ fee: 'roundNodeBps', to: 500 }], activation: 158213, purpose: 'More for nodes' }]);
  assert.match(renderToStaticMarkup(React.createElement(FeesProposal, { ...props, data: null, error: 'no node answered /fees' })), /<div class="empty">no node answered \/fees<\/div>/);
});

test('a leaderboard payout: each federation\'s reserves and cap, the form, the page\'s check as typed, the amount and reason required, the requests', async () => {
  const { PayoutProposal } = await import('../dist/test/proposals.mjs');
  const data = { feds: [{ id: '337ae01a'.padEnd(64, '0'), held: 114, max: 11 }], tip: 157205, topMax: 50, periods: [7, 14, 30], defaultDate: '2026-11-05', listEmpty: 'No leaderboard payouts yet.',
    list: [{ id: 'l1', title: 'Top 10 · 10 sat', vote: 'open · YES 0 % of the voting weight (25 % passes)', line: 'all games and markets · last 7 days · paid at block 158000 from 337ae01a · equal', purpose: 'test' }] };
  const sent = [];
  const props = { data, types: [['#new', 'Payout'], ['#new-leaderboard', 'Leaderboard payout']], hash: '#new-leaderboard', markdown: (s) => `<p>${s}</p>`, signedIn: true,
    check: (v) => (Number(v.amount) > 11 ? { ok: false, why: `${v.amount} sat is more than 10 % of that federation's reserves (11 sat): it could never be paid.` }
      : { ok: true, request: { amountSats: v.amount ? Number(v.amount) : 0, purpose: v.purpose, top: Number(v.top), federationId: v.fed }, say: `Pays the top ${v.top} at block 160000, equal.` }),
    onPublish: async (b) => { sent.push(b); return { ok: true, say: 'Published to 14 of 14 nodes. Its 2-week vote starts now.' }; } };
  const h = renderToStaticMarkup(React.createElement(PayoutProposal, props));
  assert.match(h, /<div class="avail-name">Federation 337ae01a<\/div><div class="avail-row"><span>Reserves now<\/span><b>114 sat<\/b><\/div><div class="avail-row"><span>Max for one payout \(10 %\)<\/span><b class="max">11 sat<\/b>/);
  assert.match(h.match(/<input[^>]*name="game"[^>]*>/)[0], /disabled=""/, 'all games: no name');
  assert.match(h, /<option value="30">last month \(30 days\)<\/option>/);
  assert.match(h, /<b>Top 10 · 10 sat<\/b><span class="say">open · YES 0 % of the voting weight/);
  const f = new PayoutProposal(props); f.setState = (u) => Object.assign(f.state, typeof u === 'function' ? u(f.state) : u);
  assert.equal(f.state.fed, data.feds[0].id); assert.equal(f.state.date, '2026-11-05');
  f.state.amount = '50'; await f.submit({ preventDefault() {} });
  assert.match(f.state.say, /more than 10 % of that federation's reserves \(11 sat\)/);
  f.state.amount = '10'; await f.submit({ preventDefault() {} }); assert.equal(f.state.say, 'Say why: a proposal always gives its reason.');
  f.state.purpose = 'the best of the week'; await f.submit({ preventDefault() {} });
  assert.deepEqual(sent, [{ amountSats: 10, purpose: 'the best of the week', top: 10, federationId: data.feds[0].id }]);
  assert.match(renderToStaticMarkup(React.createElement(PayoutProposal, { ...props, data: null })), /Reading the nodes…/);
});

test('the forum\'s key line, its reserves on top and a line in place of the view, in React', () => {
  const r = (c, p) => renderToStaticMarkup(React.createElement(c, p));
  assert.equal(r(SignedIn, { name: 'satoshi', npub: 'npub1x' }), 'Signed in as <b title="npub1x">satoshi</b> · your in-game key and name');
  assert.match(r(SignedIn, {}), /^Read freely\. To post, open the Arena once/);
  assert.equal(r(ReserveBalance, { reserves: { sats: 1234567, agreeing: 5, asked: 7 }, capPct: 10 }),
    '<span class="lbl">Protocol reserves</span><b class="sats">1,234,567 sat</b><span class="sub">5 of 7 nodes agree · a PIP may ask up to 123,456 sat</span>');
  assert.match(r(ReserveBalance, { reserves: null, why: 'no seat answered', capPct: 10 }), /<b class="sats">–<\/b><span class="sub">could not be read: no seat answered<\/span>/);
  assert.match(r(ReserveBalance, { reserves: null, capPct: 10 }), /<span class="sub">reading the nodes<\/span>/);
  assert.equal(r(Empty, { text: 'could not load x <b>' }), '<div class="empty">could not load x &lt;b&gt;</div>');
});
