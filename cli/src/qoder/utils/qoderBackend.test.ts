import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    QODER_LOGIN_MESSAGE,
    configOptionsWithModels,
    formatQoderError,
    qoderEffortOption,
    qoderPermissionModeId,
    resolveQoderEffortValue,
    resolveQoderPermissionModeId,
    resolveQoderAcpCommand,
    resolveQoderCommand
} from './qoderBackend'

async function makeExecutable(directory: string, name: string): Promise<string> {
    const path = join(directory, name)
    await writeFile(path, '#!/bin/sh\nexit 0\n')
    await chmod(path, 0o755)
    return path
}

describe('Qoder CN command resolution', () => {
    it('defaults to qoderclicn with the ACP stdio flag', () => {
        expect(resolveQoderAcpCommand({ PATH: '' })).toEqual({
            command: 'qoderclicn',
            args: ['--acp']
        })
    })

    it('honors an explicit HAPI_QODER_PATH', () => {
        expect(resolveQoderAcpCommand({
            HAPI_QODER_PATH: '/opt/qoder/custom',
            PATH: ''
        })).toEqual({ command: '/opt/qoder/custom', args: ['--acp'] })
    })

    it('finds qoderclicn on PATH', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-qoder-path-'))
        const binary = await makeExecutable(directory, 'qoderclicn')

        expect(resolveQoderCommand({ PATH: directory })).toBe('qoderclicn')
        expect(resolveQoderAcpCommand({ PATH: directory }).command).toBe('qoderclicn')
        expect(binary).toBe(join(directory, 'qoderclicn'))
    })

    it('falls back to the legacy qodercn binary when qoderclicn is absent', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-qoder-path-'))
        await makeExecutable(directory, 'qodercn')

        expect(resolveQoderCommand({ PATH: directory })).toBe('qodercn')
    })

    it('keeps the canonical command when neither binary is installed', () => {
        expect(resolveQoderCommand({ PATH: '' })).toBe('qoderclicn')
    })
})

describe('Qoder permission mode mapping', () => {
    it('uses the ACP session mode ids, which already match HAPI ids', () => {
        expect(qoderPermissionModeId('default')).toBe('default')
        expect(qoderPermissionModeId('acceptEdits')).toBe('acceptEdits')
        expect(qoderPermissionModeId('plan')).toBe('plan')
        expect(qoderPermissionModeId('bypassPermissions')).toBe('bypassPermissions')
    })

    it('resolves against the modes the session advertises', () => {
        expect(resolveQoderPermissionModeId('acceptEdits', ['default', 'acceptEdits', 'bypassPermissions', 'plan']))
            .toBe('acceptEdits')
        expect(resolveQoderPermissionModeId('bypassPermissions', ['default', 'acceptEdits']))
            .toBe('bypassPermissions')
        // Older CLI builds exposed the flag spelling instead.
        expect(resolveQoderPermissionModeId('acceptEdits', ['default', 'accept_edits']))
            .toBe('accept_edits')
    })

    it('treats a missing mode as default', () => {
        expect(qoderPermissionModeId(undefined)).toBe('default')
        expect(resolveQoderPermissionModeId(undefined, ['acceptEdits'])).toBe('default')
    })
})

describe('configOptionsWithModels', () => {
    it('synthesizes a model option from an ACP model catalog', () => {
        expect(configOptionsWithModels([], {
            availableModels: [
                { modelId: 'deepseek-v4.1-flash-1017', name: 'DeepSeek-V4.1-Flash-1017' },
                { modelId: 'qwen-max' }
            ],
            currentModelId: 'deepseek-v4.1-flash-1017'
        })).toEqual([{
            id: 'model',
            name: 'Model',
            category: 'model',
            currentValue: 'deepseek-v4.1-flash-1017',
            options: [
                { value: 'deepseek-v4.1-flash-1017', name: 'DeepSeek-V4.1-Flash-1017' },
                { value: 'qwen-max', name: undefined }
            ]
        }])
    })

    it('keeps a server-provided model config option untouched', () => {
        const serverOption = {
            id: 'model',
            name: 'Model',
            category: 'model',
            currentValue: 'qwen-max',
            options: [{ value: 'qwen-max', name: 'Qwen Max' }]
        }
        expect(configOptionsWithModels([serverOption], {
            availableModels: [{ modelId: 'other' }],
            currentModelId: 'other'
        })).toEqual([serverOption])
    })

    it('leaves options alone when no model catalog was advertised', () => {
        const options = [{ id: 'mode', category: 'mode', options: [] }]
        expect(configOptionsWithModels(options, undefined)).toBe(options)
        expect(configOptionsWithModels(options, { availableModels: [], currentModelId: null })).toBe(options)
    })
})

describe('formatQoderError', () => {
    it('turns an ACP authentication rejection into the one-time login command', () => {
        const failure = formatQoderError(new Error('Authentication required: Authentication is required.'))
        expect(failure.message).toBe(QODER_LOGIN_MESSAGE)
        expect(failure.details).toContain('Authentication required')
    })

    it('recognizes the CLI login wording', () => {
        expect(formatQoderError(new Error('Not logged in · Please run /login')).message)
            .toBe(QODER_LOGIN_MESSAGE)
    })

    it('keeps generic failures generic but preserves details', () => {
        const failure = formatQoderError(new Error('transport closed'))
        expect(failure.message).toBe('Qoder CN request failed; expand the details for the underlying error.')
        expect(failure.details).toBe('transport closed')
    })
})


describe('Qoder reasoning effort', () => {
    const effortOption = {
        id: 'reasoning_effort',
        category: 'model',
        currentValue: 'xhigh',
        options: [
            { value: 'xhigh', name: 'Extra High' },
            { value: 'low', name: 'Low' }
        ]
    }

    it('finds reasoning_effort even though qoderclicn files it under category model', () => {
        expect(qoderEffortOption([{ id: 'mode', options: [] }, effortOption])?.id).toBe('reasoning_effort')
        expect(qoderEffortOption([
            { id: 'effort', category: 'thought_level', options: [] }
        ])?.category).toBe('thought_level')
        expect(qoderEffortOption(undefined)).toBeUndefined()
    })

    it('accepts advertised levels and rejects unknown ones', () => {
        expect(resolveQoderEffortValue('low', effortOption, 'xhigh')).toBe('low')
        expect(() => resolveQoderEffortValue('maximum', effortOption, 'xhigh')).toThrow(/reasoning effort/)
    })

    it('restores the launch default for a null request', () => {
        expect(resolveQoderEffortValue(null, effortOption, 'xhigh')).toBe('xhigh')
        expect(resolveQoderEffortValue(null, effortOption, null)).toBe('xhigh')
        expect(resolveQoderEffortValue(null, { ...effortOption, currentValue: undefined }, null)).toBe('xhigh')
    })

    it('throws when the session advertises no effort option', () => {
        expect(() => resolveQoderEffortValue('low', undefined, null))
            .toThrow(/does not advertise a reasoning effort option/)
    })
})
