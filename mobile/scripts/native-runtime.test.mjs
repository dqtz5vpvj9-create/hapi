import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { computeNativeRuntimeVersion, resolveNativeUpdateConfig } from './native-runtime.mjs'

const defaultFeed = 'https://raw.githubusercontent.com/dqtz5vpvj9-create/hapi/mobile-updates/latest.json'

function write(root, path, content) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
}

function changeLock(root, update) {
    const path = join(root, 'bun.lock')
    const lock = JSON.parse(readFileSync(path, 'utf8'))
    update(lock)
    writeFileSync(path, JSON.stringify(lock))
}

function installDependency(root, name, version, metadata = {}) {
    write(root, `mobile/node_modules/${name}/package.json`, JSON.stringify({ name, version, ...metadata }))
    changeLock(root, lock => {
        lock.packages[name] = [`${name}@${version}`, '', { dependencies: metadata.dependencies ?? {} }, `sha512-fixture-${name}-${version}`]
    })
}

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'hapi-native-runtime-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    write(root, 'mobile/update.config.json', JSON.stringify({ feedUrl: defaultFeed, publicKey: '' }))
    write(root, 'mobile/capacitor.config.ts', 'export default { appId: "run.hapi.mobile" }\n')
    write(root, 'mobile/package.json', JSON.stringify({
        version: '0.1.0',
        scripts: { test: 'node --test scripts/*.test.mjs' },
        dependencies: {
            '@capacitor/core': '8.5.3',
            '@capacitor/android': '8.5.3',
            '@capacitor/ios': '8.5.3',
            '@capacitor/app': '8.1.2',
            '@capawesome/capacitor-live-update': '8.7.0',
        },
    }))
    write(root, 'mobile/android/app/src/main/AndroidManifest.xml', '<manifest package="run.hapi.mobile"/>\n')
    write(root, 'mobile/ios/App/App/Info.plist', '<plist version="1.0"><dict/></plist>\n')
    write(root, 'bun.lock', '{"lockfileVersion":1,"packages":{}}')
    const manifest = JSON.parse(readFileSync(join(root, 'mobile/package.json'), 'utf8'))
    for (const [name, version] of Object.entries(manifest.dependencies)) installDependency(root, name, version)
    execFileSync('git', ['-C', root, 'init', '-q'])
    execFileSync('git', ['-C', root, 'add', '.'])
    execFileSync('git', ['-C', root, '-c', 'user.name=HAPI tests', '-c', 'user.email=tests@example.invalid', 'commit', '-qm', 'native fixture'], {
        env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' },
    })
    return root
}

function changeDependency(root, name, version) {
    const path = join(root, 'mobile/package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    manifest.dependencies[name] = version
    writeFileSync(path, JSON.stringify(manifest))
    installDependency(root, name, version)
}

test('a web-only release changes provenance without invalidating the native runtime', t => {
    const root = fixture(t)
    const original = resolveNativeUpdateConfig(root)
    write(root, 'web/src/App.tsx', 'export const newWebFeature = true\n')
    write(root, 'web/package.json', '{"dependencies":{"react":"99.0.0"}}\n')
    changeLock(root, lock => { lock.packages.react = ['react@99.0.0', '', {}, 'sha512-new-web-only-resolution'] })
    execFileSync('git', ['-C', root, 'add', '.'])
    execFileSync('git', ['-C', root, '-c', 'user.name=HAPI tests', '-c', 'user.email=tests@example.invalid', 'commit', '-qm', 'web release'], {
        env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-03T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-03T03:04:05Z' },
    })
    const next = resolveNativeUpdateConfig(root)
    assert.deepEqual(next.runtimes, original.runtimes)
    assert.notEqual(next.builtInBundleId, original.builtInBundleId)
    assert.equal(next.builtInCreatedAt - original.builtInCreatedAt, 86400000)
    assert.equal(next.feedUrl, defaultFeed)
})

test('native source changes invalidate only their target platform', t => {
    const root = fixture(t)
    const original = resolveNativeUpdateConfig(root)
    write(root, 'mobile/android/app/src/main/java/run/hapi/mobile/FilesPlugin.java', 'class FilesPlugin {}\n')
    const androidChange = resolveNativeUpdateConfig(root)
    assert.notEqual(androidChange.runtimes.android, original.runtimes.android)
    assert.equal(androidChange.runtimes.ios, original.runtimes.ios)
    write(root, 'mobile/ios/App/App/FilesPlugin.swift', 'class FilesPlugin {}\n')
    const iosChange = resolveNativeUpdateConfig(root)
    assert.equal(iosChange.runtimes.android, androidChange.runtimes.android)
    assert.notEqual(iosChange.runtimes.ios, androidChange.runtimes.ios)
})

test('platform dependency updates remain separate and shared native plugins affect both', t => {
    const root = fixture(t)
    const original = resolveNativeUpdateConfig(root)
    changeDependency(root, '@capacitor/android', '8.5.4')
    const androidChange = resolveNativeUpdateConfig(root)
    assert.notEqual(androidChange.runtimes.android, original.runtimes.android)
    assert.equal(androidChange.runtimes.ios, original.runtimes.ios)
    changeDependency(root, '@capacitor/ios', '8.5.4')
    const iosChange = resolveNativeUpdateConfig(root)
    assert.equal(iosChange.runtimes.android, androidChange.runtimes.android)
    assert.notEqual(iosChange.runtimes.ios, androidChange.runtimes.ios)
    changeDependency(root, '@capawesome/capacitor-live-update', '8.7.1')
    const pluginChange = resolveNativeUpdateConfig(root)
    assert.notEqual(pluginChange.runtimes.android, iosChange.runtimes.android)
    assert.notEqual(pluginChange.runtimes.ios, iosChange.runtimes.ios)
})

test('copied web resources, generated plugin declarations, docs, tests and build output are excluded', t => {
    const root = fixture(t)
    const original = resolveNativeUpdateConfig(root).runtimes
    for (const path of [
        'mobile/android/app/src/main/assets/public/index.html',
        'mobile/android/app/src/main/assets/capacitor.config.json',
        'mobile/android/app/src/main/assets/capacitor.plugins.json',
        'mobile/android/app/capacitor.build.gradle',
        'mobile/android/capacitor.settings.gradle',
        'mobile/android/app/src/test/java/PluginTest.java',
        'mobile/android/app/build/intermediates/config.json',
        'mobile/ios/App/App/public/index.html',
        'mobile/ios/App/App/capacitor.config.json',
        'mobile/ios/App/App/config.xml',
        'mobile/ios/App/CapApp-SPM/Package.swift',
        'mobile/ios/App/App/Plugin.test.swift',
        'mobile/ios/App/App/README.md',
        'mobile/ios/App/App.xcodeproj/xcuserdata/local.xcuserstate',
    ]) write(root, path, `machine-specific/generated data: ${path}\n`)
    const manifest = JSON.parse(readFileSync(join(root, 'mobile/package.json'), 'utf8'))
    manifest.version = '0.2.0'
    manifest.scripts.test = 'a new test command'
    manifest.devDependencies = { vitest: '5.0.5' }
    installDependency(root, '@capacitor/cli', '8.9.9')
    installDependency(root, 'typescript', '99.0.0')
    manifest.devDependencies['@capacitor/cli'] = '8.9.9'
    manifest.devDependencies.typescript = '99.0.0'
    write(root, 'mobile/package.json', JSON.stringify(manifest, null, 4))
    assert.deepEqual(resolveNativeUpdateConfig(root).runtimes, original)
})

test('custom plugins are discovered by native metadata and fingerprint platform source content', t => {
    const root = fixture(t)
    const original = resolveNativeUpdateConfig(root).runtimes
    changeDependency(root, 'our-files-plugin', '1.0.0')
    installDependency(root, 'our-files-plugin', '1.0.0', {
        capacitor: { android: { src: 'native/android' }, ios: { src: 'native/ios' } },
    })
    write(root, 'mobile/node_modules/our-files-plugin/native/android/FilesPlugin.java', 'class FilesPlugin {}\n')
    write(root, 'mobile/node_modules/our-files-plugin/native/ios/FilesPlugin.swift', 'class FilesPlugin {}\n')
    const installed = resolveNativeUpdateConfig(root).runtimes
    assert.notEqual(installed.android, original.android)
    assert.notEqual(installed.ios, original.ios)
    write(root, 'mobile/node_modules/our-files-plugin/native/android/FilesPlugin.java', 'class FilesPlugin { boolean albums = true; }\n')
    const nativeChange = resolveNativeUpdateConfig(root).runtimes
    assert.notEqual(nativeChange.android, installed.android)
    assert.equal(nativeChange.ios, installed.ios)
    write(root, 'mobile/node_modules/our-files-plugin/dist/definitions.d.ts', 'generated declarations\n')
    write(root, 'mobile/node_modules/our-files-plugin/native/android/build/output', 'generated native build output\n')
    write(root, 'mobile/node_modules/our-files-plugin/native/ios/README.md', 'new documentation\n')
    assert.deepEqual(resolveNativeUpdateConfig(root).runtimes, nativeChange)
})

test('transitive resolutions and relevant patch contents invalidate the native runtime', t => {
    const root = fixture(t)
    installDependency(root, '@capawesome/capacitor-live-update', '8.7.0', { dependencies: { 'native-support': '^1.0.0' } })
    installDependency(root, 'native-support', '1.0.0')
    const original = resolveNativeUpdateConfig(root).runtimes
    installDependency(root, 'native-support', '1.0.1')
    const upgraded = resolveNativeUpdateConfig(root).runtimes
    assert.notEqual(upgraded.android, original.android)
    assert.notEqual(upgraded.ios, original.ios)
    changeLock(root, lock => { lock.packages['native-support'][3] = 'sha512-changed-archive' })
    const repacked = resolveNativeUpdateConfig(root).runtimes
    assert.notEqual(repacked.android, upgraded.android)
    assert.notEqual(repacked.ios, upgraded.ios)
    changeLock(root, lock => { lock.patchedDependencies = { 'native-support@1.0.1': 'patches/native-support.patch' } })
    write(root, 'patches/native-support.patch', 'native bug fix\n')
    const patched = resolveNativeUpdateConfig(root).runtimes
    assert.notEqual(patched.android, repacked.android)
    assert.notEqual(patched.ios, repacked.ios)
    write(root, 'patches/native-support.patch', 'a different native bug fix\n')
    assert.notDeepEqual(resolveNativeUpdateConfig(root).runtimes, patched)
})

test('Web lock changes, patch changes and hoisting-key relocation stay outside the native contract', t => {
    const root = fixture(t)
    installDependency(root, '@capawesome/capacitor-live-update', '8.7.0', { dependencies: { 'native-support': '^1.0.0' } })
    installDependency(root, 'native-support', '1.0.0')
    const original = resolveNativeUpdateConfig(root).runtimes
    changeLock(root, lock => {
        lock.packages['@capawesome/capacitor-live-update/native-support'] = lock.packages['native-support']
        delete lock.packages['native-support']
        lock.packages.react = ['react@99.0.0', '', {}, 'sha512-web']
        lock.patchedDependencies = { 'react@99.0.0': 'patches/react.patch' }
    })
    write(root, 'patches/react.patch', 'Web-only behavior\n')
    assert.deepEqual(resolveNativeUpdateConfig(root).runtimes, original)
    write(root, 'patches/react.patch', 'Different Web-only behavior\n')
    assert.deepEqual(resolveNativeUpdateConfig(root).runtimes, original)
})

test('native fingerprints are independent of absolute checkout locations and lock formatting', t => {
    const root = fixture(t)
    const original = resolveNativeUpdateConfig(root).runtimes
    const otherRoot = mkdtempSync(join(tmpdir(), 'hapi-native-runtime-moved-'))
    t.after(() => rmSync(otherRoot, { recursive: true, force: true }))
    cpSync(root, otherRoot, { recursive: true })
    const lock = JSON.parse(readFileSync(join(otherRoot, 'bun.lock'), 'utf8'))
    lock.packages = Object.fromEntries(Object.entries(lock.packages).reverse())
    // Bun uses JSON with trailing commas; parse the real format without
    // evaluating JavaScript or depending on whitespace/property ordering.
    write(otherRoot, 'bun.lock', JSON.stringify(lock, null, 2).replace(/\n}$/, ',\n}\n'))
    assert.deepEqual(resolveNativeUpdateConfig(otherRoot).runtimes, original)
})

test('missing or inconsistent installed dependencies fail closed', t => {
    const root = fixture(t)
    rmSync(join(root, 'mobile/node_modules/@capacitor/core'), { recursive: true })
    assert.throws(() => resolveNativeUpdateConfig(root), /Missing mobile dependency @capacitor\/core/)
    write(root, 'mobile/node_modules/@capacitor/core/package.json', '{"name":"@capacitor/core","version":"99.0.0"}')
    assert.throws(() => resolveNativeUpdateConfig(root), /No matching bun.lock resolution/)
})

test('native origin, feed and signature trust changes require a matching native runtime', t => {
    const root = fixture(t)
    const original = resolveNativeUpdateConfig(root).runtimes
    write(root, 'mobile/capacitor.config.ts', 'export default { server: { hostname: "new-native-origin" } }\n')
    const changedOrigin = resolveNativeUpdateConfig(root).runtimes
    assert.notEqual(changedOrigin.android, original.android)
    assert.notEqual(changedOrigin.ios, original.ios)
    const { publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    write(root, 'mobile/update.config.json', JSON.stringify({ feedUrl: 'https://updates.example.invalid/latest.json', publicKey }))
    const next = resolveNativeUpdateConfig(root)
    assert.notEqual(next.runtimes.android, changedOrigin.android)
    assert.notEqual(next.runtimes.ios, changedOrigin.ios)
    assert.equal(next.publicKey, publicKey.trim())
})

test('invalid feed or key configuration fails before producing a native build contract', t => {
    const root = fixture(t)
    for (const feedUrl of ['http://updates.example.invalid/latest.json', 'https://user:secret@example.invalid/latest.json', 'https://example.invalid/latest.json#fragment']) {
        write(root, 'mobile/update.config.json', JSON.stringify({ feedUrl }))
        assert.throws(() => resolveNativeUpdateConfig(root), /HTTPS without credentials or a fragment/)
    }
    write(root, 'mobile/update.config.json', JSON.stringify({ feedUrl: defaultFeed, publicKey: true }))
    assert.throws(() => resolveNativeUpdateConfig(root), /PEM string/)
    write(root, 'mobile/update.config.json', JSON.stringify({ feedUrl: defaultFeed, publicKey: 'untrusted-key' }))
    assert.throws(() => resolveNativeUpdateConfig(root), /PEM-encoded RSA/)
    assert.throws(() => computeNativeRuntimeVersion(root, 'web'), /Unsupported native platform/)
})
