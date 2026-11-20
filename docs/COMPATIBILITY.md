# Compatibility checks

The public list is `src/website/www/compatibility/results.json`. `planned.json` is the shared product catalog: product link, platform, check method, release source and pairing secret name. Your four manual results remain until a passing automatic test replaces them in a reviewed PR.

## Release-triggered checks (#2950, #2952)

After merging the compatibility PR stack, enable GitHub Actions and the repository setting allowing Actions to create pull requests. The scheduled workflow polls release versions from the default branch at 03:23 UTC. Scheduled runs use `--releases-only`: only a versioned product with a newly detected version is eligible for testing. An already checked version (passing or failing) is skipped; hosted/unversioned products are manual-only. Manual workflow/local runs can explicitly retest unchanged or unversioned products. Versioned paired apps must first be upgraded and their installed-version credential updated to the detected release. This workflow does not upgrade remote apps.

Set a repository secret named `COMPAT_SECRETS` containing a JSON object. Each catalog entry with `check: signer` or `check: nwc` names its connection field, for example:

```json
{
  "COMPAT_NSEC_APP": "bunker://<paired-test-signer>",
  "COMPAT_ALBY_HUB": "nostr+walletconnect://<budgeted-test-wallet>",
  "COMPAT_ALBY_HUB_VERSION": "<installed-version>"
}
```

Use dedicated test accounts and pair signers once with the requested calls allowed. NWC connections need `get_info`, `get_balance`, `make_invoice`, and (for a payment-enabled check) `pay_invoice`. Use a small spending budget. Pairings are credentials: revoke them when retiring a product. Keep their values out of issues and commits.

For a remote app with published releases, supply `<connection-field>_VERSION` with the installed version. The latest available release alone cannot prove what the paired app runs. Without the installed version the row says `unknown`; hosted services use `hosted`, and an unversioned self-hosted service uses `self-hosted`. Update the version field when upgrading the paired app.

For a payment-enabled check, set the separate `COMPAT_PAY_WALLET` repository secret to our receiving NWC wallet. Each product pays its 1 sat invoice, then our wallet pays the product's 1 sat invoice back. Both wallets may incur routing fees; these are not refunded. A missing receiving wallet or failed return payment produces a failure for triage. A product that cannot create its return invoice is never charged. Manual workflow runs only pay when the `pay` input is selected. This workflow does not provision or fund accounts.

Missing pairings are explicitly skipped. Manual products generate reminders when the published version differs from the last tested version. A failed test retains the previous public row and opens or updates one triage issue in **our** repository. It never opens an upstream issue. Diagnose first; our bugs get a kanban ticket, and suspected product bugs go to the team before any upstream report.

Passing rows are proposed on the persistent `automation/compatibility-results` branch. A row refreshes after its version or tested calls change, when replacing a manual/failed row, or after 30 days on an explicit retest; release polling does not itself retest unchanged versions. Local adapter changes and measured results are reviewed in a PR. The scheduled workflow follows its existing publication policy. JSON and Markdown reports are retained as workflow artifacts for 30 days, including skipped pairings and version lookup errors.

## Running locally

Install `packages/arena-node` dependencies (replace its tracked development `node_modules` symlink with a local installation first), then from that directory:

```sh
node --test --test-timeout=60000 test/compat-check.test.js test/compat-run.test.js test/compat-publish.test.js
node tools/compat-run.mjs --out=/tmp/arena-compat --no-extensions
node tools/compat-run.mjs --out=/tmp/arena-compat --only='Alby Hub'
```

The runner writes passing changes into the working tree's `results.json`. Supply credentials through environment variables or `COMPAT_SECRETS`; supply `GITHUB_TOKEN` for authenticated release lookups. `--pay` explicitly enables the round trip. Local tests use an in-process relay, bunker and wallet and spend no funds.

## Browser and mobile coverage

The nos2x and Sidecar adapters (#2951) download the actual Chrome Web Store package, load it in Chromium with a fresh test key, allow the testnet site in extension storage, and drive the real Login with Nostr → Browser extension flow. Each waits for the restored wallet after reload, then verifies the signed encrypted seed read back from our relay, decrypts it through the extension and verifies an auth signature. The row records the version of the downloaded package. Profiles and test keys are deleted after each run; browser subprocesses do not receive pairing secrets or the GitHub token. Successful public testnet checks of nos2x 2.5.2 and Sidecar 1.17.2 are included in the results.

Install Chromium with `npx playwright install --with-deps chromium` from `packages/arena-node`. For a locally installed unbranded Chromium, set `COMPAT_CHROMIUM` to its executable. A local integration check also runs the actual extension, our bundled login component and Nostr library on a temporary HTTP server and relay, including the post-login reload:

```sh
COMPAT_EXTENSION_PACKAGE=/absolute/path/to/nos2x.crx node --test --test-timeout=120000 test/compat-extension.test.js
```

Set `COMPAT_EXTENSION_ADAPTER=sidecar` to check Sidecar with its own package. The optional integration test is skipped without that package path. The scheduled run exercises the real public testnet login. Sidecar initializes its own encrypted keystore and imports the disposable key through the extension’s own functions; nos2x uses its documented storage shape. Alby has an encrypted account/password onboarding flow and still needs a tested setup adapter (unassigned backlog #2956). Keys.band 1.7.0’s shipped provider exposes NIP-04 but no NIP-44, which our login requires; no upstream issue has been filed. Those two remain manual, with release reminders for any previously tested version and explicit skip reasons otherwise. Amber Android emulator automation is tracked in #2952; its adapter runs locally under the owner’s Linux user account (no GitHub runner provisioning). Clave remains manual pending the macOS/iPhone Simulator work planned separately in [#3072](https://beelink.tail1723e2.ts.net/kanban/task/3072). See [the Clave implementation plan](CLAVE-COMPATIBILITY-PLAN.md) for source evidence, sandbox APNs/NSE requirements and pending infrastructure decisions. A physical iPhone is not inherently required.

## Amber on a local Android emulator (#2952)

`compat-amber.mjs` checks the actual online Android APK through its UI and NIP-46. The SDK, JDK, APK and AVD live under the operator's user account; this change adds no GitHub runner, installation workflow or schedule. The catalog uses `check: android`. Without an explicitly selected emulator, the runner skips Amber and retains version reminders.

Use a dedicated English-language AVD named **arena-compat-amber**, with Android API 35 and host loopback reachable as `10.0.2.2`. Start it before running the check and wait for `adb shell getprop sys.boot_completed` to return `1`. Serialize runs on that AVD. The adapter disables Android animations in this dedicated test device and waits between UI actions. The adapter refuses physical device serials and other AVD names. It **clears Amber's app data before and after each check**; never put a personal key in this AVD.

Install the online x86_64 APK from Amber's official release (not the offline variant), verifying its signed release manifest. The measured release is 6.6.9, SHA-256 `2de34e1b278dbad3a06064814b0503330ec95c4927013ca67208192cdf3ad93e`. APK upgrades remain an explicit local maintenance action. Optional `COMPAT_AMBER_APK=/path/to/verified.apk` installs that APK before checking; otherwise the adapter uses the installed online package. The public row records Android's installed `versionName`, even when GitHub's latest-release lookup fails.

From the repository root, with the emulator running (manual retest; add `--releases-only` for release gating):

```sh
COMPAT_ADB=/path/to/android-sdk/platform-tools/adb \
COMPAT_AMBER_SERIAL=emulator-5582 \
node packages/arena-node/tools/compat-run.mjs --only=Amber --no-extensions --out=/tmp/amber-report
```

The adapter imports a fresh disposable key, creates a bunker connection using only an ephemeral loopback relay, and selects **I fully trust this application** for that test connection. It reads the real bunker URI from the UI and runs the existing verifier: connect, public key, signed kinds 27235 and 30078, and NIP-44 encryption/decryption to self. The relay forwards verified kind-24133 events; it does not implement a signer. No pairing secret is stored. Notification permission is granted to the test APK. Errors identify the failed stage and cleanup failure prevents a passing result. UI selectors match the released English UI; the unlabeled add-relay icon is located relative to its relay field. UI changes may require an adapter update.

Transport, dispatch and missing-device checks run without Android. The optional integration test performs the entire real UI flow and destroys test app state:

```sh
cd packages/arena-node
COMPAT_AMBER_INTEGRATION=1 COMPAT_ADB=/path/to/android-sdk/platform-tools/adb \
COMPAT_AMBER_SERIAL=emulator-5582 \
node --test --test-timeout=300000 test/compat-amber.test.js
```

Successful local runs write `results.json` through the existing runner; include measured changes in an implementation/results PR. No local run pushes, publishes or merges automatically. Stop the emulator when finished. Interrupted runs may leave disposable app state; the next run clears it before creating a new key.

The owner selected release-triggered checks, not nightly emulator runs. Local infrastructure stays outside this repository: the local release watcher polls stable Amber releases hourly, verifies the upstream signed manifest and APK checksum, and starts the emulator only for a newly observed release. It records the checked release after a completed result; failed versions require a manual retest or a newer release. Its launcher clears test state and shuts the emulator down. No Mac or Clave infrastructure is provisioned. This local service currently points to the dedicated implementation checkout; update its checkout path if that checkout is retired after merge.
