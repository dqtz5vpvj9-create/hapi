import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { packageNativeUpdate } from './package-update.mjs'

const temporaryRoots = []
const source = Buffer.from('export const greeting = "你好，HAPI"\n')
const keyPair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const sourceTimestamp = 1_790_000_000_000

async function fixture({ publicKey = '' } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hapi-update-package-'))
    temporaryRoots.push(root)
    const files = {
        'mobile/update.config.json': JSON.stringify({ feedUrl: 'https://updates.example/latest.json', publicKey }),
        'mobile/package.json': JSON.stringify({ dependencies: { '@capacitor/core': '8.5.3' } }),
        'mobile/node_modules/@capacitor/core/package.json': JSON.stringify({ name: '@capacitor/core', version: '8.5.3' }),
        'bun.lock': JSON.stringify({ lockfileVersion: 1, packages: { '@capacitor/core': ['@capacitor/core@8.5.3', '', {}, 'sha512-fixture'] } }),
        'mobile/capacitor.config.ts': 'export default {}\n',
        'mobile/android/app/src/main/AndroidManifest.xml': '<manifest />\n',
        'mobile/ios/App/App/Info.plist': '<plist />\n',
        'shared/src/buildInfo.ts': "export const APP_VERSION = '0.30.7'\n",
        'web/dist/index.html': '<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css"></head><body><script type="module" src="/assets/app.js"></script></body></html>',
        'web/dist/assets/app.js': source,
        'web/dist/assets/app.css': 'body { color: #123 }',
        'web/dist/assets/empty.dat': Buffer.alloc(0),
    }
    for (const [filename, contents] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, filename)), { recursive: true })
        await writeFile(path.join(root, filename), contents)
    }
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['-c', 'user.name=Update Test', '-c', 'user.email=update-test@example.invalid', 'commit', '-qm', 'Test update source'], {
        cwd: root,
        env: { ...process.env, GIT_AUTHOR_DATE: `${sourceTimestamp / 1000} +0000`, GIT_COMMITTER_DATE: `${sourceTimestamp / 1000} +0000` },
    })
    return root
}

const settings = root => ({ root, artifactBase: 'https://updates.example/immutable', environment: {} })

afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('packages an extractable native bundle and publishes metadata for the exact immutable bytes', async () => {
    const root = await fixture()
    const result = await packageNativeUpdate(settings(root))
    const archive = await readFile(result.archivePath)
    const checksum = createHash('sha256').update(archive).digest('hex')
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'))
    assert.deepEqual(manifest, result.manifest)
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.bundleId, checksum)
    assert.equal(manifest.sha256, checksum)
    assert.equal(manifest.size, archive.length)
    assert.equal(manifest.createdAt, sourceTimestamp)
    assert.match(manifest.version, /^0\.30\.7\+[a-f0-9]{12}$/u)
    assert.match(manifest.runtimes.android, /^[a-f0-9]{64}$/u)
    assert.match(manifest.runtimes.ios, /^[a-f0-9]{64}$/u)
    assert.equal(manifest.url, `https://updates.example/immutable/${checksum}.zip`)
    assert.equal('signature' in manifest, false)
    assert.equal('validationOnly' in manifest, false)
    assert.equal(path.basename(result.archivePath), `${checksum}.zip`)
    const entries = execFileSync('unzip', ['-Z', '-1', result.archivePath], { encoding: 'utf8' }).trim().split('\n')
    assert.deepEqual(entries, ['assets/app.css', 'assets/app.js', 'assets/empty.dat', 'index.html'])
    assert.deepEqual(execFileSync('unzip', ['-p', result.archivePath, 'assets/app.js']), source)
    assert.deepEqual(execFileSync('unzip', ['-p', result.archivePath, 'assets/empty.dat']), Buffer.alloc(0))
    assert.equal((await readdir(path.dirname(result.archivePath))).some(name => name.startsWith('.package-')), false)
})

test('ignores filesystem timestamps but gives changed Web bytes a different bundle identity', async () => {
    const root = await fixture()
    const first = await packageNativeUpdate(settings(root))
    await utimes(path.join(root, 'web/dist/assets/app.js'), new Date(), new Date())
    const second = await packageNativeUpdate({ ...settings(root), outputDir: 'mobile/dist/repeated' })
    assert.deepEqual(await readFile(first.archivePath), await readFile(second.archivePath))
    assert.equal(first.manifest.bundleId, second.manifest.bundleId)
    await writeFile(path.join(root, 'web/dist/assets/app.js'), 'export const changed = true\n')
    const changed = await packageNativeUpdate({ ...settings(root), outputDir: 'mobile/dist/changed' })
    assert.notEqual(changed.manifest.bundleId, first.manifest.bundleId)
    assert.deepEqual(changed.manifest.runtimes, first.manifest.runtimes)
})

test('signs the ZIP bytes with the pinned key and detects tampering through that signature', async () => {
    const root = await fixture({ publicKey: keyPair.publicKey })
    const result = await packageNativeUpdate({ ...settings(root), environment: { HAPI_UPDATE_PRIVATE_KEY: keyPair.privateKey } })
    const bytes = await readFile(result.archivePath)
    const signature = Buffer.from(result.manifest.signature, 'base64')
    assert.equal(verify('RSA-SHA256', bytes, keyPair.publicKey, signature), true)
    bytes[bytes.length - 1] ^= 1
    assert.equal(verify('RSA-SHA256', bytes, keyPair.publicKey, signature), false)
})

test('accepts a private-key file and refuses missing, mismatched or unpinned signing keys', async () => {
    const root = await fixture({ publicKey: keyPair.publicKey })
    await assert.rejects(packageNativeUpdate(settings(root)), /unsigned updates are not allowed/u)
    const other = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
    await assert.rejects(packageNativeUpdate({ ...settings(root), environment: { HAPI_UPDATE_PRIVATE_KEY: other.privateKey } }), /does not match/u)
    const keyPath = path.join(root, 'signing-key.pem')
    await writeFile(keyPath, keyPair.privateKey, { mode: 0o600 })
    const result = await packageNativeUpdate({ ...settings(root), environment: { HAPI_UPDATE_PRIVATE_KEY_PATH: keyPath } })
    assert.equal(typeof result.manifest.signature, 'string')
    const unpinned = await fixture()
    await assert.rejects(packageNativeUpdate({ ...settings(unpinned), environment: { HAPI_UPDATE_PRIVATE_KEY: keyPair.privateKey } }), /requires publicKey/u)
})

test('validation-only PR packaging requires no private key and never produces a publishable latest.json', async () => {
    const root = await fixture({ publicKey: keyPair.publicKey })
    const result = await packageNativeUpdate({ ...settings(root), validationOnly: true })
    assert.equal(path.basename(result.manifestPath), 'candidate.json')
    assert.equal(result.manifest.validationOnly, true)
    assert.equal(result.manifest.signatureRequired, true)
    assert.equal('signature' in result.manifest, false)
    await assert.rejects(lstat(path.join(path.dirname(result.manifestPath), 'latest.json')), { code: 'ENOENT' })
})

test('refuses PWA and incomplete builds without emitting update metadata', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'web/dist/sw.js'), 'self.skipWaiting()')
    await assert.rejects(packageNativeUpdate(settings(root)), /contains PWA asset/u)
    await rm(path.join(root, 'web/dist/sw.js'))
    await rm(path.join(root, 'web/dist/assets/app.js'))
    await assert.rejects(packageNativeUpdate(settings(root)), /missing referenced asset/u)
    await assert.rejects(lstat(path.join(root, 'mobile/dist/update/latest.json')), { code: 'ENOENT' })
})

test('refuses symlinks and ambiguous archive paths before packaging', async () => {
    const root = await fixture()
    await symlink(path.join(root, 'shared/src/buildInfo.ts'), path.join(root, 'web/dist/linked.txt'))
    await assert.rejects(packageNativeUpdate(settings(root)), /symbolic links/u)
    await rm(path.join(root, 'web/dist/linked.txt'))
    for (const name of ['bad\\path.txt', 'line\nbreak.txt', '.env', 'C:drive.txt']) {
        await writeFile(path.join(root, 'web/dist', name), 'not a valid portable archive path')
        await assert.rejects(packageNativeUpdate(settings(root)), /Unsupported native bundle path/u)
        await rm(path.join(root, 'web/dist', name))
    }
})

test('requires a clean HTTPS artifact base and rejects output inside the bundle', async () => {
    const root = await fixture()
    for (const artifactBase of ['http://updates.example/', 'https://user:secret@updates.example/', 'https://updates.example/?redirect=yes', 'https://updates.example/#fragment', '/updates']) {
        await assert.rejects(packageNativeUpdate({ ...settings(root), artifactBase }), /HTTPS/u)
    }
    await assert.rejects(packageNativeUpdate({ ...settings(root), outputDir: 'web/dist/updates' }), /outside web\/dist/u)
})

test('rejects an oversized extracted bundle before copying or compressing its files', async () => {
    const root = await fixture()
    const oversized = path.join(root, 'web/dist/oversized.dat')
    await writeFile(oversized, '')
    await truncate(oversized, 512 * 1024 * 1024 + 1)
    await assert.rejects(packageNativeUpdate(settings(root)), /exceeds the 512 MiB/u)
    await assert.rejects(lstat(path.join(root, 'mobile/dist/update/latest.json')), { code: 'ENOENT' })
})
