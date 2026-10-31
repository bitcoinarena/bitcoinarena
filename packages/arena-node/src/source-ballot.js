// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SOURCE PROPOSED FROM THE OWNER'S PAGE (kanban #921, spec 27A.7): the deposit, then, with it confirmed, the proposal this node's key signs. Neither step keeps
// anything here: the page holds the entry and the deposit's txid, and each step reads the example again, so nothing goes out on a read that stopped answering.
// A wallet is the bond wallet of a seat set up by hand (ARENA_BOND_CLI). A node without one answers what to pay and what to send, and the owner pays from any wallet.
import { CLASS, encodeConfigProposalBody, proposalBodyId, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected } from '../../arena-protocol/src/ballot-chain.js';
import { encodeSourceList, hostListProblem } from '../../arena-protocol/src/market-check.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';

// a smaller output is dust: no node relays it
const DUST_SATS = 330n;

/** The new list and the deposit it costs, or { ok: false, why }. `live`: GET /market-sources. `capSats`: the most a deposit may be, which is what it pays. */
export function sourcePlan({ entry, live, recipients, capSats }) {
  const bad = hostListProblem(encodeSourceList([entry]));
  if (bad) return { ok: false, why: bad };
  if (live.hosts.includes(entry.host)) return { ok: false, why: `${entry.host} is already listed` };
  const config = encodeSourceList([...live.entries, entry]);
  const want = depositOutputsExpected(capSats, recipients);
  if (!want.ok) return want;
  const small = want.outputs.find((o) => o.sats < DUST_SATS);
  if (small) return { ok: false, why: `A deposit of ${capSats} sat splits into outputs below ${DUST_SATS} sat, which no node relays` };
  return { ok: true, config, configHash: toHex(configHashOf(config)), parent: live.configHash, depositSats: String(capSats),
    outputs: want.outputs.map((o) => ({ script: toHex(o.script), sats: String(o.sats) })) };
}

/** The deposit, sent from the bond wallet. */
export function payDeposit({ cli, plan }) {
  const outputs = {};
  for (const o of plan.outputs) outputs[JSON.parse(cli('decodescript', o.script)).address] = Number(o.sats) / 1e8;
  return JSON.parse(cli('-named', 'send', `outputs=${JSON.stringify(outputs)}`, 'fee_rate=2')).txid;
}

/** The block a wallet's deposit confirmed in, or null while it has none. */
export function depositBlock({ cli, txid }) {
  const t = JSON.parse(cli('gettransaction', txid));
  return Number(t.confirmations) >= 1 ? t.blockhash : null;
}

/** The proposal, signed: hex of body || signature. `activationHeight` is the earliest its schedule allows. */
export function signedProposal({ plan, net, txid, proposer, height, schedule, sign }) {
  const s = schedule[CLASS.SOURCES];
  const p = { networkId: fromHex(net), parent: fromHex(plan.parent), configHash: fromHex(plan.configHash), config: plan.config, class: CLASS.SOURCES,
    activationHeight: height + s.review + s.voting + s.cooldown, proposer, depositTxid: fromHex(txid).reverse() };
  return toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...sign(proposalBodyId(p))]));
}
