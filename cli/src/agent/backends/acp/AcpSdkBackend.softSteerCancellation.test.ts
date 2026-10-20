import { describe, expect, it, vi } from 'vitest'

const gate = vi.hoisted(() => {
    let release!: () => void
    const promise = new Promise<void>(resolve => { release = resolve })
    return { promise, release }
})

vi.mock('./promptImages', () => ({
    prepareAcpPrompt: vi.fn(async () => {
        await gate.promise
        return { prompt: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }], warnings: [] }
    }),
}))

import { AcpSdkBackend } from './AcpSdkBackend'

describe('AcpSdkBackend soft-steer cancellation', () => {
    it('does not dispatch a prepared attachment after the turn was cancelled', async () => {
        const dispatch = vi.fn(() => ({
            dispatched: Promise.resolve(),
            completed: Promise.resolve({ stopReason: 'end_turn' }),
        }))
        const backend = new AcpSdkBackend({ command: 'agent' })
        const internal = backend as unknown as {
            isProcessingMessage: boolean
            transport: { sendRequestWithDispatch: typeof dispatch; close: () => Promise<void> } | null
        }
        internal.isProcessingMessage = true
        internal.transport = { sendRequestWithDispatch: dispatch, close: async () => {} }

        const { dispatched, completed } = backend.beginSoftSteerPrompt('session-1', [
            { type: 'image', mimeType: 'image/png', data: 'AA==' },
        ])
        backend.abortSoftSteers()
        gate.release()

        await expect(dispatched).rejects.toThrow(/cancelled/)
        await expect(completed).rejects.toThrow(/cancelled/)
        expect(dispatch).not.toHaveBeenCalled()
    })
})
