import { inject } from 'vitest'
import type {} from './context'

// This file runs at the top level of each vitest worker, before any test file
// is imported. Project-scoped context keeps simultaneous test runs isolated.
const config = inject('hapiTestContext')

if (!config) {
    throw new Error(
        '[test setup] Missing isolated hub context.\n' +
        'Run "bun run test:cli" or "bun run test:cli:integration" so globalSetup can start a temp hub first.'
    )
}

process.env.HAPI_API_URL = `http://127.0.0.1:${config.port}`
process.env.CLI_API_TOKEN = config.token
process.env.HAPI_HOME = config.tmpHome
process.env.HAPI_BUN_EXEC = config.bunExec
// The runner agent-availability preflight must see an installable Claude CLI
// even on machines (CI) without one; globalSetup provides a stub binary.
if (config.stubClaudePath) process.env.HAPI_CLAUDE_PATH = config.stubClaudePath
// The stress test starts 20 real CLI children. On slower/loaded machines their
// session webhooks can take longer than the production control-client default.
process.env.HAPI_RUNNER_HTTP_TIMEOUT ??= '60000'
// Keep heartbeat short so the version-mismatch test doesn't need to wait 60s
process.env.HAPI_RUNNER_HEARTBEAT_INTERVAL ??= '30000'
