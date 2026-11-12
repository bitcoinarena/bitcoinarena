// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WINNINGS ARE ALWAYS SENT, BY THE SIGNER NODES, ON A FEDERATION ROUND (2026-09-21 13:25: "winnings are always
// sent. There is no Collect"; ruled for FEDERATION 2026-09-23 - the refund key is the committee's, the gateway is the
// lowest live key, and an invoice is taken only if its amount and its LUD-06 description hash stand).
//
// The winner names a Lightning address once, signed with the entry's session key (POST /payout-address), and after
// that nothing of the player's runs. When the round settles, the coordinating signer node proposes one SEND PLAN per
// qualifier that named an address - the invoice fetched from that address for what the lowest-key gateway's own fee
// leaves of the payout, that gateway, and an expiration inside its window - and every other signer node checks it
// for itself (protocol/winnings-send.js `sendPlanStands`) before it rebuilds the settlement, which then pays each
// such qualifier by an outgoing contract to the invoice, refunding to the committee claim key. Once the guardians
// accept the settlement, the signer nodes sign the invoice's consensus hash with the claim key - the gateway pays
// only with that signature - and the gateway is asked to pay. The preimage it reveals is checked against the
// invoice's hash and kept on every signer node: one payment row each.
//
// Every message a signer node signs it rebuilds from its own store and its own tool first: no door takes a message.
//
// AND THE DONATION SET'S 25% OF A WALK-AWAY'S LOCK (RULED 2026-09-30, destination 1), sent the same way: one plan
// per recipient of the round's donation set, its invoice fetched from that recipient's LNURL, agreed by the seats,
// kept (donation_sends, under the send id `donationSendId`), signed, asked of the gateway, and re-sent if unpaid. A
// recipient has no key, so it is paid only by the send - there is no contract only its owner could move.
// A RECIPIENT THAT DOES NOT ANSWER (RULED 2026-09-30, hole 1 (a)) is planned HELD - a row with no invoice - and its
// share is settled into a pre-expired contract under the committee claim key; the proposer's sweep retries that same
// recipient, and once it answers, the held contract is spent (the re-send's refund) into the send to its invoice.
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { lightningAddressEndpoint, payRequestStands, callbackFor, invoiceAnswersPayRequest } from '../../arena-protocol/src/lnurl-pay.js';
import { sendableInvoiceMsat, lowestLiveGateway, sendPlanStands, proposedExpiration } from '../../arena-protocol/src/winnings-send.js';
import { signShare340, aggregate340, nonceGenerate340, verifyShare340 } from '../../arena-protocol/src/frost-bip340.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { encodeCommitments, decodeCommitments, decodeShare, commitmentListRefusal } from './pool-wire.js';
import { largestPayoutMsat, lnv2FeeMsat } from '../../arena-protocol/src/lock-settlement.js';
import { urlOfLnurl } from '../../arena-protocol/src/bech32.js';
import { stateOf } from './settlement-state.js';
import { namedClaimKeys } from '../../arena-protocol/src/arena-lock.js';
import { NamedNonces, aggregateBatch, encodeNamedCommitment, decodeNamedCommitment } from './named-settlement.js';
import { askPeers, askWithin, PEER_ASK_MS, PEER_GRACE_MS } from './peer-ask.js';
import { sendHoldOn } from './test-named-offence.js';
import { invoicePayee } from '../../arena-protocol/src/bolt11.js';
import { SEND } from './send-state.js';
import { PLAN_ASK, sendPlanAskHeaders } from './send-plan-ask.js';
import { readJsonBounded } from './lnurl-read.js';

/** WHO AN INVOICE PAYS (kanban #1154): the node key its BOLT11 signature recovers to, hex; throws if none. */
export const payeeOf = (invoice) => invoicePayee(invoice, (sig64, bit, digest) =>
  secp256k1.Signature.fromBytes(sig64, 'compact').addRecoveryBit(bit).recoverPublicKey(digest).toBytes(true));

/** How long an address's LNURL endpoint is waited for, at its pay request and at its callback each (kanban #1074): it is no seat, and fetch alone waits 300 s. */
export const LNURL_ASK_MS = 15000;

/** Where an address's pay request is: a Lightning address (LUD-16), or a donation recipient's LNURL (LUD-01). */
function payRequestUrl(address) {
  if (/^lnurl1/i.test(String(address || ''))) {
    try { return { ok: true, url: urlOfLnurl(String(address).toLowerCase()) }; } catch (e) { return { ok: false, why: `that LNURL does not decode: ${e.message}` }; }
  }
  return lightningAddressEndpoint(address);
}

const refuse = (why, status = 409) => ({ ok: false, status, why });
/**
 * A FAILED FETCH, IN FULL (kanban #1044): fetch says only "fetch failed" - the reason (ECONNREFUSED 127.0.0.1:18777, a reset, a timeout) is in its cause chain.
 * Every message and code down the chain, joined, so a held donation share says why it was held.
 */
export function fetchErrorText(e) {
  const out = [];
  for (let c = e, i = 0; c && i < 5; c = c.cause, i++) {
    const bits = [c.name && c.name !== 'Error' && c.name !== 'TypeError' ? c.name : '', c.message || (typeof c === 'string' ? c : ''), c.code || '',
      c.address ? `${c.address}${c.port ? `:${c.port}` : ''}` : ''].filter(Boolean);
    if (bits.length) out.push(bits.join(' '));
    if (Array.isArray(c.errors)) for (const x of c.errors.slice(0, 3)) out.push(fetchErrorText(x));
  }
  return out.join(' <- ') || String(e);
}
const PAID = SEND.PAID;
/** Where an attempt's contract stands at the federation (kanban #1186, contractFate). */
export const CONTRACT_FATE = Object.freeze({ LIVE: 'LIVE', EXPIRED: 'EXPIRED', GONE: 'GONE', NEVER: 'NEVER' });
const listKey = (commitments) => commitments.map((c) => `${c.id}:${toHex(c.hiding)}:${toHex(c.binding)}`).join('|');
const plain = (row) => ({ entry: toHex(row.entryId), attempt: row.attempt || 0, address: row.address, invoice: row.invoice,
  paymentHash: row.paymentHash, invoiceMsat: String(row.invoiceMsat), payoutMsat: String(row.payoutMsat), owedMsat: String(row.owedMsat),
  gatewayUrl: row.gatewayUrl, gatewayPk: row.gatewayPk, expiration: String(row.expiration) });

export class WinningsSend {
  /**
   * @param round      the signer node's Round (payoutAddress, putSendPlan, sendPlansOf, markSend, putWinnings)
   * @param port       its stake-lock port (gateways, send)
   * @param lnurlFetch how an address's LNURL endpoint is fetched (a test hands its own)
   * @param peersFor   (roundIdBytes) => [base URL] - the round's other settlement signer nodes
   */
  constructor({ round, port, curve, random, peersFor, fetcher, lnurlFetch = fetch, network = 'regtest', scopeParam = '', dkg = null,
    peerAskMs = PEER_ASK_MS, peerGraceMs = PEER_GRACE_MS, lnurlMs = LNURL_ASK_MS }) {
    // `scopeParam`: A LATE SETTLEMENT'S SENDS (slice C3b-2a) - `&late=<entry>` on every signing and paid call to a peer,
    // so the peer answers from that late settlement's rows; empty for the round's own sends.
    // `dkg`: the public shares that name a seat whose share does not stand (kanban #1074); the bounds: how long a seat, and an LNURL endpoint, is waited for
    Object.assign(this, { round, port, curve, random, peersFor, fetcher, lnurlFetch, network, scopeParam, dkg, peerAskMs, peerGraceMs, lnurlMs });
    this.pairs = new Map();      // `${round}:${entry}:${attempt}` -> nonce pair for the auth signature
    this.withheld = new Map();   // a signing's query -> the peers that gave this asker no share for it (kanban #1074)
    this.rebuilt = new Map();    // an unsigned re-send transaction, by everything it is built from
    this.resendSaid = new Map(); // `${round}:${entry}` -> the last reason a re-send's invoice did not stand, as said (kanban #1044)
  }

  /**
   * THE PORT OF THIS ROUND'S FEDERATION (RULED 2026-10-13: "Every node serves every federation"): a
   * router's own port for the round's federation, else the one port this node has, as before.
   */
  async portFor(roundIdBytes) {
    const p = this.port;
    if (!p || typeof p.forFederation !== 'function') return p;
    const row = this.round.get(roundIdBytes);
    if (!row) return p;
    const c = decodeRoundContract(new Uint8Array(row.contract));
    return (await p.forFederation(toHex(c.federationId))) || p;
  }

  /** The address's LUD-06 pay request, as THIS signer node fetches it. Its answer, and the callback's, is read to at most
   *  LNURL_MAX_BYTES (kanban #1562): the address is the player's own server, asked by every seat of the committee at once. */
  async payRequest(address, amountMsat) {
    const ep = payRequestUrl(address);
    if (!ep.ok) return refuse(ep.why);
    let said;
    try { said = await askWithin(async (signal) => readJsonBounded(await this.lnurlFetch(ep.url, { signal })), this.lnurlMs); } catch (e) { return refuse(`${ep.url} did not answer: ${fetchErrorText(e)}`); }
    const pr = payRequestStands(said, amountMsat);
    return pr.ok ? { ok: true, ...pr } : refuse(pr.why);
  }

  /** The invoice for exactly `amountMsat`, checked by amount and LUD-06 description hash. */
  async invoiceFor(address, amountMsat) {
    const pr = await this.payRequest(address, amountMsat);
    if (!pr.ok) return pr;
    let said;
    try { said = await askWithin(async (signal) => readJsonBounded(await this.lnurlFetch(callbackFor({ callback: pr.callback, amountMsat }), { signal })), this.lnurlMs); }
    catch (e) { return refuse(`the address's callback did not answer: ${fetchErrorText(e)}`); }
    const inv = invoiceAnswersPayRequest({ invoice: said && said.pr, amountMsat, metadata: pr.metadata, network: this.network });
    if (!inv.ok) return refuse(inv.why);
    let payee;
    try { payee = payeeOf(said.pr); } catch (e) { return refuse(`the address's own invoice names no payee: ${e.message}`); }
    return { ok: true, invoice: said.pr, paymentHash: toHex(inv.paymentHash), metadata: pr.metadata, payee };
  }

  /**
   * THE COORDINATOR'S PROPOSAL: one plan per qualifier of `base` whose entry named an address. Kept, and returned;
   * a round already planned is not planned again. A bad invoice is a refusal: no payout output is built on it.
   */
  // `hold`: donation addresses planned HELD without asking them - the seats' refusal named them unreachable there.
  async propose(roundIdBytes, base, { hold = new Set() } = {}) {
    this.dropIfStale(roundIdBytes, base);
    const kept = this.round.sendPlansOf(roundIdBytes);
    if (kept.length) return { ok: true, rows: kept };
    const wanting = this.wanting(base);
    if (!wanting.length) return { ok: true, rows: [] };
    const g = await (await this.portFor(roundIdBytes)).gateways();
    const gw = lowestLiveGateway(g.gateways);
    if (!gw) return refuse('the round\'s federation has no live gateway to send the winnings through');
    const rows = [];
    for (const { entryId, payout, address, donation } of wanting) {
      const invoiceMsat = sendableInvoiceMsat(payout.msat, gw.sendFeeDefault);
      if (invoiceMsat <= 0n) return refuse(`a payout of ${payout.msat} msat does not cover the gateway's own fee`);
      const inv = donation && hold.has(address) ? refuse('a seat could not reach it') : await this.invoiceFor(address, invoiceMsat);
      // A DONATION RECIPIENT THAT DOES NOT ANSWER IS HELD, not refused: the walk-away's settlement goes ahead.
      if (!inv.ok && donation) {
        rows.push({ entryId, roundId: roundIdBytes, attempt: 0, address, invoice: '', paymentHash: '', invoiceMsat: 0n, payoutMsat: payout.msat,
          owedMsat: payout.owedMsat, gatewayUrl: '', gatewayPk: '', expiration: 0n, donation: true, heldWhy: inv.why });
        continue;
      }
      if (!inv.ok) return refuse(`the ${donation ? 'donation recipient' : 'winner'}'s invoice does not stand, so no payout is built on it: ${inv.why}`);
      rows.push({ entryId, roundId: roundIdBytes, attempt: 0, address, invoice: inv.invoice, paymentHash: inv.paymentHash, invoiceMsat,
        payoutMsat: payout.msat, owedMsat: payout.owedMsat, gatewayUrl: gw.url, gatewayPk: gw.modulePublicKey,
        expiration: proposedExpiration(g.height, gw), donation: !!donation });
    }
    for (const r of rows) this.round.putSendPlan({ ...r, why: r.heldWhy ? `held: the recipient did not answer (${String(r.heldWhy).slice(0, 400)})` : 'proposed by this signer node' });
    // EVERY HELD SHARE'S REASON, SAID WHOLE (kanban #1044: the row's why is overwritten by HELD, and the sweep's line is cut at 200)
    for (const r of rows) if (r.heldWhy) console.log(`[winnings] ${toHex(roundIdBytes).slice(0, 16)} donation share ${toHex(r.entryId).slice(0, 8)} held, ${r.address.slice(0, 24)}: ${r.heldWhy}`);
    return { ok: true, rows: this.round.sendPlansOf(roundIdBytes) };
  }

  /**
   * A PEER'S CHECK of the coordinator's plans, each against this signer node's own payout, gateways, height and LNURL - and its own invoice
   * from the address, for the same amount, whose node key the plan's invoice must be signed by (kanban #1154). `from`: the hex node key of
   * the seat of the round that signed this plan (server.js checked it), or null when no seat's signature came with it.
   */
  async check(roundIdBytes, base, proposed, { from = null } = {}) {
    // A PLAN ALREADY KEPT IS NOT REPLACED - the same plan again is taken, another is refused by name - with one
    // exception that makes two askers converge: while nothing of the round is settled or sent, a plan whose payment
    // hashes sort LOWER replaces the kept one. Measured on a 5-of-7 under M3.3-19's takeover: two askers each fetched
    // their own invoice, the peers split 4 and 2, and neither plan ever reached the five a signature needs.
    this.dropIfStale(roundIdBytes, base);
    const kept = this.round.sendAttemptsOf(roundIdBytes).filter((x) => x.attempt === 0);
    if (kept.length) {
      const same = kept.length === proposed.length && kept.every((k) => proposed.some((p) => String(p.entry) === toHex(k.entryId)
        && String(p.paymentHash).toLowerCase() === k.paymentHash && Number(p.attempt || 0) === k.attempt));
      if (same) return { ok: true, rows: kept };
      // A LOWER PLAN REPLACES THE KEPT ONE ONLY FROM A SEAT OF THE ROUND (kanban #1154): a planKey anyone can grind is no reason
      // to drop what this seat checked and kept
      if (!(from && planKey(proposed) < planKey(kept) && this.replaceable(roundIdBytes)))
        return refuse(`this signer node keeps another send plan for that round, and does not replace it${from ? '' : ' with a plan no seat of the round signed'}`);
    }
    const wanting = new Map(this.wanting(base).map((w) => [toHex(w.entryId), w]));
    if (proposed.length !== wanting.size)
      return refuse(`the plan names ${proposed.length} winning(s) and this signer node's settlement owes ${wanting.size} to a named address`);
    const g = await (await this.portFor(roundIdBytes)).gateways();
    const rows = [];
    for (const p of proposed) {
      const w = wanting.get(String(p.entry));
      if (!w) return refuse(`the plan names entry ${String(p.entry).slice(0, 16)}, which this signer node does not owe to an address`);
      if (w.address !== p.address) return refuse('the plan names another address than the one this signer node holds for that entry');
      // A HELD DONATION SHARE: no invoice to check - only that it is this signer node's own share of that recipient.
      if (w.donation && !p.invoice) {
        if (String(p.payoutMsat) !== String(w.payout.msat)) return refuse(`a held donation share of ${p.payoutMsat} msat, and this signer node's is ${w.payout.msat}`);
        rows.push({ entryId: w.entryId, roundId: roundIdBytes, attempt: 0, address: w.address, invoice: '', paymentHash: '', invoiceMsat: 0n,
          payoutMsat: w.payout.msat, owedMsat: w.payout.owedMsat, gatewayUrl: '', gatewayPk: '', expiration: 0n, donation: true });
        continue;
      }
      const gw = lowestLiveGateway(g.gateways);
      if (!gw) return refuse('this signer node sees no live gateway on the round\'s federation');
      // THIS SEAT'S OWN INVOICE FROM THE ADDRESS, FOR THE SAME AMOUNT (kanban #1154): its node key is who the address pays, and the
      // plan's invoice must be signed by that key - the description hash and the amount are public, and anyone can mint those
      const pr = await this.invoiceFor(w.address, sendableInvoiceMsat(w.payout.msat, gw.sendFeeDefault));
      // A DONATION RECIPIENT THIS SEAT CANNOT REACH is named, so the proposer can plan it HELD (hole 1 (a)): an invoice this
      // seat cannot check is not taken, and the walk-away's settlement is not left to stall into a refund.
      if (!pr.ok && w.donation) return refuse(`the donation recipient does not answer here: ${w.address} (${pr.why})`);
      if (!pr.ok) return refuse(`this signer node could not read the address's own invoice: ${pr.why}`);
      const stands = sendPlanStands({ plan: p, payoutMsat: w.payout.msat, gateways: g.gateways, height: g.height, metadata: pr.metadata, network: this.network,
        payee: pr.payee, payeeOf });
      if (!stands.ok) return refuse(`the send plan does not stand here: ${stands.why}`);
      rows.push({ entryId: w.entryId, roundId: roundIdBytes, attempt: Number(p.attempt || 0), address: w.address, invoice: p.invoice,
        paymentHash: p.paymentHash, invoiceMsat: stands.invoiceMsat, payoutMsat: w.payout.msat, owedMsat: w.payout.owedMsat,
        gatewayUrl: p.gatewayUrl, gatewayPk: p.gatewayPk, expiration: BigInt(p.expiration), donation: !!w.donation });
    }
    // THE KEPT PLAN GIVES WAY ONLY ONCE EVERY ROW OF THE NEW ONE STOOD HERE - never dropped for a plan that is then refused
    // (and while it was checked - the LNURL asks wait - the settlement may have been signed: replaceable is asked again)
    if (kept.length && !(this.replaceable(roundIdBytes) && this.round.dropPlannedSends(roundIdBytes) > 0))
      return refuse('this signer node\'s kept send plan moved on while that one was checked, and it is not replaced');
    for (const r of rows) this.round.putSendPlan({ ...r, why: from ? `checked by this signer node, signed by seat ${String(from).slice(0, 16)}` : 'checked by this signer node' });
    // THE ROWS THAT STAND ARE THE ANSWER (a compare-and-set): another plan kept here while this one was checked is not this one, and
    // this seat signs no acceptance of a plan it does not keep
    const now = this.round.sendAttemptsOf(roundIdBytes).filter((x) => x.attempt === 0);
    if (planKey(now) !== planKey(rows)) return refuse('this signer node keeps another send plan for that round, kept while that one was checked');
    return { ok: true, rows: this.round.sendPlansOf(roundIdBytes) };
  }

  /**
   * A KEPT PLAN THE PAYOUT NO LONGER MATCHES IS DROPPED - while nothing of the round was settled or sent. Its invoices
   * were sized for payouts this signer node no longer rebuilds (measured: the federation's fee rule changed between
   * the plan and the submit, and every rebuild was refused against the old amount, the round held SUBMITTING). Once
   * the settlement is ACCEPTED or a send went out, the kept plan is what the federation holds, and it stands.
   */
  dropIfStale(roundIdBytes, base) {
    const kept = this.round.sendAttemptsOf(roundIdBytes).filter((x) => x.attempt === 0);
    if (!kept.length) return false;
    // SIGNED IS SETTLED HERE TOO (kanban #1368, audit 2 #1204 SETTLEMENT-4): a SUBMITTING row's transaction may still land and pay this plan's
    // send contracts, so the plan stands as `replaceable` says. A round whose fee rule changed is no longer stuck by it: once every signed
    // txid was refused the row goes REFUSED, and there the plan drops as before.
    const state = stateOf(this.round, roundIdBytes);
    if (state === 'ACCEPTED' || state === 'SUBMITTING') return false;
    const wanting = new Map(this.wanting(base).map((w) => [toHex(w.entryId), w.payout.msat]));
    const same = kept.length === wanting.size && kept.every((k) => wanting.get(toHex(k.entryId)) === k.payoutMsat);
    if (same) return false;
    return this.round.dropPlannedSends(roundIdBytes) > 0;
  }

  /** Whether a kept first plan may still give way: nothing settled, nothing sent, no re-send made. */
  replaceable(roundIdBytes) {
    const settled = { state: stateOf(this.round, roundIdBytes) };
    // SIGNED IS SETTLED: a node that holds the combined settlement (SUBMITTING - it signed or was handed the signature -
    // or ACCEPTED) keeps the plan that settlement pays. Measured on 5 of 7: a later asker's lower plan replaced it at
    // three signer nodes after the combine, and the auth never reached its five ("3 of 5 signer nodes committed").
    if (settled && (settled.state === 'SUBMITTING' || settled.state === 'ACCEPTED')) return false;
    return this.round.sendAttemptsOf(roundIdBytes).every((r) => r.attempt === 0 && r.state === 'PLANNED');
  }

  /** The first plan this signer node keeps, as the peers' door hands it out (GET /settle-sends). */
  keptPlan(roundIdBytes) {
    return this.round.sendAttemptsOf(roundIdBytes).filter((x) => x.attempt === 0).map(plain);
  }

  /** Every send the base plan wants: its qualifiers' to their named addresses, and its donation shares. */
  wanting(base) {
    return [...this.qualifiersWithAddress(base), ...this.donationsOf(base)].sort((a, b) => (toHex(a.entryId) < toHex(b.entryId) ? -1 : 1));
  }

  /** The donation shares of the base plan (a walk-away's 25%), each under its send id, with the recipient's LNURL. */
  donationsOf(base) {
    return base.plan.payouts.filter((p) => p.kind === 'donation' && p.donation)
      .map((p) => ({ entryId: p.donation.id, payout: p, address: p.donation.lnurl, donation: true }));
  }

  /**
   * Qualifier payouts of the base plan whose entry named an address, with that address - NONE since WINNINGS-AUTO (RULED
   * 2026-10-01): a qualifier is paid by its payout contract into its federation wallet, never by a Lightning send,
   * so no winner is planned a send (and none could be paid twice). Donation shares still are.
   */
  qualifiersWithAddress(base) {
    void base;
    return [];
  }

  // the former address path, kept for reading old plans
  qualifiersWithAddressBefore(base) {
    const out = [];
    for (const p of base.plan.payouts) {
      if (p.kind !== 'qualifier') continue;
      const entryId = base.entryOf.get(toHex(p.pubkey));
      const named = entryId && this.round.payoutAddress(entryId);
      if (named) out.push({ entryId, payout: p, address: named.address });
    }
    return out.sort((a, b) => (toHex(a.entryId) < toHex(b.entryId) ? -1 : 1));
  }

  /** The kept plans as `lockSettlement`'s `sends`, keyed by player key. */
  sendsFor(roundIdBytes, base, claimPk) {
    const byEntry = new Map([...base.entryOf.entries()].map(([pk, eid]) => [toHex(eid), pk]));
    const sends = new Map();
    // THE FIRST ATTEMPT ONLY: the settlement is what it was when it was signed; a re-send is its own transaction.
    for (const d of this.donationsOf(base)) byEntry.set(toHex(d.entryId), toHex(d.entryId));
    for (const r of this.round.sendAttemptsOf(roundIdBytes).filter((x) => x.attempt === 0)) {
      const pk = byEntry.get(toHex(r.entryId));
      if (pk) sends.set(pk, { paymentHash: r.paymentHash, gatewayPk: r.gatewayPk, refundPk: claimPk, expiration: r.expiration, payoutMsat: r.payoutMsat,
        held: r.donation && !r.invoice });
    }
    return sends;
  }

  /** What the committee signs for one send: the invoice's consensus hash, rebuilt by this signer node's own tool. */
  async authMessage(row, claimPk, roundIdBytes) {
    const said = await (await this.portFor(roundIdBytes)).send({ paymentHash: row.paymentHash, amountMsat: row.payoutMsat, expiration: row.expiration,
      claimPk: row.gatewayPk, refundPk: claimPk, invoice: row.invoice });
    return said.message;
  }

  rowOf(roundIdBytes, entryHex, attempt = null) {
    const rows = this.round.sendAttemptsOf(roundIdBytes).filter((r) => toHex(r.entryId) === entryHex);
    if (attempt === null) return rows.at(-1) || null;
    return rows.find((r) => r.attempt === Number(attempt)) || null;
  }

  /**
   * WHERE A SEND'S CONTRACT IS: the first attempt's in the settlement (its output, found by payment hash), a re-send's
   * in its own transaction (output 0), each rebuilt by this signer node - never taken from a peer.
   */
  async contractOf(roundIdBytes, row, built) {
    if (row.attempt === 0) {
      // A HELD DONATION SHARE's contract is the settlement's held output for that recipient's send id.
      const outIdx = !row.invoice
        ? built.plan.payouts.findIndex((p) => p.kind === 'held' && p.donation && toHex(p.donation.id) === toHex(row.entryId))
        : built.plan.payouts.findIndex((p) => p.sent && p.sent.paymentHash === row.paymentHash);
      return outIdx < 0 ? null : { txid: fromHex(built.txid), outIdx: BigInt(outIdx) };
    }
    const tx = await this.resendTx(roundIdBytes, row, built);
    return tx ? { txid: fromHex(tx.txid), outIdx: 0n } : null;
  }

  /**
   * THE RE-SEND OF AN EXPIRED WINNING (RULED 2026-09-23: "If the chosen gateway does not pay before expiry, the contract
   * returns to the signer nodes and they re-send through the other live gateway"): the previous attempt's contract,
   * spent by the committee's refund key, into one outgoing contract to the new attempt's invoice. The nonce is the
   * round's, the entry's and the attempt's, so every signer node rebuilds the same txid.
   */
  async resendTx(roundIdBytes, row, built, signature = null) {
    const prev = this.rowOf(roundIdBytes, toHex(row.entryId), row.attempt - 1);
    if (!prev) return null;
    const from = await this.contractOf(roundIdBytes, prev, built);
    if (!from) return null;
    const nonce = resendNonce({ roundId: roundIdBytes, lateEntryId: this.round.lateEntryId || null, entryId: row.entryId, attempt: row.attempt });
    // AN UNSIGNED REBUILD IS KEPT (NODE-OPT-1648): it is the same transaction every time - the nonce is the round's, the
    // entry's and the attempt's - yet every winnings sweep (once a minute, every seat) rebuilt it with a stock-client run
    // on the shared client directory for every held send: 48 `settle` runs a minute across seven idle testnet4 seats. A
    // signed one is a submission and always goes to the federation.
    const key = signature ? null : [toHex(roundIdBytes), toHex(row.entryId), row.attempt, built.txid, String(prev.payoutMsat),
      String(row.payoutMsat), row.paymentHash, row.gatewayPk, row.expiration, toHex(from.txid), String(from.outIdx)].join(':');
    if (key && this.rebuilt.has(key)) return this.rebuilt.get(key);
    const tx = await (await this.portFor(roundIdBytes)).settle({ claimPk: built.claimPk, claims: [], refunds: [{ outpoint: from, amountMsat: prev.payoutMsat }],
      payouts: [{ payoutPk: built.claimPk, msat: row.payoutMsat,
        sent: { paymentHash: row.paymentHash, gatewayPk: row.gatewayPk, expiration: row.expiration } }], nonce, signature });
    if (key && tx) {
      this.rebuilt.set(key, tx);
      if (this.rebuilt.size > 4096) this.rebuilt.delete(this.rebuilt.keys().next().value);
    }
    return tx;
  }

  /**
   * WHERE AN ATTEMPT'S CONTRACT STANDS AT THE FEDERATION (kanban #1186): one of CONTRACT_FATE. "Not stored" was read as "spent", so a contract no landed
   * transaction ever made (a re-send that never went in, a first send of a settlement that never landed) read as claimed and never expired. Now a
   * contract not stored is GONE (claimed by the gateway, or refunded) only when it is known to have been made - attempt 0 by its settlement's row
   * ACCEPTED on that txid here (#1171: only on what the guardians hold), attempt N by its re-send's input, attempt N-1's contract, no longer held -
   * and NEVER otherwise.
   */
  async contractFate(roundIdBytes, row, built) {
    const at = await this.contractOf(roundIdBytes, row, built);
    if (!at) return { fate: CONTRACT_FATE.NEVER, why: 'no contract for that attempt' };
    const port = await this.portFor(roundIdBytes);
    const st = await port.status(at);
    if (st.stored) return { fate: st.stored.blocksLeft <= 0 ? CONTRACT_FATE.EXPIRED : CONTRACT_FATE.LIVE, at, blocksLeft: st.stored.blocksLeft, height: st.blockCount };
    if (row.attempt === 0) {
      const s = typeof this.round.lockSettlement === 'function' ? this.round.lockSettlement(roundIdBytes) : null;
      // (a round that takes any federation: the federation's row whose transaction made it)
      const rows = s ? [s] : (typeof this.round.fedLockSettlementsOf === 'function' ? this.round.fedLockSettlementsOf(roundIdBytes) : []);
      return rows.some((x) => x.state === 'ACCEPTED' && String(x.txid) === toHex(at.txid))
        ? { fate: CONTRACT_FATE.GONE, at, why: 'the contract is no longer held: the gateway claimed it, or it was refunded' }
        : { fate: CONTRACT_FATE.NEVER, at, why: `the contract is not held, and its settlement ${toHex(at.txid).slice(0, 12)} is not ACCEPTED here: no landed transaction made it` };
    }
    const prev = this.rowOf(roundIdBytes, toHex(row.entryId), row.attempt - 1);
    const from = prev ? await this.contractOf(roundIdBytes, prev, built) : null;
    const input = from ? await port.status(from) : null;
    if (input && input.stored) return { fate: CONTRACT_FATE.NEVER, at, why: `the re-send's input, attempt ${row.attempt - 1}'s contract, is still held: the re-send never went in` };
    return { fate: CONTRACT_FATE.GONE, at, why: 'the contract is no longer held and its input is spent: the gateway claimed it, or it was refunded' };
  }

  /** Has this attempt's contract expired unpaid, as this signer node reads the federation? `spent` only for a contract that was made (contractFate). */
  async expired(roundIdBytes, row, built) {
    const f = await this.contractFate(roundIdBytes, row, built);
    if (f.fate === CONTRACT_FATE.GONE) return { expired: false, spent: true, fate: f.fate, why: f.why };
    if (f.fate === CONTRACT_FATE.NEVER) return { expired: false, never: true, fate: f.fate, why: f.why };
    return { expired: f.fate === CONTRACT_FATE.EXPIRED, fate: f.fate, blocksLeft: f.blocksLeft, height: f.height };
  }

  /**
   * The gateways the entry's attempts up to `upTo` used (every attempt when null). KANBAN #1629: a peer checking another seat's attempt N+1
   * counts only attempts <= N - its own kept attempt N+1 is the competitor, not an earlier attempt, and counting its gateway as used refused
   * every competing offer through the same next gateway, so the #1241 lower-hash replace below was never reached.
   */
  usedGateways(roundIdBytes, entryHex, upTo = null) {
    return new Set(this.round.sendAttemptsOf(roundIdBytes).filter((r) => toHex(r.entryId) === entryHex && (upTo === null || Number(r.attempt) <= upTo))
      .map((r) => r.gatewayUrl));
  }

  /** The next gateway: the lowest live key the entry's earlier attempts (up to `upTo`, kanban #1629) did not use. */
  nextGateway(roundIdBytes, entryHex, listed, upTo = null) {
    const used = this.usedGateways(roundIdBytes, entryHex, upTo);
    return lowestLiveGateway(listed.filter((g) => !used.has(g.url)));
  }

  /** The proposer's re-send plan for an expired attempt. */
  async proposeResend(roundIdBytes, prev, built) {
    const entryHex = toHex(prev.entryId);
    const g = await (await this.portFor(roundIdBytes)).gateways();
    const gw = this.nextGateway(roundIdBytes, entryHex, g.gateways, prev.attempt);
    if (!gw) return refuse('no other live gateway to re-send through; the winning waits for one');
    const fees = await (await this.portFor(roundIdBytes)).fees();
    const out = largestPayoutMsat(fees, prev.payoutMsat - lnv2FeeMsat(fees, prev.payoutMsat));
    const invoiceMsat = sendableInvoiceMsat(out, gw.sendFeeDefault);
    if (invoiceMsat <= 0n) return refuse('the refunded winning does not cover the next gateway\'s fee');
    const inv = await this.invoiceFor(prev.address, invoiceMsat);
    if (!inv.ok) {
      // SAID WHOLE, ONCE PER CHANGE (kanban #1044): the proposer's sweep asks every pass
      const k = `${toHex(roundIdBytes)}:${entryHex}`;
      if (this.resendSaid.get(k) !== inv.why) { this.resendSaid.set(k, inv.why); console.log(`[winnings] ${toHex(roundIdBytes).slice(0, 16)} re-send of ${entryHex.slice(0, 8)} not proposed: ${inv.why}`); }
      return refuse(`the winner's invoice does not stand, so nothing is re-sent on it: ${inv.why}`);
    }
    const row = { entryId: prev.entryId, roundId: roundIdBytes, attempt: prev.attempt + 1, address: prev.address, invoice: inv.invoice,
      paymentHash: inv.paymentHash, invoiceMsat, payoutMsat: out, owedMsat: prev.owedMsat, gatewayUrl: gw.url, gatewayPk: gw.modulePublicKey,
      expiration: proposedExpiration(g.height, gw), donation: !!prev.donation };
    this.round.putSendPlan({ ...row, why: prev.invoice ? `re-send proposed: attempt ${prev.attempt} expired unpaid through ${prev.gatewayUrl}`
      : 'a held donation share re-sent: the recipient answers' });
    // THE ROW THIS SEAT KEEPS IS THE ONE OFFERED (kanban #1241): another seat's attempt kept here first stands (or a lower one replaced it), and
    // offering this seat's fresh invoice beside it split the peers for good
    const kept = this.rowOf(roundIdBytes, entryHex, row.attempt);
    const offer = kept && kept.paymentHash !== String(row.paymentHash).toLowerCase() ? { ...kept, roundId: roundIdBytes, donation: !!prev.donation } : row;
    const refused = await this.offerResend(roundIdBytes, offer);
    return refused.length ? refuse(`a signer node did not take the re-send: ${refused.join('; ')}`) : { ok: true, row: this.rowOf(roundIdBytes, entryHex) };
  }

  /**
   * A RE-SEND HANDED TO THE PEERS, each checking it itself (`checkResend`); a peer that holds it already takes it again.
   * Offered again before an unfunded re-send is signed: a peer that refused it once - a held donation recipient it could
   * not yet reach - takes the same attempt once it can, instead of the re-send waiting on a row it never kept.
   */
  async offerResend(roundIdBytes, row) {
    // EVERY PEER AT ONCE, WITHIN THE BOUND (kanban #1074): each must take it, so there is no threshold; a hung one is named as one that refused
    const body = JSON.stringify(plain(row));
    // SIGNED BY THIS SEAT'S NODE KEY (kanban #1154): a peer takes a re-send only from a seat of the round
    const headers = sendPlanAskHeaders(this.round, { kind: PLAN_ASK.RESEND, roundId: roundIdBytes, lateEntryId: this.round.lateEntryId || null, body });
    const asked = await askPeers(this.peersFor(roundIdBytes), async (base, signal) => {
      const r = await this.fetcher(`${base}/resend-sends?round=${toHex(roundIdBytes)}${this.scopeParam}`, { method: 'POST', body, headers, signal });
      return r.ok ? null : (await r.text()).trim();
    }, { boundMs: this.peerAskMs });
    return asked.filter((x) => !('value' in x) || x.value !== null).map((x) => `${x.peer}: ${'value' in x ? x.value : x.error.message}`);
  }

  /**
   * A PEER'S CHECK of a re-send: the previous attempt expired here, the gateway is the next live key here, the invoice stands and pays
   * the node the address's own callback answers this seat with. `from`: the hex node key of the seat of the round that signed it
   * (server.js checked it) - a re-send from no seat is not taken (kanban #1154: attempt N+1 went to whoever posted first).
   */
  async checkResend(roundIdBytes, built, p, { from = null } = {}) {
    if (!from) return refuse('a re-send is taken only from a seat of the round, signed by its node key', 403);
    if (!p || typeof p !== 'object') return refuse('a re-send is a send plan', 400);
    let prev = this.rowOf(roundIdBytes, String(p.entry));
    if (!prev) return refuse('this signer node holds no send for that entry');
    // ANOTHER SEAT'S ATTEMPT N+1 KEPT HERE ALREADY, still PLANNED (kanban #1241): this one is checked against the attempt before it, and replaces
    // the kept one below when its hash is lower
    if (Number(p.attempt) === prev.attempt && prev.attempt > 0 && prev.state === 'PLANNED' && prev.paymentHash !== String(p.paymentHash).toLowerCase())
      prev = this.rowOf(roundIdBytes, String(p.entry), prev.attempt - 1) || prev;
    if (Number(p.attempt) !== prev.attempt + 1) {
      const same = this.rowOf(roundIdBytes, String(p.entry), Number(p.attempt));
      return same && same.paymentHash === String(p.paymentHash).toLowerCase() ? { ok: true } : refuse(`that is not the next attempt after ${prev.attempt}`);
    }
    const ex = await this.expired(roundIdBytes, prev, built);
    if (!ex.expired) return refuse(`attempt ${prev.attempt} has not expired here: ${ex.why || `${ex.blocksLeft} block(s) left`}`);
    const g = await (await this.portFor(roundIdBytes)).gateways();
    // ONLY ATTEMPTS UP TO prev COUNT (kanban #1629): a kept PLANNED attempt N+1 of another hash is what this offer competes with
    const gw = this.nextGateway(roundIdBytes, String(p.entry), g.gateways, prev.attempt);
    if (!gw) return refuse('this signer node sees no other live gateway');
    const fees = await (await this.portFor(roundIdBytes)).fees();
    const out = largestPayoutMsat(fees, prev.payoutMsat - lnv2FeeMsat(fees, prev.payoutMsat));
    const pr = await this.invoiceFor(prev.address, sendableInvoiceMsat(out, gw.sendFeeDefault));
    if (!pr.ok) return refuse(`this signer node could not read the address's own invoice: ${pr.why}`);
    const others = g.gateways.filter((x) => x.url !== prev.gatewayUrl);
    const used = this.usedGateways(roundIdBytes, String(p.entry), prev.attempt);
    const stands = sendPlanStands({ plan: p, payoutMsat: out, gateways: others.filter((x) => !used.has(x.url)), height: g.height, metadata: pr.metadata, network: this.network,
      payee: pr.payee, payeeOf });
    if (!stands.ok) return refuse(`the re-send does not stand here: ${stands.why}`);
    this.round.putSendPlan({ entryId: prev.entryId, roundId: roundIdBytes, attempt: prev.attempt + 1, address: prev.address, invoice: p.invoice,
      paymentHash: p.paymentHash, invoiceMsat: stands.invoiceMsat, payoutMsat: out, owedMsat: prev.owedMsat, gatewayUrl: p.gatewayUrl,
      gatewayPk: p.gatewayPk, expiration: BigInt(p.expiration), donation: !!prev.donation, why: `re-send checked here: attempt ${prev.attempt} expired (signed by seat ${String(from).slice(0, 16)})` });
    // THE ROW THAT STANDS IS THE ANSWER: another seat's attempt N+1 kept a moment before is not this one, and this one is not taken
    let kept = this.rowOf(roundIdBytes, String(p.entry), prev.attempt + 1);
    // A LOWER RE-SEND REPLACES A KEPT ONE NOTHING WAS SIGNED ON YET (kanban #1241): the peers meet on the lowest hash any seat offered
    // ...and never one this seat already gave a share on (kanban #1629): a swap after signing could strand a funded attempt
    const signedOn = ['resend', 'auth'].some((k) => { const x = this.pairs.get(`${k}:${toHex(roundIdBytes)}:${String(p.entry)}:${prev.attempt + 1}`); return !!(x && x.list); });
    if (kept && kept.paymentHash !== String(p.paymentHash).toLowerCase() && kept.state === 'PLANNED' && typeof this.round.replaceSendPlan === 'function'
      && String(p.paymentHash).toLowerCase() < kept.paymentHash && !signedOn) {
      this.pairs.delete(`resend:${toHex(roundIdBytes)}:${String(p.entry)}:${prev.attempt + 1}`);
      this.round.replaceSendPlan({ roundId: roundIdBytes, entryId: prev.entryId, attempt: prev.attempt + 1, invoice: p.invoice, paymentHash: p.paymentHash,
        invoiceMsat: stands.invoiceMsat, payoutMsat: out, gatewayUrl: p.gatewayUrl, gatewayPk: p.gatewayPk, expiration: BigInt(p.expiration), donation: !!prev.donation,
        why: `re-send checked here: a lower attempt ${prev.attempt + 1} than the one kept (signed by seat ${String(from).slice(0, 16)})` });
      kept = this.rowOf(roundIdBytes, String(p.entry), prev.attempt + 1);
    }
    if (!kept || kept.paymentHash !== String(p.paymentHash).toLowerCase())
      return refuse(`this signer node keeps another attempt ${prev.attempt + 1} for that send, and does not replace it`);
    return { ok: true };
  }

  /** The message a kind of signature covers, rebuilt here: `auth` the invoice's hash, `resend` the re-send's txid. */
  async messageFor(kind, roundIdBytes, row, built) {
    if (kind === 'auth') return this.authMessage(row, built.claimPk, roundIdBytes);
    if (kind === 'resend') { const tx = await this.resendTx(roundIdBytes, row, built); return tx ? fromHex(tx.message) : null; }
    return null;
  }

  /** ROUND ONE: this signer node's commitment for the message of `kind` it rebuilt. */
  async commit(roundIdBytes, entryHex, built, kind = 'auth', attempt = null, { hash = null } = {}) {
    const row = this.rowOf(roundIdBytes, entryHex, attempt);
    if (!row) return refuse('this signer node holds no send plan for that entry', 404);
    // A COMMITMENT ONLY TO THE PLAN THE ASKER SIGNS FOR - the settlement's own guard (settlement.js `commit`), here for a
    // send: a signer node keeping another plan would otherwise commit, and its share over its own invoice spoils the
    // combined auth for everyone (measured on 5 of 7: 5 nodes took one plan, 2 kept another, and 34 auths came back
    // "does not verify under the claim key"; the winner was never paid).
    if (hash && String(hash).toLowerCase() !== String(row.paymentHash).toLowerCase())
      return refuse('this signer node keeps another send plan for that winning: it commits to no other bytes', 409);
    const message = await this.messageFor(kind, roundIdBytes, row, built);
    if (!message) return refuse('this signer node cannot rebuild that message');
    const key = `${kind}:${toHex(roundIdBytes)}:${entryHex}:${row.attempt}`;
    if (built.named) return this.#commitNamed(built, key, message);
    let pair = this.pairs.get(key);
    // A PAIR THAT SIGNED A LIST IS SPENT (kanban #1074, the settlement's #1070): the next commit draws a new one, so a list one seat never completed binds nobody
    if (!pair || toHex(pair.message) !== toHex(message) || pair.list) {
      const hiding = nonceGenerate340(this.random(32), built.signerNode.share);
      const binding = nonceGenerate340(this.random(32), built.signerNode.share);
      pair = { message, hiding, binding, list: null, share: null,
        commitment: { id: built.signerNode.id, hiding: this.curve.pointFromScalar(hiding), binding: this.curve.pointFromScalar(binding) } };
      this.pairs.set(key, pair);
    }
    return { ok: true, commitment: pair.commitment };
  }

  /** ROUND TWO: the share over the message this signer node rebuilt, for one commitment list, once. */
  async share(roundIdBytes, entryHex, built, commitments, kind = 'auth', attempt = null) {
    const row = this.rowOf(roundIdBytes, entryHex, attempt);
    if (!row) return refuse('this signer node holds no send plan for that entry', 404);
    const message = await this.messageFor(kind, roundIdBytes, row, built);
    const pair = this.pairs.get(`${kind}:${toHex(roundIdBytes)}:${entryHex}:${row.attempt}`);
    if (!message || !pair || toHex(pair.message) !== toHex(message)) return refuse(`this signer node committed to no ${kind} of that send`);
    if (built.named) return this.#shareNamed(built, pair, commitments, kind);
    // NO LIST LONGER THAN A COMMITTEE (kanban #1672, as at /settle-share): refused before any curve work
    { const why = commitmentListRefusal(commitments, { needed: built.needed, nodes: built.contract && built.contract.nodes }); if (why) return refuse(why); }
    const own = commitments.find((c) => String(c.id) === String(pair.commitment.id));
    if (!own || toHex(own.hiding) !== toHex(pair.commitment.hiding) || toHex(own.binding) !== toHex(pair.commitment.binding))
      return refuse('that list does not carry this signer node\'s own commitment');
    if (commitments.length < built.needed) return refuse(`${commitments.length} commitments, and this round's key signs at ${built.needed}`);
    const key = listKey(commitments);
    if (pair.list && pair.list !== key) return refuse(`this signer node signed that ${kind} over another list, and keeps no second pair`);
    if (pair.share === null) {
      pair.share = signShare340({ id: pair.commitment.id, share: built.signerNode.share, groupPublicKey: built.claimPk,
        nonces: { hiding: pair.hiding, binding: pair.binding }, message, commitments, curve: this.curve });
      pair.list = key;
    }
    return { ok: true, share: pair.share };
  }

  /**
   * The committee's signature of `kind` over one attempt, made here with the peers: every peer asked at once within a bound (kanban #1074 as #1061), and a
   * seat that gave no share, or one that does not stand, left off the next list while the threshold remains (as #1070), asked again at once.
   */
  async sign(roundIdBytes, row, built, kind) {
    const entryHex = toHex(row.entryId);
    const q = `round=${toHex(roundIdBytes)}&entry=${entryHex}&kind=${kind}&attempt=${row.attempt}&hash=${row.paymentHash}${this.scopeParam}`;
    if (built.named) return this.#signNamed(roundIdBytes, row, built, kind, q);
    for (;;) {
      const own = await this.commit(roundIdBytes, entryHex, built, kind, row.attempt);
      if (!own.ok) return own;
      const message = this.pairs.get(`${kind}:${toHex(roundIdBytes)}:${entryHex}:${row.attempt}`).message;
      const asked = await askPeers(this.peersFor(roundIdBytes), async (base, signal) => {
        const r = await this.fetcher(`${base}/send-commit?${q}`, { method: 'POST', signal });
        return r.ok ? { commitment: decodeCommitments(new Uint8Array(await r.arrayBuffer()))[0] } : null;
      }, { boundMs: this.peerAskMs, graceMs: this.peerGraceMs, enough: built.needed - 1, counts: (x) => !!(x && x.commitment) });
      const signers = [{ base: null, commitment: own.commitment }];
      for (const { peer: base, value } of asked) if (value && value.commitment) signers.push({ base, commitment: value.commitment });
      if (signers.length < built.needed) return refuse(`${signers.length} of ${built.needed} signer nodes committed to the ${kind}`);
      const listed = this.#listed(q, signers, built.needed);
      const combined = await this.#gatherShares(roundIdBytes, entryHex, built, kind, row.attempt, q, message, listed);
      if (combined.ok) { this.withheld.delete(q); return combined; }
      if (!this.#leaveOut(q, combined, listed, built.needed)) return combined;
    }
  }

  /**
   * S-ONLY SIGNING AFTER THE SETTLEMENT (protocol 27, kanban #1044 B1, ruling #1134 2): a held donation share's re-send and its send's auth are signed by the
   * settlement's signer set S - the key its refund names is KeyAgg(claim_keys[S]) - with BIP-327 MuSig2, one message a session. Only a member of S commits;
   * every member of S must sign, since no other set makes that key; a member of S gone for good leaves the share where it is (the written residual).
   * The commit door answers the seat's index and its public nonce pair; the share door is asked over the list of every member's (seat, pubnonce),
   * ascending - exactly S - and each nonce pair signs one list, once.
   */
  #namedSeat(built) {
    const { seatKeys, threshold } = namedClaimKeys(built.contract);
    const seat = seatKeys.findIndex((k) => toHex(k) === toHex(this.round.pubkey));
    return { seatKeys, threshold, seat, signers: built.signers || [] };
  }

  #commitNamed(built, key, message) {
    const { seat, signers } = this.#namedSeat(built);
    if (seat < 0 || !signers.includes(seat)) return refuse('this seat is not in the signer set S of that settlement: only S signs under its key');
    let pair = this.pairs.get(key);
    if (!pair || !pair.named || toHex(pair.message) !== toHex(message) || pair.list) {
      pair = { named: true, message, list: null, partial: null,
        nonces: new NamedNonces({ count: 1, secret: this.round.identity.secret, myKey: this.round.pubkey, rand: this.random }) };
      this.pairs.set(key, pair);
    }
    return { ok: true, named: true, seat, pubnonces: pair.nonces.pubnonces, wire: encodeNamedResendCommit(seat, pair.nonces.pubnonces) };
  }

  #shareNamed(built, pair, members, kind) {
    const { seatKeys, threshold, seat, signers } = this.#namedSeat(built);
    if (!pair.named) return refuse(`this signer node committed to no ${kind} of that send under S`);
    if (!Array.isArray(members) || members.length !== signers.length || members.some((m, i) => m.seat !== signers[i]))
      return refuse(`that list is not the signer set S (${signers.join(', ')}) of the settlement`);
    const own = members.find((m) => m.seat === seat);
    if (!own || own.pubnonces.length !== 1 || toHex(own.pubnonces[0]) !== toHex(pair.nonces.pubnonces[0])) return refuse('that list does not carry this seat\'s own nonces');
    const key = members.map((m) => `${m.seat}:${toHex(m.pubnonces[0] || new Uint8Array(0))}`).join('|');
    if (pair.list && pair.list !== key) return refuse(`this seat signed that ${kind} over another list, and keeps no second nonce`);
    if (members.some((m) => m.pubnonces.length !== 1)) return refuse('a member of that list commits to another number of nonces');
    if (pair.partial === null) {
      pair.partial = pair.nonces.sign({ claimKeys: seatKeys, threshold, signers, pubnoncesBySigner: members.map((m) => m.pubnonces), messages: [pair.message] })[0];
      pair.list = key;
    }
    return { ok: true, named: true, partial: pair.partial, wire: pair.partial };
  }

  async #signNamed(roundIdBytes, row, built, kind, q) {
    const entryHex = toHex(row.entryId);
    const { seatKeys, threshold, seat, signers } = this.#namedSeat(built);
    if (!signers.length) return refuse('the settlement names no signer set S');
    const message = await this.messageFor(kind, roundIdBytes, row, built);
    if (!message) return refuse('this signer node cannot rebuild that message');
    const members = new Map();
    let mineKey = null;
    if (signers.includes(seat)) {
      const own = await this.commit(roundIdBytes, entryHex, built, kind, row.attempt);
      if (!own.ok) return own;
      members.set(seat, { seat, pubnonces: own.pubnonces, base: null });
      mineKey = `${kind}:${toHex(roundIdBytes)}:${entryHex}:${row.attempt}`;
    }
    const asked = await askPeers(this.peersFor(roundIdBytes), async (base, signal) => {
      const r = await this.fetcher(`${base}/send-commit?${q}`, { method: 'POST', signal });
      return r.ok ? decodeNamedResendCommit(new Uint8Array(await r.arrayBuffer())) : null;
    }, { boundMs: this.peerAskMs, graceMs: this.peerGraceMs, enough: signers.length - members.size, counts: (x) => !!(x && x.pubnonces) });
    for (const { peer: base, value } of asked) {
      if (value && signers.includes(value.seat) && !members.has(value.seat) && value.pubnonces.length === 1) members.set(value.seat, { ...value, base });
    }
    const missing = signers.filter((i) => !members.has(i));
    // A MEMBER OF S GONE: no other set makes S's key, so the share stays where it is until it answers (ruling #1134 2's residual)
    if (missing.length) return { ...refuse(`seat(s) ${missing.join(', ')} of the signer set S did not commit to the ${kind}: only S signs under its key, and the share stays held`), held: true };
    const list = signers.map((i) => members.get(i));
    const body = encodeNamedResendList(list);
    const partials = new Map();
    if (mineKey) {
      const mine = await this.share(roundIdBytes, entryHex, built, list, kind, row.attempt);
      if (!mine.ok) return mine;
      partials.set(seat, mine.partial);
    }
    const peers = list.filter((x) => x.base !== null);
    const got = await askPeers(peers.map((x) => x.base), async (base, signal) => {
      const r = await this.fetcher(`${base}/send-share?${q}&named=1`, { method: 'POST', body, signal });
      if (!r.ok) return { why: (await r.text()).trim() };
      return { partial: new Uint8Array(await r.arrayBuffer()) };
    }, { boundMs: this.peerAskMs });
    got.forEach(({ value }, i) => { if (value && value.partial && value.partial.length === 32) partials.set(peers[i].seat, value.partial); });
    const agg = aggregateBatch({ claimKeys: seatKeys, threshold, signers, messages: [message], pubnoncesBySigner: list.map((x) => x.pubnonces),
      partialsBySigner: signers.map((i) => (partials.has(i) ? [partials.get(i)] : null)) });
    if (!agg.ok) return { ...refuse(`the ${kind} under S was not made: ${agg.why} (seat(s) ${agg.bad.join(', ')})`), held: true };
    const signature = agg.signatures[0];
    if (!schnorr.verify(signature, message, built.claimPk.subarray(1))) return refuse(`the ${kind} signature does not verify under the signer set's key`);
    return { ok: true, signature };
  }

  /** THE SEATS THAT SIGN THIS LIST (settlement.js #listed): those that committed, less any that gave this asker no share for it while enough others remain. */
  #listed(key, signers, needed) {
    const out = this.withheld.get(key);
    if (!out) return signers;
    const kept = signers.filter((s) => !out.has(s.base));
    return kept.length >= needed ? kept : signers;
  }

  /** A LIST THAT FAILED AT A SEAT: true when that seat is now left out and enough others remain; it grows by a seat each time, so it ends. */
  #leaveOut(key, failed, listed, needed) {
    const out = this.withheld.get(key) || new Set();
    const fresh = (failed.withheld || []).filter((base) => !out.has(base));
    for (const base of fresh) out.add(base);
    if (!fresh.length || listed.filter((s) => !out.has(s.base)).length < needed) { this.withheld.delete(key); return false; }
    this.withheld.set(key, out);
    if (this.withheld.size > 4096) this.withheld.delete(this.withheld.keys().next().value);
    return true;
  }

  /** ROUND TWO: every seat on the list gives its share, all at once within the bound; a refusal names in `withheld` the seats that gave none or whose share does not stand. */
  async #gatherShares(roundIdBytes, entryHex, built, kind, attempt, q, message, signers) {
    const commitments = signers.map((x) => x.commitment).sort((x, y) => x.id - y.id);
    const mine = await this.share(roundIdBytes, entryHex, built, commitments, kind, attempt);
    if (!mine.ok) return mine;
    const body = encodeCommitments(commitments);
    const peers = signers.filter((x) => x.base !== null);
    const asked = await askPeers(peers.map((x) => x.base), async (base, signal) => {
      const r = await this.fetcher(`${base}/send-share?${q}`, { method: 'POST', body, signal });
      if (!r.ok) return { why: (await r.text()).trim() };
      return { share: decodeShare(new Uint8Array(await r.arrayBuffer())) };
    }, { boundMs: this.peerAskMs });
    const none = asked.filter((x) => !x.value || !('share' in x.value));
    if (none.length) return { ...refuse(`${none[0].peer} gave no ${kind} share: ${none[0].value ? none[0].value.why : none[0].error.message}`), withheld: none.map((x) => x.peer) };
    const shares = [mine.share, ...asked.map((x) => x.value.share)];
    const { signature } = aggregate340({ commitments, message, groupPublicKey: built.claimPk, shares, curve: this.curve });
    if (schnorr.verify(signature, message, built.claimPk.subarray(1))) return { ok: true, signature };
    const held = this.dkg && this.dkg.publicSharesFor && built.contract ? this.dkg.publicSharesFor(built.contract.nodes) : null;
    const spoilt = held && held.ok ? peers.filter((x, i) => !verifyShare340({ id: x.commitment.id, share: asked[i].value.share,
      publicShare: held.shares.get(String(x.commitment.id)), groupPublicKey: built.claimPk, message, commitments, curve: this.curve })) : [];
    return { ...refuse(`the ${kind} signature does not verify under the claim key`), withheld: spoilt.map((x) => x.base) };
  }

  /**
   * THE PRESIGNED REFUND (c) OF AN EXPIRED SEND, SUBMITTED (protocol 27, rulings #1134 2, #1135 2, #1136): the send contract at `at` by Refund into
   * the pre-expired payout to the qualifier's key from the batch, under the signature S made before the settlement went in.
   */
  async submitRefund(roundIdBytes, row, built, at) {
    const slot = built.batch.slots.findIndex((s) => s.kind === 'refund' && s.outIdx === Number(at.outIdx));
    if (slot < 0) return refuse('the batch holds no refund (c) for that send');
    const r = built.batch.slots[slot];
    const said = await (await this.portFor(roundIdBytes)).arenaSendRefund({ send: at, amountMsat: row.payoutMsat, refundPk: built.claimPk,
      qualifierPk: fromHex(r.qualifierPk), signature: built.batch.signatures[slot] });
    if (String(said.txid) !== String(r.txid)) return refuse(`the refund rebuilt here is ${String(said.txid).slice(0, 16)}, not the signed ${String(r.txid).slice(0, 16)}`);
    if (!said.accepted) return refuse(`the guardians refused the refund (c): ${said.error}`);
    this.round.markSend({ entryId: row.entryId, attempt: row.attempt, state: SEND.REFUNDED, txid: String(r.txid), outIdx: 0,
      why: 'the send expired unpaid: its presigned refund (c) put the winnings in the qualifier\'s own payout contract' });
    return { ok: true, state: 'REFUNDED', refund: String(r.txid) };
  }

  /** A preimage a peer reports: kept only if it is the invoice's own (sha256 of it is the payment hash). */
  paid(roundIdBytes, entryHex, preimage) {
    const row = this.round.sendAttemptsOf(roundIdBytes).filter((r) => toHex(r.entryId) === entryHex)
      .find((r) => r.paymentHash === toHex(sha256(preimage)));
    if (!row) return refuse('that preimage is not the invoice of any send this signer node holds for that entry');
    this.keepPaid(row, preimage, 'the gateway paid the winner\'s invoice; its preimage checked here');
    return { ok: true };
  }

  keepPaid(row, preimage, why) {
    this.round.markSend({ entryId: row.entryId, attempt: row.attempt, state: PAID, why, preimage: toHex(preimage) });
    // A DONATION SEND IS NO PLAYER'S WINNING: its PAID row is all that is kept.
    if (row.donation) return;
    this.round.putWinnings({ entryId: row.entryId, roundId: row.roundId, owedMsat: row.owedMsat, state: PAID, request: row.invoice,
      why, paidMs: this.round.now() });
  }

  /**
   * EVERY WINNING OF A SETTLED ROUND, CARRIED TO PAID - run by the round's proposer only (the others answer). For each
   * entry's latest attempt: a re-send not yet funded is funded (the committee signs its txid and it is submitted); a
   * funded one is signed over its invoice and asked of its gateway; one that did not pay and has EXPIRED is re-sent
   * through the next live gateway. A PAID winning is left alone, and a gateway asked twice answers its one payment.
   */
  async sendAll(roundIdBytes, built) {
    const out = [];
    for (const row of this.round.sendPlansOf(roundIdBytes)) {
      const entryHex = toHex(row.entryId);
      if (row.state === PAID) { out.push({ entry: entryHex, attempt: row.attempt, state: PAID, already: true }); continue; }
      if (row.state === SEND.REFUNDED) { out.push({ entry: entryHex, attempt: row.attempt, state: SEND.REFUNDED, already: true }); continue; }
      // A HELD DONATION SHARE: kept under the committee key, and the same recipient asked again - once it answers, the
      // re-send spends the held contract into the send to its invoice (the next pass funds and pays it).
      // A PROTOCOL-27 QUALIFIER'S SEND IS NEVER RE-SENT (its refund (c) is): only a donation's held share or re-send is signed by S after the settlement
      if (built.named && !row.donation && row.attempt > 0) {
        out.push({ entry: entryHex, attempt: row.attempt, ok: false, why: 'a protocol-27 qualifier\'s send is not re-sent: its presigned refund (c) is submitted' });
        continue;
      }
      if (!row.invoice) {
        const at = await this.contractOf(roundIdBytes, row, built);
        if (!at) { out.push({ entry: entryHex, attempt: row.attempt, ok: false, why: 'no held contract for this share' }); continue; }
        if (!row.txid) this.round.markSend({ entryId: row.entryId, attempt: 0, state: SEND.HELD, txid: toHex(at.txid), outIdx: Number(at.outIdx),
          why: 'the recipient did not answer: its share is held under the committee key for a retry to the same address' });
        const re = await this.proposeResend(roundIdBytes, this.rowOf(roundIdBytes, entryHex, 0), built);
        out.push({ entry: entryHex, attempt: row.attempt, ok: false, held: true, resend: re.ok ? re.row.attempt : re.why });
        continue;
      }
      if (row.attempt > 0 && (!row.txid || row.state === SEND.FUNDING)) {
        // A RE-SEND SUBMITTED BEFORE (kanban #1186): FUNDING carries its txid, so the federation is asked first - a contract made by it, or its input
        // spent, is not submitted again; only one whose input is still held (it never went in) is
        if (row.state === SEND.FUNDING && row.txid) {
          const f = await this.contractFate(roundIdBytes, row, built);
          if (f.fate !== CONTRACT_FATE.NEVER) {
            if (this.round.markSend({ entryId: row.entryId, attempt: row.attempt, state: SEND.SENDING, txid: row.txid, outIdx: 0,
              why: `the re-send ${String(row.txid).slice(0, 12)} went in before (${f.fate}): not submitted again` }) !== false) row.state = SEND.SENDING;
          }
        }
      }
      if (row.attempt > 0 && row.state !== SEND.SENDING && (!row.txid || row.state === SEND.FUNDING)) {
        await this.offerResend(roundIdBytes, row);
        const s = await this.sign(roundIdBytes, row, built, 'resend');
        if (!s.ok) { out.push({ entry: entryHex, attempt: row.attempt, ...s }); continue; }
        // FUNDING, WITH THE RE-SEND'S TXID, IS ON DISK BEFORE THE GUARDIANS ARE HANDED THE RE-SEND (kanban #1154, #1186): the txid is the unsigned
        // rebuild's - the nonce is the round's, the entry's and the attempt's, so it is the same transaction every time
        const unsigned = await this.resendTx(roundIdBytes, row, built);
        if (!unsigned || !unsigned.txid) { out.push({ entry: entryHex, attempt: row.attempt, ok: false, why: 'the re-send does not rebuild here' }); continue; }
        if (this.round.markSend({ entryId: row.entryId, attempt: row.attempt, state: SEND.FUNDING, txid: String(unsigned.txid), outIdx: 0,
          why: `the re-send is signed and handed to the guardians: attempt ${row.attempt - 1} refunded into a contract through ${row.gatewayUrl}` }) === false) {
          out.push({ entry: entryHex, attempt: row.attempt, ok: false, why: `this send is ${row.state} here, not one a re-send is funded from` }); continue;
        }
        const tx = await this.resendTx(roundIdBytes, row, built, s.signature);
        if (!tx.accepted) { out.push({ entry: entryHex, attempt: row.attempt, ok: false, why: `the guardians refused the re-send: ${tx.error}` }); continue; }
        this.round.markSend({ entryId: row.entryId, attempt: row.attempt, state: SEND.SENDING, txid: tx.txid, outIdx: 0,
          why: `re-sent: the expired attempt refunded to the committee and funded into a contract through ${row.gatewayUrl}` });
        row.state = SEND.SENDING;
      }
      const at = await this.contractOf(roundIdBytes, row, built);
      if (!at) { out.push({ entry: entryHex, attempt: row.attempt, ok: false, why: 'no contract for this attempt' }); continue; }
      // SENDING IS ON DISK BEFORE THE GATEWAY IS ASKED (kanban #1154): a row that does not move there (a final one) is not sent
      if (row.state !== SEND.SENDING && this.round.markSend({ entryId: row.entryId, attempt: row.attempt, state: SEND.SENDING,
        txid: row.txid ? null : toHex(at.txid), outIdx: row.txid ? null : Number(at.outIdx),
        why: 'the settlement is accepted; the committee signs the invoice and the gateway is asked' }) === false) {
        out.push({ entry: entryHex, attempt: row.attempt, ok: false, why: `this send is ${row.state} here, and the gateway is not asked` }); continue;
      }
      // THE REGTEST FAULT (test-named-offence.js `send-hold`, off by default): a qualifier's send left unasked, so it expires unpaid, and its refund (c) left
      // to anyone else (ruling #1134 2: "after a failed send, anyone submits (c)")
      if (built.named && !row.donation && sendHoldOn(roundIdBytes)) { out.push({ entry: entryHex, attempt: row.attempt, ok: false, why: 'test switch: this seat holds the send and its refund (c) (send-hold)' }); continue; }
      // PROTOCOL 27 (ruling #1134 2): the auth was signed by S in the settlement's batch, before the submit - never by a key signed after it
      // (a donation's re-send is S's own send after the settlement: its auth is signed by S now, at the S-only doors)
      const a = built.named && row.attempt === 0 ? presignedAuth(built, row) : await this.sign(roundIdBytes, row, built, 'auth');
      if (!a.ok) { out.push({ entry: entryHex, attempt: row.attempt, ...a }); continue; }
      const said = await (await this.portFor(roundIdBytes)).send({ gateway: row.gatewayUrl, outpoint: at, paymentHash: row.paymentHash, amountMsat: row.payoutMsat,
        expiration: row.expiration, claimPk: row.gatewayPk, refundPk: built.claimPk, invoice: row.invoice, auth: a.signature });
      if (said.sent && said.preimage && toHex(sha256(said.preimage)) === row.paymentHash) {
        this.keepPaid(row, said.preimage, `the gateway at ${row.gatewayUrl} paid the winner's invoice; its preimage checked`);
        // EVERY PEER AT ONCE, WITHIN THE BOUND (kanban #1074): a peer that misses it asks again
        // SIGNED BY THIS SEAT'S NODE KEY (kanban #1185): a peer keeps a preimage only from a seat of the round
        const paidHeaders = sendPlanAskHeaders(this.round, { kind: PLAN_ASK.PAID, roundId: roundIdBytes, lateEntryId: this.round.lateEntryId || null, body: said.preimage });
        await askPeers(this.peersFor(roundIdBytes), (base, signal) => this.fetcher(`${base}/winnings-paid?round=${toHex(roundIdBytes)}&entry=${entryHex}${this.scopeParam}`,
          { method: 'POST', body: said.preimage, headers: paidHeaders, signal }), { boundMs: this.peerAskMs, graceMs: this.peerGraceMs, enough: 0 });
        out.push({ entry: entryHex, attempt: row.attempt, ok: true, state: PAID, preimage: toHex(said.preimage), gateway: row.gatewayUrl });
        continue;
      }
      this.round.markSend({ entryId: row.entryId, attempt: row.attempt, state: SEND.SENDING, why: `the gateway did not pay: ${said.why || 'no preimage'}` });
      const ex = await this.expired(roundIdBytes, row, built);
      if (!ex.expired) { out.push({ entry: entryHex, attempt: row.attempt, ok: false, why: said.why, blocksLeft: ex.blocksLeft }); continue; }
      // PROTOCOL 27: A FAILED SEND TO A QUALIFIER IS NOT RE-SENT (ruling #1134 2): its presigned refund (c) is submitted and the winnings land in the
      // qualifier's own payout contract. Anyone may submit it; the seat whose turn it is does, once the send expired.
      if (built.named && !row.donation) { out.push({ entry: entryHex, attempt: row.attempt, ...(await this.submitRefund(roundIdBytes, row, built, at)) }); continue; }
      const re = await this.proposeResend(roundIdBytes, row, built);
      out.push({ entry: entryHex, attempt: row.attempt, ok: false, expired: true, resend: re.ok ? re.row.attempt : re.why });
    }
    return out;
  }
}

export { plain as sendPlanToJson };

/** The auth S presigned for a send of a protocol-27 settlement, from the batch the seats kept: { ok, signature } or a refusal. */
export function presignedAuth(built, row) {
  const k = built.batch.slots.findIndex((s) => s.kind === 'auth' && String(s.paymentHash).toLowerCase() === String(row.paymentHash).toLowerCase());
  return k < 0 ? refuse('the settlement\'s batch holds no auth for that send') : { ok: true, signature: built.batch.signatures[k] };
}

/**
 * A RE-SEND'S NONCE: the round's, the entry's and the attempt's, so every signer node rebuilds the same txid - and, for a
 * late settlement's send (slice C3b-2b), its late entry's too, under its own tag, so a late re-send of a winner's attempt
 * 1 never shares a nonce with that winner's first-round attempt 1.
 */
export function resendNonce({ roundId, lateEntryId = null, entryId, attempt }) {
  const tag = new TextEncoder().encode(lateEntryId ? 'blwp late winnings resend v1' : 'blwp winnings resend v1');
  return sha256(new Uint8Array([...tag, ...roundId, ...(lateEntryId || []), ...entryId,
    (attempt >>> 24) & 255, (attempt >>> 16) & 255, (attempt >>> 8) & 255, attempt & 255])).subarray(0, 8);
}

/** A plan's order key: its payment hashes, sorted and joined. Two plans for one round compare by it. */
export function planKey(rows) {
  return rows.map((r) => String(r.paymentHash).toLowerCase()).sort().join(':');
}

/** A member of S at the re-send commit door (protocol 27): u8 seat index, then its public nonces (u16 k, k x 66 bytes). */
export const encodeNamedResendCommit = (seat, pubnonces) => Uint8Array.from([seat, ...encodeNamedCommitment(pubnonces)]);
export function decodeNamedResendCommit(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 3) throw new Error('a re-send commit is a seat index and its nonces');
  return { seat: bytes[0], pubnonces: decodeNamedCommitment(bytes.subarray(1)) };
}
/** The list the re-send share door is asked over: u8 n, then per member u8 seat, u16 k and k public nonces - exactly S, ascending. */
export function encodeNamedResendList(members) {
  const parts = [Uint8Array.of(members.length), ...members.flatMap((m) => [Uint8Array.of(m.seat), encodeNamedCommitment(m.pubnonces)])];
  const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0)); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
export function decodeNamedResendList(bytes) {
  const out = []; let at = 1;
  const n = bytes[0];
  for (let i = 0; i < n; i++) {
    const seat = bytes[at]; const k = (bytes[at + 1] << 8) | bytes[at + 2];
    const end = at + 3 + 66 * k;
    if (end > bytes.length) throw new Error('the re-send list ends early');
    out.push({ seat, pubnonces: decodeNamedCommitment(bytes.subarray(at + 1, end)) });
    at = end;
  }
  if (at !== bytes.length) throw new Error('the re-send list runs on');
  return out;
}
