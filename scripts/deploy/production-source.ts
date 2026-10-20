import {
    chmodSync,
    copyFileSync,
    lstatSync,
    mkdirSync,
    readlinkSync,
    symlinkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export function copySourceFiles(repository: string, destination: string, paths: readonly string[]): void {
    for (const path of paths) {
        const source = join(repository, path)
        let sourceInfo
        try {
            sourceInfo = lstatSync(source)
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'ENOENT') continue
            throw error
        }

        const target = join(destination, path)
        mkdirSync(dirname(target), { recursive: true })
        if (sourceInfo.isSymbolicLink()) {
            symlinkSync(readlinkSync(source), target)
            continue
        }
        if (!sourceInfo.isFile()) continue
        copyFileSync(source, target)
        chmodSync(target, sourceInfo.mode)
    }
}
