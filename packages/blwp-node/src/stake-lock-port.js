// THE ROUND'S FEDERATION, AS A SEAT ASKS IT (v4.6.2 §23.1 step 5).
//
// Two answers, both the stock Fedimint 0.12.0 client's own, through
// blwp-stake-lock (tools/stake-lock, our code on the stock client crates):
//   status(outpoint)    what the guardians hold there - the contract id and
//                       the blocks LEFT to its expiry - and their block count
//   contractId(fields)  the stock hash of a contract the player handed over
// Nothing here hashes a contract or speaks the federation's API: a second
// implementation of either would be a second place for them to disagree.
//
// It runs the tool once per question, as `lnd-port.js` runs lncli: the
// federation is the tool's business, and a daemon that linked the client
// crates in would be a daemon in Rust.
import { execFile } from 'node:child_process';
import { toHex } from '../../protocol/src/hash.js';

export const STAKE_LOCK_SETTINGS = ['BLWP_STAKE_LOCK_BIN', 'BLWP_FEDERATION_CLIENT_DIR'];

const run = (bin, args, timeoutMs) => new Promise((done, fail) => {
  execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    const line = String(stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    if (err && !line) return fail(new Error(`blwp-stake-lock: ${String(stderr || err.message).trim().split('\n').pop()}`));
    try { done(JSON.parse(line)); } catch { fail(new Error(`blwp-stake-lock answered no JSON: ${String(stdout).slice(0, 200)}`)); }
  });
});

const outpointArg = (o) => `${toHex(o.txid)}:${o.outIdx}`;

/** The tool's arguments for a contract's fields - the same flags its lock mode takes. */
export function contractArgs(f) {
  const image = f.paymentImage.kind === 'point' ? ['--point', toHex(f.paymentImage.bytes)] : ['--hash', toHex(f.paymentImage.bytes)];
  return [...image, '--amount-msat', String(f.amountMsat), '--claim-pk', toHex(f.claimPk),
    '--refund-pk', toHex(f.refundPk), '--expiration', String(f.expiration)];
}

export function stakeLockPort({ bin, dataDir, timeoutMs = 60000 }) {
  return {
    async status(outpoint) {
      const j = await run(bin, ['--mode', 'status', '--data-dir', dataDir, '--outpoint', outpointArg(outpoint)], timeoutMs);
      return {
        blockCount: Number(j.block_count),
        stored: j.stored ? { contractId: String(j.stored.contract_id), blocksLeft: Number(j.stored.blocks_left) } : null,
      };
    },
    async contractId(fields) {
      const j = await run(bin, ['--mode', 'id', ...contractArgs(fields)], timeoutMs);
      return String(j.contract_id);
    },
  };
}

/**
 * THE PORT FROM TWO SETTINGS, ALL OR NONE: the tool, and the data directory of a
 * client that has joined the round's federation (the seat's own, read-only here).
 * @returns {{ ok: true, given: false } | { ok: true, given: true, stakeLocks } | { ok: false, why }}
 */
export function stakeLocksFromEnv(env) {
  const got = STAKE_LOCK_SETTINGS.filter((k) => env[k]);
  if (!got.length) return { ok: true, given: false };
  if (got.length !== STAKE_LOCK_SETTINGS.length)
    return { ok: false, why: `${STAKE_LOCK_SETTINGS.join(' and ')} go together: set both, or neither` };
  return { ok: true, given: true, stakeLocks: stakeLockPort({ bin: env.BLWP_STAKE_LOCK_BIN, dataDir: env.BLWP_FEDERATION_CLIENT_DIR }) };
}
