// kanban #2997: the card's test (audit faucet r2-1 of 2026-11-18)
// Audit faucet r2-1: the Nostr follow check of POST /feedback/social { nostr: "name@domain" } (kanban #2641) resolves the NIP-05 name with
// checkedFetch's default refusal (walletUrlRefusal) - not faucetUrlRefusal, the guard #2683 put on the Armada NIP-05 lookup. So the faucet's own
// team hosts (FAUCET_TEAM_HOSTS, default tn4.bitcoin-arena.io), refused by name for every other stranger-named URL, are dialled here.
// Safe: a NIP-05 name on a team host is refused before any lookup or connection. (kanban #3922: the Armada control is gone with the Armada check.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';

test('audit-faucet-r2-1: a Nostr NIP-05 name on the faucet team host is never looked up or dialled', async () => {
  const looked = [];
  const real = dns.lookup;
  dns.lookup = (host, opts, cb) => { if (typeof opts === 'function') cb = opts; looked.push(String(host)); const e = new Error('blocked in test'); e.code = 'ENOTFOUND'; process.nextTick(() => cb(e)); };
  syncBuiltinESMExports();
  try {
    const { nostrPubkeyOf } = await import('../src/bounty-nostr.js');
    await nostrPubkeyOf('bob@tn4.bitcoin-arena.io').catch(() => null);
  } finally { dns.lookup = real; syncBuiltinESMExports(); }
  assert.deepEqual(looked, [], `the faucet looked up / dialled a team host a stranger named as a Nostr NIP-05 domain: ${looked.join(', ')}`);
});

