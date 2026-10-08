# Bitcoin Arena

An engine for games and prediction markets played for bitcoin: custody in a Fedimint federation of bonded nodes, every
run replayed by independent nodes, payouts computed alike by every node. **Test networks only (testnet4, regtest);
mainnet is not live.**

| package | what it is |
|---|---|
| `packages/arena-protocol` | the protocol: contracts, manifests, census, payouts, fees, donations |
| `packages/arena-node` | the node: lists rounds, takes entries, replays runs, signs results and payouts, runs a guardian |
| `packages/arena-client` | the player's client in the page: lobby, join, wallet, the game picker |
| `packages/arena-donor` | the developer's client: donation key, collect and withdraw, the game developer key, signing a manifest |
| `packages/nextblock` | the first game's deterministic core and its plugin |
| `unity-proto/Assets/WebGLTemplates/NextBlock` | the page around the game; `platform/index.html` is the guide for developers and node operators |

```sh
npm install
cd packages/arena-protocol && node --test test/
```

Start with `unity-proto/Assets/WebGLTemplates/NextBlock/platform/index.html` (open it in a browser): why build here, who
earns what, a guide to programming and signing a game, and how to run a node. The full specification is
`multiplayer_p2p.md`.

MIT licence: see `LICENSE`.
