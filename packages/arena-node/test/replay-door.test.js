// THE REPLAY PAGE IS THE ROUND'S GAME'S (kanban #202, hole 1 of comment 747): /replay serves the replay page the round's
// game registered - nextblock's draws the truck - and the engine draws no game. A round of a game with no replay page,
// or a round this node does not hold, has none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { TALLY, TALLY_CORE_HASH, TALLY_CONFIG_HASH, TALLY_GAME_ID } from './plugins/tally/index.js';
import { contractFor, opts, b32, WINDOW_MS } from './window-fixture.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('/replay serves the round\'s own game\'s page: nextblock\'s for a nextblock round, none for tally or a round this node does not hold', async () => {
  const d = await serve(openStore(':memory:'), { port: 0, ...opts, plugins: [NEXTBLOCK, TALLY] });
  try {
    const base = { ...contractFor([d.round.pubkey, b32(0x33)], BigInt(WINDOW_MS)), stakeMsat: 0n, federationId: new Uint8Array(32) };
    const nextblock = base;
    const tally = { ...base, gameId: TALLY_GAME_ID, simCoreHash: TALLY_CORE_HASH, configHash: TALLY_CONFIG_HASH, blockTicks: 600, startDeadlineTicks: 300 };
    for (const c of [nextblock, tally]) {
      const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
      assert.equal(r.status, 201, await r.text());
    }
    const page = async (q) => { const r = await fetch(`http://127.0.0.1:${d.port}/replay${q}`); return { status: r.status, body: await r.text() }; };
    const got = {
      nextblock: await page(`?round=${toHex(roundId(nextblock))}&entry=${'00'.repeat(32)}`),
      tally: await page(`?round=${toHex(roundId(tally))}&entry=${'00'.repeat(32)}`),
      unknown: await page(`?round=${'ab'.repeat(32)}`),
      none: await page(''),
    };
    console.log('  FACTS (replay door):', JSON.stringify(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, { status: v.status, bytes: v.body.length, says: v.status === 200 ? undefined : v.body }]))));
    assert.equal(got.nextblock.status, 200);
    assert.equal(got.nextblock.body, readFileSync(NEXTBLOCK.replayPage, 'utf8'), 'the nextblock round was not served nextblock\'s page');
    assert.deepEqual([got.tally.status, got.tally.body.trim()], [404, 'tally serves no replay page']);
    assert.deepEqual([got.unknown.status, got.unknown.body.trim()], [404, 'this node holds no such round']);
    assert.equal(got.none.status, 400);
  } finally { await d.close(); }
});

test('the engine draws no game: nothing in arena-node/pages or arena-node/src reads the truck\'s state or names a replay page of its own', () => {
  const at = (p) => new URL(p, import.meta.url).pathname;
  const drawing = [];
  for (const dir of ['../pages/', '../src/']) for (const f of readdirSync(at(dir))) {
    const src = readFileSync(at(dir + f), 'utf8');
    if (/O_TRUCK|replay\.html/.test(src)) drawing.push(dir.replace('../', '') + f);
  }
  assert.deepEqual(drawing, [], 'an engine file draws a game');
});
