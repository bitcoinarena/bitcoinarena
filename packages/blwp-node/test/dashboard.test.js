// /Dashboard (the owner 2026-10-01 15:44): the figures and the page every node serves. An empty store says nothing earned,
// every category present, the guardian third and the costs at 0 with the reason named; the page reads dashboard.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { dashboardData, dashboardHtml } from '../src/dashboard.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../core/plugin/nextblock.js';

test('an empty node: every category and period is there, at 0, with 30 days of chart', () => {
  const d = dashboardData(new Round(openStore(), () => Date.UTC(2026, 9, 3, 12), { plugins: HOSTED }), { nowMs: Date.UTC(2026, 9, 3, 12) });
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
  const { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } = await import('../../core/plugin/nextblock.js');
  const { BLOCK_TICKS } = await import('../../core/src/rules/gate.js');
  const { TEST_DONATION_SET_REGTEST } = await import('../../protocol/src/test-donation-sets.js');
  const { donationSetId } = await import('../../protocol/src/donation.js');
  const { toHex } = await import('../../protocol/src/hash.js');
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const { createRequire } = await import('node:module');
  const core = createRequire(import.meta.url)('../../core/dist/blwp-core.js');
  const b32 = (n) => new Uint8Array(32).fill(n);
  const session = ed25519.utils.randomSecretKey();
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, funded: () => true });
  try {
    const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign: (id) => ed25519.sign(id, session), verify: () => true });
    const rid = await client.openRound({
      networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
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
  const hosting = await serve(openStore(), { plugins: HOSTED, port: 0, funded: () => true, hosts: fake });
  const bare = await serve(openStore(), { plugins: HOSTED, port: 0, funded: () => true });
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
  const { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } = await import('../../core/plugin/nextblock.js');
  const { BLOCK_TICKS } = await import('../../core/src/rules/gate.js');
  const { TEST_DONATION_SET_REGTEST } = await import('../../protocol/src/test-donation-sets.js');
  const { donationSetId } = await import('../../protocol/src/donation.js');
  const { toHex } = await import('../../protocol/src/hash.js');
  const b32 = (n) => new Uint8Array(32).fill(n);
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, funded: () => true });
  try {
    const c = { networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
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

// THE MONEY PATH (kanban #149 step 5, plan comment 249, Go 2026-10-05): a paying round in this node's store, its entries
// with this node's signed results, and the round's lock settlement. Earned only once the settlement is ACCEPTED - then
// split as the settlement pays it (nodeFeeTable over the contract's own pools) and counted in the day, month, year and
// the chart; before that, the same money is owed and never shown as earned.
test('a paying round with this node\'s results: an ACCEPTED settlement earns its split in day, month, year and the chart; any other state is owed only', async () => {
  const { contractFor, b32 } = await import('./window-fixture.js');
  const { encodeRoundContract, encodeEntryContract, roundId, entryId } = await import('../../protocol/src/contracts.js');
  const { encodePlayerResult, joinSignedResult } = await import('../../protocol/src/result.js');
  const { nodeFeeTable } = await import('../../protocol/src/fee.js');
  const { toHex } = await import('../../protocol/src/hash.js');
  const NOW = Date.UTC(2026, 9, 5, 12);
  const build = (state) => {
    const round = new Round(openStore(), () => NOW, { plugins: HOSTED });
    const me = round.pubkey;
    const other = b32(0x44);
    const contract = { ...contractFor([me, other], 3000n, ['wss://r.example']), stakeMsat: 100000n };
    const rid = roundId(contract);
    const db = round.db;
    db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(rid, encodeRoundContract(contract), NOW - 3600000);
    const players = [b32(0x51), b32(0x52), b32(0x53)];
    const outcomes = ['DELIVERED', 'FAILED', 'FORFEIT'];
    const entries = [];
    for (const [i, player] of players.entries()) {
      const e = { roundId: rid, playerPubkey: player, sessionPubkey: b32(0x60 + i), stakeCommitment: b32(0x70 + i), stakeMsat: 100000n,
        feeMsat: 2000n, donationMsat: 0n, joinTick: 0, worldSecret: b32(0), vssSharesRef: b32(0x80 + i), stakePoint: Uint8Array.from([2, ...b32(0x90 + i)]),
        feePreimage: b32(0), stakeLockOutpoint: { txid: b32(0xa0 + i), outIdx: 0n }, feeLockOutpoint: { txid: b32(0), outIdx: 0n }, claimKeyAttestationRef: b32(0) };
      const eid = entryId(e);
      db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, ?)').run(eid, rid, encodeEntryContract(e), NOW - 3000000 + i);
      const bytes = joinSignedResult(encodePlayerResult({ roundId: rid, playerPubkey: player, outcome: outcomes[i], score: 100 * (3 - i),
        transcriptHash: b32(0xb0 + i), simCoreHash: contract.simCoreHash, nodePubkey: me }), new Uint8Array(64));
      db.prepare('INSERT INTO results (round_id, entry_id, node_pubkey, result_id, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .run(rid, eid, me, b32(0xc0 + i), bytes, NOW - 2000000);
      entries.push({ pubkey: player, stakeMsat: 100000n, outcome: outcomes[i] });
    }
    // an unreadable result row for a fourth entry earns nothing and breaks nothing
    const badEntry = { roundId: rid, playerPubkey: b32(0x54), sessionPubkey: b32(0x64), stakeCommitment: b32(0x74), stakeMsat: 100000n, feeMsat: 2000n,
      donationMsat: 0n, joinTick: 0, worldSecret: b32(0), vssSharesRef: b32(0x84), stakePoint: Uint8Array.from([2, ...b32(0x94)]), feePreimage: b32(0),
      stakeLockOutpoint: { txid: b32(0xa4), outIdx: 0n }, feeLockOutpoint: { txid: b32(0), outIdx: 0n }, claimKeyAttestationRef: b32(0) };
    const beid = entryId(badEntry);
    db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, ?)').run(beid, rid, encodeEntryContract(badEntry), NOW - 2999000);
    db.prepare('INSERT INTO results (round_id, entry_id, node_pubkey, result_id, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)').run(rid, beid, me, b32(0xc4), Buffer.from('not a result'), NOW - 2000000);
    if (state) round.putLockSettlement({ roundId: rid, txid: 'ab'.repeat(32), message: b32(1), signature: new Uint8Array(64), state, why: state === 'ACCEPTED' ? '' : 'the guardians refused it' });
    const pools = { gameVerify: contract.nodes, settlement: contract.nodes, guardian: [] };
    const table = nodeFeeTable({ contract, entries, pools, eligible: new Set(contract.nodes.map((k) => toHex(k))) });
    const mine = { gameVerify: 0n, settlement: 0n };
    for (const [k, msat] of table.signerNodes) if (k.endsWith(toHex(me))) mine[k.startsWith('gameVerify') ? 'gameVerify' : 'settlement'] += msat;
    return { d: dashboardData(round, { nowMs: NOW }), mine, rid: toHex(rid), table };
  };

  const ok = build('ACCEPTED');
  assert.ok(ok.mine.gameVerify > 0n && ok.mine.settlement > 0n, 'the settlement\'s own table pays this node in both pools');
  const r = ok.d.rounds.find((x) => x.id === ok.rid);
  assert.equal(r.checked, 4, 'four result rows of this node, the unreadable one among them');
  assert.equal(r.earned, true);
  assert.deepEqual([r.gameVerifyMsat, r.settlementMsat, r.guardianMsat], [String(ok.mine.gameVerify), String(ok.mine.settlement), '0'],
    'split exactly as the settlement pays it; the unreadable row earns nothing');
  for (const period of ['day', 'month', 'year']) {
    assert.equal(ok.d.totals[period].gameVerifyMsat, String(ok.mine.gameVerify), period);
    assert.equal(ok.d.totals[period].settlementMsat, String(ok.mine.settlement), period);
  }
  assert.deepEqual([ok.d.totals.owed.gameVerifyMsat, ok.d.totals.owed.settlementMsat], ['0', '0'], 'nothing owed once accepted');
  const today = ok.d.days.find((x) => x.day === '2026-10-05');
  assert.equal(today.gameVerifyMsat, String(ok.mine.gameVerify), 'the chart shows it on the day it was settled');
  assert.equal(today.profitMsat, String(ok.mine.gameVerify + ok.mine.settlement));

  for (const state of ['SUBMITTED', 'REFUSED', null]) {
    const no = build(state);
    const nr = no.d.rounds.find((x) => x.id === no.rid);
    assert.ok(!nr.earned, `${state}: not earned (with no settlement row, dashboard.json leaves earned out)`);
    for (const period of ['day', 'month', 'year']) assert.deepEqual([no.d.totals[period].gameVerifyMsat, no.d.totals[period].settlementMsat], ['0', '0'], `${state}: ${period} shows nothing earned`);
    assert.deepEqual([no.d.totals.owed.gameVerifyMsat, no.d.totals.owed.settlementMsat], [String(no.mine.gameVerify), String(no.mine.settlement)], `${state}: the same money, owed`);
    assert.ok(no.d.days.every((x) => x.gameVerifyMsat === '0' && x.settlementMsat === '0'), `${state}: nothing on the chart`);
  }
});

// THE ROUNDS TABLE'S NET, AS THE DASHBOARD DRAWS IT (kanban #187 item 1 follow-up, the owner 2026-10-05 on comment 318). The
// page dashboardHtml() serves draws each player's result and netMsat from api/round-result with its own code: signedSat
// ("+" before a positive net), the cell's class (ok positive, bad negative, none at zero or pending). Its renderer is lifted
// out of the page as served and run with the four results playerBalance answers for a paying round.
test('the dashboard draws a paying round\'s nets: "+286 sat" ok, "-4 sat" and "-100 sat" bad, pending blank', () => {
  const page = dashboardHtml();
  const script = page.slice(page.indexOf('<script>') + '<script>'.length, page.lastIndexOf('</script>'));
  const line = (start) => { const at = script.indexOf(start); assert.ok(at >= 0, `the page has ${start}`); return script.slice(at, script.indexOf('\n', at)); };
  const at = script.indexOf('function playersOf(id){');
  const playersOfSrc = script.slice(at, script.indexOf('\nfunction readPlayers(', at));
  const players = new Map();
  const playersOf = new Function('players', [line('const sat='), line('const esc='), line('const score='), line('const signedSat='), playersOfSrc, 'return playersOf;'].join('\n'))(players);
  const row = (p) => ({ entry: 'e'.repeat(64), player: 'p'.repeat(64), name: p.name, stakeMsat: '100000', outcome: p.outcome, score: 500000, signedBy: 2, ...p });
  players.set('r1', { id: 'r1', free: false, players: [
    row({ name: 'winner', outcome: 'DELIVERED', result: 'won', netMsat: '286000' }),
    row({ name: 'back', outcome: 'FAILED', result: 'stake back', netMsat: '-4000' }),
    row({ name: 'loser', outcome: 'FORFEIT', result: 'lost', netMsat: '-100000' }),
    row({ name: 'waiting', outcome: 'DELIVERED', result: 'pending', netMsat: null }),
    row({ name: 'even', outcome: 'FAILED', result: 'stake back', netMsat: '0' }),
  ] });
  const html = playersOf('r1');
  // each row's cells in order: player, outcome, score, signed by, stake, won or lost, net, replay
  const cells = Object.fromEntries(html.split('<tr>').slice(2).map((tr) => {
    const td = [...tr.matchAll(/<td(?: class="([^"]*)")?>(.*?)<\/td>/g)].map((m) => ({ cls: (m[1] || '').trim(), text: m[2] }));
    return [td[0].text, { result: td[5].text, resultClass: td[5].cls, net: td[6].text, netClass: td[6].cls.replace(/^n\s*/, '') }];
  }));
  assert.deepEqual(cells.winner, { result: 'won', resultClass: 'ok', net: '+286 sat', netClass: 'ok' });
  assert.deepEqual(cells.back, { result: 'stake back', resultClass: 'bad', net: '-4 sat', netClass: 'bad' });
  assert.deepEqual(cells.loser, { result: 'lost', resultClass: 'bad', net: '-100 sat', netClass: 'bad' });
  assert.deepEqual(cells.waiting, { result: 'pending', resultClass: '', net: '', netClass: '' }, 'pending: blank, no class');
  assert.deepEqual(cells.even, { result: 'stake back', resultClass: '', net: '0 sat', netClass: '' }, 'zero: no "+", no class');
  assert.match(html, /<th>Won or lost<\/th><th class="n">Net<\/th>/);
});
