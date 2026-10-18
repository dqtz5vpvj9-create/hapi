import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadServerSettings } from './serverSettings'

function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'hapi-server-settings-test-'))
}

describe('loadServerSettings', () => {
    let dir: string | null = null
    const originalBackgroundOnly = process.env.SERVERCHAN_BACKGROUND_ONLY

    beforeEach(() => {
        delete process.env.SERVERCHAN_BACKGROUND_ONLY
    })

    afterEach(() => {
        if (dir) {
            rmSync(dir, { recursive: true, force: true })
            dir = null
        }
        if (originalBackgroundOnly === undefined) {
            delete process.env.SERVERCHAN_BACKGROUND_ONLY
        } else {
            process.env.SERVERCHAN_BACKGROUND_ONLY = originalBackgroundOnly
        }
    })

    it('rejects old webapp settings fields instead of migrating them', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            webappHost: '0.0.0.0',
            webappPort: 3007,
            webappUrl: 'http://localhost:3007',
        }))

        await expect(loadServerSettings(dir)).rejects.toThrow('Unsupported old settings field')
    })

    it('persists Android push mode and honors env over file without replacing the file value', async () => {
        dir = makeTempDir()
        const original = process.env.HAPI_ANDROID_PUSH
        try {
            process.env.HAPI_ANDROID_PUSH = 'relay'
            expect((await loadServerSettings(dir)).settings.androidPushMode).toBe('relay')
            expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).androidPushMode).toBe('relay')
            process.env.HAPI_ANDROID_PUSH = 'off'
            const overridden = await loadServerSettings(dir)
            expect(overridden.settings.androidPushMode).toBe('off')
            expect(overridden.sources.androidPushMode).toBe('env')
            delete process.env.HAPI_ANDROID_PUSH
            const restored = await loadServerSettings(dir)
            expect(restored.settings.androidPushMode).toBe('relay')
            expect(restored.sources.androidPushMode).toBe('file')
        } finally {
            if (original === undefined) delete process.env.HAPI_ANDROID_PUSH
            else process.env.HAPI_ANDROID_PUSH = original
        }
    })

    it('defaults ServerChan background-only mode to disabled', async () => {
        dir = makeTempDir()

        const result = await loadServerSettings(dir)

        expect(result.settings.serverChanBackgroundOnly).toBe(false)
        expect(result.sources.serverChanBackgroundOnly).toBe('default')
    })

    it('loads ServerChan background-only mode from settings.json', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            serverChanBackgroundOnly: true
        }))

        const result = await loadServerSettings(dir)

        expect(result.settings.serverChanBackgroundOnly).toBe(true)
        expect(result.sources.serverChanBackgroundOnly).toBe('file')
    })

    it('loads ServerChan background-only mode with environment precedence', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            serverChanBackgroundOnly: false
        }))
        process.env.SERVERCHAN_BACKGROUND_ONLY = 'true'

        const result = await loadServerSettings(dir)

        expect(result.settings.serverChanBackgroundOnly).toBe(true)
        expect(result.sources.serverChanBackgroundOnly).toBe('env')
    })

    it('rejects a non-boolean ServerChan background-only setting', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            serverChanBackgroundOnly: 'false'
        }))

        await expect(loadServerSettings(dir)).rejects.toThrow('serverChanBackgroundOnly must be a boolean')
    })

    it('defaults push settings to null', async () => {
        dir = makeTempDir()

        const result = await loadServerSettings(dir)

        expect(result.settings.fcmServiceAccountPath).toBeNull()
        expect(result.settings.iosPushMode).toBeNull()
        expect(result.sources.fcmServiceAccountPath).toBe('default')
    })

    it('persists a push env value to settings.json on first sight', async () => {
        dir = makeTempDir()
        process.env.FCM_SERVICE_ACCOUNT_PATH = '/tmp/sa.json'
        try {
            const result = await loadServerSettings(dir)

            expect(result.settings.fcmServiceAccountPath).toBe('/tmp/sa.json')
            expect(result.sources.fcmServiceAccountPath).toBe('env')
            expect(result.savedToFile).toBe(true)

            const written = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
            expect(written.fcmServiceAccountPath).toBe('/tmp/sa.json')
        } finally {
            delete process.env.FCM_SERVICE_ACCOUNT_PATH
        }
    })

    it('loads push settings from settings.json when the env is unset', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            fcmServiceAccountPath: '~/.hapi/sa.json',
            iosPushMode: 'off'
        }))

        const result = await loadServerSettings(dir)

        expect(result.settings.fcmServiceAccountPath).toBe('~/.hapi/sa.json')
        expect(result.sources.fcmServiceAccountPath).toBe('file')
        expect(result.settings.iosPushMode).toBe('off')
        expect(result.sources.iosPushMode).toBe('file')
    })
})

describe('native WebView CORS configuration', () => {
    let dir: string
    const keys = ['CORS_ORIGINS', 'HAPI_PUBLIC_URL'] as const
    let savedEnv: Partial<Record<typeof keys[number], string>>

    beforeEach(() => {
        dir = makeTempDir()
        savedEnv = {}
        for (const key of keys) {
            savedEnv[key] = process.env[key]
            delete process.env[key]
        }
        process.env.HAPI_PUBLIC_URL = 'https://hub.example'
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
        for (const key of keys) {
            if (savedEnv[key] === undefined) delete process.env[key]
            else process.env[key] = savedEnv[key]
        }
    })

    it('persists and reloads an explicit native allowlist without storing null', async () => {
        process.env.CORS_ORIGINS = 'https://app.example, capacitor://localhost, https://localhost'
        const expected = ['https://app.example', 'capacitor://localhost', 'https://localhost']

        const configured = await loadServerSettings(dir)
        expect(configured.settings.corsOrigins).toEqual(expected)
        expect(configured.sources.corsOrigins).toBe('env')
        expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).corsOrigins).toEqual(expected)

        delete process.env.CORS_ORIGINS
        const restored = await loadServerSettings(dir)
        expect(restored.settings.corsOrigins).toEqual(expected)
        expect(restored.sources.corsOrigins).toBe('file')
    })

    it('normalizes a file allowlist without admitting opaque or other custom origins', async () => {
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            corsOrigins: ['capacitor://localhost', 'https://localhost:443/', 'null', 'file:///tmp/a.html', 'capacitor://other'],
        }))

        const result = await loadServerSettings(dir)
        expect(result.settings.corsOrigins).toEqual(['capacitor://localhost', 'https://localhost'])
        expect(result.sources.corsOrigins).toBe('file')
    })

    it('leaves mobile origins disabled when no allowlist was configured', async () => {
        expect((await loadServerSettings(dir)).settings.corsOrigins).toEqual(['https://hub.example'])
    })
})
