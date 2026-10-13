// THE OWNER 2026-10-13 ~11:55Z: "Die Funds müssen immer sichtbar sein von allen Föderationen, ohne zwischen Federations zu klicken
// und zu wechseln, immer alle Balances summiert und ersichtlich" - the page's BLWP_SUM_BALANCES, run on its own source
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url), 'utf8');
const a = HTML.indexOf("      window.BLWP_WALLETS = window.BLWP_WALLETS || new Map();");
const b = HTML.indexOf('      // OUT OF A DRAINING FEDERATION, BY ITSELF');
const src = HTML.slice(a, b);

test('the balance is every held federation\'s sum, a wallet opened for each held federation with a verified invite', async () => {
  assert.ok(a > 0 && b > a, 'the page carries the summing block');
  const A = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32);
  const bal = { [A]: 1500000n, [B]: 2250000n };
  const opened = [];
  const window = { ARENA_FED_LOADS: new Map([[A, { federation: A, invite: 'invA' }], [B, { federation: B, invite: 'invB' }]]),
    BLWP_LOCK_WASM: async () => ({ default: async () => {}, LockClient: {} }), BLWP_PENDING_SATS: 0 };
  const client = (f) => ({ balanceMsat: async () => String(bal[f] || 0n) });
  const BLWPCLIENT = { ledgerFederations: () => [A, B, C], fromHex: (h) => Uint8Array.from(Buffer.from(h, 'hex')),
    openPlayerWallet: async ({ federationId }) => { const f = Buffer.from(federationId).toString('hex'); opened.push(f.slice(0, 2)); return client(f); } };
  const run = new Function('window', 'BLWPCLIENT', 'walletSeed', 'vault', src + '\nreturn window.BLWP_SUM_BALANCES;');
  const sum = run(window, BLWPCLIENT, () => new Uint8Array(32), () => ({}));
  window.BLWP_KEEP_WALLET(A, client(A));            // the round's wallet, kept as the page keeps it
  await sum();
  const got = window.BLWP_WALLET_BALANCE;
  console.log('  SUM:', JSON.stringify({ sats: got.sats, federation: got.federation, parts: got.parts.map((p) => p.federation.slice(0, 2) + ' ' + p.sats), opened }));
  assert.equal(got.sats, 3750, '1,500 + 2,250 sat');
  assert.equal(got.federation, '2 federations');
  assert.deepEqual(opened, ['bb'], 'B opened (held, invite verified); C held but no verified invite: not opened; A already kept');
});
