import { describe, expect, it } from 'vitest'
import { fileManagerDestination, fileManagerDropItems, isHiddenFileManagerPath, matchesFileManagerExclude, topLevelFileManagerPaths } from './file-manager-paths'

describe('file manager navigation and selection boundaries', () => {
    it('keeps similarly prefixed siblings when reducing a selected subtree', () => {
        expect(topLevelFileManagerPaths(['src', 'src/a.ts', 'src-other/a.ts', 'src2', 'src'])).toEqual(['src', 'src2', 'src-other/a.ts'])
        expect(topLevelFileManagerPaths(['SRC', 'src/a.ts'], true)).toEqual(['SRC'])
    })
    it.each(['/etc/file', '../file', 'src/../../file', 'C:/file', 'src\\file', 'https://host/file'])('rejects destination %s', path => {
        expect(fileManagerDestination(path)).toBeUndefined()
    })
    it('identifies hidden ancestors without treating middle dots as hidden', () => {
        expect(isHiddenFileManagerPath('src/.cache/result.txt')).toBe(true)
        expect(isHiddenFileManagerPath('src/app.test.ts')).toBe(false)
    })
    it('uses bounded literal-aware globs consistently for folder trees and search results', () => {
        expect(matchesFileManagerExclude('node_modules/pkg/index.js', ['node_modules'])).toBe(true)
        expect(matchesFileManagerExclude('src/dist/app.js', ['**/dist'])).toBe(true)
        expect(matchesFileManagerExclude('src/a.log', ['*.log'])).toBe(true)
        expect(matchesFileManagerExclude('src/a.ts', ['*.log'])).toBe(false)
        expect(matchesFileManagerExclude('src/[draft]/a.txt', ['src/[draft]'])).toBe(true)
        expect(matchesFileManagerExclude('src/d/a.txt', ['src/[draft]'])).toBe(false)
    })
})

describe('dropped folder collection', () => {
    it('captures entries during dispatch, drains directory batches and preserves nested paths', async () => {
        let dispatchActive = true
        const file = (name: string) => ({ name, isFile: true, isDirectory: false, file: (done: (file: File) => void) => done(new File([name], name)) }) as FileSystemFileEntry
        const batches = [[file('one.txt')], [file('two.txt')], []]
        let reads = 0
        const directory = { name: 'picked', isFile: false, isDirectory: true, createReader: () => ({ readEntries: (done: (entries: FileSystemEntry[]) => void) => { reads++; queueMicrotask(() => done(batches.shift()!)) } }) } as unknown as FileSystemDirectoryEntry
        const data = { items: [{ kind: 'file', webkitGetAsEntry: () => { expect(dispatchActive).toBe(true); return directory } }], files: [] } as unknown as DataTransfer
        const result = fileManagerDropItems(data)
        dispatchActive = false
        expect((await result).map(item => item.relativePath)).toEqual(['picked/one.txt', 'picked/two.txt'])
        expect(reads).toBe(3)
    })
})
