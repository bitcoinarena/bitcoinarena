// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE HOLDS THE VICTORY UNTIL THE RUN IS SAFE (§13A "Client duty"): the template's own ARENA_SECURE_RUN on stubs -
// a DELIVERED run is asked of its nodes until two hold all of it, and the line over the result card says so; anything else is not gated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../nextblock/page/unity-page.js', import.meta.url), 'utf8');   // Tick Tock's page part (kanban #521)
const body = HTML.slice(HTML.indexOf('    window.ARENA_SECURE_RUN = async'), HTML.indexOf('    window.ARENA_RUN_OVER = (word, run) => {'));

function page(answers) {
  const els = new Map();
  const document = { getElementById: (id) => els.get(id) || null, createElement: () => ({ style: {} }), body: { appendChild: (e) => els.set(e.id, e) } };
  const asked = [];
  // the line is drawn by React (Tick Tock's Securing, kanban #564): what it was handed is kept on its host
  const window = { unityInstance: { Module: { blwpRunNet: { client: { nextTick: 4920 } } } }, ArenaNextBlock: { draw: (el, kind, props) => { el.drawn = { kind, ...props }; } } };
  const ARENACLIENT = { fromHex: (h) => h, secureTranscript: async (o) => { asked.push(o); return answers[Math.min(asked.length - 1, answers.length - 1)]; } };
  new Function('window', 'document', 'ARENACLIENT', 'setTimeout', body)(window, document, ARENACLIENT, (f) => { Promise.resolve().then(f); return 0; });
  return { window, els, asked };
}
const run = { roundHex: 'ab'.repeat(32), entryHex: 'cd'.repeat(32), nodes: ['https://n1', 'https://n2', 'https://n3'] };

test('a DELIVERED run: asked until two nodes hold all of it, then "safe"', async () => {
  const p = page([{ safe: false, holders: ['https://n1'], why: '1 of the 2' }, { safe: false, holders: ['https://n1'] }, { safe: true, holders: ['https://n1', 'https://n2'] }]);
  const got = await p.window.ARENA_SECURE_RUN('DELIVERED', run, { everyMs: 0 });
  assert.deepEqual([got.safe, p.asked.length, p.asked[0].finalTick, p.asked[0].nodes.length], [true, 3, 4920, 3]);
  const d = p.els.get('arena-securing-host').drawn;
  assert.deepEqual([d.kind, d.say, d.tone, d.hidden], ['securing', 'Your run is safe: 2 signer nodes hold all of it', 'safe', true], 'said, then put away after 4 s');
});

test('not delivered: not gated; still unsafe after its tries: the line stays and says why', async () => {
  const p = page([{ safe: false, need: 5, holders: [], why: '0 of the 5 committee nodes the run needs hold its whole transcript' }]);
  assert.equal(await p.window.ARENA_SECURE_RUN('FAILED', run, { everyMs: 0 }), null);
  assert.equal(p.asked.length, 0);
  const got = await p.window.ARENA_SECURE_RUN('DELIVERED', run, { tries: 2, everyMs: 0 });
  assert.equal(got.safe, false);
  assert.match(p.els.get('arena-securing-host').drawn.say, /not yet held by 5 signer nodes - keep this tab open \(0 of the 5/);
  assert.equal(p.els.get('arena-securing-host').drawn.tone, 'bad');
});
