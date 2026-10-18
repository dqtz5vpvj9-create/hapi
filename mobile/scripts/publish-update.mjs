import { createHash, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const releaseTag = 'mobile-web'
const feedBranch = 'mobile-updates'

function notFound(error) {
    return error?.status === 404
}

async function readCandidate(root, owner, repo) {
    const directory = path.join(root, 'mobile/dist/update')
    const text = await readFile(path.join(directory, 'latest.json'), 'utf8')
    const manifest = JSON.parse(text)
    const settings = JSON.parse(await readFile(path.join(root, 'mobile/update.config.json'), 'utf8'))
    const expectedFeed = `https://raw.githubusercontent.com/${owner}/${repo}/${feedBranch}/latest.json`
    if (settings.feedUrl !== expectedFeed) {
        throw new Error(`This workflow publishes ${expectedFeed}; mobile/update.config.json selects a different update authority. Use the publisher for that self-hosted feed.`)
    }
    if (manifest.validationOnly || manifest.schemaVersion !== 1 || !/^[a-f0-9]{64}$/u.test(manifest.bundleId ?? '')
        || manifest.sha256 !== manifest.bundleId || !Number.isSafeInteger(manifest.createdAt) || manifest.createdAt <= 0
        || !['android', 'ios'].every(platform => /^[a-f0-9]{64}$/u.test(manifest.runtimes?.[platform] ?? ''))) {
        throw new Error('Only a complete publishable mobile update manifest is accepted.')
    }
    if (settings.publicKey?.trim() && !manifest.signature) throw new Error('The pinned update feed requires a signed release.')
    const name = `${manifest.bundleId}.zip`
    if (manifest.url !== `https://github.com/${owner}/${repo}/releases/download/${releaseTag}/${name}`) {
        throw new Error('The update archive URL does not match this repository release.')
    }
    const bytes = await readFile(path.join(directory, name))
    if (bytes.length !== manifest.size || bytes.length > 120 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
        throw new Error('The update archive does not match its manifest.')
    }
    if (settings.publicKey?.trim() && !verify('RSA-SHA256', bytes, settings.publicKey, Buffer.from(manifest.signature, 'base64'))) {
        throw new Error('The update archive signature does not match the pinned key.')
    }
    return { text, manifest, name, bytes }
}

async function ensureArchive(github, owner, repo, candidate, sourceSha) {
    let release
    try {
        release = (await github.rest.repos.getReleaseByTag({ owner, repo, tag: releaseTag })).data
    } catch (error) {
        if (!notFound(error)) throw error
        release = (await github.rest.repos.createRelease({
            owner, repo, tag_name: releaseTag, target_commitish: sourceSha,
            name: 'HAPI mobile Web updates',
            body: 'Immutable Web bundles for the Capacitor app. The mobile-updates branch selects the current compatible bundle. These archives do not update native plugins or replace the app binary.',
            prerelease: true, make_latest: 'false',
        })).data
    }
    const assets = await github.paginate(github.rest.repos.listReleaseAssets, { owner, repo, release_id: release.id, per_page: 100 })
    let existing = assets.find(asset => asset.name === candidate.name)
    // GitHub can retain an empty starter after an interrupted/502 upload. It
    // has no immutable release bytes to preserve and must not block a retry.
    if (existing?.state === 'starter' && existing.size === 0) {
        await github.rest.repos.deleteReleaseAsset({ owner, repo, asset_id: existing.id })
        existing = null
    }
    if (existing) {
        if (existing.size !== candidate.bytes.length) throw new Error('An immutable release archive already exists with a different size.')
        if (existing.digest) {
            if (existing.digest !== `sha256:${candidate.manifest.sha256}`) throw new Error('An immutable release archive already exists with a different digest.')
        } else {
            const response = await github.rest.repos.getReleaseAsset({ owner, repo, asset_id: existing.id, headers: { accept: 'application/octet-stream' } })
            const data = response.data
            if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) throw new Error('Could not verify the existing immutable release archive.')
            if (createHash('sha256').update(Buffer.from(data instanceof ArrayBuffer ? data : data.buffer, data.byteOffset ?? 0, data.byteLength)).digest('hex') !== candidate.manifest.sha256) {
                throw new Error('An immutable release archive already exists with different bytes.')
            }
        }
        return
    }
    const uploaded = (await github.rest.repos.uploadReleaseAsset({
        owner, repo, release_id: release.id, name: candidate.name,
        headers: { 'content-type': 'application/zip', 'content-length': String(candidate.bytes.length) },
        data: candidate.bytes,
    })).data
    if (uploaded.size !== candidate.bytes.length || uploaded.browser_download_url !== candidate.manifest.url
        || (uploaded.digest && uploaded.digest !== `sha256:${candidate.manifest.sha256}`)) {
        throw new Error('GitHub did not confirm the expected immutable update archive.')
    }
}

async function currentFeed(github, owner, repo) {
    let head
    try {
        head = (await github.rest.git.getRef({ owner, repo, ref: `heads/${feedBranch}` })).data.object.sha
    } catch (error) {
        if (notFound(error)) return null
        throw error
    }
    const commit = (await github.rest.git.getCommit({ owner, repo, commit_sha: head })).data
    let manifest = null
    try {
        const file = (await github.rest.repos.getContent({ owner, repo, path: 'latest.json', ref: head })).data
        if (Array.isArray(file) || file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('The update feed is not a regular JSON file.')
        manifest = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))
    } catch (error) {
        if (!notFound(error)) throw error
    }
    return { head, tree: commit.tree.sha, manifest }
}

/** Used only by the main-branch workflow. No API mutation runs on PR builds. */
export async function publishMobileUpdate({ github, context, core, root = process.cwd() }) {
    const { owner, repo } = context.repo
    if (context.ref !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(context.eventName)) {
        throw new Error('Mobile Web publication is restricted to reviewed main-branch builds.')
    }
    const candidate = await readCandidate(root, owner, repo)
    const isCurrentMain = async () => (await github.rest.git.getRef({ owner, repo, ref: 'heads/main' })).data.object.sha === context.sha
    if (!await isCurrentMain()) {
        core.notice('A newer main commit exists; this candidate will not replace the update feed.')
        return { published: false, reason: 'superseded' }
    }
    await ensureArchive(github, owner, repo, candidate, context.sha)
    // A non-forced ref update is a compare-and-swap here: each candidate commit
    // has the observed feed head as its parent. A concurrent writer makes that
    // commit non-fast-forward, so we re-read instead of overwriting its changes.
    for (let attempt = 0; attempt < 3; attempt++) {
        if (!await isCurrentMain()) {
            core.notice('Main advanced during upload; the immutable archive is retained, and the feed is unchanged.')
            return { published: false, reason: 'superseded' }
        }
        const current = await currentFeed(github, owner, repo)
        if (current?.manifest && JSON.stringify(current.manifest) === JSON.stringify(candidate.manifest)) {
            return { published: false, reason: 'already-published' }
        }
        if (current?.manifest?.createdAt >= candidate.manifest.createdAt) {
            throw new Error('The feed already contains an equally recent or newer source commit. Refusing to move clients backwards; publish from a newer Git commit.')
        }
        const tree = (await github.rest.git.createTree({
            owner, repo, ...(current ? { base_tree: current.tree } : {}),
            tree: [{ path: 'latest.json', mode: '100644', type: 'blob', content: candidate.text }],
        })).data
        const commit = (await github.rest.git.createCommit({
            owner, repo, message: `Publish mobile Web ${candidate.manifest.version}`,
            tree: tree.sha, parents: current ? [current.head] : [],
        })).data
        try {
            if (current) {
                await github.rest.git.updateRef({ owner, repo, ref: `heads/${feedBranch}`, sha: commit.sha, force: false })
            } else {
                await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${feedBranch}`, sha: commit.sha })
            }
            core.notice(`Published mobile Web ${candidate.manifest.version}: ${candidate.manifest.bundleId}`)
            return { published: true, bundleId: candidate.manifest.bundleId }
        } catch (error) {
            if (![409, 422].includes(error?.status) || attempt === 2) throw error
        }
    }
    throw new Error('The update feed changed repeatedly during publication.')
}
