import { describe, expect, it } from 'vitest'
import { fileManagerTargetFromPath, normalizeFileManagerTarget, parseSessionFilesSearch } from './session-files-navigation'

describe('session file-manager targets', () => {
    it.each([
        ['images/a.tar.gz', '/home/chris/project', 'images/a.tar.gz'],
        ['./images/a.custom', '/home/chris/project', 'images/a.custom'],
        ['/home/chris/project/images/a.tar.gz', '/home/chris/project', 'images/a.tar.gz'],
        ['/a.tar.gz', '/', 'a.tar.gz'],
        ['README', '/home/chris/project', 'README'],
        ['images/中文 #1%20.tar.gz', '/home/chris/project', 'images/中文 #1%20.tar.gz'],
        [String.raw`C:\Users\Chris\project\images\a.tar.gz`, String.raw`C:\Users\Chris\project`, 'images/a.tar.gz'],
        [String.raw`c:\users\chris\PROJECT\images\a.tar.gz`, 'C:/Users/Chris/project/', 'images/a.tar.gz'],
        [String.raw`images\a.tar.gz`, String.raw`C:\Users\Chris\project`, 'images/a.tar.gz'],
    ])('resolves %s against %s', (path, root, target) => {
        expect(fileManagerTargetFromPath(path, root)).toBe(target)
    })

    it.each(['../a.tar.gz', 'images/../../a.tar.gz', '/home/chris/other/a.tar.gz', '/home/chris/project-other/a.tar.gz',
        '/home/chris/project/../secret.tar.gz', 'javascript:alert(1)', 'https://example.com/a.tar.gz',
        String.raw`C:\other\a.tar.gz`, '//example.com/a.tar.gz', String.raw`\\server\a.tar.gz`, 'a\u0000.tar.gz'])('rejects unsafe %s', path => {
        expect(fileManagerTargetFromPath(path, '/home/chris/project')).toBeUndefined()
    })

    it('needs session metadata before turning an unknown path into navigation', () => {
        expect(fileManagerTargetFromPath('a.tar.gz', null)).toBeUndefined()
    })

    it('validates direct route input without treating percent signs as another encoding layer', () => {
        expect(parseSessionFilesSearch({ tab: 'directories', target: './images/a%20.tar.gz' })).toEqual({ tab: 'directories', target: 'images/a%20.tar.gz' })
        expect(parseSessionFilesSearch({ tab: 'directories', target: '../secret', query: 'hello' })).toEqual({ tab: 'directories', query: 'hello' })
        expect(normalizeFileManagerTarget('/etc/passwd')).toBeUndefined()
        expect(normalizeFileManagerTarget('')).toBeUndefined()
        expect(normalizeFileManagerTarget('a'.repeat(8193))).toBeUndefined()
    })
})
