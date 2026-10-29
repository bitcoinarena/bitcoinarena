// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LND SET UP ON THIS MACHINE, from the wizard's Lightning step and from the owner page (kanban #567: a node that becomes a liquidity
// provider there and has no LND yet): the checked download, whether others reach its peer port (else Tor and an onion address), lnd.conf
// on the node's own Bitcoin Core, a service; then - LND takes some seconds to start - its wallet from the node's seed and the first
// getinfo, after which the node's state names its Lightning pubkey.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installLnd, configureLnd, lndArgs, createLndWallet, testLnd, LND_PORTS } from './lnd.js';
import { installProgram } from './service.js';
import { torBin, writeTorrc, torCommand, freeTorPorts, torControlInfo, torComplaint, ownTorCookie, TOR_PORTS } from './tor.js';

/**
 * Is THIS NODE'S Tor up? Its control port asked every second for up to `waitMs`: up once it answers with this node's cookie file
 * (torControlInfo) - another program on the port is not this Tor (kanban #670); a Tor that stopped says so in its log ([err]) and is
 * not waited for. Answers { ok } or { ok: false, why } with Tor's own line.
 */
export async function torUp({ port = TOR_PORTS.control, home = null, waitMs = 30000, everyMs = 1000, info = torControlInfo, complaint = torComplaint } = {}) {
  const until = Date.now() + waitMs;
  let foreign = null;   // a program that answers on the port, not this Tor: { cookieFile } (null for a program that is no Tor)
  for (;;) {
    const r = await info(port);
    if (r.answers && (!home || ownTorCookie(home, r.cookieFile))) return { ok: true };
    if (r.answers) foreign = { cookieFile: r.cookieFile };
    const said = home ? complaint(home) : null;
    if (said && said.stopped) return { ok: false, why: `Tor stopped: ${said.line}` };
    if (Date.now() >= until) break;
    await new Promise((ok) => setTimeout(ok, everyMs));
  }
  const said = home ? complaint(home) : null;
  return { ok: false, why: [foreign ? `another program answers on its control port ${port}${foreign.cookieFile ? ` (a Tor with ${foreign.cookieFile})` : ''}`
    : `its control port ${port} did not answer within ${Math.round(waitMs / 1000)} s`, said ? `Tor says: ${said.line}` : null].filter(Boolean).join('; ') };
}
import * as reachKit from './reach.js';
import { routerForwards } from './router-probe.js';
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
export async function setUpOwnLnd({ state, release, fetcher = fetch, reach = reachKit, lndKit = { installLnd, configureLnd, lndArgs, installProgram }, tor: torKit = { torBin, writeTorrc, torCommand, freeTorPorts, torUp }, router = routerForwards, boot = true, onStage = () => {} }) {
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
  let torOn = false, torWhy = null, torPorts = TOR_PORTS;
  if (tor) {
    // FREE PORTS, AND THIS NODE'S OWN TOR ANSWERING (kanban #670, 2026-10-26: "tor is not starting and could be the reason lnd also doesnt
    // start"): a port another program holds stops Tor at once ("Could not bind ... Is Tor already running?"), and a control port that
    // answers may be another Tor's - LND told to use it does not start. So the pair is chosen free, Tor's answer is checked to be its own
    // (its cookie file), and when it does not come Tor's own line says why on the Lightning step
    if (torKit.freeTorPorts) torPorts = await torKit.freeTorPorts({ home: state.home }).catch(() => TOR_PORTS);
    const cmd = torKit.torCommand ? torKit.torCommand({ home: state.home, tor }) : [tor];
    const t = await lndKit.installProgram({ id: 'tor', description: 'Bitcoin Arena: Tor for Lightning', args: [...cmd, '-f', torKit.writeTorrc({ home: state.home, ports: torPorts })], home: state.home, boot,
      // A TOR THAT ENDS IS STARTED AGAIN, however it ended (kanban #720): LND dials every peer through it
      restart: 'always' });
    // TOR ANSWERING, NOT ONLY STARTED (2026-10-25): LND told to use a Tor that is not there shuts down - so LND gets Tor only once its
    // control port answers; else LND runs without it (clearnet only) and the node's state says why
    const up = !t.ok ? false : torKit.torUp ? await torKit.torUp({ port: torPorts.control, home: state.home }) : true;
    torOn = up === true || Boolean(up && up.ok);
    if (!t.ok) torWhy = `Tor could not be set up as a service: ${t.why}: LND runs without it`;
    else if (!torOn) torWhy = `Tor did not start (${(up && up.why) || 'its control port did not answer within 30 s'}): LND runs without it`;
  }
  // NEITHER REACHED NOR TOR: A ROUTER THAT FORWARDS ON REQUEST, OR NOTHING (kanban #730, measured 2026-10-29 in the Linux VM: the
  // linux-arm64 release has no Tor and none was installed, the port was not reached, nat=true was written anyway, and LND quit at every
  // start because no router answered NAT-PMP) - asked as LND would ask it (router-probe.js); nat=true only when one answered. With none,
  // LND runs and dials out to its peers; the step says how peers can reach it (a port forward, or Tor)
  const fwd = !lnReach.reached && !torOn ? await router().catch((e) => ({ answered: false, by: null, why: e.message })) : null;
  if (fwd) state.save({ lnReach: { ...state.read().lnReach, router: { answered: fwd.answered, by: fwd.by, why: fwd.why } } });
  onStage('start');
  const cfg = lndKit.configureLnd({ home: state.home, chain, tor: torOn ? torPorts : null, externalIp: lnReach.reached ? lnReach.address : null, nat: Boolean(fwd && fwd.answered) });
  const r = await lndKit.installProgram({ id: 'lnd', description: 'LND for Bitcoin Arena (custody)', args: lndKit.lndArgs({ lnd: got.lnd, lnddir: cfg.lnddir }), home: state.home, boot, partOf: torOn ? 'tor' : null,
    // LND STARTS ONCE ITS TOR'S SOCKS PORT ANSWERS (kanban #720)
    waitPort: torOn ? torPorts.socks : null });
  if (!r.ok) return { ok: false, why: r.why };
  state.save({ tor: torOn ? { bin: tor, ports: torPorts } : { why: torWhy ? torWhy : lnReach.reached ? `not needed: others reach LND at ${lnReach.address}:${LND_PORTS.p2p}` : tor ? 'Tor did not start' : 'no Tor: neither this release nor this system has one (on Linux: sudo apt install tor, then run this step again)' },
    lightning: { mode: 'own', restUrl: cfg.restUrl, tlsCert: cfg.tlsCert, macaroon: cfg.macaroon, passwordFile: cfg.passwordFile, lnddir: cfg.lnddir, startedMs: Date.now() } });
  return { ok: true, lnd: got.lnd, sha256: got.sha256 || null, peers: lnReach.reached ? `reachable from outside at ${lnReach.address}:${LND_PORTS.p2p}` : torOn ? 'not reachable from outside: Tor gives LND an onion address'
    : fwd && fwd.answered ? `not reachable from outside and no Tor: LND asks your router (${fwd.by}) to forward its port ${LND_PORTS.p2p}`
    : `LND dials out to its peers only: nothing outside reaches this computer, it has no Tor${torWhy ? ` (${torWhy})` : ''} and ${fwd ? fwd.why : 'no router forwards ports'}. For peers to reach it, forward TCP ${LND_PORTS.p2p} on your router to this computer, or install Tor (on Linux: sudo apt install tor), then run this step again` };
}

/**
 * HAS LND STOPPED ITSELF SINCE IT WAS STARTED, AGAIN AND AGAIN? (kanban #730, measured 2026-10-29: LND quit 20 s after each start and its
 * service started it again, five times in three minutes, while step 10 said "Waiting for LND's first answer" for good). LND's own log
 * (logs/bitcoin/<network>/lnd.log, local time) is read for "Shutting down due to error in main method" after `sinceMs`: from the second
 * one the wait ends with LND's reason and what to do. Answers null, or { exits, err, why }.
 */
export function lndCrashes({ lnddir, sinceMs = 0, readLog = (f) => readFileSync(f, 'utf8'), min = 2 }) {
  let text = '';
  for (const net of ['testnet4', 'mainnet']) { try { text = readLog(join(lnddir, 'logs', 'bitcoin', net, 'lnd.log')); break; } catch { /* not this network */ } }
  const exits = [];
  for (const line of text.split('\n')) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) .*Shutting down due to error in main method.*?err="?([^"]*)"?\s*$/.exec(line);
    if (m && new Date(`${m[1]}T${m[2]}`).getTime() >= sinceMs - 1000) exits.push(m[3]);
  }
  if (exits.length < min) return null;
  const err = exits[exits.length - 1];
  const todo = /NAT-PMP|UPnP/i.test(err) ? 'Its settings ask your router to forward a port (nat) and no router here answers. Choose "Set up LND here" again: setup now writes that only when a router answers, and LND runs without it.'
    : /bitcoind|chain backend|connection refused/i.test(err) ? 'LND cannot use your Bitcoin Core: check that Bitcoin Core runs and answers, then choose "Set up LND here" again.'
    : /address already in use|bind/i.test(err) ? 'Another program holds one of LND\'s ports: stop it, then choose "Set up LND here" again.'
    : `LND's log says more: ${join(lnddir, 'logs', 'bitcoin', '<network>', 'lnd.log')}.`;
  return { exits: exits.length, err, why: `LND stops right after it starts (${exits.length} times since setup started it): ${err}. ${todo}` };
}

/**
 * Is the node's LND up? Its wallet made from the seed (an own LND, once), then getinfo; the pubkey kept in the state. Answers
 * { ok, created, pubkey, alias, uris, peers } or { ok: false, why, waiting } - waiting while an own LND is still starting.
 */
export async function lndReady({ state, lndKit = { createLndWallet, testLnd }, onStage = () => {}, crashes = lndCrashes }) {
  const s = state.read(); const l = s.lightning;
  if (!l) return { ok: false, why: 'no Lightning node set up yet' };
  let created = false;
  if (l.mode === 'own') {
    onStage('wallet');
    const w = await lndKit.createLndWallet({ cfg: l, seed: fromHex(state.readSecret('seed.hex')) });
    if (!w.ok) { const c = crashes({ lnddir: l.lnddir, sinceMs: l.startedMs }); return c ? { ok: false, why: c.why, waiting: false, crashed: c } : { ok: false, why: w.why, waiting: true }; }
    created = w.created;
  }
  onStage('answer');
  const t = await lndKit.testLnd(l);
  if (!t.ok) {
    const c = l.mode === 'own' && l.lnddir ? crashes({ lnddir: l.lnddir, sinceMs: l.startedMs }) : null;
    return c ? { ok: false, why: c.why, waiting: false, created, crashed: c } : { ok: false, why: t.why, waiting: l.mode === 'own', created };
  }
  state.save({ lightning: { ...l, pubkey: t.pubkey, alias: t.alias, testedMs: Date.now() } });
  // how other Lightning nodes reach this one: the measured address, or the onion LND announces (Tor), or not at all
  const r = s.lnReach || {}; const onion = (t.uris || []).find((u) => /\.onion:/.test(u));
  const peers = r.reached ? `others reach it at ${r.address}:${r.port} (measured from outside)` : onion ? `no open port (measured), so it is reached over Tor at ${onion.split('@')[1]}`
    : s.tor && s.tor.bin ? 'no open port (measured); Tor is making its onion address'
    // NO PORT, NO TOR (kanban #730): with a router that forwards on request LND asks it; with none it dials out only, and says how to change that
    : r.atMs && r.router && r.router.answered ? `no open port (measured) and no Tor: LND asks your router (${r.router.by}) to forward its port ${r.port}`
    : r.atMs ? `LND dials out to its peers only: no open port (measured), no Tor and no router that forwards ports. For peers to reach it, forward TCP ${r.port} on your router to this computer, or install Tor (on Linux: sudo apt install tor), then run this step again` : null;
  return { ok: true, created, ...t, peers };
}
