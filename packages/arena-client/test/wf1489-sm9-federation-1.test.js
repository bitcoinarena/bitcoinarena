// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm9-find-federation 1 (state machine audit, federation; timeout / a gateway that does not pay for a while):
// A STOPPED EVACUATION IS REMEMBERED AS "THIS FEDERATION IS EMPTY", AND THE PAGE NEVER TRIES IT AGAIN.
// SM-C5 (index.html ARENA_EVACUATE, page-lock.js migrateFromDraining): on every status read the page moves the notes out of each
// federation it holds whose record says DRAINING or CRITICAL. kanban #803 added `evacuatedEmpty`: a federation "found empty" is not opened
// again at later reads. "Empty" is read as `moved === 0 && chunks === 0` - and that is also exactly what migrateFromDraining answers when
// it STOPPED on its first chunk: the gateway refunded the send (or made no invoice) `retries + 1` times, `state: 'stopped'`, nothing moved,
// every note still in the draining federation. From then on the page skips that federation at every status read for the life of the
// tab: the gateway comes back, the record goes DRAINING -> CRITICAL -> HALTED, and the notes are never moved out (frozen at the halt).
// Invariant: a federation is set aside as empty only when it was found empty, never when its move stopped with the notes still there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateFromDraining } from '../src/page-lock.js';
import { safeFederation } from '../src/federations.js';
import { bech32Encode, convertBits } from '../../arena-protocol/src/bech32.js';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const a = HTML.indexOf('      const evacuating = new Set();');
const b = HTML.indexOf('      // THE FEDERATIONS CHECKED WHEN THE WALLET OPENS');

function bolt11For(amountMsat, n = 0) {
  const amount = amountMsat % 100n === 0n ? `${amountMsat / 100n}n` : `${amountMsat * 10n}p`;
  const ts = 1788700000 + n;
  const words = [];
  for (let i = 6; i >= 0; i--) words.push(Math.floor(ts / 32 ** i) % 32);
  const field = (type, bytes) => { const w = convertBits([...bytes], 8, 5, true); words.push(type, w.length >> 5, w.length & 31, ...w); };
  field(1, new Uint8Array(32).fill(0x77));
  field(23, new Uint8Array(32).fill(0x78));
  for (let i = 0; i < 104; i++) words.push(0);
  return bech32Encode(`lnbcrt${amount}`, words);
}

const OLD = 'aa'.repeat(32), NEW = 'bb'.repeat(32);

test('#1489 sm9 federation-1: an evacuation that stopped with every note still there is never tried again', async () => {
  assert.ok(a > 0 && b > a, 'the page carries the evacuation block');
  // the player's wallet in the DRAINING federation: 500 000 msat; the gateway refunds every send while it is down
  let bal = 500000n, gatewayDown = true, n = 0, moves = 0;
  const pending = new Map();
  const from = {
    withdrawableMsat: async () => String(bal > 2000n ? bal - 2000n : 0n),
    withdraw: async (invoice) => {
      const amount = pending.get(invoice);
      if (gatewayDown) return JSON.stringify({ state: 'Refunded', invoice_msat: String(amount) });
      bal -= amount + 2000n;
      return JSON.stringify({ state: 'Success', invoice_msat: String(amount) });
    },
  };
  const to = {
    receive: async (msat) => { ++n; const invoice = bolt11For(BigInt(msat), n); pending.set(invoice, BigInt(msat)); return JSON.stringify({ invoice, operation: 'op' + n }); },
    awaitReceive: async () => 'Claimed',
  };
  const hex = (u) => Buffer.from(u).toString('hex');
  // evacuatePlayerWallet as page-lock.js runs it, the two player wallets opened (the lock client is the only part not run here)
  const evacuatePlayerWallet = async ({ from: f, target, storage, onState, chunkMsat = null, gateways = [] }) => {
    moves++;
    if (!f || !['DRAINING', 'CRITICAL'].includes(f.status) || !f.invite) return { moved: 0n, chunks: 0, state: 'not draining' };
    if (!target || target.status !== 'OPEN' || !target.invite) return { moved: 0n, chunks: 0, state: 'no safe federation to move to' };
    const fromId = Uint8Array.from(Buffer.from(f.federation, 'hex')), toId = Uint8Array.from(Buffer.from(target.federation, 'hex'));
    return migrateFromDraining({ from, to, record: { status: f.status, successorId: toId }, toFederationId: toId, fromFederationId: fromId,
      storage, onState, chunkMsat, gateways });
  };
  const ARENACLIENT = { evacuatePlayerWallet, safeFederation, ledgerFederations: () => [OLD], federationIsKnown: () => true, federationConfirmed: () => true };
  const window = { ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: {} }), ARENA_BROWSER_STORE: () => ({}), ARENA_LEDGER_GATEWAYS: [] };
  const quiet = { log: () => {}, warn: () => {} };
  const run = new Function('window', 'ARENACLIENT', 'walletSeed', 'vault', 'console', HTML.slice(a, b) + '\nreturn window.ARENA_EVACUATE;');
  const evacuate = run(window, ARENACLIENT, () => new Uint8Array(32).fill(7), () => null, quiet);
  const all = new Map([[OLD, { federation: OLD, status: 'DRAINING', successorId: NEW, invite: 'inv-old' }], [NEW, { federation: NEW, status: 'OPEN', load: 0.1, invite: 'inv-new' }]]);

  // status read 1: the gateway refunds every send - the move stops, nothing moved, the notes all still in OLD
  await evacuate(all);
  const first = window.ARENA_EVACUATED, afterStop = bal;
  // status read 2 (the next minute): the gateway pays again
  gatewayDown = false;
  await evacuate(all);
  // status read 3: the record now says CRITICAL - one guardian from a halt
  all.set(OLD, { ...all.get(OLD), status: 'CRITICAL' });
  await evacuate(all);
  console.log('  FACTS #1489 sm9 federation-1:', JSON.stringify({ first: first && { state: first.state, moved: first.moved, chunks: first.chunks },
    movesAsked: moves, leftInDrainingMsat: String(bal) }));
  assert.equal(first.state, 'stopped', 'precondition: the first move stopped on the refunding gateway');
  // (kanban #2289: read right after status read 1, not at the end - once the move is tried again the notes leave)
  assert.equal(String(afterStop), '500000', 'precondition: after the stop every note is still in the draining federation');
  // THE INVARIANT: a stopped move is tried again at a later status read, and the notes leave the draining federation
  assert.ok(moves > 1, 'the stopped federation is marked "found empty" and never asked to move again');
  assert.ok(bal < 500000n, `the notes stay in the draining (now CRITICAL) federation: ${bal} msat`);
});
