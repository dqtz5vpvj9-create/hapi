import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { checkNativeWebBundle } from './check-web-bundle.mjs'

const folders = []
const entry = '<!doctype html><html><head><script>window.theme = "light"</script><link rel="stylesheet" href="/assets/app.css"></head><body><script type="module" src="/assets/app.js"></script></body></html>'

async function bundle(html = entry) {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'hapi-native-bundle-'))
    folders.push(folder)
    await mkdir(path.join(folder, 'assets'))
    await writeFile(path.join(folder, 'index.html'), html)
    await writeFile(path.join(folder, 'assets/app.js'), 'export {}')
    await writeFile(path.join(folder, 'assets/app.css'), 'body { color: black }')
    return folder
}

afterEach(async () => {
    await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})

test('accepts a built local app with inline appearance bootstrap and no service worker', async () => {
    await checkNativeWebBundle(await bundle())
})

test('reports an absent build and incomplete entry point', async () => {
    const folder = await bundle('<div>not a built page</div>')
    await assert.rejects(checkNativeWebBundle(folder), /complete index.html/)
    await rm(path.join(folder, 'index.html'))
    await assert.rejects(checkNativeWebBundle(folder), /bundle is missing/)
})

test('rejects a browser PWA build even when its service worker is not linked from HTML', async () => {
    for (const filename of ['sw.js', 'registerSW.js', 'manifest.webmanifest', 'workbox-old.js']) {
        const folder = await bundle()
        await writeFile(path.join(folder, filename), '')
        await assert.rejects(checkNativeWebBundle(folder), /contains PWA asset/)
    }
    await assert.rejects(checkNativeWebBundle(await bundle(entry.replace('</head>', '<link rel="manifest" href="/other.json"></head>'))), /PWA manifest link/)
})

test('rejects development scripts, remote scripts and a non-root build base', async () => {
    for (const source of ['http://localhost:5173/src/main.tsx', '//example.com/app.js', '/src/main.tsx', './assets/app.js', '/hapi/assets/app.js']) {
        await assert.rejects(checkNativeWebBundle(await bundle(entry.replace('/assets/app.js', source))), /non-local resource|built scripts/)
    }
    await assert.rejects(checkNativeWebBundle(await bundle(entry.replace('</head>', '<base href="/hapi/"></head>'))), /root base path/)
})

test('rejects missing bundle assets and a missing application entry', async () => {
    const folder = await bundle()
    await rm(path.join(folder, 'assets/app.css'))
    await assert.rejects(checkNativeWebBundle(folder), /missing referenced asset/)
    await assert.rejects(checkNativeWebBundle(await bundle(entry.replace('<script type="module" src="/assets/app.js"></script>', ''))), /no built module entry/)
})
