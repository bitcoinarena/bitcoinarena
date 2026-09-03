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

export const TAG = {
  roundContract: 'BLWP/v1/RoundContract',
  entryContract: 'BLWP/v1/EntryContract',
  advert: 'BLWP/v1/Advert',
  censusLeaf: 'BLWP/v1/CensusLeaf',
  censusBranch: 'BLWP/v1/CensusBranch',
  ticket: 'BLWP/v1/Ticket',
  checkpoint: 'BLWP/v1/Checkpoint',
  result: 'BLWP/v1/Result',
  payoutTable: 'BLWP/v1/PayoutTable',
  inputBatch: 'BLWP/v1/InputBatch',
  remainder: 'BLWP/v1/Remainder',
};

/** Roles a bonded node can stand for. Order is protocol: it indexes roleByte. */
export const ROLES = ['game', 'verify', 'settlement', 'relay'];
export const roleByte = (role) => {
  const i = ROLES.indexOf(role);
  if (i < 0) throw new Error('unknown role: ' + role);
  return i;
};
