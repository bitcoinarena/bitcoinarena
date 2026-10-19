// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A LAUNCHED DAEMON COUNTS AS FUNDED (M3.3-31).
//
// `serve` refuses a round or an entry nobody funded - the disk is spent only on
// stakes that exist (IMPLEMENTATION.md), and a default of yes is how a stranger
// opened 200 free rounds. But `main.js` gave `serve` no answer at all, so a
// launched daemon refused EVERY round and every entry with 402 and held no
// stake: a round for sats existed only where a harness passed `() => true`.
//
// The rule (the owner's pick):
//   a ROUND is funded when the operator NAMED it and it asks a stake - named in
//     ARENA_FUNDED_ROUNDS (ids, comma or space) or ARENA_FUNDED_ROUNDS_FILE (one
//     id per line, read on every ask, so a round can be named without a
//     restart). Neither set, none named. A free round is not funded here.
//   an ENTRY is funded when it names a round this node already holds, that
//     round asks a stake, and this node can hold it: Lightning for a hold
//     invoice, and - for a round naming a federation, whose stake is a lock
//     the signer node verifies there (§23.1 step 5, W1b) - the federation.
// NOT "the invoice is paid": the hold is issued after the entry is stored. The
// transcript waits for the money anyway - input batches are refused until the
// stake is seen paid.
import { readFileSync } from 'node:fs';
import { roundId, decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const idsIn = (text) => String(text || '').split(/[\s,]+/)
  .map((s) => s.trim().toLowerCase()).filter((s) => /^[0-9a-f]{64}$/.test(s));

/**
 * `named()` answers which round ids the operator funds, asked each time.
 * `funded.nameRound(id)` adds one in-process - the rehearsal names its round
 * once the contract that names this node gives it an id.
 */
export function operatorFunding({ named = () => [] } = {}) {
  const added = new Set();
  const isNamed = (hex) => added.has(hex) || named().includes(hex);
  const funded = ({ kind, contract, node } = {}) => {
    try {
      if (kind === 'round')
        return BigInt(contract.stakeMsat) > 0n && isNamed(toHex(roundId(contract)));
      // A GRID SERIES POSTED TO POST /series: funded when the operator names its series id, as a round by its id
      if (kind === 'series')
        return BigInt(contract.stakeMsat) > 0n && contract.seriesIdBytes instanceof Uint8Array && isNamed(toHex(contract.seriesIdBytes));
      if (kind === 'entry') {
        if (!node) return false;
        const held = node.holds(contract.roundId);
        if (!held) return false;
        const round = decodeRoundContract(new Uint8Array(held.contract));
        if (BigInt(round.stakeMsat) <= 0n) return false;
        // CAN THIS NODE HOLD THE STAKE: a paying round takes it as a lock in the federation it names,
        // which the signer node VERIFIES there (§23.1 step 5), so the node must reach that federation.
        // There is no other branch. The custody field has one value (§23.6, RULED 2026-09-22 22:59):
        // the hold invoice that "needed Lightning" was the withdrawn Lightning custody, which does not exist, and a record
        // naming it does not parse - so no paying round reaches this line without a federation.
        return !!node.reachesFederation;
      }
    } catch { return false; }
    return false;
  };
  funded.nameRound = (id) => { added.add(typeof id === 'string' ? id.toLowerCase() : toHex(id)); };
  return funded;
}

/**
 * THE DAILY'S LAUNCHER WITH A FREE ROUND AND A PAYING ONE BESIDE IT (the owner
 * 2026-09-15 12:54: always one free round and one 2-of-2 round, both at once).
 * A free round and an entry into a free round this node holds are funded, as
 * the launcher's `() => true` had them - they hold nothing. Anything else is
 * the operator's rule unchanged: a paying round only when named, its entries
 * only where this node can hold the stake.
 */
export function freeOrOperatorFunding({ named = () => [] } = {}) {
  const paying = operatorFunding({ named });
  const funded = (ask = {}) => {
    try {
      if (ask.kind === 'round' && BigInt(ask.contract.stakeMsat) === 0n) return true;
      if (ask.kind === 'entry') {
        const held = ask.node && ask.node.holds(ask.contract.roundId);
        if (held && BigInt(decodeRoundContract(new Uint8Array(held.contract)).stakeMsat) === 0n) return true;
      }
    } catch { return false; }
    return paying(ask);
  };
  funded.nameRound = paying.nameRound;
  return funded;
}

/**
 * The launcher's rule, off the operator's own settings. ARENA_FUND_FREE_ROUNDS=1 takes a free round and its entries too, as
 * the Daily's launcher does in-process (`freeOrOperatorFunding`) - for nodes run as their own processes (attach). Unset,
 * a free round is not funded here, as before.
 */
export function fundingFromEnv(env) {
  const rule = env.ARENA_FUND_FREE_ROUNDS === '1' ? freeOrOperatorFunding : operatorFunding;
  return rule({
    named: () => {
      const ids = idsIn(env.ARENA_FUNDED_ROUNDS);
      if (env.ARENA_FUNDED_ROUNDS_FILE) {
        try { ids.push(...idsIn(readFileSync(env.ARENA_FUNDED_ROUNDS_FILE, 'utf8'))); }
        catch { /* no such file yet: none named from it */ }
      }
      return ids;
    },
  });
}
