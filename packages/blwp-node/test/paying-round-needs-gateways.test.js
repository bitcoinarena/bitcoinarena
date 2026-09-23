// A PAYING ROUND DOES NOT OPEN WITHOUT TWO INDEPENDENT GATEWAYS (§23.6, M3, the owner 2026-09-20).
//
// The law: "deposits and withdrawals through any of at least two gateways ... No gateway holds a round's
// money or is needed by it", and §22 is explicit that a gateway may refuse a deposit but never keep one. A
// round opened against a single endpoint is one outage away from a player who has paid and cannot be paid
// back, and the operator must not profit from a technical failure.
//
// `gatewaysAreIndependent` existed and was proven against the live pair, but NOTHING CALLED IT - so a paying
// round would open with no gateways at all. This is the call site and its refusal.
//
// WHERE IT IS CALLED: `lightningPreflight` in `blwp-node/src/preflight.js`, which is the one gate
// `server.js` consults on the paying-round open path - `POST /round`, under
// `if (contract.stakeMsat > 0n && custody.reaches)`, BEFORE `round.open(contract)`, before any invoice and
// before the round is advertised as payable. The browser never decides this; it is asked on the node.
//
// THE LAST TEST HERE IS THE ONE THAT MATTERS: delete the call from `lightningPreflight` and it goes red. A
// green suite must not be able to hide an unused predicate, which is exactly what this letter found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lightningPreflight } from '../src/preflight.js';

const SYNCED = { synced_to_chain: true, chains: [{ network: 'testnet4' }] };
// One 100-sat entry: the node must be able to RECEIVE it, so the channel's remote side carries the balance.
const ENTRY = { stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n };
const CHANNELS = [{ active: true, remote_balance: '200000', local_balance: '0' }];

const A = '0274e26122c7b8fc11f6caaee03f8b639965ffb83196eb1a9aa1a281906898d6b9';
const B = '025f17c2563260049cbae649699fdcbdcd3706d7c298d2d2d4ce7e49bf529c4cc4';

/** The operator's live pair as it stands: A inbound 116530, B inbound 80000, both active and synced. */
const LIVE_PAIR = [
  { identityPubkey: A, rpc: '127.0.0.1:11009', syncedToChain: true,
    channels: [{ active: true, remoteBalanceSat: 116530n }] },
  { identityPubkey: B, rpc: '127.0.0.1:11010', syncedToChain: true,
    channels: [{ active: true, remoteBalanceSat: 80000n }] },
];

const ask = (gateways) => lightningPreflight({
  info: SYNCED, channels: CHANNELS, holdInvoices: true, players: 1, entry: ENTRY, gateways,
});

test('the live pair lets a paying round through this gate', slice2(), () => {
  const said = ask(LIVE_PAIR);
  assert.equal(said.ready, true, said.why);
  assert.equal(said.missing.length, 0);
});

test('one gateway dark: the round is refused, and the refusal names why', slice2(), () => {
  // B stopped - which is the state the operator was actually in from 2026-09-16 to 2026-09-20.
  const dark = [LIVE_PAIR[0], { ...LIVE_PAIR[1], syncedToChain: false, channels: [] }];
  const said = ask(dark);
  assert.equal(said.ready, false, 'a single live gateway opened a paying round');
  assert.match(said.why, /gateways cannot take this round's money/);
  assert.match(said.why, /1 of 2/);
});

test('a channel nobody is home for is not inbound, however much it holds', slice2(), () => {
  // A's channel carried 196530 sat while its only peer was down: active false, unreachable.
  const inactive = LIVE_PAIR.map((g) => ({ ...g, channels: g.channels.map((c) => ({ ...c, active: false })) }));
  const said = ask(inactive);
  assert.equal(said.ready, false);
  assert.match(said.why, /0 of 2/);
});

test('two labels on one node are one gateway, and that is refused', slice2(), () => {
  const said = ask([LIVE_PAIR[0], { ...LIVE_PAIR[1], identityPubkey: A }]);
  assert.equal(said.ready, false);
  assert.match(said.why, /that is one node/);
});

test('MISSING GATEWAYS ARE NOT AN ESCAPE HATCH: shown none, the round is refused', slice2(), () => {
  // The operator does not get to pass the check by declining to answer it.
  for (const nothing of [null, undefined, 'two, honest', 0]) {
    const said = ask(nothing);
    assert.equal(said.ready, false, `gateways ${JSON.stringify(nothing)} opened a paying round`);
    assert.match(said.why, /shown no gateways/);
  }
});

test('a round that asks no stake still needs no Lightning and no gateway (M3.3-19)', slice2(), () => {
  // The free round must not be dragged down by this gate: it holds nothing, so it receives nothing.
  const free = lightningPreflight({
    info: SYNCED, channels: [], holdInvoices: false, players: 1,
    entry: { stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n }, gateways: null,
  });
  assert.equal(free.ready, true, free.why);
  assert.match(free.why, /needs no inbound and no channel/);
});

test('THE CALL SITE ITSELF: delete it and this goes red', slice2(), () => {
  // Everything the single node needs is true - synced, an active channel with enough inbound, hold invoices -
  // so the ONLY thing that can refuse this round is the gateway check. If `lightningPreflight` stops calling
  // `gatewaysAreIndependent`, `ready` becomes true and this fails. That is the point of it: the predicate was
  // written, proven against the live pair, and called by nothing at all.
  const onlyGatewaysCanRefuse = ask([LIVE_PAIR[0]]);          // one gateway, everything else in order
  assert.equal(onlyGatewaysCanRefuse.ready, false,
    'the paying-round gate no longer asks gatewaysAreIndependent - a round would open with one gateway');
  assert.equal(onlyGatewaysCanRefuse.missing.length, 1, 'the gateway check is the only thing refusing here');
  assert.match(onlyGatewaysCanRefuse.missing[0], /gateways cannot take this round's money/);
});

/** Why this test does not run in Step 1 of the THRESHOLD_LN disposal (see TASKBOOK). */
function slice2() { return { skip: "slice 2: the subject is the hold path (hold invoices on a Lightning port). It still runs at HEAD on a FEDERATION round given a Lightning port, so it is skipped, not moved to FEDERATION (RULED 2026-09-23); slice 2 deletes this test with the code" }; }
