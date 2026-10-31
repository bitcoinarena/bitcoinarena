# Create a market (kanban #920)

## What the owner asked for

A node owner creates a new prediction market in the owner dashboard, always with the same form.
They choose where the result comes from: a URL the nodes read, or code the nodes run.
Code gets an editor with syntax highlighting, live testing and examples: read a socket, read a page, compute on the spot.
Every node checks the code for malicious content. Anything obfuscated, hidden or compressed is forbidden.
The owner sets one-off or recurring, the length and the rest of the terms.
It looks modern, needs no explaining and ends with signing the finished market.

## Where we start

| Part | Today |
|---|---|
| Market template in the protocol | yes: `manifest.js` template rounds, each round asks its own question |
| Form that makes one | no: only a JSON box under Developer |
| Result from a URL or code | no: seats decide BTC Up/Down only |
| Sandbox | yes: `core-sandbox.js`: no network, files or clock; 2 s per call, 128 MB |
| New market reaches other seats | no: a seat hosts what its owner installed |
| Day posting | three named apps only |

So this needs a protocol change and one node release. After that, a new market needs neither.

## The flow

Six steps, one screen each, a live preview of the market card beside them.

1. **Start**: pick a template or blank.
2. **Question**: title, category from a fixed list, image, outcomes (2 to 8, or a number between two bounds).
3. **Result**: a URL, or code.
4. **Test**: run it now, see the outcome, the time taken and each check.
5. **Schedule**: one-off or recurring, length, entry close, stake, federations.
6. **Sign**: review, sign, publish.

Templates: *Price above X*, *Up or down*, *Number between*, *Yes or no from a page*, *Blank*.
Text stays to labels and one short hint per field. Errors appear at the field.

## The result source

### URL

| Field | Rule |
|---|---|
| Address | `https`, public host only |
| Read | JSON path, or a CSS selector, or a regular expression |
| Rule | compare to a value, or map the value to an outcome |

Known addresses are one tap: Coinbase, Binance, Kraken, Bitstamp, mempool.space, blockchain.info.
Testing reads the address, shows the value, the fields it holds to pick from, and the outcome; every option is tried at once on that answer.

### Code

One pure function. It has no network, files, clock or randomness.
The owner declares what the node reads; the node reads it outside the sandbox and passes the results in.

```js
// reads: [{ id: 'btc', kind: 'http', url: 'https://…', at: 'close' }]
function decide(reads, market) {
  return reads.btc.price >= market.strike ? 'Yes' : 'No';
}
```

| Example | Declared read | The code |
|---|---|---|
| Read a page | `http` | picks a value out of the page |
| Read a socket | `ws`, with subscribe message and sample length | gets the messages as a list |
| Compute on the spot | none, or several | averages, compares, rounds |

Why this shape: it keeps §0A.6's sandbox, and the same inputs give the same answer on every node.

### When nodes disagree

Seven are drawn and five must sign the same outcome, as today. Without five, the round refunds.
A market reading a fast number should round it in its code. The test step warns when two reads differ.

## Who controls the source

Consensus does not protect a market from its own source: seven honest nodes reading a page its creator runs sign the creator's answer.
So a market reads listed hosts only, enforced in the manifest rule, on every node. The list is `MARKET_HOSTS`; a host joins by a release, later by a vote.

| Attack | Answer |
|---|---|
| Creator's own page | refused: not listed |
| Creator's page behind code | refused: code declares its reads, and each is held to the list |
| Page that answers nodes differently | same: not listed. On a listed host, under 5 of 7 refunds the round |
| Thin pair on a listed exchange, moved by a trade | open: needs a list of pairs or a median of exchanges |
| Listed host with text anyone can post | keep such hosts off the list |

## What every node checks

The check runs before a node hosts a market and again in the editor. It is one versioned function, so all nodes agree.

| Refused | How it is found |
|---|---|
| `eval`, `Function`, `import`, `require`, `globalThis`, `process`, `WebAssembly`, `Proxy`, `Reflect` | parsed tree, never text search |
| computed access to those names (`this['ev'+'al']`) | any computed member on a global or a prototype |
| Base64, hex or packed text | string over 200 characters, or high entropy |
| Escapes in names or strings used to hide text | `\u`, `\x` outside plain data |
| Minified code | line over 200 characters, or mostly one-letter names |
| Oversized code | over 32 KB |

Failing one rule refuses the market, with the rule and the line shown. No rule is scored or waived.
This does not prove code is safe; the sandbox does that. The check makes code readable for people.

Network reads:

| Rule | Value |
|---|---|
| Hosts | listed hosts only; public addresses, checked after DNS, never private or local ranges |
| Reads per market | 3 |
| Answer | 1 MB, 10 s, no redirects, no cookies, no keys |
| Socket | 30 s, 1,000 messages |

## Schedule

| Field | One-off | Recurring |
|---|---|---|
| Timing | resolve date | every 5 min, 15 min, 1 h or 1 day |
| Length | entry close before resolve | window length |
| End | one round | number of rounds, or until stopped |

Also: minimum and maximum stake, creator fee within the protocol's limits, federations, and when the round refunds without a result.

## Signing and publishing

The market is signed with the dev key derived from the owner's words or nsec.
Extension and bunker logins hold no such key. They see a clear message for now.

Publishing is a new owner door. The node keeps the signed market and offers it to other seats.
Each seat fetches it, runs the check and hosts it. An owner can turn this off.

## Changes needed

| Change | Where |
|---|---|
| Source field in the manifest, new marker, protocol vote | `arena-protocol/manifest.js` |
| `attest` call in the sandbox | `core-sandbox.js`, `core-driver.js` |
| Reader for URL, http and socket | new `market-reader.js` |
| Rule check | new `market-check.js`, shared by node and page |
| Template rounds scheduled by `resolveAtMs` | `drawn-attestor.js`, `server.js:2363` |
| Publish and spread | `server.js` owner block, seat fetch |
| Day posting for any market | `duty-guard.js` |
| Form with CodeMirror, served by the node | `arena-web/src/owner` |
| A signed market counts as known in the client | `market.js`, `donation-pay.js` |

§0A.6 says a node never runs code because a manifest names it. This feature changes that rule by the owner's request of 2026-10-31, for this sandboxed function only.

## Order of work

1. Form and templates, URL only, local preview. Needs no release.
2. Check, editor, examples, test in the browser.
3. Node reader and test door.
4. Protocol field, attest call, release, testnet4 vote.
5. Publish, spread, posting.
6. One real market on testnet4, settled and paid.

## Open rulings

| Question | Assumed until ruled |
|---|---|
| Who may publish | bonded node owners only |
| Limit against spam | 5 open markets per node |
| Auto-host markets from other nodes | on, if the check passes |
| Topics a node refuses | each owner decides; no central list |
| Mainnet | testnet4 only until a review of reader and check |
