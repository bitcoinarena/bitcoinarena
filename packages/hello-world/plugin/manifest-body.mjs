// HELLO WORLD, THE SMALLEST MARKET (kanban #276, the owner 2026-10-11: "Mach eine Art hello world game/market die nur eine node
// hat damit andere das sehen können"): an attested market of two outcomes, one attestor, no client, its own developer key
// (~/.config/blwp/hello-world-dev, never a seat's). Hosted by one testnet4 seat so the others find it on the network and can
// install it from their owner page. Signed with the dev client:
//   node packages/arena-donor/bin/arena-donor.mjs sign ~/.config/blwp/hello-world-dev packages/hello-world/plugin/manifest-body.mjs
// then the printed hex into hello-world-manifest.js.
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from 'arena-sdk/manifest';
import { fromHex } from 'arena-sdk/hash';
import { donationSetId } from 'arena-sdk/donation';
import { TESTNET4_DONATION_SET_KEYS } from 'arena-sdk/testnet4-donation-set-keys';

export const HELLO_WORLD_DEV_PUBKEY = '784e19811b32a0065bd5fb10c38539b5e09429302a8ff38afc61ad94cc562d8d';
export const HELLO_WORLD_ATTESTOR = '9b439af5608b1eec47644f8aabc4dd20d94408139a62bcc30acf371e52a60138';

export const BODY = {
  gameName: 'hello-world', gameDevPubkey: fromHex(HELLO_WORLD_DEV_PUBKEY), version: 1, parentManifestId: NO_PARENT,
  resultType: RESULT_TYPE.ATTESTED, cores: [], runTicksMax: 0, roundPeriodMs: 900000n,
  payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [],
  gameDonationSetId: donationSetId(TESTNET4_DONATION_SET_KEYS.recipients),
  outcomes: ['Hello', 'World'],
  attestors: [fromHex(HELLO_WORLD_ATTESTOR)],
  attestThreshold: 1,
};
