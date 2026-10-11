import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { runOwnedChild } from './lifecycle.mjs'
import { tree, identity, changed, sourceManifest } from './receipts.mjs'
const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(process.env.SOURCE_ROOT ?? path.join(here, '../../..'))
if (!process.env.HAPI_QA_BUILD) throw new Error('Set HAPI_QA_BUILD to a fresh output directory')
const output = path.resolve(process.env.HAPI_QA_BUILD)
if (output === here || output.startsWith(here + path.sep)) throw new Error('Build output must be outside harness sources')
// Exclusive creation prevents accidental deletion of an existing build by Vite.
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.mkdir(output)
const sources = () => sourceManifest(repo, here)
const before = await sources()
const receipt = { schema: 1, startedAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), sourceIdentity: identity(before), sources: before }
const require = createRequire(path.join(repo, 'web/package.json'))
const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js')
const { code, timedOut, interrupted, error } = await runOwnedChild(process.execPath, [vite, 'build', '--config', path.join(here, 'fixture.config.mjs')], { cwd: path.join(repo, 'web'), env: { ...process.env, SOURCE_ROOT: repo, HAPI_QA_BUILD: output }, stdio: 'inherit' }, { timeoutMs: 180000 })
const after = await sources()
Object.assign(receipt, { finishedAt: new Date().toISOString(), code, timedOut, interrupted, error, changedDuringBuild: changed(before, after), assets: code === 0 ? await tree(output) : {} })
receipt.assetIdentity = identity(receipt.assets)
await fs.writeFile(path.join(output, 'qa-source-provenance.json'), JSON.stringify(receipt, null, 2))
if (code || timedOut || receipt.changedDuringBuild.length) throw new Error('Build failed, timed out, or source changed; inspect provenance')
