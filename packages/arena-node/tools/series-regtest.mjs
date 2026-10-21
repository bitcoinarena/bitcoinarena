#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NODE REFUSES WHAT A SERIES DOES NOT DERIVE, AS A PROCESS (2026-09-29, the accepted series sequence, step 3):
// "Private regtest: bitcoind on 30601, nodes on 41221+, two main.js processes, one series. Accept a genuine round i. Refuse
// a moved window, index 960, an id that is not the hash, and an entry, a lock, and a settlement commit that name such a
// round." Never testnet4, no bond, nothing spent. Since (2026-10-05) the seats are on 23421/23431 - below the
// ephemeral range - and the series' run is the 82 s one every 90 s series runs (RUN_82_TICKS): the seats refused the
// 180 s BLOCK_TICKS run once the run had to fit its slot. test/series-regtest-tool.test.js runs this with CHAIN=0.
//
//   RT=<datadir> RPCPORT=30601 node tools/series-regtest.mjs            (from packages/arena-node)
//
// Two `node src/main.js` processes on their own stores, holding one series (ARENA_SERIES_FILE); the rounds posted over HTTP.
// Then node 1 is started again on the same store WITHOUT the series: the round it took and the entry it took are no
// longer a series it holds - an entry, a lock and a settlement commit naming them are refused by name.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore, nodeIdentity } from '../src/store.js';
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { RUN_82_TICKS } from './round-2of2.mjs';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../arena-protocol/src/contracts.js';
import { seriesTemplate, seriesRound, seriesIndexAt, seriesId, ROUND_PERIOD_MS } from '../../arena-protocol/src/series.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { worldIsShared } from '../../arena-protocol/src/seed.js';
import { sharedWorldOf } from '../../arena-protocol/src/known-game.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar } from '../test/window-fixture.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const env = process.env, RT = env.RT, RPCPORT = env.RPCPORT || '30601';
if (!RT) throw new Error('RT=<a private regtest datadir>');
const out = (o) => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...o }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b32 = (n) => new Uint8Array(32).fill(n);
const ports = [23421, 23431];
const dir = mkdtempSync(join(env.SERIES_DIR || '/mnt/bitcoin', 'series-regtest-'));
const stores = ports.map((_, i) => join(dir, `node-${i + 1}.db`));
const keys = stores.map((p) => { const db = openStore(p); const k = nodeIdentity(db).pubkey; db.close(); return k; });

// ---- one series: today's, both nodes its committee
const base = {
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n,
  bondMinSats: 50000n, blockTicks: RUN_82_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: keys,
};
const t = seriesTemplate(base, seriesIndexAt(NETWORK_ID_REGTEST, Date.now()) - 1);          // the series running now
const other = seriesTemplate(base, seriesIndexAt(NETWORK_ID_REGTEST, Date.now()));          // tomorrow's: not held
writeFileSync(join(dir, 'series.txt'), toHex(encodeRoundContract(t)) + '\n');
const i = Math.ceil((Date.now() - Number(t.startTimeMs)) / Number(ROUND_PERIOD_MS)) + 2;    // a round whose entry is still open
out({ step: 'series', seriesId: toHex(seriesId(t)).slice(0, 16), start: new Date(Number(t.startTimeMs)).toISOString(), i });

const start = (k, withSeries) => {
  // CHAIN=0: no chain view - a genuine round whose template names no census this chain has is then stored (the series
  // door is before the chain's); with the chain the same round passes the series door and meets the census check
  const e = { ...env, ...(env.CHAIN === '0' ? {} : { ARENA_BITCOIND_URL: `http://127.0.0.1:${RPCPORT}`, ARENA_BITCOIND_COOKIE: `${RT}/regtest/.cookie` }), ARENA_FUND_FREE_ROUNDS: '1',
    // the games its nodes host (main.js names none): nextblock
    ARENA_APPS: new URL('../../nextblock/plugin/nextblock.js', import.meta.url).pathname,
    ARENA_DONATION_NETWORK: 'regtest', ...(withSeries ? { ARENA_SERIES_FILE: join(dir, 'series.txt') } : {}) };
  delete e.ARENA_ATTACH_PROOF_DIR;
  const p = spawn(process.execPath, ['src/main.js', String(ports[k]), stores[k]], { cwd: new URL('..', import.meta.url).pathname, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; for (const s of [p.stdout, p.stderr]) s.on('data', (d) => { p.log += d; });
  return p;
};
const up = async (k) => { for (let n = 0; n < 60; n++) { try { if ((await fetch(`http://127.0.0.1:${ports[k]}/identity`)).ok) return; } catch { /* not yet */ } await wait(500); } throw new Error(`node ${k + 1} did not come up: ${nodes[k].log.trim().split('\n').filter((l) => /Error|refused/.test(l)).slice(-2).join(' | ')}`); };
const post = async (k, path, body) => { const r = await fetch(`http://127.0.0.1:${ports[k]}${path}`, { method: 'POST', body }); return { status: r.status, text: (await r.text()).slice(0, 170) }; };

let nodes = [start(0, true), start(1, true)];
await up(0); await up(1);
out({ step: 'two processes', pids: nodes.map((p) => p.pid), ports });

// ---- the round door
const genuine = seriesRound(t, i);
const gid = toHex(roundId(genuine));
const ok = await Promise.all([0, 1].map((k) => post(k, '/round', encodeRoundContract(genuine))));
const moved = { ...genuine, startTimeMs: genuine.startTimeMs + 1000n, entryCloseMs: genuine.entryCloseMs + 1000n };
const r960 = { ...seriesRound(t, 959), roundIndex: 960 };
const notHeld = seriesRound(other, i);                                                          // its id is H(another series || i)
out({ step: 'round door', genuine: { id: gid.slice(0, 16), statuses: ok.map((r) => r.status), texts: ok.map((r) => r.text), idIsTheHash: gid === toHex(roundId(genuine)) },
  movedWindow: await post(0, '/round', encodeRoundContract(moved)),
  index960: await post(0, '/round', encodeRoundContract(r960)),
  idNotTheHashOfAHeldSeries: await post(0, '/round', encodeRoundContract(notHeld)) });

// ---- an entry taken while the series is held, then the same store without the series
const preimage = secretScalar(); const eph = rand(32);
const dealt = await dealHandout({ preimage, signerNodes: keys, roundId: roundId(genuine), playerPubkey: b32(3), ephemeralSecret: eph,
  ephemeralPubkey: feldmanGroup.pointX(eph), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
const handout = await post(0, '/handout', encodeHandout(dealt.handout));
const entry = { roundId: roundId(genuine), playerPubkey: b32(3), sessionPubkey: b32(4), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n,
  joinTick: 0, stakeCommitment: sha256(preimage), vssSharesRef: handoutId(dealt.handout),
  // a shared-world round's entry names no world secret, as the page's join writes it (the seats refuse any other)
  worldSecret: worldIsShared(genuine, sharedWorldOf(genuine.gameId)) ? b32(0) : b32(9), stakePoint: dealt.handout.commitments[0],
  feePreimage: b32(0), stakeLockOutpoint: { txid: b32(0), outIdx: 0n }, feeLockOutpoint: { txid: b32(0), outIdx: 0n }, claimKeyAttestationRef: b32(0) };
out({ step: 'handout', status: handout.status });
const eid = toHex(entryId(entry));
out({ step: 'entry while held', ...(await post(0, '/entry', encodeEntryContract(entry))) });
nodes[0].kill('SIGTERM'); await wait(2500);
nodes[0] = start(0, false); await up(0);
const entry2 = { ...entry, playerPubkey: b32(13) };
out({ step: 'node 1 again, same store, without the series',
  entry: await post(0, '/entry', encodeEntryContract(entry2)),
  lock: await post(0, `/lock?entry=${eid}`, JSON.stringify(lockFieldsToJson({ paymentImage: { kind: 'point', bytes: dealt.handout.commitments[0] },
    amountMsat: 1000n, claimPk: new Uint8Array(33).fill(2), refundPk: new Uint8Array(33).fill(2), expiration: 400 }))),
  settleCommit: await post(0, `/settle-commit?round=${gid}`, '') });
for (const p of nodes) p.kill('SIGTERM');
await wait(1500);
out({ step: 'stopped', dir });
process.exit(0);
