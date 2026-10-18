# HAPI mobile shell

The Capacitor app opens the deployed HAPI website configured in
`site.config.json`. The website supplies HTML, JavaScript, CSS, chat, workspaces
and settings. The APK does not contain a separate copy of the chat frontend.
Web releases use the website's existing deployment and update flow; only native
code or plugin changes require a new APK/IPA.

The native shell adds file/photo selection, protected credential storage,
keyboard handling and Android back navigation. Native adapters live in `web/`
and run only when Capacitor is present. Browser users use the same React UI.
The application ID is `run.hapi.mobile`.

## Website configuration

The default deployment is `https://hapi.tail.lixinrui000.cn`. To build for another
deployment, edit `site.config.json` or set `HAPI_MOBILE_SITE_URL` while syncing:

```sh
HAPI_MOBILE_SITE_URL=https://your-hapi.example bun run build:mobile
```

Use an HTTPS origin without a path, credentials or query string. This address
selects the actual website, not just its API. Capacitor restricts the native
bridge to that configured origin; there is no wildcard navigation permission.
External links open outside the app. The configured website is trusted to call
the native APIs, so only use a deployment you control.

The local `shell/` contains only connection/error pages. It never falls back to
an older chat UI. The former GitHub ZIP updater is not registered in this shell.
Its scripts remain for maintaining older installed local-bundle shells.

The website must include the native Web adapters to use secure credential
storage and the dedicated photo/file buttons. Without them it still renders
the deployed Web UI, using Capacitor's normal WebView file-input handling.
The website and browser share their ordinary service-worker update mechanism;
updates are offered without interrupting an active conversation.

## Build

Use Node.js 22+, Bun 1.4.0, JDK 21 and Android SDK 36. Android uses Gradle 8.14.3
and AGP 8.13.0, with minimum API 24. iOS requires macOS with Xcode 26+.

```sh
bun install --frozen-lockfile
bun run build:mobile
cd mobile/android
HAPI_ANDROID_KEYSTORE_PATH="$HOME/.local/share/hapi-mobile/signing/hapi-android.keystore" \
  ./gradlew :app:assembleDebug :app:lintDebug
```

`build:mobile` syncs the small hosted shell and plugins. It does not build or
copy `web/dist`. The APK is at
`mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

For an unsigned iOS Simulator build:

```sh
xcodebuild build -project mobile/ios/App/App.xcodeproj -scheme App \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
```

Physical iOS distribution requires the maintainer's Apple signing team.

## Persistent Android signing

CI and local APKs use the existing local installation's signing identity.
`HAPI_ANDROID_KEYSTORE_BASE64` is the repository secret containing that keystore.
Trusted main/manual CI runs restore it to a private temporary file, explicitly
pass its path to Gradle through `HAPI_ANDROID_KEYSTORE_PATH`, verify the finished
APK against `android-signing-cert.pem`, then remove the temporary key. Missing
credentials or a different signer fail publication. Pull requests compile and
lint without the persistent key and do not publish an installable APK.

The maintained local copy is
`${XDG_DATA_HOME:-$HOME/.local/share}/hapi-mobile/signing/hapi-android.keystore`.
A backup is in the adjacent `signing-backup` directory. Both directories are
owner-only and key files have mode `0600`. Do not replace the key or generate a
new one for CI. The alias and passwords are Android's standard debug values.
Never commit the keystore or publish it as an artifact. The checked-in PEM
contains only the public certificate.

## Native viewport and data

On Android the shell keeps system bars, display cutouts and the keyboard outside
the Web viewport. The website retains its ordinary single-row toolbar layout.
Native secure storage uses Keychain on iOS and Android Keystore-backed encrypted
preferences. Android backup and device transfer remain disabled.

After upgrading from the old local-origin shell, the website has a separate Web
storage origin. Existing local-origin data is retained; sign in to the website
once if its login is not already available. No chat history is stored in the APK.

## Verification

```sh
bun run --cwd mobile test
bun run build:mobile
bun run typecheck:web
```

Android assembly and lint, iOS Simulator compilation, and the APK certificate
check run in `.github/workflows/capacitor-mobile.yml`. Device acceptance includes
verifying the loaded origin and script URLs match the configured deployment,
checking top/bottom insets and keyboard behavior, native attachment selection,
login restore and updates from a new website deployment without reinstalling.
