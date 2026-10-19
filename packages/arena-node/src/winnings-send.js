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
import { schnorr } from '@noble/curves/secp256k1.js';
import { lightningAddressEndpoint, payRequestStands, callbackFor, invoiceAnswersPayRequest } from '../../arena-protocol/src/lnurl-pay.js';
import { sendableInvoiceMsat, lowestLiveGateway, sendPlanStands, proposedExpiration } from '../../arena-protocol/src/winnings-send.js';
import { signShare340, aggregate340, nonceGenerate340 } from '../../arena-protocol/src/frost-bip340.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { encodeCommitments, decodeCommitments, decodeShare } from './pool-wire.js';
import { largestPayoutMsat, lnv2FeeMsat } from '../../arena-protocol/src/lock-settlement.js';
import { urlOfLnurl } from '../../arena-protocol/src/bech32.js';
import { stateOf } from './settlement-state.js';

/** Where an address's pay request is: a Lightning address (LUD-16), or a donation recipient's LNURL (LUD-01). */
function payRequestUrl(address) {
  if (/^lnurl1/i.test(String(address || ''))) {
    try { return { ok: true, url: urlOfLnurl(String(address).toLowerCase()) }; } catch (e) { return { ok: false, why: `that LNURL does not decode: ${e.message}` }; }
  }
  return lightningAddressEndpoint(address);
}

const refuse = (why, status = 409) => ({ ok: false, status, why });
const PAID = 'PAID';
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
  constructor({ round, port, curve, random, peersFor, fetcher, lnurlFetch = fetch, network = 'regtest', scopeParam = '' }) {
    // `scopeParam`: A LATE SETTLEMENT'S SENDS (slice C3b-2a) - `&late=<entry>` on every signing and paid call to a peer,
    // so the peer answers from that late settlement's rows; empty for the round's own sends.
    Object.assign(this, { round, port, curve, random, peersFor, fetcher, lnurlFetch, network, scopeParam });
    this.pairs = new Map();      // `${round}:${entry}:${attempt}` -> nonce pair for the auth signature
    this.rebuilt = new Map();    // an unsigned re-send transaction, by everything it is built from
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

  /** The address's LUD-06 pay request, as THIS signer node fetches it. */
  async payRequest(address, amountMsat) {
    const ep = payRequestUrl(address);
    if (!ep.ok) return refuse(ep.why);
    let said;
    try { said = await (await this.lnurlFetch(ep.url)).json(); } catch (e) { return refuse(`${ep.url} did not answer: ${e.message}`); }
    const pr = payRequestStands(said, amountMsat);
    return pr.ok ? { ok: true, ...pr } : refuse(pr.why);
  }

  /** The invoice for exactly `amountMsat`, checked by amount and LUD-06 description hash. */
  async invoiceFor(address, amountMsat) {
    const pr = await this.payRequest(address, amountMsat);
    if (!pr.ok) return pr;
    let said;
    try { said = await (await this.lnurlFetch(callbackFor({ callback: pr.callback, amountMsat }))).json(); }
    catch (e) { return refuse(`the address's callback did not answer: ${e.message}`); }
    const inv = invoiceAnswersPayRequest({ invoice: said && said.pr, amountMsat, metadata: pr.metadata, network: this.network });
    if (!inv.ok) return refuse(inv.why);
    return { ok: true, invoice: said.pr, paymentHash: toHex(inv.paymentHash), metadata: pr.metadata };
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
    for (const r of rows) this.round.putSendPlan({ ...r, why: r.heldWhy ? `held: the recipient did not answer (${String(r.heldWhy).slice(0, 120)})` : 'proposed by this signer node' });
    return { ok: true, rows: this.round.sendPlansOf(roundIdBytes) };
  }

  /** A PEER'S CHECK of the coordinator's plans, each against this signer node's own payout, gateways, height and LNURL. */
  async check(roundIdBytes, base, proposed) {
    // A PLAN ALREADY KEPT IS NOT REPLACED - the same plan again is taken, another is refused by name - with one
    // exception that makes two askers converge: while nothing of the round is settled or sent, a plan whose payment
    // hashes sort LOWER replaces the kept one. Measured on a 5-of-7 under M3.3-19's takeover: two askers each fetched
    // their own invoice, the peers split 4 and 2, and neither plan ever reached the five a signature needs.
    this.dropIfStale(roundIdBytes, base);
    let kept = this.round.sendAttemptsOf(roundIdBytes).filter((x) => x.attempt === 0);
    if (kept.length) {
      const same = kept.length === proposed.length && kept.every((k) => proposed.some((p) => String(p.entry) === toHex(k.entryId)
        && String(p.paymentHash).toLowerCase() === k.paymentHash && Number(p.attempt || 0) === k.attempt));
      if (same) return { ok: true, rows: kept };
      if (!(planKey(proposed) < planKey(kept) && this.replaceable(roundIdBytes)))
        return refuse('this signer node keeps another send plan for that round, and does not replace it');
      this.round.dropPlannedSends(roundIdBytes);
      kept = [];
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
      const pr = await this.payRequest(w.address, sendableInvoiceMsat(w.payout.msat, gw.sendFeeDefault));
      // A DONATION RECIPIENT THIS SEAT CANNOT REACH is named, so the proposer can plan it HELD (hole 1 (a)): an invoice this
      // seat cannot check is not taken, and the walk-away's settlement is not left to stall into a refund.
      if (!pr.ok && w.donation) return refuse(`the donation recipient does not answer here: ${w.address} (${pr.why})`);
      if (!pr.ok) return refuse(`this signer node could not read the address's pay request: ${pr.why}`);
      const stands = sendPlanStands({ plan: p, payoutMsat: w.payout.msat, gateways: g.gateways, height: g.height, metadata: pr.metadata, network: this.network });
      if (!stands.ok) return refuse(`the send plan does not stand here: ${stands.why}`);
      rows.push({ entryId: w.entryId, roundId: roundIdBytes, attempt: Number(p.attempt || 0), address: w.address, invoice: p.invoice,
        paymentHash: p.paymentHash, invoiceMsat: stands.invoiceMsat, payoutMsat: w.payout.msat, owedMsat: w.payout.owedMsat,
        gatewayUrl: p.gatewayUrl, gatewayPk: p.gatewayPk, expiration: BigInt(p.expiration), donation: !!w.donation });
    }
    for (const r of rows) this.round.putSendPlan({ ...r, why: 'checked by this signer node' });
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
    if (stateOf(this.round, roundIdBytes) === 'ACCEPTED') return false;
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

  /** Has this attempt's contract expired unpaid, as this signer node reads the federation? */
  async expired(roundIdBytes, row, built) {
    const at = await this.contractOf(roundIdBytes, row, built);
    if (!at) return { expired: false, why: 'no contract for that attempt' };
    const st = await (await this.portFor(roundIdBytes)).status(at);
    if (!st.stored) return { expired: false, spent: true, why: 'the contract is no longer held: the gateway claimed it, or it was refunded' };
    return { expired: st.stored.blocksLeft <= 0, blocksLeft: st.stored.blocksLeft, height: st.blockCount };
  }

  /** The next gateway: the lowest live key the entry's earlier attempts did not use. */
  nextGateway(roundIdBytes, entryHex, listed) {
    const used = new Set(this.round.sendAttemptsOf(roundIdBytes).filter((r) => toHex(r.entryId) === entryHex).map((r) => r.gatewayUrl));
    return lowestLiveGateway(listed.filter((g) => !used.has(g.url)));
  }

  /** The proposer's re-send plan for an expired attempt. */
  async proposeResend(roundIdBytes, prev, built) {
    const entryHex = toHex(prev.entryId);
    const g = await (await this.portFor(roundIdBytes)).gateways();
    const gw = this.nextGateway(roundIdBytes, entryHex, g.gateways);
    if (!gw) return refuse('no other live gateway to re-send through; the winning waits for one');
    const fees = await (await this.portFor(roundIdBytes)).fees();
    const out = largestPayoutMsat(fees, prev.payoutMsat - lnv2FeeMsat(fees, prev.payoutMsat));
    const invoiceMsat = sendableInvoiceMsat(out, gw.sendFeeDefault);
    if (invoiceMsat <= 0n) return refuse('the refunded winning does not cover the next gateway\'s fee');
    const inv = await this.invoiceFor(prev.address, invoiceMsat);
    if (!inv.ok) return refuse(`the winner's invoice does not stand, so nothing is re-sent on it: ${inv.why}`);
    const row = { entryId: prev.entryId, roundId: roundIdBytes, attempt: prev.attempt + 1, address: prev.address, invoice: inv.invoice,
      paymentHash: inv.paymentHash, invoiceMsat, payoutMsat: out, owedMsat: prev.owedMsat, gatewayUrl: gw.url, gatewayPk: gw.modulePublicKey,
      expiration: proposedExpiration(g.height, gw), donation: !!prev.donation };
    this.round.putSendPlan({ ...row, why: prev.invoice ? `re-send proposed: attempt ${prev.attempt} expired unpaid through ${prev.gatewayUrl}`
      : 'a held donation share re-sent: the recipient answers' });
    const refused = await this.offerResend(roundIdBytes, row);
    return refused.length ? refuse(`a signer node did not take the re-send: ${refused.join('; ')}`) : { ok: true, row: this.rowOf(roundIdBytes, entryHex) };
  }

  /**
   * A RE-SEND HANDED TO THE PEERS, each checking it itself (`checkResend`); a peer that holds it already takes it again.
   * Offered again before an unfunded re-send is signed: a peer that refused it once - a held donation recipient it could
   * not yet reach - takes the same attempt once it can, instead of the re-send waiting on a row it never kept.
   */
  async offerResend(roundIdBytes, row) {
    const refused = [];
    for (const base of this.peersFor(roundIdBytes)) {
      try {
        const r = await this.fetcher(`${base}/resend-sends?round=${toHex(roundIdBytes)}${this.scopeParam}`, { method: 'POST', body: JSON.stringify(plain(row)) });
        if (!r.ok) refused.push(`${base}: ${(await r.text()).trim()}`);
      } catch (e) { refused.push(`${base}: ${e.message}`); }
    }
    return refused;
  }

  /** A PEER'S CHECK of a re-send: the previous attempt expired here, the gateway is the next live key here, the invoice stands. */
  async checkResend(roundIdBytes, built, p) {
    const prev = this.rowOf(roundIdBytes, String(p.entry));
    if (!prev) return refuse('this signer node holds no send for that entry');
    if (Number(p.attempt) !== prev.attempt + 1) {
      const same = this.rowOf(roundIdBytes, String(p.entry), Number(p.attempt));
      return same && same.paymentHash === String(p.paymentHash).toLowerCase() ? { ok: true } : refuse(`that is not the next attempt after ${prev.attempt}`);
    }
    const ex = await this.expired(roundIdBytes, prev, built);
    if (!ex.expired) return refuse(`attempt ${prev.attempt} has not expired here: ${ex.why || `${ex.blocksLeft} block(s) left`}`);
    const g = await (await this.portFor(roundIdBytes)).gateways();
    const gw = this.nextGateway(roundIdBytes, String(p.entry), g.gateways);
    if (!gw) return refuse('this signer node sees no other live gateway');
    const fees = await (await this.portFor(roundIdBytes)).fees();
    const out = largestPayoutMsat(fees, prev.payoutMsat - lnv2FeeMsat(fees, prev.payoutMsat));
    const pr = await this.payRequest(prev.address, sendableInvoiceMsat(out, gw.sendFeeDefault));
    if (!pr.ok) return refuse(`this signer node could not read the address's pay request: ${pr.why}`);
    const others = g.gateways.filter((x) => x.url !== prev.gatewayUrl);
    const stands = sendPlanStands({ plan: p, payoutMsat: out, gateways: others.filter((x) => !this.round.sendAttemptsOf(roundIdBytes)
      .some((r) => toHex(r.entryId) === String(p.entry) && r.gatewayUrl === x.url)), height: g.height, metadata: pr.metadata, network: this.network });
    if (!stands.ok) return refuse(`the re-send does not stand here: ${stands.why}`);
    this.round.putSendPlan({ entryId: prev.entryId, roundId: roundIdBytes, attempt: prev.attempt + 1, address: prev.address, invoice: p.invoice,
      paymentHash: p.paymentHash, invoiceMsat: stands.invoiceMsat, payoutMsat: out, owedMsat: prev.owedMsat, gatewayUrl: p.gatewayUrl,
      gatewayPk: p.gatewayPk, expiration: BigInt(p.expiration), donation: !!prev.donation, why: `re-send checked here: attempt ${prev.attempt} expired` });
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
    let pair = this.pairs.get(key);
    if (!pair || toHex(pair.message) !== toHex(message)) {
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

  /** The committee's signature of `kind` over one attempt, made here with the peers. */
  async sign(roundIdBytes, row, built, kind) {
    const entryHex = toHex(row.entryId);
    const q = `round=${toHex(roundIdBytes)}&entry=${entryHex}&kind=${kind}&attempt=${row.attempt}&hash=${row.paymentHash}${this.scopeParam}`;
    const own = await this.commit(roundIdBytes, entryHex, built, kind, row.attempt);
    if (!own.ok) return own;
    const signers = [{ base: null, commitment: own.commitment }];
    for (const base of this.peersFor(roundIdBytes)) {
      try {
        const r = await this.fetcher(`${base}/send-commit?${q}`, { method: 'POST' });
        if (r.ok) signers.push({ base, commitment: decodeCommitments(new Uint8Array(await r.arrayBuffer()))[0] });
      } catch { /* a peer down: the threshold decides */ }
    }
    if (signers.length < built.needed) return refuse(`${signers.length} of ${built.needed} signer nodes committed to the ${kind}`);
    const commitments = signers.map((x) => x.commitment).sort((x, y) => x.id - y.id);
    const shares = [];
    for (const x of signers) {
      if (x.base === null) { const mine = await this.share(roundIdBytes, entryHex, built, commitments, kind, row.attempt); if (!mine.ok) return mine; shares.push(mine.share); continue; }
      const r = await this.fetcher(`${x.base}/send-share?${q}`, { method: 'POST', body: encodeCommitments(commitments) });
      if (!r.ok) return refuse(`${x.base} gave no ${kind} share: ${(await r.text()).trim()}`);
      shares.push(decodeShare(new Uint8Array(await r.arrayBuffer())));
    }
    const message = this.pairs.get(`${kind}:${toHex(roundIdBytes)}:${entryHex}:${row.attempt}`).message;
    const { signature } = aggregate340({ commitments, message, groupPublicKey: built.claimPk, shares, curve: this.curve });
    if (!schnorr.verify(signature, message, built.claimPk.subarray(1))) return refuse(`the ${kind} signature does not verify under the claim key`);
    return { ok: true, signature };
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
      // A HELD DONATION SHARE: kept under the committee key, and the same recipient asked again - once it answers, the
      // re-send spends the held contract into the send to its invoice (the next pass funds and pays it).
      if (!row.invoice) {
        const at = await this.contractOf(roundIdBytes, row, built);
        if (!at) { out.push({ entry: entryHex, attempt: row.attempt, ok: false, why: 'no held contract for this share' }); continue; }
        if (!row.txid) this.round.markSend({ entryId: row.entryId, attempt: 0, state: 'HELD', txid: toHex(at.txid), outIdx: Number(at.outIdx),
          why: 'the recipient did not answer: its share is held under the committee key for a retry to the same address' });
        const re = await this.proposeResend(roundIdBytes, this.rowOf(roundIdBytes, entryHex, 0), built);
        out.push({ entry: entryHex, attempt: row.attempt, ok: false, held: true, resend: re.ok ? re.row.attempt : re.why });
        continue;
      }
      if (row.attempt > 0 && !row.txid) {
        await this.offerResend(roundIdBytes, row);
        const s = await this.sign(roundIdBytes, row, built, 'resend');
        if (!s.ok) { out.push({ entry: entryHex, attempt: row.attempt, ...s }); continue; }
        const tx = await this.resendTx(roundIdBytes, row, built, s.signature);
        if (!tx.accepted) { out.push({ entry: entryHex, attempt: row.attempt, ok: false, why: `the guardians refused the re-send: ${tx.error}` }); continue; }
        this.round.markSend({ entryId: row.entryId, attempt: row.attempt, state: 'SENDING', txid: tx.txid, outIdx: 0,
          why: `re-sent: the expired attempt refunded to the committee and funded into a contract through ${row.gatewayUrl}` });
      }
      const at = await this.contractOf(roundIdBytes, row, built);
      if (!at) { out.push({ entry: entryHex, attempt: row.attempt, ok: false, why: 'no contract for this attempt' }); continue; }
      if (row.attempt === 0 && !row.txid)
        this.round.markSend({ entryId: row.entryId, attempt: 0, state: 'SENDING', txid: toHex(at.txid), outIdx: Number(at.outIdx),
          why: 'the settlement is accepted; the committee signs the invoice and the gateway is asked' });
      const a = await this.sign(roundIdBytes, row, built, 'auth');
      if (!a.ok) { out.push({ entry: entryHex, attempt: row.attempt, ...a }); continue; }
      const said = await (await this.portFor(roundIdBytes)).send({ gateway: row.gatewayUrl, outpoint: at, paymentHash: row.paymentHash, amountMsat: row.payoutMsat,
        expiration: row.expiration, claimPk: row.gatewayPk, refundPk: built.claimPk, invoice: row.invoice, auth: a.signature });
      if (said.sent && said.preimage && toHex(sha256(said.preimage)) === row.paymentHash) {
        this.keepPaid(row, said.preimage, `the gateway at ${row.gatewayUrl} paid the winner's invoice; its preimage checked`);
        for (const base of this.peersFor(roundIdBytes)) {
          try { await this.fetcher(`${base}/winnings-paid?round=${toHex(roundIdBytes)}&entry=${entryHex}${this.scopeParam}`, { method: 'POST', body: said.preimage }); } catch { /* it asks again */ }
        }
        out.push({ entry: entryHex, attempt: row.attempt, ok: true, state: PAID, preimage: toHex(said.preimage), gateway: row.gatewayUrl });
        continue;
      }
      this.round.markSend({ entryId: row.entryId, attempt: row.attempt, state: 'SENDING', why: `the gateway did not pay: ${said.why || 'no preimage'}` });
      const ex = await this.expired(roundIdBytes, row, built);
      if (!ex.expired) { out.push({ entry: entryHex, attempt: row.attempt, ok: false, why: said.why, blocksLeft: ex.blocksLeft }); continue; }
      const re = await this.proposeResend(roundIdBytes, row, built);
      out.push({ entry: entryHex, attempt: row.attempt, ok: false, expired: true, resend: re.ok ? re.row.attempt : re.why });
    }
    return out;
  }
}

export { plain as sendPlanToJson };

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
