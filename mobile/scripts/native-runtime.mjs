import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const platforms = ['android', 'ios']
const generatedFiles = new Set([
    'mobile/android/app/capacitor.build.gradle',
    'mobile/android/capacitor.settings.gradle',
    'mobile/android/app/src/main/assets/capacitor.config.json',
    'mobile/android/app/src/main/assets/capacitor.plugins.json',
    'mobile/ios/App/App/capacitor.config.json',
    'mobile/ios/App/App/config.xml',
])
const ignoredDirectories = new Set([
    'node_modules', 'build', 'DerivedData', 'Pods', '.gradle', '.idea',
    'xcuserdata', 'project.xcworkspace', '__tests__', '__snapshots__', 'test', 'tests', 'androidTest',
])

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'))
}

function readUpdateSettings(root) {
    const settings = readJson(join(root, 'mobile/update.config.json'))
    if (typeof settings.feedUrl !== 'string') {
        throw new Error('mobile/update.config.json must contain a feedUrl.')
    }
    const url = new URL(settings.feedUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
        throw new Error('The mobile update feed must use HTTPS without credentials or a fragment.')
    }
    if (settings.publicKey !== undefined && typeof settings.publicKey !== 'string') {
        throw new Error('The mobile update publicKey must be a PEM string.')
    }
    const publicKey = settings.publicKey?.trim() ?? ''
    if (publicKey) {
        if (!publicKey.startsWith('-----BEGIN PUBLIC KEY-----') || createPublicKey(publicKey).asymmetricKeyType !== 'rsa') {
            throw new Error('The mobile update publicKey must be a PEM-encoded RSA public key.')
        }
    }
    return { feedUrl: url.href, publicKey }
}

function includeFile(path) {
    if (generatedFiles.has(path)) return false
    if (path.startsWith('mobile/android/app/src/main/assets/public/')) return false
    if (path.startsWith('mobile/ios/App/App/public/')) return false
    const segments = path.split('/')
    if (segments.some(segment => ignoredDirectories.has(segment))) return false
    const name = segments.at(-1)
    return name !== '.DS_Store' && !name.startsWith('.') && !/\.(?:md|test\.[^.]+|spec\.[^.]+)$/.test(name)
}

function collectFiles(root, path, files) {
    const fullPath = join(root, path)
    if (!existsSync(fullPath) || !includeFile(path)) return
    const stat = lstatSync(fullPath)
    if (stat.isSymbolicLink()) {
        throw new Error(`Native runtime inputs must not be symlinks: ${path}`)
    }
    if (stat.isDirectory()) {
        for (const entry of readdirSync(fullPath).sort()) {
            collectFiles(root, `${path}/${entry}`, files)
        }
    } else if (stat.isFile()) {
        files.push(path)
    }
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    }
    return value
}

function installedPackage(from, name, required = true) {
    // Resolve from each real package directory so isolated Bun installs and
    // ordinary hoisted node_modules produce the same dependency graph.
    for (let directory = from; ; directory = dirname(directory)) {
        const path = join(directory, 'node_modules', name, 'package.json')
        if (existsSync(path)) return dirname(realpathSync(path))
        if (dirname(directory) === directory) break
    }
    if (required) throw new Error(`Missing mobile dependency ${name}; run bun install before computing the native runtime.`)
}

function within(root, path) {
    const resolved = resolve(root, path)
    const local = relative(root, resolved)
    if (!local || local === '..' || local.startsWith(`..${sep}`)) {
        throw new Error(`Native dependency input must stay inside its package: ${path}`)
    }
    return resolved
}

function nativeDependencies(root, platform) {
    const manifest = readJson(join(root, 'mobile/package.json'))
    const lockPath = join(root, 'bun.lock')
    const parsed = ts.parseConfigFileTextToJson(lockPath, readFileSync(lockPath, 'utf8'))
    if (parsed.error || !parsed.config?.packages) throw new Error('A valid bun.lock is required to compute the native runtime.')
    const lock = parsed.config
    const oppositePlatform = `@capacitor/${platform === 'android' ? 'ios' : 'android'}`
    const relevant = entries => Object.fromEntries(Object.entries(entries ?? {})
        .filter(([name]) => name !== oppositePlatform).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    const declared = relevant(manifest.dependencies)
    // Capacitor also discovers plugins declared as devDependencies. Include
    // those by their real native metadata; CLI/TypeScript/test tooling is not a
    // native plugin and does not change the installed runtime contract.
    for (const [name, version] of Object.entries(manifest.devDependencies ?? {})) {
        const directory = installedPackage(join(root, 'mobile'), name, false)
        if (directory && readJson(join(directory, 'package.json')).capacitor?.[platform]) declared[name] = version
    }
    const records = new Set()
    const visitedLocks = new Set()
    const visitedPackages = new Set()
    const save = value => records.add(JSON.stringify(canonical(value)))

    function lockedPackage(name, parent, installed) {
        const candidates = []
        for (let scope = parent; scope; scope = scope.replace(/(?:^|\/)(?:@[^/]+\/)?[^/]+$/, '')) {
            candidates.push(`${scope}/${name}`)
        }
        candidates.push(name)
        const expected = installed && `${installed.name}@${installed.version}`
        const matches = entry => entry && (!expected || entry[0] === expected
            || entry[0]?.startsWith(`${installed.name}@workspace:`)
            || entry[0]?.startsWith(`${installed.name}@file:`)
            || entry[0]?.startsWith(`${installed.name}@link:`))
        let key = candidates.find(key => matches(lock.packages[key]))
        if (!key && expected) {
            // Hoisting keys can move when an unrelated Web dependency changes.
            // Accept an unambiguous matching resolution, never hash that key.
            const alternatives = Object.keys(lock.packages).filter(key => lock.packages[key][0] === expected)
            const resolutions = new Set(alternatives.map(key => JSON.stringify(canonical(lock.packages[key]))))
            if (resolutions.size === 1) key = alternatives.sort()[0]
        }
        if (!key) throw new Error(`No matching bun.lock resolution for ${expected ?? name}; run bun install.`)
        return key
    }

    function visitLock(key) {
        if (visitedLocks.has(key)) return
        visitedLocks.add(key)
        const entry = lock.packages[key]
        const info = { ...entry[2] }
        for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
            if (info[field]) info[field] = relevant(info[field])
        }
        const normalized = [...entry]
        if (entry.length > 2) normalized[2] = info
        const patch = lock.patchedDependencies?.[entry[0]]
        save({ resolution: normalized, patch: patch ? readFileSync(within(root, patch), 'utf8') : null })
        const optionalPeers = new Set(info.optionalPeers ?? [])
        const dependencies = {
            ...info.dependencies, ...info.optionalDependencies,
            ...Object.fromEntries(Object.entries(info.peerDependencies ?? {}).filter(([name]) => !optionalPeers.has(name))),
        }
        for (const name of Object.keys(dependencies).sort()) {
            const child = lockedPackage(name, key)
            save({ from: entry[0], dependency: name, to: lock.packages[child][0] })
            visitLock(child)
        }
    }

    function visitInstalled(name, from, parent) {
        if (name === oppositePlatform) return
        const directory = installedPackage(from, name)
        if (visitedPackages.has(directory)) return
        visitedPackages.add(directory)
        const dependency = readJson(join(directory, 'package.json'))
        if (!dependency.name || !dependency.version) throw new Error(`Invalid installed mobile dependency: ${name}`)
        const key = lockedPackage(name, parent, dependency)
        visitLock(key)
        const native = dependency.capacitor?.[platform]
        const files = []
        if (native) {
            const source = native.src ?? platform
            within(directory, source)
            collectFiles(directory, source, files)
            if (!files.length) throw new Error(`No ${platform} native sources found in ${name}.`)
            if (platform === 'ios') {
                for (const file of readdirSync(directory)) {
                    if (file === 'Package.swift' || file.endsWith('.podspec')) collectFiles(directory, file, files)
                }
            }
        }
        save({
            package: `${dependency.name}@${dependency.version}`,
            dependencies: relevant(dependency.dependencies),
            optionalDependencies: relevant(dependency.optionalDependencies),
            native: native ?? null,
            sources: [...new Set(files)].sort().map(path => [path.split(sep).join('/'), createHash('sha256').update(readFileSync(join(directory, path))).digest('hex')]),
        })
        // Optional dependencies are already covered by their lock resolutions
        // and patches above. Do not condition the hash on which host-specific
        // optional packages Bun happens to install on Linux versus macOS.
        const requiredPeers = Object.fromEntries(Object.entries(dependency.peerDependencies ?? {})
            .filter(([peer]) => !dependency.peerDependenciesMeta?.[peer]?.optional))
        const required = { ...requiredPeers, ...dependency.dependencies }
        for (const optional of Object.keys(dependency.optionalDependencies ?? {})) delete required[optional]
        for (const child of Object.keys(relevant(required))) visitInstalled(child, directory, key)
    }

    for (const name of Object.keys(declared).sort()) visitInstalled(name, join(root, 'mobile'), manifest.name)
    return { declared: canonical(declared), resolved: [...records].sort() }
}

/**
 * Compute compatibility from native inputs only. Generated cap-sync declarations
 * are represented by native plugin metadata, source and resolved dependencies
 * instead of machine-specific paths. Only the mobile dependency closure enters
 * the hash; unrelated Web lockfile changes do not invalidate native binaries.
 * A web-only release therefore retains the installed binary's runtime version.
 *
 * @param {string} root Repository root.
 * @param {'android' | 'ios'} platform
 * @returns {string}
 */
export function computeNativeRuntimeVersion(root, platform) {
    if (!platforms.includes(platform)) throw new Error(`Unsupported native platform: ${platform}`)
    const paths = platform === 'android'
        ? [
            'mobile/android/app/src/main', 'mobile/android/app/build.gradle',
            'mobile/android/app/proguard-rules.pro', 'mobile/android/build.gradle',
            'mobile/android/settings.gradle', 'mobile/android/gradle.properties',
            'mobile/android/variables.gradle', 'mobile/android/gradle',
        ]
        : ['mobile/ios/App/App', 'mobile/ios/App/App.xcodeproj', 'mobile/ios/debug.xcconfig']
    const files = []
    for (const path of paths) collectFiles(root, path, files)
    if (!files.length) throw new Error(`No ${platform} native runtime inputs were found.`)
    const hash = createHash('sha256')
    hash.update(`hapi-native-runtime-v1\0${platform}\0`)
    hash.update(JSON.stringify(nativeDependencies(root, platform)))
    hash.update('\0')
    hash.update(JSON.stringify(readUpdateSettings(root)))
    hash.update('\0')
    // The shared Capacitor config controls native plugins, origins and WebView
    // behavior. Its generated copy is deliberately excluded above.
    files.push('mobile/capacitor.config.ts')
    for (const path of files.sort()) {
        hash.update(relative(root, join(root, path)).split(sep).join('/'))
        hash.update('\0')
        hash.update(readFileSync(join(root, path)))
        hash.update('\0')
    }
    return hash.digest('hex')
}

/**
 * Shared by cap sync (compiled native metadata) and OTA publishing. The runtime
 * comes from native sources/configuration, never from the downloaded web bundle.
 *
 * @param {string} [root] Repository root, inferred from this module by default.
 * @returns {{feedUrl: string, publicKey: string, builtInBundleId: string, builtInCreatedAt: number, runtimes: {android: string, ios: string}}}
 */
export function resolveNativeUpdateConfig(root = repositoryRoot) {
    root = resolve(root)
    const settings = readUpdateSettings(root)
    const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const seconds = Number(execFileSync('git', ['-C', root, 'show', '-s', '--format=%ct', 'HEAD'], { encoding: 'utf8' }).trim())
    if (!/^[a-f\d]{40,64}$/.test(revision) || !Number.isSafeInteger(seconds) || seconds <= 0) {
        throw new Error('A valid Git commit is required to identify the built-in mobile bundle.')
    }
    return {
        ...settings,
        builtInBundleId: revision,
        builtInCreatedAt: seconds * 1000,
        runtimes: {
            android: computeNativeRuntimeVersion(root, 'android'),
            ios: computeNativeRuntimeVersion(root, 'ios'),
        },
    }
}
