import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { decodeSeatingCertificate, seatingId } from '../../arena-protocol/src/seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const signer = (n) => (m) => schnorr.sign(m, n.secret);
const START = 60500n;
const NOW = Number(START) - 150000;


const BAD = 1;
function setup({ dead = new Set(), badSeated, badNull = () => false }) {
  const seatedFor = typeof badSeated === 'function' ? badSeated : () => badSeated;
  const c = { ...contractFor(nodes.slice(0, 7).map((n) => n.pubkey)), startTimeMs: START };
  const bytes = encodeRoundContract(c);
  const rid = roundIdOf(c);
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const net = { now: NOW, agents: new Map(), dbs: new Map(), rid, bytes, drawn };
  const fetcherOf = (from) => async (url, init = {}) => {
    const u = new URL(url);
    const to = nodes.findIndex((n) => n.endpoint === `${u.protocol}//${u.host}`);
    const a = net.agents.get(to);
    if (!a || dead.has(to)) return new Response('down', { status: 503 });
    if (u.pathname === '/presents') { const r = a.takePresents(new Uint8Array(await new Response(init.body).arrayBuffer())); return new Response(JSON.stringify(r), { status: r.ok ? 201 : 400 }); }
    if (u.pathname === '/seating-batch') {
      const j = a.batchOf(u.searchParams.get('rounds').split(','));
      if (to === BAD) for (const r of Object.values(j.rounds)) {
        const seated = seatedFor(from, net).map((i) => nodes[i].pubkey);
        const sigOf = (role) => (badNull() ? null : { node: toHex(nodes[BAD].pubkey), seated: seated.map(toHex), signature: toHex(schnorr.sign(seatingId({ roundId: rid, role, seated }), nodes[BAD].secret)) });
        r.sig = { game: sigOf('game'), settlement: sigOf('settlement') }; r.cert = { game: null, settlement: null };
      }
      return new Response(JSON.stringify(j), { status: 200 });
    }
    if (u.pathname === '/seating') {
      if (to === BAD) return new Response('ok', { status: 201 });
      const b = new Uint8Array(await new Response(init.body).arrayBuffer()); const r = a.keepCert(rid, decodeSeatingCertificate(b).role, b);
      return new Response(JSON.stringify(r), { status: r.ok ? 201 : 409 });
    }
    return new Response('no', { status: 404 });
  };
  net.boot = (i, fresh = true) => {
    const n = nodes[i];
    let db = net.dbs.get(i);
    if (fresh) {
      db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
      db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, bytes);
      net.dbs.set(i, db);
    }
    const round = { db, pubkey: n.pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null) };
    net.agents.set(i, seatingAgent({ round, roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: signer(n), fetcher: fetcherOf(i), nowMs: () => net.now,
      verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } } }));
  };
  for (let i = 0; i < 9; i++) if (!dead.has(i)) net.boot(i);
  net.tickAll = async (times, all = false) => { for (let k = 0; k < times; k++) for (const [i, a] of net.agents) if (all || i !== BAD) await a.tick(); };
  net.report = (honest) => {
    const held = honest.filter((i) => net.agents.get(i).certOf(rid, 'settlement'));
    const roles = honest.map((i) => { const m = net.agents.get(i).mySignature(rid, 'settlement'); return `${i}:` + (m ? m.seated.map((k) => nodes.findIndex((n) => toHex(n.pubkey) === k)).join('') : '-'); });
    return { held, roles };
  };
  return net;
}



const idx = (k) => nodes.findIndex((n) => toHex(n.pubkey) === k);
const sigStr = (net, i) => { const m = net.agents.get(i).mySignature(net.rid, 'settlement'); return m ? m.seated.map(idx).join('') : '-'; };
const certStr = (net, i) => { const c = net.agents.get(i).certOf(net.rid, 'settlement'); if (!c) return '-'; return decodeSeatingCertificate(typeof c === 'string' ? new Uint8Array(Buffer.from(c, 'hex')) : c).seated.map((k) => idx(toHex(k))).join(''); };

// wf1489 a44 refute-3 s2-1 (attacker: the same one drawn seat, now SELECTIVE in time): seat 1 hands every honest seat a valid signature over the
// first 5 drawn (the #1609 attack) until some honest seats have left it as a withholder (#1509/#1609) and re-signed 0234567 - then it hands its
// signature over 0123456 to everyone. The seats that had not yet moved (their WITHHELD_SIG_MS still running a tick behind) hold every member's
// signature over 0123456 (the movers' first signatures are kept) and certify it; the movers refuse that certificate for good (#1707: it seats the
// member they left) and their own seating never completes, since the certified seats stop signing. Expected: the round ends with one seating whose
// certificate at least receiptsNeeded(7) = 5 honest members of it hold. Observed on 0f04ff273: below.
test('wf1489 a44 refute-3 s2-1: the #1609 withholder signing the first seating late, after a few honest seats moved, does not split the honest seats under the threshold', async () => {
  const MOVERS = [0, 2, 3];
  const S = '0123456';
  const net = setup({ badSeated: (from, n) => (MOVERS.every((i) => { const s = sigStr(n, i); return s !== '-' && s !== S; }) ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4]) });
  await net.tickAll(2, true);
  const close = Number(START - 120000n);
  for (let t = close + 1000; t < Number(START); t += 5000) {
    net.now = t;
    // the movers tick first in a tick round (any honest order, any seat's tick a few ms earlier than another's)
    for (const i of [0, 2, 3, 4, 5, 6, 7, 8]) await net.agents.get(i).tick();
  }
  const honest = [0, 2, 3, 4, 5, 6, 7, 8];
  const view = honest.map((i) => `${i}: signed ${sigStr(net, i)} cert ${certStr(net, i)}`).join('; ');
  const byCert = new Map();
  for (const i of honest) { const c = certStr(net, i); if (c !== '-' && c.includes(String(i))) byCert.set(c, (byCert.get(c) || 0) + 1); }
  const best = Math.max(0, ...byCert.values());
  assert.ok(best >= 5, `no seating's certificate is held by 5 honest members of it (best ${best}); ${view}`);
});

// the same split reached through a RESTART (retry/reload lens): seats 4, 5 and 6 restart 20 s after they signed (a deploy, a crash); signedAt is
// in memory, so their WITHHELD_SIG_MS starts again and they move 20 s after 0, 2 and 3 whatever order the seats tick in. Seat 1 signs 0123456 once
// 0, 2 and 3 have moved.
test('wf1489 a44 refute-3 s2-1b: honest seats restarted after signing do not let the #1609 withholder split them under the threshold', async () => {
  const MOVERS = [0, 2, 3];
  const S = '0123456';
  const net = setup({ badSeated: (from, n) => (MOVERS.every((i) => { const s = sigStr(n, i); return s !== '-' && s !== S; }) ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4]) });
  await net.tickAll(2, true);
  const close = Number(START - 120000n);
  for (let t = close + 1000; t < Number(START); t += 5000) {
    net.now = t;
    if (t === close + 21000) for (const i of [4, 5, 6]) net.boot(i, false);
    for (const i of [8, 7, 6, 5, 4, 3, 2, 0]) await net.agents.get(i).tick();
  }
  const honest = [0, 2, 3, 4, 5, 6, 7, 8];
  const view = honest.map((i) => `${i}: signed ${sigStr(net, i)} cert ${certStr(net, i)}`).join('; ');
  const byCert = new Map();
  for (const i of honest) { const c = certStr(net, i); if (c !== '-' && c.includes(String(i))) byCert.set(c, (byCert.get(c) || 0) + 1); }
  const best = Math.max(0, ...byCert.values());
  assert.ok(best >= 5, `no seating's certificate is held by 5 honest members of it (best ${best}); ${view}`);
});
