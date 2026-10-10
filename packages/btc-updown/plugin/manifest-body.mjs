// BITCOIN UP OR DOWN 15M ON TESTNET4: ITS MANIFEST BODY (kanban #293 step 1), as its developer signs it with the dev client:
//   node packages/arena-donor/bin/arena-donor.mjs sign ~/.config/blwp/updown-tn4/dev packages/btc-updown/plugin/manifest-body.mjs
// then the printed hex into updown-tn4-manifest.js. The market is the regtest test market's (#236/#237) in every term -
// question, source rule, fees, its 15-minute period, outcomes, 2 of 3 - and its client byte for byte (frozen by hash), but
// with keys of its own: its developer's and three attestors' (attestors.js), never the regtest market's public test words.
// Its developer donation goes to testnet4's donation key set, as nextblock's and Rock Paper Scissors' do.
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../../arena-protocol/src/manifest.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { TESTNET4_DONATION_SET_KEYS } from '../../arena-protocol/src/testnet4-donation-set-keys.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { UPDOWN_TERMS, UPDOWN_PERIOD_MS, UPDOWN_CLIENT_HASH } from '../../arena-node/test/plugins/updown/index.js';
import { UPDOWN_TN4_ATTESTORS, UPDOWN_TN4_DEV_PUBKEY } from './attestors.js';

export const BODY = {
  gameName: 'btc-updown-15m', gameDevPubkey: fromHex(UPDOWN_TN4_DEV_PUBKEY), version: 1, parentManifestId: NO_PARENT,
  resultType: RESULT_TYPE.ATTESTED, cores: [], runTicksMax: 0, roundPeriodMs: UPDOWN_PERIOD_MS,
  payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [new Uint8Array(UPDOWN_CLIENT_HASH)],
  gameDonationSetId: donationSetId(TESTNET4_DONATION_SET_KEYS.recipients),
  outcomes: [...UP_DOWN_OUTCOMES],
  // in key order, as a manifest lists them
  attestors: Object.values(UPDOWN_TN4_ATTESTORS).map(fromHex).sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))),
  attestThreshold: 2,
  marketTerms: UPDOWN_TERMS,
};
