// A SEAT'S PART IN A FOUNDING (spec §23A.2, kanban #320): when to start one and how its own guardian takes part. founding.js runs
// the ceremony; this reads its inputs off what the seat holds and drives the node's own guardian.
//
//   TRIGGER   foundingTrigger over what this seat holds: a record that entered DRAINING (succession) at its height; the first height
//             with federation_nominal guardian-capable operators while no federation exists (genesis); every OPEN federation at 80 %
//             of its cap for abandon_blocks (load). The seat keeps the census and load history it saw at each tick (kanban #320).
//   SEED      the beacon: the hash of the block after trigger_height, once it is in the seat's chain.
//   CENSUS    the bonded census at trigger_height, its entries with their adverts (guardian_capable, guardian_endpoint).
//   GUARDIAN  a node takes part only while its own guardian waits in Fedimint's setup (its admin status names no federation):
//             a node already guarding is not eligible anyway (guardingOpen). Its setup calls go through fedimint-cli's
//             `admin setup` against the guardian's own API socket, with its admin password.
import { foundingTrigger } from '../../arena-protocol/src/guardian-founding.js';
import { createFounding } from './founding.js';
import { toHex } from '../../arena-protocol/src/hash.js';

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
  };
}

/**
 * The seat's foundings: `tick()` once in a while. `records()` the held records [{ federation, status, height }]; `entriesAt(h)`
 * the census entries at h (or null while the chain is not read that far); `beaconAt(h)` the block hash at h (32 bytes, or null);
 * `tip()`; `guardianInSetup()` true while the node's guardian waits in setup; `setup` its setup calls; `guardingOpen()` operator
 * ids guarding an OPEN federation; `peers()` the seats' roots, whose GET /founding is read for codes this seat missed.
 */
export function createFoundingSeat({ records, entriesAt, beaconAt, tip, guardianInSetup, setup, guardingOpen = () => new Set(), nominal,
  bondMinGuardian, clocks, ownKey, sign, verify, post = async () => {}, peers = () => [], fetchJson = null, say = () => {}, keep = 4096 }) {
  let current = null;                        // { key, founding }
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
      const ops = new Set();
      for (const e of entries) { const a = e && e.advert; if (a && a.guardianCapable === true && a.guardianEndpoint) ops.add(String(a.operatorId || toHex(e.pubkey))); }
      remember(capable, { height: h, operators: ops.size });
    }
    return held;
  }
  async function tick() {
    const h0 = await tip();
    const held = await history(h0);
    const t = foundingTrigger({ records: held, capable, loads, nominal, abandonBlocks: clocks.abandonBlocks, federationExists: held.length > 0 });
    if (!t.ok) return { ok: false, why: t.why };
    const key = `${t.kind}:${t.height}`;
    const h = await tip();
    if (!current || current.key !== key) {
      const seed = await beaconAt(t.height + 1);
      if (!seed) return { ok: false, why: `the beacon after ${t.height} is not in this seat's chain yet (tip ${h})` };
      const entries = await entriesAt(t.height);
      if (!entries) return { ok: false, why: `no census read at ${t.height} yet` };
      const inSetup = await guardianInSetup();
      current = { key, trigger: t, founding: createFounding({ seed, triggerHeight: t.height, entries, nominal, bondMinGuardian, guardingOpen: guardingOpen(),
        foundingWindow: clocks.foundingWindow, ownKey, sign, verify, setup: inSetup ? setup : null, post, say }) };
      say({ founding: current.founding.id.slice(0, 16), trigger: t.kind, height: t.height, why: t.why, takesPart: inSetup });
    }
    // codes this seat missed, from the others' GET /founding
    if (fetchJson) for (const root of peers()) {
      try { const s = await fetchJson(`${root}/founding`); if (s && s.id === current.founding.id) current.founding.takeAll(s.codes); } catch { /* the next tick */ }
    }
    const st = await current.founding.advance(h);
    return { ok: true, trigger: current.trigger, state: st };
  }
  return { tick, take: (m) => (current ? current.founding.take(m) : { ok: false, status: 404, why: 'no founding runs' }),
    state: () => (current ? { trigger: current.trigger, ...current.founding.state() } : null) };
}
