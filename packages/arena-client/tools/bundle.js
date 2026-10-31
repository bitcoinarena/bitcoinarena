// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Bundles the Arena client into one file for the browser.
//
// The same smallest-possible bundler `nextblock` uses, and for the same
// stated reason: a bundler in the trust path is a bad property for something
// that pins money. It topologically sorts the imports, strips the import and
// export lines, and concatenates. No transforms, no minification, no renaming.
//
// IT CARRIES NO CRYPTO, and that is why it can be this simple. Signing and
// verifying are injected - the page hands the client `sign` and `verify` - so
// the bundle is the protocol's encoding plus the client's rules and nothing
// else. A vendored curve would be an implementation of the thing that pins
// money, sitting in the page, that nobody audits.
//
// The test that matters is bundle.test.js: the bundle must build the same
// bytes and the same ids as the modules, or it is not the same client.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
const ROOT = new URL('../../', import.meta.url).pathname;
// ARENA_BUNDLE_OUT builds into another directory, so a test can build this
// source and compare it with what is committed; unset, it writes dist/ as ever.
const OUT = process.env.ARENA_BUNDLE_OUT ? process.env.ARENA_BUNDLE_OUT.replace(/\/?$/, '/') : new URL('../dist/', import.meta.url).pathname;

const seen = new Set();
const order = [];

function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/import\s[\s\S]*?from\s+'([^']+)';/g)) {
    walk(resolve(dirname(file), m[1]));
  }
  order.push(file);
}
walk(SRC + 'client.js');
// (THE GHOSTS - what a page does with a picture once the client has decoded one - are Tick Tock's, so not the engine's:
// packages/nextblock/page/ghost-page.js, loaded by the page after this bundle, puts them on ARENACLIENT. §0A.2, kanban #525)
// THE PROTOCOL RESERVES: the reserve key a version-11 entry pays and its mandatory split - the page asks before a lock
walk(SRC + 'reserves-page.js');
// AND PROJECT PROPOSALS: bitcoin-arena.io reads, signs and posts proposals and comments with this bundle
walk(SRC + 'funding-page.js');
walk(SRC + 'donation-gift-page.js');
// WHEN THE NEXT ROUND STARTS (kanban #690): the market page's line under "No window is open"
walk(SRC + 'next-round-line.js');
walk(SRC + 'fee-proposal-page.js');
// THE OWNER'S EMERGENCY CODE (spec §23A.5a, protocol 17): the Arena site's "My node is offline" makes the key from the code and signs the leave request
walk(ROOT + 'arena-protocol/src/emergency.js');
walk(SRC + 'leaderboard-page.js');
// AND THE EXCHANGE VIEW OF A MARKET: the page draws a market client's order book, chart and depth with it
walk(SRC + 'exchange-view.js');
// AND THE BACKUP GATE AND THE PHRASE IT CHECKS (§24B). Nothing in the client imports them - the gate is
// what the PAGE asks before a deposit or a paid join, and the phrase is what it shows in Settings - so
// they are walked in here the same way `ghost-field.js` is.
walk(SRC + 'backup-gate.js');
walk(SRC + 'bip39.js');
// AND THE WAY IN. `join.js` is what a page does with its own URL before the
// client exists at all: nothing imports it, because a client that publishes a
// run must not depend on how the page was told which round to publish to.
walk(SRC + 'join.js');
// AND THE COMMITTEE THE CLIENT BUILDS ITSELF (spec 5A.6): what a paid join deals the stake to
walk(SRC + 'committee.js');
// AND WHAT IT BELIEVES ABOUT A FEDERATION: the guardians' signed record, checked against that census
walk(SRC + 'federations.js');
// AND THE BALANCE, FEDERATION BY FEDERATION (kanban #545): each one's health, a halted one's payback time, the debug view's capacity
walk(SRC + 'balance-view.js');
// AND THE WARNINGS BEFORE ENTRY (§18A.7 / §22A): what a paid join shows and the player confirms
walk(SRC + 'entry-warnings.js');
// AND A HALTED FEDERATION'S CLAIMS: the page presents its notes and collects what the arbitration set paid
walk(SRC + 'liquidation-claim.js');
// AND WHO WON A PRICE ROUND: the round's verdict, signed by the settlement committee
walk(SRC + 'round-verdict.js');
// AND THE RUN MADE SAFE BEFORE THE VICTORY SCREEN (§13A): two committee nodes hold the whole transcript
walk(SRC + 'transcript-upload.js');
// AND THE LOBBY (M3.3-34): what a page with no round in its link lists - the
// named nodes' rounds, each checked against its own contract.
walk(SRC + 'lobby.js');
// AND THE NEXT ROUND (2026-09-28, option 1 of A): after a run, the round the page enters by default, and the
// countdown and the exit it shows.
walk(SRC + 'next-round.js');
// AND WHO THE TAB IS IN IT: a generated key, a name from that key, and the
// player's own name over it (M3.3-34).
walk(SRC + 'identity.js');
// AND THE PLAYER'S DONATION (M3.2 6e): the choice, judged and kept per round.
walk(SRC + 'donation-choice.js');
// AND ITS SET (M3.2 6e): the round's donation set from its signer nodes, checked. The
// donation itself is paid by the player's own Client (payDonation).
walk(SRC + 'donation-pay.js');
// AND WHERE A WINNER'S WINNINGS ARE SENT (ruled 2026-09-23): the one question at the run's end, and the signed
// address posted to every signer node that has not taken it. Nothing in the client imports it; the page calls it.
walk(SRC + 'winnings.js');
// AND THE GAME'S ITEMS: the shop, the purchase paid from the player's wallet, what the player owns, and the items
// an entry plays with - the page calls them, nothing in the client imports them
walk(SRC + 'item-buy.js');
// COPY GAME REPLAY (2026-09-25 18:39): the link a player copies from the result screen.
walk(SRC + 'replay-link.js');
walk(SRC + 'market.js');   // a market in the page: the Arena's, for every attested market (kanban #568; it was in btc-updown/page)
// AND A HEAD-TO-HEAD ROUND'S HIDDEN MOVE AND ITS REVEAL
walk(SRC + 'head-to-head.js');
// AND THE GAMES: the games the lobby's nodes host, and a game's client loaded only by its manifest's hashes.
walk(SRC + 'games.js');
walk(SRC + 'node-discovery.js');
// AND A GAME'S SEASON BOARD (PLATFORM-RESEARCH item 1): the rows the page draws from a seat's GET /season, and
// the ask that falls through the game's seats. Nothing in the client imports it; the page's season view calls it.
walk(SRC + 'season-view.js');
// AND A PLAYER'S BADGES ON THAT BOARD (PLATFORM-RESEARCH items 13 + 1): the badge seats' awards merged by
// (d, scope), their icons and words, and the book that asks each player once per board. The page's season view calls it.
walk(SRC + 'badges-view.js');
// AND ZAPS AND TIPS (PLATFORM-RESEARCH item 14): a player zapped from the season board, a game's developer tipped
// from its tile - the player's own NWC wallet paying a Lightning address, each invoice checked first (NIP-57).
walk(SRC + 'zap.js');

// One scope, so a name declared twice would collide. EVERY top-level name is
// checked, not only the exported ones: two files with a private helper of the
// same name are the dangerous case, because nothing in either module says so.
// A duplicated `const` throws when the page loads, which is loud; a duplicated
// `function` or `var` silently keeps one of them and the survivor depends on
// file order, which is a different program from the modules with no symptom.
// Measured: `chain.js` and `transcript.js` each had a private `same`.
const declared = new Map();
for (const file of order) {
  for (const m of readFileSync(file, 'utf8')
    .matchAll(/^(?:export\s+)?(?:async\s+)?(?:const|function|class|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (declared.has(m[1]) && declared.get(m[1]) !== file) {
      console.error(`bundle: ${m[1]} is declared at the top level of both `
        + `${relative(ROOT, declared.get(m[1]))} and ${relative(ROOT, file)}`);
      process.exit(1);
    }
    declared.set(m[1], file);
  }
}

// AN IMPORT ALIAS IS STRIPPED WITH ITS IMPORT: `import { a as b }` leaves `b` undefined in the page unless some file of the bundle
// declares a top-level `b` (measured live,: `seriesId as seriesIdOf` - every node test green, the page threw
// "seriesIdOf is not defined"). Such an alias is refused here, by name.
for (const file of order) {
  for (const m of readFileSync(file, 'utf8').matchAll(/^import\s*\{([^}]*)\}\s*from/gm)) {
    for (const part of m[1].split(',')) {
      const a = part.trim().match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (a && !declared.has(a[2])) {
        console.error(`bundle: ${relative(ROOT, file)} imports ${a[1]} as ${a[2]}, and the bundle drops imports - nothing declares ${a[2]}`);
        process.exit(1);
      }
    }
  }
}

let out = '';
out += '// GENERATED by tools/bundle.js from arena-client. Do not edit.\n';
out += '// Verified against the module build by test/bundle.test.js.\n';
out += 'var ARENACLIENT = (function () {\n"use strict";\n';
for (const file of order) {
  const body = readFileSync(file, 'utf8')
    .replace(/^import\s[\s\S]*?;\s*$/gm, '')
    .replace(/^export\s+\*\s+from\s+[^;]*;\s*$/gm, '')
    // A LIST OF NAMES ON ONE LINE, and not a lazy match that crosses them.
    //
    // These two used to read `\{[\s\S]*?\}`, which spans lines: with an
    // `export { A, B };` early in a file and an `export { C } from './x.js';`
    // later, the match started at the first and ran to the second, DELETING
    // every declaration in between. Measured on `core/src/sim.js`: line 51's
    // `export { UNITS, ARMOUR_MASK };` and line 106's `export { TICK_DT } from
    // './tick.js';` swallowed 55 lines, including `export const HALF_X` - and
    // the bundle still carried nine USES of it, so the page threw
    // "HALF_X is not defined" on the first step. The committed bundle predated
    // that re-export, which is the only reason anybody had a working one.
    .replace(/^export\s*\{[^{}]*\}\s*from\s+[^;]*;\s*$/gm, '')
    .replace(/^export\s*\{[^{}]*\}\s*;\s*$/gm, '')
    .replace(/^export\s+(async\s+)?(const|function|class|let|var)\s/gm, '$1$2 ');
  out += '\n// ---- ' + relative(ROOT, file) + '\n' + body;
}
out += '\nreturn { Client: Client, markState: markState, catchUpCore: catchUpCore,\n';
out += '         reach: reach, endpointFor: endpointFor, roundCoreHex: roundCoreHex,\n';
out += '         discover: discover, agreedChain: agreedChain,\n';
out += '         askForBond: askForBond, provenBond: provenBond,\n';
out += '         headersOverHttp: headersOverHttp, httpProvider: httpProvider,\n';
out += '         GENESIS: GENESIS, NO_PREVIOUS: NO_PREVIOUS,\n';
out += '         encodeRoundContract: encodeRoundContract, roundId: roundId,\n';
out += '         encodeEntryContract: encodeEntryContract, entryId: entryId,\n';
// (watchGhosts, GHOST_BACKLOG, tickClock, ghostLabels, ghostLabelText, moveGlyphs, playersLine, newestPose, stakeLine: Tick Tock's ghosts,
// put on ARENACLIENT by its own page script, packages/nextblock/page/ghost-page.js - §0A.2, kanban #525)
out += '         parseEmergencyCode: parseEmergencyCode, emergencySecret: emergencySecret, signEmergencyDeparture: signEmergencyDeparture,\n';
out += '         encodeEmergencyDeparture: encodeEmergencyDeparture, EMERGENCY_FRESH_BLOCKS: EMERGENCY_FRESH_BLOCKS,\n';
// THE COMMITTEE'S PRICE (§11): the page turns a signed price in cents into the tape's unit for its core
out += '         centsToTapeUnits: centsToTapeUnits,\n';
out += '         federationHealth: federationHealth, humanDuration: humanDuration, medianBlockSeconds: medianBlockSeconds, reimbursementOf: reimbursementOf,\n';
out += '         capacityOf: capacityOf, explorerBaseFor: explorerBaseFor,\n';
out += '         joinQuery: joinQuery, joinFromQuery: joinFromQuery,\n';
out += '         verifyPhrase: verifyPhrase, verifyAndRecord: verifyAndRecord,\n';
out += '         isVerified: isVerified, backupLine: backupLine, NO_BACKUP_LINE: NO_BACKUP_LINE,\n';
out += '         phraseFromSeed: phraseFromSeed, seedFromPhrase: seedFromPhrase, seedHexFromInput: seedHexFromInput, PHRASE_WORDS: PHRASE_WORDS,\n';
out += '         fetchRound: fetchRound, bondProvider: bondProvider,\n';
// THE SEED THE COMMITTEE WILL REPLAY THIS PLAYER WITH. Without it the page
// cannot put its own core in the world its transcript is judged in, which is
// exactly what it could not do before letter 36.
out += '         fetchRandomness: fetchRandomness, worldSeedFor: worldSeedFor,\n';
out += '         seedWordForEntry: seedWordForEntry, worldSeedWord: worldSeedWord, worldIsShared: worldIsShared, sharedWorldOf: sharedWorldOf,\n';
out += '         worldSlot: worldSlot, keyOnFreeSlot: keyOnFreeSlot,\n';
out += '         tabSeed: tabSeed, importSeed: importSeed, restoreSeed: restoreSeed, seedOrigin: seedOrigin,\n'; out += '         playerFor: playerFor, entryFor: entryFor,\n';
out += '         chooseDonation: chooseDonation, donationChoice: donationChoice, DONATION_CONFIRM_BPS: DONATION_CONFIRM_BPS,\n';
out += '         DONATION_DEFAULT_BPS: DONATION_DEFAULT_BPS, DONATION_CHOICES_BPS: DONATION_CHOICES_BPS,\n';
out += '         keptDonation: keptDonation, depositDonationMsat: depositDonationMsat,\n';
out += '         fetchDonationSet: fetchDonationSet, donationRecipientsLine: donationRecipientsLine,\n';
// EACH DONATION SHARE, PAID / UNPAID / OUTCOME UNKNOWN - the state off
// `payDonation`'s answer and the line the page paints from it.
out += '         donationPaidState: donationPaidState, donationPaidLine: donationPaidLine,\n';
// AND THE SAME LINE FROM THE TAB'S NOTES ALONE, for a round link that cannot be
// reached - no signer node, no set, nothing asked of a wallet.
out += '         donationNotedState: donationNotedState, notedDonationForLink: notedDonationForLink,\n';
// WHERE THE STAKE WENT, AFTER SETTLEMENT: the signer nodes' hold state, the hold's
// amount and the round's pool, asked of every settlement signer node, and its line.
out += '         settlementBy: settlementBy,\n';
// THE STAKE THE PAGE DEALS, and the signer nodes it is dealt to. `stakeFor` was in
// this bundle already and had ZERO CALLERS - the page joined with 32
// random bytes where `sha256(P)` belongs and 32 zero bytes where the shares
// belong. `fetchSettlementSignerNodes` is what stops it being dealt to the wrong
// committee: `contract.nodes` is the UNION of the role committees, and shares
// sealed to a game-verify signer node are a stake nobody can open at payout.
out += '         stakeFor: stakeFor, fetchSettlementSignerNodes: fetchSettlementSignerNodes,\n';
out += '         roundPays: roundPays, postHandout: postHandout, attestedClaimKey: attestedClaimKey, roundLocks: roundLocks,\n';
out += '         awaitAttestedClaimKey: awaitAttestedClaimKey,\n';
// THE THRESHOLD THE STAKE IS DEALT AT - the round's (2 of 2, 5 of 7), the
// same rule the node's door and settle read, never the slot count (M3.3-26).
out += '         sharesNeededFor: sharesNeededFor,\n';
// THE PLAYER'S STAKE LOCK (W1b): what the injected lock client is asked, and the
// hand-over of the lock it made to every signer node.
out += '         lockStake: lockStake, handLock: handLock, lockSecretFor: lockSecretFor, lockLine: lockLine,\n';
out += '         fetchReserveKey: fetchReserveKey, fetchReservesTotal: fetchReservesTotal, fetchReservesPaymentsOut: fetchReservesPaymentsOut, paymentOutLine: paymentOutLine, fetchProposals: fetchProposals, fetchNetworkId: fetchNetworkId, signedProposal: signedProposal, signedComment: signedComment, signedName: signedName, forumIdentity: forumIdentity, forumNameOf: forumNameOf, giftDonation: giftDonation, signedLeaderboardPayout: signedLeaderboardPayout, splitFromPercents: splitFromPercents, fetchLeaderboards: fetchLeaderboards, heightAtDate: heightAtDate, LB_SCOPE: LB_SCOPE, LB_PERIOD_DAYS: LB_PERIOD_DAYS, LB_TOP_MAX: LB_TOP_MAX, fetchFees: fetchFees, feeChangesFrom: feeChangesFrom, signedFeeProposal: signedFeeProposal, earliestActivation: earliestActivation, roundFeesLine: roundFeesLine, marketFeesLine: marketFeesLine, marketFeeBpsOf: marketFeeBpsOf, FEE_UNITS: FEE_UNITS, FEES: FEES, FEES_TODAY: FEES_TODAY, feeProposalStands: feeProposalStands, zapPlayer: zapPlayer, collectZaps: collectZaps, referralOf: referralOf, referralNameFor: referralNameFor, myOrdersFromEntries: myOrdersFromEntries, mountExchange: mountExchange, exchangeLadder: exchangeLadder, exchangeHistory: exchangeHistory, exchangeVolume: exchangeVolume, giftAmountOf: giftAmountOf, giftRecipientsLine: giftRecipientsLine, GIFT_CHOICES_SAT: GIFT_CHOICES_SAT, postFunding: postFunding, newProposalKey: newProposalKey, keyOfNsec: keyOfNsec, npubOf: npubOf, npubOfKey: npubOfKey, reservesDonation: reservesDonation, reservesDonationForRound: reservesDonationForRound, roundPaysReserves: roundPaysReserves,\n';
// AND THE PLAYER WALLET (§24A.1, RULED 2026-09-25): one per seed and federation; the top-up is its own act, before the
// stake, and the stake is spent from it.
out += '         playerWallet: playerWallet, openPlayerWallet: openPlayerWallet, useSeatedGateways: useSeatedGateways, seatedGatewaysOf: seatedGatewaysOf, walletDepositOffer: walletDepositOffer, walletDepositChoices: walletDepositChoices, fundPlayerWallet: fundPlayerWallet, earlyDepositOffer: earlyDepositOffer, joinFundingPlan: joinFundingPlan, notSpendableYet: notSpendableYet, walletSecretFor: walletSecretFor, markSeedRecover: markSeedRecover, tidyStorage: tidyStorage, seedRecovers: seedRecovers,\n';
out += '         withdrawPlayerWallet: withdrawPlayerWallet,\n';
out += '         onStorageRefused: onStorageRefused, packWallets: packWallets, scanLostDeposits: scanLostDeposits, saveLock: saveLock, savedLock: savedLock, markLockCommitted: markLockCommitted, keptLockUse: keptLockUse,\n';
// AND THE ROUND'S CLOSE, which ends a reloaded tab's resume (keptLockUse beforeClose)
out += '         roundEndMs: roundEndMs,\n';
out += '         ledgerRows: ledgerRows, ledgerReadSavedStakes: ledgerReadSavedStakes, ledgerHistory: ledgerHistory,\n';
out += '         depositChoices: depositChoices, withdrawChoices: withdrawChoices, invoiceAmountMsat: invoiceAmountMsat, playerWithdrawable: playerWithdrawable, pendingDeposits: pendingDeposits, resumeDeposits: resumeDeposits, restOfFeesMsat: restOfFeesMsat, restInvoiceMsat: restInvoiceMsat, REST_FLOOR_MSAT: REST_FLOOR_MSAT, ceilNote: ceilNote, roundsDepositMsat: roundsDepositMsat, recordDonation: recordDonation, recordReceived: recordReceived, collectIntoPlayerWallet: collectIntoPlayerWallet, donationCostMsat: donationCostMsat, depositOffer: depositOffer, settingsDepositOffer: settingsDepositOffer, issuingMsat: issuingMsat, awaitIssued: awaitIssued, DEPOSIT_INSUFFICIENT: DEPOSIT_INSUFFICIENT,\n';
out += '         findLock: findLock, refundStake: refundStake, forfeitOf: forfeitOf, redeemStake: redeemStake,\n';
// AND THE WINNER'S PAYOUT (6d, W4): the signer nodes' accepted settlement, the payout
// contract to this seed's key spent into the tab's wallet, and its line.
out += '         settlementOf: settlementOf, redeemPayout: redeemPayout, payoutLine: payoutLine,\n';
// A SLASH'S PAYOUT: listed by the arbitration service, collected into the player wallet
out += '         redeemSlashPayout: redeemSlashPayout, collectSlashPayout: collectSlashPayout, slashPayoutMine: slashPayoutMine, slashPayoutKept: slashPayoutKept,\n';
// AND THE PLAYER'S OWN STAKE BACK BY THE SIGNER NODES' FORFEIT, after the window, and its line.
out += '         returnStake: returnStake, stakeBackLine: stakeBackLine,\n';
// AND WHAT THE TAB STILL HAS TO COLLECT, kept per round, so a reload collects too.
out += '         saveCollect: saveCollect, savedCollects: savedCollects, markCollectDone: markCollectDone,\n';
out += '         browserSeedHexes: browserSeedHexes, recordsToCollect: recordsToCollect, collectLines: collectLines,\n';
// AND 6d's DESTINATION: the tab's round wallet withdrawn over Lightning to the player's own.
out += '         tabLockWallet: tabLockWallet, withdrawCollected: withdrawCollected, withdrawLine: withdrawLine, makeInvoice: makeInvoice,\n';
out += '         invoiceQrSvg: invoiceQrSvg,\n';
// AND THE LOCK QUOTES ASKED AHEAD, while the lobby shows a paid round (the join's 2-3 s).
out += '         warmLockQuotes: warmLockQuotes,\n';
// AND A LOCK NO SIGNER NODE WILL SETTLE, BACK BY THE PLAYER'S KEY AFTER ITS EXPIRY, from the tab's record.
out += '         refundKept: refundKept, refundLine: refundLine,\n';
// AND NOTHING SPENT BEFORE THE PLAYER WITHDRAWS: the look that spends nothing, and the collect
// that happens only inside a withdraw, in one action. (join's owedLine is the hold panel's.)
out += '         lookOwed: lookOwed, owedToLine: owedToLine, collectOwed: collectOwed, collectAndWithdraw: collectAndWithdraw, findOwedRounds: findOwedRounds,\n';
// THE LOBBY (M3.3-34): a link that names nodes and no round lists what they
// hold, every row checked against its own contract; Join is the join link.
out += '         lobbyQuery: lobbyQuery, fetchLobby: fetchLobby, lobbyLine: lobbyLine, lobbyJoinSearch: lobbyJoinSearch,\n';
out += '         fetchGames: fetchGames, oneTilePerGame: oneTilePerGame, checkedGameInfoOfTile: checkedGameInfoOfTile, checkedGameInfo: checkedGameInfo, rowsOfGame: rowsOfGame, gameClientFile: gameClientFile,\n';
out += '         censusEndpoints: censusEndpoints, mergeNodes: mergeNodes,\n';
out += '         SIGNER_ANSWER_MS: SIGNER_ANSWER_MS,\n';
// AND ONE FREE ROUND AND ONE PAYING ROUND LISTED, NEVER TWO OF EITHER, with the paying one's stake.
out += '         lobbyOnePerKind: lobbyOnePerKind, phraseWalletEntries: phraseWalletEntries, forgetPhrase: forgetPhrase, clientCommittee: clientCommittee, roundAttestors: roundAttestors, clientSettlementSignerNodes: clientSettlementSignerNodes, checkedCensusFor: checkedCensusFor, tooOldFor: tooOldFor, newestCheckedCensus: newestCheckedCensus, federationStatus: federationStatus, approvalFacts: approvalFacts, approvalWords: approvalWords, depositFederation: depositFederation, withdrawFederation: withdrawFederation, safeFederation: safeFederation, custodySummary: custodySummary, custodySays: custodySays, entryWarnings: entryWarnings, warningsSay: warningsSay, federationStatuses: federationStatuses, moveSays: moveSays, migrateFromDraining: migrateFromDraining, migratePlayerWallet: migratePlayerWallet, evacuatePlayerWallet: evacuatePlayerWallet, movePlayerWallet: movePlayerWallet, moveCanMsat: moveCanMsat, swapQuote: swapQuote, swapForRound: swapForRound, swapPlayerWalletForRound: swapPlayerWalletForRound, ledgerFederations: ledgerFederations, rememberedInvite: rememberedInvite, federationSays: federationSays, loadSays: loadSays, loadRefusesDeposit: loadRefusesDeposit, pickFederation: pickFederation, moveOffer: moveOffer, FEDERATION_ALLOWS: FEDERATION_ALLOWS, federationIsKnown: federationIsKnown, knownFederation: knownFederation, guardianRowsOf: guardianRowsOf, federationConfirmed: federationConfirmed, confirmFederation: confirmFederation, forgetFederation: forgetFederation, confirmedFederations: confirmedFederations, inviteNamesFederation: inviteNamesFederation, lobbyKeepJoined: lobbyKeepJoined, lobbyRowsAt: lobbyRowsAt, lobbyKeepWhenUnanswered: lobbyKeepWhenUnanswered, lobbyRowOffered: lobbyRowOffered, lobbyRowNotOffered: lobbyRowNotOffered, unplayableWindowLine: unplayableWindowLine, fetchKeylessFederations: fetchKeylessFederations, keylessFundsLine: keylessFundsLine, gatewayUrlsOfView: gatewayUrlsOfView, settledWords: settledWords, onStorageFull: onStorageFull, inactiveFederations: inactiveFederations, nextRoundLine: nextRoundLine, inHoursMinutes: inHoursMinutes, lobbyStakeSats: lobbyStakeSats, SERIES_JOIN_LEAD_MS: SERIES_JOIN_LEAD_MS, FUNDED_JOIN_LEAD_MS: FUNDED_JOIN_LEAD_MS, JOIN_LEAD_MS: JOIN_LEAD_MS,\n';
out += '         isLateJoinRound: isLateJoinRound, lateJoinTick: lateJoinTick, runTicksForEntry: runTicksForEntry, entryOpenUntilMs: entryOpenUntilMs, lateJoinLastEntryMs: lateJoinLastEntryMs, LATE_JOIN_JOIN_MS: LATE_JOIN_JOIN_MS,\n';
out += '         presentNotes: presentNotes, liquidationKeyFor: liquidationKeyFor, collectLiquidationPayouts: collectLiquidationPayouts, roundVerdict: roundVerdict, secureTranscript: secureTranscript,\n';
out += '         nextRoundAfter: nextRoundAfter, nextRoundView: nextRoundView, joiningNextRoundIn: joiningNextRoundIn,\n';
out += '         EXIT_GAME: EXIT_GAME, RESULT_CARD_MS: RESULT_CARD_MS,\n';
// AND THE DAILY'S OWN LOBBY AT THE BARE ROOT, from daily.json beside the page.
out += '         dailyLobbySearch: dailyLobbySearch,\n';
// WHO THE TAB IS IN THE LOBBY (M3.3-34): the generated key's public half, the
// name made from it, and the player's own name over it.
out += '         tabIdentity: tabIdentity, setPlayerName: setPlayerName, generatedName: generatedName, identityProofFor: identityProofFor, presenceProofFor: presenceProofFor, orderCancelId: orderCancelId, orderSellId: orderSellId, ORDER_PRICE_SCALE: ORDER_PRICE_SCALE,\n';
// AND THE OTHERS' NAMES (M3.3-34): this tab's signed record for its signer nodes, and
// the round's records fetched and checked before a name is drawn.
out += '         nameRecordFor: nameRecordFor, postName: postName, namesOf: namesOf, checkedNames: checkedNames, shownNameOf: shownNameOf,\n';
out += '         boardNames: boardNames,\n';
// THE WALLET THE PAGE RENDERS. `tabWallet` holds the connection per tab,
// `spendLog` is what §24A.1 requires a client to show, and `spentLine` turns it
// into one sentence - so the page renders a total it did not add up.
out += '         tabWallet: tabWallet, spendLog: spendLog, spentLine: spentLine,\n';
// A STAKE THAT CAME BACK (its hold CANCELLED or EXPIRED) is written into the log as
// returned, so the running total counts only what left the wallet and stayed gone.
// WHAT THE ENTRY COSTS, AS 22A's TRANSPARENCY LIST: the commitment, the fee and
// the donation out of it, the net stake, and what the wallet is asked. The
// page renders it; the subtraction is `netStakeMsat`'s.
out += '         parseConnection: parseConnection,\n';
// WHAT THE WALLET WILL STILL LET THIS CONNECTION SPEND. Asked for, never read
// off the connection string - NIP-47's URI carries no budget, and the field
// that pretended it did is gone.
out += '         walletBudget: walletBudget, budgetLine: budgetLine,\n';
out += '         decodeRoundContract: decodeRoundContract, decodeEntryContract: decodeEntryContract,\n';
// COPY GAME REPLAY: the link, and the endpoint as the https origin it names.
out += '         replayLinkFor: replayLinkFor, httpsOfEndpoint: httpsOfEndpoint,\n';
// WHERE A WINNER'S WINNINGS ARE SENT (ruled 2026-09-23): the run-over hook's one question, the resend at every load,
// and the address check the bridge's signing call makes before it signs anything.
out += '         askForWinnings: askForWinnings, resendWinnings: resendWinnings, winningsAddressOf: winningsAddressOf,\n';
out += '         winningsQualify: winningsQualify,\n';
// A MARKET (§0A.7a): the pick sheet's model, the pick handed to the seats, the outcome checked, the lines
out += '         marketForRound: marketForRound, pickSheet: pickSheet, submitPick: submitPick, checkAttestation: checkAttestation,\n';
out += '         marketLines: marketLines, quietOrders: quietOrders, webCryptoEd25519: webCryptoEd25519, pickRecord: pickRecord,\n';
// A SCALAR MARKET'S VALUE AND A MARKET ON A GAME'S SOURCE RESULT, CHECKED BY THE PAGE (protocols 7 and 6)
out += '         checkMarketOutcome: checkMarketOutcome, scalarValueLine: scalarValueLine, fetchSeriesTemplate: fetchSeriesTemplate, seriesRoundCheck: seriesRoundCheck, roundOfPick: roundOfPick,\n';
// A HEAD-TO-HEAD ROUND: the hidden move, its commitment, its reveal, and the reveals the seats hold
out += '         hiddenMove: hiddenMove, moveCommitment: moveCommitment, revealMove: revealMove, revealsOfRound: revealsOfRound,\n';
// THE SEASON BOARD: its lines from a /season answer, and the ask of the game's seats in turn
out += '         seasonView: seasonView, fetchSeason: fetchSeason, seasonPath: seasonPath, seasonSats: seasonSats, seasonScore: seasonScore,\n';
out += '         SEASON_DAYS_CHOICES: SEASON_DAYS_CHOICES, SEASON_POLL_MS: SEASON_POLL_MS,\n';
// A PLAYER'S BADGES ON THE BOARD: the merge of the badge seats' awards, their words, and the board's book
out += '         badgeBook: badgeBook, mergeBadgeAwards: mergeBadgeAwards, readBadgeDefinition: readBadgeDefinition, badgeTitle: badgeTitle,\n';
out += '         yourBadgesLine: yourBadgesLine, badgeGlyph: badgeGlyph, badgeImagePath: badgeImagePath, badgesPath: badgesPath,\n';
// ZAPS AND TIPS: a zap or a tip from the player's own wallet, the player's address and the zaps they received
out += '         sendZap: sendZap, zapTarget: zapTarget, zapsReceived: zapsReceived, playerLightningAddress: playerLightningAddress,\n';
out += '         zapProfileEvent: zapProfileEvent, zapSatLine: zapSatLine, ZAP_CHOICES_SAT: ZAP_CHOICES_SAT, identitySignEvent: identitySignEvent,\n';
// THE GAME'S ITEMS: the shop, the purchase, what the player owns, the items an entry plays with and their unlocks
out += '         shopOf: shopOf, buyItem: buyItem, itemTermsOf: itemTermsOf, itemShareOn: itemShareOn, itemPriceOn: itemPriceOn, itemPriceFor: itemPriceFor, ITEM_DEV_SHARES: ITEM_DEV_SHARES, ITEM_DEV_SHARE_DEFAULT: ITEM_DEV_SHARE_DEFAULT, ownedItems: ownedItems, itemsKeyFor: itemsKeyFor, entryItemsFor: entryItemsFor,\n';
out += '         entryUnlocks: entryUnlocks, itemUnlocksOf: itemUnlocksOf,\n';
// WHAT AN ENTRY'S STAKE IS MADE OF: the deposit request says it
out += '         entryBreakdown: entryBreakdown, pendingWindowLine: pendingWindowLine, savedLockExpiration: savedLockExpiration,\n';
out += '         toHex: toHex, fromHex: fromHex };\n})();\n';
out += 'if (typeof module !== "undefined") module.exports = ARENACLIENT;\n';

mkdirSync(OUT, { recursive: true });
writeFileSync(OUT + 'arena-client.js', out);
// The package is "type": "module", so Node would read this as ESM and an ESM
// file with no export statements has an empty namespace - exactly the empty
// object require() would otherwise hand back.
writeFileSync(OUT + 'package.json', JSON.stringify({ type: 'commonjs' }, null, 1) + '\n');
console.log(`dist/arena-client.js  ${(out.length / 1024).toFixed(1)} KB  from ${order.length} modules`);
