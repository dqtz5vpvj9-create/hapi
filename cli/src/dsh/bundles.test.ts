import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearDshRestartRequired, listDshBundleCatalog, readDshBundles, setDshBundle, writeDshBundles } from './bundles'

let home = ''
const previous = process.env.DSH_HOME
const previousInstall = process.env.HAPI_DSH_INSTALL_ROOT
const BUNDLES = [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-acp-app',
    '@deepseek-ai/dsh-subagent-codex',
    '@deepseek-ai/dsh-experimental-auto-review'
]

async function writeInstalledBundles(root: string): Promise<void> {
    for (const name of BUNDLES) {
        const packageDirectory = join(root, 'node_modules', '@deepseek-ai', name.split('/')[1])
        await mkdir(packageDirectory, { recursive: true })
        await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
            name,
            description: `${name} description`,
            dsh: { bundle: { patch: './cordis.patch.yml' } }
        }))
    }
}

async function writeProfile(bundles: string[], extra: Record<string, unknown> = {}) {
    const directory = join(home, 'profiles', 'acp')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({
        name: 'dsh-profile-acp',
        private: true,
        ...extra,
        dsh: { profile: { bundles } }
    }, null, 2))
}

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'hapi-dsh-bundles-'))
    process.env.DSH_HOME = home
    const install = join(home, 'installation')
    await writeInstalledBundles(install)
    process.env.HAPI_DSH_INSTALL_ROOT = install
})

afterEach(async () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    if (previousInstall === undefined) delete process.env.HAPI_DSH_INSTALL_ROOT
    else process.env.HAPI_DSH_INSTALL_ROOT = previousInstall
    await rm(home, { recursive: true, force: true })
})

describe('dsh profile bundles', () => {
    it('reads the composed bundle list', async () => {
        await writeProfile(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'])
        const state = await readDshBundles()
        expect(state.profile).toBe('acp')
        expect(state.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'])
    })

    it('catalogs every bundle the installation ships and refuses unknown names', async () => {
        await writeProfile(['@deepseek-ai/dsh-base'])
        const catalog = await listDshBundleCatalog()
        expect(catalog.available.map((entry) => entry.name)).toContain('@deepseek-ai/dsh-base')
        expect(catalog.available.find((entry) => entry.name === '@deepseek-ai/dsh-base')?.enabled).toBe(true)
        expect(catalog.available.find((entry) => entry.name === '@deepseek-ai/dsh-base')?.switchable).toBe(false)
        await expect(setDshBundle('@deepseek-ai/not-installed', true)).rejects.toThrow('Unknown bundle')
    })

    it('enables and disables one bundle while preserving the rest of the profile', async () => {
        await writeProfile(['@deepseek-ai/dsh-base'], { version: '1.0.0' })

        const enabled = await setDshBundle('@deepseek-ai/dsh-subagent-codex', true)
        expect(enabled.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-subagent-codex'])
        expect(enabled.restartRequired).toBe(true)

        const stored = JSON.parse(await readFile(join(home, 'profiles', 'acp', 'package.json'), 'utf8')) as {
            version?: string
            dsh: { profile: { bundles: string[] } }
        }
        expect(stored.version).toBe('1.0.0')
        expect(stored.dsh.profile.bundles).toContain('@deepseek-ai/dsh-subagent-codex')

        const disabled = await setDshBundle('@deepseek-ai/dsh-subagent-codex', false)
        expect(disabled.bundles).toEqual(['@deepseek-ai/dsh-base'])
        // The marker survives a fresh catalog read (browser refresh), then a
        // newly composed DSH process clears it.
        expect((await listDshBundleCatalog()).restartRequired).toBe(true)
        await clearDshRestartRequired()
        expect((await listDshBundleCatalog()).restartRequired).toBe(false)
        // The provider stays in the catalog after removal so it can be enabled
        // again; foundation layers cannot be removed at all.
        expect(disabled.available.find((entry) => entry.name === '@deepseek-ai/dsh-subagent-codex'))
            .toMatchObject({ enabled: false, switchable: true })
        await expect(setDshBundle('@deepseek-ai/dsh-base', false)).rejects.toThrow('required by the acp profile')
    })

    it('deduplicates and rejects names that cannot be a package specifier', async () => {
        await writeProfile([])
        const state = await writeDshBundles(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-base'])
        expect(state.bundles).toEqual(['@deepseek-ai/dsh-base'])
        await expect(setDshBundle('bad name!', true)).rejects.toThrow('Invalid bundle name')
    })
})
