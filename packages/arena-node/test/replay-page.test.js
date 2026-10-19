// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GAME REPLAY FROM ANY NODE THAT HOLDS THE RUN (2026-09-25 18:39): GET /replay serves a page, not the Unity
// build; the page fetches the transcript, the entry and the round from that node - or the round's other committee
// endpoints - and steps the core the round names. Measured here on a bonded two-node round with one played entry:
// what each door hands the page, and that the core the page is handed, stepped over the transcript the page is handed,
// reaches the state this node's own replay reaches. No second simulator: the page's core is core/src's adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { LOSER } from './window-fixture.js';
import { readTranscript } from '../src/transcript-read.js';
import { replay } from '../src/replay.js';
import { coreOfGame } from '../src/plugins.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { decodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const require = createRequire(import.meta.url);
const get = async (base, path) => { const r = await fetch(`${base}${path}`); return { status: r.status, type: r.headers.get('content-type'), body: new Uint8Array(await r.arrayBuffer()) }; };
const text = (b) => new TextDecoder().decode(b);

test('the replay doors: a page, the run as the node replays it, the round\'s own core, and the committee\'s endpoints as https', async () => {
  const w = await lockRound();
  try {
    const played = await lockAndPlay(w, LOSER);
    const A = `http://127.0.0.1:${w.a.port}`;
    const rid = toHex(w.rid), eid = toHex(played.eid);

    const page = await get(A, `/replay?round=${rid}&entry=${eid}`);
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    // RELATIVE, and this node is origin plus the path it is published under: an endpoint may carry a path
    // (https://host/blwp-a), and a root-absolute fetch would ask the host's root, not this node.
    assert.match(text(page.body), /<script src="replay\/client\.js"><\/script>/);
    assert.match(text(page.body), /const here = location\.origin \+ location\.pathname\.replace\(/);
    assert.match(text(page.body), /\/replay\/core\.js\?round=/);

    const t = await get(A, `/replay/transcript?round=${rid}&entry=${eid}`);
    assert.equal(t.status, 200);
    const handed = JSON.parse(text(t.body));
    assert.deepEqual(handed, JSON.parse(JSON.stringify(readTranscript(w.a.round.db, w.rid, played.eid))), 'the page is handed another run than the node replays');
    assert.equal((await get(A, `/replay/transcript?round=${rid}&entry=${'ab'.repeat(32)}`)).status, 404, 'a run this node does not hold is not a 404 - the page could not ask the others');

    const core = await get(A, `/replay/core.js?round=${rid}`);
    assert.equal(core.status, 200);
    assert.match(core.type, /javascript/);
    assert.equal((await get(A, `/replay/core.js?round=${'cd'.repeat(32)}`)).status, 404);

    const nodes = JSON.parse(text((await get(A, `/replay/nodes?round=${rid}`)).body));
    console.log('  FACTS (replay nodes):', JSON.stringify(nodes));
    assert.deepEqual([...nodes.endpoints].sort(), [w.a.port, w.b.port].map((p) => `https://127.0.0.1:${p}`).sort());

    // THE PAGE'S STEPPING, with what the doors handed it: the served core, the served transcript, the entry and the
    // beacon from the same node - against this node's own replay of the run.
    const R = require('../../nextblock/dist/blwp-replay-core.js');
    const ent = decodeEntryContract((await get(A, `/entry?id=${eid}`)).body);
    const beacon = (await get(A, `/randomness?round=${rid}`)).body;
    const st = R.CORE.start(seedWordForEntry(ent, beacon));
    const events = R.CORE.eventsOf(handed);
    for (const tick of handed.ticks) { events.before(st, tick.tick); R.CORE.step(st, tick.words); }
    const found = coreOfGame(w.c, NEXTBLOCK);
    const node = replay(w.a.round.transcript(w.rid, played.eid), played.entry, { core: { ...found.core, config: found.config }, roundRandomness: w.randomness });
    console.log(`  the page's stepping: ${handed.ticks.length} ticks, state ${R.CORE.stateHash(st).slice(0, 16)}; the node's replay ${String(node.stateHash).slice(0, 16)}`);
    assert.equal(node.ok, true, node.why);
    assert.equal(R.CORE.stateHash(st), node.stateHash, 'the page\'s core, stepped over what it is handed, reaches another state than the node\'s replay');
  } finally { await w.close(); }
});

test('the served replay core is the build of core/src\'s adapter: the same state as the modules over a run with a load', async () => {
  const R = require('../../nextblock/dist/blwp-replay-core.js');
  const { CORE } = await import('../../nextblock/src/adapter.js');
  const run = { ticks: Array.from({ length: 400 }, (_, t) => ({ tick: t, words: [65536, ((t * 977) % 60000) - 30000, 0, 0, 0] })), loads: [[10, 2000, 50]], liquidations: [[120, 3]] };
  const a = R.CORE.start(424242), b = CORE.start(424242);
  const ea = R.CORE.eventsOf(run), eb = CORE.eventsOf(run);
  for (const t of run.ticks) { ea.before(a, t.tick); R.CORE.step(a, t.words); eb.before(b, t.tick); CORE.step(b, t.words); }
  assert.equal(R.CORE.stateHash(a), CORE.stateHash(b));
});

test('the committed dist/blwp-replay-core.js is the build of core/src as it stands (tools/bundle-replay.js)', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const out = mkdtempSync(join(tmpdir(), 'replay-core-'));
  try {
    execFileSync(process.execPath, [new URL('../../nextblock/tools/bundle-replay.js', import.meta.url).pathname],
      { env: { ...process.env, ARENA_BUNDLE_OUT: out }, stdio: 'ignore' });
    assert.ok(Buffer.compare(readFileSync(join(out, 'blwp-replay-core.js')),
      readFileSync(new URL('../../nextblock/dist/blwp-replay-core.js', import.meta.url))) === 0,
    'dist/blwp-replay-core.js is not the build of core/src - run node packages/nextblock/tools/bundle-replay.js');
  } finally { rmSync(out, { recursive: true, force: true }); }
});
