// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BALLOT READ OFF THE CHAIN, AND ACTIVATION (spec §27A.7.3, §27A.7.5), the second slice.
//
//   VOTES      every OP_RETURN output of a block whose push is a 77-byte "ARN" 'V' vote (ballot.js decodeVote), with the height and
//              txid the tally needs - the tally then decides which bond, which phase, which one is last
//   ACTIVATION the config live at a height: from genesis, each PASSED proposal at its activation_height, in order of height (ties:
//              lower proposal id). "parent serialises competing proposals. Both may pass; the first to activate becomes the
//              config, and the second is void at its activation height because its parent is no longer current" (§27A.7.2)
//
//   DEPOSIT    a proposal's deposit_txid, read off its transaction (RULED 2026-10-13, option A): one P2TR output per share
//              of the network's KEYED donation set, split as a donation is (share_bps floored, the remainder to the first as
//              published), each output key the recipient key's x-only form, untweaked - the recipient spends it with the key it
//              already holds, and checking it needs no curve. The height it confirmed at is the proposal's publication (§27A.7.3:
//              the census is snapshotted there). A network whose set pays LNURLs takes no proposal until it publishes a keyed set.
//
// What is live is a pure function of the passed proposals and a height; which proposals passed is the tally's.
import { splitBlock } from './block.js';
import { parseTransaction, commitmentsOf } from './tx.js';
import { decodeVote } from './ballot.js';
import { toHex, fromHex } from './hash.js';
import { splitDonation, donationSetPaysKeys } from './donation.js';

/** The vote outputs of one raw block at `height`: [{ payload, height, txid }], txid hex in Bitcoin's display order. */
export function votesInBlock(raw, height) {
  const out = [];
  for (const t of splitBlock(raw).transactions) {
    let tx; try { tx = parseTransaction(t); } catch { continue; }
    for (const payload of commitmentsOf(tx)) {
      if (!decodeVote(payload)) continue;
      out.push({ payload, height, txid: toHex(Uint8Array.from(tx.txid).reverse()) });
    }
  }
  return out;
}

/**
 * THE CONFIG LIVE AT `height`. `genesis`: { configHash, config }; `passed`: [{ id, parent, configHash, config, activationHeight }]
 * - proposals the tally passed. Answers { configHash, history: [{ configHash, config, since, by }], void: [{ id, why }] };
 * `history` (genesis first) is what isRepeal reads.
 */
export function liveConfig({ genesis, passed = [], height }) {
  const history = [{ configHash: genesis.configHash, config: genesis.config, since: 0, by: null }];
  const voided = [];
  const due = passed.filter((p) => p.activationHeight <= height)
    .sort((a, b) => (a.activationHeight - b.activationHeight) || (toHex(a.id) < toHex(b.id) ? -1 : 1));
  for (const p of due) {
    const current = history[history.length - 1];
    if (toHex(p.parent) !== toHex(current.configHash)) {
      voided.push({ id: p.id, why: `its parent ${toHex(p.parent).slice(0, 16)} is not the config live at ${p.activationHeight} (${toHex(current.configHash).slice(0, 16)})` });
      continue;
    }
    history.push({ configHash: p.configHash, config: p.config, since: p.activationHeight, by: p.id });
  }
  return { configHash: history[history.length - 1].configHash, history, void: voided };
}

/**
 * WHERE THE BALLOT'S CHAIN OF CONFIGS STARTS (§27A.6, §27A.7.8), on every network this build knows. `genesis_config_hash`
 * (bbae68dc, genesis-ids.js) is where the network's chain of configs began, and it stays that; three rulings (§27A.7.8,
 * FEDERATION.md "Rulings") then moved the config new rounds name to 2170f250 - the truck's v4 - and §27A.7.8 says the interim
 * "is replaced by §27A.7 as soon as those are built". So the ballot carries on from the config the rulings left live: it is
 * history[0], since height 0, by nobody. A choice, named: the configs ruled before it (bbae68dc, dbb49344, f51759b6) have no
 * ballot record, so no repeal reaches them as ancestors - a repeal goes back only to configs the ballot itself held live.
 *
 * WRITTEN OUT, NOT COMPUTED: the bytes are nextblock's encodeGameConfigV4 (nextblock/config/game-config.js), and the engine
 * imports no game. nextblock/test/ballot-genesis.test.js holds them to that encoder and the hash to the
 * config every truck round names (TRUCK_CURRENT_CONFIG). While no proposal has passed, this is the only entry of the history,
 * and every round is served exactly as before (configServesRound below answers `governed` only for configs the ballot named).
 */
export const BALLOT_GENESIS = Object.freeze({
  configHash: fromHex('2170f25079f5652ba0633f4b44032c1c9b4dac094e6df99dd001e74b5586293d'),
  config: fromHex('040140000000220000001600000024000000004000000180000000000103042a3000c800004ccd00003333000080000000385200000708000004b000001c20010000b333000000060101'),
});

/** The history as spans: each entry live from its `since` up to (not including) the next one's. */
const spansOf = (history) => (history || []).map((h, i) => ({ ...h, until: i + 1 < history.length ? history[i + 1].since : Infinity }));

/**
 * MAY A ROUND NAMING `configHash`, CREATED AT `height`, BE SERVED (§27A.7.5)? "A round is bound to the config it was created
 * under": a config the ballot's history names is served for the rounds created while it was live - the one live now for the
 * rounds created since its activation, an earlier one for the rounds created before an activation, which keep it to the end -
 * and for no other round. A config the history never named is not the ballot's (another game's config, a frozen core's pair
 * kept by ruling, §27A.7.8): answered `governed: false` and left to the doors that served it before.
 *
 * `height` is the round's census height: the census is chain state at the round's making (§5A.2), every round names one,
 * and a series' rounds share their template's - so a series published before an activation keeps its config for all of its
 * rounds, and "a paid series [changes] only from the next series published" (§27A.7.8). A creator naming an old census height
 * names the config live at it; the census lookback bounds how old (main.js CENSUS_LOOKBACK).
 *
 * `history`: liveConfig's, computed over every passed proposal (with no height cut), so a config that is not live YET is
 * refused for the rounds created before its activation too.
 */
export function configServesRound({ configHash, height, history }) {
  if (!(configHash instanceof Uint8Array) || configHash.length !== 32) return { ok: false, governed: false, why: 'that round names no 32-byte config' };
  const want = toHex(configHash);
  const spans = spansOf(history);
  const mine = spans.filter((s) => toHex(s.configHash) === want);
  if (!mine.length) return { ok: true, governed: false };
  if (mine.some((s) => s.since <= height && height < s.until)) return { ok: true, governed: true };
  const live = spans.find((s) => s.since <= height && height < s.until);
  const when = mine.map((s) => (s.until === Infinity ? `from ${s.since}` : `${s.since} to ${s.until - 1}`)).join(', ');
  return { ok: false, governed: true, live: live ? live.configHash : null,
    why: `that round, created at census height ${height}, names config ${want.slice(0, 16)}, which the ballot made live for rounds created ${when}; `
      + `the config live at ${height} is ${live ? toHex(live.configHash).slice(0, 16) : '(none)'} - a round is bound to the config it was created under (27A.7.5)` };
}

/**
 * THE CONFIG A ROUND CREATED AT `height` NAMES, for its creator (§27A.7.5): `wanted` when it is served there (a config the
 * ballot never named stays the creator's choice), else the config the ballot made live at that height - so a round created
 * after an activation names the new hash, and nobody types it.
 */
export function configForNewRound({ wanted, height, history }) {
  const got = configServesRound({ configHash: wanted, height, history });
  if (got.ok) return wanted;
  return got.live || wanted;
}

/** The P2TR script a deposit share pays: OP_1 PUSH32 the recipient key's x-only form (its 33-byte key without the parity byte). */
export const depositScriptOf = (recipientPk) => Uint8Array.from([0x51, 0x20, ...recipientPk.subarray(1)]);

/**
 * WHAT A DEPOSIT OF `depositSats` PAYS (option A): [{ recipientPk, script, sats }], one per share above 0 - for a proposer's wallet
 * to build, and for depositOf to check. Refused by name for a set that pays LNURLs.
 */
export function depositOutputsExpected(depositSats, recipients) {
  if (!Array.isArray(recipients) || !donationSetPaysKeys(recipients))
    return { ok: false, why: 'that network\'s donation set pays LNURLs: a proposal deposit is a Bitcoin output per key, so it takes no proposal until it publishes a keyed set' };
  // the same split as a donation, in whole sats: splitDonation is unit-free (floors by share_bps, the remainder to the first)
  const split = splitDonation({ donationMsat: BigInt(depositSats), recipients });
  if (!split.owed) return { ok: false, why: split.why };
  return { ok: true, outputs: split.shares.filter((sh) => sh.amountMsat > 0n)
    .map((sh) => ({ recipientPk: sh.recipientPk, script: depositScriptOf(sh.recipientPk), sats: sh.amountMsat })) };
}

/**
 * A PROPOSAL'S DEPOSIT, READ OFF ITS TRANSACTION. `raw`: the deposit transaction; `height`: the block it confirmed in. The deposit
 * is everything it pays to the set's keys, and each key must be paid at least its share of that sum - so the split is exact.
 * Answers { ok, publishedAt, depositSats } - what proposalStands takes - or { ok: false, why }.
 */
export function depositOf({ raw, height, proposal, recipients }) {
  let tx; try { tx = parseTransaction(raw); } catch (e) { return { ok: false, why: `that is no transaction: ${e.message}` }; }
  if (!proposal || !(proposal.depositTxid instanceof Uint8Array) || toHex(Uint8Array.from(tx.txid)) !== toHex(proposal.depositTxid))
    return { ok: false, why: 'that transaction is not the deposit the proposal names (deposit_txid)' };
  if (!Number.isInteger(height) || height < 0) return { ok: false, why: 'a deposit counts once it is confirmed at a height' };
  if (!Array.isArray(recipients) || !donationSetPaysKeys(recipients)) return depositOutputsExpected(0, recipients);
  const paid = new Map(recipients.map((r) => [toHex(depositScriptOf(r.recipientPk)), 0n]));
  for (const o of tx.outputs) {
    const k = toHex(o.script);
    if (paid.has(k)) paid.set(k, paid.get(k) + BigInt(o.value));
  }
  const total = [...paid.values()].reduce((a, b) => a + b, 0n);
  if (total === 0n) return { ok: false, why: 'that transaction pays nothing to the network\'s donation set' };
  const want = depositOutputsExpected(total, recipients);
  if (!want.ok) return want;
  for (const o of want.outputs) {
    const got = paid.get(toHex(o.script));
    if (got < o.sats) return { ok: false, why: `a deposit of ${total} sat owes ${toHex(o.recipientPk).slice(0, 16)} ${o.sats} sat, and it is paid ${got}: not the set's split` };
  }
  return { ok: true, publishedAt: height, depositSats: total };
}
