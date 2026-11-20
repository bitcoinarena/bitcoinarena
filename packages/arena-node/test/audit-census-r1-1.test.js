// Audit 2026-11-19, module census, round 1, finding 1.
// THE SEAT RE-SIGNS A STRANGER'S UNSIGNED BOND BODY AS ITS OWN ADVERTISEMENT.
//
// The seat's own bond-wallet reader (tools/regtest-bond.mjs bondsOf, used by add-bond-wallet.js guardianOfFromWallet -
// the automatic advert-self check every 10 min - and by Add to bond / the roles change) lists every unspent output paying
// the node's bond output key and takes the body committed in its witness as that output's advertisement. It never checks the
// body's signature (it reads `advertSignature` and drops it). Anyone can pay a bond output to any node's key (the key is
// built from public data), so a stranger posts a 330-sat bond to the victim's key with an UNSIGNED copy of the victim's
// advertisement where only the payout key and the endpoint are his, and a timestamp one tick above the victim's newest.
// inForceOf then picks the stranger's output (highest timestamp, #2426), and the seat builds its next update on that body
// (ownAdvertAfter spreads `...now`) and SIGNS it with the node key: the node itself now advertises, signed, the stranger's
// payoutPubkey (roster.js guardianPayoutsFor pays the guardian custody share to it) and endpoint (where seats and players
// dial it). Unlike #2994 (the census reading an unsigned body), this survives a census that checks signatures: the body is
// now the victim's own signature.
// Safe behaviour: a body the node never signed is not its advertisement in force - what the seat signs is built only from
// bodies signed by its own key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { readAdvertUpdate } from '../../arena-protocol/src/advert-update.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { keyFor, bondFor } from './curve.js';
import { guardianOfFromWallet } from '../src/add-bond-wallet.js';
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
const forgedHex = toHex(bondTransaction(advertFor({ payoutPubkey: ATTACKER_PAYOUT, endpoint: 'wss://attacker.example', timestamp: 1001n }),
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

test('audit census r1-1: the seat\'s own advertisement update is built from bodies its node signed, not from a stranger\'s unsigned dust bond', async () => {
  const { cli, scan, sent } = fakeBitcoind();
  // the advert-self check: a new game version to announce (kanban #685), the guardians kept
  const NEW_GAME = b32(0x47);
  const r = await guardianOfFromWallet({ cli, network: 'regtest', secret: SECRET, guardianOf: [], hostedGames: [NEW_GAME], post: true, keep: true, scan });
  assert.equal(r.ok, true, r.why);
  const updateHex = sent.find((h) => h !== '00ff');
  assert.ok(updateHex, 'the seat posted its update');
  const read = readAdvertUpdate(fromHex(updateHex), { network: 'regtest' });
  assert.equal(read.ok, true, read.why);
  const signedByVictim = schnorr.verify(read.signature, read.advertId, keyFor(VICTIM));
  const onOutput = `${toHex(Uint8Array.from(read.bondTxid).reverse())}:${read.bondVout}`;
  console.log(`  MEASURED: update signed by the victim=${signedByVictim}, on output ${onOutput === `${displayTxid(forgedHex)}:0` ? 'the STRANGER\'s dust bond' : 'the victim\'s own bond'}, `
    + `payoutPubkey=${toHex(read.advert.payoutPubkey) === toHex(ATTACKER_PAYOUT) ? 'ATTACKER\'s' : 'own'}, endpoint=${read.advert.endpoint}`);
  assert.equal(signedByVictim, true);
  assert.notEqual(toHex(read.advert.payoutPubkey), toHex(ATTACKER_PAYOUT), 'the node signed the stranger\'s payout key into its own advertisement');
  assert.notEqual(read.advert.endpoint, 'wss://attacker.example', 'the node signed the stranger\'s endpoint into its own advertisement');
});

