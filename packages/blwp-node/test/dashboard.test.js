// /Dashboard (the owner 2026-10-01 15:44): the figures and the page every node serves. An empty store says nothing earned,
// every category present, the guardian third and the costs at 0 with the reason named; the page reads dashboard.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { dashboardData, dashboardHtml } from '../src/dashboard.js';

test('an empty node: every category and period is there, at 0, with 30 days of chart', () => {
  const d = dashboardData(new Round(openStore(), () => Date.UTC(2026, 9, 3, 12)), { nowMs: Date.UTC(2026, 9, 3, 12) });
  for (const p of ['day', 'month', 'year', 'owed'])
    for (const k of ['gameVerifyMsat', 'settlementMsat', 'guardianMsat', 'otherMsat', 'lightningCostMsat', 'gatewayCostMsat', 'profitMsat'])
      assert.equal(d.totals[p][k], '0', `${p}.${k}`);
  assert.equal(d.days.length, 30);
  assert.equal(d.days.at(-1).day, '2026-10-03');
  assert.equal(d.roundsChecked, 0);
  assert.match(d.notes.guardian, /guardian third/);
  assert.equal(typeof d.node, 'string');
});

test('the page draws dashboard.json and names every category', () => {
  const h = dashboardHtml();
  assert.match(h, /<title>Node Dashboard<\/title>/);
  assert.match(h, /fetch\('dashboard\.json'/);
  for (const n of ['Game/verify fee', 'Settlement fee', 'Guardian/custody fee', 'Other earnings', 'Lightning costs', 'Gateway costs', 'Absolute profit'])
    assert.ok(h.includes(n), n);
});

// THE ROUNDS ARE CLICKABLE (the owner 2026-10-03 22:25, plan accepted 2026-10-04): against a real node holding a round with an
// entry - the page it serves carries the row toggle, the fetch of its own api/round-result (relative, so /guardian-N/ works)
// and the replay link; and that endpoint answers every field the opened row draws.
test('a real node: /dashboard opens a round to its players from api/round-result, each with a replay link', async () => {
  const { serve } = await import('../src/server.js');
  const { Client } = await import('../../blwp-client/src/client.js');
  const { TEST_FEDERATION_ID } = await import('../../protocol/src/test-federation.js');
  const { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } = await import('../src/cores.js');
  const { BLOCK_TICKS } = await import('../../core/src/rules/gate.js');
  const { TEST_DONATION_SET_REGTEST } = await import('../../protocol/src/test-donation-sets.js');
  const { donationSetId } = await import('../../protocol/src/donation.js');
  const { toHex } = await import('../../protocol/src/hash.js');
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const { createRequire } = await import('node:module');
  const core = createRequire(import.meta.url)('../../core/dist/blwp-core.js');
  const b32 = (n) => new Uint8Array(32).fill(n);
  const session = ed25519.utils.randomSecretKey();
  const node = await serve(openStore(), { port: 0, funded: () => true });
  try {
    const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign: (id) => ed25519.sign(id, session), verify: () => true });
    const rid = await client.openRound({
      networkId: b32(0x4e), configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
      censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 0n, bondMinSats: 50000n,
      blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
      timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [node.round.pubkey],
    });
    const eid = await client.join({
      roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    });
    const page = await (await fetch(`http://127.0.0.1:${node.port}/dashboard`)).text();
    assert.ok(page.includes(`fetch('api/round-result?round='+id`), 'the opened row reads this node\'s own api/round-result, relative');
    assert.ok(page.includes(`tr.closest('tr.rr')`) || page.includes(`closest('tr.rr')`), 'the whole round row is the toggle');
    assert.ok(page.includes('<a href="replay?round=') && page.includes('target="_blank"'), 'each player links its replay in a new window');
    assert.ok(page.includes('not signed yet'));
    const j = await (await fetch(`http://127.0.0.1:${node.port}/api/round-result?round=${toHex(rid)}`)).json();
    assert.equal(j.id, toHex(rid));
    assert.equal(j.players.length, 1);
    const p = j.players[0];
    for (const k of ['entry', 'player', 'name', 'outcome', 'score', 'signedBy', 'stakeMsat', 'result', 'netMsat']) assert.ok(k in p, `the row draws ${k}`);
    assert.equal(p.entry, toHex(eid));
    assert.equal(p.outcome, null, 'nothing signed yet');
    assert.equal(p.result, 'free');
  } finally { await node.close(); }
});
