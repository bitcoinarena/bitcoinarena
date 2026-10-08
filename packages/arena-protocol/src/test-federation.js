// THE TEST FEDERATION (M3 W7, 2026-09-15): the one federation id the fixtures and the protocol
// vectors name for a stake-lock round that runs against a stand-in federation - the test lock port,
// never a federation that holds money. A round that takes a stake into a FEDERATION must name
// which one (§23.6); a test round names this one, the id its stand-in federation carries, and not
// an id typed into the round. It is bonded nowhere: no census lists its guardians, so
// federationIsBonded refuses it, as it must.
import { sha256 } from './hash.js';

export const TEST_FEDERATION_ID = sha256(new TextEncoder().encode('ARENA/v1/TEST_FEDERATION - a stand-in federation for tests and vectors, never one that holds money'));
