/**
 * THE DONATION AUTHORITY AND RECOVERY KEYS, BY THE NETWORK ID A ROUND CONTRACT
 * CARRIES (M3.2 6e, §27A.4). A signer node and a page know a round's network by its
 * id, not by a name; a network with no generated donation authority answers
 * null. Its own module, reading only genesis-ids.js, so the page bundle can use
 * it without genesis.js (which reads the core's game rules).
 */
import {
  NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4,
  AUTHORITY_PUBKEY_REGTEST, RECOVERY_PUBKEY_REGTEST, AUTHORITY_PUBKEY_TESTNET4, RECOVERY_PUBKEY_TESTNET4,
} from './genesis-ids.js';
import { isOldTestnet4Id } from './old-series.js';

export function donationKeysForNetworkId(networkId) {
  const is = (known) => networkId instanceof Uint8Array && networkId.length === 32
    && networkId.every((x, i) => x === known[i]);
  if (is(NETWORK_ID_REGTEST)) return { network: 'regtest', authority: AUTHORITY_PUBKEY_REGTEST, recovery: RECOVERY_PUBKEY_REGTEST };
  if (is(NETWORK_ID_TESTNET4)) return { network: 'testnet4', authority: AUTHORITY_PUBKEY_TESTNET4, recovery: RECOVERY_PUBKEY_TESTNET4 };
  // PICK B (old-series.js): the same testnet4 authority signed the set series 3cfbe516 names under the old id
  if (isOldTestnet4Id(networkId)) return { network: 'testnet4', authority: AUTHORITY_PUBKEY_TESTNET4, recovery: RECOVERY_PUBKEY_TESTNET4 };
  return null;
}
