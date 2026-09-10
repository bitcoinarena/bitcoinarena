// CAN THE OPERATOR'S TESTNET4 LND HOLD A ROUND? Asked, never acted on.
//
//   node packages/blwp-node/tools/testnet4-preflight.mjs \
//     [--lnddir /mnt/bitcoin/lnd-testnet4] [--players 2] [--stake-msat 100000]
//
// READ-ONLY BY CONSTRUCTION, not by care: `askLnd` carries the node's
// `readonly.macaroon` on every call and refuses any lnddir whose own lnd.conf
// is not testnet4. The daemon's gate (`lndPreflight`) asks the same way.
import { askLnd, lightningPreflight } from '../src/preflight.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const LNCLI = (process.env.LND_BIN || '/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta') + '/lncli';
const lnddir = arg('lnddir', '/mnt/bitcoin/lnd-testnet4');
const players = Number(arg('players', '2'));
const stakeMsat = BigInt(arg('stake-msat', '100000'));

let node;
try { node = askLnd({ lncli: LNCLI, lnddir }); }
catch (e) { console.error(`refused: ${e.message}`); process.exit(2); }

const entry = { stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n };
const said = lightningPreflight({ ...node, players, entry });

console.log(`node      ${lnddir} (${said.network}), block ${node.info.block_height}, synced ${node.info.synced_to_chain}`);
console.log(`channels  ${said.facts.activeChannels ?? 0} active, outbound ${said.facts.outboundMsat ?? 0n} msat, `
  + `usable inbound ${said.facts.inboundMsat ?? 0n} msat`);
console.log(`a round   ${players} seat(s) at ${stakeMsat} msat: each hold is ${said.facts.heldPerSeatMsat} msat `
  + `(the net of the 2% fee), ${said.facts.neededMsat} msat of inbound in all`);
console.log(`hold      lncli offers addholdinvoice: ${node.holdInvoices} (the server side is proven only by issuing one)`);
console.log(said.ready ? 'READY' : `NOT READY: ${said.missing.join('; ')}`);
process.exit(said.ready ? 0 : 1);
