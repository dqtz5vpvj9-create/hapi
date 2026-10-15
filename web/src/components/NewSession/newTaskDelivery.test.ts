import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { createNewTaskDelivery, loadNewTaskDelivery, saveNewTaskDelivery, sendNewTaskDelivery } from './newTaskDelivery'

describe('new task delivery identity', () => {
    beforeEach(() => { sessionStorage.clear(); saveNewTaskDelivery('test', null) })
    it('keeps the frozen launch, text and message identity across reloads', () => {
        const delivery = createNewTaskDelivery('Inspect this project', ['file-1'])
        delivery.launch = { machineId: 'machine', directory: '/project', requestId: delivery.requestId, model: 'model-live' }
        delivery.sessionId = 'session-1'
        saveNewTaskDelivery('test', delivery)
        expect(loadNewTaskDelivery('test')).toEqual(delivery)
    })
    it('retries a failed send with the same session, body, attachments and localId', async () => {
        const sendMessage = vi.fn().mockRejectedValueOnce(new Error('Network timeout')).mockResolvedValueOnce(undefined)
        const api = { sendMessage } as unknown as ApiClient
        const delivery = { ...createNewTaskDelivery('Do the task', []), sessionId: 'created-session' }
        await expect(sendNewTaskDelivery(api, delivery, undefined)).rejects.toThrow('Network timeout')
        await sendNewTaskDelivery(api, delivery, undefined)
        expect(sendMessage.mock.calls[0]).toEqual(sendMessage.mock.calls[1])
        expect(sendMessage).toHaveBeenLastCalledWith('created-session', 'Do the task', delivery.localId, undefined)
    })
    it('never sends before the real session is known', async () => {
        const sendMessage = vi.fn()
        await expect(sendNewTaskDelivery({ sendMessage } as unknown as ApiClient, createNewTaskDelivery('draft', []), undefined)).rejects.toThrow('not ready')
        expect(sendMessage).not.toHaveBeenCalled()
    })
    it('clears a confirmed delivery', () => {
        saveNewTaskDelivery('test', createNewTaskDelivery('draft', []))
        saveNewTaskDelivery('test', null)
        expect(loadNewTaskDelivery('test')).toBeNull()
    })
})
