// THE PLAYER'S STAKE LOCK, MADE FROM THE PAGE (W1b; v4.6.2 §23.1 steps 3-5).
//
// The lock client (lock-client/, the stock fedimint 0.12.0 client crates built
// to wasm) is INJECTED, like the curve: this bundle carries no crypto and no
// federation code. What is here decides only what the lock client is asked -
// which federation, under whose secret, how much, to which keys, until when,
// all read off the round, the dealt stake and the attested claim key - and it
// refuses an answer that is not the lock it asked for (`lockFromClient`).
//
// AND IT HANDS THE LOCK TO THE SEATS once they hold the entry: a seat verifies
// it in the federation and only then counts the stake (§23.1 step 5).
import { taggedHash, toHex } from '../../protocol/src/hash.js';
import { TAG } from '../../protocol/src/constants.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { refundKeyOf, lockFieldsToJson } from '../../protocol/src/stake-lock.js';
import { lockFromClient } from './lock-result.js';
import { roundLocks } from './join.js';

// THE BLOCKS OVER stake_expiry_blocks A LOCK IS MADE FOR. The seat requires
// expiration >= its federation height + 144 when it verifies, and the chain
// moves between the lock and the check; W1a locked with 150 and both seats
// committed. How large this margin must be is a parked ruling (the expiry
// margin, §23.1 step 4 vs step 5) - it is W1a's number, named, not a choice.
export const LOCK_EXPIRY_MARGIN_BLOCKS = 6;

const namesNothing = (b) => !(b instanceof Uint8Array) || b.every((x) => x === 0);

/**
 * THE LOCK CLIENT'S SECRET FOR THIS ROUND, FROM THE PLAYER'S SEED. The ecash a
 * deposit buys, before it is locked, is then the seed's and not this tab's: a
 * reload joins the same wallet (fedimint's own recovery finds it), where a
 * random secret would lose it with the tab.
 */
export function lockSecretFor(seed, roundId) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32)
    throw new Error('the lock client\'s secret comes from the player\'s 32-byte seed, and none was given');
  if (!(roundId instanceof Uint8Array) || roundId.length !== 32)
    throw new Error('the lock client\'s secret is per round, and no round id was given');
  const msg = new Uint8Array(64);
  msg.set(seed, 0);
  msg.set(roundId, 32);
  return taggedHash(TAG.lockClientSecret, msg);
}

/** The net stake a lock holds: the stake less the node fee and the donation (§22A). */
export const lockAmountMsat = (round) => {
  const stakeMsat = BigInt(round.stakeMsat || 0n);
  return netStakeMsat({ stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n });
};

/**
 * JOIN THE ROUND'S FEDERATION, FUND THE LOCK, AND MAKE IT.
 *
 * `LockClient` is the wasm class; `onDeposit({ invoice, amountMsat })` is told
 * each invoice the player's wallet must pay - the page shows it. Returns the
 * outpoint and the contract (`lockFromClient`), and the client that holds it.
 */
export async function lockStake({ round, roundId, invite, seed, stake, claimKey, playerPubkey, LockClient,
  onDeposit = () => {}, onStep = () => {} } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so its stake is not a lock');
  if (!invite)
    throw new Error('this round\'s stake goes into a federation lock, and the link names no federation '
      + 'to make it in - add federation=<invite code>');
  if (!LockClient || typeof LockClient.join !== 'function')
    throw new Error('a stake lock is made by the lock client, and none was loaded');
  if (!stake || namesNothing(stake.stakePoint)) throw new Error('a lock is to the stake\'s point, and this stake names none');
  if (!claimKey || !claimKey.ok || namesNothing(claimKey.claimPk))
    throw new Error('no claim key has its seats\' attestation: a client must refuse to lock to a key without it (23.1 step 0)');
  if (!(playerPubkey instanceof Uint8Array) || playerPubkey.length !== 32)
    throw new Error('a lock refunds to the player\'s key, and that is 32 bytes');

  const amount = lockAmountMsat(round);
  onStep('joining the federation');
  const client = await LockClient.join(invite, toHex(round.federationId), toHex(lockSecretFor(seed, roundId)));

  // FUNDED FROM THE PLAYER'S OWN DEPOSIT. The federation's fee for the lock is
  // quoted as a dry run over the notes the client holds, so an empty client
  // cannot be quoted - measured on regtest, the first page rehearsal refused
  // its seat with "Insufficient funds" before asking for any deposit. So the
  // first deposit is the net stake and the stock fee allowance
  // (`LockClient.lockAllowanceMsat`); after it the quote decides, and a quote
  // that still finds the funds short is topped up by the allowance again.
  const allowance = BigInt(LockClient.lockAllowanceMsat(String(amount)));
  for (let tries = 0; ; tries++) {
    const have = BigInt(await client.balanceMsat());
    let cost = null;
    try { cost = BigInt(await client.lockCostMsat(String(amount))); } catch (e) {
      if (!/insufficient funds/i.test(String((e && e.message) || e))) throw e;
    }
    if (cost !== null && have >= cost) break;
    if (tries >= 3) throw new Error(`after ${tries} deposits the lock client holds ${have} msat and cannot fund a ${amount} msat lock`);
    const short = cost !== null ? cost - have : amount + allowance - have;
    const plan = JSON.parse(await client.depositFor(String(short > 0n ? short : allowance)));
    const asked = JSON.parse(await client.receive(String(plan.invoice_msat), String(plan.gateway || '')));
    onDeposit({ invoice: asked.invoice, amountMsat: BigInt(plan.invoice_msat), creditsMsat: BigInt(plan.credited_msat) });
    onStep('waiting for the deposit');
    const final = await client.awaitReceive(asked.operation);
    if (final !== 'Claimed') throw new Error(`the deposit was not claimed: ${final}`);
  }

  onStep('locking the stake');
  const refundPk = refundKeyOf(playerPubkey);
  const answer = await client.lock(toHex(stake.stakePoint), String(amount), toHex(claimKey.claimPk), toHex(refundPk),
    Number(round.stakeExpiryBlocks) + LOCK_EXPIRY_MARGIN_BLOCKS);
  const lock = lockFromClient(answer, { point: stake.stakePoint, claimPk: claimKey.claimPk, refundPk });
  if (lock.fields.amountMsat !== amount)
    throw new Error(`the lock client locked ${lock.fields.amountMsat} msat, and this entry's net stake is ${amount}`);
  return { ...lock, client };
}

/**
 * THE LOCK, HANDED TO EVERY SEAT (POST /lock). A seat that verifies it in the
 * federation answers 201 and counts the stake; `ok` is `needed` of them.
 */
export async function handLock({ entryId, fields, nodes, needed, fetcher = fetch } = {}) {
  if (!(entryId instanceof Uint8Array) || entryId.length !== 32) throw new Error('a lock is handed over for an entry, by its id');
  const body = JSON.stringify(lockFieldsToJson(fields));
  const said = [];
  for (const node of [...new Set(nodes || [])]) {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/lock?entry=${toHex(entryId)}`, { method: 'POST', body });
      said.push({ node, status: r.status, why: (await r.text()).trim() });
    } catch (e) {
      said.push({ node, status: 0, why: e.message });
    }
  }
  const committed = said.filter((s) => s.status === 201).length;
  return { ok: committed >= needed, committed, needed, said };
}
