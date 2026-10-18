import { describe, expect, it } from 'vitest'
import { parseDshCommandOptions } from './dsh'

describe('parseDshCommandOptions', () => {
    it('forces remote mode and accepts an existing HAPI row', () => {
        expect(parseDshCommandOptions([
            '--hapi-starting-mode', 'remote',
            '--existing-session-id', 'hapi-session'
        ])).toEqual({
            startingMode: 'remote',
            existingSessionId: 'hapi-session'
        })
    })

    it('accepts native resume and opaque configuration values for capability validation after connect', () => {
        expect(parseDshCommandOptions(['--resume', 'native-id', '--model', '["provider","model"]', '--effort', 'high']))
            .toMatchObject({ resumeSessionId: 'native-id', model: '["provider","model"]', effort: 'high', startingMode: 'remote' })
    })

    it('rejects HAPI permission controls and local mode', () => {
        expect(() => parseDshCommandOptions(['--yolo']))
            .toThrow('permission policy')
        expect(() => parseDshCommandOptions(['--permission-mode', 'default'])).toThrow()
        expect(() => parseDshCommandOptions(['--hapi-starting-mode', 'local'])).toThrow()
    })
})
