// A SEAT'S PART IN A FOUNDING (spec §23A.2, kanban #320): when to start one and how its own guardian takes part. founding.js runs
// the ceremony; this reads its inputs off what the seat holds and drives the node's own guardian.
//
//   TRIGGER   foundingTrigger over what this seat holds: a record that entered DRAINING (succession) at its height; the first height
//             with federation_nominal guardian-capable operators while no federation exists (genesis); every OPEN federation at 80 %
//             of its cap for abandon_blocks (load). The seat keeps the census and load history it saw at each tick (kanban #320).
//   SEED      the beacon: the hash of the block after trigger_height, once it is in the seat's chain.
//   CENSUS    the bonded census at trigger_height, its entries with their adverts (guardian_capable, guardian_endpoint).
//   GUARDIAN  a node takes part only while one of its guardians waits in Fedimint's setup (its setup status is not
//             ConsensusIsRunning): its own guardian (a node with no ceremony files starts it in setup mode with
//             ARENA_FOUNDING=1, node-start.js), else its second one, the guardian-next (kanban #326: a guardian in consensus
//             seated first in its federation's successor takes part through a second fedimintd in setup mode beside it).
//             Its setup calls go through fedimint-cli's `admin setup` against that guardian's own API socket, with its admin
//             password.
//   NOTICE    a succession is also triggered by a standing departure notice (§23A.6 "or a departure notice that would make it
//             DRAINING", kanban #326): the seat's held notices (absences.js, POST /departure) against the held record of an OPEN
//             federation - or one already DRAINING or CRITICAL - whose seated guardians without the leaving one fall to DRAINING
//             (CRITICAL at four, §23A.1); trigger_height is the height the notice was posted at.
//   SEATED    a succession seats the record's seated, non-departing guardians first, in the record's order (node key
//   FIRST     ascending), and draws the missing seats (drawGuardians). The draw's pool leaves out the operators guarding an OPEN
//             federation other than the one succeeded (their census adverts' guardian_of[] naming a federation whose held record is
//             OPEN), and the leaving guardians' operators (the succeeded federation's departing / gone guardians).
import { triggerKey, foundingTrigger } from '../../arena-protocol/src/guardian-founding.js';
import { departureStands } from '../../arena-protocol/src/absence.js';
import { statusFor } from '../../arena-protocol/src/federation-record.js';
import { createFounding } from './founding.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const opOf = (e) => String((e && e.advert && e.advert.operatorId) || toHex(e.pubkey));
const lower = (x) => String(x || '').toLowerCase();
/** A held record's seated guardians - not in its gone[] - in the record's order. */
export function seatedOf(record) {
  const gone = new Set((record.gone || []).map((g) => toHex(g.peerKey)));
  return (record.guardians || []).filter((g) => !gone.has(toHex(g.peerKey)));
}
const goneNodes = (record) => { const s = new Set(seatedOf(record).map((g) => toHex(g.nodePubkey))); return (record.guardians || []).map((g) => toHex(g.nodePubkey)).filter((k) => !s.has(k)); };

/**
 * THE NOTICE TRIGGERS (§23A.6, kanban #326): of `notices` (decoded departure notices), each one that stands against the held record
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

/** The operators guarding an OPEN federation other than `except`: census adverts whose guardian_of[] names a federation held OPEN. */
export function guardingOpenOf({ entries = [], held = [], except = null }) {
  const open = new Set((held || []).filter((r) => r && r.status === 'OPEN' && lower(r.federation) !== lower(except)).map((r) => lower(r.federation)));
  const ops = new Set();
  for (const e of entries || []) for (const g of (e && e.advert && e.advert.guardianOf) || []) if (open.has(toHex(g.federationId))) ops.add(opOf(e));
  return ops;
}

/**
 * The guardian's setup, through the stock CLI: `run(args)` runs fedimint-cli and answers its stdout. The code is the
 * set-local-params output without its JSON quotes.
 */
export function cliSetup({ run, apiPort, password, guardianName }) {
  const setup = (...a) => run(['--password', password, 'admin', 'setup', `ws://127.0.0.1:${apiPort}`, ...a]);
  const unq = (s) => String(s).trim().replace(/^"|"$/g, '');
  return {
    localParams: async ({ leader, name, size }) => unq(await setup('set-local-params', guardianName, ...(leader ? ['--federation-name', name, '--federation-size', String(size)] : []))),
    addPeer: async (code) => { await setup('add-peer', code); },
    startDkg: async () => { await setup('start-dkg'); },
    invite: async () => null,
    // WHETHER THE GUARDIAN WAITS IN SETUP (kanban #320, rehearsal 20b 2026-10-14): asked of the SETUP API itself. A guardian in setup mode
    // does not serve the admin `status` ("Method not found"), so a seat asking that never took part; `admin setup status` answers
    // "ConsensusIsRunning" once its federation runs, and a setup state (AwaitingLocalParams, SharingConnectionCodes, ...) before
    inSetup: async () => { try { const st = unq(await setup('status')); return !!st && st !== 'ConsensusIsRunning'; } catch { return false; } },
    // THE FEDERATION RUNS (§23A.2: the founding is void only "if the window passes without a federation"): its DKG done, consensus running
    done: async () => { try { return unq(await setup('status')) === 'ConsensusIsRunning'; } catch { return false; } },
  };
}

/**
 * The seat's foundings: `tick()` once in a while. `records()` the held records [{ federation, status, height }]; `entriesAt(h)`
 * the census entries at h (or null while the chain is not read that far); `beaconAt(h)` the block hash at h (32 bytes, or null);
 * `tip()`; `guardianInSetup()` true while the node's guardian waits in setup; `setup` its setup calls; `peers()` the seats' roots,
 * whose GET /founding is read for codes this seat missed. Kanban #326: `records()` rows may carry `record` (the held record,
 * decoded) - a DRAINING one then seats its seated guardians first, and the notice trigger reads it; `notices()` the departure
 * notices this seat holds (decoded); `next` { inSetup(), setup } the node's guardian-next, if it runs one; `guardingOpen({ entries,
 * records, except })` the operators guarding an OPEN federation (by default guardingOpenOf over the census and the held records).
 */
export function createFoundingSeat({ records, entriesAt, beaconAt, tip, guardianInSetup, setup, guardingOpen = null, notices = () => [], next = null, nominal,
  bondMinGuardian, clocks, ownKey, sign, verify, post = async () => {}, peers = () => [], fetchJson = null, say = () => {}, keep = 4096 }) {
  let current = null;                        // { key, founding }
  const voided = new Set();                  // keys of foundings whose window passed without a federation: the next trigger draws again
  // THE HISTORY THE GENESIS AND LOAD TRIGGERS READ (§23A.2, kanban #320), one row per chain height this seat ticked at:
  //   capable  { height, operators }: the distinct operators of guardian-capable census nodes with an endpoint (the draw's own rule)
  //   loads    { height, federations: [{ federation, status, load }] }: every held record's status and load (reserve over exposure cap)
  const capable = [], loads = [];
  const remember = (rows, row) => { if (!rows.length || rows[rows.length - 1].height < row.height) rows.push(row); if (rows.length > keep) rows.shift(); };
  async function history(h) {
    const held = records() || [];
    remember(loads, { height: h, federations: held.map((r) => ({ federation: r.federation, status: r.status, load: typeof r.load === 'number' ? r.load : null })) });
    let entries = null; try { entries = await entriesAt(h); } catch { entries = null; }
    if (entries) {
      const ops = new Set(), bonds = new Map();
      for (const e of entries) {
        const a = e && e.advert; if (!(a && a.guardianCapable === true && a.guardianEndpoint)) continue;
        const op = String(a.operatorId || toHex(e.pubkey)); ops.add(op); bonds.set(op, (bonds.get(op) || 0n) + BigInt(e.bondSats || 0));
      }
      // THE COHORT (protocol 2026.0.14): the same operators, held to bond_min_guardian, minus those guarding an OPEN federation
      const guarding = guardingOpen ? guardingOpen({ entries, records: held, except: null }) : guardingOpenOf({ entries, held });
      const free = [...bonds].filter(([op, sats]) => sats >= bondMinGuardian && !guarding.has(op)).length;
      remember(capable, { height: h, operators: ops.size, free });
    }
    return held;
  }
  async function tick() {
    const h0 = await tip();
    const held = await history(h0);
    // a DRAINING record seats its seated guardians first, its gone ones leave; a standing notice triggers as of its posting
    const rows = held.map((r) => (r && r.record && r.status === 'DRAINING'
      ? { ...r, nominal: r.record.nominal, seatedFirst: seatedOf(r.record).map((g) => toHex(g.nodePubkey)), departing: goneNodes(r.record) } : r));
    let notes = [];
    try { notes = noticeTriggers({ held, notices: (await notices()) || [], departureNotice: clocks.departureNotice, verify }); } catch { notes = []; }
    const t = foundingTrigger({ records: rows, notices: notes, capable, loads, nominal, abandonBlocks: clocks.abandonBlocks, federationExists: held.length > 0, voided: [...voided] });
    if (!t.ok) return { ok: false, why: t.why };
    const key = triggerKey(t);
    const h = await tip();
    if (!current || current.key !== key) {
      const seed = await beaconAt(t.height + 1);
      if (!seed) return { ok: false, why: `the beacon after ${t.height} is not in this seat's chain yet (tip ${h})` };
      const entries = await entriesAt(t.height);
      if (!entries) return { ok: false, why: `no census read at ${t.height} yet` };
      const except = t.federation || null;
      const seatedFirst = (t.seatedFirst || []).map((k) => entries.find((e) => toHex(e.pubkey) === k)).filter(Boolean);
      const out = new Set(guardingOpen ? guardingOpen({ entries, records: held, except }) : guardingOpenOf({ entries, held, except }));
      for (const k of t.departing || []) { const e = entries.find((x) => toHex(x.pubkey) === k); if (e) out.add(opOf(e)); }
      // WHICH GUARDIAN TAKES PART: the node's own while it waits in setup, else its guardian-next while that one does
      let use = null, via = null;
      if (await guardianInSetup()) { use = setup; via = 'guardian'; }
      else if (next && next.setup && typeof next.inSetup === 'function' && await next.inSetup()) { use = next.setup; via = 'guardian-next'; }
      // A SUCCESSOR HAS ITS PREDECESSOR'S SIZE (kanban #326): the held record's nominal (federation B: 7) - genesis's federation_nominal
      // is 4 on testnet4 and regtest, and B's successor drawn at 4 would seat four of B and draw nobody
      const size = Number.isInteger(t.nominal) && t.nominal > 0 ? t.nominal : nominal;
      current = { key, trigger: t, via, founding: createFounding({ seed, triggerHeight: t.height, entries, nominal: size, bondMinGuardian, guardingOpen: out, seatedFirst,
        foundingWindow: clocks.foundingWindow, ownKey, sign, verify, setup: use, post, say }) };
      say({ founding: current.founding.id.slice(0, 16), trigger: t.kind, height: t.height, why: t.why, nominal: size, seatedFirst: seatedFirst.length,
        leftOut: [...out], takesPart: !!use, via });
    }
    // codes this seat missed, from the others' GET /founding
    if (fetchJson) for (const root of peers()) {
      try {
        const s = await fetchJson(`${root}/founding`);
        if (s && s.id === current.founding.id) { current.founding.takeAll(s.codes); if (s.federation === true) current.founding.federationSeen(); }
      } catch { /* the next tick */ }
    }
    const st = await current.founding.advance(h);
    if (st && st.void) voided.add(current.key);   // the next tick draws on the next trigger
    return { ok: true, trigger: current.trigger, state: st };
  }
  return { tick, take: (m) => (current ? current.founding.take(m) : { ok: false, status: 404, why: 'no founding runs' }),
    state: () => (current ? { trigger: current.trigger, via: current.via, ...current.founding.state() } : null) };
}
