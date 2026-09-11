// THE POOL, SPENT ON A REAL CHAIN.
//
// `pool-spend.test.js` proves that BIP-340 accepts a witness five seats
// produced. That is our own verifier agreeing with our own construction of the
// sighash - and a sighash built wrong produces a perfectly valid signature over
// the wrong message, which no unit test can tell from a right one. A wallet
// that only exists in a unit test is not a wallet.
//
// So this funds the committee's key on an ISOLATED regtest - its own bitcoind
// datadir, non-default ports, cookie auth, stopped when the numbers are in -
// and asks a real consensus engine:
//
//   five of seven      sendrawtransaction -> a txid, and a block contains it
//   four of seven      REJECTED, and bitcoind says why
//   one operator alone REJECTED
//
// It touches no mainnet and no testnet4 datadir. The coins are worthless.
//
//   node packages/blwp-node/tools/pool-regtest.mjs [--keep]
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

import { trustedDealerSplit } from '../../protocol/src/frost.js';
import { nonceGenerate340 } from '../../protocol/src/frost-bip340.js';
import { signShare340, aggregate340, evenGroupSecret } from '../../protocol/src/frost-bip340.js';
import { poolOutput, poolShare, poolSigningKey, poolWitness } from '../../protocol/src/pool.js';
import { tapSighash, serializeSpend } from '../../protocol/src/bond-spend.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { scalarFrom32, FIELD, SHARES_NEEDED, SHARES_TOTAL } from '../../protocol/src/shares.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

const BITCOIN = process.env.BITCOIN_BIN || '/mnt/bitcoin/bitcoin-31.1/bin';
const KEEP = process.argv.includes('--keep');
const P = { rpc: 29653, p2p: 29654 };
const rand = (n) => new Uint8Array(randomBytes(n));
const curve = { ...feldmanGroup, tweakPoint };
const say = (s) => console.log(s);

const sh = (bin, args) => execFileSync(bin, args,
  { encoding: 'utf8', maxBuffer: 8 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function until(what, check, ms = 60000) {
  const stop = Date.now() + ms;
  for (;;) {
    let got = null;
    try { got = await check(); } catch { got = null; }
    if (got) return got;
    if (Date.now() > stop) throw new Error(`gave up waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** A 5-of-7 committee and the pool output it owns. */
function committee() {
  const even = evenGroupSecret(scalarFrom32(rand(32)) % FIELD, feldmanGroup);
  const dealt = trustedDealerSplit({
    secret: even.secret, max: SHARES_TOTAL, min: SHARES_NEEDED,
    coefficients: Array.from({ length: SHARES_NEEDED - 1 }, () => scalarFrom32(rand(32)) % FIELD),
    curve: feldmanGroup,
  });
  const out = poolOutput({ groupPublicKey: dealt.groupPublicKey, curve });
  if (!out.ok) throw new Error(out.why);
  return { dealt, out };
}

/** Round one and two over the tweaked shares, for one signing set. */
function sign({ dealt, out, sighash, who }) {
  const signers = who.map((id) => {
    const share = poolShare({
      share: dealt.shares.find((s) => s.id === id).share,
      tweak: out.tweak, negated: out.negated,
    });
    const hiding = nonceGenerate340(rand(32), share);
    const binding = nonceGenerate340(rand(32), share);
    return { id, share, hiding, binding,
      commitment: { id,
        hiding: feldmanGroup.pointFromScalar(hiding),
        binding: feldmanGroup.pointFromScalar(binding) } };
  });
  const commitments = signers.map((s) => s.commitment);
  const groupPublicKey = poolSigningKey(out.outputKey);
  const shares = signers.map((s) => signShare340({
    id: s.id, share: s.share, groupPublicKey,
    nonces: { hiding: s.hiding, binding: s.binding },
    message: sighash, commitments, curve: feldmanGroup,
  }));
  return aggregate340({ commitments, message: sighash, groupPublicKey, shares, curve: feldmanGroup });
}

async function main() {
  const dir = process.env.POOLRT || mkdtempSync(join(tmpdir(), 'pool-regtest-'));
  mkdirSync(join(dir, 'btc'), { recursive: true });
  say(`an isolated regtest of its own: ${dir}`);
  const btcArgs = ['-regtest', `-datadir=${join(dir, 'btc')}`, `-rpcport=${P.rpc}`];
  const cli = (...a) => sh(join(BITCOIN, 'bitcoin-cli'), [...btcArgs, ...a]);
  const cookie = join(dir, 'btc', 'regtest', '.cookie');
  const problems = [];

  try {
    spawn(join(BITCOIN, 'bitcoind'), [...btcArgs, `-port=${P.p2p}`, '-listenonion=0',
      '-fallbackfee=0.0001', '-txindex', '-daemon'], { stdio: 'ignore' });
    await until('bitcoind', () => existsSync(cookie) && cli('getblockcount'));
    try { cli('createwallet', 'pool'); } catch { cli('loadwallet', 'pool'); }
    const mine = (n) => cli('generatetoaddress', String(n), cli('getnewaddress'));
    if (Number(cli('getblockcount')) < 200) mine(200 - Number(cli('getblockcount')));
    say(`bitcoind ${cli('-getinfo') ? '' : ''}at height ${cli('getblockcount')}, rpc ${P.rpc}, cookie auth`);

    // ---- THE COMMITTEE'S KEY, AND AN OUTPUT PAYING TO IT. ----
    const { dealt, out } = committee();
    const address = JSON.parse(cli('decodescript', toHex(out.script))).address;
    say(`\nthe pool key is ${toHex(out.outputKey)}`);
    say(`  which bitcoind reads as ${address}`);
    say(`  the output commits to no script: tweak by the key alone, empty merkle root`);

    const funding = cli('sendtoaddress', address, '0.001');
    mine(1);
    const raw = cli('getrawtransaction', funding);
    const tx = parseTransaction(fromHex(raw));
    const vout = tx.outputs.findIndex((o) => toHex(o.script) === toHex(out.script));
    if (vout < 0) throw new Error('the funding transaction pays no pool output');
    const value = tx.outputs[vout].value;
    say(`  funded: ${funding.slice(0, 16)}...:${vout}, ${value} sats`);

    // ---- ONE SPEND, BACK TO A WALLET ADDRESS. ----
    const back = fromHex(JSON.parse(cli('getaddressinfo', cli('getnewaddress'))).scriptPubKey);
    const inputs = [{ txid: fromHex(funding).reverse(), vout, sequence: 0xfffffffd }];
    const prevouts = [{ value, script: out.script }];
    const outputs = [{ value: value - 500n, script: back }];
    const sighash = tapSighash({ inputs, prevouts, outputs, inputIndex: 0 });

    const attempt = (who) => {
      const sig = sign({ dealt, out, sighash, who });
      return {
        accepted: schnorr.verify(sig.signature, sighash, out.outputKey),
        raw: toHex(serializeSpend({ inputs, outputs, witnesses: [poolWitness(sig.signature)] })),
      };
    };
    const send = (hex) => {
      try { return { ok: true, txid: cli('sendrawtransaction', hex) }; }
      catch (e) {
        // BITCOIND'S OWN WORDS, not just its exit code. "error code: -26" says
        // a policy or consensus check refused it and nothing about which one,
        // and which one is the whole point of this measurement.
        const said = (e.stderr || e.message).trim().split('\n').map((l) => l.trim())
          .filter((l) => l && !/^error code:/.test(l) && !/^error message:$/.test(l));
        return { ok: false, why: said.join(' ') || 'refused without saying why' };
      }
    };

    say('\nfour of seven try to move the pool:');
    const four = send(attempt([1, 2, 3, 4]).raw);
    say(`  ${four.ok ? 'ACCEPTED ' + four.txid : 'rejected: ' + four.why}`);
    if (four.ok) problems.push('four of seven moved the pool');

    say('one operator alone tries:');
    const one = send(attempt([3]).raw);
    say(`  ${one.ok ? 'ACCEPTED ' + one.txid : 'rejected: ' + one.why}`);
    if (one.ok) problems.push('one operator moved the pool');

    say('five of seven:');
    const five = attempt([2, 3, 4, 5, 6]);
    const sent = send(five.raw);
    say(`  ${sent.ok ? 'sendrawtransaction -> ' + sent.txid : 'REJECTED: ' + sent.why}`);
    if (!sent.ok) problems.push(`five of seven were rejected: ${sent.why}`);

    if (sent.ok) {
      mine(1);
      const height = Number(cli('getblockcount'));
      const block = JSON.parse(cli('getblock', cli('getblockhash', String(height))));
      const inIt = block.tx.includes(sent.txid);
      say(`  and block ${height} ${inIt ? 'contains it' : 'DOES NOT contain it'}`);
      if (!inIt) problems.push('the accepted spend never made it into a block');
      const spent = JSON.parse(cli('gettxout', funding, String(vout)) || 'null');
      say(`  the pool output is ${spent === null ? 'spent' : 'STILL UNSPENT'}`);
      if (spent !== null) problems.push('the pool output was not spent');
    }

    say('');
    if (problems.length) {
      for (const p of problems) console.error('  ' + p);
      console.error(`pool on regtest: ${problems.length} problem(s)`);
      process.exitCode = 1;
    } else {
      say('pool on regtest: five of seven spent the committee\'s output and consensus took it.');
      say('four could not, and one alone could not.');
    }
  } finally {
    if (KEEP) { say(`\nleft running, --keep: ${dir}`); return; }
    say('\nstopping bitcoind.');
    try { sh(join(BITCOIN, 'bitcoin-cli'), [...btcArgs, 'stop']); } catch { /* not running */ }
    await new Promise((r) => setTimeout(r, 3000));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
    say('stopped, and the scratch datadir is gone. No testnet or mainnet datadir was touched.');
  }
}

await main();
