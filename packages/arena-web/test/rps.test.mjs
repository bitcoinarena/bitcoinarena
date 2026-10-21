// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ROCK PAPER SCISSORS' TABLE IN REACT (version 4's client): every phase the client's round logic gives it, drawn as version 3 drew
// it - with the emoji cards when there is no 3D stage, with the stage's overlay when there is - and the taps: a button marks itself and
// holds the others at once, the move goes to the client's tap(), and a refused tap gives the buttons back at the next draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RpsView, Moves, lastWords, opponentOf, mmss, VERDICT } from '../dist/test/rps.mjs';

const T = 1_800_000_000_000;
const draw = (state, extra = {}) => renderToStaticMarkup(React.createElement(RpsView, { state, stage: null, stageFailed: true, onTap() {}, drawn: 1, ...extra }));

test('pick: alone in the round, the steps at Pick, the two seats, the clock, the three moves', () => {
  const h = draw({ phase: 'pick', id: 'r1', closeMs: Date.now() + 6000, openMs: Date.now() - 2000, free: true, joined: false, chosen: null, prev: null, scoreboard: null, here: [] });
  assert.match(h, /<div class="presence alone"><span class="icon">🙋<\/span><div><b>You are alone in this round<\/b>/);
  assert.match(h, /<div class="step now"><b>✋<\/b>Pick<\/div>/);
  assert.match(h, /<div class="seat"><div class="slot empty">\?<\/div><div class="who">you<\/div><\/div><div><div class="clock">/);
  assert.match(h, /<div class="t">0:0[56]<\/div>/);
  assert.equal((h.match(/<button type="button">/g) || []).length, 3);
  assert.match(h, /<span>✊<\/span>Rock<\/button><button type="button"><span>✋<\/span>Paper/);
  assert.match(h, /Pick - your opponent cannot see it until the round closes/);
});

test('pick with an opponent here and the match score; wait with both moves in', () => {
  const sb = { me: 2, them: 1, themName: 'satoshi', themKey: 'k2', played: 3 };
  const h = draw({ phase: 'pick', id: 'r2', closeMs: Date.now() + 6000, openMs: Date.now() - 2000, joined: true, chosen: 1, scoreboard: sb, here: [{ key: 'k2', name: 'other name' }] });
  assert.match(h, /<div class="board"><span class="who">You<\/span><b>2<\/b><i>:<\/i><b>1<\/b><span class="who">satoshi<\/span><\/div>/);
  assert.match(h, /You are playing against satoshi<\/b><small>their move is in - pick yours/, 'the match\'s own name, the seats sign it');
  assert.match(h, /Your Paper is going in…/);
  assert.match(h, /<button type="button" disabled="" class="chosen"><span>✋<\/span>Paper/);
  const w = draw({ phase: 'wait', id: 'r2', move: 0, closeMs: Date.now() + 3000, openMs: Date.now() - 5000, them: 1, here: [] });
  assert.match(w, /both moves are in - hidden until the round closes/);
  assert.match(w, /<div class="slot shown">✊<\/div><div class="who">you · Rock<\/div>/);
  assert.match(w, /<div class="slot in">🔒<\/div><div class="who">opponent in<\/div>/);
  assert.equal(opponentOf({ here: [{ key: 'x', name: 'n' }], scoreboard: null }).name, 'n');
});

test('reveal waits with its seconds; the result and the score; a round nobody came to; the strip of the last round', () => {
  const r = draw({ phase: 'reveal', id: 'r3', move: 2, theirs: null, closeMs: T - 4000, endMs: T + 26000 }, {});
  assert.match(r, /<div class="pick due">Result: waiting/);
  assert.match(r, /<div class="slot empty">…<\/div><div class="who">them<\/div>/);
  const won = draw({ phase: 'result', id: 'r3', move: 2, theirs: 1, verdict: 'win', closeMs: T, score: { me: 3, them: 1, played: false } });
  assert.match(won, /<div class="slot shown win">✌️<\/div>[\s\S]*<div class="slot shown loss">✋<\/div>/);
  assert.match(won, /<div class="verdict win">You win 🏆<\/div><div class="pick">score 3 : 1 · match over<\/div>/);
  const alone = draw({ phase: 'alone', id: 'r4', move: 0 });
  assert.match(alone, /<div class="slot empty">∅<\/div><div class="who">nobody came<\/div>[\s\S]*Not played · stake back/);
  const next = draw({ phase: 'pick', id: 'r5', closeMs: Date.now() + 7000, openMs: Date.now() - 1000, chosen: null, here: [], prev: { phase: 'result', move: 0, theirs: 2, verdict: 'loss' } });
  assert.match(next, /<div class="last loss"><span>last round<\/span><b>✊<\/b><i>vs<\/i><b>✌️<\/b><em>lost<\/em><\/div>/);
  assert.deepEqual([lastWords({ phase: 'reveal' }), lastWords({ phase: 'alone' }), lastWords({ phase: 'result', verdict: 'void' })], [['draw', 'result coming…'], ['draw', 'not played'], ['draw', 'not played']]);
  assert.equal(VERDICT.forfeit[1], 'Not revealed · you lose');
});

test('none, and while the 3D stage loads only a quiet card', () => {
  assert.match(draw({ phase: 'none', prev: null }), /<div class="card none"><span class="big">⏳<\/span>The next round opens in a moment\.<\/div>/);
  const loading = draw({ phase: 'pick', id: 'r', closeMs: Date.now() + 5000, openMs: Date.now(), here: [] }, { stageFailed: false });
  assert.match(loading, /<div class="card loading"><span class="spin"><\/span><\/div>/);
  assert.doesNotMatch(loading, /<button/, 'no emoji cards while Three.js is still loading');
  assert.equal(mmss(61000), '1:01');
});

test('a tap marks its button and holds the others at once; the client gets the move; a refused tap gives them back at the next draw', () => {
  const taps = [];
  const m = new Moves({ stage: null, chosen: null, drawn: 1, onTap: (i) => taps.push(i) });
  m.setState = (u) => Object.assign(m.state, typeof u === 'function' ? u(m.state) : u);
  m.tap(2); m.tap(0);
  assert.deepEqual(taps, [2], 'one tap per round');
  assert.match(renderToStaticMarkup(m.render()), /<button type="button" disabled=""><span>✊<\/span>Rock<\/button><button type="button" disabled=""><span>✋<\/span>Paper<\/button><button type="button" disabled="" class="chosen"><span>✌️<\/span>Scissors/);
  const prev = m.props; m.props = { ...prev, drawn: 2 }; m.componentDidUpdate(prev);
  assert.equal(m.state.tapped, null);
  assert.equal((renderToStaticMarkup(m.render()).match(/disabled/g) || []).length, 0, 'the buttons come back');
});
