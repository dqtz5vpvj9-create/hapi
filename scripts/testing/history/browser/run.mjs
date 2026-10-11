import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { runOwnedChild, recordRun } from '../../recent/lifecycle.mjs'
import { tree, sha256, sourceManifest, verifyBuild } from '../../recent/receipts.mjs'
import { driverFiles, validateHistoryCells } from './cells.mjs'
const here = path.dirname(fileURLToPath(import.meta.url)), harnessRoot = path.dirname(here)
const [scenario, label, cellsText] = process.argv.slice(2)
if (!label || !/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('Fresh alphanumeric label required')
const cells = validateHistoryCells(scenario, JSON.parse(cellsText))
const sourceRoot = path.resolve(process.env.SOURCE_ROOT ?? path.join(here, '../../../..'))
if (!process.env.HAPI_QA_BUILD) throw new Error('Set HAPI_QA_BUILD to a verified portable history build')
const build = path.resolve(process.env.HAPI_QA_BUILD)
const provenance = JSON.parse(await fs.readFile(path.join(build, 'qa-source-provenance.json'), 'utf8'))
const sources = async () => {
    const result = await sourceManifest(sourceRoot, harnessRoot)
    for (const name of ['fixture-transform.mjs', 'lifecycle.mjs', 'receipts.mjs']) result['inherited-recent/' + name] = sha256(await fs.readFile(path.join(here, '../../recent', name)))
    return result
}
const assets = await tree(build); delete assets['qa-source-provenance.json']
verifyBuild(provenance, assets, await sources())
const output = path.resolve(process.env.HAPI_QA_RESULTS ?? 'test-results/history', label)
for (const protectedRoot of [harnessRoot, build]) if (output === protectedRoot || output.startsWith(protectedRoot + path.sep)) throw new Error('Results must be outside harness/build sources')
await fs.mkdir(path.dirname(output), { recursive: true }); await fs.mkdir(output)
const status = { label, scenario, startedAt: new Date().toISOString(), pid: process.pid, build,
    sourceIdentity: provenance.sourceIdentity, assetIdentity: provenance.assetIdentity, cells, results: [], status: 'running' }
const save = () => fs.writeFile(path.join(output, 'status.json'), JSON.stringify(status, null, 2))
let server
process.exitCode = await recordRun(status, save, async () => {
    const frozen = path.join(output, 'frozen-harness'), helpers = {}
    await fs.mkdir(frozen)
    for (const file of ['run.mjs', 'cells.mjs', 'EVIDENCE.md', 'origin.json', ...Object.values(driverFiles).flat()]) {
        const bytes = await fs.readFile(path.join(here, file)), hash = sha256(bytes)
        if (provenance.sources['harness/browser/' + file] !== hash) throw new Error('Runtime helper differs from build: ' + file)
        helpers[file] = hash; await fs.writeFile(path.join(frozen, file), bytes)
    }
    await fs.writeFile(path.join(output, 'helper-manifest.json'), JSON.stringify(helpers, null, 2))
    await fs.writeFile(path.join(output, 'build-provenance.json'), JSON.stringify(provenance, null, 2))
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }
    const realBuild = await fs.realpath(build)
    server = http.createServer(async (request, response) => {
        try {
            const file = path.resolve(build, '.' + new URL(request.url, 'http://localhost').pathname)
            if (!file.startsWith(build + path.sep) || !(await fs.stat(file)).isFile() || !(await fs.realpath(file)).startsWith(realBuild + path.sep)) throw new Error('Not a build asset')
            response.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
            createReadStream(file).on('error', () => response.destroy()).pipe(response)
        } catch { response.writeHead(404); response.end('Not found') }
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const url = `http://127.0.0.1:${server.address().port}`; status.url = url
    for (const [index, cell] of cells.entries()) {
        const name = [index + 1, cell.historyCount, cell.viewport, scenario, cell.warmMode ?? 'none', cell.mode, cell.cpu ? 'cpu' : 'nocpu'].join('-')
        const folder = path.join(output, name); await fs.mkdir(folder)
        const result = await runOwnedChild(process.execPath, [path.join(frozen, driverFiles[scenario][0]), JSON.stringify({ ...cell, sourceRoot, url, output: folder })], { stdio: 'inherit' }, {
            timeoutMs: 30000,
            onSpawn: async child => { status.current = { name, pid: child.pid, startedAt: new Date().toISOString() }; await save() },
        })
        status.results.push({ name, ...result, endedAt: new Date().toISOString() }); status.code = result.code; status.interrupted = result.interrupted
        await save()
        if (result.code) break
    }
    // Source drift during execution invalidates certification even when cells pass.
    const finalAssets = await tree(build); delete finalAssets['qa-source-provenance.json']
    verifyBuild(provenance, finalAssets, await sources())
}, async () => {
    if (server) { server.closeAllConnections(); if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
