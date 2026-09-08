// A ROOT IS NOT PUBLISHED WITH THE 5A.3B TEMPLATE UNCHECKED.
//
// 5A.3's fourth criterion is that the output is "a bond output built to the
// 5A.3B template". Rebuilding that key is a point addition this package
// cannot do - it carries no curve on purpose, because every other package
// reads it - so `resolveCensus` has always been able to run without one and
// name the gap: the template goes in `unchecked` and the entry is counted.
//
// That is honest for a STEP and wrong for a CENSUS. The composed five steps
// are what a node publishes a root from, and a root taken without that check
// is a census over outputs nobody proved were bonds: a stranger's taproot key
// is thirty-two bytes like any other. 5A.3 says why it matters - "the bond is
// what makes identity expensive. Without it, a Sybil attacker creates
// arbitrarily many nodes for free and buys arbitrarily many selection
// chances".
//
// This file is the refusal, measured where no curve exists. What a census
// looks like WITH one is in `blwp-node/test/census-derive.test.js`, which is
// where those tests moved for exactly this reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION } from '../src/constants.js';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from '../src/genesis-ids.js';
import { parseTransaction } from '../src/tx.js';
import { bondTransaction } from '../tools/bond.js';
import { chainOf as minedChain } from '../tools/chainview.js';
import { deriveCensus, resolveCensus, scanCensus } from '../src/census.js';
import { genesisFor } from '../src/genesis.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const HEIGHT = 900000;
const TIP = HEIGHT + 10;
const advertFor = (n) => ({
  nodePubkey: b32(n), operatorId: 'operator', protocolVersions: [PROTOCOL_VERSION],
  roles: ['game'], endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1,
  softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), timestamp: 1788700000000n,
});
const BOND = bondTransaction(advertFor(0x11), { previousTxid: b32(0xa1), previousVout: 0 });
const BOND_ID = parseTransaction(BOND).txid;
const view = () => {
  const blocks = [];
  for (let h = HEIGHT - 20; h <= TIP; h++) blocks.push({ transactions: h === HEIGHT - 20 ? [BOND] : [] });
  return minedChain(blocks, HEIGHT - 20);
};
const round = (over = {}) => ({
  bondMinSats: 50000n, protocolVersion: PROTOCOL_VERSION,
  censusHeight: HEIGHT, censusConfirmations: 6, networkId: NETWORK_ID_REGTEST, ...over,
});
const candidates = [{ txid: BOND_ID, vout: 0, pubkey: b32(0x11), bondSats: 60000n, roles: ['game'] }];
const resolve = () => ({ transaction: BOND });

test('a composed census with no curve is refused instead of returning a root', () => {
  const tried = deriveCensus(view(), { contract: round(), candidates, resolve });

  assert.equal(tried.ok, false, 'a root came back with the bond template unchecked');
  assert.equal(tried.root, undefined);
  assert.match(tried.why, /template unchecked/);
  assert.match(tried.why, /regtest names an arbitration set/);

  // BEFORE, this is exactly what it returned instead: a root, three steps of
  // checking, and the template named in `unchecked` - which is still what the
  // STEP does, because a step that says what it did not check is honest. The
  // census is where saying so stops being enough.
  const step = resolveCensus(candidates.map((c) => ({ ...c, height: HEIGHT - 20, spent: false })),
    { contract: round(), resolve });
  assert.equal(step.ok, true, step.why);
  assert.equal(step.eligible.length, 1);
  assert.equal(step.unchecked.some((u) => /script template/.test(u)), true,
    'the step stopped naming the gap it still has');
});

test('every known network names an arbitration set, so no round escapes the check', () => {
  for (const [networkId, name] of [[NETWORK_ID_REGTEST, 'regtest'], [NETWORK_ID_TESTNET4, 'testnet4']]) {
    const g = genesisFor(name);
    assert.equal(g.arbitrationKeys.length, g.arbitrationM);
    assert.equal(g.arbitrationKeys.length > 0, true);
    const tried = deriveCensus(view(), { contract: round({ networkId }), candidates, resolve });
    assert.equal(tried.ok, false, `${name} produced a root with the template unchecked`);
    assert.match(tried.why, new RegExp(`${name} names an arbitration set`));
  }
});

test('a round that names no network is refused, not scanned as regtest', () => {
  const nameless = { bondMinSats: 50000n, protocolVersion: PROTOCOL_VERSION,
    censusHeight: HEIGHT, censusConfirmations: 6 };

  // SCAN: it used to fall back to regtest's marker - `network || 'regtest'` -
  // so a contract with no network was answered as if it were regtest, on
  // whatever chain it was actually running.
  assert.throws(() => scanCensus(view(), { contract: nameless }), /names no network/);
  assert.throws(() => scanCensus(view(), { contract: nameless, candidates }), /names no network/);

  // RESOLVE: the same default one layer down, in `recognizeBond`.
  const step = resolveCensus(candidates.map((c) => ({ ...c, height: HEIGHT - 20, spent: false })),
    { contract: nameless, resolve });
  assert.equal(step.ok, false);
  assert.match(step.why, /names no network/);

  // and the composed census speaks with the scan's voice, since that is where
  // it stops first
  assert.match(deriveCensus(view(), { contract: nameless, candidates, resolve }).why,
    /names no network/);
});

test('a set that is not this network\'s set is refused before any entry is judged', () => {
  const g = genesisFor('regtest');
  const entries = candidates.map((c) => ({ ...c, height: HEIGHT - 20, spent: false }));
  const full = {
    arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK,
    bondMaturity: g.bondMaturity, tweakPoint: () => {}, combine: () => {},
  };
  const refusedBy = (bond) => {
    const out = resolveCensus(entries, { contract: round(), resolve, bond });
    assert.equal(out.ok, false, 'that was accepted as this network\'s arbitration set');
    return out.why;
  };

  // AN EMPTY SET IS NOT A SET. A mutant that let one through survived every
  // test, because with no keys the recompute simply fails and every honest
  // bond is excluded by name - a chain that reads as full of liars when what
  // is actually wrong is the caller's own set.
  assert.match(refusedBy({ ...full, arbitrationKeys: [] }), /not the arbitration set regtest was born with/);
  assert.match(refusedBy({ ...full, arbitrationKeys: g.arbitrationKeys.slice(0, 3) }),
    /not the arbitration set regtest was born with/);
  assert.match(refusedBy({ ...full, arbitrationKeys: [...g.arbitrationKeys.slice(1), b32(0x99)] }),
    /not the arbitration set regtest was born with/);

  // AND THE THRESHOLD AND THE MATURITY ARE GENESIS FACTS TOO (letter 24's
  // ruling): both go into the leaves, so a caller naming its own would be
  // rebuilding a different tree and calling the answer a template check.
  assert.match(refusedBy({ ...full, arbitrationK: 2 }), /where regtest was born 5-of-7/);
  assert.match(refusedBy({ ...full, bondMaturity: 1 }), /at maturity 1 where/);

  // A CURVE THAT IS NOT THERE IS NOT A CURVE.
  assert.match(refusedBy({ ...full, tweakPoint: undefined }), /needs both curve operations/);
  assert.match(refusedBy({ ...full, combine: 'yes' }), /needs both curve operations/);

  // and the set genesis actually names passes this gate - it fails later, on
  // the curve stubs, which is a different sentence
  const ok = resolveCensus(entries, { contract: round(), resolve, bond: full });
  assert.equal(ok.ok, true, ok.why);
});
