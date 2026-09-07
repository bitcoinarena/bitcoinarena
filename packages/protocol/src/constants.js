// Everything a second implementation has to agree on before anything else can
// be compared: the version, the type bytes, and the hash tags.
//
// Tags are BIP-340 style and every hash in the protocol carries one, so a
// RoundContract digest can never collide with an Advert digest even if their
// bodies happen to encode identically. Adding a type means adding a tag, not
// reusing a neighbour's.

export const PROTOCOL_VERSION = 1;

export const TYPE_ROUND_CONTRACT = 0x01;
export const TYPE_ENTRY_CONTRACT = 0x02;
export const TYPE_ADVERT = 0x03;
export const TYPE_CENSUS_LEAF = 0x04;
export const TYPE_CHECKPOINT = 0x05;
export const TYPE_RESULT = 0x06;
export const TYPE_PAYOUT_TABLE = 0x07;

/**
 * What a player sends while a round is running.
 *
 * The only message a node takes in M2.1 that was not already here, and the
 * next free byte rather than a reuse: a batch digest must not be able to
 * collide with a contract's.
 */
export const TYPE_INPUT_BATCH = 0x08;

/** A whole round's inputs as one object - what a node hands over. */
export const TYPE_TRANSCRIPT = 0x09;

// The receipt a node returns for a checkpoint (section 10). The spec names
// the object but reserves no type for it, so this is the next free number.
export const TYPE_CHECKPOINT_RECEIPT = 0x0a;

/**
 * 13A's objection. The spec reserves neither a type nor a tag for it - it
 * gives the field list and nothing else - so both are new here, the way
 * `CheckpointReceipt` needed both, and both follow the numbering already in
 * use rather than starting a second one.
 */
export const TYPE_OBJECTION = 0x0b;

/**
 * 5A.3B's fraud proof. Same story as the objection: the spec names the
 * artifact - "the two contradicting signatures, or the transcript + receipts
 * + replay, or the payout table + its inputs" - and reserves neither a type
 * nor a tag, so both are the next free number here.
 *
 * It needs its own tag for a reason step 4 makes concrete: the slashing
 * transaction carries `H(fraud_proof)` in an OP_RETURN, so that hash is what
 * a stranger re-derives years later to check a spend was justified. A digest
 * that could collide with some other object's is a slash nobody can audit.
 */
export const TYPE_SLASH_PROOF = 0x0c;

/**
 * The settlement record of 5A.3 row 4: what a settlement node DID to a hold
 * invoice, and the conditions it published for having done it. 23.2's table
 * names the action and the requirements; the spec reserves no type for the
 * record itself, so this is the next free number, like the objection's.
 */
export const TYPE_SETTLEMENT_RECORD = 0x0d;

/**
 * 22A's fee share, as the two objects row 6 of 5A.3 needs: what a node CLAIMS
 * for a round and a role, and the record of what it actually did. The spec
 * gives the arithmetic and the availability rule and reserves no types, so
 * these are the next free numbers, like the objection's and the record's.
 */
export const TYPE_FEE_CLAIM = 0x0e;
export const TYPE_SERVICE_RECORD = 0x0f;

export const TAG = {
  roundContract: 'BLWP/v1/RoundContract',
  entryContract: 'BLWP/v1/EntryContract',
  advert: 'BLWP/v1/Advert',
  censusLeaf: 'BLWP/v1/CensusLeaf',
  censusBranch: 'BLWP/v1/CensusBranch',
  ticket: 'BLWP/v1/Ticket',
  checkpoint: 'BLWP/v1/Checkpoint',
  checkpointReceipt: 'BLWP/v1/CheckpointReceipt',
  result: 'BLWP/v1/Result',
  payoutTable: 'BLWP/v1/PayoutTable',
  inputBatch: 'BLWP/v1/InputBatch',
  transcript: 'BLWP/v1/Transcript',
  objection: 'BLWP/v1/Objection',
  slashProof: 'BLWP/v1/SlashProof',
  // The membership and floor a payout table was computed FROM. Its own tag
  // rather than the table's, because a proof binds to the inputs and a
  // signature binds to the table, and the two must never be interchangeable.
  payoutInputs: 'BLWP/v1/PayoutInputs',
  settlementRecord: 'BLWP/v1/SettlementRecord',
  feeClaim: 'BLWP/v1/FeeClaim',
  serviceRecord: 'BLWP/v1/ServiceRecord',
  // The record and the minimum a claim is measured against, bound as one hash
  // so an accuser cannot choose either of them after the fact.
  feeInputs: 'BLWP/v1/FeeInputs',
  vssShare: 'BLWP/v1/VssShare',
  remainder: 'BLWP/v1/Remainder',
};

/** Roles a bonded node can stand for. Order is protocol: it indexes roleByte. */
export const ROLES = ['game', 'verify', 'settlement', 'relay'];
export const roleByte = (role) => {
  const i = ROLES.indexOf(role);
  if (i < 0) throw new Error('unknown role: ' + role);
  return i;
};

/**
 * THE ONE ADDRESS EVERY BOND PAYS A DUST OUTPUT TO.
 *
 * Section 25.1: "A P2TR output is a 32-byte key and looks like every other
 * one, so a bond cannot be recognised from its output... OP_RETURN does not
 * help either: BIP158 compact filters exclude it." Hence the requirement:
 * "Every bond funding transaction MUST pay a dust output to BOND_MARKER, a
 * single address fixed by this protocol." One address for every bond, so it
 * appears in the compact filters and any light client can find every bond that
 * has ever existed without asking anyone. It costs one dust output, once.
 *
 * IT IS NOT CHOSEN HERE, and that is deliberate rather than unfinished. The
 * marker is part of the network's identity in the same way `genesis_parameters`
 * is: introducing or changing it later makes every bond posted before it
 * unfindable, so it has to be settled once, before the first bond exists, and
 * never again. Writing a plausible address into this file would be settling it
 * by accident in a source tree, which is exactly how such a thing gets decided
 * without anyone deciding it.
 *
 * So it is null, and `bondMarker()` refuses rather than returning something
 * that would silently match nothing. A search for bonds that quietly found
 * none would look exactly like a network with no nodes in it.
 */
export const BOND_MARKER = null;

export function bondMarker() {
  if (BOND_MARKER === null)
    throw new Error(
      'BOND_MARKER has not been chosen. It is fixed once, before the first bond '
      + 'is posted, and every bond ever posted is unfindable without it');
  return BOND_MARKER;
}

/**
 * The objection window's reference length: ten minutes, in milliseconds.
 *
 * Section 13A gives "reference: 10 minutes, contract-defined". A REFERENCE is
 * not a default: the number lives in the round contract the player signed, and
 * this is here so a round can be written with the figure the spec suggests
 * rather than one somebody remembered.
 */
export const OBJECTION_WINDOW_REFERENCE_MS = 600000n;

/**
 * WHICH CUSTODY CONSTRUCTION A ROUND USES. Section 23.6 names two and says
 * "The Round Contract names which construction it uses":
 *
 *   THRESHOLD_LN   a threshold-signed Lightning node - FROST-style Schnorr
 *                  over channel operations - which 23.6 calls "the cleanest
 *                  fit, and emerging technology rather than a solved product"
 *   FEDERATION     a Fedimint-class federation with a Lightning gateway,
 *                  "production-ready today, with an identical trust statement"
 *
 * "V1 deployments should use the mature one and migrate when threshold-LN
 * hardens", so a round has to SAY which one it ran under: the residual is the
 * same either way (22: five colluding bonded operators control in-transit
 * funds) but a player is entitled to know which construction they staked into,
 * and a round settled under one cannot be replayed as if it were the other.
 *
 * Naming them is not implementing them. Neither construction exists in this
 * repo and this field does not bring one.
 */
export const CUSTODY = ['THRESHOLD_LN', 'FEDERATION'];
export const custodyByte = (which) => {
  const at = CUSTODY.indexOf(which);
  if (at < 0) throw new Error(`${which} is not one of ${CUSTODY.join(', ')}`);
  return at;
};
