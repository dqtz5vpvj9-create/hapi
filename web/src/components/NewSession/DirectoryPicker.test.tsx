import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { MachineListDirectoryResponse } from '@/types/api'
import { DirectoryPicker } from './DirectoryPicker'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string, params?: Record<string, string | number>) => {
            if (params?.name) return `${key}:${params.name}`
            if (params?.count !== undefined) return `${key}:${params.count}`
            return key
        }
    })
}))

function makeApi(entriesByPath: Record<string, MachineListDirectoryResponse['entries']>) {
    return {
        listMachineDirectory: vi.fn(async (_machineId: string, path: string) => {
            const entries = entriesByPath[path]
            if (!entries) return { success: false as const, error: 'ENOENT' }
            return { success: true as const, entries }
        })
    } as unknown as ApiClient & { listMachineDirectory: ReturnType<typeof vi.fn> }
}

describe('DirectoryPicker', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('lists subfolders of the current directory and navigates into one', async () => {
        const api = makeApi({
            '/work': [
                { name: 'b-project', type: 'directory' },
                { name: 'a-project', type: 'directory', isGitRepo: true },
                { name: 'readme.md', type: 'file' }
            ],
            '/work/a-project': [{ name: 'packages', type: 'directory' }]
        })

        render(
            <DirectoryPicker
                api={api}
                machineId="machine-1"
                workspaceRoots={['/work']}
                initialPath="/work"
                recentPaths={[]}
                onSelect={vi.fn()}
            />
        )

        expect(await screen.findByTitle('/work/a-project')).toBeInTheDocument()
        expect(screen.queryByText('readme.md')).not.toBeInTheDocument()
        expect(api.listMachineDirectory).toHaveBeenCalledWith('machine-1', '/work', { includeHidden: false })

        fireEvent.click(screen.getByTitle('/work/a-project'))
        expect(await screen.findByTitle('/work/a-project/packages')).toBeInTheDocument()
    })

    it('falls back to the first workspace root when no initial path is set', async () => {
        const api = makeApi({ '/work': [{ name: 'repo', type: 'directory' }] })

        render(
            <DirectoryPicker
                api={api}
                machineId="machine-1"
                workspaceRoots={['/work']}
                initialPath=""
                recentPaths={[]}
                onSelect={vi.fn()}
            />
        )

        expect(await screen.findByTitle('/work/repo')).toBeInTheDocument()
        expect(api.listMachineDirectory).toHaveBeenCalledWith('machine-1', '/work', { includeHidden: false })
    })

    it('resumes the folder chosen last time on this machine when no initial path is set', async () => {
        localStorage.setItem('hapi:directoryPicker:lastPath', JSON.stringify({ 'machine-1': '/work/repo' }))
        const api = makeApi({
            '/work': [{ name: 'repo', type: 'directory' }],
            '/work/repo': [{ name: 'packages', type: 'directory' }]
        })

        render(
            <DirectoryPicker
                api={api}
                machineId="machine-1"
                workspaceRoots={['/work']}
                initialPath=""
                recentPaths={['/work']}
                onSelect={vi.fn()}
            />
        )

        expect(await screen.findByTitle('/work/repo/packages')).toBeInTheDocument()
        expect(api.listMachineDirectory).toHaveBeenCalledWith('machine-1', '/work/repo', { includeHidden: false })
    })

    it('commits the browsed directory only when confirmed', async () => {
        const onSelect = vi.fn()
        const api = makeApi({
            '/work': [{ name: 'repo', type: 'directory' }],
            '/work/repo': []
        })

        render(
            <DirectoryPicker
                api={api}
                machineId="machine-1"
                workspaceRoots={['/work']}
                initialPath="/work"
                recentPaths={[]}
                onSelect={onSelect}
            />
        )

        fireEvent.click(await screen.findByTitle('/work/repo'))
        await waitFor(() => expect(api.listMachineDirectory).toHaveBeenCalledWith('machine-1', '/work/repo', { includeHidden: false }))
        expect(onSelect).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: /directoryPicker\.selectNamed/ }))
        expect(onSelect).toHaveBeenCalledWith('/work/repo')
    })

    it('commits the typed path even before the listing is loaded', async () => {
        const onSelect = vi.fn()
        const api = makeApi({ '/work': [{ name: 'repo', type: 'directory' }] })

        render(
            <DirectoryPicker
                api={api}
                machineId="machine-1"
                workspaceRoots={['/work']}
                initialPath="/work"
                recentPaths={[]}
                onSelect={onSelect}
            />
        )

        const input = await screen.findByLabelText('newSession.directory')
        fireEvent.change(input, { target: { value: '/work/fresh-project' } })
        expect(screen.getByText('directoryPicker.pressEnter')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /directoryPicker\.selectNamed/ }))
        expect(onSelect).toHaveBeenCalledWith('/work/fresh-project')
    })

    it('loads a typed absolute path on Enter instead of requiring a folder click', async () => {
        const api = makeApi({
            '/work': [{ name: 'repo', type: 'directory' }],
            '/home/chris/hapi': [{ name: 'web', type: 'directory' }]
        })

        render(
            <DirectoryPicker
                api={api}
                machineId="machine-1"
                workspaceRoots={['/work']}
                initialPath="/work"
                recentPaths={[]}
                onSelect={vi.fn()}
            />
        )

        const input = await screen.findByLabelText('newSession.directory')
        fireEvent.change(input, { target: { value: '/home/chris/hapi' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        expect(await screen.findByTitle('/home/chris/hapi/web')).toBeInTheDocument()
    })

    it('navigates up from the parent row', async () => {
        const api = makeApi({
            '/work': [{ name: 'repo', type: 'directory' }],
            '/work/repo': [{ name: 'packages', type: 'directory' }]
        })

        render(
            <DirectoryPicker
                api={api}
                machineId="machine-1"
                workspaceRoots={['/work']}
                initialPath="/work/repo"
                recentPaths={[]}
                onSelect={vi.fn()}
            />
        )

        fireEvent.click(await screen.findByTitle('/work'))
        expect(await screen.findByTitle('/work/repo')).toBeInTheDocument()
    })

    it('filters the folder list and supports keyboard navigation', async () => {
        const api = makeApi({
            '/work': [
                { name: 'alpha', type: 'directory' },
                { name: 'beta', type: 'directory' }
            ],
            '/work/beta': [{ name: 'packages', type: 'directory' }]
        })

        render(
            <DirectoryPicker
                api={api}
                machineId="machine-1"
                workspaceRoots={['/work']}
                initialPath="/work"
                recentPaths={[]}
                onSelect={vi.fn()}
            />
        )

        await screen.findByTitle('/work/alpha')
        const filter = screen.getByLabelText('directoryPicker.filter')
        fireEvent.change(filter, { target: { value: 'bet' } })
        expect(screen.queryByTitle('/work/alpha')).not.toBeInTheDocument()
        expect(screen.getByText('directoryPicker.count:1')).toBeInTheDocument()

        fireEvent.keyDown(filter, { key: 'ArrowDown' })
        fireEvent.keyDown(filter, { key: 'Enter' })

        expect(await screen.findByTitle('/work/beta/packages')).toBeInTheDocument()
    })

    it('opens the first search match when Enter is pressed without an arrow key', async () => {
        const api = makeApi({
            '/work': [
                { name: 'alpha', type: 'directory' },
                { name: 'beta', type: 'directory' }
            ],
            '/work/beta': [{ name: 'packages', type: 'directory' }]
        })

        render(
            <DirectoryPicker
                api={api}
                machineId="machine-1"
                workspaceRoots={['/work']}
                initialPath="/work"
                recentPaths={[]}
                onSelect={vi.fn()}
            />
        )

        await screen.findByTitle('/work/alpha')
        const filter = screen.getByLabelText('directoryPicker.filter')
        fireEvent.change(filter, { target: { value: 'bet' } })
        fireEvent.keyDown(filter, { key: 'Enter' })

        expect(await screen.findByTitle('/work/beta/packages')).toBeInTheDocument()
    })

    it('remembers the chosen directory for next time', async () => {
        const api = makeApi({
            '/work': [{ name: 'repo', type: 'directory' }],
            '/work/repo': []
        })

        render(
            <DirectoryPicker
                api={api}
                machineId="machine-1"
                workspaceRoots={['/work']}
                initialPath="/work"
                recentPaths={[]}
                onSelect={vi.fn()}
            />
        )

        fireEvent.click(await screen.findByTitle('/work/repo'))
        await waitFor(() => expect(api.listMachineDirectory).toHaveBeenCalledWith('machine-1', '/work/repo', { includeHidden: false }))
        fireEvent.click(screen.getByRole('button', { name: /directoryPicker\.selectNamed/ }))

        await waitFor(() => {
            const stored = JSON.parse(localStorage.getItem('hapi:directoryPicker:lastPath') ?? '{}')
            expect(stored['machine-1']).toBe('/work/repo')
        })
    })

    it('surfaces listing errors and keeps the path editable', async () => {
        const api = makeApi({})

        render(
            <DirectoryPicker
                api={api}
                machineId="machine-1"
                workspaceRoots={['/work']}
                initialPath="/missing"
                recentPaths={[]}
                onSelect={vi.fn()}
            />
        )

        expect(await screen.findByText('ENOENT')).toBeInTheDocument()
        expect(screen.getByLabelText('newSession.directory')).toHaveValue('/missing')
    })

    it('asks for a machine instead of rendering an empty browser', () => {
        render(
            <DirectoryPicker
                api={makeApi({})}
                machineId={null}
                workspaceRoots={[]}
                initialPath=""
                recentPaths={[]}
                onSelect={vi.fn()}
            />
        )

        expect(screen.getByText('directoryPicker.noMachine')).toBeInTheDocument()
    })
})
