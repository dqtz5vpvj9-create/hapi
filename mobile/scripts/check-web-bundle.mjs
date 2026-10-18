import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const defaultWebDir = fileURLToPath(new URL('../../web/dist', import.meta.url))

function attribute(attributes, name) {
    const match = attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
    return match ? match[1] ?? match[2] ?? match[3] : undefined
}

/** Validate the generated entry point before Capacitor copies it into an app. */
export async function checkNativeWebBundle(webDir = defaultWebDir) {
    let html
    try {
        html = await readFile(path.join(webDir, 'index.html'), 'utf8')
    } catch {
        throw new Error('Native Web bundle is missing. Run `bun run build:mobile` from the repository root.')
    }

    if (!/<head(?:\s|>)/i.test(html) || !/<body(?:\s|>)/i.test(html)) {
        throw new Error('Native Web bundle must contain a complete index.html with head and body elements.')
    }

    const files = await readdir(webDir)
    const serviceWorkerFile = files.find(name => /^(?:sw\.js|registerSW\.js|manifest\.(?:webmanifest|json)|workbox-.*\.js)$/i.test(name))
    if (serviceWorkerFile) {
        throw new Error(`Native Web bundle contains PWA asset ${serviceWorkerFile}. Rebuild with \`bun run build:mobile\`.`)
    }

    // Inline theme/font bootstraps are part of the existing Web UI. Only their
    // opening tag matters here; text inside scripts is not HTML markup.
    const markup = html.replace(/<!--[\s\S]*?-->/g, '').replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, '$1</script>')
    let appEntry = false
    for (const match of markup.matchAll(/<(script|link|base)\b([^>]*)>/gi)) {
        const tag = match[1].toLowerCase()
        const attributes = match[2]
        if (tag === 'base') {
            if (attribute(attributes, 'href') !== '/') {
                throw new Error('Native Web bundle must use the root base path `/`.')
            }
            continue
        }
        if (tag === 'link' && attribute(attributes, 'rel')?.toLowerCase().split(/\s+/).includes('manifest')) {
            throw new Error('Native Web bundle contains a PWA manifest link. Rebuild with `bun run build:mobile`.')
        }
        const resource = attribute(attributes, tag === 'script' ? 'src' : 'href')
        if (resource === undefined && tag === 'script') continue
        if (!resource || !resource.startsWith('/') || resource.startsWith('//') || resource.includes('\\')) {
            throw new Error(`Native Web bundle references a non-local resource: ${resource ?? tag}.`)
        }
        const url = new URL(resource, 'https://localhost')
        let pathname
        try {
            pathname = decodeURIComponent(url.pathname)
        } catch {
            throw new Error(`Native Web bundle has an invalid resource path: ${resource}.`)
        }
        const root = path.resolve(webDir)
        const file = path.resolve(root, `.${pathname}`)
        if (!file.startsWith(`${root}${path.sep}`)) {
            throw new Error(`Native Web bundle resource escapes the asset directory: ${resource}.`)
        }
        if (tag === 'script') {
            if (!pathname.startsWith('/assets/') || !pathname.endsWith('.js')) {
                throw new Error(`Native Web bundle must use built scripts under /assets/: ${resource}.`)
            }
            if (attribute(attributes, 'type') === 'module') appEntry = true
        }
        try {
            if (!(await stat(file)).isFile()) throw new Error('Not a file')
        } catch {
            throw new Error(`Native Web bundle is missing referenced asset: ${resource}.`)
        }
    }
    if (!appEntry) {
        throw new Error('Native Web bundle has no built module entry under /assets/.')
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        await checkNativeWebBundle()
        console.log('Native Web bundle: local assets verified; no PWA service worker.')
    } catch (error) {
        console.error(error instanceof Error ? error.message : error)
        process.exitCode = 1
    }
}
