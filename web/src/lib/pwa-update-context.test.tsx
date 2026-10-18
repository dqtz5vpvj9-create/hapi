import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PwaUpdateProvider, usePwaUpdateContext } from './pwa-update-context'

const mocks = vi.hoisted(() => ({
    native: false,
    bundled: true,
    browser: vi.fn(() => ({ needRefresh: false, reload: vi.fn() })),
    mobile: vi.fn(() => ({ native: true, needRefresh: true, reload: vi.fn(), status: 'available' as 'available' | 'applying' })),
}))
vi.mock('@/lib/platform', () => ({ isNativePlatform: () => mocks.native, isBundledNativePlatform: () => mocks.native && mocks.bundled }))
vi.mock('@/hooks/usePwaUpdate', () => ({ usePwaUpdate: mocks.browser }))
vi.mock('@/hooks/useNativeUpdate', () => ({ useNativeUpdate: mocks.mobile }))

function Status() {
    const update = usePwaUpdateContext()
    return <output>{update.native ? 'native' : 'browser'}:{String(update.needRefresh)}</output>
}

describe('update provider', () => {
    beforeEach(() => { vi.clearAllMocks(); mocks.bundled = true })
    it('keeps browser users on the existing service-worker update flow', () => {
        mocks.native = false
        render(<PwaUpdateProvider><Status /></PwaUpdateProvider>)
        expect(screen.getByText('browser:false')).toBeInTheDocument()
        expect(mocks.browser).toHaveBeenCalledOnce()
        expect(mocks.mobile).not.toHaveBeenCalled()
    })
    it('uses the website update flow in a hosted native shell', () => {
        mocks.native = true
        mocks.bundled = false
        render(<PwaUpdateProvider><Status /></PwaUpdateProvider>)
        expect(mocks.browser).toHaveBeenCalledOnce()
        expect(mocks.mobile).not.toHaveBeenCalled()
    })
    it('uses the native updater without mounting a service-worker hook', () => {
        mocks.native = true
        render(<PwaUpdateProvider><Status /></PwaUpdateProvider>)
        expect(screen.getByText('native:true')).toBeInTheDocument()
        expect(mocks.mobile).toHaveBeenCalledOnce()
        expect(mocks.browser).not.toHaveBeenCalled()
    })
    it('prevents further edits while draft preparation and activation are in progress', () => {
        mocks.native = true
        mocks.mobile.mockReturnValueOnce({ native: true, needRefresh: false, reload: vi.fn(), status: 'applying' })
        render(<PwaUpdateProvider><Status /></PwaUpdateProvider>)
        expect(screen.getByText('native:false').parentElement).toHaveAttribute('inert')
    })
})
