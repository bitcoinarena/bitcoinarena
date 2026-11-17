# Compatibility checks

The public list is `src/website/www/compatibility/results.json`. `planned.json` is the shared product catalog: product link, platform, check method, release source and pairing secret name. Your four manual results remain until a passing automatic test replaces them in a reviewed PR.

## Nightly setup (#2950)

After merging the compatibility PR stack, enable GitHub Actions and the repository setting allowing Actions to create pull requests. The scheduled workflow runs from the default branch at 03:23 UTC. It can also be started manually.

Set a repository secret named `COMPAT_SECRETS` containing a JSON object. Each catalog entry with `check: signer` or `check: nwc` names its connection field, for example:

```json
{
  "COMPAT_NSEC_APP": "bunker://<paired-test-signer>",
  "COMPAT_ALBY_HUB": "nostr+walletconnect://<budgeted-test-wallet>",
  "COMPAT_ALBY_HUB_VERSION": "<installed-version>"
}
```

Use dedicated test accounts and pair signers once with the requested calls allowed. NWC connections need `get_info`, `get_balance`, `make_invoice`, and (for the weekly check) `pay_invoice`. Use a small spending budget. Pairings are credentials: revoke them when retiring a product. Keep their values out of issues and commits.

For a remote app with published releases, supply `<connection-field>_VERSION` with the installed version. The latest available release alone cannot prove what the paired app runs. Without the installed version the row says `unknown`; hosted services use `hosted`, and an unversioned self-hosted service uses `self-hosted`. Update the version field when upgrading the paired app.

For the weekly Sunday payment check, set the separate `COMPAT_PAY_WALLET` repository secret to our receiving NWC wallet. Each product pays its 1 sat invoice, then our wallet pays the product's 1 sat invoice back. Both wallets may incur routing fees; these are not refunded. A missing receiving wallet or failed return payment produces a failure for triage. A product that cannot create its return invoice is never charged. Manual workflow runs only pay when the `pay` input is selected. This workflow does not provision or fund accounts.

Missing pairings are explicitly skipped. Manual products generate reminders when the published version differs from the last tested version. A failed test retains the previous public row and opens or updates one triage issue in **our** repository. It never opens an upstream issue. Diagnose first; our bugs get a kanban ticket, and suspected product bugs go to the team before any upstream report.

Passing rows are proposed on the persistent `automation/compatibility-results` branch. A row refreshes after its version or tested calls change, when replacing a manual/failed row, or after 30 days. An admin reviews and merges the PR; no run deploys the site or merges results automatically. JSON and Markdown reports are retained as workflow artifacts for 30 days, including skipped pairings and version lookup errors.

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

Set `COMPAT_EXTENSION_ADAPTER=sidecar` to check Sidecar with its own package. The optional integration test is skipped without that package path. The scheduled run exercises the real public testnet login. Sidecar initializes its own encrypted keystore and imports the disposable key through the extension’s own functions; nos2x uses its documented storage shape. Alby has an encrypted account/password onboarding flow and still needs a tested setup adapter (unassigned backlog #2956). Keys.band 1.7.0’s shipped provider exposes NIP-04 but no NIP-44, which our login requires; no upstream issue has been filed. Those two remain manual, with release reminders for any previously tested version and explicit skip reasons otherwise. Amber in an Android emulator remains the unassigned backlog idea #2952; Clave needs a real iPhone and stays manual.
