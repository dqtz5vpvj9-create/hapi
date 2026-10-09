import type { E2EConfig } from 'e2e'
import { web } from '@e2e-dev/web'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { systemChromium } from './system-chromium'

const repo = resolve(process.env.HAPI_REPO_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../..'))
const executable = process.env.CHROMIUM_EXECUTABLE
const browser = executable ? systemChromium(executable) : 'chromium'
const app = {
    url: 'http://127.0.0.1:5187',
    command: {
        executable: process.execPath,
        args: [join(repo, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5187', '--strictPort'],
        cwd: join(repo, 'web'),
        log: '.e2e/logs/vite.log',
        startupTimeout: 120_000,
    },
}

export default {
    tests: 'tests/**/*.e2e.ts',
    targets: [
        { name: 'desktop', engine: web({ browser, viewport: { width: 1440, height: 900 } }), app },
        { name: 'phone', engine: web({ browser, viewport: { width: 390, height: 844 } }), app },
    ],
    workers: 1,
    retries: 0,
    timeout: 120_000,
    assertionTimeout: 15_000,
    trace: 'on',
    reporters: ['list', 'markdown'],
    cache: 'off',
} satisfies E2EConfig
