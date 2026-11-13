// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WINNINGS ARE ALWAYS SENT, ON A FEDERATION ROUND (2026-09-21 13:25, "winnings are always sent. There is
// no Collect"; ruled for FEDERATION 2026-09-23).
//
// A qualifier's payout is not a contract the winner must collect. It is an LNv2 outgoing contract that ONE
// gateway may claim only by paying the winner's invoice - fetched from the Lightning address the winner gave
// once - and which, unpaid past its expiration, refunds to the round's committee claim key, never the
// winner's: the signer nodes re-send it through another gateway and the winner never acts.
//
// Every signer node rebuilds the settlement byte for byte, so the invoice, the gateway and the expiration are
// one SEND PLAN the coordinating signer node proposes and every other signer node checks for itself before it
// rebuilds (`sendPlanStands`): the invoice's amount is what that gateway's own fee rule leaves of the payout,
// its description hash is sha256 of the address's LNURL metadata (LUD-06), the gateway is the LOWEST KEY among
// the round's federation's distinct live gateways - the set the door counts - and the expiration is inside that
// gateway's own window over the federation's height. A plan that fails any of these is refused, and no payout
// output is built on it. Nothing here moves money or talks to anyone; it is arithmetic and checks.
import { decodeBolt11 } from './bolt11.js';
import { invoiceAnswersPayRequest } from './lnurl-pay.js';
import { federationGatewayCount } from './gateways.js';
import { toHex } from './hash.js';

const refuse = (why) => ({ ok: false, why });

/**
 * THE INVOICE A PAYOUT OF `payoutMsat` CAN CARRY through a gateway whose send fee is `base + amount*ppm/1e6`:
 * the largest amount a with a + fee(a) <= payoutMsat. The gateway takes its fee out of the contract, so the
 * winner's invoice is the payout less the gateway's own fee on it, and nothing is invented to pad it.
 */
export function sendableInvoiceMsat(payoutMsat, fee) {
  if (typeof payoutMsat !== 'bigint' || payoutMsat <= 0n) return 0n;
  const base = BigInt(fee && fee.baseMsat !== undefined ? fee.baseMsat : 0);
  const ppm = BigInt(fee && fee.ppm !== undefined ? fee.ppm : 0);
  const feeOf = (a) => base + (a * ppm) / 1000000n;
  let a = ((payoutMsat - base) * 1000000n) / (1000000n + ppm);
  if (a < 0n) return 0n;
  while (a > 0n && a + feeOf(a) > payoutMsat) a -= 1n;
  while (a + 1n + feeOf(a + 1n) <= payoutMsat) a += 1n;
  return a;
}

/**
 * THE GATEWAY A WINNINGS CONTRACT NAMES: the lowest Lightning node key among the federation's distinct live
 * gateways (RULED 2026-09-23), as `arena-stake-lock --mode gateways` reports them. Two names on one key are one
 * gateway, a name that does not answer is none - the door's own count. Null when there is none.
 */
// THE GATEWAY'S OWN TERMS, BOUNDED (kanban #2602): its fee and expiration delta come from its own routing_info and it may change them
// any time. Unbounded, the lowest key answering ppm 900,000 kept 47 % of every winning, and a reserve payout's contract grew by it. The
// limits are the stock LNv2 client's (it refuses a gateway over them for its own sends): send fee 100 sat + 15,000 ppm, delta 1440 blocks.
// A gateway over them is not a payout gateway; the next lowest key within them is.
export const GATEWAY_SEND_FEE_LIMIT = Object.freeze({ baseMsat: 100_000n, ppm: 15_000n });
export const GATEWAY_EXPIRATION_DELTA_LIMIT = 1440;
export function gatewayTermsWithinLimits(g) {
  const f = g && g.sendFeeDefault;
  let base = 0n, ppm = 0n;
  try { base = BigInt(f && f.baseMsat !== undefined ? f.baseMsat : 0); ppm = BigInt(f && f.ppm !== undefined ? f.ppm : 0); } catch { return false; }
  if (base < 0n || ppm < 0n || base > GATEWAY_SEND_FEE_LIMIT.baseMsat || ppm > GATEWAY_SEND_FEE_LIMIT.ppm) return false;
  const d = g && g.expirationDeltaDefault;
  if (d !== null && d !== undefined && !(Number.isSafeInteger(Number(d)) && Number(d) >= 0 && Number(d) <= GATEWAY_EXPIRATION_DELTA_LIMIT)) return false;
  return true;
}
export function lowestLiveGateway(listed) {
  listed = (Array.isArray(listed) ? listed : []).filter(gatewayTermsWithinLimits);
  const n = federationGatewayCount(listed);
  if (!n.keys.length) return null;
  const key = [...n.keys].sort()[0];
  const g = listed.find((x) => x && x.live === true && String(x.lightningPublicKey).toLowerCase() === key);
  return g || null;
}

/**
 * DOES A PROPOSED SEND STAND, as a signer node that did not propose it checks it? Everything is this node's own:
 * the payout it rebuilt (`payoutMsat`), the gateways it sees, the federation height it reads, and the LNURL
 * metadata it fetched from the address itself.
 *
 * AND WHO IT PAYS (kanban #1154): the amount and the description hash are public - anyone mints an invoice of their own that has both,
 * and a plan carrying it once redirected a donation share to whoever posted it. So the checker fetches an invoice of its own from the
 * address's callback, for the same amount, and the plan's invoice must be signed by the same node key (`payee`, that invoice's,
 * read by `payeeOf`). A plan whose payee is not checked does not stand.
 *
 * @param plan      { invoice, paymentHash, gatewayUrl, gatewayPk, expiration }
 * @param gateways  this node's `gateways()` list (with sendFeeDefault and the expiration deltas)
 * @param payee     hex node key of the invoice THIS checker fetched from the address for the same amount
 * @param payeeOf   (invoice) => hex node key its signature recovers to (bolt11.js `invoicePayee` with the caller's curve); throws if none
 * @returns {{ ok: true, invoiceMsat: bigint, gateway: object } | { ok: false, why: string }}
 */
export function sendPlanStands({ plan, payoutMsat, gateways, height, metadata, network, payee, payeeOf }) {
  if (!plan || typeof plan.invoice !== 'string') return refuse('the send plan carries no invoice');
  if (typeof payee !== 'string' || !payee || typeof payeeOf !== 'function')
    return refuse('this signer node holds no invoice of its own from that address, so who the plan pays is not checked');
  const gw = lowestLiveGateway(gateways);
  if (!gw) return refuse('this signer node sees no live gateway on the round\'s federation');
  if (String(plan.gatewayUrl) !== String(gw.url))
    return refuse(`the plan names gateway ${plan.gatewayUrl} and the lowest live key this signer node sees is at ${gw.url}`);
  if (!gw.modulePublicKey || String(plan.gatewayPk).toLowerCase() !== String(gw.modulePublicKey).toLowerCase())
    return refuse('the plan\'s gateway key is not that gateway\'s own module key');
  const invoiceMsat = sendableInvoiceMsat(payoutMsat, gw.sendFeeDefault);
  if (invoiceMsat <= 0n) return refuse(`a payout of ${payoutMsat} msat does not cover that gateway's own fee`);
  const said = invoiceAnswersPayRequest({ invoice: plan.invoice, amountMsat: invoiceMsat, metadata, network });
  if (!said.ok) return refuse(`the invoice does not stand: ${said.why}`);
  if (toHex(said.paymentHash) !== String(plan.paymentHash).toLowerCase())
    return refuse('the plan\'s payment hash is not the invoice\'s');
  let signer;
  try { signer = String(payeeOf(plan.invoice)).toLowerCase(); } catch (e) { return refuse(`the plan's invoice names no payee: ${e.message}`); }
  if (signer !== String(payee).toLowerCase())
    return refuse(`the plan's invoice pays node ${signer.slice(0, 16)}, and the address's own callback answers this signer node with invoices of node ${String(payee).toLowerCase().slice(0, 16)}`);
  const min = BigInt(height) + BigInt(gw.expirationDeltaMinimum);
  const max = BigInt(height) + BigInt(gw.expirationDeltaDefault) + 36n;
  const exp = BigInt(plan.expiration);
  if (exp < min || exp > max)
    return refuse(`the plan's expiration ${exp} is outside that gateway's window ${min}..${max} over height ${height}`);
  return { ok: true, invoiceMsat, gateway: gw };
}

/** The expiration a proposer names: the gateway's default window over the federation's height now. */
export const proposedExpiration = (height, gw) => BigInt(height) + BigInt(gw.expirationDeltaDefault);

/** The invoice's own payment hash, hex. */
export const paymentHashOf = (invoice) => toHex(decodeBolt11(invoice).paymentHash);
