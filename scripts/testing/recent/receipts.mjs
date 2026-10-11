import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const identity = manifest => sha256(JSON.stringify(Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)))))
export async function tree(root, folder = '') {
    const result = {}
    for (const entry of (await fs.readdir(path.join(root, folder), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        const relative = path.join(folder, entry.name)
        if (entry.isDirectory()) Object.assign(result, await tree(root, relative))
        else if (entry.isFile()) result[relative] = sha256(await fs.readFile(path.join(root, relative)))
    }
    return result
}
export function changed(before, after) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file]).sort()
}
export function validateCells(cells) {
    if (!Array.isArray(cells) || !cells.length || cells.length > 30) throw new Error('Expected 1–30 cells')
    for (const cell of cells) {
        if (!cell || !Number.isInteger(cell.count) || cell.count < 4 || cell.count > 5000 || !['phone', 'desktop'].includes(cell.viewport) || !['saved', 'ui'].includes(cell.entry) || !['full', 'lean', 'anchor'].includes(cell.mode) || typeof cell.cpu !== 'boolean') throw new Error('Invalid count/viewport/entry/mode/cpu')
        if (cell.mode === 'anchor' && (cell.entry !== 'saved' || cell.cpu || cell.count < 100)) throw new Error('Anchor requires at least 100 roots, saved entry and no CPU profiling')
    }
    return cells
}
export async function sourceManifest(repo, harnessRoot) {
    const result = {}
    for (const folder of ['web/src', 'web/e2e-fixtures', 'web/public', 'shared/src']) for (const [file, hash] of Object.entries(await tree(path.join(repo, folder)))) result[folder + '/' + file] = hash
    for (const file of ['web/vite.config.ts', 'web/package.json', 'package.json', 'bun.lock']) result[file] = sha256(await fs.readFile(path.join(repo, file)))
    for (const [file, hash] of Object.entries(await tree(harnessRoot))) result['harness/' + file] = hash
    return result
}
export function verifyBuild(receipt, assets, currentSources) {
    if (receipt.code || receipt.timedOut || receipt.interrupted || receipt.changedDuringBuild.length) throw new Error('Unclean build')
    if (identity(receipt.sources) !== receipt.sourceIdentity || identity(assets) !== receipt.assetIdentity || changed(receipt.assets, assets).length) throw new Error('Source receipt or build assets changed')
    const drift = changed(receipt.sources, currentSources)
    if (drift.length) throw new Error('Current source/helper drift; rebuild before running: ' + drift.join(', '))
}
