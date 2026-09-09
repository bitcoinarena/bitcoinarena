// THE PORT THAT REACHES A REAL LIGHTNING NODE.
//
// `custody.js` decides what should happen to a stake and this is the transport
// that makes it happen, injected the same way `sign`, the curve and `chainFor`
// are. Everything the rules say is measured against a fake port with no node
// running; this file exists so that the same rules can be run against
// `lnd v0.21.3-beta` and the answer compared.
//
// FOUR OPERATIONS, AND THEY ARE NOT SYMMETRIC:
//
//   createHeld   `addholdinvoice <hash> --amt_msat` - the hash comes from the
//                player's own Entry Contract, so this node commits money to a
//                preimage it may not have
//   look         `lookupinvoice <hash>` - the only party that knows what
//                actually happened to an invoice is the node holding it
//   settle       `settleinvoice <preimage>` - NOT the hash. Releasing the
//                preimage IS the settlement, which is why 23.4 wants five of
//                seven shares before it can be done
//   cancel       `cancelinvoice <hash>` - the only act that returns money
//
// LND'S STATES ARE NOT 23.2'S, so they are mapped here and nowhere else. An
// OPEN invoice and an ACCEPTED one are both HELD as far as the protocol is
// concerned: money is in flight and in nobody's balance either way, and the
// difference between them is whether the player has paid yet. lnd has no
// EXPIRED for a hold - an invoice that runs out is CANCELED - so the state a
// stake reaches by nobody acting reads back as CANCELLED, and this node's own
// row is the only place the difference is recorded.
//
// SINGLE-NODE CUSTODY, NOT §23.5. One `lncli`, one macaroon, one operator who
// could run every one of these commands by hand. FROST is what closes that.
import { execFile } from 'node:child_process';
import { HELD, SETTLED, CANCELLED } from '../../protocol/src/payout.js';
import { toHex } from '../../protocol/src/hash.js';

/** lnd's invoice states, in 23.2's words. */
export const STATE_OF = {
  OPEN: HELD, ACCEPTED: HELD, SETTLED, CANCELED: CANCELLED, CANCELLED,
};

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
    /**
     * The invoice is read back after it is made, rather than assembled from
     * what was asked for. `addholdinvoice` answers with a payment request and
     * nothing else, and an invoice this node believes in because it asked for
     * it is exactly what `invoiceMatchesEntry` exists to refuse.
     */
    async createHeld({ paymentHash, amountMsat }) {
      const hash = toHex(paymentHash);
      // AN EXPIRY IS NOT OPTIONAL. A VOID round is refunded by nobody acting,
      // and "nobody acting" only ever ends if the invoice runs out - a hold
      // that never expires is one an operator can sit on forever.
      const made = await json(['addholdinvoice', hash, '--amt_msat', String(amountMsat),
        '--expiry', String(expirySeconds)]);
      const back = await json(['lookupinvoice', hash]);
      return {
        paymentHash: Buffer.from(back.r_hash, 'hex'),
        amountMsat: BigInt(back.value_msat),
        request: made.payment_request,
      };
    },

    async look({ paymentHash }) {
      const back = await json(['lookupinvoice', toHex(paymentHash)]);
      const state = STATE_OF[back.state];
      if (!state) throw new Error(`lnd called that invoice ${back.state}, which is not a state a hold can be in`);
      return { state, amountMsat: BigInt(back.value_msat), paidMsat: BigInt(back.amt_paid_msat || 0) };
    },

    async settle({ preimage }) { await call(['settleinvoice', '--preimage', toHex(preimage)]); },

    async cancel({ paymentHash }) { await call(['cancelinvoice', toHex(paymentHash)]); },
  };
}
