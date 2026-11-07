#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A HALT PROVEN ON REAL GUARDIANS, "ANSWERING" = SIGNING (spec §23A.5, RULED 2026-11-07 kanban #1289; kanban #1319).
// tools/rehearsal-1319-regtest.sh founds a federation of four on a private regtest (rehearsal 20's sortition, each fedimintd in
// its own systemd scope) and runs this:
//
//   1. running      five census seats (src/halts.js) ask every guardian's session_count, through a TCP relay each (the seats'
//                   view of the network); the sessions move
//   2. cut          f + 1 = 2 guardians lose P2P (iptables, their scope's packets to any P2P port and every packet to or from
//                   their own P2P port), their API still answering; one of the two others is cut off from the SEATS only (its
//                   relay closed) and stays in P2P consensus. The federation halts.
//   3. halt         abandon_blocks mined: every seat signs its observation and takes the others'; every guardian's node signs its
//                   own view from its admin status (createGuardianHaltSigner, its P2P connections); seat 0 takes them
//   4. proof        seat 0's halt proof (signing) beside the reading of the old rule (reachability, the seats' `answering`)
//   5. stub         the same, one cut guardian signing nothing (a stub that answers session_count)
//
// One JSON line per question; it decides nothing. Never testnet4. Needs sudo for iptables (chain R1319, removed at the end).
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { REGTEST_CLOCKS } from '../../arena-protocol/src/federation-slash.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeHaltObservation, encodeGuardianHaltObservation } from '../../arena-protocol/src/halt-proof.js';
import { createHalts, createGuardianHaltSigner, wsSessionCount } from '../src/halts.js';
import { wsAdminStatus, guardianConfigOf } from '../src/absence-producer.js';

const P = process.env.P, B = process.env.BITCOIN_CLI, ARGS = (process.env.BTC_ARGS || '').split(' ').filter(Boolean);
if (!P || !B) throw new Error('P=<the run dir> BITCOIN_CLI=<bitcoin-cli> BTC_ARGS=<its -datadir/-rpc args>');
const cli = (...a) => execFileSync(B, [...ARGS, ...a], { encoding: 'utf8' }).trim();
const out = (o) => console.log(JSON.stringify(o));
const mine = (n) => cli('generatetoaddress', String(n), cli('getnewaddress'));
const tip = () => Number(cli('getblockcount'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const verify = (sig, msg, pub) => { try { return schnorr.verify(sig, msg, pub); } catch { return false; } };
const key = (s) => { const secret = taggedHash('REHEARSAL/1319', new TextEncoder().encode(s)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const p2p = (g) => 30120 + g * 10, api = (g) => 30121 + g * 10;
const clocks = REGTEST_CLOCKS;

// 1. THE FEDERATION: the four seated guardians (their data dirs hold the client config after the DKG)
const gs = [0, 1, 2, 3, 4, 5].filter((g) => existsSync(join(P, `g${g}`, 'client.json')));
if (gs.length !== 4) throw new Error(`${gs.length} guardians founded, four expected`);
const cfg = Object.fromEntries(gs.map((g) => [g, guardianConfigOf(join(P, `g${g}`), (f) => readFileSync(f, 'utf8'))]));
const client = readFileSync(join(P, `g${gs[0]}`, 'client.json'));
// the federation's id as this rehearsal names it in its record (the same 32 bytes for every seat and signer)
const federationId = Uint8Array.from(createHash('sha256').update(client).digest());
const fid = toHex(federationId);
const gnode = Object.fromEntries(gs.map((g) => [g, key(`guardian node ${g}`)]));
const peerKey = (g) => cfg[g].peerKeyOf(cfg[g].ownPeerId);
const nameOf = (k) => { const h = toHex(k); const g = gs.find((x) => toHex(peerKey(x)) === h); return g === undefined ? h.slice(0, 8) : `g${g}`; };

// THE SEATS' VIEW OF THE NETWORK: one relay per guardian API, closable
const relays = {};
for (const g of gs) {
  const conns = new Set();
  const srv = net.createServer((c) => { if (relays[g].closed) return c.destroy(); const u = net.connect(api(g), '127.0.0.1'); conns.add(c); conns.add(u);
    c.pipe(u); u.pipe(c); const end = () => { c.destroy(); u.destroy(); }; c.on('error', end); u.on('error', end); c.on('close', end); u.on('close', end); });
  await new Promise((r) => srv.listen(31900 + g, '127.0.0.1', r));
  relays[g] = { srv, conns, closed: false, close() { this.closed = true; for (const c of conns) c.destroy(); } };
}
const record = { federationId, guardians: gs.map((g) => ({ peerKey: peerKey(g), nodePubkey: gnode[g].pub, endpoint: `ws://127.0.0.1:${31900 + g}` })) };
const records = { list: () => [{ federation: fid }], recordOf: (f) => (f === fid ? { record, status: 'CRITICAL', height: 1 } : null) };
const seatKeys = [0, 1, 2, 3, 4].map((i) => key(`seat ${i}`));
const posted = [];
const seats = seatKeys.map((s) => createHalts({ records, censusSeats: () => seatKeys.map((x) => x.pub), clocks, verify, sign: (h) => schnorr.sign(h, s.secret),
  ownKey: s.pub, height: async () => tip(), ask: (ep) => wsSessionCount(ep, { overrides: '', timeoutMs: 5000 }), post: async (o) => { posted.push(o); } }));
const sessions = async () => Object.fromEntries(await Promise.all(gs.map(async (g) => {
  try { return [`g${g}`, await wsSessionCount(`ws://127.0.0.1:${api(g)}`, { overrides: '', timeoutMs: 5000 })]; } catch (e) { return [`g${g}`, `no answer: ${e.message}`.slice(0, 40)]; } })));

out({ step: 'federation', guardians: gs.map((g) => `g${g}`), peerIds: Object.fromEntries(gs.map((g) => [`g${g}`, cfg[g].ownPeerId])), federation: fid.slice(0, 16),
  abandonBlocks: clocks.abandonBlocks, height: tip() });
// consensus runs: wait until every guardian's session moved past 0 (a fresh federation closes its first session after a while)
const s0 = await sessions(); let s1 = s0;
for (let i = 0; i < 36 && !gs.every((g) => Number.isInteger(s1[`g${g}`]) && s1[`g${g}`] >= 2); i++) { await sleep(5000); s1 = await sessions(); }
out({ step: 'running', sessions: s0, later: s1 });

// 2. THE CUT: two guardians out of P2P (their API untouched), one other out of the seats' reach only
const [x, y, cut1, cut2] = gs;
const ipt = (...a) => execFileSync('sudo', ['-n', 'iptables', ...a], { encoding: 'utf8' });
try { ipt('-N', 'R1319'); } catch { ipt('-F', 'R1319'); }
for (const ch of ['INPUT', 'OUTPUT']) { try { ipt('-D', ch, '-j', 'R1319'); } catch { /* not there */ } ipt('-I', ch, '-j', 'R1319'); }
const allP2p = gs.map(p2p).join(',');
for (const g of [cut1, cut2]) {
  ipt('-A', 'R1319', '-m', 'cgroup', '--path', `user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/app.slice/r1319-g${g}.scope`,
    '-p', 'tcp', '-m', 'multiport', '--dports', allP2p, '-j', 'REJECT', '--reject-with', 'tcp-reset');
  ipt('-A', 'R1319', '-p', 'tcp', '--sport', String(p2p(g)), '-j', 'REJECT', '--reject-with', 'tcp-reset');
  ipt('-A', 'R1319', '-p', 'tcp', '--dport', String(p2p(g)), '-j', 'REJECT', '--reject-with', 'tcp-reset');
}
relays[x].close();
// connections already open carry no packet while idle: closed now, so each must be dialed again through the rules
for (const g of [cut1, cut2]) { try { execFileSync('sudo', ['-n', 'ss', '-K', `( sport = :${p2p(g)} or dport = :${p2p(g)} )`]); } catch { /* none */ } }
const cgroupOf = (g) => { try { const pid = execFileSync('ss', ['-ltnpH', `sport = :${p2p(g)}`], { encoding: 'utf8' }).match(/pid=(\d+)/)[1];
  return readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim(); } catch (e) { return `unread: ${e.message}`.slice(0, 60); } };
out({ step: 'cut', p2pCut: [`g${cut1}`, `g${cut2}`], seatsCannotReach: `g${x}`, rules: ipt('-S', 'R1319').trim().split('\n').length - 1,
  cgroups: Object.fromEntries([cut1, cut2].map((g) => [`g${g}`, cgroupOf(g)])) });
// until the guardians themselves see the cut: g-x's admin status names the two cut peers disconnected
const connectedOf = async (g) => { const st = await wsAdminStatus(api(g), 'probe'); return Object.entries(st.federation.status_by_peer).filter(([, v]) => v.connection_status === 'connected').map(([id]) => `g${gs.find((h) => cfg[h].ownPeerId === Number(id))}`); };
let view = null;
for (let i = 0; i < 36; i++) { view = await connectedOf(x); if (!view.includes(`g${cut1}`) && !view.includes(`g${cut2}`)) break; await sleep(5000); }
out({ step: 'p2p as the guardians see it', [`g${x}`]: view, [`g${cut1}`]: await connectedOf(cut1).catch((e) => e.message), [`g${cut2}`]: await connectedOf(cut2).catch((e) => e.message) });
let last = null, still = 0;
for (let i = 0; i < 40 && still < 3; i++) { await sleep(10000); const s = JSON.stringify(await sessions()); still = s === last ? still + 1 : 0; last = s; }
out({ step: 'halted', sessions: JSON.parse(last), stillFor: `${still * 10} s` });

// 3. abandon_blocks without a session: the seats observe, the guardians' nodes sign their own views
const signers = Object.fromEntries(gs.map((g) => [g, createGuardianHaltSigner({ federationId: fid, ...cfg[g], abandonBlocks: clocks.abandonBlocks,
  status: () => wsAdminStatus(api(g), 'probe'), height: async () => tip(), sign: (h) => schnorr.sign(h, gnode[g].secret) })]));
mine(1);
for (const s of seats) await s.observe();
for (const g of gs) await signers[g].pass();
mine(clocks.abandonBlocks);
const rows = [];
for (const s of seats) rows.push((await s.observe())[0]);
out({ step: 'seats observe', rows: rows.map((r) => ({ session: r.session, firstHeight: r.firstHeight, height: r.height, answering: r.answering, signed: !!r.signed })) });
for (const o of posted) seats[0].take(o);
const views = {};
for (const g of gs) {
  const r = await signers[g].pass();
  views[g] = r;
  out({ step: 'guardian view', guardian: `g${g}`, session: r.session, firstHeight: r.firstHeight, height: r.height, ok: r.ok, why: r.why,
    seen: r.signed ? r.signed.peersSeen.map(nameOf) : null });
}
const asJson = (o) => ({ observation: toHex(encodeGuardianHaltObservation(o)), signature: toHex(o.signature) });

// 4. THE PROOF (signing) and what the old rule (reachability) would have said
const takeAll = (seat, which) => { for (const g of which) if (views[g].signed) seat.takeGuardian(asJson(views[g].signed)); };
takeAll(seats[0], gs);
const p = seats[0].proofOf(fid);
const held = seats[0].list(fid).length;
out({ step: 'proof', ok: !!p, session: p && p.session, haltHeight: p && p.haltHeight, observers: p && p.observers, seatObservationsHeld: held,
  signers: p && p.signers, largestSubset: p && p.largestSubset, spared: p && p.answered.map(nameOf), slashed: p && p.abandoned.map(nameOf),
  expected: { spared: [`g${x}`, `g${y}`].sort(), slashed: [`g${cut1}`, `g${cut2}`].sort() } });
// the old rule's reading (before #1289) from the same signed seat observations: spared = reached by a majority of the observing seats
const seatViews = [...new Map(posted.map((o) => { const d = decodeHaltObservation(fromHex(o.observation)); return [toHex(d.observer), d]; })).values()].filter((d) => d.height === rows[0].height);
const reachedBy = (g) => seatViews.filter((d) => d.answering.some((k) => toHex(k) === toHex(peerKey(g)))).length;
const majority = Math.floor(seatViews.length / 2) + 1;
out({ step: 'old rule', seatObservations: seatViews.length, reachedBy: Object.fromEntries(gs.map((g) => [`g${g}`, reachedBy(g)])),
  wouldSpare: gs.filter((g) => reachedBy(g) >= majority).map((g) => `g${g}`), wouldSlash: gs.filter((g) => reachedBy(g) < majority).map((g) => `g${g}`) });

// 5. A STUB: one cut guardian's node signs nothing (it answers session_count all the same)
const stub = createHalts({ records, censusSeats: () => seatKeys.map((k) => k.pub), clocks, verify, sign: (h) => schnorr.sign(h, seatKeys[0].secret),
  ownKey: seatKeys[0].pub, height: async () => tip(), ask: (ep) => wsSessionCount(ep, { overrides: '', timeoutMs: 5000 }) });
for (const o of posted) stub.take(o);
takeAll(stub, gs.filter((g) => g !== cut1));
await stub.observe();
const ps = stub.proofOf(fid);
out({ step: 'stub', stub: `g${cut1}`, ok: !!ps, signers: ps && ps.signers, spared: ps && ps.answered.map(nameOf), slashed: ps && ps.abandoned.map(nameOf) });

// cleanup
for (const ch of ['INPUT', 'OUTPUT']) { try { ipt('-D', ch, '-j', 'R1319'); } catch { /* gone */ } }
try { ipt('-F', 'R1319'); ipt('-X', 'R1319'); } catch { /* gone */ }
for (const g of gs) { relays[g].close(); relays[g].srv.close(); }
out({ step: 'cleanup', iptablesChainLeft: (() => { try { ipt('-S', 'R1319'); return true; } catch { return false; } })() });
process.exit(0);
