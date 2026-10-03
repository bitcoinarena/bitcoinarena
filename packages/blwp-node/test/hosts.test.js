// WHAT A NODE HOSTS, READ (hosts.js): one LND through lncli and one gateway over loopback HTTP, both stubbed here - the
// figures come through, the password never leaves the reader, a part that fails is named, and the environment is parsed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostsFromEnv, readLnd, readGateway, hostsReader } from '../src/hosts.js';

const lncliAnswers = {
  getinfo: { alias: 'lnd-testnet4-b', identity_pubkey: '025f17c2', num_active_channels: 3, synced_to_chain: true },
  channelbalance: { local_balance: { sat: '722117', msat: '722117053' }, remote_balance: { sat: '1332143', msat: '1332143947' } },
  fwdinghistory: { forwarding_events: [{ fee_msat: '1000' }, { fee_msat: '1000' }, { fee_msat: '1000' }] },
  listpayments: { payments: [{ status: 'SUCCEEDED', fee_msat: '2000', creation_time_ns: '1791000000000000000' },
    { status: 'SUCCEEDED', fee_msat: '0', creation_time_ns: '1791000000000000000' }, { status: 'FAILED', fee_msat: '5000', creation_time_ns: '1' }] },
};
const run = async (bin, args, env) => {
  assert.ok(args.includes('--rpcserver=127.0.0.1:11010') && args.includes('--network=testnet4'));
  assert.equal(env.HOME, '/x', 'lncli runs with HOME at the LND directory, never a profile it cannot read');
  return lncliAnswers[args.find((a) => !a.startsWith('--'))];
};

test('the LND: who it is, its balances in msat, 30 days of routing fees, and only the fees its succeeded payments paid', async () => {
  const l = await readLnd({ lnddir: '/x', rpcserver: '127.0.0.1:11010', network: 'testnet4', lncli: 'lncli' }, { run, nowMs: 5 });
  assert.deepEqual([l.alias, l.activeChannels, l.localMsat, l.remoteMsat, l.routingFeesMsat30d, l.forwards30d],
    ['lnd-testnet4-b', 3, '722117053', '1332143947', '3000', 3]);
  assert.deepEqual(l.paymentFees, [{ atMs: 1791000000000, feeMsat: '2000' }]);
});

test('the gateway: state, e-cash per federation, balances and 30 days of payments; the password goes in the header only', async () => {
  const seen = [];
  const fetcher = async (url, o = {}) => {
    seen.push({ url, auth: o.headers && o.headers.Authorization, method: o.method || 'GET' });
    const body = url.endsWith('/v1/info') ? { gateway_state: 'Running', lightning_info: { connected: { alias: 'lnd-testnet4-b' } },
      federations: [{ federation_id: '337ae01a', federation_name: 'blwp-testnet4', balance_msat: 224296960 }] }
      : url.endsWith('/v1/balances') ? { lightning_balance_msats: 722117053, inbound_lightning_liquidity_msats: 1332143947, onchain_balance_sats: 69116 }
      : { incoming: { total_success: 1, total_failure: 0, total_fees: 10 }, outgoing: { total_success: 0, total_failure: 2, total_fees: 0 } };
    return { ok: true, json: async () => body };
  };
  const g = await readGateway({ name: 'gw-b', base: 'http://127.0.0.1:31280', passwordFile: '/pw' }, { fetcher, readPassword: () => 's3cret', nowMs: 1e12 });
  assert.equal(g.state, 'Running');
  assert.deepEqual(g.federations, [{ id: '337ae01a', name: 'blwp-testnet4', ecashMsat: '224296960' }]);
  assert.deepEqual([g.lightningMsat, g.inboundMsat, g.onchainSat], ['722117053', '1332143947', '69116']);
  assert.deepEqual(g.payments30d.incoming, { success: 1, failure: 0, feesMsat: '10' });
  assert.ok(seen.every((s) => s.auth === 'Bearer s3cret'));
  assert.deepEqual(seen.map((s) => s.method).sort(), ['GET', 'GET', 'POST']);
  assert.doesNotMatch(JSON.stringify(g), /s3cret/, 'the password is not in the figures');
});

test('the reader keeps the last reading, names a failed part, and the environment names nothing on nodes 3-7', async () => {
  const r = hostsReader({ lnd: { rpcserver: 'x' }, gateway: { name: 'gw-a' } }, {
    readLndWith: async () => { throw new Error('lncli: connection refused'); },
    readGatewayWith: async () => ({ name: 'gw-a', state: 'Running' }),
  });
  assert.deepEqual(r.snapshot(), { lnd: null, gateway: null });
  await r.refresh();
  assert.match(r.snapshot().lnd.error, /connection refused/);
  assert.equal(r.snapshot().gateway.state, 'Running');
  assert.equal(hostsFromEnv({}), null);
  const h = hostsFromEnv({ BLWP_HOSTS_LND: '/mnt/bitcoin/lnd-testnet4,127.0.0.1:11009', BLWP_HOSTS_GATEWAY: 'gw-a,http://127.0.0.1:31270/,/home/arena/blwp-testnet4/gw-a/password' });
  assert.deepEqual([h.lnd.rpcserver, h.lnd.network, h.gateway.name, h.gateway.base], ['127.0.0.1:11009', 'testnet4', 'gw-a', 'http://127.0.0.1:31270']);
});
