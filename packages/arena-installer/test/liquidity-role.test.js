// THE LIQUIDITY PROVIDER ROLE IN THE INSTALLER (kanban #494, §23A.10): it needs LND (the Lightning step) but no federation or bond rules;
// its deposit (5 x L = 500,000 sat on testnet4) is part of what the node's wallet must hold; the agent sends it to LND once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWizard } from '../src/wizard.js';
import { createCustodyAgent } from '../src/custody-agent.js';
import { nodeState, ROLES } from '../src/state.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('roles: liquidity takes the Lightning step, skips federation and bond rules; the deposit is a part; the agent sends it once', async (t) => {
  assert.ok(ROLES.liquidity && /500,000 sat/.test(ROLES.liquidity.needs), 'the fourth role, its deposit said');
  const home = mkdtempSync(join(tmpdir(), 'liq-role-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  state.save({ chain: { kind: 'core', url: 'http://x/' }, owner: { pubkey: 'ab'.repeat(32) }, reach: { mode: 'direct', url: 'http://203.0.113.1:8470', port: 8470 }, service: { port: 1 },
    done: { chain: 1, seed: 1, owner: 1, reach: 1, service: 1 } });
  const sent = [];
  const chainKit = { coinsOf: async () => ({ tip: 157000, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 600000, height: 156999 }] }),
    broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } };
  const w = createWizard({ state, release: home, seatPort: 1, chainKit, launch: () => ({ files: [] }) });
  const server = http.createServer((q, s) => w.handle(q, s));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const port = server.address().port; let cookie = '';
  const go = (method, path, body) => new Promise((ok) => { const q = http.request({ host: '127.0.0.1', port, method, path, headers: { cookie, 'x-arena-wizard': '1', 'content-type': 'application/json' } }, (r) => {
    if (r.headers['set-cookie']) cookie = r.headers['set-cookie'][0].split(';')[0]; let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => { try { ok(JSON.parse(b)); } catch { ok(null); } }); }); if (body) q.write(JSON.stringify(body)); q.end(); });
  await go('GET', `/?t=${w.token}`);
  assert.equal((await go('POST', '/api/roles', { roles: ['verify', 'liquidity'] })).ok, true);
  assert.equal((await go('GET', '/api/state')).step, 'lightning', 'a provider needs LND');
  state.save({ lightning: { mode: 'own', pubkey: '03' + 'cd'.repeat(32) }, done: { ...state.read().done, lightning: 2 } });
  assert.equal((await go('GET', '/api/state')).step, 'bond', 'no federation, no bond rules: those are custody\'s');
  const check = await go('POST', '/api/bond/check');
  assert.deepEqual([check.parts, check.needSats], [{ bond: 50000, fees: 2000, liquidity: 500000 }, 552000], 'the deposit: 5 x 100,000 sat');
  // the agent: the deposit to LND's wallet, once
  const agent = createCustodyAgent({ state, release: home, chainKit, lnd: { funds: async () => ({ ok: true, address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', onchainSats: 0 }) } });
  const r = await agent.tick();
  assert.equal(r.did, 'liquidity-fund');
  assert.equal(parseTransaction(fromHex(sent.at(-1))).outputs[0].value, 500000n);
  assert.match((await agent.tick()).idle, /deposit sent/, 'once');
});
