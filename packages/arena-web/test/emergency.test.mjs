// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// "MY NODE IS OFFLINE" IN REACT (kanban #564): the three steps - a code the client cannot read is said at once and asks nothing; a code
// no census node names says so; the node found is shown with its roles and federations and the warning; the leave request is signed by
// the code's key at the node's tip, posted as hex, the key forgotten after; a refused post says why and lets it be tried again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmergencyPage, OUTCOMES } from '../dist/test/emergency.mjs';

const NODE = 'ab'.repeat(32);
const client = (log) => ({
  parseEmergencyCode: (s) => { if (!/^ARN-/.test(s)) throw new Error('an emergency code starts with ARN-'); return new Uint8Array([1, 2, 3]); },
  emergencySecret: (b) => ({ secretOf: [...b] }), pubkeyOf: () => 'pub', toHex: (x) => (typeof x === 'string' ? `hex(${x})` : 'hexbytes'), fromHex: (h) => `bytes(${h})`,
  signEmergencyDeparture: (d, sign) => { log.push(['sign', d]); return { ...d, signature: sign('msg') }; }, sign: (m, s) => { log.push(['by', m, s]); return 'sig'; },
  encodeEmergencyDeparture: () => 'departure' });
const page = (extra = {}) => { const p = new EmergencyPage({ dashboardHref: '/Dashboard', ...extra }); p.setState = (u) => Object.assign(p.state, typeof u === 'function' ? u(p.state) : u); return p; };
const named = { named: { node: NODE, endpoint: 'https://n.example', roles: ['game', 'verify'], guardianOf: ['337ae01a' + '0'.repeat(56)], held: false }, tip: 157210 };

test('step 1: the code, the warning about the 24 words, what leaving does by role', () => {
  const h = renderToStaticMarkup(React.createElement(EmergencyPage, { dashboardHref: '/Dashboard' }));
  assert.match(h, /<span class="now">1 Code<\/span><span>2 Confirm<\/span><span>3 Out<\/span>/);
  assert.match(h, /Never type your 24 words here/);
  assert.match(h, /<button type="submit" class="primary" disabled="">Find my node<\/button>/, 'nothing to find without a code');
  assert.equal(OUTCOMES.length, 3); assert.match(h, /<i class="bad">Bond: Slashed<\/i>/);
  assert.match(h, /href="\/Dashboard"/);
});

test('a code the client cannot read, and one no census node names, say so without going further', async () => {
  const asked = [];
  const p = page({ client: client([]), get: async (u) => { asked.push(u); return { named: null }; } });
  p.state.code = 'XYZ'; await p.find();
  assert.deepEqual([p.state.error, asked], ['an emergency code starts with ARN-', []]);
  p.state.code = 'ARN-AAAA'; await p.find();
  assert.deepEqual(asked, ['/emergency-departures?key=hex(pub)']);
  assert.match(p.state.error, /^No node of the census names this emergency code/);
  assert.equal(p.state.found, null);
});

test('the node found, then the leave request signed by the code\'s key at the tip and posted; the key forgotten', async () => {
  const log = [], posted = [];
  const p = page({ client: client(log), get: async () => named, post: async (u, body) => { posted.push([u, body]); return { postedAt: 157210 }; } });
  p.state.code = 'ARN-AAAA'; await p.find();
  const h = renderToStaticMarkup(p.render());
  assert.match(h, /<span class="done">1 Code<\/span><span class="now">2 Confirm<\/span>/);
  assert.match(h, /<span>Roles<\/span><b>game, verify<\/b>/); assert.match(h, /<span>Guardian of<\/span><b>337ae01a<\/b>/);
  assert.match(h, /<span>Signed at block<\/span><b>157210<\/b>/);
  assert.match(h, /cannot be undone/); assert.match(h, /class="primary danger">Yes, leave the network<\/button>/);
  await p.leave();
  assert.deepEqual(log[0], ['sign', { nodePubkey: `bytes(${NODE})`, emergencyPubkey: 'bytes(hex(pub))', postedAt: 157210 }]);
  assert.deepEqual(log[1], ['by', 'msg', { secretOf: [1, 2, 3] }], 'signed by the code\'s key');
  assert.deepEqual(posted, [['/emergency-departure', 'hex(departure)hex(sig)']]);
  assert.equal(p.secret, null, 'the key forgotten');
  const done = renderToStaticMarkup(p.render());
  assert.match(done, /Your node is out/); assert.match(done, /block 157210/); assert.match(done, /succession starts now/);
});

test('a refused leave request says why and can be tried again; Back starts over', async () => {
  let n = 0;
  const p = page({ client: client([]), get: async () => named, post: async () => { if (n++ === 0) throw new Error('that request is not at this node\'s tip'); return { postedAt: 157211 }; } });
  p.state.code = 'ARN-AAAA'; await p.find();
  await p.leave();
  assert.equal(p.state.error, 'that request is not at this node\'s tip'); assert.equal(p.state.busy, false); assert.equal(p.state.sent, null);
  await p.leave();
  assert.equal(p.state.sent.postedAt, 157211);
});

test('on the Arena site (/offline/): the seats\' own errors as they are, the seats that took the request counted, its own back link', async () => {
  const p = page({ client: client([]), unreachable: '', backLabel: '← Bitcoin Arena', dashboardHref: '../',
    get: async () => { throw new Error('No seat answered. Try again in a moment.'); } });
  p.state.code = 'ARN-AAAA'; await p.find();
  assert.equal(p.state.error, 'No seat answered. Try again in a moment.', 'no "this node did not answer" before it');
  assert.match(renderToStaticMarkup(p.render()), /<a href="\.\.\/">← Bitcoin Arena<\/a>/);
  const q = page({ client: client([]), unreachable: '', get: async () => named, post: async () => ({ postedAt: 157210, took: 13, asked: 14 }) });
  q.state.code = 'ARN-AAAA'; await q.find(); await q.leave();
  assert.match(renderToStaticMarkup(q.render()), /13 of 14 seats took the leave request \(block 157210\); each passes it on\./);
});
