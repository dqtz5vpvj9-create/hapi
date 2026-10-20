import { describe, expect, it } from 'vitest'
import { parseQoderCommandOptions } from './qoder'

describe('parseQoderCommandOptions', () => {
    it('forces remote mode and accepts an existing HAPI row', () => {
        expect(parseQoderCommandOptions([
            '--hapi-starting-mode', 'remote',
            '--existing-session-id', 'hapi-session'
        ])).toEqual({
            startingMode: 'remote',
            existingSessionId: 'hapi-session'
        })
    })

    it('accepts native resume, a model, and an ACP permission mode', () => {
        expect(parseQoderCommandOptions([
            '--resume', 'native-id',
            '--model', 'dfmodel',
            '--permission-mode', 'acceptEdits'
        ])).toMatchObject({
            resumeSessionId: 'native-id',
            model: 'dfmodel',
            permissionMode: 'acceptEdits',
            startingMode: 'remote'
        })
    })

    it('maps --yolo to bypassPermissions and rejects local mode', () => {
        expect(parseQoderCommandOptions(['--yolo']).permissionMode).toBe('bypassPermissions')
        expect(parseQoderCommandOptions(['--permission-mode', 'plan']).permissionMode).toBe('plan')
        expect(() => parseQoderCommandOptions(['--hapi-starting-mode', 'local'])).toThrow()
    })
})
