#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium, expect } from '@playwright/test'
import { runOwnedChild } from './recent/lifecycle.mjs'
import { runRealtimeCohort } from './realtime-cohort.mjs'

// Staging outside the checkout prevents a missing build output from being
// supplied by Vite or the original checkout. The JS Hub uses a companion
// compiled web/dist; only the native executable embeds its web assets.
const repo = fileURLToPath(new URL('../../', import.meta.url))
const { values } = parseArgs({ options: {
    executable: { type: 'string' }, browser: { type: 'string' }, cohort: { type: 'boolean', default: false },
    output: { type: 'string', default: path.join(repo, 'e2e-output/built-artifact') },
} })
const output = path.resolve(values.output)
const temporary = await mkdtemp(path.join(tmpdir(), 'hapi-artifact-smoke-'))
const token = randomBytes(24).toString('base64url')
const artifact = path.resolve(values.executable ?? path.join(repo, 'hub/dist/index.js'))
const report = { artifact, kind: values.executable ? 'native-executable' : 'compiled-hub-with-web', startedAt: new Date().toISOString(), success: false }
let logs = ''
let browser

async function freePort() {
    const server = createServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    await new Promise(resolve => server.close(resolve))
    return port
}

async function ready(origin, child) {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Built Hub exited before readiness (${child.exitCode}).`)
        try {
            const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })
            if (response.ok) return
        } catch { /* startup has not bound its port yet */ }
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Built Hub did not become ready within 20 seconds.')
}

async function checkBrowser(origin) {
    const htmlResponse = await fetch(origin)
    assert.equal(htmlResponse.status, 200, 'The staged artifact must serve its own app.')
    assert.match(htmlResponse.headers.get('content-type') ?? '', /text\/html/)
    const html = await htmlResponse.text()
    assert.doesNotMatch(html, /\/@vite\/client|\/src\/.*\.(?:tsx?|jsx?)/, 'Source modules are not a built-artifact check.')
    const scriptPaths = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map(match => match[1])
    assert.ok(scriptPaths.some(src => src.startsWith('/assets/') && src.endsWith('.js')), 'A compiled app entry must be present.')
    for (const src of scriptPaths.filter(src => src.startsWith('/'))) {
        const response = await fetch(new URL(src, origin))
        assert.equal(response.status, 200, `Missing compiled entry: ${src}`)
        assert.match(response.headers.get('content-type') ?? '', /javascript/, `An HTML fallback must not impersonate ${src}.`)
    }
    report.indexSha256 = createHash('sha256').update(html).digest('hex')

    browser = await chromium.launch({ headless: true, ...(values.browser ? { executablePath: values.browser } : {}), args: ['--no-sandbox'] })
    report.browser = browser.version()
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, locale: 'en-US', serviceWorkers: 'block' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const errors = [], assetFailures = [], scripts = new Set()
    page.on('pageerror', error => errors.push(error.message))
    page.on('requestfailed', request => {
        if (['script', 'stylesheet', 'font'].includes(request.resourceType())) assetFailures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText })
    })
    page.on('response', response => {
        const request = response.request()
        if (!['script', 'stylesheet', 'font'].includes(request.resourceType())) return
        const pathname = new URL(response.url()).pathname
        if (response.status() >= 400) assetFailures.push({ path: pathname, status: response.status() })
        if (request.resourceType() === 'script') {
            scripts.add(pathname)
            if (!/javascript/.test(response.headers()['content-type'] ?? '')) assetFailures.push({ path: pathname, error: 'Script response is not JavaScript.' })
        }
    })
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await page.getByPlaceholder('Access token', { exact: true }).fill(token)
    await page.getByRole('button', { name: 'Sign In', exact: true }).click()
    await expect(page.getByPlaceholder('Access token', { exact: true })).toHaveCount(0)
    const bootScripts = [...scripts]
    await page.goto(`${origin}/settings/display`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible()
    await page.getByRole('radio', { name: 'Dark', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toHaveAttribute('aria-checked', 'true')
    assert.equal(await page.evaluate(() => localStorage.getItem('hapi-appearance')), 'dark')
    assert.ok(scripts.size > 1, 'The browser must load compiled dependencies as well as the entry.')
    assert.deepEqual(assetFailures, [], 'Built static assets must load with the correct type.')
    assert.deepEqual(errors, [], 'The compiled app must boot without runtime exceptions.')
    await page.screenshot({ path: path.join(output, 'settings.png'), fullPage: false })
    Object.assign(report, { checks: ['isolated startup', 'compiled entry', 'real authentication', 'deep-link settings', 'theme persistence', 'asset MIME and status', 'runtime errors'], bootScripts, loadedScripts: [...scripts], assetFailures, errors })
    await context.close()
    if (values.cohort) report.realtime = await runRealtimeCohort({ browser, origin, token, output })
}

try {
    await mkdir(output, { recursive: true })
    const bytes = await readFile(artifact)
    report.artifactSha256 = createHash('sha256').update(bytes).digest('hex')
    const staged = path.join(temporary, 'artifact')
    await mkdir(staged)
    let command, args
    if (values.executable) {
        const executable = path.join(staged, process.platform === 'win32' ? 'hapi.exe' : 'hapi')
        await cp(artifact, executable)
        command = executable
        args = ['hub']
    } else {
        await cp(path.dirname(artifact), staged, { recursive: true })
        const webArtifact = path.join(repo, 'web/dist')
        await readFile(path.join(webArtifact, 'index.html'))
        await cp(webArtifact, path.join(temporary, 'web/dist'), { recursive: true })
        report.webArtifact = webArtifact
        command = process.env.HAPI_BUN_EXEC ?? 'bun'
        args = [path.join(staged, path.basename(artifact))]
    }
    const port = await freePort(), origin = `http://127.0.0.1:${port}`
    const env = {
        PATH: process.env.PATH, HOME: process.env.HOME,
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        HAPI_HOME: path.join(temporary, 'home'), DB_PATH: path.join(temporary, 'hapi.db'),
        HAPI_LISTEN_HOST: '127.0.0.1', HAPI_LISTEN_PORT: String(port), HAPI_PUBLIC_URL: origin,
        CLI_API_TOKEN: token, TELEGRAM_NOTIFICATION: 'false', SERVERCHAN_NOTIFICATION: 'false',
    }
    if (values.executable) {
        let version = ''
        const result = await runOwnedChild(command, ['--version'], { cwd: staged, env, stdio: ['ignore', 'pipe', 'pipe'] }, {
            timeoutMs: 15_000, onSpawn(child) { child.stdout.on('data', chunk => { version += chunk }); child.stderr.on('data', chunk => { version += chunk }) },
        })
        assert.equal(result.code, 0, 'The packaged executable must report its version.')
        const expected = JSON.parse(await readFile(path.join(repo, 'cli/package.json'), 'utf8')).version
        assert.ok(version.includes(expected), `The executable must report package version ${expected}.`)
        report.version = expected
    }
    let failure
    const result = await runOwnedChild(command, args, { cwd: staged, env, stdio: ['ignore', 'pipe', 'pipe'] }, {
        timeoutMs: values.cohort ? 150_000 : 90_000,
        async onSpawn(child) {
            const capture = chunk => { logs = (logs + chunk.toString()).slice(-200_000) }
            child.stdout.on('data', capture); child.stderr.on('data', capture)
            try { await ready(origin, child); await checkBrowser(origin) }
            catch (error) { failure = error }
            finally { child.kill('SIGTERM') }
        },
    })
    if (failure) throw failure
    assert.equal(result.code, 0, 'The built Hub must shut down cleanly.')
    assert.equal(result.timedOut, false)
    report.success = true
} catch (error) {
    report.failure = String(error)
    process.exitCode = 1
} finally {
    await browser?.close()
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 })
    report.endedAt = new Date().toISOString()
    await writeFile(path.join(output, 'hub.log'), logs.replaceAll(token, '<smoke-token>').replaceAll(temporary, '<smoke-home>'))
    await writeFile(path.join(output, 'result.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({ success: report.success, kind: report.kind, output, ...(report.failure ? { failure: report.failure } : {}) }))
}
