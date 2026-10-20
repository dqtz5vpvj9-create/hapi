import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ImagePreview } from './ImagePreview'
import { PaneContext, type PaneContextValue } from '@/workspace/PaneContext'

function renderGallery() {
    render(
        <>
            <ImagePreview src="/first.png" fileName="first.png" label="First image" />
            <ImagePreview src="/second.png" fileName="second.png" label="Second image" />
        </>
    )
}

describe('ImagePreview gallery navigation', () => {
    it('portals outside the clipped pane and excludes other pane galleries', () => {
        const { container } = render(<>
            <div data-pane-id="left">
                <ImagePreview src="/first.png" fileName="first.png" label="First image" />
                <ImagePreview src="/second.png" fileName="second.png" label="Second image" />
            </div>
            <div data-pane-id="right"><ImagePreview src="/other.png" fileName="other.png" label="Other pane" /></div>
        </>)
        fireEvent.click(screen.getByRole('button', { name: /first image/i }))
        const dialog = screen.getByRole('dialog', { name: 'First image' })
        expect(container.contains(dialog)).toBe(false)
        expect(within(dialog).getByText('1 / 2')).toBeInTheDocument()
        fireEvent.click(within(dialog).getByRole('button', { name: 'Next image' }))
        expect(screen.getByRole('dialog', { name: 'Second image' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Next image' })).toBeDisabled()
    })

    it('dismisses a portaled viewer before retaining its owning workspace', () => {
        const pane: PaneContextValue = { paneId: 'left', sessionId: 'chat', focused: true,
            root: { current: null }, navigate: vi.fn(), beforeHide: new Set() }
        const child = <ImagePreview src="/first.png" fileName="first.png" label="First image" />
        const view = render(<PaneContext.Provider value={pane}>{child}</PaneContext.Provider>)
        fireEvent.click(screen.getByRole('button', { name: /first image/i }))
        expect(screen.getByRole('dialog')).toBeInTheDocument()
        view.rerender(<PaneContext.Provider value={{ ...pane, focused: false }}>{child}</PaneContext.Provider>)
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        view.rerender(<PaneContext.Provider value={pane}>{child}</PaneContext.Provider>)
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('navigates between rendered image previews with toolbar buttons', () => {
        renderGallery()

        fireEvent.click(screen.getByRole('button', { name: /first image/i }))

        const dialog = screen.getByRole('dialog', { name: 'First image' })
        expect(within(dialog).getByText('1 / 2')).toBeInTheDocument()
        expect(within(dialog).getByRole('button', { name: 'Previous image' })).toBeDisabled()

        fireEvent.click(within(dialog).getByRole('button', { name: 'Next image' }))

        const nextDialog = screen.getByRole('dialog', { name: 'Second image' })
        expect(within(nextDialog).getByText('second.png')).toBeInTheDocument()
        expect(within(nextDialog).getByText('2 / 2')).toBeInTheDocument()
        expect(within(nextDialog).getByRole('img', { name: 'Second image' })).toHaveAttribute('src', '/second.png')
        expect(within(nextDialog).getByRole('button', { name: 'Next image' })).toBeDisabled()
    })

    it('supports left and right arrow keys', () => {
        renderGallery()

        fireEvent.click(screen.getByRole('button', { name: /first image/i }))
        fireEvent.keyDown(window, { key: 'ArrowRight' })
        expect(screen.getByRole('dialog', { name: 'Second image' })).toBeInTheDocument()

        fireEvent.keyDown(window, { key: 'ArrowLeft' })
        expect(screen.getByRole('dialog', { name: 'First image' })).toBeInTheDocument()
    })

    it('keeps named galleries separate from ungrouped previews', () => {
        render(
            <>
                <ImagePreview src="/sent.png" fileName="sent.png" label="Sent image" />
                <ImagePreview src="/draft-one.png" fileName="draft-one.png" label="First draft" galleryId="composer-attachments" />
                <ImagePreview src="/draft-two.png" fileName="draft-two.png" label="Second draft" galleryId="composer-attachments" />
            </>
        )

        fireEvent.click(screen.getByRole('button', { name: /first draft/i }))

        const dialog = screen.getByRole('dialog', { name: 'First draft' })
        expect(within(dialog).getByText('1 / 2')).toBeInTheDocument()
        fireEvent.click(within(dialog).getByRole('button', { name: 'Next image' }))
        expect(screen.getByRole('dialog', { name: 'Second draft' })).toBeInTheDocument()
        expect(within(screen.getByRole('dialog')).queryByRole('img', { name: 'Sent image' })).not.toBeInTheDocument()
    })

    it('exposes trigger pointer and context-menu hooks for sortable image attachments', () => {
        const onTriggerPointerDown = vi.fn()
        const onTriggerContextMenu = vi.fn()
        const onTriggerClick = vi.fn()

        render(
            <ImagePreview
                src="/drag.png"
                fileName="drag.png"
                label="Drag image"
                onTriggerPointerDown={onTriggerPointerDown}
                onTriggerContextMenu={onTriggerContextMenu}
                onTriggerClick={onTriggerClick}
            />
        )

        const trigger = screen.getByRole('button', { name: /drag image/i })
        fireEvent.pointerDown(trigger)
        fireEvent.contextMenu(trigger)
        fireEvent.click(trigger)

        expect(onTriggerPointerDown).toHaveBeenCalledTimes(1)
        expect(onTriggerContextMenu).toHaveBeenCalledTimes(1)
        expect(onTriggerClick).toHaveBeenCalledTimes(1)
        expect(screen.getByRole('dialog', { name: 'Drag image' })).toBeInTheDocument()
    })
})
