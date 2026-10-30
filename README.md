# Bitcoin Arena

> **⬇ Run a node: [download the latest release](https://github.com/bitcoin-arena/bitcoin-arena/releases/latest)** (testnet4):
> Windows `bitcoin-arena-node-setup-*.exe` · macOS `bitcoin-arena-node-*.dmg` · Linux `bitcoin-arena-node_*.deb` · or the plain archives.
> All releases: [Releases](https://github.com/bitcoin-arena/bitcoin-arena/releases). Guide: [docs.bitcoin-arena.io](https://docs.bitcoin-arena.io/#run).

Bitcoin Arena is a set of games and prediction markets played for bitcoin, with **no central server**. The nodes *are* the arena:

- they hold the rounds;
- they check every run and every outcome;
- they sign the results;
- their federations keep the players' stakes.

Anyone can run a node. A node posts a bond on Bitcoin, gets drawn onto rounds, and earns a share of every paid entry. It is checked by the other nodes in everything it signs; a node that cheats is slashed with the proof made public.

It runs on **testnet4** today.

## Play

| Game | Kind | What it is |
|---|---|---|
| **Tick Tock, Next Block** | skill, replayed | Drive a truck through the next Bitcoin block. Load mempool transactions, cross the price war front, deliver before time runs out. Every player gets the same block and seed, every node replays every run, and the best run wins the pot. |
| **Rock Paper Scissors** | head to head | Commit a hidden move, reveal it, and the winner takes the pot. Rounds every 8 seconds. |
| **Bitcoin Up or Down** | prediction market | Will BTC be higher at the end of the 15-minute window? Three independent attestors sign the price, and the winning side shares the pot. 96 markets a day. |

The game page is at [testnet.bitcoin-arena.io](https://testnet.bitcoin-arena.io). Your wallet is your 24 words or your Nostr key; your stake is locked in a federation until the round settles.

## Run a node

1. **Download** the package for your system from the [latest release](https://github.com/bitcoin-arena/bitcoin-arena/releases/latest) and open it. A small *Bitcoin Arena* window starts the installer and opens its setup page in your browser.
2. **Set it up** in the browser wizard. It tests each step before saving it:
   - **chain:** your own Bitcoin Core, or an Electrum server;
   - **roles:** verify, settlement, custody, liquidity;
   - **24 words:** your node's keys and your wallet;
   - **public address:** direct, a Cloudflare tunnel, Tailscale Funnel or workers.dev;
   - **Lightning and the gateway**, for custody;
   - **the bond.**
3. **Manage it** with one command:

   | Command | What it does |
   |---|---|
   | `bitcoinarena status` | every service and what it answers |
   | `bitcoinarena doctor` | finds problems and names the fix |
   | `bitcoinarena restart lnd` | restarts one service, or all with plain `bitcoinarena restart` |
   | `bitcoinarena logs` | shows a service's log |
   | `bitcoinarena config` | shows and changes the settings |

   Add `--verbose` (or `-v`) to any of them, or to `arena-install`, to see each step as it runs; `--debug` also shows full errors, failed answers and the programs it runs. Passwords, keys and seed words are never shown. For the node's own services: `bitcoinarena config set log_level debug`, then `bitcoinarena restart`.

   Until 2026.1.9.8 the command was `arenanode` and the node lived in `~/.arena-node`. `arenanode` still works (it runs `bitcoinarena`), and a node installed before stays in `~/.arena-node`; a new one goes in `~/.bitcoinarena`.

   Every setting is in one file, `arena.conf`. The owner page (`/dashboard/owner`, signed with your owner key) shows the same services, plus the bond, earnings and updates.
4. **Update** in place with `arena-install --update <new release>`. It checks the release's signature, backs the node up, and rolls back by itself if the new release does not come up.

Each paid entry pays **4 % to the nodes** (four pools: game/verify, settlement, custody, liquidity), **4 % to the developers** and **2 % to the protocol reserves**, a treasury the bonded nodes vote to spend. Prediction markets pay 0.4 % / 0.4 % / 0.2 %.

The full guide, the node API and how to build your own game are at **[docs.bitcoin-arena.io](https://docs.bitcoin-arena.io)**.

## How it works, in one paragraph

A round is a signed contract. Players enter with a stake locked in a Fedimint federation (10 guardians, all of them nodes) and play against a deterministic game core. A committee of 7 nodes, drawn by a fair lottery from the bonded nodes in the on-chain census, replays every input (or checks the attestors' signed outcome for a market). The result holds when 5 of the 7 sign the same one. The federation then pays the winners from the locked stakes. Every rule is a protocol version: rounds carry the version they run on, and old and new versions run side by side.

## Repository layout

| Path | What |
|---|---|
| `packages/arena-protocol` | the protocol: canonical encodings, contracts, census, sortition, payouts, reserves. Isomorphic JavaScript |
| `packages/arena-node` | the node (seat): rounds, entries, replay, signing, settlement, federations, the owner page |
| `packages/arena-client` | the player's half: joining, stake locks, the page's bundle |
| `packages/arena-installer` | the installer wizard, `bitcoinarena`, updates, services on Linux/macOS/Windows |
| `packages/nextblock` | Tick Tock, Next Block's deterministic core (integer arithmetic only) and plugin |
| `packages/rock-paper-scissors`, `packages/btc-updown` | the other games: decide adapters, signed manifests, clients |
| `packages/arena-attestor` | a market attestor: reads price sources, signs outcomes |
| `packages/arena-donor` | a developer's donation client |
| `unity-proto/` | the Unity WebGL client of Tick Tock, Next Block (input and rendering only; outcomes come from the core) |
| `deploy/` | the websites: homepage, docs and API reference |
| `tools/release/` | the release build (`build-release.sh`), the installer packages (`package.sh`, `package-mac.sh`) and signing |
| `multiplayer_p2p.md`, `FEDERATION.md` | the specification |
| `index.html`, `src/` | the original single-player browser prototype ([its notes](docs/original-browser-prototype.md)) |

## License

The **Bitcoin Arena License 1.0** ([LICENSE](LICENSE)) covers everything here: the protocol, the nodes, the installer, the UI and the
games. In short: **everything is allowed, except replacing the original protocol developers.** Use, copy, change, sell and fork it
as with MIT; a fork keeps the **network id** (it stays on the same network) and the **network's donation set** (every round still pays
the original protocol developers). That set changes only by updates signed with the donation authority key; a game's own donation
set belongs to its developers.

## Develop

The apps (Next Block, Rock Paper Scissors, Up or Down, Hello World) are not in this repository: each is its own repository, pinned in `apps.lock.json`. Place them once after a clone, and again when a pin moves:

```
node tools/fetch-apps.mjs
```

Each package's tests run with Node.js 24:

```
cd packages/arena-node && node --test --test-timeout=120000 test/<file>.test.js
```

The release workflow (`.github/workflows/release.yml`) runs the installer tests, builds every asset for Linux, macOS and Windows, installs each one fresh on its own system, and builds and installs the packages. Every release's `SHA256SUMS` is signed with the Arena release key (published at [testnet.bitcoin-arena.io/release-key.txt](https://testnet.bitcoin-arena.io/release-key.txt)).

The repository and its releases are private for now: invited users only.
