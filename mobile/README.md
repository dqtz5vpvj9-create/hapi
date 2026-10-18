# HAPI mobile shell

This Capacitor app packages the existing React application in `web/`. Chat,
workspaces, settings, rendering and attachment uploads continue to use the Web
implementation. Native plugins provide system file/photo selection, protected
credential storage, keyboard resizing and Android back navigation.

The shell lives in `mobile/android` and `mobile/ios`. The existing Kotlin client
in [`android/`](../android/README.md) and SwiftUI client in
[`ios/`](../ios/README.md) are independent applications. The shell's application
and bundle ID is `run.hapi.mobile`, so it can be installed alongside the native
companion. Launcher artwork is copied from the repository's existing HAPI icons.

## Build

Requirements:

- Node.js 22 or newer and the repository's Bun 1.4.0.
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
missing referenced assets. The app always loads the copied local bundle;
`capacitor.config.json` has no remote `server.url` or `allowNavigation` list.
The Web base URL must be `/`.

Generated Web assets, local SDK paths, build outputs and signing keys are
ignored. Native project source files are checked in. After Web changes, the
build/sync command must run again before building an APK or iOS app.

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

### iOS

```sh
bun run --cwd mobile open:ios

# Simulator build from the repository root; no distribution signing required
xcodebuild build -project mobile/ios/App/App.xcodeproj -scheme App \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
```

Xcode resolves the Capacitor runtime and plugin Swift packages. A physical
device or distribution build requires the maintainer's Apple signing team.

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
# Asset packaging guard regressions
bun run --cwd mobile test

# Build the Web application and verify/sync both native projects
bun run build:mobile

# Web integration checks are run at the repository root
bun run typecheck:web
bun run test:web
```

Capacitor sync verifies asset copying and plugin discovery; it does not compile
Kotlin/Java or Swift. Android assembly/lint require the Android toolchain. iOS
compilation requires macOS/Xcode. Device acceptance includes login and restore,
Photos/Files selection and cancellation, oversized attachments, Chinese input
with the keyboard open, back navigation, rotation, background/foreground and
sign-out. A passing desktop browser test cannot establish those native results.

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
