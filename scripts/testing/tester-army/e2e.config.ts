import type { E2EConfig } from 'e2e'
import { web } from '@e2e-dev/web'

const repo = process.env.HAPI_REPO ?? '/mnt/cache/src/hapi'
const capture = process.env.HAPI_REPLAY_DATA
if (!capture) throw new Error('Set HAPI_REPLAY_DATA to a private capture directory')
const app = {
    url: 'http://127.0.0.1:5313',
    environment: 'test' as const,
    command: {
        executable: 'python3',
        args: [repo + '/scripts/testing/history-replay-server.py', '--data', capture,
            '--web-root', process.env.HAPI_WEB_ROOT ?? repo + '/web/dist',
            '--port', '5313', '--latency-ms', '700'],
        log: '.e2e/logs/replay.log',
    },
}

export default {
    projectId: 'hapi-real-history',
    tests: 'tests/**/*.e2e.ts',
    targets: [
        { name: 'mobile-chrome', engine: web({ viewport: { width: 390, height: 844 } }), app },
        { name: 'desktop-chrome', engine: web({ viewport: { width: 1440, height: 900 } }), app },
    ],
    workers: 1,
    retries: 0,
    timeout: 120000,
    cache: 'off',
    trace: 'retain-on-failure',
    reporters: ['list', 'markdown'],
} satisfies E2EConfig
