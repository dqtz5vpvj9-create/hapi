# HAPI mobile shell

This Capacitor app packages the existing React application in `web/`. Chat,
workspaces, settings, rendering and attachment uploads continue to use the Web
implementation. Native plugins provide system file/photo selection, protected
credential storage, keyboard resizing, Android back navigation and Web bundle
updates.

The shell lives in `mobile/android` and `mobile/ios`. The existing Kotlin client
in [`android/`](../android/README.md) and SwiftUI client in
[`ios/`](../ios/README.md) are independent applications. The shell's application
and bundle ID is `run.hapi.mobile`, so it can be installed alongside the native
companion. Launcher artwork is copied from the repository's existing HAPI icons.

## Build

Requirements:

- A Git checkout, Node.js 22 or newer and the repository's Bun 1.4.0.
- Info-ZIP (`zip` and `unzip`) for update packaging and its regression tests.
- Android: JDK 21, Android SDK 36 and Android Studio 2025.2.1 or newer. The
  checked-in wrapper uses Gradle 8.14.3 and the app uses AGP 8.13.0. Minimum
  Android API level is 24.
- iOS: macOS and Xcode 26 or newer. The project uses Swift Package Manager and
  targets iOS 15 or newer. CocoaPods is not required.

From the repository root:

```sh
bun install --frozen-lockfile
bun run build:mobile
```

`build:mobile` builds `web/dist` in Vite's `native` mode and runs Capacitor sync.
The native build omits the PWA service worker. A check before sync rejects a
browser PWA build, remote/development entry scripts, non-root asset paths and
missing referenced assets. The app loads the copied local bundle initially and
can later activate a verified downloaded bundle. Both run at the same local
WebView origin. `capacitor.config.ts` has no remote `server.url` or
`allowNavigation` list. The Web base URL must be `/`.

Generated Web assets, local SDK paths, build outputs and signing keys are
ignored. Native project source files are checked in. Run build/sync before
building an APK or iOS app so its fallback Web bundle and native update metadata
match that checkout. Ordinary Web changes can use the update workflow below
without rebuilding the installed binary.

### Android

```sh
bun run --cwd mobile open:android

# Command-line debug build, after setting ANDROID_HOME or mobile/android/local.properties
cd mobile/android
./gradlew :app:assembleDebug :app:lintDebug

# Install on a connected emulator or device
./gradlew :app:installDebug
```

The debug APK is produced at
`mobile/android/app/build/outputs/apk/debug/app-debug.apk`. Release signing is
configured in Android Studio by the maintainer; no signing credentials or
Firebase configuration are included.

Published Android debug APKs use the same persistent key as the established
local installation. The repository secret `HAPI_ANDROID_KEYSTORE_BASE64` stores
the existing keystore, encoded as Base64; it must not be replaced with a newly
generated key. Main-branch and manual builds restore it before Gradle runs,
verify the APK against the public certificate in `android-signing-cert.pem`,
and remove the restored private key afterwards. A missing secret or different
certificate fails publication. Pull requests still compile and lint, but do not
receive the persistent key or publish an APK with a temporary signer.

Keep the local keystore outside source/build/cache directories. The maintained
copy is `${XDG_DATA_HOME:-$HOME/.local/share}/hapi-mobile/signing/hapi-android.keystore`;
the local backup is in the adjacent `signing-backup` directory. Both directories
are owner-only and the key files have mode `0600`. Local Gradle debug builds use
the matching `$HOME/.android/debug.keystore`. Restore that file from the
maintained copy if setting up a new local build environment. The existing key
uses Android's standard debug alias and passwords. Never commit the keystore or
upload it as a build artifact. The checked-in PEM contains only its public
certificate, which is safe to distribute.

### iOS

```sh
bun run --cwd mobile open:ios

# Simulator build from the repository root; no distribution signing required
xcodebuild build -project mobile/ios/App/App.xcodeproj -scheme App \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
```

Xcode resolves the Capacitor runtime and plugin Swift packages. A physical
device or distribution build requires the maintainer's Apple signing team.

## Update HAPI without replacing the app

The native app checks for a compatible Web bundle at startup, when it returns
to the foreground and hourly while open. It downloads a candidate without
activating it. **Update HAPI** uses the existing update banner: the user's click
switches to the complete downloaded bundle and reloads the Web UI. It does not
automatically reload a conversation or require installing another APK/IPA.
Browser/PWA users continue using the existing service-worker update path.

| Change | Delivery |
| --- | --- |
| React screens, command details, styling, Web logic or assets | A compatible Web update; tap Update HAPI |
| Native plugin implementation or version, Java/Kotlin/Swift code, native permissions, WebView configuration or update trust settings | A new Android/iOS binary |
| Hub or CLI behavior | Update that server/CLI deployment separately |

Native compatibility is computed from the installed binary's native source,
plugin dependencies and configuration. It does not follow `APP_VERSION` or Web
source changes. Each platform has its own SHA-256 runtime identifier. An update
with a different identifier is not loaded; the UI explains that this release
requires a newer app. The updater itself is a native plugin, so a binary built
before this mechanism was added needs one app update to gain this capability.

There is one trusted update source for the app, independent of the selected
data Hub. The default is:

```text
https://raw.githubusercontent.com/dqtz5vpvj9-create/hapi/mobile-updates/latest.json
```

[`update.config.json`](update.config.json) selects this source. A custom Hub
cannot replace the app's code by changing the hub URL. Native metadata exposes
the feed and compatibility identifiers to Web code through the small
`HapiUpdates` bridge. The app keeps its existing local origin, hub selection and
credential storage across updates.

### Publish Web updates from this repository

The [Mobile Web update workflow](../.github/workflows/mobile-web-update.yml)
validates relevant pull requests without publishing. After reviewed changes
reach `main`, it builds the native Web bundle, packages an immutable ZIP and
uploads it to the reserved `mobile-web` prerelease. Only after the upload is
confirmed does it advance `mobile-updates/latest.json`. This release is never
marked as GitHub's latest application release.

The workflow preserves other files on the feed branch and uses a non-forced
Git ref update. If another writer changes the branch, it re-reads that head;
superseded `main` builds cannot move the feed backwards. A `workflow_dispatch`
run on `main` can retry publication. The feed is created by the first successful
main-branch publish; opening a PR does not publish an update to devices.

The ordinary Web/PWA deployment continues producing its existing browser
bundle. This workflow makes a separate native-mode build with no service
worker. It does not build or release an APK/IPA, and needs no App Store signing
credentials or third-party update-service account.

### Package for a self-hosted feed

Configure your HTTPS `feedUrl` in `mobile/update.config.json` before building
the native app. The feed host must permit requests from the native origins
(`https://localhost` and `capacitor://localhost`). Then, from the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd web build:mobile
node mobile/scripts/package-update.mjs \
  --artifact-base-url https://updates.example.com/hapi/bundles/ \
  --output-dir mobile/dist/update
```

The script writes `<sha256>.zip` and `latest.json` locally; it does not upload
anything. Upload the immutable ZIP to the URL in the manifest first, then
atomically replace your configured feed with `latest.json`. Serve the manifest
with revalidation or `Cache-Control: no-cache`; the content-addressed ZIP can
use an immutable cache policy. Keep old immutable archives available so an
already downloaded manifest remains valid during publication.

Each manifest contains the Web release version plus Git revision, source commit
time, both native runtime identifiers, HTTPS archive URL, SHA-256 and byte size.
ZIP entries are sorted with normalized times and permissions, and unsafe paths
or symlinks are rejected. Archive size is limited to 120 MiB; the packaging
guard also rejects PWA/development bundles and missing entry assets. Use a new
source commit for a new release so its timestamp advances beyond the current
feed.

The checked-in GitHub publisher intentionally refuses a different feed URL.
When self-hosting, publish the local artifacts to your chosen host through your
own deployment pipeline; do not direct the app at arbitrary user-selected Hubs.

### Optional signed updates

The default feed trusts the fixed HTTPS publisher, with native SHA-256
verification of every downloaded ZIP. To pin a signing key as an additional
trust boundary, set `publicKey` in `mobile/update.config.json` to a PEM RSA public
key (`-----BEGIN PUBLIC KEY-----`) before building the app. Store the matching
private key outside the checkout.

For a signed self-hosted package:

```sh
HAPI_UPDATE_PRIVATE_KEY_PATH=/secure/path/hapi-update-private.pem \
  node mobile/scripts/package-update.mjs \
  --artifact-base-url https://updates.example.com/hapi/bundles/
```

The GitHub workflow reads the optional repository secret
`HAPI_UPDATE_PRIVATE_KEY` as PEM text. With a pinned public key, production
packaging fails if the private key is absent or does not match. The resulting
manifest adds a Base64 RSA-SHA256 signature over the ZIP bytes. The native
plugin verifies that signature in pinned-key mode; it uses the manifest's
checksum in default HTTPS mode. These are separate native verification modes,
not two concurrently enabled plugin options. SHA-256 remains in every manifest
as the immutable archive identity and is checked again by the publisher.

PR validation uses `--validate-only`, which needs no private key and writes
`candidate.json`, never a publishable `latest.json`. Release credentials are
only supplied to the main-branch packaging step. Changing the pinned key or
feed requires a native binary update because both are part of its trust and
compatibility configuration.

### Failed update recovery

Incomplete downloads and failed verification leave the current bundle active.
Activation remains a single local bundle switch. The native Live Update plugin
has automatic activation disabled, a 30-second startup readiness timeout and
automatic blocking of rolled-back bundles. A bundle that cannot start returns
to the app's bundled fallback. The Web UI acknowledges a healthy startup before
contacting a Hub or update feed, so offline use does not itself trigger a
rollback. Updating the native app also supplies a fresh fallback bundle and
native compatibility metadata.

## Connect a hub

The app uses the existing Web login: choose the hub's HTTPS URL and enter its
access token. A hub selected on a desktop browser is not automatically selected
inside the mobile app. Hub URLs remain application data and never become the
WebView's navigation origin. Plain HTTP is rejected by the mobile login and
Android's cleartext policy; iOS uses its default App Transport Security policy.

The packaged WebView has a different origin from a hosted Web page. The hub's
CORS allowlist must include the origins of the native platforms in use, along
with any existing trusted Web origins. For example:

```sh
CORS_ORIGINS='https://app.hapi.run,https://localhost,capacitor://localhost' hapi hub --relay
```

- Android origin: `https://localhost`.
- iOS origin: `capacitor://localhost`.

These are the app's local origins, not hub addresses. The phone still needs a
reachable HTTPS hub URL. The hub preserves an explicit origin allowlist; the
shell does not enable wildcard CORS, arbitrary WebView navigation or a native
HTTP bypass. Updated hub origin parsing is required for the iOS scheme.

The hub access token is stored per hub using iOS Keychain or AES-GCM encrypted
Android preferences backed by Android Keystore. Mobile storage failures do not
fall back to plaintext browser storage. Android backup and device transfer are
disabled so encrypted credentials cannot be restored without their device key.
Existing browser/PWA credential storage remains separate.

## Native attachment selection

The React attachment panel offers Photos and Files on native builds. Photos
opens Android's system Photo Picker or iOS PHPicker. Files opens Android's
system content chooser or iOS document picker, including the document providers
installed on the device. The operating system chooses the available provider
UI; an app cannot guarantee a particular OEM gallery or file manager.

Only selected files are exposed to the app. No broad storage or photo-library
permission is declared or requested. The picker returns a local WebView URL
and metadata; the Web adapter reads bytes without Base64 bridge payloads,
enforces the existing 50 MiB upload limit and feeds the existing attachment
preview/upload flow. Dismissing the picker leaves the draft unchanged, while
file-read errors remain visible.

Android selections are read through temporary content URI grants, without
copying or deleting the user's original file. On iOS the picker creates copies
in the application's cache directory, managed by the operating system. The
plugin exposes no explicit cache cleanup operation. Selection does not grant
persistent access to the whole library or document tree.

## Keyboard, safe areas and voice

The Keyboard plugin resizes the native WebView around the keyboard. Android
also uses `adjustResize` and the fullscreen resize workaround. Capacitor's
built-in SystemBars handling supplies compatible safe-area behavior for Android
WebView versions; the existing Web headers and composer retain ownership of
their safe-area padding. Android back navigation uses the official App plugin's
WebView history handling.

Existing Web dictation and voice features use `getUserMedia`. Android declares
the microphone permission and iOS includes its usage description; the system
asks for microphone access when recording starts. The shell does not request
microphone access on launch.

Native background push, notification actions and incoming share targets are
not implemented in this shell. Those features in the independent native
companions are not inherited by wrapping the Web app. The native build also
does not register the browser PWA service worker.

## Verification

```sh
# Native compatibility, packaging, publication and guard regressions
bun run --cwd mobile test

# Build the Web application and verify/sync both native projects
bun run build:mobile

# Web integration checks are run at the repository root
bun run typecheck:web
bun run test:web

# Validate an OTA artifact without release credentials or publication
node mobile/scripts/package-update.mjs --validate-only
```

Capacitor sync verifies asset copying and plugin discovery; it does not compile
Kotlin/Java or Swift. Android assembly/lint require the Android toolchain. iOS
compilation requires macOS/Xcode. Device acceptance includes login and restore,
Photos/Files selection and cancellation, oversized attachments, Chinese input
with the keyboard open, back navigation, rotation, background/foreground and
sign-out. Update acceptance also includes downloading while a conversation is
open, activating only on click, keeping a draft and credentials after reload,
offline startup, rejecting an incompatible native runtime and installing a new
native binary over an app that has already applied a Web update.

[`e2e/native-update.spec.ts`](../e2e/native-update.spec.ts) exercises the update
banner with simulated native bridge responses and a real browser reload. It
checks restored navigation, unsent composer text, IndexedDB attachments and a
verification failure followed by retry without early activation. It does not
run the native downloader or establish Android/iOS rollback behavior. On real
devices, also test a corrupt ZIP and signature/checksum rejection, terminate
the app before the new bundle reports readiness, confirm recovery to the
bundled fallback and verify compatibility after an in-place native app upgrade.

The [Capacitor mobile workflow](../.github/workflows/capacitor-mobile.yml) runs
the native asset build and sync, Android debug assembly/lint and an unsigned iOS
Simulator build for relevant pull requests. Its Android job uploads a debug APK
as a seven-day workflow artifact. It does not sign a release or deploy an app.

## Dependencies and references

Capacitor core/CLI/platform packages are pinned to 8.5.3. Runtime plugins are
listed in `mobile/package.json` for native discovery; plugins imported by React
are also declared in `web/package.json`. The repository's Bun lockfile owns
their JavaScript versions. `cap sync` generates native dependency declarations.

- [Capacitor environment requirements](https://capacitorjs.com/docs/getting-started/environment-setup)
- [Capacitor configuration](https://capacitorjs.com/docs/config)
- [File Picker API](https://capawesome.io/docs/sdks/capacitor/file-picker/)
- [Secure Storage plugin](https://github.com/aparajita/capacitor-secure-storage)
- [Keyboard API](https://capacitorjs.com/docs/apis/keyboard)
- [SystemBars API](https://capacitorjs.com/docs/apis/system-bars)
- [Live Update API](https://capawesome.io/docs/sdks/capacitor/live-update/)
