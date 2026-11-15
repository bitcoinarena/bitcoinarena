# E2E report (kanban #2642)

commit a79895475 · 7 runs merged (2026-11-14T09:57:20.378Z .. 2026-11-14T18:43:42.253Z) · **55 pass, 0 fail, 2 not covered**

Private regtest devnet on the MacBook (devnet.mjs: 5-of-7 federation, seven seats, two gateways on two lnds, a payee lnd); the page built from
this tree (tools/build-arena-page.mjs) served by e2e/lib/page.mjs and driven in headless Chrome. Order: money first, then reach.

| flow | area | result | s | evidence / why |
|---|---|---|---|---|
| deposit.lightning | deposit | pass | 23.3 | {"before":"0 sat","after":"10,000 sat","paid":{"from":"a","dest":"03cb44c7ec15d117","status":"SUCCEEDED"},"secondsToShow":3,"gateway":null} |
| faucet.page-welcome | faucet | pass | 63.7 | {"ask":{"invoiceAsk":{"at":1794652575652,"kind":"welcome","invoice":"lnbcrt30u1p40swv… -> lntb"},"posts":2},"credited":"3000 sats have been credited","bookRow":{"sats":3000,"hash":"ead83b5b5700a541…"},"payment":"SUCCEEDED","balanceText":"3000 sats","console":[]} |
| faucet.player-grant | faucet | pass | 2 | {"account":"9490eb762613…","welcomeMs":747,"welcomeSettled":true,"topupSettled":true,"refused":{"regtestInvoice":"that is not a testnet invoice","secondWelcome":"this account already has its welcome sats","reusedInvoice":"that invoice was already used: make a new one","wrongAmount":"this grant pays  |
| faucet.service-up | faucet | pass | 0.6 | {"run":"/Users/user/wf1489/e2e-2642/faucet/run-2026-11-14T10-26-18-937Z","ports":{"front":13015,"faucet":13016,"chat":13017,"rpc":13018},"balanceSats":299899718,"maxSats":1500000,"leftTodaySats":30000000,"pid":945,"standIns":["RPC proxy tb1<->bcrt1","lncli-regtest (--network=regtest, lntb->lnbcrt) |
| lightning.gateways-live | lightning | pass | 0.2 | {"gatewayAEcashMsat":49940336640,"lndBChannels":1} |
| round.paid.headless-entry | rounds | pass | 1148.1 | {"exit":0,"deposit":{"msat":"10700000","final":"Claimed"},"locked":"9500000","handedOver":["201/201","201/201","201/201","201/201","201/201","201/201","201/201"],"last":[{"step":"settled"},{"step":"collected"},{"step":"lightning payout"}]} |
| round.paid.open | rounds | pass | 8.4 | {"round":"78f9e8509169fc44","stakeMsat":"10000000","firstAskRefused":null,"listedAt":7,"phase":"open","entryClose":"2026-11-14T14:30:26.000Z"} |
| wallet.create-and-verify | wallet | pass | 9.3 | {"asked":[4,11,18],"words":24,"warningGone":true} |
| wallet.reload-keeps-balance | wallet | pass | 19.1 | {"funded":10000,"shown":10000} |
| withdraw.lightning | withdraw | pass | 22.7 | {"before":10000,"after":8000,"paidSat":2000,"seconds":2} |
| faucet.coins | faucet | pass | 0.9 | {"address":"tb1qknscuw3kfw53gu3t86tvsz69wa9kaz2e89xlgn","txid":"078d336b9d39097c733bbc4d5e42a4833d843825124f1db93c49cf04cd77a657","received":0.001,"refused":{"sameAddress":"this address got coins from the faucet already","regtest":"that is not a testnet4 address (it starts with tb1)","tooMuch":"the  |
| wallet.restore-from-words | wallet | pass | 24.2 | {"funded":10000,"restored":8000,"seconds":18} |
| bounty.lnurlw-claim | bounty | pass | 3.4 | {"paidMs":3011,"settled":"SETTLED","refused":{"k1":"k1 does not match the link","small":"the invoice must be for exactly 1000 sat","big":"the invoice must be for exactly 1000 sat","otherNetwork":"that invoice could not be read","twice":"this reward was claimed"},"myFeedback":"Feedback #001 · 2026-11 |
| bounty.season2 | bounty | pass | 0.5 | {"pot":100000,"linkCode":"BA-…","social":{"telegram":{"member":null,"why":"this check is not on yet"},"discord":{"member":null,"why":"this check is not on yet"},"x":{"member":null,"why":"this check is not on yet"},"armada":{"member":null,"why":"this check is not on yet"}},"approvals":{"medium":2000, |
| seats.owner-door-locked | owner | pass | 0 | {"posts":{"/owner/roles":409,"/owner/leave":409,"/owner/bond-withdraw":409,"/owner/settings":409,"/owner/plugins/install":409,"/owner/network/update":409,"/owner/key-from-words":409},"reads":{"/owner":200,"/owner/standing":200,"/owner/rounds":200,"/owner/version":200}} |
| lightning.payee-routes | lightning | pass | 0.1 | {"opened":[],"routes":[true,true]} |
| leaderboard.page | leaderboard | pass | 6.3 | {"text":"✕ Close / LEADERBOARD / Tick Tock, Next Block / 7 days / 30 days / 90 days / Asking the nodes …","asked":["/api/season?game=nextblock&days=7 -","/season?game=nextblock&days=7&scope=network 200","/season?game=nextblock&days=7&scope=network 200","/season?game=nextblock&days=7&scope=network 20 |
| season.board-and-badges | leaderboard | pass | 0.1 | {"seasonKeys":["node","game","days","from","to","fromMs","toMs","rows"],"networkKeys":["node","game","days","from","to","fromMs","toMs","rows"],"seasonRounds":8,"badgeDefinitions":4,"badgesOn":false} |
| feedback.fakes | feedback | pass | 0.1 | {"replay":{"label":"Feedback #002","keptOnce":true,"chatPostsOnce":true},"refused":{"a forged signature":"invalid: the signature is not its author's","content changed after signing":"invalid: the id is not the event's hash","another key's report under K's pubkey":"invalid: the id is not the event's  |
| markets.reads | markets | pass | 0 | {"marketRounds":0,"priceSamples":400,"note":"no market round is opened on the devnet: the devnet hosts no market game (btc-updown is not in DEVNET_APPS)"} |
| nostr.login-nsec | wallet | pass | 32.7 | {"npub":"npub1v7u7ancjnaj05u9","shown":"0 sat","afterReload":"0 sat","storage":"[\"arena.nostr\",\"arena.seeds\",\"arena.seed.held.3391ef5d2dc6ad2b\",\"arena.seed.held.ebe880566289e795\"]"} |
| bounty.admin-review | bounty | pass | 0 | {"duplicate":"a duplicate report is not approved for money: the first report of it is","rejected":"a rejected report is not approved for money","approved":"Feedback #001","amountSats":1000,"k1":"5de931844bdb…","lnurl":"lnurl1dp68gup69uhnzv…"} |
| proposals.ballot-reads | proposals | pass | 0 | {"configHash":"2170f25079f5652b","proposals":0,"fundingProposals":0} |
| referrals.name-and-fees | referrals | pass | 0 | {"totalMsat":"0","unsignedNamePost":400,"why":"that is not a referral name: reader ran off the end\n"} |
| seats.operator-door-locked | owner | pass | 0 | {"codes":[401,401,401]} |
| feedback.page-signed | feedback | pass | 3.8 | {"label":"Feedback #001","id":"9782a9f6c3879c00…","pubkey":"88e25b8d6e44ac23…","chatPosts":1,"myFeedback":"Feedback #001 · 2026-11-14 · bug · waiting for the team E2E #2642 page-mwg8sinl: the order strip froze after I pressed Play and the balance stayed the same for ","viaMenu":false,"debugChars":75 |
| installer.auto-update | installer | pass | 17.8 | {"wrongDownload":"arena-node-2026.1.9.27-darwin-arm64.tar.gz downloaded with SHA-256 f5904816672067e0..., not the 6df86497277527e7... the signed latest.json names: not used","moved":{"ok":true,"from":"2026.1.9.26","to":"2026.1.9.27"},"seconds":17,"after":{"identity":"034ecfb1652b613ad53ab17732ad60c4 |
| installer.rollback-failed-release | installer | pass | 47.1 | {"to":"2026.1.9.28","seconds":47,"ok":false,"rolledBack":true,"restored":true,"failedAt":"Waiting for your node's first answer","why":"the new release did not come up: the node did not answer on port 18340 within 45 s (ECONNREFUSED). Its last log lines: [games] hosting none (ARENA_APPS names no game |
| installer.seed-words | installer | pass | 3.5 | {"asked":[2,6,15],"refused":"words 2, 6, 15 are not what was shown - check what you wrote down","seedHexMode":"600","owner":{"mode":"seed","pubkey":"62e5221f2991ae99d35b3efca2627407863717cb01bbc4f1a8562fd0303377bd"},"step":"emergency","shots":["07-seed-words.png","08-seed-asked-back.png"]} |
| installer.update | installer | pass | 8.3 | {"from":"2026.1.9.26","to":"2026.1.9.27","seconds":4,"ok":true,"backup":"/Users/user/wf1489/e2e-2642/installer-2026-11-14T10-02-40-520Z/update/home/.bitcoinarena/backups/2026-11-14T10-02-45-493Z","moved":["arena-node.service"],"answered":{"version":"2026.1.9.27","commit":"ab85a72fcfcb6c8329d0b371e |
| page.boot | page | pass | 5 | {"rows":[{"id":"38b0a4187875","free":true,"phase":"open","join":true}],"unity":true,"rewrites":["ARENA_FAUCET_URL -> /api/faucet/player on 127.0.0.1","arena-client.js chainAnchorFor -> the devnet genesis"],"requests":133,"blockedExternal":27} |
| round.free.headless-play | rounds | pass | 223.7 | {"round":"01ba807f56f18d2c","entry":"d5dbe3535b40faae","outcome":"FAILED","score":1605404,"agreeing":"7/7"} |
| round.free.page-join | rounds | not covered | 133.4 | the page cannot prove a seat on a private chain: "[arena] warm: the session reads were not done ahead (no proven endpoint: no bond: no provider proved that bond into the chain (provider 0: the transaction 4bcfeee33b506c189e680814adf55d653629c6b06ff684270a37e7c6cf233404 " - the client anchors to comp |
| seats.games-and-network | node | pass | 0 | {"games":["nextblock"],"iconBytes":0,"network":"bitcoin-regtest","configHash":"2170f25079f5652b","fees":{"roundNodeBps":400,"roundDonationBps":400,"roundReserveBps":200,"itemNodesPct":40,"itemReservesPct":20,"itemDevsPct":40,"marketNodeBps":40,"marketDonationBps":40,"marketReserveBps":20,"websitePct |
| seats.identity-and-roles | node | pass | 0 | {"guardians":7,"census":[1428],"roles":["game","settlement","verify"]} |
| explorer.round-reads | explorer | pass | 0 | {"reads":["/round 739B","/api/round-result 444B","/round-result 79B","/results 1624B","/transcript 99607B","/census 11540B","/committee 224B","/headers 116960B","/outcome 77B","/replay 23223B"],"listed":2} |
| feedback.page-unsigned | feedback | pass | 3.3 | {"said":"Thank you, it reached the team.","myFeedback":"Open a wallet first: your reports are listed under your key."} |
| installer.chain-devnet | installer | pass | 3.1 | {"tested":"Failed: block 0 is 0f9188f13cb7b2c7... (chain \"regtest\"): not testnet4","step":"chain","devnet":"http://127.0.0.1:13001","shots":["03-bitcoin-tested.png","04-bitcoin-save-refused.png"]} |
| installer.downgrade-guard | installer | pass | 2 | {"refused":"release 2026.1.9.26 is older than the release this node runs (2026.1.9.27): not moved back (--allow-older to mean it)","moved":{"ok":true,"from":"/Users/user/wf1489/e2e-2642/installer-2026-11-14T10-02-40-520Z/update/home/.bitcoinarena/releases/arena-node-2026.1.9.27-darwin-arm64","to": |
| installer.emergency-owner-handoff | installer | pass | 2.6 | {"codeLength":38,"step":"reach","handoff":"seed","withoutSession":401,"done":["start","chain","roles","federation","promise","lightning","apps","seed","owner","emergency"],"shots":["09-emergency.png","10-reach.png"]} |
| installer.reach-service | installer | not covered | 0.1 | not drivable on this machine: the reach step's direct check asks the live testnet4 seats (reach.js REACH_SEATS, hard-coded, no setting) to connect back, and "Install and start" writes launchd agents into the user's real gui domain (service.js installService) where a live node runs - neither has a re |
| installer.resume-after-restart | installer | pass | 2.6 | {"restartedPid":75840,"step":"roles","sessionKept":true,"chainWritten":{"kind":"core","url":"http://127.0.0.1:13001","height":544},"shots":["05-roles-after-restart.png"]} |
| installer.roles-apps | installer | pass | 2.9 | {"roleTiles":["role-verify","role-settlement","role-custody","role-liquidity"],"roles":["verify","settlement"],"apps":["nextblock","btc-updown","rock-paper-scissors"],"step":"seed","shots":["06-apps.png"]} |
| installer.start-new-seed | installer | pass | 2.6 | {"origin":"new","control":"words","step":"chain","shots":["02-bitcoin.png"]} |
| installer.update-cli-signature | installer | pass | 2.7 | {"asset":"arena-node-2026.1.9.27-darwin-arm64.tar.gz","forgedSums":{"status":2,"out":"[----------]   0 %  Checking the signature / [----------]   0 %  Failed at \"Checking the signature\": SHA256SUMS is not signed by the Arena release key / Refused: SHA256SUMS is not signed by the Arena release key" |
| installer.wizard-opens | installer | pass | 2.4 | {"home":"/Users/user/wf1489/e2e-2642/installer-2026-11-14T10-02-40-520Z/wizard-home/.bitcoinarena","link":"http://127.0.0.1:18310/?t=(token)","step":"start","build":{"version":null,"commit":null},"usedLink":403,"noSession":401,"otherHost":421,"noHeader":403,"shots":["01-start.png"]} |
| settings.name | settings | pass | 25.7 | {"said":"NAME / Current name / Update / Updated.","refused":"NAME / Current name / Update / a name is letters and digits, with space, dot, dash or underscore between them","kept":"E2E Hauler"} |
| feedback.screenshot | feedback | pass | 0 | {"refused":{"notImage":"a screenshot is a PNG, JPEG or WebP image","svg":"a screenshot is a PNG, JPEG or WebP image","tooBig":"a screenshot is at most 1.5 MB","unknownHash":"that screenshot was not uploaded here"},"kept":"6b7fa434f92a8b80"} |
| page.sub.dashboard | page | pass | 8.1 | {"chars":327,"start":"Bitcoin Arena · Node Dashboards /  / Each testnet4 node serves its own dashboard: its own earnings, the ","failedRequests":0} |
| page.sub.guardians | page | pass | 8.1 | {"chars":1678,"start":"Guardian check /  / This device opens every guardian of the two testnet4 federations at the address its ","failedRequests":0} |
| page.sub.health | page | pass | 8 | {"chars":758,"start":"Bitcoin Arena / Games / How it works / Explorer / Build & run / Download / Proposals / Security / Docs / App → / Network","failedRequests":0} |
| page.sub.offline | page | pass | 8.1 | {"chars":727,"start":"My node is offline /  / Take your own node out of the network while it is offline, so it keeps its bond.","failedRequests":0} |
| page.sub.platform | page | pass | 8.2 | {"chars":4724,"start":"Contents / Play on testnet → / GLOSSARY / PLAY / Start playing / Your wallet / Federations / Stake locks and settl","failedRequests":0} |
| page.sub.proposals | page | pass | 8.1 | {"chars":726,"start":"Bitcoin Arena / Games / How it works / Explorer / Build & run / Download / Proposals / Security / Docs / App → / PROTOCO","failedRequests":0} |
| page.sub.referral | page | pass | 8.1 | {"chars":4008,"start":"Bitcoin Arena / Games / How it works / Explorer / Build & run / Download / Proposals / Security / Docs / App → / Referra","failedRequests":0} |
| page.sub.wallet | page | pass | 8.1 | {"chars":25,"start":"Lightning Wallet testnet4","failedRequests":0} |
| round.replay | rounds | pass | 1.9 | {"last":{"step":"replay","round":"01ba807f56f18d2c7343039923197b9a492154d3a95b4c8aa67bcf2c163b3354","entry":"d5dbe3535b40faaefaefcfbf1bb2f16426e6bda0d52d9d7a0ca9bc9a73bd65f8","core":"68e2b3d6757dc26a76f95eaf0b57799f4e965267ae70a2e79ce4228154acb589","ms":1611,"ok":true,"outcome":"FAILED","score":1605 |

## Triage of the reds (final, 2026-11-14 ~18:45Z)

No product regression was found; no "Regression:" card was filed. Every red was a harness fault, fixed and measured green:
- withdraw.lightning: gateway B paid the withdrawal invoice with "FailureReasonNoRoute" (gateway-b.log): devnet.mjs liquidity opens a -> c only,
  so a withdrawal routed through gateway B had no path to the payee. `lightning.payee-routes` now gives both gateway lnds a channel to it; green.
  Observation for the team: while that payment failed, the page showed no failure for 200 s ("You withdraw 2,000 sat." and nothing more).
- season.board-and-badges ("fetch failed" at 0 s): a kept-alive socket the seat had closed; every door answered 200 a moment later. getJson asks once more; green.
- the earlier reds (identity size, game manifest, 409 doors of an unattested game, a removed sub-page, the settings name card, the paid round's
  entry window, the restore moving the e-cash) are described above and green since.

Not covered (2): round.free.page-join (a private chain cannot be proven by the page: compiled-in anchors, one shared devnet bond proof) and
installer.reach-service (asks live testnet4 seats, installs into the Mac's real launchd beside node 15).
Live paid rounds on testnet4 (every game) are a separate runner: e2e/live-paid.mjs.
