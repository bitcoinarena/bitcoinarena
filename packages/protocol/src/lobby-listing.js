// ONE SEAT'S SIGNED WORD ABOUT ONE ROUND IN ITS LOBBY (M3.3-34).
//
// A round is played by its committee at the committee's threshold - 2 of 2 on
// regtest and testnet4, 5 of 7 on mainnet - so a round only ONE seat holds is
// a round nobody can play: every mark needs the threshold's receipts. A lobby
// that listed it on one node's word would offer a Join into a dead round.
//
// So each seat signs what it says about a round - that it holds it, in which
// phase, whether it has seated it, and its own counts, at a time - under its
// own node key, and the page counts DISTINCT SEATS OF THAT ROUND (keys the
// verified contract names) that say "open and seated". Join is offered only
// at the round's threshold. A listing decides nothing about money: it is what
// a seat says, signed so that one server cannot say it for two seats.
import { Writer } from './encode.js';
import { taggedHash } from './hash.js';
import { TAG } from './constants.js';

export const LOBBY_PHASES = ['pending', 'open'];

const lobbyIs32 = (b) => b instanceof Uint8Array && b.length === 32;
const lobbyCount = (n, what) => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`${what} is a whole count`);
  return n;
};

export function encodeLobbyListing({ roundId, nodePubkey, nowMs, phase, seatedHere, seated, playing } = {}) {
  if (!lobbyIs32(roundId)) throw new Error('a listing names a 32-byte round id');
  if (!lobbyIs32(nodePubkey)) throw new Error('a listing is signed by a 32-byte node key');
  const at = BigInt(nowMs);
  if (at < 0n) throw new Error('a listing\'s time is not negative');
  const p = LOBBY_PHASES.indexOf(phase);
  if (p < 0) throw new Error(`a listed round is ${LOBBY_PHASES.join(' or ')}, not ${phase}`);
  const w = new Writer();
  w.bytes32(roundId);
  w.bytes32(nodePubkey);
  w.u64(at);
  w.u8(p);
  w.u8(seatedHere ? 1 : 0);
  w.u32(lobbyCount(seated, 'seated'));
  w.u32(lobbyCount(playing, 'playing'));
  return w.finish();
}

/** What a seat signs (BIP-340, its node key) for one listed round. */
export const lobbyListingId = (listing) => taggedHash(TAG.lobbyListing, encodeLobbyListing(listing));
