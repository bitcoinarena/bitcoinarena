// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r9 play-1: THE REPLAY PAGE RUNS ANOTHER SEAT'S SCRIPT IN THIS SEAT'S ORIGIN.
// GET /replay is served by the seat's own http server - the same origin as GET /Dashboard/owner, whose page keeps the
// owner's seed in localStorage ('arena-owner-seed:<base>'). When this seat holds no transcript of the (round, entry) the
// link names - any made-up entry id - the page asks the round's committee endpoints and takes the FIRST that answers
// any JSON, then loads `${base}/replay/core.js` from it as a <script>. One byzantine committee seat answers both, and its
// JavaScript runs in the honest seat's origin. Safe: the core script is only ever loaded from this seat itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from '../../arena-client/test/page-script.js';

const PAGE = new URL('../../nextblock/plugin/nextblock-replay.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const at = HTML.indexOf('(async function () {\n  const q = new URLSearchParams(location.search);');
const SCRIPT = HTML.slice(at, HTML.lastIndexOf('})();', HTML.indexOf('</script>', at)) + '})();'.length);

const RID = 'ab'.repeat(32), EID = 'cd'.repeat(32);
const json = (v) => new Response(JSON.stringify(v), { status: 200 });

test('a committee peer that answers a run this seat lacks never gets its script run in this seat\'s origin', async () => {
  const said = [];
  const status = { set textContent(s) { said.push(s); }, get textContent() { return said.at(-1) || ''; }, style: {} };
  const scripts = [];
  const document = {
    getElementById: (id) => (id === 'status' ? status : null),
    createElement: () => ({}),
    head: { appendChild: (s) => { scripts.push(s.src); setTimeout(() => s.onerror && s.onerror(), 0); } },
  };
  const fetch = async (url) => {
    url = String(url);
    if (url.includes('/replay/nodes')) return json({ endpoints: ['https://evil.example'] });
    if (url.startsWith('https://node.example')) return new Response('no', { status: 404 });
    // the byzantine seat answers everything
    if (url.includes('/replay/transcript')) return json({ ticks: [{ tick: 0, words: [0, 0, 0, 0, 0] }] });
    return new Response(new Uint8Array([1]), { status: 200 });
  };
  const location = { search: `?round=${RID}&entry=${EID}`, origin: 'https://node.example', pathname: '/replay' };
  const ARENACLIENT = { decodeRoundContract: () => ({}), decodeEntryContract: () => ({}) };
  await pageFunction(PAGE, ['document', 'fetch', 'location', 'ARENACLIENT', 'window', 'console'], SCRIPT, '', 'return ')(
    document, fetch, location, ARENACLIENT, {}, { log: () => {} }).catch(() => {});
  const foreign = scripts.filter((u) => !String(u).startsWith('https://node.example/'));
  assert.deepEqual(foreign, [], `the page loaded a script from another seat into this seat's origin: ${foreign.join(', ')}`);
});
