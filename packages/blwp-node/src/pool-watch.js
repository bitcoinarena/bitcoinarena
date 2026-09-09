// WHICH BITCOIN OUTPUT HOLDS THE POOL, ASKED OF THE CHAIN.
//
// Measured before this file: nothing in `src/` could ask - no `scantxoutset`,
// no `gettxout`, no `listunspent` anywhere - and `chainSpend` can only `send`
// bytes and `look` up a txid it already has. So `payWithCommittee` took the
// output as an ARGUMENT and had no caller: a closed round stopped at
// PAYOUT_QUEUED and the winner was paid by a test handing the daemon an
// outpoint.
//
// IT IS THE SAME ADAPTER THE CENSUS READS THE CHAIN WITH. `bitcoindRpc`
// returns `call(method, params)` and that is what this takes; there is no
// second Bitcoin RPC style here, and the two methods below are bitcoind's own,
// with the shapes recorded off a running node rather than remembered:
//
//   gettxout <txid> <vout>   -> { confirmations, value, scriptPubKey: { hex } }
//                               or NULL when the output is spent or unknown
//   scantxoutset start [{desc:"raw(<hex>)"}]
//                            -> { success, unspents: [{ txid, vout, amount,
//                                 confirmations, scriptPubKey }] }
//
// A VALUE IS THE CHAIN'S, NEVER A CALLER'S. BIP-341 hashes every prevout
// amount into the sighash, so a committee signing at an amount the chain does
// not hold produces a signature the chain refuses - measured, and it can burn
// nothing. What it can do is waste a signing round, and a seat that reads the
// amount itself cannot be asked to.
import { poolOutput } from '../../protocol/src/pool.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

/**
 * BITCOIND SPEAKS BTC AND THIS SPEAKS SATOSHIS.
 *
 * The RPC answers a JSON number - 0.00001200, 49.99997250 - which is a double
 * by the time any JSON parser is done with it. Multiplying by 1e8 and rounding
 * is EXACT for every amount Bitcoin can hold: 21e6 BTC is 2.1e15 satoshis and
 * a double carries integers to 9e15, so the error before rounding is many
 * orders below half a satoshi. Rounding rather than truncating, because
 * 0.1 * 1e8 is 10000000.000000002 and flooring that would lose a satoshi
 * eventually.
 */
export const satsOf = (btc) => {
  if (typeof btc !== 'number' || !Number.isFinite(btc) || btc < 0)
    return null;
  return BigInt(Math.round(btc * 1e8));
};

/**
 * BITCOIND'S TXIDS ARE PRINTED BACKWARDS AND THE PROTOCOL'S ARE NOT.
 *
 * A transaction id is the hash of the transaction; Bitcoin PRINTS it
 * big-endian and puts it in an input little-endian. `bond-spend.js` writes the
 * bytes it is given straight into the input, so what this daemon carries is
 * the internal order - and the RPC has to be spoken to in the printed one.
 * Named here, once, because a reversal that lives in three call sites is a
 * reversal that is wrong in one of them.
 */
export const txidToRpc = (txid) => toHex(Uint8Array.from(txid).reverse());
export const txidFromRpc = (hex) => Uint8Array.from(fromHex(hex)).reverse();

export class PoolWatch {
  /**
   * `call` is `bitcoindRpc`'s, `pool` is `{ groupPublicKey }`, `curve` the
   * one the committee's key lives on. A watch without all three reaches
   * nothing and says so rather than inventing an output.
   */
  constructor({ call = null, pool = null, curve = null } = {}) {
    this.call = call;
    this.pool = pool;
    this.curve = curve;
  }

  get reaches() { return !!(this.call && this.pool && this.curve); }

  /** The one script this committee's pool pays to, derived and not stored. */
  scriptOf() {
    if (!this.reaches) return { ok: false, why: 'this node watches no pool' };
    const out = poolOutput({ groupPublicKey: this.pool.groupPublicKey, curve: this.curve });
    if (!out.ok) return { ok: false, why: out.why };
    return { ok: true, script: out.script, outputKey: out.outputKey };
  }

  /**
   * ONE NAMED OUTPOINT, CONFIRMED AGAINST THE CHAIN.
   *
   * This is the rule for a payout: the asker names an outpoint and the seat
   * takes everything else from here. It refuses an output the chain does not
   * hold - spent, or never existed - and one that pays somebody other than
   * this pool, which is the check that stops a committee signing away a coin
   * that is not theirs.
   */
  async outpoint({ txid, vout }) {
    const mine = this.scriptOf();
    if (!mine.ok) return mine;
    if (!(txid instanceof Uint8Array) || txid.length !== 32)
      return { ok: false, why: 'that is not a transaction id' };
    if (!Number.isInteger(vout) || vout < 0)
      return { ok: false, why: 'that is not an output index' };

    let got;
    try { got = await this.call('gettxout', [txidToRpc(txid), vout]); }
    catch (e) { return { ok: false, why: `the chain would not answer gettxout: ${e.message}` }; }

    // NULL IS THE ANSWER FOR SPENT AND FOR NEVER, and bitcoind does not
    // distinguish them. Neither does this: an output that is not in the set is
    // not one to spend, whichever way it left.
    if (got === null || got === undefined)
      return { ok: false, why: 'the chain holds no such unspent output' };

    const value = satsOf(got.value);
    if (value === null || value <= 0n)
      return { ok: false, why: `the chain answered ${got.value} for that output's value` };

    const hex = got.scriptPubKey && got.scriptPubKey.hex;
    if (typeof hex !== 'string')
      return { ok: false, why: 'the chain named no script for that output' };
    const script = fromHex(hex);
    if (toHex(script) !== toHex(mine.script))
      return { ok: false, why: 'that output pays a different key than this pool' };

    return {
      ok: true,
      utxo: { txid: Uint8Array.from(txid), vout, value, script: mine.script },
      confirmations: Number(got.confirmations || 0),
    };
  }

  /** Every unspent output paying this pool, as the chain has them. */
  async unspent() {
    const mine = this.scriptOf();
    if (!mine.ok) return mine;
    let got;
    try { got = await this.call('scantxoutset', ['start', [{ desc: `raw(${toHex(mine.script)})` }]]); }
    catch (e) { return { ok: false, why: `the chain would not scan for the pool: ${e.message}` }; }
    if (!got || got.success !== true)
      return { ok: false, why: 'the chain did not finish scanning for the pool' };

    const outputs = [];
    for (const u of got.unspents || []) {
      const value = satsOf(u.amount);
      if (value === null || value <= 0n) continue;
      outputs.push({
        txid: txidFromRpc(u.txid), vout: Number(u.vout), value,
        script: mine.script, confirmations: Number(u.confirmations || 0),
      });
    }
    return { ok: true, outputs, height: Number(got.height || 0) };
  }

  /**
   * THE OUTPUT A ROUND MAY SPEND WHEN NOBODY NAMED ONE, AND ONLY WHEN THERE IS
   * EXACTLY ONE ANSWER.
   *
   * the owner's rule, and it is a rule rather than a preference: pick only when
   * exactly one pool output covers what the round owes. Zero is a refusal by
   * name and several is a refusal by name. It does NOT combine outputs - a
   * two-input spend is a different transaction and a different signing round -
   * and it does NOT quietly take the largest, because "the largest" is an
   * operator's choice wearing arithmetic.
   */
  async forRound({ owedSats, minConfirmations = 1 }) {
    if (typeof owedSats !== 'bigint' || owedSats <= 0n)
      return { ok: false, why: 'a round that owes nothing needs no output' };
    const seen = await this.unspent();
    if (!seen.ok) return seen;

    const deep = seen.outputs.filter((o) => o.confirmations >= minConfirmations);
    const covering = deep.filter((o) => o.value >= owedSats);
    if (!covering.length) {
      // TOO SHALLOW AND NOT THERE ARE DIFFERENT PROBLEMS AND MUST NOT READ THE
      // SAME. An operator told "0 confirmed outputs" goes looking for a
      // missing coin; one told "not deep enough yet" waits.
      //
      // AND IT IS NOT THE MEMPOOL CASE, which is what this comment claimed
      // first and a real bitcoind disproved: `scantxoutset` scans the UTXO SET,
      // so a funding transaction still unconfirmed is not in the answer at all
      // and reads - correctly - as a pool holding nothing. This branch is for
      // an output that IS in the set and has fewer confirmations than the
      // caller asked for, which needs `minConfirmations` above one.
      const shallow = seen.outputs.length - deep.length;
      return {
        ok: false, held: seen.outputs.length, confirmed: deep.length, shallow,
        why: shallow && !deep.length
          ? `the pool holds ${shallow} output(s) with fewer than ${minConfirmations} `
            + 'confirmation(s) and no confirmed one, so there is nothing to spend yet'
          : `the pool holds ${deep.length} confirmed output(s) and none of them covers the `
            + `${owedSats} sats this round owes`,
      };
    }
    if (covering.length > 1)
      return {
        ok: false, held: seen.outputs.length, covering: covering.length,
        why: `the pool holds ${covering.length} outputs that cover ${owedSats} sats: `
          + 'name the one to spend, because choosing between them is not this node\'s to make',
      };
    return { ok: true, utxo: covering[0], confirmations: covering[0].confirmations };
  }
}
