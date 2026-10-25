// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LND SET UP ON THIS MACHINE, from the wizard's Lightning step and from the owner page (kanban #567: a node that becomes a liquidity
// provider there and has no LND yet): the checked download, whether others reach its peer port (else Tor and an onion address), lnd.conf
// on the node's own Bitcoin Core, a service; then - LND takes some seconds to start - its wallet from the node's seed and the first
// getinfo, after which the node's state names its Lightning pubkey.
import { execFile } from 'node:child_process';
import { installLnd, configureLnd, lndArgs, createLndWallet, testLnd, LND_PORTS } from './lnd.js';
import { installProgram } from './service.js';
import { torBin, writeTorrc, TOR_PORTS } from './tor.js';
import * as reachKit from './reach.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { ownCoreOf } from './state.js';

const which = async (x) => {
  const r = await new Promise((ok) => execFile(process.platform === 'win32' ? 'where' : 'which', [x], (e, o) => ok(e ? '' : String(o).split(/\r?\n/)[0].trim())));
  return r || null;
};

/**
 * The Bitcoin Core LND reads: the node's chain when it is a Core; while the Core installed here still syncs behind the interim
 * Electrum chain, that Core - LND starts at once and waits for the sync by itself (kanban #635, 2026-10-25: "Du kannst ja
 * bitcoin core schon einrichten und dann direkt lnd danach, und einfach auf den Sync warten"). null when there is no Core.
 */
export const lndChainOf = (s) => ownCoreOf(s);

/** Install and start LND for the node at `state` (on its own Core, lndChainOf). Answers { ok, lnd, sha256, peers } or { ok: false, why }. */
export async function setUpOwnLnd({ state, release, fetcher = fetch, reach = reachKit, lndKit = { installLnd, configureLnd, lndArgs, installProgram }, tor: torKit = { torBin, writeTorrc }, boot = true, onStage = () => {} }) {
  const s = state.read();
  const chain = lndChainOf(s);
  if (!chain) return { ok: false, why: 'LND needs your own Bitcoin Core, not an Electrum server' };
  onStage('download');
  const got = await lndKit.installLnd({ home: state.home, fetcher });
  if (!got.ok) return { ok: false, why: got.why };
  // CAN OTHERS DIAL THIS LND? (2026-10-18: "Measure if lnd is accessible from the outside after installing if not install tor"):
  // two seats connect back to the peer port before LND takes it (reach.checkDirect). Reached: LND announces that address, no Tor.
  // Not reached - the usual case, no open port: Tor (tor.js), and LND gets a permanent onion address others dial instead.
  onStage('reach');
  const lnReach = await reach.checkDirect({ port: LND_PORTS.p2p, fetcher }).catch((e) => ({ ok: false, reached: false, why: e.message }));
  state.save({ lnReach: { reached: Boolean(lnReach.reached), address: lnReach.address || null, port: LND_PORTS.p2p, why: (lnReach.diagnosis && lnReach.diagnosis.advice) || lnReach.why || null, atMs: Date.now() } });
  const tor = lnReach.reached ? null : await torKit.torBin({ release, which });
  let torOn = false;
  if (tor) {
    const t = await lndKit.installProgram({ id: 'tor', description: 'Bitcoin Arena: Tor for Lightning', args: [tor, '-f', torKit.writeTorrc({ home: state.home })], home: state.home, boot });
    torOn = t.ok;
  }
  onStage('start');
  const cfg = lndKit.configureLnd({ home: state.home, chain, tor: torOn ? TOR_PORTS : null, externalIp: lnReach.reached ? lnReach.address : null });
  const r = await lndKit.installProgram({ id: 'lnd', description: 'LND for Bitcoin Arena (custody)', args: lndKit.lndArgs({ lnd: got.lnd, lnddir: cfg.lnddir }), home: state.home, boot, partOf: torOn ? 'tor' : null });
  if (!r.ok) return { ok: false, why: r.why };
  state.save({ tor: torOn ? { bin: tor, ports: TOR_PORTS } : { why: lnReach.reached ? `not needed: others reach LND at ${lnReach.address}:${LND_PORTS.p2p}` : tor ? 'Tor did not start' : 'no Tor: the release has none for this system (linux-arm64: apt install tor)' },
    lightning: { mode: 'own', restUrl: cfg.restUrl, tlsCert: cfg.tlsCert, macaroon: cfg.macaroon, passwordFile: cfg.passwordFile, lnddir: cfg.lnddir, startedMs: Date.now() } });
  return { ok: true, lnd: got.lnd, sha256: got.sha256 || null, peers: lnReach.reached ? `reachable from outside at ${lnReach.address}:${LND_PORTS.p2p}` : torOn ? 'not reachable from outside: Tor gives LND an onion address' : 'not reachable from outside and no Tor: only nodes it dials reach it' };
}

/**
 * Is the node's LND up? Its wallet made from the seed (an own LND, once), then getinfo; the pubkey kept in the state. Answers
 * { ok, created, pubkey, alias, uris, peers } or { ok: false, why, waiting } - waiting while an own LND is still starting.
 */
export async function lndReady({ state, lndKit = { createLndWallet, testLnd }, onStage = () => {} }) {
  const s = state.read(); const l = s.lightning;
  if (!l) return { ok: false, why: 'no Lightning node set up yet' };
  let created = false;
  if (l.mode === 'own') {
    onStage('wallet');
    const w = await lndKit.createLndWallet({ cfg: l, seed: fromHex(state.readSecret('seed.hex')) });
    if (!w.ok) return { ok: false, why: w.why, waiting: true };
    created = w.created;
  }
  onStage('answer');
  const t = await lndKit.testLnd(l);
  if (!t.ok) return { ok: false, why: t.why, waiting: l.mode === 'own', created };
  state.save({ lightning: { ...l, pubkey: t.pubkey, alias: t.alias, testedMs: Date.now() } });
  // how other Lightning nodes reach this one: the measured address, or the onion LND announces (Tor), or not at all
  const r = s.lnReach || {}; const onion = (t.uris || []).find((u) => /\.onion:/.test(u));
  const peers = r.reached ? `others reach it at ${r.address}:${r.port} (measured from outside)` : onion ? `no open port (measured), so it is reached over Tor at ${onion.split('@')[1]}`
    : s.tor && s.tor.bin ? 'no open port (measured); Tor is making its onion address' : r.atMs ? `no open port (measured) and no Tor: ${(s.tor || {}).why || ''}` : null;
  return { ok: true, created, ...t, peers };
}
