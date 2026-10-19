// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// W6 LIVE, THE RESTART (2026-09-15): settle-live-regtest.mjs with W6_KILL=1 was SIGKILLed the
// moment the real guardians (stock fedimintd 0.12.0) answered the signer nodes' signed settlement, before any
// signer node wrote that answer down. This starts both signer nodes again - on their store files, their ports and
// their lock clients' data - and measures what each signer node's row held before and after, and what the
// federation holds: the claimed locks, the payout contracts at (txid, i).
//
//   PROBE=<probe dir> LOCK_BIN=<blwp-stake-lock> node tools/settle-live-w6-resume.mjs
import { readFileSync } from 'node:fs';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { opts, wait } from '../test/window-fixture.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';

const env = process.env;
const P = env.PROBE;
const out = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const curve = { ...feldmanGroup, tweakPoint };
const kill = JSON.parse(readFileSync(`${P}/w6-kill.json`, 'utf8'));
const rid = fromHex(kill.rid);
const ports = [stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client` }), stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client2` })];
const outpoint = (s) => { const [t, i] = String(s).split(':'); return { txid: fromHex(t), outIdx: BigInt(i) }; };
const held = async (o) => !!(await ports[0].status(o)).stored;
const federation = async () => ({
  claimedLocksHeld: await Promise.all(kill.claims.map((c) => held(outpoint(c)))),
  payoutsHeld: await Promise.all(Array.from({ length: kill.payouts }, (_, i) => held({ txid: fromHex(kill.txid), outIdx: BigInt(i) }))),
});
const rowOf = (store) => {
  const r = store.prepare('SELECT state, why, txid FROM lock_settlements WHERE round_id = ?').get(Buffer.from(rid));
  return r ? { state: r.state, txid: String(r.txid).slice(0, 12), why: String(r.why).slice(0, 140) } : null;
};

// 1. WHAT THE KILLED SIGNER NODES LEFT, read from their files before anything starts.
const before = [0, 1].map((i) => { const db = openStore(`${P}/signer node-${i}.sqlite`); try { return rowOf(db); } finally { db.close(); } });
const fedBefore = await federation();
out({ step: 'W6 restart: what the SIGKILL left', killedAfter: { signerNode: kill.signerNode, guardiansAccepted: kill.accepted, error: kill.error, txid: kill.txid.slice(0, 12) },
  rows: before, federation: fedBefore });

// 2. BOTH SIGNER NODES STARTED AGAIN on their stores, ports and lock clients; the signer nodes wired as the driver wires them.
const t = Date.now();
const signerNodes = [];
for (const i of [0, 1])
  signerNodes.push(await serve(openStore(`${P}/signer node-${i}.sqlite`), { plugins: [NEXTBLOCK], port: kill.ports[i], ...opts, stakeLocks: ports[i], poolCurve: curve, finality: { everyMs: 250 } }));
for (const [d, o] of [[signerNodes[0], signerNodes[1]], [signerNodes[1], signerNodes[0]]]) {
  const there = [`http://127.0.0.1:${o.port}`];
  d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there;
}
const rowsNow = () => signerNodes.map((d) => { const r = d.round.lockSettlement(rid); return r ? { state: r.state, txid: r.txid.slice(0, 12), why: r.why.slice(0, 140) } : null; });
for (const stop = Date.now() + 90000; Date.now() < stop; await wait(500))
  if (rowsNow().every((r) => !r || r.state !== 'SUBMITTING')) break;
out({ step: 'W6 restart: after the signer nodes started again', ms: Date.now() - t, rows: rowsNow(), federation: await federation(),
  signerNodesAt: signerNodes.map((d) => toHex(d.round.pubkey).slice(0, 12)) });
for (const d of signerNodes) await d.close();
