# Clave compatibility automation — implementation plan only

Split from #2952 into #3072. Unassigned backlog; plan only. Assume an Apple-silicon Mac with current macOS/Xcode. Initial scope is foreground NIP-46 only. Do not provision a Mac, implement Clave automation, or set up APNs/proxy infrastructure.

## Verified feasibility (2026-11-20)

Source reviewed: https://github.com/dmnyc/clave/tree/230229a08d92d687b6b667fd30dcce7cba2d9591 (README, Clave.xcodeproj/project.pbxproj, Clave/Clave.entitlements, ClaveNSE, Shared/SharedConstants.swift, Shared/SharedKeychain.swift, Clave/AppState+NostrConnect.swift, ClaveUITests, relay-proxy/proxy.js).

A physical iPhone is NOT inherently required. Apple Xcode 14 release notes explicitly support sandbox remote notifications on iOS 16 Simulator with macOS 13 and Apple silicon or T2, including Notification Service Extensions. These are minimum feature requirements, not a recommendation to use old Xcode. Select a currently supported macOS/Xcode/runtime combination after identifying the Mac. Source app/NSE deployment target is 17.6; project/test settings also reference 26.4. Resolve packages and validate actual build settings before choosing runtime. No build was run on this Linux host.

Apple sources:
- https://developer.apple.com/documentation/xcode-release-notes/xcode-14-release-notes
- https://developer.apple.com/xcode/system-requirements/
- https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns
- https://developer.apple.com/help/account/capabilities/communicate-with-apns-using-authentication-tokens/
- https://developer.apple.com/documentation/xcode/testing
- https://developer.apple.com/documentation/xcuiautomation

`simctl push` is useful for payload/UI tests but is not proof of APNs transport or NSE signing. Apple explicitly distinguishes it from remote notifications supporting NSEs.

Clave README warns debug end-to-end signing fails against its production proxy (sandbox tokens). The app entitlement currently says production; proxy defaults to api.push.apple.com and hardcodes APNS_TOPIC dev.nostr.Clave. Shared constants contain production relay/proxy and app group. A source build is required, not the App Store iPhone binary. Simulator compilation alone and a successful nostrconnect handshake do not establish full signing compatibility. Source has foreground LightSigner request handling, but sustained foreground full-suite operation remains an experiment, not a verified push-free solution.

## Foreground implementation plan (future work)

1. When the Mac exists, inventory its chip, macOS/Xcode versions and installed iPhone runtime. Pin Clave source/dependencies and capture `xcodebuild -list` / `-showBuildSettings`. Build Debug for an explicit iPhone Simulator destination. App/NSE targets specify iOS 17.6, while project/test settings reference 26.4: verify effective settings on that Xcode. Install the simulator .app, not the App Store device binary. No build has been run here.
2. Validate app Keychain and app-group access in the simulator. A compile-only unsigned build is a useful first experiment, but removing sharing entitlements cannot establish working signing. Resolve actual signing requirements on the chosen Xcode before deciding whether a developer account is needed for this foreground experiment. Do not assume APNs credentials are needed for foreground operation.
3. Use XCTest/XCUIAutomation to launch a clean simulator, import a fresh disposable Nostr key, handle onboarding and keep Clave foreground throughout the run. Existing UITests are launch templates. Use paste-link or deep-link pairing rather than camera scanning. Do not bypass UI by writing permission storage. Grant required signing/encryption operations including protected kind 30078 (Medium trust would otherwise prompt). Never import funded/personal keys; delete simulator/Keychain and pairings afterward and redact credentials from artifacts.
4. First establish a real `nostrconnect://` handshake: subscribe before opening the URI, validate the echoed secret and preserve the client identity. Choose a reachable test relay at execution time. Source has foreground LightSigner handling and a bounded post-handshake listener; prove that subsequent requests continue to arrive. README's debug limitation against the production proxy means a handshake alone is not evidence of a complete foreground signing path. No production push service dependency is assumed.
5. Run the existing compat-check.mjs assertions through the actual foreground app: get_public_key, signatures for kinds 27235/30078 and NIP-44 self encrypt/decrypt round trip. Audit BunkerSigner identity/reconnect behavior before reusing a bunker URI whose secret may rotate. Capture exact source SHA/build version, simulator runtime, foreground state and per-call results. Never label this source build as the App Store release.
6. If foreground relay handling cannot sustain the suite, stop and record the precise blocker and logs. Ask the owner before broadening scope or patching Clave; do not silently add a test proxy, APNs, background coverage or a physical device. A direct LightSigner unit test cannot substitute for real NIP-46 traffic through the app.
7. Only after a real pass, propose a foreground macOS adapter for compat-run.mjs with explicit missing-environment skips, bounded timeouts and sanitized reports. Mark coverage as foreground only. Keep Clave manual until that evidence exists. Follow the repository's then-current results publishing policy.

## Deferred: background push feasibility

Apple's sandbox APNs/NSE Simulator support establishes that a physical iPhone is not inherently necessary. Full background coverage would additionally need a team-owned push-enabled test app identity, compatible app/NSE signing, app groups and Keychain entitlements, a sandbox-configured proxy and relay, and APNs credentials. Clave's proxy supports APNS_HOST but hardcodes its topic; app/shared defaults and production entitlements need consistent test configuration. `simctl push` does not establish real APNs/NSE signing. This work is outside the owner's selected foreground scope and requires a new decision.

## Remaining prerequisites

No Mac is currently available. Actual hardware access, runtime/build validation, foreground listener feasibility and a reachable test relay remain execution-time prerequisites. The owner has selected foreground-only exploration; no Apple Developer account, push server or background coverage is requested.
