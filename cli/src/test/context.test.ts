import { existsSync } from 'node:fs'
import { expect, inject, it } from 'vitest'
import { configuration } from '@/configuration'
import { buildTestChildEnv, TEST_OWNED_MARKER_KEY } from './integrationEnv'
import type {} from './context'

it('keeps the worker, CLI singleton and child ownership on this test project\'s hub', async () => {
    const context = inject('hapiTestContext')
    const apiUrl = `http://127.0.0.1:${context.port}`

    expect(process.env.HAPI_HOME).toBe(context.tmpHome)
    expect(configuration.happyHomeDir).toBe(context.tmpHome)
    expect(configuration.apiUrl).toBe(apiUrl)
    expect(process.env.CLI_API_TOKEN === context.token).toBe(true)
    expect(buildTestChildEnv()[TEST_OWNED_MARKER_KEY]).toBe(context.tmpHome)
    expect(existsSync(context.tmpHome)).toBe(true)
    expect((await fetch(`${apiUrl}/health`)).ok).toBe(true)
})
