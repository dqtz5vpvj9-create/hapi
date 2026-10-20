import { describe, expect, it, vi } from 'vitest'
import type { AcpConfigOptionDescriptor, AcpSdkBackend } from '@/agent/backends/acp/AcpSdkBackend'
import { DshSessionConfig } from './dshSessionConfig'

function fixture() {
    let options: AcpConfigOptionDescriptor[] = [
        { id: 'model', category: 'model', currentValue: '["provider","a"]', options: [{ value: '["provider","a"]' }, { value: '["provider","b"]' }] },
        { id: 'reasoning_effort', category: 'thought_level', currentValue: '', options: [{ value: '' }, { value: 'high' }] }
    ]
    let listener: ((id: string, options: AcpConfigOptionDescriptor[]) => void) | null = null
    const backend = {
        getConfigOptionByCategory: (_id: string, category: string) => options.find((entry) => entry.category === category),
        getSessionConfigOptions: () => options,
        setSessionConfigOptionsListener: (value: typeof listener) => { listener = value },
        setConfigOption: vi.fn(async (_id: string, configId: string, value: string, _opts: unknown) => {
            options = options.map((entry) => entry.id === configId ? { ...entry, currentValue: value } : entry)
            if (configId === 'model') {
                options[1] = value === '["provider","b"]'
                    ? { id: 'reasoning_effort', category: 'thought_level', currentValue: 'low', options: [{ value: 'low' }, { value: 'medium' }] }
                    : { id: 'reasoning_effort', category: 'thought_level', currentValue: '', options: [{ value: '' }, { value: 'high' }] }
            }
            listener?.('root', options)
        })
    }
    const session = { publishConfigOptions: vi.fn() }
    const config = new DshSessionConfig(backend as unknown as AcpSdkBackend, session as never, 'root')
    return { config, backend, session, options: () => options }
}

describe('DshSessionConfig', () => {
    it('validates exact opaque model values and preserves the advertised empty-string default', async () => {
        const { config, backend, options } = fixture()
        await expect(config.apply({ model: 'provider/a' })).rejects.toThrow('does not advertise')
        expect(backend.setConfigOption).not.toHaveBeenCalled()
        await config.apply({ effort: 'high' })
        await config.apply({ effort: null })
        expect(backend.setConfigOption).toHaveBeenLastCalledWith('root', 'reasoning_effort', '', { waitForResponse: false })
        expect(options()[1]?.currentValue).toBe('')
    })

    it('resolves an omitted or null model to the catalog default before preflight', () => {
        const { config } = fixture()
        expect(config.resolveModel()).toBe('["provider","a"]')
        expect(config.resolveModel(null)).toBe('["provider","a"]')
        expect(config.resolveModel('["provider","b"]')).toBe('["provider","b"]')
    })

    it('serializes changes and refreshes effort choices after switching model', async () => {
        const { config, backend, options } = fixture()
        await Promise.all([config.apply({ model: '["provider","b"]' }), config.apply({ effort: 'medium' })])
        expect(backend.setConfigOption.mock.calls.map((call) => [call[1], call[2]])).toEqual([
            ['model', '["provider","b"]'], ['reasoning_effort', 'medium']
        ])
        await config.apply({ effort: null })
        expect(options()[1]?.currentValue).toBe('low')
        await config.apply({ model: null })
        expect(options()[0]?.currentValue).toBe('["provider","a"]')
    })

    it('rolls a combined request back when the new model does not support the requested effort', async () => {
        const { config, options } = fixture()
        await config.apply({ effort: 'high' })
        await expect(config.apply({ model: '["provider","b"]', effort: 'high' })).rejects.toThrow('does not advertise')
        expect(options()[0]?.currentValue).toBe('["provider","a"]')
        expect(options()[1]?.currentValue).toBe('high')
        await config.apply({ effort: null })
        expect(options()[1]?.currentValue).toBe('')
    })

    it('rejects conflicting effort aliases before applying either value', async () => {
        const { config, backend } = fixture()
        await expect(config.apply({ effort: 'high', modelReasoningEffort: 'low' })).rejects.toThrow('Conflicting')
        expect(backend.setConfigOption).not.toHaveBeenCalled()
    })

    it('rejects queued configuration after closing the session', async () => {
        const { config, backend } = fixture()
        const pending = config.apply({ effort: 'high' })
        config.dispose()
        await expect(pending).rejects.toThrow('closed')
        await expect(config.apply({ effort: 'high' })).rejects.toThrow('closed')
        expect(backend.setConfigOption).not.toHaveBeenCalled()
    })
})
