import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveSiteUrl } from './site-config.mjs'

const mobileRoot = fileURLToPath(new URL('..', import.meta.url))

test('Capacitor loads the configured deployment, without a separate chat bundle or OTA feed', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { createRequire } from 'node:module';
        const require = createRequire(process.cwd() + '/package.json');
        const { loadConfig } = require('@capacitor/cli/dist/config.js');
        process.stdout.write(JSON.stringify((await loadConfig()).app.extConfig));
    `], { cwd: mobileRoot, encoding: 'utf8', env: { ...process.env, HAPI_MOBILE_SITE_URL: 'https://deployment.example' } })
    const config = JSON.parse(output)
    assert.equal(config.server.url, 'https://deployment.example')
    assert.equal(config.server.allowNavigation, undefined)
    assert.equal(config.server.cleartext, false)
    assert.equal(config.android.allowMixedContent, false)
    assert.equal(config.webDir, 'shell')
    assert.equal(config.plugins.HapiUpdates, undefined)
    assert.equal(config.plugins.LiveUpdate, undefined)
    assert.doesNotMatch(readFileSync(resolve(mobileRoot, 'shell/index.html'), 'utf8'), /<script|assets\//)
})

test('the deployment URL is an explicit HTTPS origin, not an API-only URL', () => {
    assert.equal(resolveSiteUrl('https://HAPI.example:443/'), 'https://hapi.example')
    for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/api', 'https://example.com/?token=secret', 'https://example.com/#foo']) {
        assert.throws(() => resolveSiteUrl(url))
    }
})
