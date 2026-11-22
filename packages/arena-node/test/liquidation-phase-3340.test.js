// kanban #3340 (feedback #391): GET /liquidations listed the two halted testnet federations of 158519 a month after their last deadline
// exactly as on the day they halted - nothing said the late-claim tail and the remainder's block were behind the tip, nor why `claims`
// is null. Each row now names its phase on this seat's tip, and a seat that names no claim door says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiquidations } from '../src/liquidations.js';
import { TESTNET_CLOCKS } from '../../arena-protocol/src/federation-slash.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(0x37); const FID = toHex(FED);
const records = { recordOf: (f) => (f === FID ? { record: { federationId: FED, guardians: [] }, status: 'HALTED', height: 900 } : null),
  haltOf: (f) => (f === FID ? { height: 880, bytes: null, proof: { session: 7, observers: 9, abandoned: [], id: new Uint8Array(32) } } : null),
  haltedFederations: () => [FID] };

test('#3340 a liquidation row names its phase on the tip, ended past the remainder block, and why no claim door is named', () => {
  const l = createLiquidations({ records, clocks: TESTNET_CLOCKS, verify: () => false });
  const [x] = l.list({ tip: 885 });
  // (2.0's testnet clocks differ from 1.9's: the edges are read from the row)
  const at = (tip) => l.list({ tip })[0].phase;
  assert.deepEqual([at(885), at(x.liquidatesAt), at(x.claimWindowCloses - 1), at(x.claimWindowCloses), at(x.remainderSplitsAt - 1), at(x.remainderSplitsAt), at(x.remainderSplitsAt + 4000)],
    ['halted', 'claim-window', 'claim-window', 'late-claims', 'late-claims', 'ended', 'ended']);
  assert.equal(l.list({ tip: 5000 })[0].tip, 5000);
  assert.match(l.list({ tip: 5000 })[0].claimsWhy, /names no claim door/);
  // no tip read: no phase claimed
  assert.equal(l.list()[0].phase, null);
  // a seat that names the door says no why
  const named = createLiquidations({ records, clocks: TESTNET_CLOCKS, verify: () => false, claimsUrl: 'https://arb.example/claims' });
  assert.equal(named.list({ tip: 900 })[0].claimsWhy, undefined);
});
