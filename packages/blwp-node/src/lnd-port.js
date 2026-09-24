// A READ-ONLY WINDOW ONTO A REAL LIGHTNING NODE: IT DECODES AN INVOICE, AND NOTHING ELSE.
//
// This file used to be the port a signer node's custody drove - issue a hold invoice on the hash an
// entry named, look it up, settle it with a preimage, cancel it - and its own header said what that was:
// "SINGLE-NODE CUSTODY, NOT §23.5. One `lncli`, one macaroon, one operator who could run every one of
// these commands by hand." That custody is the withdrawn Lightning custody, and it does not exist (§23.6, RULED 2026-09-22
// 22:59): the custody field has one value, FEDERATION. Issuing, looking up, settling, cancelling and
// paying are gone with it, and so is the table mapping lnd's invoice states onto 23.2's.
//
// WHAT IS LEFT, AND NEITHER IS CUSTODY:
//
//   decode    `/federation-invoice` must say which hash and amount the federation's LNv2 invoice carries
//             before a player commits to them, read off the invoice rather than the federation's word.
//             `decodepayreq` is local and read-only.
//   invoice   an ORDINARY invoice (`addinvoice`, no hold), which the donation recipients a launcher binds
//             mint to be paid a §22A donation. No stake is in it; money arrives and stays. This was cut with
//             the rest at first and restored: the caller is a tool, not `src/`, and only `src/` was checked.
import { execFile } from 'node:child_process';
import { toHex } from '../../protocol/src/hash.js';

/**
 * @param {object} o
 * @param {string} o.lncli    path to the lncli binary
 * @param {string[]} o.args   the flags that name ONE node: --lnddir, --rpcserver, --network
 * @param {number} o.timeoutMs
 */
export function lndPort({ lncli, args = [], timeoutMs = 60000, expirySeconds = 3600, run = null }) {
  const call = run || ((argv) => new Promise((resolve, reject) => {
    execFile(lncli, [...args, ...argv], { timeout: timeoutMs, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`lncli ${argv[0]} refused: ${(stderr || err.message).trim()}`));
        else resolve(stdout);
      });
  }));
  const json = async (argv) => {
    const out = await call(argv);
    try { return JSON.parse(out); } catch { throw new Error(`lncli ${argv[0]} did not answer JSON: ${out.slice(0, 200)}`); }
  };

  return {
    // AN ORDINARY INVOICE FOR A DONATION RECIPIENT (§22A), described by the LNURL metadata's hash.
    async invoice({ amountMsat, descriptionHash, expirySeconds: expiry = expirySeconds }) {
      const made = await json(['addinvoice', '--amt_msat', String(amountMsat),
        '--description_hash', toHex(descriptionHash), '--expiry', String(expiry)]);
      return { request: made.payment_request, paymentHash: Buffer.from(String(made.r_hash), 'hex') };
    },

    // READ AN INVOICE THIS NODE DID NOT MAKE: a federation round's invoice comes from the federation
    // (invoice first, the owner 2026-09-11), and the node has to say which hash and amount it carries
    // before a player commits to them.
    async decode({ request }) {
      const d = await json(['decodepayreq', String(request)]);
      return { paymentHash: Buffer.from(d.payment_hash, 'hex'), amountMsat: BigInt(d.num_msat || 0) };
    },
  };
}
