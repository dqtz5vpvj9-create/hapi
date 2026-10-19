import { describe, expect, it, vi } from 'vitest'
import { FileWorkbenchStore, MAX_FILE_TABS, registerFileWorkbench, fileWorkbenches } from './fileWorkbenchStore'
import { filePathSuffix, relocatedFilePath } from '@/documents/filePaths'

const ref = (path: string) => ({ kind: 'file' as const, path, machineId: 'machine-a' })
describe('file workbench references', () => {
    it('distinguishes same-basename files and restores selected tab without storing content', () => {
        const scope = crypto.randomUUID(), store = new FileWorkbenchStore(scope, 'session-a')
        const first = store.open(ref('/project/src/index.ts'))!
        const second = store.open(ref('/project/test/index.ts'))!
        expect(first).not.toBe(second)
        expect(store.open(ref('/project/src/./index.ts'))).toBe(first)
        const restored = new FileWorkbenchStore(scope, 'session-a')
        expect(restored.get().activeId).toBe(first)
        expect(restored.get().tabs).toHaveLength(2)
        expect(JSON.parse(localStorage.getItem(store.key)!)).not.toHaveProperty('text')
        expect(new FileWorkbenchStore(scope, 'session-b').get().tabs).toEqual([])
        expect(new FileWorkbenchStore(crypto.randomUUID(), 'session-a').get().tabs).toEqual([])
    })
    it('rejects another session and invalid document references in persisted tabs', () => {
        const scope = crypto.randomUUID(), store = new FileWorkbenchStore(scope, 'session-a')
        localStorage.setItem(store.key, JSON.stringify({ version: 1, tabs: [
            { id: 'foreign', resource: { sessionId: 'session-b', document: ref('/project/a') } },
            { id: 'bad', resource: { sessionId: 'session-a', document: { kind: 'script', path: 'javascript:alert(1)' } } },
        ], treeWidth: Infinity }))
        expect(new FileWorkbenchStore(scope, 'session-a').get()).toMatchObject({ tabs: [], activeId: null, treeWidth: 320 })
    })
    it('enforces tab capacity without evicting an open draft owner', () => {
        const store = new FileWorkbenchStore(crypto.randomUUID(), 'session-a')
        for (let index = 0; index < MAX_FILE_TABS; index++) store.open(ref(`/project/${index}.ts`))
        const before = store.get().tabs
        expect(store.open(ref('/project/overflow.ts'))).toBeUndefined()
        expect(store.get().tabs).toEqual(before)
        expect(store.get().error).toContain('Close a tab')
        expect(store.open(ref('/project/0.ts'))).toBe(before[0].id)
    })
    it('moves a directory subtree with stable tab identities and leaves siblings untouched', () => {
        const store = new FileWorkbenchStore(crypto.randomUUID(), 'session-a')
        const id = store.open(ref('/project/src/a.ts'))
        store.open(ref('/project/src/nested/b.ts'))
        store.open(ref('/project/src-other/c.ts'))
        store.relocate('/project/src', '/project/lib')
        expect(store.get().tabs.map(tab => tab.resource.document)).toEqual([
            ref('/project/lib/a.ts'), ref('/project/lib/nested/b.ts'), ref('/project/src-other/c.ts'),
        ])
        expect(store.get().tabs[0].id).toBe(id)
        expect(store.affected(['/project/lib'])).toHaveLength(2)
    })
    it('closes selected files deterministically and retains width when restoring', () => {
        const scope = crypto.randomUUID(), store = new FileWorkbenchStore(scope, 'session-a')
        const first = store.open(ref('/project/a'))!, second = store.open(ref('/project/b'))!, third = store.open(ref('/project/c'))!
        store.select(second); store.close([second])
        expect(store.get().activeId).toBe(third)
        store.reorder(third, first)
        expect(store.get().tabs.map(tab => tab.id)).toEqual([third, first])
        store.resize(360)
        expect(new FileWorkbenchStore(scope, 'session-a').get().treeWidth).toBe(360)
        store.close([first, third])
        expect(store.get().activeId).toBeNull()
    })
    it('retargets mounted readers of the same machine across sessions without changing another machine', () => {
        const registry = {}, scope = crypto.randomUUID()
        const current = new FileWorkbenchStore(scope, 'session-a'), sibling = new FileWorkbenchStore(scope, 'session-b')
        const other = new FileWorkbenchStore(scope, 'session-c')
        current.open(ref('/project/src/a')); sibling.open(ref('/project/src/a'))
        other.open({ ...ref('/project/src/a'), machineId: 'machine-b' })
        const releases = [current, sibling, other].map(store => registerFileWorkbench(registry, store))
        const owner = { sessionId: 'session-a', machineId: 'machine-a' }
        for (const store of fileWorkbenches(registry, current)) store.relocate('/project/src', '/project/lib', owner)
        expect(current.get().tabs[0].resource.document).toEqual(ref('/project/lib/a'))
        expect(sibling.get().tabs[0].resource.document).toEqual(ref('/project/lib/a'))
        expect(other.get().tabs[0].resource.document).toMatchObject({ path: '/project/src/a', machineId: 'machine-b' })
        for (const store of fileWorkbenches(registry, current)) store.close(store.affected(['/project/lib'], owner).map(tab => tab.id))
        expect(current.get().tabs).toEqual([]); expect(sibling.get().tabs).toEqual([])
        expect(other.get().tabs).toHaveLength(1)
        releases.forEach(release => release())
        expect([...fileWorkbenches(registry, current)].map(store => store.key)).toEqual([current.key, other.key])
    })
    it('reconciles an unmounted initiating store while another reader remains registered', () => {
        const registry = {}, scope = crypto.randomUUID()
        const initiating = new FileWorkbenchStore(scope, 'session-a'), visible = new FileWorkbenchStore(scope, 'session-b')
        initiating.open(ref('/project/old.txt')); visible.open(ref('/project/old.txt'))
        const release = registerFileWorkbench(registry, visible)
        for (const store of fileWorkbenches(registry, initiating)) store.relocate('/project/old.txt', '/project/new.txt')
        expect(new FileWorkbenchStore(scope, 'session-a').get().tabs[0].resource.document).toEqual(ref('/project/new.txt'))
        expect(visible.get().tabs[0].resource.document).toEqual(ref('/project/new.txt'))
        release()
    })
    it('settles an old operation against the latest layout after a replacement mount also unmounted', () => {
        const registry = {}, scope = crypto.randomUUID()
        const initiating = new FileWorkbenchStore(scope, 'session-a')
        const source = initiating.open(ref('/project/old.txt'))!
        const closed = initiating.open(ref('/project/closed.txt'))!
        const kept = initiating.open(ref('/project/kept.txt'))!
        registerFileWorkbench(registry, initiating)()

        const replacement = new FileWorkbenchStore(scope, 'session-a')
        const release = registerFileWorkbench(registry, replacement)
        replacement.close([closed])
        const added = replacement.open(ref('/project/added.txt'))!
        replacement.reorder(added, source)
        replacement.select(kept)
        replacement.resize(360)
        release()
        const before = localStorage.getItem(initiating.key)
        const readers = fileWorkbenches(registry, initiating)
        expect(localStorage.getItem(initiating.key)).toBe(before)
        for (const reader of readers) reader.relocate('/project/old.txt', '/project/new.txt', { sessionId: 'session-a', machineId: 'machine-a' })

        const restored = new FileWorkbenchStore(scope, 'session-a').get()
        expect(restored.tabs.map(tab => tab.id)).toEqual([added, source, kept])
        expect(restored.tabs.map(tab => tab.resource.document)).toEqual([
            ref('/project/added.txt'), ref('/project/new.txt'), ref('/project/kept.txt'),
        ])
        expect(restored).toMatchObject({ activeId: kept, treeWidth: 360 })
    })
    it('does not let an unmounted initiating instance resurrect tabs a live replacement closed', () => {
        const registry = {}, scope = crypto.randomUUID()
        const initiating = new FileWorkbenchStore(scope, 'session-a')
        const source = initiating.open(ref('/project/old.txt'))!
        const replacement = new FileWorkbenchStore(scope, 'session-a')
        replacement.close([source])
        replacement.open(ref('/project/current.txt'))
        const release = registerFileWorkbench(registry, replacement)
        const before = localStorage.getItem(replacement.key)
        try {
            for (const reader of fileWorkbenches(registry, initiating)) reader.relocate('/project/old.txt', '/project/new.txt')
            expect(localStorage.getItem(replacement.key)).toBe(before)
            expect(replacement.get().tabs.map(tab => tab.resource.document)).toEqual([ref('/project/current.txt')])
        } finally { release() }
    })
    it('updates every mounted reader of one key while preserving the last written layout', () => {
        const registry = {}, scope = crypto.randomUUID()
        const first = new FileWorkbenchStore(scope, 'session-a')
        first.open(ref('/project/old.txt'))
        const second = new FileWorkbenchStore(scope, 'session-a')
        const releases = [first, second].map(store => registerFileWorkbench(registry, store))
        second.open(ref('/project/only-in-second.txt'))
        // The latest registered reader is not necessarily the latest writer.
        const active = first.open(ref('/project/only-in-first.txt'))!
        first.resize(410)
        const notified = [vi.fn(), vi.fn()]
        const unsubscribe = [first, second].map((store, index) => store.subscribe(notified[index]))
        const owner = { sessionId: 'session-a', machineId: 'machine-a' }
        try {
            for (const reader of fileWorkbenches(registry, first)) reader.relocate('/project/old.txt', '/project/new.txt', owner)
            expect(first.get().tabs.map(tab => tab.resource.document)).toEqual([ref('/project/new.txt'), ref('/project/only-in-first.txt')])
            expect(second.get().tabs.map(tab => tab.resource.document)).toEqual([ref('/project/new.txt'), ref('/project/only-in-second.txt')])
            expect(new FileWorkbenchStore(scope, 'session-a').get()).toEqual(first.get())
            expect(first.get()).toMatchObject({ activeId: active, treeWidth: 410 })
            notified.forEach(notify => expect(notify).toHaveBeenCalledTimes(1))

            for (const reader of fileWorkbenches(registry, first)) reader.close(reader.affected(['/project/new.txt'], owner).map(tab => tab.id))
            expect(first.get().tabs.map(tab => tab.resource.document)).toEqual([ref('/project/only-in-first.txt')])
            expect(second.get().tabs.map(tab => tab.resource.document)).toEqual([ref('/project/only-in-second.txt')])
            expect(new FileWorkbenchStore(scope, 'session-a').get()).toEqual(first.get())
            notified.forEach(notify => expect(notify).toHaveBeenCalledTimes(2))
        } finally { releases.forEach(release => release()); unsubscribe.forEach(release => release()) }
    })
    it.each(['empty', 'missing'])('honors a newer %s durable layout without resurrecting old references', kind => {
        const scope = crypto.randomUUID(), initiating = new FileWorkbenchStore(scope, 'session-a')
        const id = initiating.open(ref('/project/old.txt'))!
        if (kind === 'empty') new FileWorkbenchStore(scope, 'session-a').close([id])
        else localStorage.removeItem(initiating.key)
        const before = localStorage.getItem(initiating.key)
        for (const reader of fileWorkbenches({}, initiating)) reader.relocate('/project/old.txt', '/project/new.txt')
        expect(localStorage.getItem(initiating.key)).toBe(before)
        expect(new FileWorkbenchStore(scope, 'session-a').get().tabs).toEqual([])
    })
    it('keeps all available memory references when storage cannot be read and never overwrites an unknown layout', () => {
        const registry = {}, scope = crypto.randomUUID(), storage = localStorage
        const initiating = new FileWorkbenchStore(scope, 'session-a')
        initiating.open(ref('/project/old.txt'))
        const first = new FileWorkbenchStore(scope, 'session-b')
        first.open(ref('/project/old.txt'))
        const second = new FileWorkbenchStore(scope, 'session-b')
        const releases = [first, second].map(store => registerFileWorkbench(registry, store))
        const write = vi.fn()
        vi.stubGlobal('localStorage', {
            getItem: () => { throw new DOMException('Unavailable', 'SecurityError') },
            setItem: write,
            get length() { return storage.length },
            key: (index: number) => storage.key(index),
        })
        try {
            for (const reader of fileWorkbenches(registry, initiating)) reader.relocate('/project/old.txt', '/project/new.txt')
            for (const store of [initiating, first, second]) expect(store.get().tabs[0].resource.document).toEqual(ref('/project/new.txt'))
            expect(write).not.toHaveBeenCalled()
        } finally { vi.unstubAllGlobals(); releases.forEach(release => release()) }
    })
    it('retains unwritten memory changes only while their durable baseline remains unchanged', () => {
        const scope = crypto.randomUUID(), storage = localStorage
        const initiating = new FileWorkbenchStore(scope, 'session-a')
        initiating.open(ref('/project/old.txt'))
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => storage.getItem(key),
            setItem: () => { throw new DOMException('Full', 'QuotaExceededError') },
            get length() { return storage.length },
            key: (index: number) => storage.key(index),
        })
        try {
            initiating.open(ref('/project/not-yet-persisted.txt'))
            for (const reader of fileWorkbenches({}, initiating)) reader.relocate('/project/not-yet-persisted.txt', '/project/renamed.txt')
            expect(initiating.get().tabs[1].resource.document).toEqual(ref('/project/renamed.txt'))
        } finally { vi.unstubAllGlobals() }

        const replacement = new FileWorkbenchStore(scope, 'session-a')
        replacement.open(ref('/project/newer-layout.txt'))
        for (const reader of fileWorkbenches({}, initiating)) reader.relocate('/project/old.txt', '/project/new.txt')
        expect(new FileWorkbenchStore(scope, 'session-a').get().tabs.map(tab => tab.resource.document)).toEqual([
            ref('/project/new.txt'), ref('/project/newer-layout.txt'),
        ])
    })
    it('retargets inactive persisted tabs without editing another account or machine', () => {
        const registry = {}, scope = crypto.randomUUID()
        const inactive = new FileWorkbenchStore(scope, 'session-a'), current = new FileWorkbenchStore(scope, 'session-b')
        const otherAccount = new FileWorkbenchStore(crypto.randomUUID(), 'session-a')
        const otherMachine = new FileWorkbenchStore(scope, 'session-c')
        inactive.open(ref('/project/old.txt')); current.open(ref('/project/old.txt'))
        otherAccount.open(ref('/project/old.txt')); otherMachine.open({ ...ref('/project/old.txt'), machineId: 'machine-b' })
        const releaseOtherAccount = registerFileWorkbench(registry, otherAccount)
        const owner = { sessionId: 'session-b', machineId: 'machine-a' }
        for (const store of fileWorkbenches(registry, current)) store.relocate('/project/old.txt', '/project/new.txt', owner)
        expect(new FileWorkbenchStore(scope, 'session-a').get().tabs[0].resource.document).toEqual(ref('/project/new.txt'))
        expect(new FileWorkbenchStore(otherAccount.scope, 'session-a').get().tabs[0].resource.document).toEqual(ref('/project/old.txt'))
        expect(new FileWorkbenchStore(scope, 'session-c').get().tabs[0].resource.document).toMatchObject({ path: '/project/old.txt', machineId: 'machine-b' })
        for (const store of fileWorkbenches(registry, current)) store.close(store.affected(['/project/new.txt'], owner).map(tab => tab.id))
        expect(new FileWorkbenchStore(scope, 'session-a').get().tabs).toEqual([])
        expect(otherAccount.get().tabs[0].resource.document).toEqual(ref('/project/old.txt'))
        releaseOtherAccount()
    })
})

describe('remote file path matching', () => {
    it('matches path components and Windows case without interpreting POSIX backslashes', () => {
        expect(filePathSuffix('/project/src-other/a', '/project/src')).toBeNull()
        expect(filePathSuffix('/project/src/a', '/project/src')).toBe('/a')
        expect(filePathSuffix('C:\\Project\\SRC\\File.ts', 'c:/project/src')).toBe('/File.ts')
        expect(relocatedFilePath('C:\\Project\\SRC\\File.ts', 'c:/project/src', 'C:\\Project\\lib')).toBe('C:/Project/lib/File.ts')
        expect(filePathSuffix('/project/a\\b/file', '/project/a')).toBeNull()
        expect(relocatedFilePath('/project/a\\b/file', '/project/a\\b', '/project/new')).toBe('/project/new/file')
    })
})
