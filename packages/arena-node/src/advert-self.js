// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT'S OWN guardian_of UPDATE, CHECKED OFF THE SEAT'S THREAD (kanban #705, measured on testnet4 2026-10-26 ~12:20Z): the check
// reads the bond wallet with bitcoin-cli, synchronously - its bonds, the newest update of the first (a scantxoutset over the whole
// UTXO set and a getrawtransaction per marker) - and on the seat's thread that held the loop 2-3 minutes every 10 min. Seat 6's
// accept queue filled (Recv-Q 512) and a CPU profile of it was 94.9 % spawn from this check. Here the whole check runs in a worker,
// one per check; the seat's thread only waits for its answer.
//
// AND NO UTXO SCAN WHEN NOTHING CAN BE DUE (kanban #741, measured on the test host 2026-10-28 ~00:40-01:05Z, 7 seats on one testnet4
// bitcoind): every seat scanned the whole UTXO set every 10 min whether or not its advertisement lacked anything. getrpcinfo showed a
// scantxoutset running in 6 of 6 samples over 30 s, the seats logged "Scan already in progress" 357-1,277 times each (bitcoind runs one
// scan at a time, the others retried every 2 s for up to 4 min), and meanwhile their own getblockheader / getblockcount timed out - after a
// restart they had no chain view, knew no peers and could not settle. Now:
//  - the seat compares what its advertisement should name (its guardians, the games it hosts) with what its own census entry names - data
//    it holds already. Only when they differ is the wallet read, and the same wanted advertisement is not read for again within 6 h (an
//    update posted waits for the census to take it; a dry run or a refusal is not repeated every 10 min);
//  - the bond wallet's own view cannot find the bond: the bond output pays the bond key and every update pays the network's marker dust,
//    neither a wallet address - so a read is one scantxoutset (both descriptors at once, where it was up to six), and only one scan per
//    bitcoind on the machine at a time (a lock file beside the seats' stores). A scan busy - the lock held, or bitcoind answering "Scan
//    already in progress" - is not waited for: the check gives up until the next one, 10 min on;
//  - the first check is 5-15 min after the start, by the seat's key, so seven seats restarted together do not check together.
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, unlinkSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

/** A wanted advertisement read for once is not read for again within this (an update posted waits for the census, ~2 h on testnet4). */
export const READ_AGAIN_MS = 6 * 3600000;
const LOCK_STALE_MS = 30 * 60000;

/** The first check after a start: 5-15 min, spread by the seat's key (seven seats restarted together check apart). */
export function firstCheckDelayMs(pubkey) {
  const b = pubkey instanceof Uint8Array ? pubkey : fromHex(String(pubkey));
  const n = ((b[b.length - 2] << 8) | b[b.length - 1]) >>> 0;
  return 300000 + Math.floor((n / 65536) * 600000);
}

/** What the advertisement should name, as one string: its guardians (federation:key) and hosted games, sorted. */
export function wantedKey({ mine = [], hostedGames = [] }) {
  const g = mine.map((e) => `${toHex(e.federationId)}:${toHex(e.guardianKey)}`).sort();
  const h = [...new Set(hostedGames.map((x) => (typeof x === 'string' ? x : toHex(x))))].sort();
  return `${g.join(',')}|${h.join(',')}`;
}

/**
 * IS A WALLET READ DUE? Off data the seat holds: `entries` its census (null when it reads none, [] when not read yet), `pubkey` its own key,
 * `last` the update it posted (`.advert-self.json`), `lastRead` its last read in this run. Answers { due, why, want }.
 */
export function ownAdvertDue({ entries, pubkey, mine = [], hostedGames = [], last = null, lastRead = null, nowMs = Date.now() }) {
  const want = wantedKey({ mine, hostedGames });
  if (last && last.want === want && nowMs - Number(last.atMs || 0) < READ_AGAIN_MS) return { due: false, want, why: `update ${String(last.txid || '').slice(0, 16)} posted, the census takes it once 6 deep` };
  if (lastRead && lastRead.want === want && nowMs - lastRead.atMs < READ_AGAIN_MS) return { due: false, want, why: `read ${Math.round((nowMs - lastRead.atMs) / 60000)} min ago for the same guardians and games` };
  if (entries === null || entries === undefined) return { due: true, want, why: 'this seat reads no census' };
  if (!entries.length) return { due: false, want, why: 'the census is not read yet' };
  const me = toHex(pubkey);
  const own = entries.filter((e) => e && e.pubkey && toHex(e.pubkey) === me && e.advert);
  if (!own.length) return { due: true, want, why: 'the census has no entry of this seat' };
  const names = (a, e) => {
    const g = new Set(((a.guardianOf) || []).map((x) => `${toHex(x.federationId)}:${toHex(x.guardianKey)}`));
    const h = new Set([...(a.hostedGames || []), ...(e.hostedGames || [])].map((x) => (typeof x === 'string' ? x : toHex(x))));
    const lacks = [...mine.filter((m) => !g.has(`${toHex(m.federationId)}:${toHex(m.guardianKey)}`)).map((m) => `guardian ${toHex(m.federationId).slice(0, 8)}`),
      ...hostedGames.map((x) => (typeof x === 'string' ? x : toHex(x))).filter((x) => !h.has(x)).map((x) => `game ${x.slice(0, 8)}`)];
    return lacks;
  };
  const lacks = own.map((e) => names(e.advert, e)).sort((a, b) => a.length - b.length)[0];
  if (!lacks.length) return { due: false, want, why: 'it names every guardian and game' };
  return { due: true, want, why: `it lacks ${lacks.join(', ')}` };
}

/** One scan per bitcoind on this machine: the lock's name from the bitcoin-cli words (its datadir, port, host), not the wallet. */
function scanLockPath(lockDir, cliWords) {
  const key = createHash('sha256').update(cliWords.filter((w) => !w.startsWith('-rpcwallet=')).join(' ')).digest('hex').slice(0, 16);
  return join(lockDir, `.arena-utxo-scan-${key}.lock`);
}
function takeLock(path) {
  const make = () => { try { writeFileSync(path, JSON.stringify({ pid: process.pid, atMs: Date.now() }), { flag: 'wx' }); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } };
  const release = () => { try { unlinkSync(path); } catch { /* gone */ } };
  if (make()) return release;
  // a lock left by a seat that died: its process gone, or older than any scan runs
  let held = null; try { held = JSON.parse(readFileSync(path, 'utf8')); } catch { held = null; }
  let age = 0; try { age = Date.now() - statSync(path).mtimeMs; } catch { return make() ? release : null; }
  let alive = true;
  if (held && Number.isInteger(held.pid)) { try { process.kill(held.pid, 0); } catch (e) { alive = e.code === 'EPERM'; } }
  if (alive && age < LOCK_STALE_MS) return null;
  release();
  return make() ? release : null;
}
class ScanBusy extends Error {}

/**
 * One check: `mine` = [{ federationId, guardianKey }] (bytes) of the guardians this seat runs. Answers null when there is nothing
 * to do (no wallet, an update still in the mempool), { busy } when a UTXO scan runs already, else guardianOfFromWallet's answer.
 * `lockDir`: where the one-scan-per-bitcoind lock lives (none named: no lock, bitcoind's own refusal still answered as busy).
 */
export async function advertSelfOnce({ mine, secret, last, hostedGames = [], network = 'testnet4', dry = false, lockDir = null, ownerRoles = null }) {
  const { bondCliFrom, guardianOfFromWallet } = await import('./add-bond-wallet.js');
  const b = bondCliFrom(); if (!b) return null;
  if (last && last.txid) { try { b.cli('getmempoolentry', last.txid); return null; } catch { /* confirmed or gone: look again */ } }
  const { bondMarker } = await import('../../arena-protocol/src/constants.js');
  const marker = `raw(5120${toHex(bondMarker(network))})`;
  const words = String(process.env.ARENA_BOND_CLI || '').trim().split(/[\s,]+/).filter(Boolean);
  // ONE scantxoutset FOR THE CHECK: the first descriptor asked is scanned with the marker's, each later ask answered from it
  const got = new Map();
  const spkOf = (d) => { const m = /^raw\(([0-9a-f]+)\)/.exec(d); return m ? m[1] : null; };
  const scan = (descriptors) => {
    if (descriptors.every((d) => got.has(d))) return { success: true, unspents: descriptors.flatMap((d) => got.get(d)) };
    const ask = [...new Set([...descriptors, marker])];
    let release = null;
    if (lockDir) {
      try { mkdirSync(lockDir, { recursive: true }); } catch { /* the lock write says */ }
      release = takeLock(scanLockPath(lockDir, words));
      if (!release) throw new ScanBusy('another seat on this machine is scanning the UTXO set');
    }
    let r;
    try { r = JSON.parse(b.cli('scantxoutset', 'start', JSON.stringify(ask))); }
    catch (e) {
      const said = String((e && (e.stderr || e.message)) || e);
      if (/Scan already in progress/.test(said)) throw new ScanBusy('bitcoind is running another UTXO scan');
      throw e;
    } finally { if (release) release(); }
    for (const d of ask) {
      const spk = spkOf(d);
      got.set(d, (r.unspents || []).filter((u) => (u.scriptPubKey && spk ? u.scriptPubKey === spk : String(u.desc || '').split('#')[0] === d)));
    }
    return { success: true, unspents: descriptors.flatMap((d) => got.get(d)) };
  };
  try {
    const r = await guardianOfFromWallet({ cli: b.cli, wallet: b.wallet, network, secret, guardianOf: mine, keep: true, scan, ownerRoles,
      hostedGames: hostedGames.map((h) => (typeof h === 'string' ? fromHex(h) : h)), post: !dry });
    return r && r.noBond ? null : r;     // no bond yet: nothing to do
  } catch (e) {
    if (e instanceof ScanBusy) return { busy: true, why: e.message };
    throw e;
  }
}

/** advertSelfOnce in a worker thread: the seat's loop stays free while bitcoin-cli runs. */
export function advertSelfInWorker(ask) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { blwpAdvertSelf: true, ask } });
    w.unref();
    let done = false;
    w.once('message', (m) => { done = true; if (m.ok) resolve(m.r); else reject(new Error(m.why)); });
    w.once('error', (e) => { if (!done) { done = true; reject(e); } });
    w.once('exit', (code) => { if (!done) { done = true; reject(new Error(`the advert worker stopped (${code})`)); } });
  });
}

/**
 * THE SEAT'S CHECK: decides off its census whether a wallet read is due, reads in a worker when it is, and logs one line per decision.
 * `census()` the census entries (null: this seat reads none), `mine()` / `hostedGames()` what the advertisement should name, `selfFile`
 * where a posted update is remembered. `check()` answers what it did: 'none' | 'current' | 'busy' | 'read'.
 */
export function createAdvertSelf({ census, pubkey, secret, mine, hostedGames, selfFile = null, lockDir = null, network = 'testnet4', dry = false, log = console.log, ownerRoles = () => null }) {
  let lastRead = null, said = null;
  const check = async (nowMs = Date.now()) => {
    const m = mine(), h = hostedGames();
    if (!m.length && !h.length) return 'none';
    let last = null; try { last = selfFile ? JSON.parse(readFileSync(selfFile, 'utf8')) : null; } catch { last = null; }
    let entries; try { entries = census(); } catch { entries = []; }
    const d = ownAdvertDue({ entries, pubkey, mine: m, hostedGames: h, last, lastRead, nowMs });
    if (!d.due) {
      // once per decision: the same answer every 10 min is said once
      if (said !== d.why) log(`[advert] own advertisement current: no wallet read (${d.why})`);
      said = d.why;
      return 'current';
    }
    said = null;
    log(`[advert] own advertisement due (${d.why}): reading the bond wallet`);
    // the owner's roles change kept in owner_actions (kanban #2182): built on while it is unconfirmed, never undone
    let roles = null; try { roles = ownerRoles(); } catch { roles = null; }
    const r = await advertSelfInWorker({ mine: m, hostedGames: h, secret, last, network, dry, lockDir, ownerRoles: roles });
    if (r && r.busy) { log(`[advert] own advertisement not read: ${r.why}; next check in 10 min`); return 'busy'; }
    lastRead = { want: d.want, atMs: nowMs };
    if (r && r.same) { log('[advert] own advertisement names them on chain already: the census takes the update once 6 deep'); return 'read'; }
    if (!r) return 'read';
    if (!r.ok) { log(`[advert] own advertisement not posted: ${r.why}`); return 'read'; }
    log(`[advert] own advertisement ${dry ? 'would be' : 'posted'}: guardian_of ${r.plan.after.split(',').map((x) => x.slice(0, 8)).join(' ') || 'none'} (was ${r.plan.before.split(',').map((x) => x.slice(0, 8)).join(' ') || 'none'})${(r.plan.addedGames || []).length ? `, ${r.plan.addedGames.length} game(s) added: ${r.plan.addedGames.map((g) => g.slice(0, 8)).join(' ')}` : ''}${r.update ? `, ${r.update.txid}` : ''}`);
    if (r.update && selfFile) { try { writeFileSync(selfFile, JSON.stringify({ txid: r.update.txid, after: r.plan.after, want: d.want, atMs: nowMs })); } catch { /* checked on chain next time */ } }
    return 'read';
  };
  return { check };
}

if (!isMainThread && workerData && workerData.blwpAdvertSelf) {
  advertSelfOnce(workerData.ask).then(
    (r) => parentPort.postMessage({ ok: true, r }),
    (e) => parentPort.postMessage({ ok: false, why: e.message }));
}
