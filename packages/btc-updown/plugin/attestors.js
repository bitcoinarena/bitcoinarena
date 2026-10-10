// THE TESTNET4 UP/DOWN MARKET'S ATTESTORS (kanban #293 step 1, the owner 2026-10-10: new testnet keys, kept on the test host, one
// attestor on the test host when it is online): their public keys, by letter. The private keys never leave their hosts
// (~/.config/blwp/updown-tn4/attestors/<letter>.pkcs8, 0600); the attestor daemon runs with `--key` on that file.
export const UPDOWN_TN4_ATTESTORS = Object.freeze({
  A: '7072d7a4eb29dbe9ebc380a6d10cbcd65707f243d58d9f3ad9280445fd32f70d',
  B: '3b74d3284f0a1a5148e39b826feaa9b222cc6717a24fbcc9a0cb00f39fb1935d',
  C: '6e304439f7f82be4f16baf3668df9a324181f21bd755d5c44e413913b5c444ab',
});
// its developer key (~/.config/blwp/updown-tn4/dev/game-dev.pkcs8): the manifest is signed with it, and an update of the
// market only by it
export const UPDOWN_TN4_DEV_PUBKEY = '65bcaf4120e334b6c17f276376d0b7129866317ab2a9b178ae0188e9c358a11a';
