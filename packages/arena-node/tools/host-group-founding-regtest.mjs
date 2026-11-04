#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FOUNDING WITH HOST GROUPS, ON REAL GUARDIANS (kanban #1093 part 4, the owner 2026-11-03: "The founding draw seats at most f guardians that share an
// operator, or that name the same host_group"). Private regtest only: a bitcoind and N fedimintd in setup mode (the shape of rehearsal 20), and the N seats'
// src/founding.js in this process, each driving its own fedimintd through the stock setup API.
//
// The candidates' advertisements are the installer's own (arena-installer bond.js advertFor, with the host group name its wizard takes), encoded and
// decoded as the census reads them off the chain. Default (N 11, nominal 7, so f = 2): four nodes on one provider, its name written four ways
// ("Hetzner FSN1", "hetzner fsn1", "  HETZNER   FSN1 ", "Hetzner fsn1"), three on "Home Box", four naming none. Asked: the draw seats at most f of a
// group; the alternates keep the cap; a drawn node of the big group that never takes part is replaced by an alternate that keeps it; the seven seated
// run the DKG and the federation answers; at the end at most f guardians of the federation share a host group.
//
//   HG_DIR=<dir> HG_BASE_PORT=30200 BITCOIN_BIN=<dir> FEDIMINT_BIN=<dir with fedimintd, fedimint-cli> node tools/host-group-founding-regtest.mjs
// Ports: base+1 bitcoind rpc, base+2 p2p; candidate i on base+20+10i .. +3. Everything it starts is stopped at its end.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { clocksFor } from '../../arena-protocol/src/federation-slash.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { encodeAdvert, decodeAdvert, hostGroupOf } from '../../arena-protocol/src/advert.js';
import { advertFor } from '../../arena-installer/src/bond.js';
import { createFounding } from '../src/founding.js';
import { wsSessionCount } from '../src/halts.js';

const env = process.env;
const D = resolve(env.HG_DIR || 'host-group-founding');
const BASE = Number(env.HG_BASE_PORT || 30200);
const BTC = env.BITCOIN_BIN, F = env.FEDIMINT_BIN;
if (!BTC || !F) throw new Error('BITCOIN_BIN and FEDIMINT_BIN');
const GROUPS = (env.HG_GROUPS ? env.HG_GROUPS.split(',') : ['Hetzner FSN1', 'hetzner fsn1', '  HETZNER   FSN1 ', 'Hetzner fsn1', 'Home Box', 'home box', 'Home  Box', '', '', '', '']);
const N = GROUPS.length, NOMINAL = Number(env.HG_NOMINAL || 7), f = Math.floor((NOMINAL - 1) / 3);
if (BASE + 20 + 10 * N + 3 > 32767 || BASE < 1024) throw new Error(`HG_BASE_PORT ${BASE}: every port must lie in 1024 .. 32767`);
const RPC = BASE + 1, HOME = join(D, 'home');
const ok = [];
const say = (o) => console.log(`#1093 ${JSON.stringify(o)}`);
const check = (good, line) => { ok.push(!!good); say({ check: good ? 'as expected' : 'WRONG', line }); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, s, fn) => { for (let i = 0; i < s; i++) { try { const v = await fn(); if (v) return v; } catch { /* again */ } await wait(1000); } throw new Error(`gave up waiting for ${what}`); };
const bcli = (...a) => execFileSync(join(BTC, 'bitcoin-cli'), ['-regtest', `-datadir=${join(D, 'btc')}`, `-rpcport=${RPC}`, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const height = () => Number(bcli('getblockcount'));
const mine = (n) => bcli('-rpcwallet=hg', 'generatetoaddress', String(n), bcli('-rpcwallet=hg', 'getnewaddress'));
const api = (i) => BASE + 20 + 10 * i + 1;
const setupCli = (i, ...a) => execFileSync(join(F, 'fedimint-cli'), ['--password', 'hg', 'admin', 'setup', `ws://127.0.0.1:${api(i)}`, ...a],
  { encoding: 'utf8', env: { ...env, HOME }, timeout: 120000 }).trim().replace(/^"|"$/g, '');
const pidFile = join(D, 'pids');
function down() {
  if (existsSync(pidFile)) for (const l of readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean)) { try { process.kill(-Number(l.split(' ')[0]), 'SIGKILL'); } catch { /* gone */ } }
  try { bcli('stop'); } catch { /* down */ }
}
process.on('exit', down);
process.on('SIGINT', () => process.exit(130)); process.on('SIGTERM', () => process.exit(143));

mkdirSync(join(D, 'btc'), { recursive: true }); mkdirSync(HOME, { recursive: true });
if (existsSync(pidFile)) throw new Error(`${D} was used before: give a fresh HG_DIR`);
const t0 = Date.now();
execFileSync(join(BTC, 'bitcoind'), ['-regtest', `-datadir=${join(D, 'btc')}`, `-rpcport=${RPC}`, `-port=${BASE + 2}`, '-listen=0', '-listenonion=0', '-fallbackfee=0.0001', '-daemon'], { stdio: 'ignore' });
await until('bitcoind', 60, () => bcli('getblockcount') !== '');
bcli('createwallet', 'hg'); mine(150);
const cookie = readFileSync(join(D, 'btc', 'regtest', '.cookie'), 'utf8').trim().split(':').slice(1).join(':');
for (let i = 0; i < N; i++) {
  const dir = join(D, `g${i}`), p = BASE + 20 + 10 * i;
  mkdirSync(dir, { recursive: true });
  const out = openSync(join(dir, 'fedimintd.out'), 'a');
  const c = spawn(join(F, 'fedimintd'), [], { detached: true, stdio: ['ignore', out, out], env: { ...env, HOME, FM_DATA_DIR: dir, FM_BITCOIN_NETWORK: 'regtest',
    FM_BITCOIND_URL: `http://127.0.0.1:${RPC}`, FM_BITCOIND_USERNAME: '__cookie__', FM_BITCOIND_PASSWORD: cookie,
    FM_BIND_P2P: `127.0.0.1:${p}`, FM_BIND_API: `127.0.0.1:${p + 1}`, FM_BIND_UI: `127.0.0.1:${p + 2}`, FM_BIND_METRICS: `127.0.0.1:${p + 3}`,
    FM_P2P_URL: `fedimint://127.0.0.1:${p}`, FM_API_URL: `ws://127.0.0.1:${p + 1}`, FM_ENABLE_IROH: 'false', FM_PASSWORD_API: 'hg', FM_PASSWORD_UI: 'hg', FM_DISABLE_BASE_FEES: '1' } });
  c.unref();
  appendFileSync(pidFile, `${c.pid} fedimintd-${i}\n`);
  await until(`guardian ${i}`, 180, () => /Setup UI running/.test(readFileSync(join(dir, 'fedimintd.out'), 'utf8')));
}
say({ step: `${N} guardians in setup mode`, height: height(), s: Math.round((Date.now() - t0) / 1000) });

// THE CANDIDATES, AS THE INSTALLER ADVERTISES THEM AND THE CENSUS READS THEM
const keys = Array.from({ length: N }, (_, i) => { const secret = taggedHash('ARENA/regtest/HostGroupFounding', new TextEncoder().encode(`n${i}`)); return { secret, pub: schnorr.getPublicKey(secret) }; });
const entries = keys.map((k, i) => {
  const a = advertFor({ hostGroup: GROUPS[i], nodeKey: k.pub, operatorId: `op-n${i}`, roles: ['custody'], endpoint: `http://127.0.0.1:${api(i) - 1}`, payoutPubkey: k.pub,
    maturity: 100000, softwareHash: new Uint8Array(32), guardianEndpoint: `ws://127.0.0.1:${api(i)}` });
  return { pubkey: k.pub, txid: taggedHash('ARENA/regtest/HostGroupFounding/bond', Uint8Array.of(i)), vout: 0, bondSats: 1000000n, advert: decodeAdvert(encodeAdvert(a)) };
});
const groupName = (i) => (GROUPS[i].trim() ? GROUPS[i].trim().toLowerCase().replace(/\s+/g, ' ') : `alone:n${i}`);
const groups = new Set(entries.filter((e) => e.advert.hostGroup).map((e) => toHex(e.advert.hostGroup)));
check(groups.size === new Set(GROUPS.filter((g) => g.trim()).map((g) => toHex(hostGroupOf(g)))).size && entries.every((e, i) => !GROUPS[i].trim() || toHex(e.advert.hostGroup) === toHex(hostGroupOf(GROUPS[i]))),
  `the adverts carry ${groups.size} host groups for ${GROUPS.filter((g) => g.trim()).length} named nodes (case and spaces are one group), ${GROUPS.filter((g) => !g.trim()).length} nodes name none`);
const ix = (hex) => keys.findIndex((k) => toHex(k.pub) === hex);
const verify = (sig, m, k) => { try { return schnorr.verify(sig, m, k); } catch { return false; } };
const capKept = (list) => { const c = new Map(); for (const i of list) if (GROUPS[i].trim()) c.set(groupName(i), (c.get(groupName(i)) || 0) + 1); return { ok: [...c.values()].every((n) => n <= f), counts: Object.fromEntries(c) }; };

const { clocks } = clocksFor('regtest');
const trigger = height();
const seed = Uint8Array.from(Buffer.from(bcli('getblockhash', String(trigger)), 'hex').reverse());
const seats = [];
for (let i = 0; i < N; i++) {
  seats.push(createFounding({ seed, triggerHeight: trigger, entries, nominal: NOMINAL, bondMinGuardian: 500000n, foundingWindow: clocks.foundingWindow,
    ownKey: keys[i].pub, sign: (h) => schnorr.sign(h, keys[i].secret), verify, name: 'hg',
    setup: {
      localParams: async ({ leader, name, size }) => setupCli(i, 'set-local-params', `n${i}`, ...(leader ? ['--federation-name', name, '--federation-size', String(size)] : [])),
      addPeer: async (code) => { setupCli(i, 'add-peer', code); },
      startDkg: async () => { setupCli(i, 'start-dkg'); },
      invite: async () => null,
    },
    post: async (m) => { for (const s of seats) s.take(m); },
    say: (o) => { if (env.VERBOSE) say({ step: 'seat says', seat: i, ...o }); } }));
}
const draw = seats[0].state();
const drawn = draw.seated.map((x) => ix(x.node)), alternates = draw.alternates.map(ix);
const dc = capKept(drawn);
check(drawn.length === NOMINAL && dc.ok, `the draw: ${NOMINAL} seated ${JSON.stringify(drawn.map((i) => `n${i} ${groupName(i)}`))}, per host group ${JSON.stringify(dc.counts)} (at most f = ${f})`);
check(alternates.every((a) => capKept([...drawn, a]).ok),
  `the alternates in order: ${JSON.stringify(alternates.map((i) => `n${i} ${groupName(i)}`))}`);
// THE NO-SHOW: the first drawn node of the biggest group never takes part, when an alternate exists to replace it
const big = drawn.find((i) => groupName(i) === groupName(0));
const SILENT = alternates.length && big !== undefined && env.HG_SILENT !== '0' ? big : -1;
say({ step: 'draw', trigger, seed: toHex(seed).slice(0, 16), id: draw.id.slice(0, 16), silent: SILENT >= 0 ? `n${SILENT} ${groupName(SILENT)}` : null, foundingWindow: clocks.foundingWindow });
const t1 = Date.now();
let st = null;
for (let n = 0; n < 60; n++) {
  const tip = height();
  for (let i = 0; i < N; i++) if (i !== SILENT) { try { await seats[i].advance(tip); } catch (e) { say({ step: 'step failed', seat: i, tip, why: String(e.message).slice(0, 300) }); } }
  st = seats[SILENT === 0 ? 1 : 0].state();
  if (st.seated.every((x) => seats[ix(x.node)].state().started)) break;
  mine(1);
}
const seatedNow = st.seated.map((x) => ix(x.node));
const sc = capKept(seatedNow);
check(sc.ok && seatedNow.length === NOMINAL && (SILENT < 0 || !seatedNow.includes(SILENT)),
  `the DKG started on ${seatedNow.length} seated ${JSON.stringify(seatedNow.map((i) => `n${i} ${groupName(i)}`))}, no-shows ${JSON.stringify(st.noShows.map((x) => `n${ix(x)}`))}, per host group ${JSON.stringify(sc.counts)}, after ${height() - trigger} blocks, ${Math.round((Date.now() - t1) / 1000)} s`);
for (let t = 0; t < 120; t++) { if (seatedNow.every((g) => existsSync(join(D, `g${g}`, 'invite-code')))) break; await wait(3000); }
const rows = [];
for (const g of seatedNow) {
  const inv = existsSync(join(D, `g${g}`, 'invite-code')) ? readFileSync(join(D, `g${g}`, 'invite-code'), 'utf8').trim().replace(/"/g, '') : null;
  let session = null; try { session = await wsSessionCount(`ws://127.0.0.1:${api(g)}`, { timeoutMs: 10000, overrides: '' }); } catch (e) { session = `no answer: ${e.message}`.slice(0, 80); }
  let peers = null; try { const c = JSON.parse(readFileSync(join(D, `g${g}`, 'client.json'), 'utf8')); peers = JSON.stringify((c.global || c).broadcast_public_keys); } catch { peers = null; }
  rows.push({ guardian: `n${g}`, group: groupName(g), invite: inv ? `${inv.slice(0, 12)}...${inv.slice(-8)}` : null, session, peers });
}
const configs = new Set(rows.map((r) => r.peers).filter(Boolean));
const peerCount = rows[0] && rows[0].peers ? Object.keys(JSON.parse(rows[0].peers)).length : 0;
for (const r of rows) r.peers = r.peers ? `${peerCount} keys` : null;
check(configs.size === 1 && rows.every((r) => r.invite) && peerCount === NOMINAL && (SILENT < 0 || !existsSync(join(D, `g${SILENT}`, 'invite-code'))),
  `the federation: one config over ${peerCount} guardians, every seated one answers: ${JSON.stringify(rows.map((r) => `${r.guardian} ${r.group} session ${r.session}`))}`);
say({ done: true, asExpected: ok.filter(Boolean).length, of: ok.length, s: Math.round((Date.now() - t0) / 1000) });
process.exit(ok.every(Boolean) ? 0 : 1);
