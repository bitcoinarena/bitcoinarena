// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GATEWAY SHOWS ITS E-CASH FOR AN EPOCH (spec §23A.3a, kanban #998): gateway-cli ecash send, a lock in a client of the federation, the seated guardians'
// signed reads, the wait to expiry, the refund, gateway-cli ecash receive. Run it before the epoch's read window; it waits, and moves nothing if the
// window has passed. Stopped anywhere, the same command carries on from the journal. The proof lands beside the claim file, where the seat serves it.
//
//   node tools/gateway-held-proof.mjs --seat <this node's seat url> --federation <hex> --key <node key file> --amount-sat <sat> --claim-file <file>
//       --journal <file> --lock-bin <arena-stake-lock> --client-dir <dir> [--invite <code>]
//       --gateway-cli <path> --gateway-addr <url> --gateway-password <file> [--expiry-delta 8] [--poll-s 30]
import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { runHeldProof, HELD_EXPIRY_DELTA } from '../src/held-proof-run.js';
import { heldLockFileOf } from '../src/held-read.js';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const need = (k) => { const v = arg(k); if (!v) { console.error(`--${k} is required`); process.exit(2); } return v; };
const seat = need('seat').replace(/\/+$/, ''), federationId = need('federation').toLowerCase(), claimFile = need('claim-file'), journalFile = need('journal');
const lockBin = need('lock-bin'), dir = need('client-dir'), gwBin = need('gateway-cli');
const amountMsat = BigInt(need('amount-sat')) * 1000n;
const secret = Uint8Array.from(Buffer.from(readFileSync(need('key'), 'utf8').trim(), 'hex'));
const secretHex = Buffer.from(secret).toString('hex'), node = Buffer.from(schnorr.getPublicKey(secret)).toString('hex');
const gwArgs = ['--address', need('gateway-addr'), '--rpcpassword', readFileSync(need('gateway-password'), 'utf8').trim()];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };

const run = (bin, args, timeout = 120000) => new Promise((ok, no) => execFile(bin, args, { encoding: 'utf8', timeout, maxBuffer: 1 << 23 }, (e, out, err) => {
  if (e) return no(new Error(String(err || e.message).trim().split('\n').pop().slice(0, 300)));
  ok(String(out).trim());
}));
const jsonOf = (out) => { try { return JSON.parse(out); } catch { return JSON.parse(out.split('\n').filter((l) => l.startsWith('{')).pop()); } };
const tool = async (mode, flags = []) => jsonOf(await run(lockBin, ['--mode', mode, '--data-dir', dir, ...flags]));
const gateway = async (...a) => jsonOf(await run(gwBin, [...gwArgs, ...a]));
const contractFlags = (f) => ['--amount-msat', String(f.amountMsat), '--hash', f.hash, '--claim-pk', f.claimPk, '--refund-pk', f.refundPk];

const gatewayd = {
  sendEcash: async (msat) => { const j = await gateway('ecash', 'send', '--federation-id', federationId, `${msat} msat`); if (!j.notes) throw new Error('gatewayd gave no notes'); return j.notes; },
  receiveEcash: async (notes) => gateway('ecash', 'receive', '--notes', notes),
};
const client = {
  receive: (notes) => tool('ecash-receive', ['--ecash', notes]),
  lock: async (f) => { const j = await tool('lock', [...contractFlags(f), '--expiry-delta', String(f.expiryDelta)]);
    if (!j.ids_match) throw new Error('the guardians stored another contract than this one');
    return { outpoint: `${j.txid}:${j.out_idx}`, expiration: Number(j.computed_expiration), contractId: j.computed_contract_id }; },
  blockCount: async () => { const j = await tool('status', ['--outpoint', `${'0'.repeat(64)}:0`]); return Number(j.block_count); },
  refund: async (f) => { const j = await tool('redeem', [...contractFlags(f), '--outpoint', f.outpoint, '--expiration', String(f.expiration), '--witness', 'refund', '--signer-secret', secretHex]);
    return { accepted: j.accepted === true, alreadySpent: j.stored_before === null, error: j.error }; },
  balance: async () => (await tool('balance')).msat,
  // the tool's serve mode holds the client open with its state machines running, which a one-shot run does not
  settle: () => new Promise((ok) => { const c = spawn(lockBin, ['--mode', 'serve', '--data-dir', dir], { stdio: ['pipe', 'ignore', 'ignore'] }); c.on('error', () => ok()); c.on('close', () => ok()); setTimeout(() => c.kill(), 5000); }),
  send: async (msat) => (await tool('ecash-send', ['--amount-msat', String(msat)])).ecash,
};
const seats = {
  info: async () => { const r = await fetch(`${seat}/held-proof?federation=${federationId}`, { signal: AbortSignal.timeout(20000) }); const j = await r.json(); if (!j.ok) throw new Error(j.why); return j; },
  ask: async (url, ask) => { const r = await fetch(`${url}/held-read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ask), signal: AbortSignal.timeout(60000) });
    const j = await r.json(); if (r.status !== 200) throw new Error(j.why || `answered ${r.status}`); return j; },
};
// written whole and only then named, and readable by the owner alone: between steps it holds spendable notes
const atomic = (file, text) => { const t = `${file}.tmp`; writeFileSync(t, text, { mode: 0o600 }); chmodSync(t, 0o600); renameSync(t, file); };
const journal = { load: () => (existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8')) : null), save: (j) => atomic(journalFile, JSON.stringify(j, null, 2)) };

if (!existsSync(join(dir, 'client.db'))) await tool('join', ['--invite', need('invite')]);
const j = await runHeldProof({ journal, gatewayd, client, seats, node, federationId, amountMsat, verify, sign: (h) => schnorr.sign(h, secret),
  saveProof: (p) => atomic(heldLockFileOf(claimFile), JSON.stringify(p, null, 2)), expiryDelta: Number(arg('expiry-delta', HELD_EXPIRY_DELTA)),
  pollMs: Number(arg('poll-s', 30)) * 1000, log: (m) => console.log(`[held-proof] ${m}`) });
console.log(JSON.stringify({ step: j.step, epoch: j.epoch ?? null, reads: j.reads ?? 0, heldSats: j.heldSats ?? '0', refused: j.refused ?? [], why: j.why ?? null }));
