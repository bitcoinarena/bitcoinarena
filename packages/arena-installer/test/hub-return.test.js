// THE HUB'S RETURN CHANNEL (hub-return.js): once per new gateway that opened >= 100,000 sat to the hub, from the hub's own wallet only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubReturnTick } from '../src/hub-return.js';

test('a channel back to each new gateway, once; never smaller; not to a channel the hub opened or a small one', async () => {
  const gw = (n) => `02${String(n).repeat(64)}`.slice(0, 66);
  let open = [{ peer: gw(1), capacitySats: 100000, active: true, initiator: false }, { peer: gw(2), capacitySats: 20000, active: true, initiator: false },
    { peer: gw(3), capacitySats: 300000, active: true, initiator: true }, { peer: gw(4), capacitySats: 100000, active: false, initiator: false }];
  let onchain = 105000; const opens = []; const state = {}; const logs = [];
  const k = { channels: async () => ({ ok: true, open, pending: [] }), funds: async () => ({ ok: true, onchainSats: onchain }),
    openTo: async (o) => { opens.push([o.pubkey, o.sats]); onchain -= o.sats + 500; return { ok: true, fundingTxid: 'ab'.repeat(32) }; }, state, log: (l) => logs.push(l) };
  let r = await hubReturnTick(k);
  assert.deepEqual([r.opened, opens], [[gw(1)], [[gw(1), 100000]]], 'only the active >= 100,000 sat channel a peer opened (not 20,000, not the hub\'s own, not inactive)');
  assert.deepEqual((await hubReturnTick(k)).opened, [], 'once per peer');
  open = [...open, { peer: gw(5), capacitySats: 100000, active: true, initiator: false }];
  r = await hubReturnTick(k);
  assert.deepEqual([r.opened, r.short, opens.length], [[], [gw(5)], 1], 'short of 100,000 + fees: nothing smaller opened');
  assert.match(logs.at(-1), /holds 4500 sat, needs 100000 \+ fees/);
  onchain = 200000;
  assert.deepEqual((await hubReturnTick(k)).opened, [gw(5)], 'funded again: it opens');
});
