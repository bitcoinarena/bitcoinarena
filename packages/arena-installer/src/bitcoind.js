// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// BITCOIN CORE, INSTALLED BY THE WIZARD WHEN ASKED (ruling 8; 2026-10-18: "471 can also install bitcoind if
// requested and not installed yet. It evaluates how much disk space is needed and [warns] if [it is] not enough for both main net and
// Testnet4. It runs bitcoind as a service and the monitor in the website monitors the progress and gives an eta how long it will take.
// Tells user to bookmark this page as it can take days on main net. Once complete the setup continues. Includes setting it up and a
// wallet and connection").
//
//   detect     a bitcoind already on PATH or in the usual places - then nothing is installed (the user connects it)
//   disk       the free space where the chain goes, against what each network needs - measured 2026-10-18 on the the test host's own
//              nodes: mainnet 825 GB of blocks + 12 GB chainstate (+13 GB indexes, not needed), testnet4 13 GB + 2 GB - and a
//              pruned node's (the chainstate and 2 GB of blocks); a warning when it is not enough for both, the pruned fallback named
//   install    Bitcoin Core 31.1 for this system, its download checked against the SHA-256 bitcoincore.org's SHA256SUMS names
//   configure  one datadir per network under the node's home, its bitcoin.conf (server, cookie, RPC on 127.0.0.1 only, prune when
//              chosen), a user service (systemd unit; launchd / scheduled task through service.js on macOS / Windows)
//   status     the sync's progress as bitcoind says it, with an ETA from the progress measured between two readings
// When the sync is done the chain step is saved with this node (state.chain), and the wizard goes on.
import { existsSync, mkdirSync, writeFileSync, statfsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { coreRpc } from './chain-test.js';

export const CORE_VERSION = '31.1';
/** The release files and their SHA-256 (bitcoincore.org/bin/bitcoin-core-31.1/SHA256SUMS, read 2026-10-18). */
export const CORE_FILES = Object.freeze({
  'linux-x64': { file: 'bitcoin-31.1-x86_64-linux-gnu.tar.gz', sha256: 'b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e' },
  'linux-arm64': { file: 'bitcoin-31.1-aarch64-linux-gnu.tar.gz', sha256: 'dcf1873f2208ba4f962f3398d47e154c39c0084be8f4553e05c940d0ace3d004' },
  'darwin-x64': { file: 'bitcoin-31.1-x86_64-apple-darwin.tar.gz', sha256: 'bc506958d0f387c1ea770bdc7c7192a505fa645ff62cabcc7761fa7eb89e867e' },
  'darwin-arm64': { file: 'bitcoin-31.1-arm64-apple-darwin.tar.gz', sha256: '16a097c09fbd7eb78b240ce1dae123663ea2e5e377cfd6a951e71e227e23cf2f' },
  'win32-x64': { file: 'bitcoin-31.1-win64.zip', sha256: 'c99ef173471c58e6766d9eebd12e6c35349082eeed3939bc99eed58ef57db587' },
});

const GB = 1024 ** 3;
/** What each network needs on disk, full and pruned, with headroom for a year's growth (measured sizes above). */
export const NEEDS = Object.freeze({
  mainnet: { fullBytes: 950 * GB, prunedBytes: 20 * GB, note: '825 GB of blocks and 12 GB of chainstate measured 2026-10-18; ~60 GB a year more' },
  testnet4: { fullBytes: 25 * GB, prunedBytes: 6 * GB, note: '13 GB of blocks and 2 GB of chainstate measured 2026-10-18' },
});
/** Ports of the node's own bitcoind per network: RPC (127.0.0.1 only) and peers. */
export const PORTS = Object.freeze({ testnet4: { rpc: 48342, p2p: 48343 }, mainnet: { rpc: 8342, p2p: 8343 } });

/** A bitcoind already here: PATH or the usual places. Answers its path or null. */
export async function detectBitcoind({ sh = run, home } = {}) {
  const w = await sh(process.platform === 'win32' ? 'where' : 'which', ['bitcoind']);
  if (w.ok && w.out.trim()) return w.out.trim().split(/\r?\n/)[0];
  for (const p of ['/usr/local/bin/bitcoind', '/usr/bin/bitcoind', '/opt/homebrew/bin/bitcoind', home && join(home, 'bitcoin-core', `bitcoin-${CORE_VERSION}`, 'bin', 'bitcoind')])
    if (p && existsSync(p)) return p;
  return null;
}

/**
 * The disk where the chain goes, against what the networks need. Answers { freeBytes, networks: { mainnet: { full, pruned },
 * testnet4: {...} }, both: { full, pruned }, warn } - `warn` says, in words, what does not fit.
 */
export function diskCheck(dir, { statfs = statfsSync } = {}) {
  mkdirSync(dir, { recursive: true });
  const s = statfs(dir);
  const freeBytes = Number(s.bavail) * Number(s.bsize);
  const fits = (n) => ({ full: freeBytes >= NEEDS[n].fullBytes, pruned: freeBytes >= NEEDS[n].prunedBytes, ...NEEDS[n] });
  const networks = { mainnet: fits('mainnet'), testnet4: fits('testnet4') };
  const both = { full: freeBytes >= NEEDS.mainnet.fullBytes + NEEDS.testnet4.fullBytes, pruned: freeBytes >= NEEDS.mainnet.prunedBytes + NEEDS.testnet4.prunedBytes };
  const gb = (b) => `${Math.round(b / GB)} GB`;
  const warn = both.full ? null
    : `${gb(freeBytes)} free: not enough for both full nodes (mainnet ${gb(NEEDS.mainnet.fullBytes)} + testnet4 ${gb(NEEDS.testnet4.fullBytes)}).`
      + (networks.testnet4.full ? ' A full testnet4 node fits' : ' Not even a full testnet4 node fits')
      + (both.pruned ? `; both fit pruned (${gb(NEEDS.mainnet.prunedBytes + NEEDS.testnet4.prunedBytes)}).` : networks.testnet4.pruned ? '; a pruned testnet4 node fits.' : '.');
  return { dir, freeBytes, networks, both, warn };
}

const run = (cmd, args, opts = {}) => new Promise((resolve) => execFile(cmd, args, { timeout: 600000, ...opts }, (e, out, err) => resolve({ ok: !e, out: String(out), err: String(err) })));

/** Download and unpack Bitcoin Core for this system into <home>/bitcoin-core, checked by SHA-256. Answers { ok, bitcoind, why }. */
export async function installCore({ home, platform = process.platform, arch = process.arch, fetcher = fetch, sh = run, onStage = () => {}, onBytes = () => {} }) {
  const f = CORE_FILES[`${platform}-${arch}`];
  if (!f) return { ok: false, why: `no Bitcoin Core release for ${platform}-${arch}` };
  const dir = join(home, 'bitcoin-core');
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, `bitcoin-${CORE_VERSION}`, 'bin', platform === 'win32' ? 'bitcoind.exe' : 'bitcoind');
  if (existsSync(bin)) return { ok: true, bitcoind: bin, already: true };
  onStage('download');
  const r = await fetcher(`https://bitcoincore.org/bin/bitcoin-core-${CORE_VERSION}/${f.file}`);
  if (r.status !== 200) return { ok: false, why: `bitcoincore.org answered ${r.status} for ${f.file}` };
  // THE DOWNLOAD COUNTED AS IT COMES (the owner's playtest 2026-10-25, "Downloading Bitcoin Core and checking it…": "Füge auch hier
  // eine Progress Bar hinzu"): bytes so far of the size bitcoincore.org names
  const total = Number((r.headers && r.headers.get && r.headers.get('content-length')) || 0);
  let bytes;
  if (r.body && typeof r.body.getReader === 'function') {
    const parts = []; let got = 0; const rd = r.body.getReader();
    for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; onBytes(got, total); }
    bytes = Buffer.concat(parts);
  } else bytes = Buffer.from(await r.arrayBuffer());
  onStage('check');
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== f.sha256) return { ok: false, why: `${f.file} is not the published file (sha256 ${sha.slice(0, 16)}, published ${f.sha256.slice(0, 16)})` };
  const archive = join(dir, f.file);
  writeFileSync(archive, bytes);
  onStage('unpack');
  const x = f.file.endsWith('.zip') ? await sh('tar', ['-xf', archive, '-C', dir]) : await sh('tar', ['-xzf', archive, '-C', dir]);
  if (!x.ok || !existsSync(bin)) return { ok: false, why: `unpacking ${f.file} failed: ${x.err.trim().slice(0, 200)}` };
  return { ok: true, bitcoind: bin, sha256: sha };
}

/** One network's datadir and bitcoin.conf under the node's home. Answers { datadir, conf, rpcUrl, cookiePath }. */
/** Is this TCP port free on 127.0.0.1 (nothing listening, nothing refusing the bind)? */
export const portFree = (port) => new Promise((ok) => {
  const srv = createServer();
  srv.once('error', () => ok(false));
  srv.listen(port, '127.0.0.1', () => srv.close(() => ok(true)));
});
/**
 * THE CORE'S PORTS, FREE ONES (kanban #635, the owner's playtest 2026-10-25: the installer's Core on his test host exited 26 times - "Binding
 * RPC on address 127.0.0.1 port 48342 failed", another Bitcoin Core held it - and the page said "bitcoind is starting (no cookie yet)"
 * for ever): the network's pair, else the next pair 10 up, checked on this machine before the config names them.
 */
export async function freeCorePorts(network = 'testnet4', { free = portFree, tries = 50 } = {}) {
  const base = PORTS[network];
  for (let i = 0; i < tries; i++) {
    const rpc = base.rpc + 10 * i, p2p = base.p2p + 10 * i;
    if (await free(rpc) && await free(p2p)) return { rpc, p2p };
  }
  throw new Error(`no free ports for Bitcoin Core (${network}) from ${base.rpc} on`);
}

export function configureCore({ home, network = 'testnet4', prune = false, dbcacheMb = 1000, ports = PORTS[network] }) {
  const datadir = join(home, `bitcoin-${network}`);
  mkdirSync(datadir, { recursive: true });
  const p = ports;
  const sect = network === 'mainnet' ? 'main' : network;
  const conf = [
    `# The Arena node's own Bitcoin Core (ruling 8), written by the installer.`,
    ...(network === 'testnet4' ? ['testnet4=1'] : []),
    'server=1', `dbcache=${dbcacheMb}`, ...(prune ? ['prune=2000'] : []),
    // ITS PEER PORT ON THIS MACHINE ONLY (the Windows VM 2026-10-19: listening on every network, bitcoind made Windows Firewall
    // ask the user to open it to public networks): the node needs no inbound Bitcoin peers - its outbound ones are as before
    `[${sect}]`, 'rpcbind=127.0.0.1', 'rpcallowip=127.0.0.1', `rpcport=${p.rpc}`, `port=${p.p2p}`, `bind=127.0.0.1:${p.p2p}`, '',
  ].join('\n');
  writeFileSync(join(datadir, 'bitcoin.conf'), conf);
  const cookieDir = network === 'mainnet' ? datadir : join(datadir, network);
  return { datadir, conf: join(datadir, 'bitcoin.conf'), rpcUrl: `http://127.0.0.1:${p.rpc}/`, cookiePath: join(cookieDir, '.cookie') };
}

/** The command line the node's bitcoind runs with (service.js installProgram makes it a service on each system). */
export const coreArgs = ({ bitcoind, datadir }) => [bitcoind, `-datadir=${datadir}`, `-conf=${join(datadir, 'bitcoin.conf')}`];

/** How long the ETA looks back, and how much it needs before it says one: measured 2026-10-18 on a fresh testnet4 sync, a 10 s
 *  window gave 2,973 then 109 minutes 70 s apart (the first blocks are nearly empty and the progress weighs transactions). */
export const ETA_WINDOW_MS = 10 * 60000;
export const ETA_MIN_SPAN_MS = 2 * 60000;

/**
 * THE SYNC, AS BITCOIND SAYS IT: blocks, headers, verification progress and an ETA from the progress made over the last ETA_WINDOW_MS
 * (`samples`: [{ atMs, progress }], kept by the caller; this reading is added). Answers { ok, blocks, headers, progress, synced, etaMs,
 * samples, why } - etaMs null until ETA_MIN_SPAN_MS of readings.
 */
/**
 * WHY A CORE DOES NOT ANSWER, FROM ITS OWN debug.log (beside its cookie): the last "Error:" since its last start, and whether it is a port
 * another program holds (`portTaken` - the wizard then moves it to free ports). null when the log names no error.
 */
export function coreFailure(cookiePath, { read = (f) => readFileSync(f, 'utf8') } = {}) {
  let text; try { text = read(join(dirname(cookiePath), 'debug.log')); } catch { return null; }
  const run = text.slice(Math.max(0, text.lastIndexOf('Bitcoin Core version')));
  const err = run.split('\n').filter((l) => /\[error\]|^Error:/.test(l)).pop();
  if (!err) return null;
  const portTaken = /Unable to bind|Binding RPC .* failed|Unable to start HTTP server/i.test(run);
  return { why: portTaken ? 'Bitcoin Core stopped: another program uses its port' : `Bitcoin Core stopped: ${err.replace(/^.*?(\[error\]|Error:)\s*/, '')}`, portTaken };
}

export async function syncStatus({ rpcUrl, cookiePath, samples = [], nowMs = Date.now(), fetcher = fetch }) {
  if (!existsSync(cookiePath)) { const f = coreFailure(cookiePath); return f ? { ok: false, why: f.why, portTaken: f.portTaken, samples } : { ok: false, why: 'Bitcoin Core is starting', samples }; }
  try {
    const info = await coreRpc({ url: rpcUrl, cookiePath, fetcher })('getblockchaininfo');
    const progress = Number(info.verificationprogress);
    // SYNCED WHEN EVERY BLOCK IS IN (kanban #636, the owner's playtest 2026-10-25: "bitcoin core testnet4 pruned downloads to 100% and then
    // nothing happens"): Core keeps initialblockdownload on while its tip is older than a day, so a node at the tip with all headers and
    // verification at 99.99 % counts as synced too
    const atTip = info.blocks >= info.headers - 1 && info.headers > 0;
    const synced = atTip && (!info.initialblockdownload || progress >= 0.9999);
    const kept = [...samples.filter((x) => nowMs - x.atMs <= ETA_WINDOW_MS), { atMs: nowMs, progress }];
    const first = kept[0];
    let etaMs = null;
    if (!synced && nowMs - first.atMs >= ETA_MIN_SPAN_MS && progress > first.progress)
      etaMs = Math.round((1 - progress) * (nowMs - first.atMs) / (progress - first.progress));
    return { ok: true, chain: info.chain, blocks: info.blocks, headers: info.headers, progress, synced, etaMs: synced ? 0 : etaMs,
      sizeOnDisk: info.size_on_disk, pruned: Boolean(info.pruned), atMs: nowMs, samples: kept };
  } catch (e) { const f = coreFailure(cookiePath); return f ? { ok: false, why: f.why, portTaken: f.portTaken, samples } : { ok: false, why: e.message, samples }; }
}
