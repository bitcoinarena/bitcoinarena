#!/usr/bin/env node
// FEDERATION.md REHEARSAL 26, A SUCCESSION FOUNDED BY NOTICE ON REAL GUARDIANS (§23A.2 + §23A.6 step 1, kanban #326). The node code
// starts every fedimintd here: tools/rehearsal-26-regtest.sh starts a private regtest bitcoind (cookie auth, as a node reads it); this
// starts five arena nodes (src/node-start.js, real servers, NEXTBLOCK hosted) and drives the seats' founding (src/founding-seat.js,
// one per node, in this process as rehearsal 20b does):
//
//   1. five nodes start with ARENA_FOUNDING=1 and no ceremony files: each starts its guardian in SETUP MODE (node-start.js)
//   2. genesis: the census holds n1..n4 (four operators); the seats draw them and the DKG on their setup-mode guardians founds the
//      OLD federation (3 of 4); each node serves it at /guardian at once, and holds its ceremony files
//   3. n1..n3 restart with ARENA_FOUNDING_NEXT=1: each runs its guardian (keyed, in consensus) AND a second fedimintd in setup mode,
//      the guardian-next (<store>.guardian-next, ports +5000..+8000, /guardian-next)
//   4. the census grows: n5 (operator node15, guardian-capable, guarding nothing, its guardian in setup mode since step 1) and a decoy
//      (operator decoy, guarding another OPEN federation G); the seats hold the old federation's record (OPEN) and G's (OPEN)
//   5. n4 posts a departure notice (POST /departure at every node); three seated of four is CRITICAL: the seats read it off GET
//      /absences as a succession trigger at its posted height
//   6. the successor: n1..n3 seated FIRST in the record's order, through their guardian-next; one seat DRAWN - n5, the only operator
//      left (the old federation's operators, the leaving one's and the decoy's are left out); the DKG; one successor federation of
//      four keys answering session_count, and the old federation answering too
// One JSON line per step; it decides nothing. Never testnet4. Blocks paced as 20b (PACE_S).
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { clocksFor } from '../../arena-protocol/src/federation-slash.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { buildFederationRecord } from '../../arena-protocol/src/federation-record.js';
import { signDeparture } from '../../arena-protocol/src/absence.js';
import { createFoundingSeat, cliSetup } from '../src/founding-seat.js';
import { startNode, holdsGuardianKey } from '../src/node-start.js';
import { guardianConfigOf } from '../src/absence-producer.js';
import { wsSessionCount } from '../src/halts.js';
import { bitcoindRpc } from '../src/chain-rpc.js';
import { departureHex, readDepartureHex } from '../src/absences.js';
import { readInvite } from '../src/invite.js';
import { openStore } from '../src/store.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';

const P = process.env.P, B = process.env.BITCOIN_CLI, ARGS = (process.env.BTC_ARGS || '').split(' ').filter(Boolean);
const F = process.env.FEDIMINT_BIN, FH = process.env.FEDIMINT_HOME, BURL = process.env.BITCOIND_URL, COOKIE = process.env.BITCOIND_COOKIE;
if (!P || !B || !F || !FH || !BURL || !COOKIE) throw new Error('P, BITCOIN_CLI, BTC_ARGS, FEDIMINT_BIN, FEDIMINT_HOME, BITCOIND_URL, BITCOIND_COOKIE');
const PACE_S = Number(process.env.PACE_S || 20);
const out = (o) => console.log(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
const cli = (...a) => execFileSync(B, [...ARGS, ...a], { encoding: 'utf8' }).trim();
const height = () => Number(cli('getblockcount'));
const mine = (n) => cli('generatetoaddress', String(n), cli('getnewaddress'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const s = () => Math.round((Date.now() - t0) / 1000);
const { clocks } = clocksFor('regtest');
const verify = (sig, m, k) => { try { return schnorr.verify(sig, m, k); } catch { return false; } };

// THE NODES: n1..n4 found the old federation, n5 is the 15th (operator node15); the decoy is a census entry only
const NAMES = ['n1', 'n2', 'n3', 'n4', 'n5'];
const PORTS = [20110, 20120, 20130, 20140, 20150];
const OPS = ['op1', 'op2', 'op3', 'op4', 'node15'];
const keys = [...NAMES, 'decoy'].map((n) => { const secret = taggedHash('ARENA/v1/Rehearsal26', new TextEncoder().encode(n)); return { secret, pub: schnorr.getPublicKey(secret) }; });
const nameOf = (hex) => { const i = keys.findIndex((k) => toHex(k.pub) === hex); return i < 0 ? hex.slice(0, 8) : i < 5 ? NAMES[i] : 'decoy'; };
const store = (i) => join(P, `${NAMES[i]}.db`);
const rpc = bitcoindRpc({ url: BURL, cookiePath: COOKIE });
const chainFor = (extra) => ({ bitcoindUrl: BURL, cookiePath: COOKIE, call: rpc, tailscale: null,
  env: { ...process.env, PATH: `${F}:${process.env.PATH}`, HOME: FH, ARENA_FOUNDING: '1', ...extra },
  log: (line) => out({ step: 'node log', line: String(line).slice(0, 220) }) });
const nodes = new Array(5).fill(null);
const pidsFile = join(P, 'pids');
async function start(i, extra = {}) {
  const path = store(i);
  const n = await startNode({ db: openStore(path), path }, { port: PORTS[i], plugins: [NEXTBLOCK] }, chainFor(extra));
  nodes[i] = n;
  for (const g of [n.guardians.own, n.guardians.next]) if (g && g.pid) appendFileSync(pidsFile, `${g.pid} fedimintd-${NAMES[i]}-${g.dataDir.endsWith('-next') ? 'next' : 'own'}\n`);
  return n;
}
const fmcli = (args) => execFileSync(join(F, 'fedimint-cli'), args, { encoding: 'utf8', env: { ...process.env, HOME: FH }, timeout: 120000 });
const pw = (dir) => readFileSync(join(dir, 'admin-password'), 'utf8').trim();
const setupOf = (g, name) => cliSetup({ run: async (a) => fmcli(a), apiPort: g.apiPort, password: pw(g.dataDir), guardianName: name });
const statusOf = async (g) => { try { return fmcli(['--password', pw(g.dataDir), 'admin', 'setup', `ws://127.0.0.1:${g.apiPort}`, 'status']).trim().replace(/^"|"$/g, ''); } catch (e) { return `no answer: ${String(e.message).split('\n')[0].slice(0, 80)}`; } };
const session = async (endpoint) => { try { return await wsSessionCount(endpoint, { timeoutMs: 10000, overrides: '' }); } catch (e) { return `no answer: ${String(e.message).slice(0, 60)}`; } };
const untilAnswer = async (what, f, ok, n = 90) => { let v; for (let t = 0; t < n; t++) { v = await f(); if (ok(v)) return v; await sleep(2000); } out({ step: 'gave up', what, last: v }); return v; };
const getJson = async (u, init) => { const r = await fetch(u, { ...init, signal: AbortSignal.timeout(15000) }); return { status: r.status, body: await r.text() }; };
const keysIn = (dir) => { try { const c = JSON.parse(readFileSync(join(dir, 'client.json'), 'utf8')); return Object.keys((c.global || c).broadcast_public_keys || {}).length; } catch { return null; } };
const inviteIn = (dir) => (existsSync(join(dir, 'invite-code')) ? readFileSync(join(dir, 'invite-code'), 'utf8').trim().replace(/"/g, '') : null);

// THE FOUNDING LOOP, as 20b: every seat ticks each block; once a DKG started, up to PACE_S seconds per block before the next
async function runFounding(seats, label, limit = 30) {
  let last = null;
  for (let n = 0; n < limit; n++) {
    const tip = height();
    for (const x of seats) { try { await x.seat.tick(); } catch (e) { out({ step: 'step failed', seat: x.name, tip, why: String(e.message).slice(0, 300) }); } }
    const st = seats[0].seat.state();
    last = st;
    if (!st) { out({ step: `${label}: no founding`, tip, why: (await seats[0].seat.tick()).why }); mine(1); continue; }
    out({ step: `${label}: window`, tip, seated: st.seated.map((x) => `${nameOf(x.node)}${x.code ? '+' : '-'}@${x.since}`), noShows: st.noShows.map(nameOf),
      started: seats.filter((x) => (x.seat.state() || {}).started).map((x) => x.name), federation: st.federation, void: st.void, why: st.failed });
    if (st.federation || st.void) break;
    if (seats.some((x) => (x.seat.state() || {}).started)) {
      for (let w = 0; w < PACE_S / 2; w++) {
        await sleep(2000);
        for (const x of seats) { try { await x.seat.tick(); } catch { /* the next */ } }
        if (seats.some((x) => (x.seat.state() || {}).federation)) break;
      }
      const now = seats.find((x) => (x.seat.state() || {}).federation);
      if (now) { last = now.seat.state(); out({ step: `${label}: window`, tip: height(), federation: true, note: `${now.name}'s guardian is in consensus` }); break; }
    }
    mine(1);
  }
  return last;
}
const makeSeat = ({ i, records, notices, entriesAt, own, next, seats, say }) => createFoundingSeat({ records, notices, entriesAt,
  beaconAt: async (h) => (h <= height() ? Uint8Array.from(Buffer.from(cli('getblockhash', String(h)), 'hex').reverse()) : null), tip: async () => height(),
  guardianInSetup: async () => (own ? own.inSetup() : false), setup: own, next,
  nominal: 4, bondMinGuardian: 500000n, clocks, ownKey: keys[i].pub, sign: (h) => schnorr.sign(h, keys[i].secret), verify,
  post: async (m) => { for (const x of seats) x.seat.take(m); }, say,
  peers: () => seats.filter((x) => x.i !== i).map((x) => `s${x.i}`), fetchJson: async (u) => seats.find((x) => x.i === Number(u.slice(1).split('/')[0])).seat.state() });
const entry = (i, advert) => ({ pubkey: keys[i].pub, txid: taggedHash('ARENA/v1/Rehearsal26/bond', Uint8Array.of(i)), vout: 0, bondSats: 1000000n, advert });

// ---- 1. FIVE NODES, NO CEREMONY FILES, ARENA_FOUNDING=1: SETUP-MODE GUARDIANS ----
for (let i = 0; i < 5; i++) await start(i);
for (let i = 0; i < 5; i++) {
  const g = nodes[i].guardians.own;
  const st = await untilAnswer(`setup status ${NAMES[i]}`, () => statusOf(g), (v) => /^Awaiting|^Sharing/.test(v));
  out({ step: 'setup-mode guardian', node: NAMES[i], port: PORTS[i], pid: g.pid, api: g.apiPort, setupMode: g.setup, setupStatus: st,
    guardian: JSON.parse((await getJson(`http://127.0.0.1:${PORTS[i]}/guardian`)).body), holdsKey: holdsGuardianKey(store(i)), s: s() });
}

// ---- 2. GENESIS: n1..n4 in the census, drawn, the DKG on their setup-mode guardians: the OLD federation ----
const genesisEntries = [0, 1, 2, 3].map((i) => entry(i, { operatorId: OPS[i], guardianCapable: true, guardianEndpoint: `ws://127.0.0.1:${PORTS[i]}/guardian` }));
const gSeats = [];
for (const i of [0, 1, 2, 3]) gSeats.push({ i, name: NAMES[i], seat: makeSeat({ i, records: () => [], entriesAt: async () => genesisEntries, own: setupOf(nodes[i].guardians.own, NAMES[i]), seats: gSeats }) });
const genesis = await runFounding(gSeats, 'genesis');
out({ step: 'genesis draw', trigger: gSeats[0].seat.state().trigger.kind, height: gSeats[0].seat.state().trigger.height, seated: genesis.seated.map((x) => nameOf(x.node)), federation: genesis.federation, s: s() });
for (let t = 0; t < 60 && ![0, 1, 2, 3].every((i) => inviteIn(nodes[i].guardians.own.dataDir)); t++) await sleep(3000);
const OLD_INVITE = inviteIn(nodes[0].guardians.own.dataDir);
const FED1 = readInvite(OLD_INVITE).federationId;
for (const i of [0, 1, 2, 3]) {
  const g = nodes[i].guardians.own;
  out({ step: 'old federation', node: NAMES[i], session: await untilAnswer(`old session ${NAMES[i]}`, () => session(`ws://127.0.0.1:${PORTS[i]}/guardian`), (v) => typeof v === 'number'),
    via: `ws://127.0.0.1:${PORTS[i]}/guardian`, setupStatus: await statusOf(g), keys: keysIn(g.dataDir), holdsKey: holdsGuardianKey(store(i)), samePid: g.pid, federation: FED1.slice(0, 16) });
}

// ---- 3. n1..n3 RESTART WITH ARENA_FOUNDING_NEXT=1: their guardian (keyed) AND a guardian-next in setup mode ----
for (const i of [0, 1, 2]) {
  await nodes[i].close();
  const n = await start(i, { ARENA_FOUNDING_NEXT: '1' });
  const own = n.guardians.own, next = n.guardians.next;
  const ns = await untilAnswer(`next status ${NAMES[i]}`, () => statusOf(next), (v) => /^Awaiting/.test(v));
  const os = await untilAnswer(`own status ${NAMES[i]}`, () => statusOf(own), (v) => v === 'ConsensusIsRunning');
  out({ step: 'two fedimintd', node: NAMES[i], own: { pid: own.pid, api: own.apiPort, setupMode: own.setup, status: os, dir: own.dataDir.slice(P.length + 1) },
    next: { pid: next.pid, api: next.apiPort, setupMode: next.setup, status: ns, dir: next.dataDir.slice(P.length + 1) },
    guardian: JSON.parse((await getJson(`http://127.0.0.1:${PORTS[i]}/guardian`)).body), s: s() });
}
for (const i of [0, 1, 2, 3])
  out({ step: 'old federation after the restarts', node: NAMES[i], session: await untilAnswer(`old session ${NAMES[i]}`, () => session(`ws://127.0.0.1:${PORTS[i]}/guardian`), (v) => typeof v === 'number') });

// ---- 4. THE RECORD AND THE CENSUS: the old federation OPEN (its four guardians' real peer keys), G OPEN (the decoy's), n5 joined ----
const G = taggedHash('ARENA/v1/Rehearsal26/G', Uint8Array.of(1));
const peerKeyOf = (i) => { const c = guardianConfigOf(nodes[i].guardians.own.dataDir, (f) => readFileSync(f, 'utf8')); return c.peerKeyOf(c.ownPeerId); };
const PEER = [0, 1, 2, 3].map(peerKeyOf);
const H_REC = height();
const recOld = buildFederationRecord({ federationId: fromHex(FED1), networkId: new Uint8Array(32), invite: OLD_INVITE, nominal: 4, height: H_REC,
  guardians: [0, 1, 2, 3].map((i) => ({ peerKey: PEER[i], nodePubkey: keys[i].pub, operatorId: OPS[i], bondTxid: taggedHash('ARENA/v1/Rehearsal26/bond', Uint8Array.of(i)), bondVout: 0,
    endpoint: `ws://127.0.0.1:${PORTS[i]}/guardian`, bondSats: 1000000n })) });
const held = [{ federation: FED1, status: 'OPEN', height: H_REC, record: recOld }, { federation: toHex(G), status: 'OPEN', height: H_REC }];
const census = [...[0, 1, 2, 3].map((i) => entry(i, { operatorId: OPS[i], guardianCapable: true, guardianEndpoint: `ws://127.0.0.1:${PORTS[i]}/guardian`, guardianOf: [{ federationId: fromHex(FED1), guardianKey: PEER[i] }] })),
  entry(4, { operatorId: 'node15', guardianCapable: true, guardianEndpoint: `ws://127.0.0.1:${PORTS[4]}/guardian`, guardianOf: [] }),
  entry(5, { operatorId: 'decoy', guardianCapable: true, guardianEndpoint: 'ws://127.0.0.1:20160/guardian', guardianOf: [{ federationId: G, guardianKey: Uint8Array.from([2, ...G]) }] })];
out({ step: 'record and census', federation: FED1.slice(0, 16), status: Object.keys({ OPEN: 1, DRAINING: 2, CRITICAL: 3 })[recOld.status - 1], seated: recOld.seated, height: H_REC,
  recordOrder: recOld.guardians.map((g) => nameOf(toHex(g.nodePubkey))), census: census.map((e) => ({ node: nameOf(toHex(e.pubkey)), operator: e.advert.operatorId, guards: e.advert.guardianOf.map((g) => (toHex(g.federationId) === FED1 ? 'old' : 'G')) })), G: toHex(G).slice(0, 16) });

// ---- 5. n4 POSTS A DEPARTURE NOTICE AT EVERY NODE; THE SEATS READ IT OFF GET /absences ----
const POSTED = height();
const notice = signDeparture({ federationId: fromHex(FED1), peerKey: PEER[3], leaveAfterHeight: POSTED + clocks.departureNotice, postedAt: POSTED, nodePubkey: keys[3].pub },
  (h) => schnorr.sign(h, keys[3].secret));
const posted = [];
for (let i = 0; i < 5; i++) posted.push((await getJson(`http://127.0.0.1:${PORTS[i]}/departure`, { method: 'POST', body: departureHex(notice) })).status);
const held0 = JSON.parse((await getJson(`http://127.0.0.1:${PORTS[0]}/absences`)).body);
out({ step: 'departure notice', by: 'n4', postedAt: POSTED, leaveAfter: POSTED + clocks.departureNotice, departureNotice: clocks.departureNotice, posted, heldAtN1: held0.departures.length });

// ---- 6. THE SUCCESSOR: the seats of n1..n5, each reading its own node's notices and running its own guardians ----
const nSeats = [];
const said = [];
for (const i of [0, 1, 2, 3, 4]) {
  const n = nodes[i];
  const own = setupOf(n.guardians.own, `${NAMES[i]}-s`);
  const next = n.guardians.next ? (() => { const x = setupOf(n.guardians.next, `${NAMES[i]}-s`); return { setup: x, inSetup: () => x.inSetup() }; })() : null;
  nSeats.push({ i, name: NAMES[i], seat: makeSeat({ i, records: () => held, own, next, seats: nSeats,
    notices: async () => JSON.parse((await getJson(`http://127.0.0.1:${PORTS[i]}/absences`)).body).departures.map(readDepartureHex),
    entriesAt: async (h) => (h >= H_REC ? census : genesisEntries), say: (o) => { if (o.trigger) said.push({ seat: NAMES[i], ...o }); } }) });
}
const first = await nSeats[0].seat.tick();
out({ step: 'trigger read', at: height(), ok: first.ok, why: first.why });
const succ = await runFounding(nSeats, 'successor');
const st0 = nSeats[0].seat.state();
out({ step: 'trigger', kind: st0.trigger.kind, notice: st0.trigger.notice, height: st0.trigger.height, federation: String(st0.trigger.federation).slice(0, 16), why: st0.trigger.why });
out({ step: 'successor draw', beacon: st0.beacon, windowEnd: st0.windowEnd, fifth: st0.fifth, seatedFirst: st0.seatedFirst, eligible: st0.eligible,
  seated: succ.seated.map((x) => nameOf(x.node)), alternates: st0.alternates.map(nameOf), leftOut: (said.find((x) => x.seat === 'n1') || {}).leftOut,
  via: Object.fromEntries(nSeats.map((x) => [x.name, x.seat.state().via])), federation: succ.federation, void: succ.void, why: succ.failed });
// the successor's guardians: n1..n3's guardian-next, n5's own
const succDir = (i) => (i < 3 ? nodes[i].guardians.next.dataDir : nodes[i].guardians.own.dataDir);
const succPath = (i) => (i < 3 ? '/guardian-next' : '/guardian');
const seatedIx = succ.seated.map((x) => NAMES.indexOf(nameOf(x.node)));
for (let t = 0; t < 60 && !seatedIx.every((i) => inviteIn(succDir(i))); t++) await sleep(3000);
const rows = [];
for (const i of seatedIx) {
  const inv = inviteIn(succDir(i));
  rows.push({ node: NAMES[i], via: `ws://127.0.0.1:${PORTS[i]}${succPath(i)}`, session: await untilAnswer(`successor session ${NAMES[i]}`, () => session(`ws://127.0.0.1:${PORTS[i]}${succPath(i)}`), (v) => typeof v === 'number', 30),
    federation: inv ? readInvite(inv).federationId.slice(0, 16) : null, keys: keysIn(succDir(i)), files: i < 3 ? holdsGuardianKey(store(i), '.guardian-next') : holdsGuardianKey(store(i)) });
}
const FED2 = rows[0].federation;
out({ step: 'successor federation', guardians: rows, oneFederation: rows.every((r) => r.federation && r.federation === FED2), distinctFromOld: FED2 !== FED1.slice(0, 16), s: s() });
const oldRows = [];
for (const i of [0, 1, 2, 3]) oldRows.push({ node: NAMES[i], session: await session(`ws://127.0.0.1:${PORTS[i]}/guardian`) });
out({ step: 'old federation still answers', federation: FED1.slice(0, 16), guardians: oldRows });
// BOTH FEDERATIONS RUN: sessions finished by every guardian of each (session_count >= SESSIONS), a block every 10 s, SESSIONS_S at most
const want = Number(process.env.SESSIONS || 2);
const tS = Date.now();
let sess = null;
for (let t = 0; t < Number(process.env.SESSIONS_S || 300) / 10; t++) {
  sess = { old: [], successor: [] };
  for (const i of [0, 1, 2, 3]) sess.old.push(await session(`ws://127.0.0.1:${PORTS[i]}/guardian`));
  for (const i of seatedIx) sess.successor.push(await session(`ws://127.0.0.1:${PORTS[i]}${succPath(i)}`));
  if ([...sess.old, ...sess.successor].every((v) => typeof v === 'number' && v >= want)) break;
  mine(1); await sleep(10000);
}
out({ step: 'sessions', want, old: Object.fromEntries([0, 1, 2, 3].map((i, k) => [NAMES[i], sess.old[k]])),
  successor: Object.fromEntries(seatedIx.map((i, k) => [`${NAMES[i]}${succPath(i)}`, sess.successor[k]])), height: height(), waitedS: Math.round((Date.now() - tS) / 1000) });
const pids = nodes.map((n, i) => ({ node: NAMES[i], own: n.guardians.own && n.guardians.own.pid, next: n.guardians.next && n.guardians.next.pid }));
out({ step: 'fedimintd per node', pids });

// ---- STOP: every node closes, and with it its guardians ----
for (const n of nodes) await n.close();
const alive = pids.flatMap((p) => [p.own, p.next]).filter(Boolean).filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
out({ step: 'stopped', fedimintdAlive: alive, s: s() });
process.exit(0);
