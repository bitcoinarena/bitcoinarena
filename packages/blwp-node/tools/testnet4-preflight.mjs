// CAN THE OPERATOR'S TESTNET4 LND HOLD A ROUND? Asked, never acted on.
//
//   node packages/blwp-node/tools/testnet4-preflight.mjs \
//     [--lnddir /mnt/bitcoin/lnd-testnet4] [--players 2] [--stake-msat 100000]
//
// READ-ONLY BY CONSTRUCTION, not by care: every call carries the node's
// `readonly.macaroon`, which cannot create an invoice, open a channel or send a
// satoshi, so a bug in this file cannot move money. And it refuses any lnddir
// whose own lnd.conf does not say `bitcoin.testnet4=true` - the mainnet lnd on
// this machine sits one directory over.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lightningPreflight } from '../src/preflight.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const LNCLI = (process.env.LND_BIN || '/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta') + '/lncli';
const lnddir = arg('lnddir', '/mnt/bitcoin/lnd-testnet4');
const players = Number(arg('players', '2'));
const stakeMsat = BigInt(arg('stake-msat', '100000'));

const conf = readFileSync(`${lnddir}/lnd.conf`, 'utf8');
if (/mainnet/i.test(lnddir) || !/^bitcoin\.testnet4\s*=\s*(true|1)\s*$/m.test(conf)) {
  console.error(`refused: ${lnddir} is not a testnet4 lnd by its own lnd.conf`);
  process.exit(2);
}
const rpc = (conf.match(/^rpclisten\s*=\s*(\S+)/m) || [])[1] || '127.0.0.1:10009';
const args = [`--lnddir=${lnddir}`, '--network=testnet4', `--rpcserver=${rpc}`,
  `--macaroonpath=${lnddir}/data/chain/bitcoin/testnet4/readonly.macaroon`];
const ask = (...argv) => JSON.parse(execFileSync(LNCLI, [...args, ...argv], { encoding: 'utf8', timeout: 30000 }));

const info = ask('getinfo');
const { channels } = ask('listchannels');
let holdInvoices = false;
try { execFileSync(LNCLI, ['addholdinvoice', '--help'], { stdio: 'ignore' }); holdInvoices = true; } catch { /* absent */ }

const entry = { stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n };
const said = lightningPreflight({ info, channels, holdInvoices, players, entry });

console.log(`node      ${lnddir} (${said.network}), block ${info.block_height}, synced ${info.synced_to_chain}`);
console.log(`channels  ${said.facts.activeChannels ?? 0} active, outbound ${said.facts.outboundMsat ?? 0n} msat, `
  + `usable inbound ${said.facts.inboundMsat ?? 0n} msat`);
console.log(`a round   ${players} seat(s) at ${stakeMsat} msat: each hold is ${said.facts.heldPerSeatMsat} msat `
  + `(the net of the 2% fee), ${said.facts.neededMsat} msat of inbound in all`);
console.log(`hold      lncli offers addholdinvoice: ${holdInvoices} (the server side is proven only by issuing one)`);
console.log(said.ready ? 'READY' : `NOT READY: ${said.missing.join('; ')}`);
process.exit(said.ready ? 0 : 1);
