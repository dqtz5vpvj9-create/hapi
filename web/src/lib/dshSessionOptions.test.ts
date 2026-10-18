import { describe, expect, it } from 'vitest'
import { dshEffortPickerOptions, dshSessionOptions } from './dshSessionOptions'
import { getModelOptionsForFlavor, getNextModelForFlavor } from '@/components/AssistantChat/modelOptions'

describe('DSH advertised settings', () => {
    it('preserves opaque values and flattened provider labels from metadata', () => {
        const value = '{"provider":"deepseek","model":"deepseek-v4"}'
        const result = dshSessionOptions([
            { id: 'models', category: 'model', options: [{ value, name: 'DeepSeek / V4' }, { value: 'vendor:exact', name: 'Other / Custom' }] },
            { id: 'reasoning', category: 'thought_level', currentValue: '', options: [{ value: '', name: 'Provider default' }, { value: 'deep', name: 'Deep reasoning' }] }
        ])
        expect(result.models).toEqual([{ value, label: 'DeepSeek / V4' }, { value: 'vendor:exact', label: 'Other / Custom' }])
        expect(dshEffortPickerOptions(result.efforts)).toEqual([{ value: null, label: 'Provider default' }, { value: 'deep', label: 'Deep reasoning' }])
    })

    it('does not fabricate default or stale options after a replacement metadata update', () => {
        const replacement = dshSessionOptions([{ id: 'model', category: 'model', options: [{ value: 'new', name: 'New model' }] },
            { id: 'reasoning', category: 'thought_level', options: [{ value: 'high', name: 'High' }] }])
        expect(getModelOptionsForFlavor('dsh', 'removed', replacement.models)).toEqual([{ value: 'new', label: 'New model' }])
        expect(getNextModelForFlavor('dsh', 'removed', replacement.models)).toBe('new')
        expect(dshEffortPickerOptions(replacement.efforts)).toEqual([{ value: 'high', label: 'High' }])
        expect(dshEffortPickerOptions([])).toEqual([])
    })

    it('keeps old servers without advertised settings empty and never falls back to Claude', () => {
        expect(dshSessionOptions(undefined)).toEqual({ models: [], efforts: [] })
        expect(getModelOptionsForFlavor('dsh', 'opaque-current')).toEqual([])
        expect(getNextModelForFlavor('dsh', 'opaque-current')).toBe('opaque-current')
    })
})
