import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveNativeUpdateConfig } from './native-runtime.mjs'

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(mobileRoot, '..')

test('the actual Capacitor config packages immutable runtime metadata and manual update settings', () => {
    // Exercise Capacitor's own TS config loader: its CommonJS/ESM path differs
    // from importing the helper directly, and this is what cap sync will use.
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { createRequire } from 'node:module';
        const require = createRequire(process.cwd() + '/package.json');
        const { loadConfig } = require('@capacitor/cli/dist/config.js');
        const config = await loadConfig();
        process.stdout.write(JSON.stringify(config.app.extConfig));
    `], { cwd: mobileRoot, encoding: 'utf8' })
    const config = JSON.parse(output)
    assert.deepEqual(config.plugins.HapiUpdates, resolveNativeUpdateConfig(repositoryRoot))
    assert.match(config.plugins.HapiUpdates.runtimes.android, /^[a-f\d]{64}$/)
    assert.match(config.plugins.HapiUpdates.runtimes.ios, /^[a-f\d]{64}$/)
    assert.equal(config.plugins.LiveUpdate.autoUpdateStrategy, 'none')
    assert.equal(config.plugins.LiveUpdate.autoDeleteBundles, false)
    assert.equal(config.plugins.LiveUpdate.autoBlockRolledBackBundles, true)
    assert.equal(config.plugins.LiveUpdate.readyTimeout, 30000)
    assert.equal(config.plugins.LiveUpdate.publicKey ?? '', config.plugins.HapiUpdates.publicKey)
    assert.equal(config.server.url, undefined)
    assert.equal(config.server.cleartext, false)
    assert.equal(config.android.allowMixedContent, false)
    assert.equal(config.webDir, '../web/dist')
})

test('both native entry points register the compiled metadata provider before Web JavaScript runs', () => {
    const read = path => readFileSync(resolve(mobileRoot, path), 'utf8')
    const activity = read('android/app/src/main/java/run/hapi/mobile/MainActivity.java')
    assert.ok(activity.indexOf('registerPlugin(HapiUpdatesPlugin.class)') < activity.indexOf('super.onCreate('))
    assert.match(activity, /registerPlugin\(HapiUpdatesPlugin\.class\)/)
    const androidPlugin = read('android/app/src/main/java/run/hapi/mobile/HapiUpdatesPlugin.java')
    assert.match(androidPlugin, /@CapacitorPlugin\(name = "HapiUpdates"\)/)
    assert.match(androidPlugin, /config\.getString\("runtimes\.android"\)/)

    const storyboard = read('ios/App/App/Base.lproj/Main.storyboard')
    assert.match(storyboard, /customClass="HapiBridgeViewController"[^>]*customModule="App"/)
    const controller = read('ios/App/App/HapiBridgeViewController.swift')
    assert.match(controller, /override func capacitorDidLoad\(\)/)
    assert.match(controller, /registerPluginInstance\(HapiUpdatesPlugin\(\)\)/)
    const iosPlugin = read('ios/App/App/HapiUpdatesPlugin.swift')
    assert.match(iosPlugin, /jsName = "HapiUpdates"/)
    assert.match(iosPlugin, /config\.getString\("runtimes\.ios"\)/)
    const project = read('ios/App/App.xcodeproj/project.pbxproj')
    assert.match(project, /HapiUpdatesPlugin\.swift in Sources/)
    assert.match(project, /HapiBridgeViewController\.swift in Sources/)
    assert.match(project, /PrivacyInfo\.xcprivacy in Resources/)
    assert.match(read('ios/App/App/PrivacyInfo.xcprivacy'), /NSPrivacyAccessedAPICategoryUserDefaults/)
    assert.match(read('ios/App/App/PrivacyInfo.xcprivacy'), /CA92\.1/)
})
