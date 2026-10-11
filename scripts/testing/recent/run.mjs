import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { runOwnedChild, recordRun } from './lifecycle.mjs'
import { createHash } from 'node:crypto'
import { tree, validateCells, sourceManifest, verifyBuild } from './receipts.mjs'
const here = path.dirname(fileURLToPath(import.meta.url))
const [label, cellsText] = process.argv.slice(2)
if (!label || !/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('Fresh label required')
const cells = validateCells(JSON.parse(cellsText))
const output = path.resolve(process.env.HAPI_QA_RESULTS ?? 'test-results/recent', label)
if (output === here || output.startsWith(here + path.sep)) throw new Error('Results must be outside harness sources')
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.mkdir(output, { recursive: false })
const harness = path.join(output, 'frozen-harness'), helpers = {}
await fs.mkdir(harness)
for (const file of ['run.mjs', 'driver.mjs', 'anchor-driver.mjs', 'probe.mjs', 'receipts.mjs', 'lifecycle.mjs']) {
    const bytes = await fs.readFile(path.join(here, file)); helpers[file] = createHash('sha256').update(bytes).digest('hex'); await fs.writeFile(path.join(harness, file), bytes)
}
await fs.writeFile(path.join(output, 'helper-manifest.json'), JSON.stringify(helpers, null, 2))
const sourceRoot = path.resolve(process.env.SOURCE_ROOT ?? path.join(here, '../../..'))
if (!process.env.HAPI_QA_BUILD) throw new Error('Set HAPI_QA_BUILD')
const build = path.resolve(process.env.HAPI_QA_BUILD)
const provenance = JSON.parse(await fs.readFile(path.join(build, 'qa-source-provenance.json')))
const assets = await tree(build); delete assets['qa-source-provenance.json']
verifyBuild(provenance, assets, await sourceManifest(sourceRoot, here))
for (const [file, hash] of Object.entries(helpers)) if (provenance.sources['harness/' + file] !== hash) throw new Error('Runtime helper differs from build receipt: ' + file)
await fs.writeFile(path.join(output, 'build-provenance.json'), JSON.stringify(provenance, null, 2))
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }
const server = http.createServer(async (request, response) => {
    try { const file = path.resolve(build, '.' + new URL(request.url, 'http://localhost').pathname); if (!file.startsWith(build + path.sep) || !(await fs.stat(file)).isFile()) throw new Error('not a static file'); response.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); createReadStream(file).pipe(response) } catch { response.writeHead(404); response.end('Not found') }
})
const status = { label, startedAt: new Date().toISOString(), pid: process.pid, build, sourceIdentity: provenance.sourceIdentity, cells, results: [], status: 'running' }
const save = () => fs.writeFile(path.join(output, 'status.json'), JSON.stringify(status, null, 2))
process.exitCode = await recordRun(status, save, async () => {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const url = `http://127.0.0.1:${server.address().port}`
    status.url = url
    for (const [index, cell] of cells.entries()) {
        const name = [index + 1, cell.count, cell.viewport, cell.entry, cell.mode, cell.cpu ? 'cpu' : 'nocpu'].join('-')
        const folder = path.join(output, name); await fs.mkdir(folder)
        const result = await runOwnedChild(process.execPath, [path.join(harness, cell.mode === 'anchor' ? 'anchor-driver.mjs' : 'driver.mjs'), JSON.stringify({ ...cell, sourceRoot, url, output: folder })], { stdio: 'inherit' }, {
            onSpawn: async child => { status.current = { name, pid: child.pid, startedAt: new Date().toISOString() }; await save() },
        })
        status.results.push({ name, ...result, endedAt: new Date().toISOString() })
        status.code = result.code; status.interrupted = result.interrupted
        await save()
        if (result.code) break
    }
}, async () => {
    server.closeAllConnections()
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})
