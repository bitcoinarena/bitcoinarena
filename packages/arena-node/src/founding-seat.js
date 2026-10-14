// A SEAT'S PART IN A FOUNDING (spec §23A.2, kanban #320): when to start one and how its own guardian takes part. founding.js runs
// the ceremony; this reads its inputs off what the seat holds and drives the node's own guardian.
//
//   TRIGGER   foundingTrigger over the federation records this seat holds: a record that entered DRAINING (succession) at its
//             height. Every seat holding the same records names the same trigger. (Genesis and load need a per-height history of
//             the census and the federations' loads; they are not read here yet.)
//   SEED      the beacon: the hash of the block after trigger_height, once it is in the seat's chain.
//   CENSUS    the bonded census at trigger_height, its entries with their adverts (guardian_capable, guardian_endpoint).
//   GUARDIAN  a node takes part only while its own guardian waits in Fedimint's setup (its admin status names no federation):
//             a node already guarding is not eligible anyway (guardingOpen). Its setup calls go through fedimint-cli's
//             `admin setup` against the guardian's own API socket, with its admin password.
import { foundingTrigger } from '../../arena-protocol/src/guardian-founding.js';
import { createFounding } from './founding.js';

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
  };
}

/**
 * The seat's foundings: `tick()` once in a while. `records()` the held records [{ federation, status, height }]; `entriesAt(h)`
 * the census entries at h (or null while the chain is not read that far); `beaconAt(h)` the block hash at h (32 bytes, or null);
 * `tip()`; `guardianInSetup()` true while the node's guardian waits in setup; `setup` its setup calls; `guardingOpen()` operator
 * ids guarding an OPEN federation; `peers()` the seats' roots, whose GET /founding is read for codes this seat missed.
 */
export function createFoundingSeat({ records, entriesAt, beaconAt, tip, guardianInSetup, setup, guardingOpen = () => new Set(), nominal,
  bondMinGuardian, clocks, ownKey, sign, verify, post = async () => {}, peers = () => [], fetchJson = null, say = () => {} }) {
  let current = null;                        // { key, founding }
  async function tick() {
    const t = foundingTrigger({ records: records(), nominal, abandonBlocks: clocks.abandonBlocks, federationExists: true });
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
    const st = await current.founding.step(h);
    return { ok: true, trigger: current.trigger, state: st };
  }
  return { tick, take: (m) => (current ? current.founding.take(m) : { ok: false, status: 404, why: 'no founding runs' }),
    state: () => (current ? { trigger: current.trigger, ...current.founding.state() } : null) };
}
