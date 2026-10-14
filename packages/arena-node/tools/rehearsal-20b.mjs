#!/usr/bin/env node
// FEDERATION.md REHEARSAL 20b, THE SEAT'S OWN FOUNDING WIRING ON REAL GUARDIANS (§23A.2, kanban #320): as rehearsal 20, but each of the
// six seats runs src/founding-seat.js - the trigger read off its held records (a DRAINING record at the trigger height), the seed the
// block AFTER the trigger, taking part only while its own guardian's admin status names no federation (wsAdminStatus), and every
// setup call through cliSetup (fedimint-cli admin setup on the guardian's socket, with its password). Then as below:
// FEDERATION.md REHEARSAL 20, A FOUNDING BY SORTITION ON REAL GUARDIANS (§23A.2, kanban #320). tools/rehearsal-20-regtest.sh starts
// a private regtest and six fedimintd in setup mode (nodes n0..n5, one guardian-capable operator each); this runs the six seats'
// src/founding.js in one process, each driving its own fedimintd through the stock setup API (fedimint-cli admin setup). Four are
// drawn, two alternates; the drawn node at position SILENT (default 1) never takes part. Blocks are mined as the window runs.
// Asked: the draw; who posted; the no-show replaced after founding_window; the DKG on the four seated; the federation then answers
// (invite code, session_count on every seated guardian). One JSON line per question; it decides nothing. Never testnet4.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { clocksFor } from '../../arena-protocol/src/federation-slash.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { createFoundingSeat, cliSetup } from '../src/founding-seat.js';
import { wsAdminStatus } from '../src/absence-producer.js';
import { wsSessionCount } from '../src/halts.js';

const P = process.env.P, B = process.env.BITCOIN_CLI, ARGS = (process.env.BTC_ARGS || '').split(' ').filter(Boolean);
const F = process.env.FEDIMINT_BIN, FH = process.env.FEDIMINT_HOME, N = Number(process.env.NODES || 6), SILENT = Number(process.env.SILENT ?? 1);
if (!P || !B || !F) throw new Error('P, BITCOIN_CLI, BTC_ARGS, FEDIMINT_BIN, FEDIMINT_HOME');
const out = (o) => console.log(JSON.stringify(o));
const cli = (...a) => execFileSync(B, [...ARGS, ...a], { encoding: 'utf8' }).trim();
const height = () => Number(cli('getblockcount'));
const mine = (n) => cli('generatetoaddress', String(n), cli('getnewaddress'));
const api = (g) => 30121 + g * 10;
const setupCli = (g, ...a) => execFileSync(join(F, 'fedimint-cli'), ['--password', 'probe', 'admin', 'setup', `ws://127.0.0.1:${api(g)}`, ...a],
  { encoding: 'utf8', env: { ...process.env, HOME: FH }, timeout: 120000 }).trim().replace(/^"|"$/g, '');
const { clocks } = clocksFor('regtest');
const keys = Array.from({ length: N }, (_, i) => { const secret = taggedHash('BLWP/v1/Rehearsal20', new TextEncoder().encode(`n${i}`)); return { secret, pub: schnorr.getPublicKey(secret) }; });
const entries = keys.map((k, i) => ({ pubkey: k.pub, txid: taggedHash('BLWP/v1/Rehearsal20/bond', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
  advert: { operatorId: `op${i}`, guardianCapable: true, guardianEndpoint: `ws://127.0.0.1:${api(i)}` } }));
const ix = (hex) => keys.findIndex((k) => toHex(k.pub) === hex);
const verify = (sig, m, k) => { try { return schnorr.verify(sig, m, k); } catch { return false; } };

const trigger = height();
mine(1);                                                                   // the beacon: the block after the trigger
const beaconAt = async (h) => (h <= height() ? Uint8Array.from(Buffer.from(cli('getblockhash', String(h)), 'hex').reverse()) : null);
const seed = await beaconAt(trigger + 1);
const runCli = (args) => execFileSync(join(F, 'fedimint-cli'), args, { encoding: 'utf8', env: { ...process.env, HOME: FH }, timeout: 120000 });
// THE SEAT'S HELD RECORDS: one federation that entered DRAINING at the trigger height - a succession (foundingTrigger)
const records = () => [{ federation: 'ab'.repeat(32), status: 'DRAINING', height: trigger }];
const seats = [];
const setups = Array.from({ length: N }, (_, i) => cliSetup({ run: async (args) => runCli(args), apiPort: api(i), password: 'probe', guardianName: `n${i}` }));
for (let i = 0; i < N; i++) {
  seats.push(createFoundingSeat({ records, entriesAt: async () => entries, beaconAt, tip: async () => height(),
    guardianInSetup: async () => setups[i].inSetup(),
    setup: setups[i],
    nominal: 4, bondMinGuardian: 500000n, clocks, ownKey: keys[i].pub, sign: (h) => schnorr.sign(h, keys[i].secret), verify,
    post: async (m) => { for (const s of seats) s.take(m); }, say: (o) => out({ step: 'seat says', seat: i, ...o }),
    // THE PEERS' GET /founding, as a seat reads it every tick (codes it missed - here a code posted before a peer's founding existed)
    peers: () => seats.map((_, j) => `s${j}`).filter((u) => u !== `s${i}`), fetchJson: async (u) => seats[Number(u.slice(1).split('/')[0])].state() }));
}
// THE DRAW BEFORE ANY SEAT STEPS (the silent one must never post): the same founding, made without a setup, says who is seated
const { createFounding } = await import('../src/founding.js');
const preview = createFounding({ seed, triggerHeight: trigger, entries, nominal: 4, bondMinGuardian: 500000n, foundingWindow: clocks.foundingWindow,
  ownKey: keys[0].pub, sign: () => new Uint8Array(64), verify, setup: null }).state();
const silentFirst = ix(preview.seated[SILENT].node);
for (let i = 0; i < N; i++) if (i !== silentFirst) { const r = await seats[i].tick(); if (!r.ok) out({ step: 'tick refused', seat: i, why: r.why }); }
const draw = seats[silentFirst === 0 ? 1 : 0].state();
out({ step: 'trigger', kind: draw.trigger.kind, height: draw.trigger.height, why: draw.trigger.why });
out({ step: 'draw', trigger, seed: toHex(seed).slice(0, 16), id: draw.id.slice(0, 16), seated: draw.seated.map((x) => ix(x.node)), alternates: draw.alternates.map(ix),
  silent: ix(draw.seated[SILENT].node), foundingWindow: clocks.foundingWindow });
const silent = ix(draw.seated[SILENT].node);
const t0 = Date.now();
for (let n = 0; n < 40; n++) {
  const tip = height();
  for (let i = 0; i < N; i++) if (i !== silent) { try { await seats[i].tick(); } catch (e) { out({ step: 'step failed', seat: i, tip, why: String(e.message).slice(0, 300) }); } }
  const st = seats[(silent + 1) % N].state();
  out({ step: 'window', tip, seated: st.seated.map((x) => `${ix(x.node)}${x.code ? '+' : '-'}`), noShows: st.noShows.map(ix), windowFrom: st.windowFrom,
    started: seats.filter((s) => (s.state() || {}).started).map((s) => ix(seats.indexOf(s) >= 0 ? toHex(keys[seats.indexOf(s)].pub) : '')) });
  if (st.seated.every((x) => (seats[ix(x.node)].state() || {}).started)) break;
  mine(2);
}
const seatedNow = seats[(silent + 1) % N].state().seated.map((x) => ix(x.node));
out({ step: 'dkg started', seated: seatedNow, ms: Date.now() - t0 });
// THE FEDERATION ANSWERS: each seated guardian's invite code and session_count, once its DKG is done
for (let t = 0; t < 60; t++) {
  const done = seatedNow.filter((g) => existsSync(join(P, `g${g}`, 'invite-code')));
  if (done.length === seatedNow.length) break;
  await new Promise((r) => setTimeout(r, 3000));
}
const rows = [];
for (const g of seatedNow) {
  const inv = existsSync(join(P, `g${g}`, 'invite-code')) ? readFileSync(join(P, `g${g}`, 'invite-code'), 'utf8').trim().replace(/"/g, '') : null;
  let session = null; try { session = await wsSessionCount(`ws://127.0.0.1:${api(g)}`, { timeoutMs: 10000, overrides: '' }); } catch (e) { session = `no answer: ${e.message}`.slice(0, 80); }
  // the federation each guardian is in: its client config's broadcast keys, by peer id (the record's guardian keys)
  let peers = null; try { const c = JSON.parse(readFileSync(join(P, `g${g}`, 'client.json'), 'utf8')); peers = JSON.stringify((c.global || c).broadcast_public_keys); } catch { peers = null; }
  rows.push({ guardian: g, invite: inv ? `${inv.slice(0, 12)}…${inv.slice(-8)}` : null, session, peers });
}
const configs = new Set(rows.map((r) => r.peers).filter(Boolean));
const peerCount = rows[0].peers ? Object.keys(JSON.parse(rows[0].peers)).length : 0;
for (const r of rows) r.peers = r.peers ? `${peerCount} keys` : null;
out({ step: 'federation', guardians: rows, oneFederation: configs.size === 1 && rows.every((r) => r.invite && r.peers), peers: peerCount, silentTookPart: existsSync(join(P, `g${silent}`, 'invite-code')), s: Math.round((Date.now() - t0) / 1000) });
