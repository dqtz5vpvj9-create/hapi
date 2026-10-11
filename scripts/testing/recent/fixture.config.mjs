import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { extendRecentFixture } from './fixture-transform.mjs'
const repo = path.resolve(process.env.SOURCE_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url)))
const require = createRequire(path.join(repo, 'web/package.json'))
const { loadConfigFromFile } = await import(require.resolve('vite'))
const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(repo, 'web/vite.config.ts'))
if (!loaded) throw new Error('Cannot load repository Vite config')
const config = loaded.config
export default {
    ...config, root: path.join(repo, 'web'),
    plugins: [
        { name: 'recent-qa-no-pwa', resolveId(id) { if (id === 'virtual:pwa-register') return '\0recent-qa-pwa' }, load(id) { if (id === '\0recent-qa-pwa') return 'export const registerSW = () => async () => {}' } },
        { name: 'recent-qa-synthetic-hub', enforce: 'pre', transform(code, id) { if (id.split('?')[0].endsWith('/e2e-fixtures/workspace-fixture.tsx')) return extendRecentFixture(code) } },
        ...config.plugins.flat(Infinity).filter(plugin => plugin && !String(plugin.name).toLowerCase().includes('pwa')),
    ],
    build: { ...config.build, outDir: process.env.HAPI_QA_BUILD, emptyOutDir: true,
        rollupOptions: { ...config.build?.rollupOptions, input: path.join(repo, 'web/e2e-fixtures/workspace-fixture.html') } },
}
