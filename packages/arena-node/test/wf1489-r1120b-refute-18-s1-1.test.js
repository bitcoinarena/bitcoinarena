// Refute of kanban #3016 (wf1489 r1120b item 18): the fix checks the creation body's signature only in inForceOf. The same file's
// findBond - the runner's bond reuse (round-2of2.mjs attach: "a node's bond is found by its public key"), which then takes
// b.bondAdvert / b.bondSignature as the node's bond in the round's proof, lobby link (&advert=) and `adverts` - still returns the
// newest output whose body matches endpoint/guardians, signed or not. A stranger's 330-sat dust bond to the node key, an UNSIGNED copy
// of its advertisement with his payout key (endpoint copied), at a newer height, is picked over the node's own signed bond.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { readAdvertUpdate } from '../../arena-protocol/src/advert-update.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { keyFor, bondFor } from './curve.js';
import { regtest } from '../tools/regtest-bond.mjs';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const VICTIM = 0x11;
const SECRET = b32(VICTIM);                  // curve.js keyFor(n) = getPublicKey(fill(n))
const OWN_PAYOUT = schnorr.getPublicKey(b32(0x21));
const ATTACKER_PAYOUT = schnorr.getPublicKey(b32(0x66));
const advertFor = (over = {}) => ({
  nodePubkey: keyFor(VICTIM), operatorId: 'op-victim', protocolVersions: [19],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'], endpoint: 'wss://victim.example', region: 'eu-west', capacityClass: 1,
  softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: OWN_PAYOUT, guardianOf: [], timestamp: 1000n, ...over,
});
const displayTxid = (hex) => toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse());

// the victim's real, signed bond (60,000 sat) at height 150
const realAdvert = advertFor();
const realHex = toHex(bondTransaction(realAdvert, { previousTxid: b32(0xa1), outputKey: bondFor(keyFor(VICTIM)), value: 60000,
  signature: schnorr.sign(advertId(realAdvert), SECRET) }));
// the stranger's dust bond to the victim's key at height 170: an unsigned body (64 zero bytes), the victim's fields copied,
// the payout key and endpoint his, timestamp one above the victim's
const forgedHex = toHex(bondTransaction(advertFor({ payoutPubkey: ATTACKER_PAYOUT, endpoint: 'wss://victim.example', timestamp: 1001n }),
  { previousTxid: b32(0xee), outputKey: bondFor(keyFor(VICTIM)), value: 330 }));
const txs = new Map([[displayTxid(realHex), { hex: realHex, height: 150, sats: 60000 }], [displayTxid(forgedHex), { hex: forgedHex, height: 170, sats: 330 }]]);
const BOND_SPK = `5120${toHex(bondFor(keyFor(VICTIM)))}`;

function fakeBitcoind() {
  const sent = [];
  let carrierSpk = null;
  const cli = (m0, ...a0) => {
    const [m, ...a] = m0 === '-named' ? a0 : [m0, ...a0];
    switch (m) {
      case 'listwallets': return '["arena"]';
      case 'getblockcount': return '200';
      case 'getblockhash': return `hash-${a[0]}`;
      case 'getblock': return JSON.stringify({ tx: [] });
      case 'getrawtransaction': { const t = txs.get(a[0]); if (!t) throw new Error('No such mempool or blockchain transaction'); return t.hex; }
      case 'getmempoolentry': throw new Error('Transaction not in mempool');
      case 'decodescript': carrierSpk = a[0]; return JSON.stringify({ address: 'bcrt1pcarrier' });
      case 'walletcreatefundedpsbt': return JSON.stringify({ psbt: 'p', fee: 0.00001 });
      case 'walletprocesspsbt': return JSON.stringify({ psbt: 'p' });
      case 'finalizepsbt': return JSON.stringify({ complete: true, hex: '00ff' });
      case 'decoderawtransaction':
        if (a[0] === '00ff') return JSON.stringify({ txid: 'cc'.repeat(32), vout: [{ n: 0, scriptPubKey: { hex: carrierSpk } }] });
        return JSON.stringify({ txid: displayTxid(a[0]) });
      case 'getnewaddress': return 'bcrt1qchange';
      case 'getaddressinfo': return JSON.stringify({ scriptPubKey: `0014${'00'.repeat(20)}` });
      case 'testmempoolaccept': return JSON.stringify(JSON.parse(a[0]).map(() => ({ allowed: true })));
      case 'sendrawtransaction': sent.push(a[0]); return 'ok';
      default: throw new Error(`fake bitcoind: no ${m}`);
    }
  };
  // scantxoutset: the bond key finds both outputs that pay it (the UTXO set does not know who funded them); no markers
  const scan = (descriptors) => ({ success: true, unspents: descriptors.includes(`raw(${BOND_SPK})`)
    ? [...txs.entries()].map(([txid, t]) => ({ txid, vout: 0, height: t.height, amount: t.sats / 1e8, scriptPubKey: BOND_SPK })) : [] });
  return { cli, scan, sent };
}


test('refute #3016: findBond does not reuse a stranger\'s unsigned dust bond as the node\'s bond', () => {
  const { cli, scan } = fakeBitcoind();
  const rt = regtest(cli, { network: 'regtest', scan });
  const b = rt.findBond({ pubkey: keyFor(VICTIM) }, { endpoint: 'wss://victim.example' });
  assert.ok(b, 'the node has its own bond');
  const zeroSig = !b.bondSignature || b.bondSignature.every((x) => x === 0);
  console.log(`  MEASURED: findBond -> ${b.txid === displayTxid(forgedHex) ? 'the STRANGER\'s dust bond' : 'the node\'s own bond'} (${b.sats} sat), signed=${b.signed}, `
    + `bondSignature zero=${zeroSig}, payoutPubkey=${toHex(b.bondAdvert.payoutPubkey) === toHex(ATTACKER_PAYOUT) ? 'ATTACKER\'s' : 'own'}`);
  assert.notEqual(b.txid, displayTxid(forgedHex), 'findBond reused the stranger\'s unsigned dust bond');
  assert.notEqual(toHex(b.bondAdvert.payoutPubkey), toHex(ATTACKER_PAYOUT));
});
