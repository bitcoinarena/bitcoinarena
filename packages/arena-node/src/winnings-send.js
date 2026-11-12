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
import { lnurlPublicFetch } from './public-fetch.js';
import { sendableInvoiceMsat, lowestLiveGateway, sendPlanStands, proposedExpiration } from '../../arena-protocol/src/winnings-send.js';
import { signShare340, aggregate340, nonceGenerate340 } from '../../arena-protocol/src/frost-bip340.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { encodeCommitments, decodeCommitments, decodeShare, commitmentListRefusal, decodePeerCommitment, peerCommitmentRefusal, leftOffLast } from './pool-wire.js';
import { largestPayoutMsat, lnv2FeeMsat } from '../../arena-protocol/src/lock-settlement.js';
import { urlOfLnurl } from '../../arena-protocol/src/bech32.js';
import { stateOf } from './settlement-state.js';
import { askPeers, askWithin, PEER_ASK_MS, PEER_GRACE_MS } from './peer-ask.js';
import { NoncePool, SignerLists, sharesRefused, BOUND_ELSEWHERE } from './nonce-pool.js';
import { OWN, UNSIGNED } from './asker-pairs.js';
import { invoicePayee } from '../../arena-protocol/src/bolt11.js';
import { SEND } from './send-state.js';
import { PLAN_ASK, sendPlanAskHeaders, checkSendPlanAsk, sendCommitAskBody } from './send-plan-ask.js';
import { readJsonBounded } from './lnurl-read.js';
import { hostReach, hostOf } from './public-fetch.js';
import { TEST_DONATION_ENDPOINTS } from '../../arena-protocol/src/test-donation-sets.js';
import { misnamedSigners, spoiltShares } from './signer-guard.js';

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
   * @param lnurlFetch how an address's LNURL endpoint is fetched (a test hands its own). The default asks the PUBLIC internet only (kanban #1919):
   *   https on a public name and address, redirects checked hop by hop, .onion over http - a payout address naming 127.0.0.1 is never fetched
   * @param peersFor   (roundIdBytes) => [base URL] - the round's other settlement signer nodes
   */
  constructor({ round, port, curve, random, peersFor, fetcher, lnurlFetch = null, network = 'regtest', scopeParam = '', dkg = null,
    peerAskMs = PEER_ASK_MS, peerGraceMs = PEER_GRACE_MS, lnurlMs = LNURL_ASK_MS, localHosts = [] }) {
    // `scopeParam`: A LATE SETTLEMENT'S SENDS (slice C3b-2a) - `&late=<entry>` on every signing and paid call to a peer,
    // so the peer answers from that late settlement's rows; empty for the round's own sends.
    // `dkg`: the public shares that name a seat whose share does not stand (kanban #1074); the bounds: how long a seat, and an LNURL endpoint, is waited for
    Object.assign(this, { round, port, curve, random, peersFor, fetcher, lnurlFetch, network, scopeParam, dkg, peerAskMs, peerGraceMs, lnurlMs });
    // `localHosts`: the operator's own "host[:port]" LNURL servers inside its network (a regtest harness's, ARENA_LNURL_LOCAL_HOSTS) - kanban #2236
    this.localHosts = (localHosts || []).map((h) => String(h).toLowerCase());
    // THE DEFAULT LNURL FETCH (kanban #1919, #2236): the PUBLIC internet only (lnurlPublicFetch: https on a public name and address, redirects checked
    // hop by hop, .onion over http); the operator's own local recipients (lnurlLocal, and their callbacks on the same hosts) by the process's fetch
    if (!this.lnurlFetch) this.lnurlFetch = (u, o) => (this.lnurlLocalHost(u) ? fetch(u, o) : lnurlPublicFetch(u, o));
    // `${kind}:${round}:${entry}:${attempt}` -> the pairs handed out for that signature, ONE PER ASK (nonce-pool.js, kanban #2011 - the forfeit's #1521
    // rule): one unspent pair handed to every asker let a stranger ask for it and at once spend it on a list of made-up commitments, and every
    // honest list was refused ("keeps no second pair") - the winner was never paid while he kept doing it. A pool per asker (kanban #2308, #2322).
    this.pairHoldMs = 2 * (this.peerAskMs + this.peerGraceMs);
    this.pairs = new NoncePool({ holdMs: () => this.pairHoldMs });
    this.lists = new SignerLists();   // a signing's query -> the peers left off its next list, and its poisoned lists (kanban #1074, #2011)
    // the pair keys a share was given on (kanban #1629): a kept re-send that one was signed on is never replaced - the pool drops spent pairs
    this.signedKeys = new Set();
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

  /** The address's LUD-06 pay request, as THIS signer node fetches it. Its answer, and the callback's, is read to at most
   *  LNURL_MAX_BYTES (kanban #1562): the address is the player's own server, asked by every seat of the committee at once. */
  async payRequest(address, amountMsat) {
    const ep = payRequestUrl(address);
    if (!ep.ok) return refuse(ep.why);
    // NEVER A HOST INSIDE THE SEAT'S NETWORK (kanban #2236, the #1809 guard of the faucet): the address is the player's pick, and every signer node
    // of the committee fetches it - so a host that is not on the public internet, by its name or by where it resolves, is never asked
    const local = this.lnurlLocal(ep.url);
    if (!local) { const why = await this.publicRefusal(ep.url); if (why) return refuse(why); }
    let said;
    try { said = await askWithin(async (signal) => readJsonBounded(await this.lnurlFetch(ep.url, { signal })), this.lnurlMs); } catch (e) { return refuse(`${ep.url} did not answer: ${e.message}`); }
    const pr = payRequestStands(said, amountMsat);
    return pr.ok ? { ok: true, ...pr, local: local ? hostOf(ep.url) : null } : refuse(pr.why);
  }

  /** An LNURL the operator itself runs inside its network (kanban #2236): the test donation set's two recipients off mainnet, or a host the operator listed. */
  lnurlLocal(url) {
    if (!/^(bitcoin|mainnet)$/.test(String(this.network)) && TEST_DONATION_ENDPOINTS.includes(String(url))) return true;
    return this.localHosts.includes(hostOf(url));
  }

  /** A host the operator's own local recipients live on (kanban #2236): a listed host, or off mainnet a test donation recipient's host - fetched by the process's own fetch. */
  lnurlLocalHost(url) {
    const h = hostOf(url);
    if (!h) return false;
    if (this.localHosts.includes(h)) return true;
    return !/^(bitcoin|mainnet)$/.test(String(this.network)) && TEST_DONATION_ENDPOINTS.some((e) => hostOf(e) === h);
  }

  /** Why this URL is not fetched for a stranger (kanban #2236), or null: https on port 443 only, no internal name, every address it resolves to global. */
  async publicRefusal(url) {
    let reach;
    try { reach = await askWithin(() => hostReach(url), this.lnurlMs); } catch { reach = 'unresolved'; }
    return reach === 'internal' ? `${hostOf(url) || 'that URL'} is not a public HTTPS host, and a seat asks no host inside its own network for an address` : null;
  }

  /** The invoice for exactly `amountMsat`, checked by amount and LUD-06 description hash. */
  async invoiceFor(address, amountMsat) {
    const pr = await this.payRequest(address, amountMsat);
    if (!pr.ok) return pr;
    // ITS CALLBACK TOO (kanban #2236): an operator's own local recipient may call back on its own host; any other callback is https on a public host
    if (!(pr.local && (hostOf(pr.callback) === pr.local || this.localHosts.includes(hostOf(pr.callback))))) {
      const why = await this.publicRefusal(pr.callback);
      if (why) return refuse(`the address's callback: ${why}`);
    }
    let said;
    try { said = await askWithin(async (signal) => readJsonBounded(await this.lnurlFetch(callbackFor({ callback: pr.callback, amountMsat }), { signal })), this.lnurlMs); }
    catch (e) { return refuse(`the address's callback did not answer: ${e.message}`); }
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
    for (const r of rows) this.round.putSendPlan({ ...r, why: r.heldWhy ? `held: the recipient did not answer (${String(r.heldWhy).slice(0, 120)})` : 'proposed by this signer node' });
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
    if (!inv.ok) return refuse(`the winner's invoice does not stand, so nothing is re-sent on it: ${inv.why}`);
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
    const signedOn = ['resend', 'auth'].some((k) => this.signedKeys.has(`${k}:${toHex(roundIdBytes)}:${String(p.entry)}:${prev.attempt + 1}`));   // a share given on any pair of the message
    if (kept && kept.paymentHash !== String(p.paymentHash).toLowerCase() && kept.state === 'PLANNED' && typeof this.round.replaceSendPlan === 'function'
      && String(p.paymentHash).toLowerCase() < kept.paymentHash && !signedOn) {
      this.pairs.drop(`resend:${toHex(roundIdBytes)}:${String(p.entry)}:${prev.attempt + 1}`);
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

  /** This seat's own node key, hex, or null when it holds none (a test's stub store). */
  ownKey() {
    const pk = this.round && this.round.pubkey;
    return this.round && this.round.identity && this.round.identity.secret && pk ? toHex(pk).toLowerCase() : null;
  }

  /**
   * A signed commit or share ask (kanban #2308, #2322): { ok, who } when a seat of the round signed these bytes - the round contract's nodes,
   * read from this seat's store as server.js reads them for every signed send ask (a stub store without one: the nodes `built` names).
   */
  askedBy(header, kind, roundIdBytes, built, body) {
    let seats = built && built.contract && Array.isArray(built.contract.nodes) ? built.contract.nodes : [];
    const row = this.round && typeof this.round.get === 'function' ? this.round.get(roundIdBytes) : null;
    if (row && row.contract) {
      try { seats = decodeRoundContract(new Uint8Array(row.contract)).nodes; } catch (e) { return { ok: false, why: `the round's contract does not decode: ${e.message}` }; }
    }
    return checkSendPlanAsk(header, { kind, roundId: roundIdBytes, lateEntryId: this.round.lateEntryId || null, body, seats });
  }

  /** ROUND ONE: this signer node's commitment for the message of `kind` it rebuilt. */
  async commit(roundIdBytes, entryHex, built, kind = 'auth', attempt = null, { hash = null, header = null, ask = null, at: askedAt = null, own = false } = {}) {
    const row = this.rowOf(roundIdBytes, entryHex, attempt);
    if (!row) return refuse('this signer node holds no send plan for that entry', 404);
    // A COMMITMENT ONLY TO THE PLAN THE ASKER SIGNS FOR - the settlement's own guard (settlement.js `commit`), here for a
    // send: a signer node keeping another plan would otherwise commit, and its share over its own invoice spoils the
    // combined auth for everyone (measured on 5 of 7: 5 nodes took one plan, 2 kept another, and 34 auths came back
    // "does not verify under the claim key"; the winner was never paid).
    if (hash && String(hash).toLowerCase() !== String(row.paymentHash).toLowerCase())
      return refuse('this signer node keeps another send plan for that winning: it commits to no other bytes', 409);
    // WHO ASKS (kanban #2308, #2322): this seat's own pass, a seat of the round signing the ask, or - an ask with no signature, as a seat on an
    // older build sends it - nobody named. Each asker draws from its own bucket below, and a pair is spent only on a list its own asker signs.
    const keptMs = 2 * this.peerAskMs + this.peerGraceMs;
    const now = Number(this.round.now());
    let asker = null;
    if (own) asker = this.ownKey();
    else if (header) {
      if (!/^[0-9a-f]{16,64}$/i.test(String(ask || '')) || !Number.isFinite(Number(askedAt)) || askedAt === null || askedAt === '')
        return refuse('a signed commit ask names its ask id and its time', 400);
      const by = this.askedBy(header, PLAN_ASK.COMMIT, roundIdBytes, built,
        sendCommitAskBody({ kind, entry: entryHex, attempt: row.attempt, hash: hash === null ? String(row.paymentHash) : String(hash), ask, at: askedAt }));
      if (!by.ok) return refuse(`this seat draws a nonce pair only for a seat of the round: ${by.why}`, 403);
      // A REPLAYED ASK IS ONLY ITS OWN PASS'S (the ask id below gives it the same pair); an old one is not taken at all
      if (Math.abs(now - Number(askedAt)) > keptMs) return refuse(`that commit ask is ${now - Number(askedAt)} ms from this seat's clock: ask again`, 409);
      asker = by.who;
    }
    const message = await this.messageFor(kind, roundIdBytes, row, built);
    if (!message) return refuse('this signer node cannot rebuild that message');
    const key = `${kind}:${toHex(roundIdBytes)}:${entryHex}:${row.attempt}`;
    // A FRESH PAIR FOR EVERY ASK (kanban #1806, #2011, the settlement's #1494 and the forfeit's #1521): /send-commit and /send-share answer anyone, and
    // one unspent pair handed to every asker let a stranger ask for it and at once spend it on a list of made-up commitments, so the honest
    // asker's list was refused ("keeps no second pair") at every seat and the winner's auth (or a re-send's txid) never formed. Now each ask
    // draws its own pair, kept by its commitment, and a share spends only the pair its own list carries; a pair that signed a list is spent
    // (kanban #1074) and never signs another. A full pool refuses no commit and a flood pushes out no pair it follows (nonce-pool.js, kanban
    // #2011, #2237); `own` the pair of this seat's own signing.
    // ...AND EACH ASKER HAS ITS OWN POOL (kanban #2308, #2322): one shared cap let a stranger refill the door and every commit - the asker's own one
    // in sign() too - was refused for as long as it kept on. Now this seat's own pass, each seat of the round that signs its ask (PLAN_ASK.COMMIT),
    // and the unsigned asks together each have a pool: a stranger fills only the unsigned one, a seat only its own. A signed pass's ask id gives a
    // replay the same pair, so no one else can fill a seat's pool. Both kinds (auth, resend) and the late sender go through here.
    const askKey = asker !== null && !own && ask ? `${asker}:${String(ask).toLowerCase()}` : null;
    const again = this.pairs.replayed(askKey);
    if (again && toHex(again.message) === toHex(message)) return { ok: true, commitment: again.commitment, message };
    const hiding = nonceGenerate340(this.random(32), built.signerNode.share);
    const binding = nonceGenerate340(this.random(32), built.signerNode.share);
    const commitment = { id: built.signerNode.id, hiding: this.curve.pointFromScalar(hiding), binding: this.curve.pointFromScalar(binding) };
    const kept = this.pairs.add(key, { message, hiding, binding, commitment }, { own, asker: own ? OWN : asker === null ? UNSIGNED : asker, askKey });
    if (!kept.ok) return refuse(kept.why, kept.status);
    return { ok: true, commitment, message };
  }

  /** ROUND TWO: the share over the message this signer node rebuilt, for one commitment list, once. */
  async share(roundIdBytes, entryHex, built, commitments, kind = 'auth', attempt = null, { header = null, own: local = false } = {}) {
    const row = this.rowOf(roundIdBytes, entryHex, attempt);
    if (!row) return refuse('this signer node holds no send plan for that entry', 404);
    const message = await this.messageFor(kind, roundIdBytes, row, built);
    const key = `${kind}:${toHex(roundIdBytes)}:${entryHex}:${row.attempt}`;
    if (!message || !this.pairs.holds(key)) return refuse(`this signer node committed to no ${kind} of that send`);
    // NO LIST LONGER THAN A COMMITTEE (kanban #1672, as at /settle-share): refused before any curve work
    { const why = commitmentListRefusal(commitments, { needed: built.needed, nodes: built.contract && built.contract.nodes }); if (why) return refuse(why); }
    // THE PAIR THE LIST NAMES (kanban #2011): the one whose commitment the list carries, of those this seat handed out for these bytes
    const own = commitments.find((c) => String(c.id) === String(built.signerNode.id));
    const found = own ? this.pairs.get(key, own) : null;
    const pair = found && toHex(found.message) === toHex(message) ? found : null;
    if (!pair) return refuse('that list does not carry this signer node\'s own commitment');
    // ONLY THE ASKER THAT DREW THE PAIR SPENDS IT (kanban #2308, #2322): a seat of the committee handed the asker's list re-posted it to every
    // other seat with only its own commitment swapped, each spent its pair on that list and refused the asker's ("keeps no second pair"), and
    // one seat of seven stopped the send for good. Now a list spends a pair only when the same asker signs it (PLAN_ASK.SHARE over the list's
    // bytes) - or, for a pair drawn by an unsigned ask (a seat on an older build), when the list is unsigned too, as before. Anyone else's
    // list, a peer seat's included, spends nothing.
    let by = null;
    if (!local && header) {
      const checked = this.askedBy(header, PLAN_ASK.SHARE, roundIdBytes, built, encodeCommitments(commitments));
      if (!checked.ok) return refuse(`this seat signs a list only for a seat of the round: ${checked.why}`, 403);
      by = checked.who;
    }
    if (local ? !pair.own : (pair.own || pair.asker !== (by === null ? UNSIGNED : by)))
      return refuse('that list is not signed by the asker this signer node\'s nonce pair was drawn for: it spends nothing', 403);
    if (commitments.length < built.needed) return refuse(`${commitments.length} commitments, and this round's key signs at ${built.needed}`);
    const list = listKey(commitments);
    if (pair.list && pair.list !== list) return refuse(`this signer node signed that ${kind} over another list, and keeps no second pair`, BOUND_ELSEWHERE);
    if (pair.share === null) {
      // A SPENT PAIR KEEPS ITS LIST AND ITS SHARE, NEVER ITS NONCES (the forfeit's #1699)
      if (this.signedKeys.size > 65536) this.signedKeys.clear();
      this.signedKeys.add(key);
      NoncePool.spend(pair, list, signShare340({ id: pair.commitment.id, share: built.signerNode.share, groupPublicKey: built.claimPk,
        nonces: { hiding: pair.hiding, binding: pair.binding }, message, commitments, curve: this.curve }));
    }
    return { ok: true, share: pair.share };
  }

  /**
   * The committee's signature of `kind` over one attempt, made here with the peers: every peer asked at once within a bound (kanban #1074 as #1061), and a
   * seat that gave no share, or one that does not stand, left off the next list while the threshold remains (as #1070), asked again at once.
   *
   * ONE SIGNING PER SEND AT A TIME (kanban #1489, #1910 - as settle() with #settling): two passes of this seat at once (settle() and the winnings
   * timer both reaching sendAll) shared its one slot at every peer (nonce-pairs.js), each with its own SELF commitment, so each peer signed the first
   * list and refused the other ("keeps no second pair"). A second signing of the same send while one runs waits for that one's answer.
   */
  async sign(roundIdBytes, row, built, kind) {
    const k = `${kind}:${toHex(roundIdBytes)}:${toHex(row.entryId)}:${row.attempt}:${String(row.paymentHash).toLowerCase()}`;
    if (this.#signing.has(k)) return this.#signing.get(k);
    const p = this.#signOnce(roundIdBytes, row, built, kind).finally(() => this.#signing.delete(k));
    this.#signing.set(k, p);
    return p;
  }
  #signing = new Map();    // `${kind}:${round}:${entry}:${attempt}:${hash}` -> the running signing's answer (kanban #1910)

  async #signOnce(roundIdBytes, row, built, kind) {
    const entryHex = toHex(row.entryId);
    const q = `round=${toHex(roundIdBytes)}&entry=${entryHex}&kind=${kind}&attempt=${row.attempt}&hash=${row.paymentHash}${this.scopeParam}`;
    this.lists.begin(q);
    for (;;) {
      const own = await this.commit(roundIdBytes, entryHex, built, kind, row.attempt, { own: true });
      if (!own.ok) return own;
      const message = own.message;
      // THIS PASS'S ASK, SIGNED BY THIS SEAT'S NODE KEY (kanban #2308, #2322): each peer keeps the pair it draws for this seat, in this seat's
      // own bucket, and spends it only on the list this seat signs
      // (a seat with no node key - a test's stub store - asks unsigned, the same bytes as before)
      let headers = {};
      let cq = q;
      if (this.ownKey()) {
        const ask = toHex(this.random(32)).slice(0, 32);
        const askedAt = Number(this.round.now());
        headers = sendPlanAskHeaders(this.round, { kind: PLAN_ASK.COMMIT, roundId: roundIdBytes, lateEntryId: this.round.lateEntryId || null,
          body: sendCommitAskBody({ kind, entry: entryHex, attempt: row.attempt, hash: String(row.paymentHash), ask, at: askedAt }) });   // the hash as the query carries it
        cq = `${q}&ask=${ask}&at=${askedAt}`;
      }
      const asked = await askPeers(this.peersFor(roundIdBytes), async (base, signal) => {
        const r = await this.fetcher(`${base}/send-commit?${cq}`, { method: 'POST', headers, signal });
        return r.ok ? { commitment: decodePeerCommitment(new Uint8Array(await r.arrayBuffer())) } : null;   // its nonces are points, or it is refused (kanban #2331, #2345)
      }, { boundMs: this.peerAskMs, graceMs: this.peerGraceMs, enough: built.needed - 1, counts: (x) => !!(x && x.commitment) });
      const signers = [{ base: null, commitment: own.commitment }];
      // A COMMITMENT UNDER ANOTHER SIGNER'S ID IS NOT LISTED (kanban #2402, #2471, as settlement.js #peerCommitments)
      for (const { peer: base, value } of leftOffLast(asked, this.lists.withheld.get(q)))
        if (value && value.commitment && !peerCommitmentRefusal(value.commitment, signers)) signers.push({ base, commitment: value.commitment });
      if (signers.length < built.needed) return refuse(`${signers.length} of ${built.needed} signer nodes committed to the ${kind}`);
      const listed = this.lists.listed(q, signers, built.needed);
      const combined = await this.#gatherShares(roundIdBytes, entryHex, built, kind, row.attempt, q, message, listed);
      if (combined.ok) { this.lists.done(q); return combined; }
      // A SEAT THAT GAVE NO SHARE IS LEFT OUT; A LIST POISONED BY A LISTED SEAT (423) TRIES THE LISTS THAT LEAVE OUT WHO READ IT (nonce-pool.js, kanban #2011)
      if (!this.lists.again(q, combined, listed, built.needed, this.peersFor(roundIdBytes))) return combined;
    }
  }

  /**
   * ROUND TWO, BEHIND THE #1807 GUARD (kanban #2369, #2372; settlement.js #gatherShares): each peer under its own id, checked before any share is asked.
   * A peer that answered /send-commit under this seat's id, or under one outside the committee, is withheld at once; of two naming one id only the first
   * stays on this list and the others are set aside for this pass. A list that still fails with no seat named names the kept claimants, and a list
   * that throws (signShare340, aggregate340) is a refusal, never an abort - before, one seat under another's id made this seat's own share refuse
   * ('names a participant twice') with nobody withheld, and every pass of the winner's auth stopped the same way.
   */
  async #gatherShares(roundIdBytes, entryHex, built, kind, attempt, q, message, signers) {
    const misnamed = misnamedSigners(signers, built.contract && built.contract.nodes);
    if (misnamed.out.length) return { ...refuse(`${misnamed.out[0]} committed under an id that is not its own on this ${kind} list`), withheld: misnamed.out };
    const list = misnamed.aside.length ? signers.filter((s) => !misnamed.aside.includes(s.base)) : signers;
    let got;
    try { got = await this.#gatherChecked(roundIdBytes, entryHex, built, kind, attempt, q, message, list); }
    catch (e) { got = { ...refuse(`the ${kind} list could not be signed: ${e.message}`, 500), withheld: [] }; }
    if (!got.ok && misnamed.kept.length && !(got.withheld && got.withheld.length)) got = { ...got, withheld: misnamed.kept };
    return got;
  }

  /** ROUND TWO: every seat on the list gives its share, all at once within the bound; a refusal names in `withheld` the seats that gave none or whose share does not stand. */
  async #gatherChecked(roundIdBytes, entryHex, built, kind, attempt, q, message, signers) {
    const commitments = signers.map((x) => x.commitment).sort((x, y) => x.id - y.id);
    const mine = await this.share(roundIdBytes, entryHex, built, commitments, kind, attempt, { own: true });
    if (!mine.ok) return mine;
    const body = encodeCommitments(commitments);
    // SIGNED BY THIS SEAT (kanban #2308, #2322): the list spends only the pairs this seat's own commit asks drew
    const headers = sendPlanAskHeaders(this.round, { kind: PLAN_ASK.SHARE, roundId: roundIdBytes, lateEntryId: this.round.lateEntryId || null, body });
    const peers = signers.filter((x) => x.base !== null);
    const asked = await askPeers(peers.map((x) => x.base), async (base, signal) => {
      const r = await this.fetcher(`${base}/send-share?${q}`, { method: 'POST', body, headers, signal });
      if (!r.ok) return { status: r.status, why: (await r.text()).trim() };
      return { share: decodeShare(new Uint8Array(await r.arrayBuffer())) };
    }, { boundMs: this.peerAskMs });
    // A PAIR SPENT ON ANOTHER LIST (kanban #2011, the forfeit's #1699): `poisoned`, and the seat refusing is not at fault
    const failed = sharesRefused(asked, `${kind} share`);
    if (failed) return failed;
    const shares = [mine.share, ...asked.map((x) => x.value.share)];
    const { signature } = aggregate340({ commitments, message, groupPublicKey: built.claimPk, shares, curve: this.curve });
    if (schnorr.verify(signature, message, built.claimPk.subarray(1))) return { ok: true, signature };
    const held = this.dkg && this.dkg.publicSharesFor && built.contract ? this.dkg.publicSharesFor(built.contract.nodes) : null;
    // an id with no public share, or a check that throws, does not stand (signer-guard.js spoiltShares, kanban #2369)
    const spoilt = spoiltShares({ signers: peers, shares: asked.map((x) => x.value.share), held, m: { claimPk: built.claimPk, message }, commitments, curve: this.curve });
    return { ...refuse(`the ${kind} signature does not verify under the claim key`), withheld: spoilt.map((x) => x.base) };
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
   * ONE PASS PER ROUND AT A TIME (kanban #1910): settle() and the winnings timer both reach it for one round; a second pass while one runs waits for
   * that one's answer, so the two never sign, mark or re-send the same rows side by side.
   */
  async sendAll(roundIdBytes, built) {
    const k = toHex(roundIdBytes);
    if (this.#sending.has(k)) return this.#sending.get(k);
    const p = this.#sendAllOnce(roundIdBytes, built).finally(() => this.#sending.delete(k));
    this.#sending.set(k, p);
    return p;
  }
  #sending = new Map();    // round id hex -> the running pass's answer (kanban #1910)

  async #sendAllOnce(roundIdBytes, built) {
    const out = [];
    for (const row of this.round.sendPlansOf(roundIdBytes)) {
      const entryHex = toHex(row.entryId);
      if (row.state === PAID) { out.push({ entry: entryHex, attempt: row.attempt, state: PAID, already: true }); continue; }
      // A HELD DONATION SHARE: kept under the committee key, and the same recipient asked again - once it answers, the
      // re-send spends the held contract into the send to its invoice (the next pass funds and pays it).
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
      const a = await this.sign(roundIdBytes, row, built, 'auth');
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

/**
 * A plan's order key: its payment hashes, sorted and joined. Two plans for one round compare by it.
 * A HELD ROW SORTS BELOW EVERY INVOICE, AND MORE HELD ROWS LOWER (kanban #1782, wf1489 sm2-settle-2): a held row has no
 * payment hash (''), and joined as '' the all-held plan's key was ':' (0x3a) - ABOVE every plan whose lowest hash starts
 * with 0-9. Hole 1 (a)'s plan with the unreachable recipients held then never replaced the first plan at the seats that
 * kept it (check, adoptPeerPlan: only a lower key does), the seats that cannot reach the recipient refused the first one,
 * and the walk-away never settled. A held row now counts as '!' (0x21, below '0' and ':'; never a hex hash), so the plan
 * the unreachable seats can take is the one every seat gives way to. Equal plans keep equal keys.
 */
export function planKey(rows) {
  return rows.map((r) => String(r.paymentHash).toLowerCase() || '!').sort().join(':');
}
