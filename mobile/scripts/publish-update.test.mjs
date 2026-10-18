import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { publishMobileUpdate } from './publish-update.mjs'

const roots = []
const owner = 'dqtz5vpvj9-create'
const repo = 'hapi'
const sourceSha = 'a'.repeat(40)
const feedUrl = `https://raw.githubusercontent.com/${owner}/${repo}/mobile-updates/latest.json`
const context = { repo: { owner, repo }, ref: 'refs/heads/main', sha: sourceSha, eventName: 'push' }

async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hapi-update-publish-'))
    roots.push(root)
    const directory = path.join(root, 'mobile/dist/update')
    await mkdir(directory, { recursive: true })
    const bytes = Buffer.from('A candidate ZIP already checked by the packaging pipeline')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const manifest = {
        schemaVersion: 1, bundleId: sha256, version: '0.30.7+aaaaaaaaaaaa', createdAt: 1_790_000_000_000,
        runtimes: { android: '1'.repeat(64), ios: '2'.repeat(64) },
        url: `https://github.com/${owner}/${repo}/releases/download/mobile-web/${sha256}.zip`,
        sha256, size: bytes.length,
    }
    await writeFile(path.join(directory, `${sha256}.zip`), bytes)
    await writeFile(path.join(directory, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n')
    await writeFile(path.join(root, 'mobile/update.config.json'), JSON.stringify({ feedUrl, publicKey: '' }))
    return { root, bytes, manifest, directory }
}

function failure(status) {
    return Object.assign(new Error(`HTTP ${status}`), { status })
}

function api(candidate, options = {}) {
    const calls = []
    const notices = []
    const state = {
        main: sourceSha,
        head: options.existingFeed ? 'feed-old' : null,
        release: options.existingRelease ? { id: 7 } : null,
        assets: options.assets ?? [],
        commits: new Map(),
        trees: new Map(),
    }
    let sequence = 0
    let conflicted = false
    if (options.existingFeed) {
        state.trees.set('tree-old', { 'latest.json': JSON.stringify(options.currentManifest ?? { ...candidate.manifest, bundleId: 'b'.repeat(64), createdAt: candidate.manifest.createdAt - 1000 }), 'operator.txt': 'preserve this file' })
        state.commits.set('feed-old', { tree: { sha: 'tree-old' } })
    }
    const repos = {
        getReleaseByTag: async () => { if (!state.release) throw failure(404); return { data: state.release } },
        createRelease: async args => { calls.push(['createRelease', args]); state.release = { id: 7 }; return { data: state.release } },
        listReleaseAssets: () => {},
        deleteReleaseAsset: async args => { calls.push(['deleteReleaseAsset', args]); state.assets = state.assets.filter(asset => asset.id !== args.asset_id); return { data: {} } },
        getReleaseAsset: async () => ({ data: options.downloadedAsset ?? candidate.bytes }),
        uploadReleaseAsset: async args => {
            calls.push(['uploadReleaseAsset', args])
            if (options.supersedeAfterUpload) state.main = 'new-main'
            return { data: { size: args.data.length, browser_download_url: candidate.manifest.url, digest: `sha256:${candidate.manifest.sha256}` } }
        },
        getContent: async args => {
            const tree = state.trees.get(state.commits.get(args.ref).tree.sha)
            if (!(args.path in tree)) throw failure(404)
            return { data: { encoding: 'base64', content: Buffer.from(tree[args.path]).toString('base64') } }
        },
    }
    const git = {
        getRef: async args => {
            if (args.ref === 'heads/main') return { data: { object: { sha: state.main } } }
            if (!state.head) throw failure(404)
            return { data: { object: { sha: state.head } } }
        },
        getCommit: async args => ({ data: state.commits.get(args.commit_sha) }),
        createTree: async args => {
            calls.push(['createTree', args])
            const sha = `tree-${++sequence}`
            state.trees.set(sha, { ...(args.base_tree ? state.trees.get(args.base_tree) : {}), ...Object.fromEntries(args.tree.map(file => [file.path, file.content])) })
            return { data: { sha } }
        },
        createCommit: async args => {
            calls.push(['createCommit', args])
            const sha = `commit-${++sequence}`
            state.commits.set(sha, { tree: { sha: args.tree }, parents: args.parents })
            return { data: { sha } }
        },
        createRef: async args => {
            calls.push(['createRef', args])
            if (state.head) throw failure(422)
            state.head = args.sha
            return { data: {} }
        },
        updateRef: async args => {
            calls.push(['updateRef', args])
            if (options.concurrentWrite && !conflicted) {
                conflicted = true
                state.trees.set('tree-concurrent', { ...state.trees.get(state.commits.get(state.head).tree.sha), 'operator.txt': 'concurrent operator edit' })
                state.commits.set('feed-concurrent', { tree: { sha: 'tree-concurrent' } })
                state.head = 'feed-concurrent'
                throw failure(422)
            }
            assert.equal(state.commits.get(args.sha).parents[0], state.head)
            assert.equal(args.force, false)
            state.head = args.sha
            return { data: {} }
        },
    }
    return {
        github: { rest: { repos, git }, paginate: async () => state.assets },
        core: { notice: message => notices.push(message) },
        calls, state, notices,
        feed: () => state.head && state.trees.get(state.commits.get(state.head).tree.sha),
    }
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('uploads immutable bytes before making the first feed visible and does not mark the release latest', async () => {
    const candidate = await fixture()
    const f = api(candidate)
    const result = await publishMobileUpdate({ ...f, context, root: candidate.root })
    assert.equal(result.published, true)
    assert.deepEqual(JSON.parse(f.feed()['latest.json']), candidate.manifest)
    const names = f.calls.map(([name]) => name)
    assert.ok(names.indexOf('uploadReleaseAsset') < names.indexOf('createRef'))
    assert.equal(f.calls.find(([name]) => name === 'createRelease')[1].make_latest, 'false')
    assert.deepEqual(f.calls.find(([name]) => name === 'createCommit')[1].parents, [])
})

test('updates only latest.json, preserves operator files and refuses to force the feed branch', async () => {
    const candidate = await fixture()
    const f = api(candidate, { existingFeed: true, existingRelease: true })
    await publishMobileUpdate({ ...f, context, root: candidate.root })
    assert.equal(f.feed()['operator.txt'], 'preserve this file')
    assert.deepEqual(JSON.parse(f.feed()['latest.json']), candidate.manifest)
    assert.equal(f.calls.find(([name]) => name === 'createTree')[1].base_tree, 'tree-old')
    assert.equal(f.calls.find(([name]) => name === 'updateRef')[1].force, false)
})

test('re-reads the branch after a competing feed edit and preserves that edit', async () => {
    const candidate = await fixture()
    const f = api(candidate, { existingFeed: true, existingRelease: true, concurrentWrite: true })
    await publishMobileUpdate({ ...f, context, root: candidate.root })
    assert.equal(f.feed()['operator.txt'], 'concurrent operator edit')
    assert.deepEqual(f.calls.filter(([name]) => name === 'createCommit').map(([, args]) => args.parents), [['feed-old'], ['feed-concurrent']])
})

test('a superseded build cannot publish, including when main advances while the archive uploads', async () => {
    const candidate = await fixture()
    const stale = api(candidate)
    stale.state.main = 'new-main'
    assert.equal((await publishMobileUpdate({ ...stale, context, root: candidate.root })).reason, 'superseded')
    assert.deepEqual(stale.calls, [])
    const later = api(candidate, { supersedeAfterUpload: true })
    assert.equal((await publishMobileUpdate({ ...later, context, root: candidate.root })).reason, 'superseded')
    assert.equal(later.state.head, null)
    assert.equal(later.calls.some(([name]) => name === 'createRef'), false)
})

test('reruns verify and reuse an immutable archive, and reject an existing asset with different bytes', async () => {
    const candidate = await fixture()
    const asset = { id: 9, name: `${candidate.manifest.bundleId}.zip`, size: candidate.bytes.length, digest: `sha256:${candidate.manifest.sha256}` }
    const f = api(candidate, { existingRelease: true, assets: [asset] })
    await publishMobileUpdate({ ...f, context, root: candidate.root })
    assert.equal(f.calls.some(([name]) => name === 'uploadReleaseAsset'), false)
    const bad = api(candidate, { existingRelease: true, assets: [{ ...asset, digest: `sha256:${'0'.repeat(64)}` }] })
    await assert.rejects(publishMobileUpdate({ ...bad, context, root: candidate.root }), /different digest/u)
    assert.deepEqual(bad.calls, [])
    const bytes = Buffer.from(candidate.bytes)
    bytes[0] ^= 1
    const legacy = api(candidate, { existingRelease: true, assets: [{ ...asset, digest: undefined }], downloadedAsset: bytes })
    await assert.rejects(publishMobileUpdate({ ...legacy, context, root: candidate.root }), /different bytes/u)
})

test('does not move a current or newer feed backwards', async () => {
    const candidate = await fixture()
    const asset = { id: 9, name: `${candidate.manifest.bundleId}.zip`, size: candidate.bytes.length, digest: `sha256:${candidate.manifest.sha256}` }
    const same = api(candidate, { existingFeed: true, existingRelease: true, currentManifest: candidate.manifest, assets: [asset] })
    assert.equal((await publishMobileUpdate({ ...same, context, root: candidate.root })).reason, 'already-published')
    assert.deepEqual(same.calls, [])
    const newer = api(candidate, { existingFeed: true, existingRelease: true, currentManifest: { ...candidate.manifest, bundleId: 'c'.repeat(64), createdAt: candidate.manifest.createdAt + 1000 }, assets: [asset] })
    await assert.rejects(publishMobileUpdate({ ...newer, context, root: candidate.root }), /equally recent or newer/u)
    assert.deepEqual(newer.calls, [])
})

test('retries a proven-empty interrupted upload without deleting any completed release asset', async () => {
    const candidate = await fixture()
    const starter = { id: 9, name: `${candidate.manifest.bundleId}.zip`, size: 0, state: 'starter' }
    const f = api(candidate, { existingRelease: true, assets: [starter] })
    await publishMobileUpdate({ ...f, context, root: candidate.root })
    const names = f.calls.map(([name]) => name)
    assert.ok(names.indexOf('deleteReleaseAsset') < names.indexOf('uploadReleaseAsset'))
    assert.equal(f.calls.find(([name]) => name === 'deleteReleaseAsset')[1].asset_id, 9)
    const complete = api(candidate, { existingRelease: true, assets: [{ ...starter, state: 'uploaded' }] })
    await assert.rejects(publishMobileUpdate({ ...complete, context, root: candidate.root }), /different size/u)
    assert.deepEqual(complete.calls, [])
})

test('rejects PR publication, tampered local archives and a user-selected Hub as update authority', async () => {
    const candidate = await fixture()
    const f = api(candidate)
    await assert.rejects(publishMobileUpdate({ ...f, context: { ...context, eventName: 'pull_request' }, root: candidate.root }), /restricted/u)
    await writeFile(path.join(candidate.directory, `${candidate.manifest.bundleId}.zip`), 'tampered')
    await assert.rejects(publishMobileUpdate({ ...f, context, root: candidate.root }), /does not match/u)
    await writeFile(path.join(candidate.root, 'mobile/update.config.json'), JSON.stringify({ feedUrl: 'https://data-hub.example/latest.json' }))
    await assert.rejects(publishMobileUpdate({ ...f, context, root: candidate.root }), /different update authority/u)
    assert.deepEqual(f.calls, [])
})

test('does not publish validation-only metadata or an unsigned artifact for a pinned-key app', async () => {
    const candidate = await fixture()
    const f = api(candidate)
    const manifestPath = path.join(candidate.directory, 'latest.json')
    await writeFile(manifestPath, JSON.stringify({ ...candidate.manifest, validationOnly: true }))
    await assert.rejects(publishMobileUpdate({ ...f, context, root: candidate.root }), /publishable/u)
    await writeFile(manifestPath, JSON.stringify(candidate.manifest))
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    await writeFile(path.join(candidate.root, 'mobile/update.config.json'), JSON.stringify({ feedUrl, publicKey }))
    await assert.rejects(publishMobileUpdate({ ...f, context, root: candidate.root }), /signed release/u)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.signature = Buffer.from('incorrect signature').toString('base64')
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(publishMobileUpdate({ ...f, context, root: candidate.root }), /signature does not match/u)
    assert.deepEqual(f.calls, [])
})
