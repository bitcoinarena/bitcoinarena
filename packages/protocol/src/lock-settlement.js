// THE ROUND'S ONE SETTLEMENT OF STAKE LOCKS (FEDERATION.md, money flow step 5;
// W4 - the owner 2026-09-14 07:22: "a loser loses the stake. The lock is claimed
// into the pool. Winners are paid from that.").
//
// THE VERDICT IS THE HOLD PATH'S OWN. `holdSettlement` over one payout table
// decides each entry, so a lock round and a hold round cannot decide the same
// round differently:
//   SETTLE   a loser's stake lock, claimed as an input (`Claim(P)`)
//   CANCEL   a qualifier's own lock, forfeited back to them (forfeit.js, W5b)
//   NOTHING  the lock is left to expire back to its player (VOID, a Delivered run
//            below the score)
// The outputs are one PRE-EXPIRED payout contract per qualifier owed a share:
// `refund_pk` = the key that qualifier's own stake lock names, so only they can
// ever move it (FEDERATION.md source audit, point 2). A qualifier's own stake is
// not in it - that half comes back by the forfeit (`winnings`, as on a hold).
//
// THE GUARDIANS' FEES, AND WHO BEARS THEM. Every input and every output pays
// `base + amount * ppm / 1e6` (lnv2-common config.rs), read from the federation
// (`blwp-stake-lock --mode fees`). They come out of the pool pro rata to what
// each qualifier is owed: target = floor(owed * spendable / pool), then the
// largest payout with payout + fee(payout) <= target. What the floors leave is no
// output and stays with the guardians as fee; a share too small to pay its own
// output fee is reported unpaid, not bumped from anyone else's.
//
// ONE TRANSACTION EVERY SIGNER NODE REBUILDS BYTE FOR BYTE: inputs sorted by outpoint,
// payouts by payout key, and the nonce derived from the round id - so the signer nodes
// sign one txid, and a signer node signs only the txid it rebuilt itself.
// AND THE FEE LOCKS (Pick A, the owner 2026-09-14): every counted entry's fee lock -
// winners' too, the fee is owed whatever the result (F5) - claimed with its F,
// handed over openly at entry, in the same transaction and the same signature.
// They pay the round's SITTING SIGNER NODES by §22A's own weights (`nodeFeeTable`: 1% to
// the game/verify pool, 1% to the settlement pool, per eligible signer node, leftovers in
// the round's order), each signer node one pre-expired payout contract to its own key -
// never to the donation recipients, and no split invented here. A VOID or
// ENTRY_VOID entry's fee lock is not claimed: §22A's fee base leaves it out.
import { holdSettlement, netStakeMsat, isRefund, SETTLE, CANCEL, FAILED } from './payout.js';
import { winnings } from './payout-spend.js';
import { nodeFeeTable, entryFeeMsat, GAME_VERIFY, SETTLEMENT } from './fee.js';
import { MIN_PLAYERS_PER_ROUND } from './constants.js';
import { refundKeyOf } from './stake-lock.js';
import { sha256, toHex, fromHex } from './hash.js';

const refuse = (why) => ({ ok: false, why });
const outpointKey = (o) => `${toHex(o.txid)}:${String(o.outIdx)}`;

/** The guardians' LNv2 fee on one input or output, in msat. */
export function lnv2FeeMsat({ ppm, baseMsat }, msat) {
  return baseMsat + (msat * ppm) / 1000000n;
}

/** The largest payout whose value and its own fee fit in `target`. */
export function largestPayoutMsat(fees, target) {
  if (target <= fees.baseMsat) return 0n;
  let x = ((target - fees.baseMsat) * 1000000n) / (1000000n + fees.ppm);
  while (x + 1n + lnv2FeeMsat(fees, x + 1n) <= target) x++;
  while (x > 0n && x + lnv2FeeMsat(fees, x) > target) x--;
  return x;
}

const NONCE_TAG = new TextEncoder().encode('blwp lock settlement v1');

/** The settlement transaction's 8-byte nonce: one per round, the same at every signer node. */
export function settlementNonce(roundId) {
  if (!(roundId instanceof Uint8Array) || roundId.length !== 32) throw new Error('a round id is 32 bytes');
  const m = new Uint8Array(NONCE_TAG.length + 32);
  m.set(NONCE_TAG); m.set(roundId, NONCE_TAG.length);
  return sha256(m).subarray(0, 8);
}

/**
 * @param {object} o
 * @param {Uint8Array} o.roundId
 * @param {object[]} o.entries  computePayoutTable's entries: pubkey, stakeMsat, feeMsat, donationMsat, outcome, score
 * @param {bigint} [o.minScore]
 * @param {Map<string, {outpoint: {txid: Uint8Array, outIdx: bigint|number}, amountMsat: bigint, refundPk: Uint8Array}>} o.locks
 *        every verified stake lock, keyed by the player's pubkey hex
 * @param {{ppm: bigint, baseMsat: bigint}} o.fees  the guardians' LNv2 fee rule
 */
// `sends`: WINNINGS ALWAYS SENT (the owner 2026-09-21; ruled for FEDERATION 2026-09-23). A qualifier with an accepted
// send plan (protocol/winnings-send.js) is paid by an outgoing contract the plan's gateway may claim only by paying
// the winner's invoice, refunding to the round's committee claim key - not by the pre-expired contract only the
// winner's key can move. Keyed by player key hex: { paymentHash, gatewayPk, refundPk, expiration }.
//
// `addressed`: THE POOL (RULED 2026-09-23, (ii) with (iii)). The qualifiers - by player key hex - who named a
// Lightning address. Only they are paid. An unaddressed qualifier's share is folded back into the round's pot and
// split over the addressed ones by the payout table's own weights, renormalised over that set; the dust the msat
// division leaves goes to the first addressed row in the table's order, so nothing claimed is left to the
// guardians as a remainder. With nobody addressed no loser's stake lock is claimed: each expires back to its
// player. Left out, the addressed set is the qualifiers with a send - no address is ever implied.
// `requireSends`: the plan that is signed. An addressed qualifier without an accepted send is refused, never paid
// by a contract only its key can move.
export function lockSettlement({ roundId, entries, minScore = 0, locks, fees, feeLocks = new Map(), signerNodes = null, contract = null,
  sends = new Map(), addressed = null, requireSends = false }) {
  if (!(locks instanceof Map)) return refuse('the verified stake locks are a Map by player key');
  if (!(feeLocks instanceof Map)) return refuse('the verified fee locks are a Map by player key');
  if (!fees || typeof fees.ppm !== 'bigint' || typeof fees.baseMsat !== 'bigint' || fees.ppm < 0n || fees.baseMsat < 0n)
    return refuse('the guardians\' fee rule is BigInt ppm and base msat, 0 or more');
  const feePart = feeSettlement({ entries, feeLocks, signerNodes, contract, fees });
  if (!feePart.ok) return feePart;
  // THE STAKE PART'S VERDICT IS THE HOLD PATH'S. A round with losers and nobody to
  // pay is refused there ("the operator would keep ..."), and so its stakes are not
  // claimed here either - but its fee locks still are: the fee is owed.
  let h;
  try { h = holdSettlement({ roundId, entries, minScore }); } catch (e) {
    if (!feePart.claims.length) return refuse(e.message);
    return finish({ roundId, claims: [], payouts: [], unpaid: [], forfeits: [], poolMsat: 0n, inputFeesMsat: 0n, spendableMsat: 0n, stakeWhy: e.message }, feePart);
  }

  const lockOf = (e) => locks.get(toHex(e.pubkey));
  const claims = [];
  for (const a of h.actions) {
    if (a.action !== SETTLE) continue;
    const lock = lockOf(a.entry);
    if (!lock) return refuse(`a loser's stake lock was never verified, so it cannot be claimed: ${toHex(a.entry.pubkey).slice(0, 16)}`);
    const net = netStakeMsat(a.entry);
    if (lock.amountMsat !== net)
      return refuse(`a loser's lock holds ${lock.amountMsat} msat and its entry's net stake is ${net}`);
    claims.push({ pubkey: a.entry.pubkey, outpoint: lock.outpoint, amountMsat: net });
  }
  const forfeits = h.actions.filter((a) => a.action === CANCEL).map((a) => a.entry.pubkey);
  if (!claims.length && !feePart.claims.length)
    return { ok: true, nothing: true, why: 'no loser\'s lock is claimed in this round', claims, payouts: [], unpaid: [], forfeits,
      poolMsat: 0n, inputFeesMsat: 0n, spendableMsat: 0n, paidMsat: 0n, outputFeesMsat: 0n, unspentMsat: 0n,
      feePoolMsat: 0n, signerNodePayouts: [], feeClaims: [] };
  if (!claims.length)
    return finish({ roundId, claims: [], payouts: [], unpaid: [], forfeits, poolMsat: 0n, inputFeesMsat: 0n, spendableMsat: 0n,
      stakeWhy: 'no loser\'s lock is claimed in this round' }, feePart);

  const owed = winnings({ table: h.table.table, stakes: h.table.activated });
  if (!owed.ok) return refuse(owed.why);
  const poolMsat = claims.reduce((s, c) => s + c.amountMsat, 0n);
  if (owed.owedMsat !== poolMsat)
    return refuse(`the table hands out ${owed.owedMsat} msat and the claimed locks hold ${poolMsat}`);
  for (const row of owed.rows) {
    const e = h.table.activated.find((x) => toHex(x.pubkey) === toHex(row.pubkey));
    if (!e || !lockOf(e)) return refuse(`a qualifier's stake lock was never verified, so there is no key to pay: ${toHex(row.pubkey).slice(0, 16)}`);
  }
  const sendOf = (row) => (sends instanceof Map ? sends.get(toHex(row.pubkey)) : null) || null;
  const named = addressed instanceof Set ? addressed : new Set(sends instanceof Map ? sends.keys() : []);
  // THE UNADDRESSED ARE NOT PAID: their rows leave the split, and what they were owed stays in the pot.
  const pooled = owed.rows.filter((r) => !named.has(toHex(r.pubkey)))
    .map((r) => ({ pubkey: r.pubkey, owedMsat: r.msat, why: 'it named no Lightning address, so its share is split over the qualifiers who did' }));
  let paying = owed.rows.filter((r) => named.has(toHex(r.pubkey)));
  const inputFeesMsat = claims.reduce((s, c) => s + lnv2FeeMsat(fees, c.amountMsat), 0n);
  const spendableMsat = poolMsat - inputFeesMsat;
  const unpaid = [...pooled];
  const nobody = (why) => finish({ roundId, claims: [], payouts: [], unpaid, forfeits, poolMsat: 0n, inputFeesMsat: 0n, spendableMsat: 0n,
    stakeWhy: why }, feePart);
  // (iii): NOBODY TO SEND TO, NOTHING CLAIMED. The losers' locks expire back to them; the fee part still settles.
  // An addressed qualifier outside the paying ranks has no weight in the table, so it cannot carry the pooled
  // shares either: renormalised over weights that sum to nothing there is no split, and none is invented.
  if (!paying.length) return nobody('no qualifier with a paying rank named a Lightning address, so no loser\'s lock is claimed and each expires back to its player');
  if (spendableMsat <= 0n) return refuse(`the guardians' fees on the claimed locks (${inputFeesMsat} msat) take the whole pool of ${poolMsat}`);

  // THE TABLE'S WEIGHTS OVER THE ADDRESSED SET. A row whose share cannot pay its own output fee leaves the split
  // too - its share folds back like an unaddressed one - and the rest is split again.
  let split;
  for (;;) {
    const weight = paying.reduce((s, r) => s + r.msat, 0n);
    split = paying.map((r) => ({ row: r, msat: largestPayoutMsat(fees, (r.msat * spendableMsat) / weight) }));
    const small = split.filter((x) => x.msat === 0n);
    if (!small.length) break;
    for (const x of small) unpaid.push({ pubkey: x.row.pubkey, owedMsat: x.row.msat, why: 'its share does not pay its own output fee' });
    paying = paying.filter((r) => !small.some((x) => x.row === r));
    if (!paying.length) return nobody('no addressed qualifier\'s share pays its own output fee, so no loser\'s lock is claimed and each expires back to its player');
  }
  // THE DUST TO THE FIRST ADDRESSED ROW of the table's own order: the payouts and their fees are the whole spendable pot.
  const gross = (msat) => msat + lnv2FeeMsat(fees, msat);
  const dust = spendableMsat - split.reduce((s, x) => s + gross(x.msat), 0n);
  if (dust > 0n) split[0].msat = largestPayoutMsat(fees, gross(split[0].msat) + dust);

  const payouts = [];
  for (const { row, msat } of split) {
    const send = sendOf(row);
    // A SEND PLANNED FOR ANOTHER AMOUNT IS NOT BUILT ON: its invoice was sized for that payout, not this one.
    if (send && send.payoutMsat !== undefined && BigInt(send.payoutMsat) !== msat)
      return refuse(`a send was planned for a ${send.payoutMsat} msat payout and this signer node's payout is ${msat}: ${toHex(row.pubkey).slice(0, 16)}`);
    if (send) {
      payouts.push({ pubkey: row.pubkey, payoutPk: send.refundPk, owedMsat: row.msat, msat, feeMsat: lnv2FeeMsat(fees, msat),
        sent: { paymentHash: String(send.paymentHash).toLowerCase(), gatewayPk: String(send.gatewayPk).toLowerCase(),
          expiration: BigInt(send.expiration) } });
      continue;
    }
    if (requireSends) return refuse(`an addressed qualifier has no accepted send, so nothing is built: ${toHex(row.pubkey).slice(0, 16)}`);
    // THE BASE PLAN the send plans are sized from; never signed (requireSends).
    const e = h.table.activated.find((x) => toHex(x.pubkey) === toHex(row.pubkey));
    payouts.push({ pubkey: row.pubkey, payoutPk: lockOf(e).refundPk, owedMsat: row.msat, msat, feeMsat: lnv2FeeMsat(fees, msat) });
  }
  return finish({ roundId, claims: claims.map((c) => ({ ...c, kind: 'stake' })), payouts: payouts.map((p) => ({ ...p, kind: p.sent ? 'sent' : 'qualifier' })),
    unpaid, forfeits, poolMsat, inputFeesMsat, spendableMsat, stakeWhy: null }, feePart);
}

const byOutpoint = (a, b) => (outpointKey(a.outpoint) < outpointKey(b.outpoint) ? -1 : outpointKey(a.outpoint) > outpointKey(b.outpoint) ? 1 : 0);
// BY PAYOUT KEY, and among sent winnings - which all refund to the one committee key - by payment hash, so every
// signer node lists the same outputs in the same order.
const payoutOrderKey = (p) => `${toHex(p.payoutPk)}:${p.sent ? p.sent.paymentHash : ''}`;
const byPayoutPk = (a, b) => (payoutOrderKey(a) < payoutOrderKey(b) ? -1 : payoutOrderKey(a) > payoutOrderKey(b) ? 1 : 0);

/** The stake part and the fee part as ONE transaction: inputs by outpoint, payouts by key, the round's nonce. */
function finish(stake, fee) {
  const claims = [...stake.claims, ...fee.claims].sort(byOutpoint);
  const payouts = [...stake.payouts, ...fee.payouts].sort(byPayoutPk);
  const paidMsat = stake.payouts.reduce((s, p) => s + p.msat, 0n);
  const outputFeesMsat = stake.payouts.reduce((s, p) => s + p.feeMsat, 0n);
  const unspentMsat = stake.spendableMsat - paidMsat - outputFeesMsat;
  if (unspentMsat < 0n) return refuse('the payouts and their fees come to more than the claimed locks pay for');
  if (fee.unspentMsat < 0n) return refuse('the signer nodes\' payouts and their fees come to more than the fee locks pay for');
  return { ok: true, nothing: false, claims, payouts, unpaid: [...stake.unpaid, ...fee.unpaid], forfeits: stake.forfeits,
    nonce: settlementNonce(stake.roundId), stakeWhy: stake.stakeWhy,
    poolMsat: stake.poolMsat, inputFeesMsat: stake.inputFeesMsat, spendableMsat: stake.spendableMsat, paidMsat, outputFeesMsat, unspentMsat,
    feeClaims: fee.claims, signerNodePayouts: fee.payouts, feePoolMsat: fee.poolMsat, feeInputFeesMsat: fee.inputFeesMsat,
    feePaidMsat: fee.paidMsat, feeOutputFeesMsat: fee.outputFeesMsat, feeUnspentMsat: fee.unspentMsat, feeUnallocatedMsat: fee.unallocatedMsat,
    feeHole: fee.hole || null };
}

/**
 * WHETHER A FEE LOCK CAN PAY A SIGNER NODE - THE GATE THE PAGE ASKS BEFORE IT MINTS ONE
 * (Pick b, the owner 2026-09-14: "Do not mint a fee lock when claiming it cannot pay
 * a sitting signer node ... The operator must not take money that only pays the
 * federation.").
 *
 * The signer nodes' own fee arithmetic (`feeSettlement`), run on the round's WORST case -
 * the fewest players a round opens for (more only raise each signer node's share) - over
 * the signer nodes the settlement pays: the round's own sitting signer nodes, its `nodes`, in
 * both pools (the owner 2026-09-15 07:42: "22A node fee goes to the sitting signer nodes of
 * this round, even if there are only two. Not seven census slots when the round is
 * 2-of-2."). It used to invent one different signer node per slot - four for a 2-of-2
 * the settlement pays as two. It pays only if every sitting signer node would be paid
 * strictly more than nothing after the federation's own fee on every input and
 * output. `fees` is the federation's rule, read by the page's own lock client -
 * not a signer node's word.
 */
export function feeLockPays({ contract, fees, players = MIN_PLAYERS_PER_ROUND } = {}) {
  if (!contract) return { pays: false, why: 'no round to size the fee lock for' };
  if (!fees || typeof fees.ppm !== 'bigint' || typeof fees.baseMsat !== 'bigint')
    return { pays: false, why: 'the federation\'s fee rule is not known, so no fee lock is minted' };
  const stakeMsat = BigInt(contract.stakeMsat || 0n);
  const lockMsat = entryFeeMsat(stakeMsat);
  // THE ROUND'S SITTING SIGNER NODES, each once - the signer nodes its settlement pays, in both pools.
  const sitting = Array.isArray(contract.nodes) ? [...new Map(contract.nodes.map((k) => [toHex(k), k])).values()] : [];
  const base = { stakeMsat, lockMsat, players, signerNodes: sitting.length };
  if (lockMsat <= 0n) return { ...base, pays: false, why: 'this round owes no fee, so there is nothing to lock' };
  if (!sitting.length) return { ...base, pays: false, why: 'that round names no sitting signer nodes, so a fee lock would pay nobody' };
  const key = (tag, i) => { const k = new Uint8Array(32); k[0] = tag; k[1] = i; k[31] = 1; return k; };
  const pools = { [GAME_VERIFY]: sitting, [SETTLEMENT]: sitting };
  const entries = Array.from({ length: players }, (_, i) => ({ pubkey: key(0xb0, i), stakeMsat, feeMsat: lockMsat, donationMsat: 0n, outcome: FAILED, score: 0 }));
  const feeLocks = new Map(entries.map((e, i) => [toHex(e.pubkey), { outpoint: { txid: key(0xc0, i), outIdx: BigInt(i) }, amountMsat: lockMsat, preimage: key(0xd0, i) }]));
  const part = feeSettlement({ entries, feeLocks, signerNodes: pools, contract, fees });
  if (!part.ok) return { ...base, pays: false, why: part.why };
  const out = { ...base, inputFeesMsat: part.inputFeesMsat, outputFeesMsat: part.outputFeesMsat,
    perSignerNodeNetMsat: part.payouts.map((p) => p.msat), unpaidSignerNodes: part.unpaid.length };
  if (part.hole) return { ...out, pays: false, why: part.hole.why };
  if (part.unpaid.length) return { ...out, pays: false, why: `${part.unpaid.length} entitled signer node(s) would be paid nothing after the federation's fees` };
  if (!part.payouts.length || part.payouts.some((p) => p.msat <= 0n)) return { ...out, pays: false, why: 'a signer node would be paid nothing after the federation\'s fees' };
  return { ...out, pays: true, why: `every one of ${part.payouts.length} signer nodes is paid more than nothing after the federation's fees` };
}

/**
 * THE FEE PART: every counted entry's fee lock in, each sitting signer node's §22A share
 * out. `signer nodes` names the round's sitting committee by pool ({ gameVerify,
 * settlement }: x-only keys); `feeLocks` the verified fee locks by player key,
 * each with its outpoint, amount and F.
 */
function feeSettlement({ entries, feeLocks, signerNodes, contract, fees }) {
  const none = { ok: true, claims: [], payouts: [], unpaid: [], poolMsat: 0n, inputFeesMsat: 0n, paidMsat: 0n, outputFeesMsat: 0n, unspentMsat: 0n, unallocatedMsat: 0n };
  if (!feeLocks.size) return none;
  if (!contract || !signerNodes || !Array.isArray(signerNodes[GAME_VERIFY]) || !Array.isArray(signerNodes[SETTLEMENT]))
    return refuse('fee locks are claimed for the round\'s sitting signer nodes, and no contract or signer nodes were named');
  const counted = entries.filter((e) => !isRefund(e.outcome));
  const claims = [];
  for (const e of counted) {
    const f = feeLocks.get(toHex(e.pubkey));
    if (!f) return refuse(`an entry's fee lock was never verified, so the fee cannot be claimed: ${toHex(e.pubkey).slice(0, 16)}`);
    if (f.amountMsat !== e.feeMsat) return refuse(`a fee lock holds ${f.amountMsat} msat and its entry's fee is ${e.feeMsat}`);
    if (!(f.preimage instanceof Uint8Array) || f.preimage.length !== 32) return refuse('a fee lock is claimed with its F, and that is 32 bytes');
    claims.push({ pubkey: e.pubkey, outpoint: f.outpoint, amountMsat: f.amountMsat, preimage: f.preimage, kind: 'fee' });
  }
  const eligible = new Set([...signerNodes[GAME_VERIFY], ...signerNodes[SETTLEMENT]].map(toHex));
  let table;
  try { table = nodeFeeTable({ contract, entries: counted, pools: signerNodes, eligible }); } catch (e) { return refuse(e.message); }
  const poolMsat = claims.reduce((s, c) => s + c.amountMsat, 0n);
  if (table.fee !== poolMsat) return refuse(`the fee table owes the signer nodes ${table.fee} msat and the fee locks hold ${poolMsat}`);
  if (table.unallocated > 0n) return refuse(`${table.unallocated} msat of the fee has no eligible signer node in its pool, so no fee lock is claimed`);
  // ONE PAYOUT PER SIGNER NODE KEY: a signer node in both pools is owed both shares (§22A), paid together.
  const owed = new Map();
  for (const [k, msat] of table.signerNodes) { const key = k.slice(k.indexOf(':') + 1); owed.set(key, (owed.get(key) || 0n) + msat); }
  const inputFeesMsat = claims.reduce((s, c) => s + lnv2FeeMsat(fees, c.amountMsat), 0n);
  const spendable = poolMsat - inputFeesMsat;
  if (spendable <= 0n) return refuse(`the guardians' fees on the fee locks (${inputFeesMsat} msat) take the whole fee of ${poolMsat}`);
  const payouts = [];
  const unpaid = [];
  for (const [key, msat] of owed) {
    const pubkey = fromHex(key);
    const got = largestPayoutMsat(fees, (msat * spendable) / poolMsat);
    if (got === 0n) { unpaid.push({ pubkey, owedMsat: msat, why: 'its fee share does not pay its own output fee' }); continue; }
    payouts.push({ pubkey, payoutPk: refundKeyOf(pubkey), owedMsat: msat, msat: got, feeMsat: lnv2FeeMsat(fees, got), kind: 'signer node' });
  }
  // A FEE THAT CANNOT REACH A SIGNER NODE IS NOT CLAIMED. Measured under the guardians'
  // real rule (1000 msat per input and per output): two 2000 msat fee locks bring
  // 4000, their inputs cost 2000, and each signer node's 1000 msat share cannot pay its
  // own output - claimed, the players' fees would only have paid the guardians.
  // Left unclaimed, each fee lock expires back to its player; the hole is named.
  if (!payouts.length)
    return { ...none, unpaid, hole: { poolMsat, inputFeesMsat, owedMsat: [...owed.values()].reduce((s, m) => s + m, 0n),
      why: `the fee locks hold ${poolMsat} msat and their inputs alone cost ${inputFeesMsat}: no signer node's share pays its own output, `
        + 'so no fee lock is claimed and each expires back to its player' } };
  const paidMsat = payouts.reduce((s, p) => s + p.msat, 0n);
  const outputFeesMsat = payouts.reduce((s, p) => s + p.feeMsat, 0n);
  return { ok: true, claims, payouts, unpaid, poolMsat, inputFeesMsat, paidMsat, outputFeesMsat,
    unspentMsat: spendable - paidMsat - outputFeesMsat, unallocatedMsat: table.unallocated, hole: null };
}
