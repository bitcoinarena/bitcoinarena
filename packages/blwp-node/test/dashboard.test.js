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
  const { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } = await import('../src/cores.js');
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
      networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
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

// WHAT A NODE HOSTS (the owner 2026-10-03 22:50, plan accepted 2026-10-04): node 1 gateway A + LND 1, node 2 gateway B + LND 2,
// nodes 3-7 neither. A real node handed a hosts reader shows them; one without keeps both notes and no Hosts card.
test('a real node that hosts an LND and a gateway shows them in dashboard.json; one that hosts neither keeps both notes', async () => {
  const { serve } = await import('../src/server.js');
  const now = Date.now();
  const fake = { snapshot: () => ({
    lnd: { alias: 'lnd-testnet4', pubkey: '0274e26122c7b8fc', activeChannels: 1, synced: true, localMsat: '1082086628', remoteMsat: '459114372',
      routingFeesMsat30d: '0', forwards30d: 0, paymentFees: [{ atMs: now - 1000, feeMsat: '1000' }, { atMs: now - 40 * 86400000, feeMsat: '7000' }], readAtMs: now },
    gateway: { name: 'gw-a', state: 'Running', lightningAlias: 'lnd-testnet4', federations: [{ id: '337ae01a', name: 'blwp-testnet4', ecashMsat: '248999936' }],
      lightningMsat: '1082086628', inboundMsat: '459114372', onchainSat: '20446', payments30d: { incoming: { success: 0, failure: 0, feesMsat: '0' }, outgoing: { success: 0, failure: 2, feesMsat: '0' } }, readAtMs: now },
  }) };
  const hosting = await serve(openStore(), { port: 0, funded: () => true, hosts: fake });
  const bare = await serve(openStore(), { port: 0, funded: () => true });
  try {
    const d = await (await fetch(`http://127.0.0.1:${hosting.port}/dashboard.json`)).json();
    assert.equal(d.hosts.lnd.alias, 'lnd-testnet4');
    assert.equal(d.hosts.gateway.name, 'gw-a');
    assert.equal(d.hosts.gateway.federations[0].ecashMsat, '248999936');
    assert.equal(d.hosts.lnd.paidFeesMsat, '8000');
    assert.equal(d.hosts.lnd.paymentFees, undefined, 'the payment list itself stays on the node');
    assert.doesNotMatch(d.notes.lightning, /holds no Lightning channel/);
    assert.doesNotMatch(d.notes.gateway, /pays no gateway/);
    assert.match(d.notes.gateway, /gateway costs are 0: the gateway is what charges, the node pays it nothing/);
    assert.equal(d.totals.day.lightningCostMsat, '1000', 'today\'s payment fee is today\'s Lightning cost');
    assert.equal(d.totals.day.gatewayCostMsat, '0');
    assert.equal(d.totals.day.profitMsat, '-1000');
    const page = await (await fetch(`http://127.0.0.1:${hosting.port}/dashboard`)).text();
    assert.ok(page.includes('function hostsCard()') && page.includes('<h3>Hosts</h3>'));
    const n = await (await fetch(`http://127.0.0.1:${bare.port}/dashboard.json`)).json();
    assert.equal(n.hosts, null);
    assert.equal(n.notes.lightning, 'this node holds no Lightning channel');
    assert.equal(n.notes.gateway, 'this node pays no gateway');
    assert.equal(n.totals.day.lightningCostMsat, '0');
  } finally { await hosting.close(); await bare.close(); }
});

// READABLE (kanban #125, the owner's playtest 2026-10-04 14:05, plan comment 218 accepted 2026-10-05). The Hosts card's label and
// value both shrank and wrapped ("Routing fees, 30 / days" beside "0 sat · 0 / forwards"); the Notes card took the subtitle's
// word-break:break-all and split inside words ("th e", "roun d", "gate way"); the fee chart's day lived only in an SVG title;
// the Player column showed 8 hex of the key, because api/round-result read only a record's custom name.
test('the page: Notes wrap on words, a Hosts value never wraps inside itself, the chart has a hover or tap box', () => {
  const page = dashboardHtml();
  const css = page.slice(page.indexOf('<style>'), page.indexOf('</style>'));
  // NOTES: their own class, words kept whole; only a single token longer than the card may break
  assert.doesNotMatch(page, /<h3>Notes<\/h3><div class="sub"/, 'the Notes card still uses the subtitle\'s break-all');
  assert.match(page, /<h3>Notes<\/h3><div class="notes">/);
  assert.match(css, /\.notes\{[^}]*word-break:normal[^}]*overflow-wrap:anywhere/);
  // HOSTS: the value is one unbroken piece; the row wraps it under its label when the pair does not fit
  assert.match(css, /\.row\{[^}]*flex-wrap:wrap/);
  assert.match(css, /\.row b\{[^}]*white-space:nowrap[^}]*margin-left:auto/);
  // THE CHART: a box that follows the pointer or a tap and names the day and its three amounts
  assert.match(page, /<div id="tip"/);
  assert.match(page, /tip\.textContent=d\.day\+': game\/verify '\+g\+' msat · settlement '\+st\+' msat · guardian '\+gd\+' msat'/);
  assert.match(page, /addEventListener\('pointermove'/);
  // MEASURED LIVE (test host Chrome, 1280 px): a node name in a note broke at its hyphen ("test-host- / testnet4"), and at 390 px
  // the box ran past the chart card's edge. A note's hyphens do not break; the box wraps inside the card.
  assert.match(page, /const keep=\(t\)=>String\(t\)\.replace\(\/-\/g,'\\u2011'\)/);
  assert.match(page, /<p>'\+keep\(D\.notes\.guardian\)\+'<\/p><p>'\+keep\(D\.notes\.lightning\)\+'<\/p><p>'\+keep\(D\.notes\.gateway\)\+'<\/p>/);
  assert.match(css, /#tip\{[^}]*white-space:normal[^}]*max-width:calc\(100% - 8px\)/);
  assert.match(page, /<title>'\+d\.day\+': game\/verify /, 'the SVG title went');
  // THE PLAYER COLUMN draws the name, never a slice of the key
  assert.doesNotMatch(page, /String\(p\.player\|\|''\)\.slice\(0,8\)/);
});

test('api/round-result names every player: the custom name, else the lobby\'s generated name, else the key\'s generated name marked', async () => {
  const { serve } = await import('../src/server.js');
  const { encodeLobbyName } = await import('../../protocol/src/lobby-name.js');
  const { displayNameFromKey } = await import('../../protocol/src/display-name.js');
  const { encodeRoundContract, roundId, encodeEntryContract } = await import('../../protocol/src/contracts.js');
  const { TEST_FEDERATION_ID } = await import('../../protocol/src/test-federation.js');
  const { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } = await import('../src/cores.js');
  const { BLOCK_TICKS } = await import('../../core/src/rules/gate.js');
  const { TEST_DONATION_SET_REGTEST } = await import('../../protocol/src/test-donation-sets.js');
  const { donationSetId } = await import('../../protocol/src/donation.js');
  const { toHex } = await import('../../protocol/src/hash.js');
  const b32 = (n) => new Uint8Array(32).fill(n);
  const node = await serve(openStore(), { port: 0, funded: () => true });
  try {
    const c = { networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
      censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 0n, bondMinSats: 50000n,
      blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
      timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [node.round.pubkey] };
    const rid = roundId(c);
    assert.equal((await fetch(`http://127.0.0.1:${node.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
    const join = async (player) => {
      const e = { roundId: rid, playerPubkey: player, sessionPubkey: b32(0x51), stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32) };
      assert.equal((await fetch(`http://127.0.0.1:${node.port}/entry`, { method: 'POST', body: encodeEntryContract(e) })).status, 201);
    };
    const NAMED = b32(0x11), GENERATED = b32(0x22), NONE = b32(0x33), IDENTITY = b32(0x44);
    for (const p of [NAMED, GENERATED, NONE]) await join(p);
    const put = (player, name) => node.round.putLobbyName({ roundId: rid, playerPubkey: player, signature: new Uint8Array(64), atMs: 1n,
      record: encodeLobbyName({ roundId: rid, playerPubkey: player, identityPubkey: IDENTITY, name, atMs: 1n }) });
    put(NAMED, 'Sophia');
    put(GENERATED, '');
    const j = await (await fetch(`http://127.0.0.1:${node.port}/api/round-result?round=${toHex(rid)}`)).json();
    const byPlayer = Object.fromEntries(j.players.map((p) => [p.player, p.name]));
    assert.equal(byPlayer[toHex(NAMED)], 'Sophia');
    assert.equal(byPlayer[toHex(GENERATED)], displayNameFromKey(IDENTITY), 'a player who kept the generated name is not named as the lobby showed it');
    assert.equal(byPlayer[toHex(NONE)], `${displayNameFromKey(NONE)} (no lobby name)`);
    for (const p of j.players) assert.doesNotMatch(p.name, /^[0-9a-f]{8}$/, `${p.player} is named by hex`);
  } finally { await node.close(); }
});
