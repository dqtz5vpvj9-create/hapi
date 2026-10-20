import { afterAll, describe, expect, test } from 'bun:test'
import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { copySourceFiles } from './production-source'

const fixtureRoot = mkdtempSync('/mnt/cache/data-cache/hapi-deploy-source-test-')
const repository = join(fixtureRoot, 'repository')
const destination = join(fixtureRoot, 'destination')

afterAll(() => rmSync(fixtureRoot, { recursive: true }))

describe('copySourceFiles', () => {
    test('copies regular files and preserves relative symbolic links', () => {
        mkdirSync(join(repository, 'cli'), { recursive: true })
        writeFileSync(join(repository, 'shared-rules.md'), 'shared rules\n')
        writeFileSync(join(repository, 'cli/index.ts'), 'export {}\n')
        symlinkSync('../shared-rules.md', join(repository, 'cli/.cursorrules'))

        copySourceFiles(repository, destination, [
            'shared-rules.md',
            'cli/index.ts',
            'cli/.cursorrules',
            'removed-file.ts',
        ])

        expect(readFileSync(join(destination, 'cli/index.ts'), 'utf8')).toBe('export {}\n')
        expect(lstatSync(join(destination, 'cli/.cursorrules')).isSymbolicLink()).toBe(true)
        expect(readlinkSync(join(destination, 'cli/.cursorrules'))).toBe('../shared-rules.md')
        expect(readFileSync(join(destination, 'cli/.cursorrules'), 'utf8')).toBe('shared rules\n')
    })
})
