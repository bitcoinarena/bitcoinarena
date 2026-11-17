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

For the weekly Sunday payment check, set the separate `COMPAT_PAY_WALLET` repository secret to our receiving NWC wallet. Each product pays its 1 sat invoice, then our wallet pays the product's 1 sat invoice back. Both wallets may incur routing fees; these are not refunded. A missing receiving wallet or failed return payment produces a failure for triage. Manual workflow runs only pay when the `pay` input is selected. This workflow does not provision or fund accounts.

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

Browser automation is tracked by #2951. Products without a tested setup adapter remain manual and produce release reminders. Amber in an Android emulator remains the unassigned backlog idea #2952; Clave needs a real iPhone and stays manual.
