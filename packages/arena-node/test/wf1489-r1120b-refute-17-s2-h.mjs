// harness for wf1489-r1120b-refute-17-s2-*.test.js (copy of -s1-h with a poison hook: poison(seatName, asker, standing) -> a JSON text or null): drives server.js's own gatherSeatings (as audit-gossip-r2-1.test.js)
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signGatewaySeating, standingSeating } from '../../arena-protocol/src/gateway-seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';
export { standingSeating };
const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const from = src.indexOf('const gatherSeatings = async () => {');
const body = src.slice(from, src.indexOf('\n    };\n', from) + 7);
const NAMES = ['chainTip', 'GATEWAY_EPOCH_BLOCKS', 'gatewayWatches', 'ownSeatings', 'gatewaySeatings', 'signGatewaySeating', 'toHex', 'round', 'schnorr',
  'keepSeating', 'fedRecords', 'addressBook', 'fetch', 'jsonUpTo', 'PEER_LISTING_BYTES', 'standingSeating', 'schnorrVerify'];
const makeGather = new Function(...NAMES, `${body}\nreturn gatherSeatings;`);
export const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
export const fid = 'f0'.repeat(32);
export const EPOCH = 1090; const TIP = 144 * 1091 + 5;
const node = (name, i, url) => { const secret = new Uint8Array(32).fill(0x41 + i); const pubkey = schnorr.getPublicKey(secret); return { name, secret, pubkey, hex: toHex(pubkey), url }; };
export const G1 = '11'.repeat(32);
const answer = (status, j) => ({ status, ok: status === 200, json: async () => j, body: null });
const jsonUpTo = async (r) => r.json();
export const list = (m) => (m ? m.seats.map((x) => x.slice(0, 2)).sort().join(',') : 'none');

// dServesTo: the names D serves its own signature to; seatNames: non-guardian census seats (entries order); junkFrom: a census seat answering ?standing=1 with junk
export function world({ dServesTo, seatNames = ['S1', 'S2'], junkFrom = null, down = () => false, poison = () => null }) {
  const guardians = ['A', 'B', 'C', 'D'].map((n, i) => node(n, i, `https://g${i}.example`));
  const others = seatNames.map((n, i) => node(n, 10 + i, `https://s${i}.example`));
  const D = guardians[3];
  const entries = [...guardians, ...others].map((x) => ({ pubkey: x.pubkey, advert: { endpoint: x.url } }));
  const seats = [...guardians, ...others].map((g) => ({ g, own: new Map(), standing: new Map(), db: new Map() }));
  const byName = Object.fromEntries(seats.map((s) => [s.g.name, s]));
  const viewOf = (name) => ({ ok: true, measuredEpoch: 'whole', epoch: EPOCH, federationId: fid,
    seated: ['A', 'B', 'D'].includes(name) ? [G1, D.hex] : [G1], belowMinimums: [], gateways: {} });
  const fetchFor = (asker) => async (u) => {
    const seat = seats.find((s) => String(u).startsWith(s.g.url));
    if (!seat || !String(u).includes('/gateway-seating?') || down(seat.g.name, asker)) return answer(404, null);
    const q = new URL(u).searchParams;
    { const p = poison(seat.g.name, asker, q.get('standing') === '1'); if (p) return answer(200, JSON.parse(p)); }   // parsed as jsonUpTo parses it
    if (q.get('standing') === '1') {
      if (junkFrom === seat.g.name) return answer(200, guardians.map((g) => ({ federationId: fid, epoch: EPOCH, seats: [G1], guardian: g.hex, signature: '00'.repeat(64) })));
      const st = seat.standing.get(`${q.get('federation')}:${Number(q.get('epoch'))}`); return st && st.proof ? answer(200, st.proof) : answer(404, { ok: false });
    }
    if (seat.g === D && !dServesTo.includes(asker)) return answer(404, { ok: false });
    const got = seat.own.get(`${q.get('federation')}:${Number(q.get('epoch'))}`);
    return got ? answer(200, got) : answer(404, { ok: false });
  };
  const fedRecords = { list: () => [{ federation: fid }], recordOf: () => ({ record: { threshold: 3 } }), seatedGuardians: () => guardians.map((g) => g.pubkey),
    censusNow: () => ({ ok: true, entries }), censusNewest: () => entries };
  const build = (s) => {
    const isGuardian = guardians.includes(s.g);
    const watches = isGuardian ? [{ watch: { view: async () => viewOf(s.g.name) } }] : [];
    const keep = (kind, f, e, b) => s.db.set(`${kind}:${f}:${e}`, JSON.stringify(b));   // as server.js keepSeating: JSON.stringify(body)
    s.pass = makeGather(async () => TIP, 144, watches, s.own, s.standing, signGatewaySeating, toHex,
      { pubkey: s.g.pubkey, identity: { secret: s.g.secret }, db: { prepare: () => ({ run: () => {} }) } }, schnorr, keep, fedRecords,
      { endpointOf: (e) => e.advert.endpoint }, fetchFor(s.g.name), jsonUpTo, 1 << 22, standingSeating, verify);
  };
  for (const s of seats) build(s);
  // a restart: the maps reloaded from the seat's database as server.js does at start (JSON.parse of the kept body)
  const restart = (name) => { const s = byName[name]; s.standing = new Map(); s.own = new Map();
    for (const [k, v] of s.db) { const [kind, f, e] = k.split(':'); ({ own: s.own }[kind] || s.standing).set(`${f}:${e}`, JSON.parse(v)); } build(s); };
  return { guardians, seats, byName, restart, k: `${fid}:${EPOCH}`, fetchFor };
}
