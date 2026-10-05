// THE READINGS OF THE TESTNET4 STACK TOOLS ON A PRIVATE REGTEST (kanban #148 step 6, plan comment 235, Go 2026-10-05).
// tools/tn4-tools-regtest.sh stands the stack up and runs each tool as it is run live; this answers what each one left
// behind, one JSON line per reading, and refuses the whole run first if anything points at the live testnet4 stack.
//
//   node tools/tn4-tools-regtest.mjs safe        - every dir, port and macaroon of the run checked against the live stack
//   node tools/tn4-tools-regtest.mjs federation  - reading 1: 7 guardians, threshold 5, consensus running
//   node tools/tn4-tools-regtest.mjs invite      - reading 1, its invite (after step 4): the seven-peer invite reads back
//   node tools/tn4-tools-regtest.mjs gateways    - reading 2: both roots at all 7 guardians, no 127.0.0.1 entry
//   node tools/tn4-tools-regtest.mjs round <id>  - reading 4: one bond per node six deep, the round open at 7, POST /round 201
//   node tools/tn4-tools-regtest.mjs lnaddr      - reading 6: the lnurlp answer, an invoice whose description hash matches
// Everything is read from the env tn4-tools-regtest.sh exports (H, NODE_PORTS, the bitcoind, the lnds).
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readInvite } from '../src/invite.js';
import { regtest } from './regtest-bond.mjs';
import { decodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

const env = process.env;
const [mode, arg] = process.argv.slice(2);
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), mode, ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const fail = (why, o = {}) => { say({ ok: false, why, ...o }); process.exit(1); };
const H = env.H;
const nodePorts = String(env.NODE_PORTS || '').split(',').filter(Boolean).map(Number);
const stores = nodePorts.map((_, i) => join(H, `node-${i + 1}.db`));
const cli = (...a) => execFileSync(env.BITCOIN_CLI, [`-datadir=${env.BTC_DIR}`, `-rpcwallet=${env.BLWP_TN4_WALLET}`, ...a], { encoding: 'utf8' }).trim();
const fc = (...a) => execFileSync(join(env.FORK_BIN, 'fedimint-cli'), ['--data-dir', env.CLIENT_DIR, ...a],
  { encoding: 'utf8', timeout: 120000, env: { ...env, HOME: env.FORK_HOME } }).replace(/\x1b\[[0-9;]*m/g, '');
const lastJson = (s) => JSON.parse(s.slice(s.lastIndexOf('\n{') + 1 || s.indexOf('{')));

// THE LIVE STACK, as named in the memory of this machine: the testnet4 chain and its rpc, the tn4 seats and their
// guardians, the free pair and the Daily, the live lnds and gateways, the donors, signal-cli and the old regtest port.
const LIVE_PORTS = new Set([8080, 30101, 48332, 18080, 18081, 18985, 18986, 18777, 18787, 11009, 8180, 31270, 31271, 31272, 31280,
  31281, 31282, 31290, 9351, 9352, 9381]);
for (const p of [31221, 31231, 31241, 31251, 31261, 31271, 31281]) for (const d of [0, 1000, 2000, 3000, 4000]) LIVE_PORTS.add(p + d);
const LIVE_DIRS = ['/mnt/bitcoin/tn4', '/mnt/bitcoin/lnd-testnet4', '/home/arena/blwp-testnet4/node-', '/home/arena/blwp-testnet4/paid',
  '/home/arena/blwp-testnet4/client-lock-tn4', '/home/arena/blwp-testnet4/gw-', '/home/arena/blwp-testnet4/donor',
  '/mnt/bitcoin/blwp-2of2', '/mnt/bitcoin/lnd-'];
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const portFree = (port) => new Promise((ok) => {
  const s = createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); ok(false); });
  s.on('error', () => ok(true));
  s.setTimeout(1500, () => { s.destroy(); ok(true); });
});

if (mode === 'safe') {
  if (!H || !real(H).startsWith('/tmp/')) fail(`H (${H}) is not a fresh dir under /tmp`);
  const ports = String(env.RUN_PORTS || '').split(',').filter(Boolean).map(Number);
  const dirs = String(env.RUN_DIRS || '').split(',').filter(Boolean);
  const macaroons = String(env.RUN_MACAROONS || '').split(',').filter(Boolean);
  const live = ports.filter((p) => LIVE_PORTS.has(p));
  if (live.length) fail('a port of this run is a port of the live stack', { live });
  for (const d of [...dirs, ...macaroons]) {
    const r = real(d);
    if (LIVE_DIRS.some((x) => r.startsWith(x))) fail(`${d} is inside the live stack`, { resolved: r });
    if (!r.startsWith(real(H))) fail(`${d} is outside this run's dir ${H}`);
  }
  if (env.BLWP_TN4_NETWORK !== 'regtest') fail(`BLWP_TN4_NETWORK is ${env.BLWP_TN4_NETWORK}, not regtest`);
  if (real(env.BLWP_TESTNET4_DIR || '') !== real(H)) fail('BLWP_TESTNET4_DIR is not this run\'s dir');
  const busy = [];
  for (const p of ports) if (!(await portFree(p))) busy.push(p);
  if (busy.length) fail('a port of this run already answers: something else holds it', { busy });
  say({ ok: true, ports: ports.length, dirs: dirs.length, macaroons: macaroons.length, network: env.BLWP_TN4_NETWORK });
  process.exit(0);
}

if (mode === 'federation') {
  const invite = readFileSync(join(H, 'invite-code'), 'utf8').replace(/["\s]/g, '');
  const named = readInvite(invite);
  const consensus = stores.map((s) => JSON.parse(readFileSync(`${s}.guardian/consensus.json`, 'utf8')));
  const keys = consensus.map((c) => Object.keys(c.broadcast_public_keys || {}).length);
  const g = lastJson(execFileSync(env.LOCK_BIN, ['--mode', 'guardians', '--data-dir', env.CLIENT_DIR], { encoding: 'utf8', timeout: 120000 }));
  const sessions = stores.map((s) => {
    const log = existsSync(`${s}.guardian/fedimintd.log`) ? readFileSync(`${s}.guardian/fedimintd.log`, 'utf8').replace(/\x1b\[[0-9;]*m/g, '') : '';
    return (log.match(/Completed consensus session/g) || []).length;
  });
  // THE FOUNDING'S OWN INVITE NAMES ONE GUARDIAN (as the live founding's did, item 5 2026-09-28); the seven-peer invite
  // is the one run-testnet4-paid.mjs writes, read back in mode `invite` after step 4.
  const out = { foundingInvitePeers: named.guardians.length, federationId: named.federationId.slice(0, 16), configKeys: keys,
    guardians: g.guardians, threshold: g.threshold, lockClientFederation: String(g.federation_id).slice(0, 16), sessionsPerGuardian: sessions };
  const ok = named.guardians.length >= 1 && keys.every((k) => k === 7) && g.guardians === 7 && g.threshold === 5
    && g.federation_id === named.federationId && sessions.every((n) => n > 0);
  say({ reading: 1, ok, ...out });
  process.exit(ok ? 0 : 1);
}

if (mode === 'invite') {
  // reading 1, its invite: the one run-testnet4-paid.mjs wrote into paid/testnet4.json - every guardian, the same federation
  const founded = readInvite(readFileSync(join(H, 'invite-code'), 'utf8').replace(/["\s]/g, ''));
  const written = readInvite(JSON.parse(readFileSync(join(H, 'paid', 'testnet4.json'), 'utf8')).federation);
  const peers = written.guardians.map((g) => g.peer).sort((a, b) => a - b);
  const ok = written.guardians.length === 7 && written.federationId === founded.federationId && peers.join() === '0,1,2,3,4,5,6';
  say({ reading: '1-invite', ok, invitePeers: written.guardians.length, peers, urls: written.guardians.map((g) => g.url),
    sameFederation: written.federationId === founded.federationId });
  process.exit(ok ? 0 : 1);
}

if (mode === 'gateways') {
  const want = String(env.GATEWAY_ROOTS).split(',');
  const lists = [];
  for (let peer = 0; peer < 7; peer++) {
    const s = fc('module', 'lnv2', 'gateways', 'list', '--peer', String(peer));
    lists.push(JSON.parse(s.slice(s.indexOf('['), s.lastIndexOf(']') + 1)));
  }
  const norm = (u) => String(u).replace(/\/+$/, '');
  const every = lists.every((l) => want.every((w) => l.map(norm).includes(norm(w))));
  const loopback = lists.flat().filter((u) => /127\.0\.0\.1/.test(u));
  const ok = every && !loopback.length;
  say({ reading: 2, ok, roots: want, perGuardian: lists.map((l) => l.length), loopbackLeft: loopback });
  process.exit(ok ? 0 : 1);
}

if (mode === 'round') {
  const id = arg;
  const rt = regtest(cli, { network: 'regtest', wallet: env.BLWP_TN4_WALLET });
  const tip = Number(cli('getblockcount'));
  const seats = [];
  let contractBytes = null;
  for (const p of nodePorts) {
    const pubkey = new Uint8Array(await (await fetch(`http://127.0.0.1:${p}/identity`)).arrayBuffer()); // 32 bytes, x-only
    const bonds = rt.bondsOf({ pubkey });
    const r = await fetch(`http://127.0.0.1:${p}/round?id=${id}`);
    const bytes = r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    if (bytes && !contractBytes) contractBytes = bytes;
    const open = bytes ? toHex(roundId(decodeRoundContract(bytes))) === id : false;
    seats.push({ port: p, node: toHex(pubkey).slice(0, 12), bonds: bonds.length, depth: bonds.length ? tip - bonds[0].height + 1 : 0, open });
  }
  // THE PREFLIGHT the paid harness makes before any deposit: the round's own contract posted to every seat, 201 each
  const posted = [];
  for (const p of nodePorts) {
    const r = await fetch(`http://127.0.0.1:${p}/round`, { method: 'POST', body: contractBytes });
    posted.push(r.status);
  }
  const ok = seats.every((s) => s.bonds === 1 && s.depth >= 6 && s.open) && posted.every((s) => s === 201);
  say({ reading: 4, ok, round: id.slice(0, 16), tip, seats, postRound: posted });
  process.exit(ok ? 0 : 1);
}

if (mode === 'lnaddr') {
  const base = env.LNADDR_PUBLIC.replace(/\/+$/, '');
  const name = 'winner';
  const lnurlp = await (await fetch(`${base}/.well-known/lnurlp/${name}`)).json();
  const cb = await (await fetch(`${lnurlp.callback}?amount=21000`)).json();
  const dec = JSON.parse(execFileSync(env.LNCLI, [`--lnddir=${env.LNADDR_LND_DIR}`, `--rpcserver=${env.LNADDR_LND_RPC}`, '--network=regtest',
    'decodepayreq', cb.pr], { encoding: 'utf8' }));
  const want = createHash('sha256').update(lnurlp.metadata).digest('hex');
  const ok = lnurlp.tag === 'payRequest' && dec.description_hash === want && Number(dec.num_msat) === 21000;
  say({ reading: 6, ok, tag: lnurlp.tag, callback: lnurlp.callback, metadata: lnurlp.metadata, invoiceMsat: dec.num_msat,
    descriptionHash: dec.description_hash, sha256OfMetadata: want });
  process.exit(ok ? 0 : 1);
}

fail(`no mode ${mode}`);
