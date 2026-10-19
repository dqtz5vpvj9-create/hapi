import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import type { DirectorySort } from '@/lib/directory-sort'
import { FileManagementToolbar } from './FileManagementToolbar'

function setup(options: { busy?: boolean; selectionCount?: number; canManage?: boolean } = {}) {
    const actions = {
        newFile: vi.fn(), newFolder: vi.fn(), upload: vi.fn(), uploadFolder: vi.fn(),
        refresh: vi.fn(), collapse: vi.fn(), select: vi.fn(), copyPaths: vi.fn(),
        move: vi.fn(), copy: vi.fn(), delete: vi.fn(), done: vi.fn(),
        sort: vi.fn(), exclude: vi.fn(),
    }
    function Fixture(props: { foreground?: boolean }) {
        const [sort, setSort] = useState<DirectorySort>({ field: 'name', direction: 'asc' })
        const [showHidden, setShowHidden] = useState(false)
        const [exclude, setExclude] = useState<string[]>([])
        const [query, setQuery] = useState('')
        return <FileManagementToolbar
            canManage={options.canManage !== false} busy={options.busy ?? false} foreground={props.foreground}
            query={query} onQueryChange={setQuery} sort={sort}
            onSortChange={next => { actions.sort(next); setSort(next) }}
            showHidden={showHidden} onShowHidden={() => setShowHidden(value => !value)}
            exclude={exclude} onExclude={next => { actions.exclude(next); setExclude(next) }}
            onNewFile={actions.newFile} onNewFolder={actions.newFolder}
            onUpload={actions.upload} onUploadFolder={actions.uploadFolder}
            onRefresh={actions.refresh} onCollapse={actions.collapse} onStartSelection={actions.select}
            selection={options.selectionCount === undefined ? undefined : {
                count: options.selectionCount, onCopyPaths: actions.copyPaths,
                onMove: actions.move, onCopy: actions.copy, onDelete: actions.delete, onDone: actions.done,
            }}
        />
    }
    const rendered = render(<I18nProvider><Fixture /></I18nProvider>)
    return { ...actions, setForeground: (foreground: boolean) => rendered.rerender(<I18nProvider><Fixture foreground={foreground} /></I18nProvider>) }
}

beforeEach(() => { window.localStorage.clear() })
afterEach(cleanup)

const openOptions = () => fireEvent.click(screen.getByRole('button', { name: 'File browser options' }))

describe('FileManagementToolbar', () => {
    it.each([
        ['New file', 'newFile'], ['New folder', 'newFolder'],
        ['Upload files', 'upload'], ['Upload folder', 'uploadFolder'],
    ] as const)('keeps %s reachable in the compact New menu', (label, action) => {
        const actions = setup()
        expect(screen.queryByRole('menu')).toBeNull()
        expect(screen.getByRole('textbox', { name: 'Search files' })).toBeVisible()
        fireEvent.click(screen.getByRole('button', { name: 'New' }))
        fireEvent.click(screen.getByRole('menuitem', { name: label }))
        expect(actions[action]).toHaveBeenCalledOnce()
        expect(screen.queryByRole('menu')).toBeNull()
    })

    it('keeps sort direction, hidden entries, refresh and collapse usable from one options menu', () => {
        const actions = setup()
        openOptions()
        fireEvent.click(screen.getByRole('menuitem', { name: 'Sort files' }))
        fireEvent.click(screen.getByRole('menuitemradio', { name: 'Modified time' }))
        fireEvent.click(screen.getByRole('menuitemradio', { name: 'Newest first' }))
        expect(actions.sort).toHaveBeenLastCalledWith({ field: 'modified', direction: 'desc' })
        expect(screen.getByRole('menuitemradio', { name: 'Newest first' })).toHaveAttribute('aria-checked', 'true')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Back to file options' }))
        const hidden = screen.getByRole('menuitemcheckbox', { name: 'Show hidden files' })
        fireEvent.click(hidden)
        expect(hidden).toHaveAttribute('aria-checked', 'true')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh filesystem view' }))
        expect(actions.refresh).toHaveBeenCalledOnce()
        expect(screen.queryByRole('menu')).toBeNull()
        openOptions()
        fireEvent.click(screen.getByRole('menuitem', { name: 'Collapse folders' }))
        expect(actions.collapse).toHaveBeenCalledOnce()
    })

    it('applies filters and reopens their existing value for editing or clearing', () => {
        const actions = setup()
        openOptions()
        fireEvent.click(screen.getByRole('menuitem', { name: 'File filters' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Exclude patterns' }), { target: { value: 'node_modules, **/dist,  *.log ' } })
        fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))
        expect(actions.exclude).toHaveBeenLastCalledWith(['node_modules', '**/dist', '*.log'])
        openOptions()
        fireEvent.click(screen.getByRole('menuitem', { name: /File filters/ }))
        expect(screen.getByRole('textbox', { name: 'Exclude patterns' })).toHaveValue('node_modules, **/dist, *.log')
        fireEvent.change(screen.getByRole('textbox', { name: 'Exclude patterns' }), { target: { value: '' } })
        fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))
        expect(actions.exclude).toHaveBeenLastCalledWith([])
    })

    it('offers selection explicitly and replaces browsing controls with a count and contextual actions', () => {
        const actions = setup()
        openOptions()
        fireEvent.click(screen.getByRole('menuitem', { name: 'Select items' }))
        expect(actions.select).toHaveBeenCalledOnce()
        cleanup()
        const selection = setup({ selectionCount: 2 })
        expect(screen.getAllByRole('toolbar')).toHaveLength(1)
        expect(screen.getByRole('status')).toHaveTextContent('2 selected')
        expect(screen.queryByRole('textbox')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Selected file actions' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Copy selected paths' }))
        expect(selection.copyPaths).toHaveBeenCalledOnce()
        fireEvent.click(screen.getByRole('button', { name: 'Done' }))
        expect(selection.done).toHaveBeenCalledOnce()
    })

    it('keeps selection operations disabled for an empty selection or a pending mutation', () => {
        setup({ selectionCount: 0 })
        expect(screen.getByRole('button', { name: 'Selected file actions' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled()
        cleanup()
        setup({ selectionCount: 2, busy: true })
        fireEvent.click(screen.getByRole('button', { name: 'Selected file actions' }))
        for (const name of ['Move selected', 'Copy selected', 'Delete selected']) {
            expect(screen.getByRole('menuitem', { name })).toBeDisabled()
        }
        expect(screen.getByRole('menuitem', { name: 'Copy selected paths' })).toBeEnabled()
    })

    it('closes a parked pane menu without moving focus back to its hidden trigger', async () => {
        const fixture = setup()
        openOptions()
        screen.getByRole('menuitem', { name: 'Sort files' }).focus()
        fixture.setForeground(false)
        await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
        expect(screen.getByRole('button', { name: 'File browser options' })).not.toHaveFocus()
        fixture.setForeground(true)
        expect(screen.queryByRole('menu')).toBeNull()
    })

    it('supports keyboard traversal across option groups', () => {
        setup()
        openOptions()
        const menu = screen.getByRole('menu', { name: 'File browser options' })
        const refresh = screen.getByRole('menuitem', { name: 'Refresh filesystem view' })
        refresh.focus()
        fireEvent.keyDown(menu, { key: 'ArrowDown' })
        expect(screen.getByRole('menuitem', { name: 'Sort files' })).toHaveFocus()
        fireEvent.keyDown(menu, { key: 'End' })
        expect(screen.getByRole('menuitem', { name: 'Select items' })).toHaveFocus()
        fireEvent.keyDown(menu, { key: 'Home' })
        expect(refresh).toHaveFocus()
    })
})
