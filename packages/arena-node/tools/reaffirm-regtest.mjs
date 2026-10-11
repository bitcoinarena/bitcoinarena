// A BLWP BOND CARRIED ONTO BITCOIN ARENA ON A REAL REGTEST (kanban #209 step 1, spec 0A.9 / §27A.8.3): the bond is posted
// by the BLWP network's own code (the phase0 tree, PHASE0_TREE), exactly as testnet4's seven were; this tree's census
// reads the chain bitcoind made; this tree's builder re-affirms it (prepareReaffirmation / postReaffirmation) and updates
// its advertisement with hosted_games. What is read at each step, and that the bond is never spent.
//
//   bitcoind -regtest -datadir=DIR -port=29444 -rpcport=29443 -fallbackfee=0.0001 -txindex -daemon
//   RT=DIR PHASE0_TREE=<phase0 checkout> node tools/reaffirm-regtest.mjs        (from packages/arena-node)
import { execFileSync } from 'node:child_process';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { regtest } from './regtest-bond.mjs';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const env = process.env;
if (!env.RT || !env.PHASE0_TREE) { console.error('RT=<datadir> and PHASE0_TREE=<phase0 checkout> are required'); process.exit(2); }
const B = env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli';
const cli = (...a) => execFileSync(B, ['-regtest', `-datadir=${env.RT}`, `-rpcport=${env.RPCPORT || '29443'}`, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v)));

const { regtest: phase0Regtest } = await import(`${env.PHASE0_TREE}/packages/blwp-node/tools/regtest-bond.mjs`);
const old = phase0Regtest(cli, { wallet: 'reaffirm209' });
const arena = regtest(cli, { wallet: 'reaffirm209' });
if (arena.height() < 101) arena.mine(101);

// THE CENSUS, AS A SEAT DERIVES IT (the curve injected for the template; BIP-340 for updates and re-affirmations)
const big = (b) => BigInt('0x' + toHex(b));
const g = genesisFor('regtest');
const BOND = { arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity: g.bondMaturity,
  tweakPoint: (P, t) => { const Q = schnorr.utils.lift_x(big(P)).add(secp256k1.Point.BASE.multiply(big(t)));
    return { outputKey: schnorr.utils.pointToBytes(Q), parity: Number(Q.toAffine().y & 1n) }; },
  combine: (terms) => { let s = null; for (const { key, coefficient } of terms) { const p = schnorr.utils.lift_x(big(key)).multiply(big(coefficient)); s = s === null ? p : s.add(p); } return schnorr.utils.pointToBytes(s); } };
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const resolve = (e) => ({ transaction: fromHex(cli('getrawtransaction', toHex([...e.txid].reverse()))) });
const census = (from) => {
  const tip = arena.height();
  const contract = { bondMinSats: 1000000n, protocolVersion: 1, networkId: NETWORK_ID_REGTEST, censusHeight: tip, censusConfirmations: 1, gameId: NEXTBLOCK_GAME_ID };
  const out = deriveCensus(arena.blocksFrom(from, tip), { contract, resolve, bond: BOND, verifyUpdate: verify });
  return { at: tip, ok: out.ok, why: out.why, root: out.root && toHex(out.root).slice(0, 16),
    counted: (out.entries || []).map((e) => ({ endpoint: e.advert.endpoint, ancestor: !!e.ancestor, reaffirmedAt: e.reaffirmedBy && e.reaffirmedBy.height,
      updatedAt: e.updatedBy && e.updatedBy.height, hosts: (e.hostedGames || []).map((x) => toHex(x).slice(0, 16)) })),
    excluded: (out.excluded || []).map((e) => ({ step: e.step, why: e.why })) };
};

// 1. THE BLWP NETWORK POSTS A BOND, with its own code: its marker, its advertisement layout, its advert id
const SECRET = new Uint8Array(32).fill(0x5a);
const posted = old.postBond(SECRET, { endpoint: 'wss://blwp-seat.example/', bondSats: 2000000n });
const from = arena.height();
cli('sendrawtransaction', posted.hex); arena.mine(2);
const bond = { txid: posted.txid, vout: 0 };
const outpoint = () => { const o = cli('gettxout', bond.txid, '0'); return o ? JSON.parse(o).value : null; };
say({ step: 'posted by phase0 code', txid: bond.txid, height: arena.height(), bondBtc: outpoint() });
say({ step: 'census before', ...census(from) });

// 2. THE OPERATOR RE-AFFIRMS IT FOR THIS NETWORK, with this tree's builder - spending a carrier, never the bond
const found = arena.bondsOf(SECRET);
say({ step: 'bondsOf (this tree)', found: found.map((b) => ({ txid: b.txid, vout: b.vout, ancestor: !!b.ancestor, endpoint: b.advert.endpoint })) });
const prepared = arena.prepareReaffirmation(SECRET, found[0], { networkId: NETWORK_ID_REGTEST });
const reaffirmed = arena.postReaffirmation(prepared);
say({ step: 'testmempoolaccept', result: JSON.parse(cli('testmempoolaccept', JSON.stringify([reaffirmed.hex])))[0] });
cli('sendrawtransaction', reaffirmed.hex); arena.mine(1);
say({ step: 'census after re-affirmation', txid: reaffirmed.txid, ...census(from) });

// 3. AND ITS ADVERTISEMENT UPDATED TO NAME THE GAME IT HOSTS (§5A.2), this tree's layout and tags
const advert = { ...found[0].advert, hostedGames: [NEXTBLOCK_GAME_ID], timestamp: BigInt(Date.now()) };
const upd = arena.postAdvertUpdate(arena.prepareAdvertUpdate(SECRET, advert), found[0]);
cli('sendrawtransaction', upd.hex); arena.mine(1);
say({ step: 'census after the update', txid: upd.txid, ...census(from) });
say({ step: 'the bond', unspent: outpoint() !== null, bondBtc: outpoint() });

// 4. AND MOVED INTO TEMPLATE 2 AT ITS OWN HEIGHT (kanban #295), as testnet4's seven will be: path A of the carried bond
// (its maturity genesis' 100, long past) into a template-2 bond of the same value whose leaf carries the next block + slack
// + the offset, with the advertisement it stands for now - checked by testmempoolaccept before it is broadcast. Then the
// census counts the new bond as this network's own (no re-affirmation needed), the old one is gone, and path A of the new
// one is refused one block before its height.
{
  const before = arena.bondsOf(SECRET)[0];
  const prepared = arena.prepareRebond(SECRET, before, { ...before.advert, timestamp: BigInt(Date.now()) });
  const moved = arena.postRebond(prepared);
  const dry = JSON.parse(cli('testmempoolaccept', JSON.stringify([moved.hex])))[0];
  say({ step: 're-bond testmempoolaccept', allowed: dry.allowed, why: dry['reject-reason'] || null, oldMaturity: before.maturity, maturity: moved.maturity, sats: moved.bondSats });
  if (!dry.allowed) throw new Error('the re-bond is refused; nothing is broadcast');
  cli('sendrawtransaction', moved.hex); arena.mine(1);
  const confirmedAt = arena.height();
  const after = arena.bondsOf(SECRET);
  say({ step: 'bondsOf after the re-bond', found: after.map((b) => ({ txid: b.txid, vout: b.vout, template: b.advert.bondScriptTemplateVersion, maturity: b.maturity, ancestor: !!b.ancestor })) });
  say({ step: 'old bond spent', unspent: outpoint() !== null });
  say({ step: 'census after the re-bond', confirmedAt, ...census(from) });
  // path A of the new bond, at H - 1 and at H, asked of bitcoind now (tip far below H)
  const { recoveryLeaf, controlBlockFor, tapLeafHash } = await import('../../arena-protocol/src/bond-script.js');
  const { tapSighash, scriptPathWitness, serializeSpend } = await import('../../arena-protocol/src/bond-spend.js');
  const nb = after[0];
  const leaf = recoveryLeaf(nb.advert.nodePubkey, nb.maturity);
  const spk = fromHex('5120' + toHex(prepared.built.outputKey));
  const payTo = arena.payTo();
  const spend = (locktime) => {
    const tx = { version: 2, locktime, inputs: [{ txid: fromHex(nb.txid).reverse(), vout: nb.vout, sequence: 0xfffffffe }], outputs: [{ value: BigInt(nb.sats) - 2000n, script: payTo }] };
    const sig = schnorr.sign(tapSighash({ ...tx, prevouts: [{ value: BigInt(nb.sats), script: spk }], inputIndex: 0, leafHash: tapLeafHash(leaf) }), SECRET);
    const r = JSON.parse(cli('testmempoolaccept', JSON.stringify([toHex(serializeSpend({ ...tx, witnesses: [scriptPathWitness({ stack: [sig], script: leaf, controlBlock: controlBlockFor('recovery', prepared.built).controlBlock })] }))])))[0];
    return { allowed: r.allowed, why: r['reject-reason'] || null };
  };
  say({ step: 'new bond path A now', tip: arena.height(), atHminus1: spend(nb.maturity - 1), atH: spend(nb.maturity) });
}
