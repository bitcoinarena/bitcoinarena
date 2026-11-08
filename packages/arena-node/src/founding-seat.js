// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT'S PART IN A FOUNDING (spec §23A.2): when to start one and how its own guardian takes part. founding.js runs
// the ceremony; this reads its inputs off what the seat holds and drives the node's own guardian.
//
//   TRIGGER   foundingTrigger over what this seat holds: a record that entered DRAINING (succession) at its height; the first height
//             with federation_nominal guardian-capable operators while no federation exists (genesis); every OPEN federation at 80 %
//             of its cap for abandon_blocks (load). The seat keeps the census and load history it saw at each tick.
//   SEED      the beacon: the hash of the block after trigger_height, once it is in the seat's chain.
//   CENSUS    the bonded census at trigger_height, its entries with their adverts (guardian_capable, guardian_endpoint).
//   GUARDIAN  a node takes part only while one of its guardians waits in Fedimint's setup (its setup status is not
//             ConsensusIsRunning): its own guardian (a node with no ceremony files starts it in setup mode with
//             ARENA_FOUNDING=1, node-start.js), else its second one, the guardian-next (a guardian in consensus
//             seated first in its federation's successor takes part through a second fedimintd in setup mode beside it).
//             Its setup calls go through fedimint-cli's `admin setup` against that guardian's own API socket, with its admin
//             password.
//   NOTICE    a succession is also triggered by a standing departure notice (§23A.6 "or a departure notice that would make it
//             DRAINING"): the seat's held notices (absences.js, POST /departure) against the held record of an OPEN
//             federation - or one already DRAINING or CRITICAL - whose seated guardians without the leaving one fall to DRAINING
//             (CRITICAL at four, §23A.1); trigger_height is the height the notice was posted at.
//   SEATED    a succession seats the record's seated, non-departing guardians first, in the record's order (node key
//   FIRST     ascending), and draws the missing seats (drawGuardians). The draw's pool leaves out the operators guarding an OPEN
//             federation other than the one succeeded (their census adverts' guardian_of[] naming a federation whose held record is
//             OPEN), and the leaving guardians' operators (the succeeded federation's departing / gone guardians).
//   PRESSURE  `pressureBondAt` answers B*_net for a draw while the network is under pressure, null otherwise (drawGuardians, §23A.3a;
//             founding-pressure.js reads it). Not given, the draw is the plain one. A reader that fails starts no founding: a guess would
//             draw another set than the others. `candidateVersionAt(height)`: the version a candidate advertises from the network's point,
//             null before it - the count of capable and free operators holds to it too, or a cohort would trigger on nodes it cannot draw.
//   VOID      from `redrawFrom`, a draw with no founding started by its height + founding_window is void and holds nothing back, and a founding
//             whose federation runs is kept through its trigger's redraws: it is not drawn over while its record names no successor yet.
import { triggerKey, foundingTrigger, COHORT_NOMINAL } from '../../arena-protocol/src/guardian-founding.js';
import { departureStands } from '../../arena-protocol/src/absence.js';
import { statusFor } from '../../arena-protocol/src/federation-record.js';
import { createFounding } from './founding.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const opOf = (e) => String((e && e.advert && e.advert.operatorId) || toHex(e.pubkey));
const lower = (x) => String(x || '').toLowerCase();
/** A held record's seated guardians - not in its gone[] - in the record's order. */
export function seatedOf(record) {
  const gone = new Set((record.gone || []).map((g) => toHex(g.peerKey)));
  return (record.guardians || []).filter((g) => !gone.has(toHex(g.peerKey)));
}
const goneNodes = (record) => { const s = new Set(seatedOf(record).map((g) => toHex(g.nodePubkey))); return (record.guardians || []).map((g) => toHex(g.nodePubkey)).filter((k) => !s.has(k)); };

/**
 * THE NOTICE TRIGGERS (§23A.6): of `notices` (decoded departure notices), each one that stands against the held record
 * of its federation (`held`: [{ federation, status, record }], status OPEN, DRAINING or CRITICAL) and leaves that federation's seated
 * guardians DRAINING or CRITICAL. Answers [{ federation, height: posted_at, wouldBe, nominal, seatedFirst, departing }] (node keys hex).
 */
export function noticeTriggers({ held = [], notices = [], departureNotice, verify }) {
  const rows = [];
  if (!Number.isInteger(departureNotice)) return rows;
  for (const d of notices || []) {
    const fid = toHex(d.federationId);
    const h = (held || []).find((r) => r && r.record && lower(r.federation) === fid);
    if (!h || !['OPEN', 'DRAINING', 'CRITICAL'].includes(h.status)) continue;
    if (!departureStands(d, { record: h.record, departureNotice, verify }).ok) continue;
    const seated = seatedOf(h.record).filter((g) => toHex(g.peerKey) !== toHex(d.peerKey));
    let wouldBe; try { wouldBe = statusFor({ nominal: h.record.nominal, seated: Math.min(h.record.nominal, seated.length) }).status; } catch { continue; }
    if (wouldBe !== 'DRAINING' && wouldBe !== 'CRITICAL') continue;
    rows.push({ federation: fid, height: d.postedAt, wouldBe, nominal: h.record.nominal, seatedFirst: seated.map((g) => toHex(g.nodePubkey)),
      departing: [...new Set([toHex(d.nodePubkey), ...goneNodes(h.record)])] });
  }
  return rows;
}

/**
 * THE OWNER'S EMERGENCY DEPARTURE TRIGGERS TOO (§23A.5a, protocol 17: "the succession starts at once, as for a notice that would make
 * it DRAINING"): `requests` [{ nodePubkey, postedAt }] - leave requests this seat holds that stand against the census (the server checks
 * them, POST /emergency-departure) - each one whose node is a seated guardian of a held OPEN, DRAINING or CRITICAL federation and whose
 * leaving makes it DRAINING or CRITICAL. The same rows as noticeTriggers, at the request's posted_at.
 */
export function emergencyTriggers({ held = [], requests = [] }) {
  const rows = [];
  for (const d of requests || []) {
    const node = toHex(d.nodePubkey);
    for (const h of held || []) {
      if (!h || !h.record || !['OPEN', 'DRAINING', 'CRITICAL'].includes(h.status)) continue;
      const all = seatedOf(h.record);
      if (!all.some((g) => toHex(g.nodePubkey) === node)) continue;
      const seated = all.filter((g) => toHex(g.nodePubkey) !== node);
      let wouldBe; try { wouldBe = statusFor({ nominal: h.record.nominal, seated: Math.min(h.record.nominal, seated.length) }).status; } catch { continue; }
      if (wouldBe !== 'DRAINING' && wouldBe !== 'CRITICAL') continue;
      rows.push({ federation: lower(h.federation), height: d.postedAt, wouldBe, nominal: h.record.nominal, seatedFirst: seated.map((g) => toHex(g.nodePubkey)),
        departing: [...new Set([node, ...goneNodes(h.record)])] });
    }
  }
  return rows;
}

/**
 * The operators guarding a federation other than `except`: census adverts whose guardian_of[] names a federation held OPEN - or one
 * this seat holds no record of at all, which counts as guarded (2026-10-18"A": measured, T3's
 * seven guardians and B's successor's one advertised federations no seat held a record of, so they counted as free and would have
 * been drawn into a cohort - as no-shows, since each runs its own federation's guardian).
 */
/** A federation at or above this load (its exposure cap) is overloaded: its guardians may found another. */
export const OVERLOADED = 1;

/**
 * WHY AN OPERATOR IS NOT FREE (kanban #585): its nodes' adverts that name a federation guardingOpenOf counts as OPEN - one held OPEN
 * (and not overloaded), or one this seat holds no record of. [{ node, federation, status }], status 'OPEN' or 'not held'.
 */
// HELD BACK BY A FEDERATION (kanban #599, 2026-10-23 "Nur mit freiem Slot"): an OPEN one, one not held, or an overloaded one when
// the node advertises no free founding slot (guardian_capable 2) - drawn without one, it can never take part (founding 4d4c9cac: test host
// seats of A at load 4.33 drawn #1 and #10, founding off, every draw void)
const holdsBack = (e, st) => st === undefined || st === 'OPEN' || (st === 'OVERLOADED' && !(e && e.advert && e.advert.foundingSlot === true));
export function guardingWhy({ entries = [], held = [], op, except = null }) {
  const full = new Set((held || []).filter((r) => r && typeof r.load === 'number' && r.load >= OVERLOADED).map((r) => lower(r.federation)));
  const status = new Map((held || []).filter(Boolean).map((r) => [lower(r.federation), full.has(lower(r.federation)) ? 'OVERLOADED' : r.status]));
  const out = [];
  for (const e of entries || []) {
    if (!e || opOf(e) !== op) continue;
    for (const g of (e.advert && e.advert.guardianOf) || []) {
      const f = toHex(g.federationId);
      if (f !== lower(except) && holdsBack(e, status.get(f))) out.push({ node: toHex(e.pubkey), federation: f, status: !status.has(f) ? 'not held' : status.get(f) === 'OVERLOADED' ? 'overloaded, no free slot' : 'OPEN' });
    }
  }
  return out;
}

export function guardingOpenOf({ entries = [], held = [], except = null }) {
  // AN OVERLOADED FEDERATION HOLDS NOBODY BACK (2026-10-22: "Also when federation is over loaded? That is causing the current
  // conflict"): an OPEN federation at load >= 1 - deposits refused (load ruling A) - frees its guardians for a founding, which they
  // serve through their guardian-next; measured 3d30afd4: A at load 4.33 kept 4 of the 14 test nodes out, 10 eligible, no alternates.
  // ONLY A NODE WITH A FREE SLOT (kanban #599): one that advertises its guardian-next (holdsBack)
  const full = new Set((held || []).filter((r) => r && typeof r.load === 'number' && r.load >= OVERLOADED).map((r) => lower(r.federation)));
  const status = new Map((held || []).filter(Boolean).map((r) => [lower(r.federation), full.has(lower(r.federation)) ? 'OVERLOADED' : r.status]));
  const ops = new Set();
  for (const e of entries || []) for (const g of (e && e.advert && e.advert.guardianOf) || []) {
    const f = toHex(g.federationId);
    if (f !== lower(except) && holdsBack(e, status.get(f))) ops.add(opOf(e));   // a draining one frees its guardians
  }
  return ops;
}

/**
 * HOW MANY OPEN FEDERATIONS EACH OPERATOR GUARDS (§23A.2 RULED 2026-11-07, kanban #1297/#1323): by its nodes' adverts (guardianOf), a federation
 * counted when this seat holds it OPEN or OVERLOADED (an overloaded federation is OPEN with deposits refused). The draw seats f + 1 of a founding
 * from operators guarding one, never one guarding two; an empty map - no OPEN federation yet - keeps the draw as it was.
 */
export function openGuardingOf({ entries = [], held = [], except = null }) {
  const open = new Set((held || []).filter((r) => r && (r.status === 'OPEN' || r.status === 'OVERLOADED')).map((r) => lower(r.federation)));
  const byOp = new Map();
  for (const e of entries || []) for (const g of (e && e.advert && e.advert.guardianOf) || []) {
    const f = toHex(g.federationId);
    if (f === lower(except) || !open.has(f)) continue;
    const op = opOf(e);
    if (!byOp.has(op)) byOp.set(op, new Set());
    byOp.get(op).add(f);
  }
  return new Map([...byOp].map(([op, fs]) => [op, fs.size]));
}

/**
 * fedimint-cli RUN, ITS OWN WORDS IN A REFUSAL (kanban #495, founding 53be35a3: the CLI prints a refusal such as "Local parameters have
 * already been set" as JSON on stdout, so an exec error held only "Command failed: ..." and the founding's fresh setup, which reads that
 * refusal, never started - two seated nodes posted no code): resolves the output; rejects with stdout and stderr appended to the message.
 */
export function execCli(execFileCb, bin, args, { timeout = 120000 } = {}) {
  return new Promise((res, rej) => execFileCb(bin, args, { timeout }, (e, out, err) => {
    if (!e) return res(String(out));
    // THE PASSWORD NEVER IN A LOG LINE (measured 2026-10-26 on n495-1: "Command failed: fedimint-cli --password <the guardian's> ..." in
    // every refused tick, 1,034 times): the command line in the error says only that a password was given
    const hide = (s) => String(s).replace(/(--password[ =])\S+/g, '$1<hidden>');
    e.message = [hide(e.message), hide(String(out || '').trim()), hide(String(err || '').trim())].filter(Boolean).join('\n');
    if (Array.isArray(e.cmd)) e.cmd = e.cmd.map(hide); else if (typeof e.cmd === 'string') e.cmd = hide(e.cmd);
    rej(e);
  }));
}

/**
 * WHAT THIS NODE'S GUARDIAN IS, AS READ (kanban #1177): three answers from its setup API, and a fourth only the node itself can verify.
 *   RUNNING  its federation runs (the setup API says ConsensusIsRunning) - or its directory holds a federation's key files, whatever the API says
 *   SETUP    the setup API answers a setup state (AwaitingLocalParams, SharingConnectionCodes, ...)
 *   DOWN     no federation key in its directory and its process verified gone (the node's own word, node-start.js guardianControl.local)
 *   UNKNOWN  anything else: no answer, an error, a timeout. Nothing is set aside on an unknown reading.
 */
export const GUARDIAN = Object.freeze({ RUNNING: 'running', SETUP: 'setup', DOWN: 'down', UNKNOWN: 'unknown' });

/**
 * THE ONE STEP OF A FRESH SETUP (kanban #1177): whether this node's guardian is set aside and started again in a fresh setup for a founding
 * that names it. `named` the draw seats it or names it an alternate; `reading` GUARDIAN; `tried` a fresh setup was already asked for this
 * founding (kept on disk). Answers { act: 'fresh' | 'wait' | 'leave', why }. Only a verified DOWN starts one; UNKNOWN waits and asks again.
 */
export function freshSetupStep({ named, reading, tried }) {
  if (!named) return { act: 'leave', why: 'not named in this draw' };
  if (tried) return { act: 'leave', why: 'its guardian was already started again in a fresh setup for this founding' };
  if (reading === GUARDIAN.RUNNING) return { act: 'leave', why: 'its guardian runs a federation (or holds its key): never set aside' };
  if (reading === GUARDIAN.SETUP) return { act: 'leave', why: 'its guardian waits in setup: it takes part as it is' };
  if (reading === GUARDIAN.DOWN) return { act: 'fresh', why: 'its guardian holds no federation key and is not running: started again in a fresh setup' };
  return { act: 'wait', why: 'its guardian\'s state is not known (no answer from its setup API): nothing is set aside on an unknown reading; asked again on the next tick' };
}

/** THE FOUNDINGS A FRESH SETUP WAS ASKED FOR, KEPT IN A FILE (kanban #1177): `add` writes it before the guardian is touched, and throws if it cannot. */
export function fileKeySet(file) {
  let keys = null;
  const load = () => { if (keys) return keys; try { const j = JSON.parse(readFileSync(file, 'utf8')); keys = new Set(Array.isArray(j) ? j.map(String) : []); } catch { keys = new Set(); } return keys; };
  return {
    has: (k) => load().has(String(k)),
    add: (k) => {
      const next = new Set(load()); next.add(String(k));
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify([...next].slice(-256)), { mode: 0o600 }); renameSync(tmp, file);
      keys = next;
    },
  };
}

/**
 * The guardian's setup, through the stock CLI: `run(args)` runs fedimint-cli and answers its stdout. The code is the
 * set-local-params output without its JSON quotes. `codeFile` (beside the guardian's data) keeps the code this node posted and its
 * founding id, so a node started again posts that same code (founding.js postOwn).
 */
export function cliSetup({ run, apiPort, password, guardianName, freshSetup = null, codeFile = null, local = null }) {
  const setup = (...a) => run(['--password', password, 'admin', 'setup', `ws://127.0.0.1:${apiPort}`, ...a]);
  const unq = (s) => String(s).trim().replace(/^"|"$/g, '');
  return {
    localParams: async ({ leader, name, size }) => unq(await setup('set-local-params', guardianName, ...(leader ? ['--federation-name', name, '--federation-size', String(size)] : []))),
    savedCode: () => {
      if (!codeFile) return null;
      try { const s = JSON.parse(readFileSync(codeFile, 'utf8')); return s && typeof s.id === 'string' && typeof s.code === 'string' ? s : null; } catch { return null; }
    },
    saveCode: (id, code) => { if (codeFile) writeFileSync(codeFile, JSON.stringify({ id, code }), { mode: 0o600 }); },
    addPeer: async (code) => { await setup('add-peer', code); },
    startDkg: async () => { await setup('start-dkg'); },
    invite: async () => null,
    // the guardian started again in a fresh setup (node-start.js guardianControl.freshSetup), where the node runs it
    ...(freshSetup ? { freshSetup } : {}),
    // WHETHER THE GUARDIAN WAITS IN SETUP (rehearsal 20b 2026-10-14): asked of the SETUP API itself. A guardian in setup mode
    // does not serve the admin `status` ("Method not found"), so a seat asking that never took part; `admin setup status` answers
    // "ConsensusIsRunning" once its federation runs, and a setup state (AwaitingLocalParams, SharingConnectionCodes, ...) before
    inSetup: async () => { try { const st = unq(await setup('status')); return !!st && st !== 'ConsensusIsRunning'; } catch { return false; } },
    // THE FEDERATION RUNS (§23A.2: the founding is void only "if the window passes without a federation"): its DKG done, consensus running
    done: async () => { try { return unq(await setup('status')) === 'ConsensusIsRunning'; } catch { return false; } },
    // ITS STATE AS ONE OF GUARDIAN (kanban #1177): `local()` the node's own word { keyed, alive } - a held federation key is RUNNING whatever
    // the API says; an API that does not answer is DOWN only when the node verified the process gone, else UNKNOWN
    status: async () => {
      let l = null; try { l = local ? await local() : null; } catch { l = null; }
      if (l && l.keyed === true) return GUARDIAN.RUNNING;
      let st; try { st = unq(await setup('status')); } catch { return l && l.alive === false ? GUARDIAN.DOWN : GUARDIAN.UNKNOWN; }
      return st === 'ConsensusIsRunning' ? GUARDIAN.RUNNING : st ? GUARDIAN.SETUP : GUARDIAN.UNKNOWN;
    },
  };
}

/**
 * The seat's foundings: `tick()` once in a while. `records()` the held records [{ federation, status, height }]; `entriesAt(h)`
 * the census entries at h (or null while the chain is not read that far); `beaconAt(h)` the block hash at h (32 bytes, or null);
 * `tip()`; `guardianInSetup()` true while the node's guardian waits in setup; `setup` its setup calls; `peers()` the seats' roots,
 * whose GET /founding is read for codes this seat missed.: `records()` rows may carry `record` (the held record,
 * decoded) - a DRAINING one then seats its seated guardians first, and the notice trigger reads it; `notices()` the departure
 * notices this seat holds (decoded); `next` { inSetup(), setup } the node's guardian-next, if it runs one; `guardingOpen({ entries,
 * records, except })` the operators guarding an OPEN federation (by default guardingOpenOf over the census and the held records);
 * `pressureBondAt({ height, entries })` B*_net for the draw at that trigger height under capacity pressure, else null (none given: null);
 * `candidateVersionAt(height)` the version a candidate at that height has to advertise, else null; `redrawFrom` the height every kind of
 * trigger redraws from (foundingTrigger), null for none.
 */
// `pegInMinSats` the network's gateway peg-in minimum: a drawn set whose cap is under 8 x it founds nothing (§23A.3a, kanban #1322); null: not checked
export function createFoundingSeat({ records, entriesAt, beaconAt, tip, guardianInSetup, setup, guardingOpen = null, pegInMinSats = null, pressureBondAt = null, candidateVersionAt = () => null, redrawFrom = null, notices = () => [], emergencies = () => [], next = null, nominal,
  bondMinGuardian, clocks, ownKey, sign, verify, post = async () => {}, postTo = null, peers = () => [], fetchJson = null, endpointOf = (e) => e.advert.endpoint, say = () => {}, keep = 4096,
  freshTried = null, firstSeason = null }) {
  let current = null;                        // { key, founding }
  // HOW FAR BACK A SEAT'S FIRST TICK READS THE RUN OF FREE OPERATORS: a cohort draws at the newest multiple of founding_window + 1 below
  // the tip once its run began at or before it, so two steps and one block decide the same height on every seat (kanban #577, measured
  // 2026-10-22 21:30Z: reading back 288 heights - each a census from the chain - held a restarted installer out of the draw for 15 min+)
  const LOOKBACK = clocks && Number.isInteger(clocks.foundingWindow) && clocks.foundingWindow > 0 ? 2 * (clocks.foundingWindow + 1) + 1 : 288;
  const voided = new Set();                  // keys of foundings whose window passed without a federation: the next trigger draws again
  // keys of foundings for which this node's guardian was started again in a fresh setup: kept on disk when the seat hands a store (kanban #1177,
  // server.js fileKeySet beside the guardian's directory), so a restarted seat never sets the same guardian aside twice for one founding
  const tried = freshTried && typeof freshTried.has === 'function' && typeof freshTried.add === 'function' ? freshTried : new Set();
  // THE HISTORY THE GENESIS AND LOAD TRIGGERS READ (§23A.2), one row per chain height this seat ticked at:
  //   capable  { height, operators }: the distinct operators of guardian-capable census nodes with an endpoint (the draw's own rule)
  //   loads    { height, federations: [{ federation, status, load }] }: every held record's status and load (reserve over exposure cap)
  const capable = [], loads = [];
  // (only the newest row keeps the free nodes' keys - the readiness answers them; thousands of rows each holding forty keys would not)
  // a row of the same height read again replaces it (kanban #585: a record that arrives within a block counts at once, not a block later)
  const remember = (rows, row) => {
    const last = rows.length ? rows[rows.length - 1] : null;
    if (last && last.height === row.height) rows[rows.length - 1] = row;
    else if (!last || last.height < row.height) { if (last) { delete last.freeNodes; delete last.self; } rows.push(row); }
    if (rows.length > keep) rows.shift();
  };
  async function history(h) {
    const held = records() || [];
    remember(loads, { height: h, federations: held.map((r) => ({ federation: r.federation, status: r.status, load: typeof r.load === 'number' ? r.load : null })) });
    // EVERY HEIGHT, FROM THE CHAIN: a gap since the last tick is read in, and the first tick reads back to where the run of
    // free operators began (kanban #495, 2026-10-21: a restarted seat's run began at its restart, so seats disagreed on the draw)
    const last = capable.length ? capable[capable.length - 1].height : null;
    if (last === null) {
      const back = [];
      for (let x = h - 1; x >= Math.max(0, h - LOOKBACK); x--) {
        const row = await capableAt(x, held); if (!row) break;
        back.unshift(row); if (row.free < COHORT_NOMINAL && (held.length > 0 || row.federations > 0 || row.operators < nominal)) break;
      }
      for (const row of back) remember(capable, row);
    } else for (let x = Math.max(last + 1, h - LOOKBACK); x < h; x++) { const row = await capableAt(x, held); if (row) remember(capable, row); }
    const row = await capableAt(h, held); if (row) remember(capable, row);
    return held;
  }
  let lastEntries = null;                    // the census of the newest row read (its members are asked, members())
  async function capableAt(h, held) {
    let entries = null; try { entries = await entriesAt(h); } catch { entries = null; }
    if (entries) {
      lastEntries = entries;
      const ops = new Set(), bonds = new Map(), named = new Set();
      const version = candidateVersionAt(h);
      const speaks = (e) => version === null || ((e.advert && e.advert.protocolVersions) || []).includes(version);
      for (const e of entries) {
        for (const g of (e && e.advert && e.advert.guardianOf) || []) named.add(toHex(g.federationId));
        const a = e && e.advert; if (!(a && a.guardianCapable === true && a.guardianEndpoint) || !speaks(e)) continue;
        const op = String(a.operatorId || toHex(e.pubkey)); ops.add(op); bonds.set(op, (bonds.get(op) || 0n) + BigInt(e.bondSats || 0));
      }
      // THE COHORT (protocol 2026.0.14): the same operators, held to bond_min_guardian, minus those guarding an OPEN federation
      const guarding = guardingOpen ? guardingOpen({ entries, records: held, except: null }) : guardingOpenOf({ entries, held });
      const freeOps = new Set([...bonds].filter(([op, sats]) => sats >= bondMinGuardian && !guarding.has(op)).map(([op]) => op));
      // and WHICH nodes those free operators run (kanban #585: the health page names the nodes the cohort counts, not only how many)
      const freeNodes = entries.filter((e) => e && e.advert && e.advert.guardianCapable === true && e.advert.guardianEndpoint && speaks(e)
        && freeOps.has(String(e.advert.operatorId || toHex(e.pubkey)))).map((e) => toHex(e.pubkey));
      // THIS NODE: its operator, free or not, and if not, which of its operator's nodes guard what
      const own = entries.find((e) => e && toHex(e.pubkey) === toHex(ownKey));
      const ownOp = own && own.advert ? String(own.advert.operatorId || toHex(own.pubkey)) : null;
      const self = ownOp === null ? { inCensus: false } : { inCensus: true, operator: ownOp, operatorNodes: entries.filter((e) => e && e.advert && opOf(e) === ownOp).length,
        free: freeOps.has(ownOp), bondSats: String(bonds.get(ownOp) || 0n), ...(freeOps.has(ownOp) ? {} : { guarding: guardingWhy({ entries, held, op: ownOp }) }) };
      return { height: h, operators: ops.size, free: freeOps.size, freeNodes, self, federations: named.size };
    }
    return null;
  }
  // THE DRAWN NODES' OWN SEATS, at their census adverts' endpoints: codes are read there, and posted there (kanban #495, measured
  // 2026-10-21: the seven new seats hold no round, so peers() never named one another; and the three installer nodes' networkSeats()
  // named none of the seven, so their codes reached nobody who could seat them)
  const drawnRoots = () => {
    if (!current) return [];
    const st = current.founding.state ? current.founding.state() : {};
    const keys = new Set([...(st.seated || []).map((x) => String(x.node || x).toLowerCase()), ...(st.alternates || []).map((x) => String(x).toLowerCase())]);
    keys.delete(toHex(ownKey));
    // AT THE ADDRESS IT IS FOUND AT NOW: its newest address announcement, else its census endpoint (kanban #562)
    return (current.entries || []).filter((e) => e && e.advert && keys.has(toHex(e.pubkey))).map((e) => endpointOf(e)).filter(Boolean)
      .map((u) => String(u).replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, ''));
  };
  async function tick() {
    const h0 = await tip();
    const held = await history(h0);
    // a DRAINING record seats its seated guardians first, its gone ones leave; a standing notice triggers as of its posting
    const named = (r) => !!(r && r.record && r.record.successorId && r.record.successorId.some((x) => x));
    const rows = held.map((r) => (r && r.record && r.status === 'DRAINING'
      ? { ...r, nominal: r.record.nominal, seatedFirst: seatedOf(r.record).map((g) => toHex(g.nodePubkey)), departing: goneNodes(r.record), successor: named(r) } : r));
    let notes = [];
    try { notes = noticeTriggers({ held, notices: (await notices()) || [], departureNotice: clocks.departureNotice, verify }); } catch { notes = []; }
    try { notes = notes.concat(emergencyTriggers({ held, requests: (await emergencies()) || [] })); } catch { /* the notices alone */ }
    // A FEDERATION EXISTS when this seat holds a record OR the census names one (measured on the test host 2026-10-18: the seven
    // new seats and the three installer nodes hold no round, so no record - they drew a GENESIS trigger at 156970 on a network with two
    // federations, and the cohort of ten could never trigger there). guardian_of[] in the bond adverts is the chain's own word for it.
    const federationExists = held.length > 0 || capable.some((x) => x.federations > 0);
    notes = notes.map((n) => (named(held.find((r) => r && lower(r.federation) === n.federation)) ? { ...n, successor: true } : n));
    let t = foundingTrigger({ records: rows, notices: notes, capable, loads, nominal, abandonBlocks: clocks.abandonBlocks, federationExists, voided: [...voided],
      tip: h0, foundingWindow: clocks.foundingWindow, redrawFrom });
    if (!t.ok) return { ok: false, why: t.why };
    // A FOUNDING THAT WORKED IS NOT DRAWN OVER: its trigger stands until the old record names the successor, a redraw height or two later
    if (t.origin && current && current.trigger.origin === t.origin && current.founding.state().federation === true) t = current.trigger;
    const key = triggerKey(t);
    const h = await tip();
    // VOID, NOT STUCK: a draw that has no founding by its height + founding_window has no window left, and the next draw is the chain's
    if (t.origin && (!current || current.key !== key) && h >= t.height + clocks.foundingWindow) {
      voided.add(key);
      return { ok: false, why: `no founding started by ${t.height + clocks.foundingWindow} for the draw at ${t.height}: void, drawn again at ${t.height + clocks.foundingWindow + 1}` };
    }
    // A FOUNDING THIS SEAT JOINED WITHOUT ITS GUARDIAN is joined again once the guardian waits in setup (kanban #577, measured
    // 2026-10-22 on founding a27706f2: n495-1/2's guardians were started again in a fresh setup, asked at once - before fedimintd's
    // setup API answered - and the founding was kept with no guardian; both seated, both no-shows while their guardians waited in
    // setup). The codes taken so far are read again from the drawn seats on this tick.
    // ... and a draw whose fresh setup waited on an unknown reading of the guardian is read again (kanban #1177)
    if (!current || current.key !== key || (!current.via && (current.freshWait || await guardianInSetup()))) {
      const seed = await beaconAt(t.height + 1);
      if (!seed) return { ok: false, why: `the beacon after ${t.height} is not in this seat's chain yet (tip ${h})` };
      const entries = await entriesAt(t.height);
      if (!entries) return { ok: false, why: `no census read at ${t.height} yet` };
      const except = t.federation || null;
      const seatedFirst = (t.seatedFirst || []).map((k) => entries.find((e) => toHex(e.pubkey) === k)).filter(Boolean);
      const candidateVersion = candidateVersionAt(t.height);
      let pressureBond = null;
      if (pressureBondAt) {
        try { pressureBond = (await pressureBondAt({ height: t.height, entries })) ?? null; }
        catch (e) { return { ok: false, why: `the capacity pressure at ${t.height} could not be read: ${e.message}` }; }
      }
      const out = new Set(guardingOpen ? guardingOpen({ entries, records: held, except }) : guardingOpenOf({ entries, held, except }));
      for (const k of t.departing || []) { const e = entries.find((x) => toHex(x.pubkey) === k); if (e) out.add(opOf(e)); }
      // WHICH GUARDIAN TAKES PART: the node's own while it waits in setup, else its guardian-next while that one does
      let use = null, via = null;
      if (await guardianInSetup()) { use = setup; via = 'guardian'; }
      else if (next && next.setup && typeof next.inSetup === 'function' && await next.inSetup()) { use = next.setup; via = 'guardian-next'; }
      // A GUARDIAN LEFT IN A FAILED KEY GENERATION (kanban #495, measured 2026-10-22: the three installers' guardians still waited on
      // founding 53be35a3's peers, and after 5716ac58's checksum failure the guardians had exited - neither in setup, so these nodes,
      // seated, posted no code): named in this draw, seated or an alternate, with no guardian in setup and none running a federation, the
      // node starts its guardian again in a fresh setup (its old setup kept beside it), once per founding
      // NEVER ON AN UNKNOWN READING (kanban #1177): a node that started in setup and finished its DKG in this process, its setup API timing out
      // once, was read "not running" and its live guardian's database was set aside. Now only a verified DOWN (GUARDIAN) starts one, the
      // founding is written as tried before the guardian is touched, and node-start.js checks the key files once more before it moves anything
      let freshWait = false;
      if (!use && setup && typeof setup.freshSetup === 'function' && !tried.has(key)) {
        const probe = createFounding({ seed, triggerHeight: t.height, entries, nominal: Number.isInteger(t.nominal) && t.nominal > 0 ? t.nominal : nominal, bondMinGuardian,
          guardingOpen: out, seatedFirst, pressureBond, candidateVersion, openGuarding: openGuardingOf({ entries, held, except }), pegInMinSats, foundingWindow: clocks.foundingWindow, ownKey, sign, verify, setup: null, firstSeason });
        const ps = probe.state(), me = toHex(ownKey);
        const named = (ps.seated || []).some((x) => String(x.node || x).toLowerCase() === me) || (ps.alternates || []).some((x) => String(x).toLowerCase() === me);
        let reading = GUARDIAN.UNKNOWN;
        if (named) { try { reading = typeof setup.status === 'function' ? await setup.status() : GUARDIAN.UNKNOWN; } catch { reading = GUARDIAN.UNKNOWN; } }
        const step = freshSetupStep({ named, reading, tried: false });
        if (step.act === 'wait') { freshWait = true; say({ founding: probe.id.slice(0, 16), freshSetup: step.why }); }
        if (step.act === 'fresh') {
          let kept = false; try { tried.add(key); kept = true; } catch (e) { say({ founding: probe.id.slice(0, 16), freshSetup: `not started: the founding could not be kept as tried (${e.message})` }); }
          if (kept) {
            let r; try { r = await setup.freshSetup(); } catch (e) { r = { ok: false, why: e.message }; }
            say({ founding: probe.id.slice(0, 16), freshSetup: r.ok ? 'the guardian was not running and held no federation key: started again in a fresh setup (its old setup kept)' : r.why });
            if (r.ok && await guardianInSetup()) { use = setup; via = 'guardian'; }
          }
        }
      }
      // A SUCCESSOR HAS ITS PREDECESSOR'S SIZE: the held record's nominal (federation B: 7) - genesis's federation_nominal
      // is 4 on testnet4 and regtest, and B's successor drawn at 4 would seat four of B and draw nobody
      const size = Number.isInteger(t.nominal) && t.nominal > 0 ? t.nominal : nominal;
      const openGuarding = openGuardingOf({ entries, held, except });
      current = { key, trigger: t, via, freshWait, entries, founding: createFounding({ seed, triggerHeight: t.height, entries, nominal: size, bondMinGuardian, guardingOpen: out, seatedFirst, pressureBond, candidateVersion, openGuarding, pegInMinSats,
        foundingWindow: clocks.foundingWindow, ownKey, sign, verify, setup: use, post, say, firstSeason }) };
      say({ founding: current.founding.id.slice(0, 16), trigger: t.kind, height: t.height, why: t.why, nominal: size, seatedFirst: seatedFirst.length,
        leftOut: [...out], takesPart: !!use, via });
    }
    // codes this seat missed, from the others' GET /founding - ASKED OF THE DRAWN NODES THEMSELVES too, at their census adverts'
    // endpoints (kanban #495, measured 2026-10-21 on the 10-node cohort 8fbeab5e at 157,174: the seven new seats hold no round, so
    // peers() - the configured seats and the newest held round's census - never named one another; each seat held only its own code
    // and every draw went void, "more no-shows than alternates")
    // ... AND WHETHER THE FEDERATION RUNS, counted only from a seated node's own seat at its census endpoint (kanban #1161): founding.js
    // runs it once a threshold of the seated say so; a root that is no drawn node's, or answers in another node's name, counts nothing
    const rootNode = new Map();
    for (const e of current.entries || []) {
      let u = null; try { u = e && e.advert ? endpointOf(e) : null; } catch { u = null; }
      if (u) rootNode.set(String(u).replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, ''), toHex(e.pubkey));
    }
    if (fetchJson) for (const root of [...new Set([...peers(), ...drawnRoots()])]) {
      try {
        const s = await fetchJson(`${root}/founding`);
        if (s && s.id === current.founding.id) {
          current.founding.takeAll(s.codes);
          const node = rootNode.get(String(root).replace(/\/+$/, ''));
          if (s.federation === true && node && (!s.node || lower(s.node) === node)) current.founding.federationSeen(node);
        }
      } catch { /* the next tick */ }
    }
    const st = await current.founding.advance(h);
    // THIS SEAT'S OWN CODE, sent to every drawn node's seat on each tick until the federation exists: one lost post, or a node
    // whose advert names a tunnel it no longer has, must not make it a no-show at seats that cannot read it back. Not only until
    // this seat starts its key generation - it starts once it holds every code, which may be before the others hold its own
    const mine = st && st.federation !== true && !st.void ? (st.codes || []).find((c) => c.node === toHex(ownKey)) : null;
    if (postTo && mine) {
      const m = { id: current.founding.id, node: mine.node, code: mine.code, signature: mine.signature };
      await Promise.all(drawnRoots().map((root) => Promise.resolve().then(() => postTo(root, m)).catch(() => null)));
    }
    if (st && st.void) voided.add(current.key);   // the next tick draws on the next trigger
    return { ok: true, trigger: current.trigger, state: st };
  }
  // IS THIS NODE READY TO BE FOUNDED? (kanban #585, 2026-10-22: "shows the 10 nodes waiting for a founding event so we know in
  // the future if they're ready to be founded"): its guardian waiting in setup (ready), running a federation, or none; the seat's newest
  // count of free operators against the cohort's ten; and why its last tick started no founding. Asked of the guardian at most every 30 s.
  let lastTick = null, ready = null;
  async function readiness(nowMs = Date.now()) {
    if (ready && nowMs - ready.atMs < 30000) return ready.value;
    let guardian = 'none';
    try { if (await guardianInSetup()) guardian = 'setup'; else if (setup && typeof setup.done === 'function' && await setup.done()) guardian = 'running'; } catch { guardian = 'none'; }
    const c = capable.length ? capable[capable.length - 1] : null;
    const value = { guardian, cohort: c && typeof c.free === 'number' ? { height: c.height, free: c.free, needed: COHORT_NOMINAL, operators: c.operators, nodes: c.freeNodes || [], self: c.self || null } : null,
      why: lastTick && !lastTick.ok ? lastTick.why : null };
    ready = { atMs: nowMs, value };
    return value;
  }
  // THE NODES THAT CAN BE DRAWN, EACH ASKED (kanban #585, 2026-10-22: "Tu das Dashboard so umbauen dass es solchen
  // Diskrepanzen nicht geben kann"): the newest row's free nodes, each at its announced address - ready (its guardian waits in setup),
  // running, none, founding off, an older release, or no answer - so a page shows one list and counts its own rows. Every 60 s at most.
  // answered at once from the last list, read again in the background when it is older than 60 s (asking thirty nodes takes longer
  // than a page waits for one answer); `wait` reads it now (tests)
  let membersCache = null, membersRun = null;
  async function members(nowMs = Date.now(), { wait = false } = {}) {
    if (membersCache && nowMs - membersCache.atMs < 60000) return membersCache.value;
    if (!membersRun) membersRun = readMembers(nowMs).finally(() => { membersRun = null; });
    if (wait || !membersCache) { const v = await Promise.race([membersRun, ...(wait ? [] : [new Promise((r) => setTimeout(() => r(undefined), 5000))])]); if (v !== undefined) return v; }
    return membersCache ? membersCache.value : null;
  }
  async function readMembers(nowMs) {
    const c = capable.length ? capable[capable.length - 1] : null;
    if (!c || !Array.isArray(c.freeNodes) || !lastEntries) return null;
    const want = new Set(c.freeNodes), me = toHex(ownKey);
    const es = lastEntries.filter((e) => e && want.has(toHex(e.pubkey)));
    const one = async (e) => {
      const k = toHex(e.pubkey), root = String(endpointOf(e) || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
      if (k === me) return { node: k, endpoint: root, state: (await readiness(nowMs)).guardian };
      if (!fetchJson || !root) return { node: k, endpoint: root, state: 'no answer' };
      try {
        const b = await fetchJson(`${root}/founding`);
        return { node: k, endpoint: root, state: b && b.ready ? b.ready.guardian : b && b.off ? 'off' : b ? 'older release' : 'no answer' };
      } catch { return { node: k, endpoint: root, state: 'no answer' }; }
    };
    const out = [];
    for (let i = 0; i < es.length; i += 8) out.push(...await Promise.all(es.slice(i, i + 8).map(one)));
    const value = { height: c.height, free: c.free, needed: COHORT_NOMINAL, nodes: out };
    membersCache = { atMs: nowMs, value };
    return value;
  }
  /** The node keys (hex) the founding in progress seats, for the P2P tunnels' port rule (kanban #1358): none when no founding runs. */
  const seatedKeys = () => { try { const st = current && current.founding.state ? current.founding.state() : null; return st && !st.void && !st.federation ? st.seated.map((x) => x.node) : []; } catch { return []; } };
  return { tick: async () => (lastTick = await tick()), readiness, members, seatedKeys, take: (m) => (current ? current.founding.take(m) : { ok: false, status: 404, why: 'no founding runs' }),
    state: () => (current ? { trigger: current.trigger, via: current.via, ...current.founding.state() } : null) };
}
