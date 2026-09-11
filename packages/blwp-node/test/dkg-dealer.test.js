// HOW MANY SHARES OF THE POOL KEY ONE PROCESS HOLDS, COUNTED.
//
// M3.3 item 14, and this file is the before and the after. Written first as
// the measurement the letter had to move:
//
//   shares reachable from the dealing process   7 of 7
//   shares needed to sign alone                 5
//   the dealer can sign without asking          TRUE
//
// and five of those seven, interpolated in that one process, rebuilt the group
// public key - so the dealer did not merely hold enough to sign, it held the
// secret. `trustedDealerSplit` had zero callers under any `src/`: the dealer
// was not code in this repository at all, it was whatever process started the
// seven daemons, and four start paths did exactly that.
//
// THE DAEMONS MAKE THEIR OWN KEY NOW. Every one deals a contribution, keeps
// the single envelope addressed to it, and combines; no process holds a
// threshold at any point. What is pinned below is that the dealer is gone from
// everything that stands a committee UP, and that the two harnesses which
// still hold shares in one process are the two that are ABOUT a transaction
// rather than about custody - they say so in their own headers, and they are
// named here so a third cannot appear quietly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dealThePool, curve } from './pool-fixture.js';
import { SHARES_NEEDED, SHARES_TOTAL } from '../../protocol/src/shares.js';
import { reconstruct, scalarFrom32 } from '../../protocol/src/shares.js';

const srcOf = (pkg) => {
  const dir = new URL(`../../${pkg}/src/`, import.meta.url);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ pkg, f, text: readFileSync(new URL(f, dir), 'utf8') }));
};

/**
 * THE NUMBER THIS LETTER EXISTS TO MOVE: 7 of 7.
 *
 * One call to the dealer returns every share, and the harnesses that stand a
 * committee up hand them out afterwards - so the dealing process holds a
 * threshold and then some. Five of seven is what opens the key, so anything at
 * or above five in one place is a single party that can sign alone.
 */
test('a dealer still holds everything, which is why nothing that ships uses one', () => {
  const dealt = dealThePool();

  assert.equal(dealt.shares.length, SHARES_TOTAL);
  const inOneProcess = dealt.shares.length;
  console.log(`  a DEALT key: shares in the dealing process: ${inOneProcess} of ${SHARES_TOTAL}`);
  console.log(`  shares needed to sign alone:                ${SHARES_NEEDED}`);
  console.log(`  so that process can sign without asking:    ${inOneProcess >= SHARES_NEEDED}`);
  assert.equal(inOneProcess, SHARES_TOTAL);
  assert.ok(inOneProcess >= SHARES_NEEDED);

  // AND IT IS NOT A COUNT ONLY: the shares in that one place OPEN the key.
  // Five of the seven, interpolated, are the group secret itself.
  const five = dealt.shares.slice(0, SHARES_NEEDED)
    .map((s) => ({ seat: Number(s.id), value: s.share }));
  // `reconstruct` hands back the 32 bytes themselves, not a result object.
  const secret = reconstruct(five, { needed: SHARES_NEEDED });
  assert.equal(secret.length, 32);
  const rebuilt = curve.pointFromScalar(scalarFrom32(secret));
  assert.deepEqual(rebuilt, dealt.groupPublicKey,
    'five shares from the dealing process did not rebuild the group key');
  console.log('  five of them, interpolated in this process, ARE the group key');
});

/**
 * AND NOTHING IN THE DAEMON GENERATES ONE, which is why the dealer is outside
 * the repository rather than inside it.
 *
 * Pinned as a LIST rather than a count, the way the pool watcher is: a second
 * file learning to make key material is a second place for "no one of them can
 * steal" to be got wrong.
 */
test('nothing that ships deals the pool key, and no launch path holds a share', () => {
  const src = [...srcOf('protocol'), ...srcOf('blwp-node'), ...srcOf('blwp-client')];

  // The dealer is DEFINED in the protocol and CALLED by nothing that ships.
  const defines = src.filter((s) => /export function trustedDealerSplit/.test(s.text));
  assert.deepEqual(defines.map((s) => `${s.pkg}/${s.f}`), ['protocol/frost.js']);
  const callers = src.filter((s) => /(?<!function )\btrustedDealerSplit\s*\(/.test(s.text)
    && !/export function trustedDealerSplit/.test(s.text));
  assert.deepEqual(callers.map((s) => `${s.pkg}/${s.f}`), [],
    'something that ships now deals the pool key - letter 14 has moved, update this pin');
  console.log('  files under src/ that call the trusted dealer: 0');

  // AND THE DAEMON MAKES ONE. `poolSeat` is still accepted - a fixture may
  // hand a share in, the way `seedWord` may be handed to a replay - but the
  // daemon has its own now, and a call site rather than a mention is what is
  // checked. Written as a bare /dkg|dealerless/i first and it matched the
  // COMMENT saying a dealerless DKG is its own letter: a sentence caught by
  // its own regex.
  const server = src.find((s) => s.pkg === 'blwp-node' && s.f === 'server.js').text;
  assert.match(server, /new Dkg\(/, 'the daemon no longer makes key material of its own');
  console.log('  the daemon runs its own DKG: 1 round, and it keeps 1 share');

  // AND NO LAUNCH PATH DEALS ONE. The two that stand a committee UP were the
  // dealer; the two that still split in one process are ABOUT a transaction -
  // `payout-regtest` proves a payout's bytes and `pool-regtest` proves the
  // sighash - and both say so in their own headers. Named rather than counted,
  // so a fourth cannot appear quietly. The third, `swap-into-pool`, is the
  // 13:53 probe of the submarine swap (SUPERSEDED at 14:19 by the stake lock):
  // a harness committee that measures one claim transaction and launches
  // nothing.
  const tools = readdirSync(new URL('../tools/', import.meta.url))
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => /trustedDealerSplit\s*\(/.test(readFileSync(new URL(`../tools/${f}`, import.meta.url), 'utf8')));
  assert.deepEqual(tools.sort(), ['payout-regtest.mjs', 'pool-regtest.mjs', 'swap-into-pool.mjs'],
    'a launch path deals the pool key again, or one that measures a transaction stopped');
  for (const f of ['payout-committee-regtest.mjs', 'settle-regtest.mjs']) {
    const text = readFileSync(new URL(`../tools/${f}`, import.meta.url), 'utf8');
    assert.match(text, /dkg\.run\(/, `${f} stands a committee up without making a key`);
    assert.equal(/trustedDealerSplit\s*\(/.test(text), false, `${f} deals the pool key again`);
  }
  console.log(`  launch paths that deal all ${SHARES_TOTAL} shares: 0`);
  console.log(`  harnesses that still split in one process, and are about a transaction: `
    + `${tools.length} (${tools.join(', ')})`);
});
