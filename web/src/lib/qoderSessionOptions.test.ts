import { describe, expect, it } from 'vitest'
import { qoderSessionOptions } from './qoderSessionOptions'

describe('qoderSessionOptions', () => {
    it('reads the model and reasoning-effort catalogs published by the ACP session', () => {
        const options = qoderSessionOptions([
            {
                id: 'mode',
                category: 'mode',
                currentValue: 'default',
                options: [{ value: 'default' }, { value: 'acceptEdits' }]
            },
            {
                id: 'model',
                category: 'model',
                currentValue: 'bailian/qwen3.8-max-tp',
                options: [
                    { value: 'qfmodel', name: 'Qwen3.8-Flash (default)' },
                    { value: 'dfmodel', name: 'DeepSeek-Flash' }
                ]
            },
            {
                // qoderclicn 1.1.27 misfiles reasoning effort under category 'model'.
                id: 'reasoning_effort',
                category: 'model',
                currentValue: 'xhigh',
                options: [
                    { value: 'xhigh', name: 'Extra High' },
                    { value: 'low', name: 'Low' }
                ]
            }
        ])

        expect(options.models).toEqual([
            { value: 'qfmodel', label: 'Qwen3.8-Flash (default)' },
            { value: 'dfmodel', label: 'DeepSeek-Flash' }
        ])
        expect(options.efforts).toEqual([
            { value: 'xhigh', name: 'Extra High' },
            { value: 'low', name: 'Low' }
        ])
    })

    it('accepts the standard thought_level category and empty catalogs', () => {
        expect(qoderSessionOptions([
            { id: 'effort', category: 'thought_level', options: [{ value: 'medium', name: 'Medium' }] }
        ]).efforts).toEqual([{ value: 'medium', name: 'Medium' }])
        expect(qoderSessionOptions(undefined)).toEqual({ models: [], efforts: [] })
    })

    it('never mistakes reasoning effort for the model catalog', () => {
        expect(qoderSessionOptions([
            { id: 'reasoning_effort', category: 'model', options: [{ value: 'low' }] }
        ]).models).toEqual([])
    })
})
