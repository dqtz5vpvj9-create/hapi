import { execFileSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile, chmod } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkNativeWebBundle } from './check-web-bundle.mjs'
import { resolveNativeUpdateConfig } from './native-runtime.mjs'

const defaultRoot = fileURLToPath(new URL('../..', import.meta.url))
export const DEFAULT_ARTIFACT_BASE_URL = 'https://github.com/dqtz5vpvj9-create/hapi/releases/download/mobile-web/'
export const MAX_UPDATE_BYTES = 120 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024
const MAX_FILES = 60_000

function artifactBaseUrl(value) {
    let url
    try {
        url = new URL(value)
    } catch {
        throw new Error('The artifact base URL must be an absolute HTTPS URL.')
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('The artifact base URL must use HTTPS without credentials, a query or a fragment.')
    }
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    return url
}

async function listBundleFiles(directory, relativeDirectory = '', files = []) {
    const entries = await readdir(path.join(directory, relativeDirectory), { withFileTypes: true })
    for (const entry of entries) {
        // ZIP entry names must have the same interpretation on Android, iOS and
        // the build host. Newlines would also be interpreted by zip's file list.
        if (entry.name.startsWith('.') || /[\\:\x00-\x1f\x7f]/u.test(entry.name)) {
            throw new Error(`Unsupported native bundle path: ${path.join(relativeDirectory, entry.name)}.`)
        }
        const relativeFile = path.posix.join(relativeDirectory, entry.name)
        const file = path.join(directory, relativeFile)
        const info = await lstat(file)
        if (info.isSymbolicLink()) {
            throw new Error(`Native bundle must not contain symbolic links: ${relativeFile}.`)
        }
        if (info.isDirectory()) {
            await listBundleFiles(directory, relativeFile, files)
        } else if (info.isFile()) {
            files.push({ path: relativeFile, size: info.size })
            if (files.length > MAX_FILES) throw new Error('Native bundle has too many files.')
        } else {
            throw new Error(`Native bundle contains a non-regular file: ${relativeFile}.`)
        }
    }
    return files
}

function sourceVersion(root) {
    return readFile(path.join(root, 'shared/src/buildInfo.ts'), 'utf8').then(contents => {
        const appVersion = contents.match(/export const APP_VERSION = ['"]([^'"]+)['"]/)?.[1]
        if (!appVersion || /\s/u.test(appVersion)) throw new Error('Could not read APP_VERSION from shared/src/buildInfo.ts.')
        const revision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
        if (!/^[a-f0-9]{7,64}$/u.test(revision)) throw new Error('Could not identify the source Git commit.')
        return `${appVersion}+${revision}`
    })
}

async function privateSigningKey(publicKey, environment) {
    const inline = environment.HAPI_UPDATE_PRIVATE_KEY?.trim()
    const filename = environment.HAPI_UPDATE_PRIVATE_KEY_PATH?.trim()
    if (inline && filename) throw new Error('Set only one of HAPI_UPDATE_PRIVATE_KEY and HAPI_UPDATE_PRIVATE_KEY_PATH.')
    if (!publicKey) {
        if (inline || filename) throw new Error('A signing private key requires publicKey in mobile/update.config.json.')
        return null
    }
    if (!inline && !filename) {
        throw new Error('This app pins an update public key. Set HAPI_UPDATE_PRIVATE_KEY or HAPI_UPDATE_PRIVATE_KEY_PATH; unsigned updates are not allowed.')
    }
    try {
        const privateKey = createPrivateKey(inline || await readFile(filename, 'utf8'))
        const expected = createPublicKey(publicKey)
        const actual = createPublicKey(privateKey)
        if (privateKey.asymmetricKeyType !== 'rsa' || expected.asymmetricKeyType !== 'rsa') {
            throw new Error('The update signing key must be RSA.')
        }
        if (!actual.export({ type: 'spki', format: 'der' }).equals(expected.export({ type: 'spki', format: 'der' }))) {
            throw new Error('The private signing key does not match the pinned update public key.')
        }
        return privateKey
    } catch (error) {
        if (error instanceof Error && /must be RSA|does not match/u.test(error.message)) throw error
        // Do not copy parser errors or key material into CI output.
        throw new Error('Could not read the RSA update signing key.')
    }
}

/**
 * Create an immutable local update artifact. Publication is deliberately a
 * separate CI operation; this function makes no network requests.
 *
 * validationOnly emits candidate.json, never latest.json. It lets untrusted PR
 * builds exercise packaging without granting access to a release signing key.
 */
export async function packageNativeUpdate({
    root = defaultRoot,
    outputDir = path.join(root, 'mobile/dist/update'),
    artifactBase = DEFAULT_ARTIFACT_BASE_URL,
    validationOnly = false,
    environment = process.env,
} = {}) {
    root = path.resolve(root)
    outputDir = path.resolve(root, outputDir)
    const webDir = path.join(root, 'web/dist')
    if (outputDir === webDir || outputDir.startsWith(`${webDir}${path.sep}`)) {
        throw new Error('The update output directory must be outside web/dist.')
    }
    const baseUrl = artifactBaseUrl(artifactBase)
    const config = resolveNativeUpdateConfig(root)
    if (!['android', 'ios'].every(platform => /^[a-f0-9]{64}$/u.test(config.runtimes[platform] ?? ''))) {
        throw new Error('Native runtime identifiers must be SHA-256 values.')
    }
    const privateKey = validationOnly ? null : await privateSigningKey(config.publicKey, environment)
    const webInfo = await lstat(webDir).catch(() => null)
    if (!webInfo?.isDirectory() || webInfo.isSymbolicLink()) throw new Error('Build web/dist in native mode before packaging an update.')
    await checkNativeWebBundle(webDir)
    const files = (await listBundleFiles(webDir)).sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)))
    if (files.reduce((size, file) => size + file.size, 0) > MAX_EXTRACTED_BYTES) {
        throw new Error('The extracted native bundle exceeds the 512 MiB limit.')
    }
    const createdAt = config.builtInCreatedAt
    if (!Number.isSafeInteger(createdAt) || createdAt <= 0) throw new Error('The source commit must have a valid creation timestamp.')
    const version = await sourceVersion(root)
    await mkdir(outputDir, { recursive: true })
    const temporary = await mkdtemp(path.join(outputDir, '.package-'))
    try {
        const stage = path.join(temporary, 'web')
        await mkdir(stage)
        // Info-ZIP stores DOS timestamps with two-second precision. Fix the
        // timestamp and mode so repeated builds of the same bytes hash equally.
        const timestamp = new Date(Math.max(Date.UTC(1980, 0, 1), Math.floor(createdAt / 2000) * 2000))
        for (const file of files) {
            const destination = path.join(stage, file.path)
            await mkdir(path.dirname(destination), { recursive: true })
            await copyFile(path.join(webDir, file.path), destination)
            await chmod(destination, 0o644)
            await utimes(destination, timestamp, timestamp)
        }
        const archive = path.join(temporary, 'bundle.zip')
        try {
            execFileSync('zip', ['-X', '-q', '-9', archive, '-@'], {
                cwd: stage,
                input: files.map(file => file.path).join('\n') + '\n',
                encoding: 'utf8',
                env: { ...environment, TZ: 'UTC' },
                maxBuffer: 1024 * 1024,
            })
        } catch {
            throw new Error('Could not create the update ZIP. Install Info-ZIP (`zip`) and retry.')
        }
        const bytes = await readFile(archive)
        if (bytes.length === 0 || bytes.length > MAX_UPDATE_BYTES) throw new Error('The update ZIP exceeds the 120 MiB limit or is empty.')
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const manifest = {
            schemaVersion: 1,
            bundleId: sha256,
            version,
            createdAt,
            runtimes: config.runtimes,
            url: new URL(`${sha256}.zip`, baseUrl).href,
            sha256,
            size: bytes.length,
        }
        if (privateKey) {
            const signature = sign('RSA-SHA256', bytes, privateKey)
            if (!verify('RSA-SHA256', bytes, createPublicKey(config.publicKey), signature)) {
                throw new Error('Update signature verification failed.')
            }
            manifest.signature = signature.toString('base64')
        }
        const archivePath = path.join(outputDir, `${sha256}.zip`)
        const existing = await readFile(archivePath).catch(error => {
            if (error.code === 'ENOENT') return null
            throw error
        })
        if (existing && !existing.equals(bytes)) throw new Error('An existing content-addressed update archive has different bytes.')
        if (!existing) await rename(archive, archivePath)
        const manifestPath = path.join(outputDir, validationOnly ? 'candidate.json' : 'latest.json')
        const result = validationOnly ? { ...manifest, validationOnly: true, signatureRequired: Boolean(config.publicKey) } : manifest
        await writeFile(path.join(temporary, 'manifest.json'), JSON.stringify(result, null, 2) + '\n')
        await rename(path.join(temporary, 'manifest.json'), manifestPath)
        return { archivePath, manifestPath, manifest: result }
    } finally {
        await rm(temporary, { recursive: true, force: true })
    }
}

function parseArguments(args) {
    const options = {}
    for (let index = 0; index < args.length; index++) {
        const name = args[index]
        if (name === '--validate-only') {
            options.validationOnly = true
            continue
        }
        const property = { '--root': 'root', '--output-dir': 'outputDir', '--artifact-base-url': 'artifactBase' }[name]
        if (!property || !args[index + 1] || args[index + 1].startsWith('--')) {
            throw new Error('Usage: node mobile/scripts/package-update.mjs [--root PATH] [--output-dir PATH] [--artifact-base-url HTTPS_URL] [--validate-only]')
        }
        options[property] = args[++index]
    }
    return options
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        const result = await packageNativeUpdate(parseArguments(process.argv.slice(2)))
        console.log(`${result.manifest.validationOnly ? 'Validated candidate' : 'Packaged native update'}: ${result.manifest.version}`)
        console.log(result.archivePath)
        console.log(result.manifestPath)
    } catch (error) {
        console.error(error instanceof Error ? error.message : 'Could not package the native update.')
        process.exitCode = 1
    }
}
