import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    clearNewSessionFormDraft,
    clearNativeUpdateNewSessionDraft,
    loadNativeUpdateNewSessionDraft,
    loadNewSessionFormDraft,
    newSessionDraftMatchesMachine,
    saveNewSessionFormDraft,
    saveNativeUpdateNewSessionDraft,
    shouldRestoreNewSessionFormDraft
} from './newSessionFormDraft'

describe('newSessionFormDraft', () => {
    it('drops Safe Yolo from a saved Codex draft without dropping other settings', () => {
        sessionStorage.setItem('hapi:new-session-form-draft', JSON.stringify({
            agent: 'codex', model: 'custom-model', nativePermissionMode: 'safe-yolo', yoloMode: true
        }))
        expect(loadNewSessionFormDraft()).toMatchObject({ model: 'custom-model', nativePermissionMode: 'default' })
    })
    afterEach(() => {
        clearNewSessionFormDraft()
    })

    it('round-trips cursor model fields through sessionStorage', () => {
        saveNewSessionFormDraft({
            agent: 'cursor',
            model: 'composer-2.5[fast=false]',
            cursorSelectedBase: 'composer-2.5',
            machineId: 'machine-1',
            effort: 'auto',
            modelReasoningEffort: 'default',
            serviceTier: 'standard',
            collaborationMode: 'default',
            copilotAgentMode: 'interactive',
            yoloMode: false,
            nativePermissionMode: 'default',
            grokPermissionMode: 'default',
            sessionType: 'simple',
            worktreeName: ''
        })

        expect(loadNewSessionFormDraft()).toEqual({
            agent: 'cursor',
            model: 'composer-2.5[fast=false]',
            cursorSelectedBase: 'composer-2.5',
            machineId: 'machine-1',
            effort: 'auto',
            modelReasoningEffort: 'default',
            serviceTier: 'standard',
            collaborationMode: 'default',
            copilotAgentMode: 'interactive',
            yoloMode: false,
            nativePermissionMode: 'default',
            grokPermissionMode: 'default',
            sessionType: 'simple',
            worktreeName: ''
        })
    })

    it('restores only when returning from browse with a directory in search', () => {
        expect(shouldRestoreNewSessionFormDraft({})).toBe(false)
        expect(shouldRestoreNewSessionFormDraft({ initialDirectory: '/tmp/proj' })).toBe(true)
        expect(shouldRestoreNewSessionFormDraft({
            initialDirectory: '/tmp/proj',
            initialMachineId: 'machine-1'
        })).toBe(true)
    })

    it('matches machine when draft has no machine id', () => {
        const draft = loadNewSessionFormDraft()
        void draft
        saveNewSessionFormDraft({
            agent: 'cursor',
            model: 'auto',
            cursorSelectedBase: 'auto',
            machineId: null,
            effort: 'auto',
            modelReasoningEffort: 'default',
            serviceTier: 'standard',
            collaborationMode: 'default',
            copilotAgentMode: 'interactive',
            yoloMode: false,
            nativePermissionMode: 'default',
            grokPermissionMode: 'default',
            sessionType: 'simple',
            worktreeName: ''
        })
        const loaded = loadNewSessionFormDraft()!
        expect(newSessionDraftMatchesMachine(loaded, 'machine-1')).toBe(true)
    })

    it('rejects draft when machine id differs', () => {
        saveNewSessionFormDraft({
            agent: 'cursor',
            model: 'composer-2.5[fast=true]',
            cursorSelectedBase: 'composer-2.5',
            machineId: 'machine-a',
            effort: 'auto',
            modelReasoningEffort: 'default',
            serviceTier: 'fast',
            collaborationMode: 'plan',
            copilotAgentMode: 'interactive',
            yoloMode: false,
            nativePermissionMode: 'default',
            grokPermissionMode: 'default',
            sessionType: 'simple',
            worktreeName: ''
        })
        const draft = loadNewSessionFormDraft()!
        expect(newSessionDraftMatchesMachine(draft, 'machine-b')).toBe(false)
        expect(draft.serviceTier).toBe('fast')
        expect(draft.collaborationMode).toBe('plan')
    })

    it('coerces a stale uncreatable agent (gemini) to claude and resets dependent fields', () => {
        saveNewSessionFormDraft({
            agent: 'gemini',
            model: 'gemini-2.5-pro',
            cursorSelectedBase: 'composer-2.5',
            machineId: 'machine-1',
            effort: 'high',
            modelReasoningEffort: 'high',
            serviceTier: 'fast',
            collaborationMode: 'plan',
            copilotAgentMode: 'interactive',
            yoloMode: true,
            nativePermissionMode: 'default',
            grokPermissionMode: 'default',
            sessionType: 'simple',
            worktreeName: ''
        })

        const loaded = loadNewSessionFormDraft()!
        expect(loaded.agent).toBe('claude')
        // agent-dependent fields reset so a Gemini model isn't carried into Claude
        expect(loaded.model).toBe('auto')
        expect(loaded.cursorSelectedBase).toBe('auto')
        expect(loaded.effort).toBe('auto')
        expect(loaded.modelReasoningEffort).toBe('default')
        expect(loaded.serviceTier).toBe('standard')
        expect(loaded.collaborationMode).toBe('default')
        // agent-independent fields preserved
        expect(loaded.yoloMode).toBe(true)
        expect(loaded.machineId).toBe('machine-1')
    })

    it('does not bridge a legacy yoloMode for a flavor outside the legacy YOLO allow-list (copilot)', () => {
        // copilot moved to the native permission select before the YOLO
        // toggle era; its restore-time bridge target already settled on
        // 'default' and stays there (see LEGACY_YOLO_BRIDGE_AGENTS).
        sessionStorage.setItem('hapi:new-session-form-draft', JSON.stringify({
            agent: 'copilot',
            model: 'auto',
            cursorSelectedBase: 'auto',
            machineId: 'machine-1',
            effort: 'auto',
            modelReasoningEffort: 'default',
            serviceTier: 'standard',
            collaborationMode: 'default',
            copilotAgentMode: 'interactive',
            yoloMode: true,
            sessionType: 'simple',
            worktreeName: ''
        }))

        const loaded = loadNewSessionFormDraft()!
        expect(loaded.agent).toBe('copilot')
        expect(loaded.nativePermissionMode).toBe('default')
    })

    it('does not bridge a legacy yoloMode for opencode', () => {
        sessionStorage.setItem('hapi:new-session-form-draft', JSON.stringify({
            agent: 'opencode',
            model: 'auto',
            cursorSelectedBase: 'auto',
            machineId: 'machine-1',
            effort: 'auto',
            modelReasoningEffort: 'default',
            serviceTier: 'standard',
            collaborationMode: 'default',
            copilotAgentMode: 'interactive',
            yoloMode: true,
            sessionType: 'simple',
            worktreeName: ''
        }))

        const loaded = loadNewSessionFormDraft()!
        expect(loaded.agent).toBe('opencode')
        expect(loaded.nativePermissionMode).toBe('default')
    })

    it('bridges a legacy yoloMode to yolo when restoring codex drafts (pin: codex stays in the allow-list)', () => {
        sessionStorage.setItem('hapi:new-session-form-draft', JSON.stringify({
            agent: 'codex',
            model: 'auto',
            cursorSelectedBase: 'auto',
            machineId: 'machine-1',
            effort: 'auto',
            modelReasoningEffort: 'default',
            serviceTier: 'standard',
            collaborationMode: 'default',
            copilotAgentMode: 'interactive',
            yoloMode: true,
            sessionType: 'simple',
            worktreeName: ''
        }))

        const loaded = loadNewSessionFormDraft()!
        expect(loaded.agent).toBe('codex')
        expect(loaded.nativePermissionMode).toBe('yolo')
    })

    it('maps legacy yoloMode to bypassPermissions when restoring claude drafts', () => {
        sessionStorage.setItem('hapi:new-session-form-draft', JSON.stringify({
            agent: 'claude',
            model: 'auto',
            cursorSelectedBase: 'auto',
            machineId: 'machine-1',
            effort: 'auto',
            modelReasoningEffort: 'default',
            serviceTier: 'standard',
            collaborationMode: 'default',
            copilotAgentMode: 'interactive',
            yoloMode: true,
            sessionType: 'simple',
            worktreeName: ''
        }))

        const loaded = loadNewSessionFormDraft()!
        expect(loaded.agent).toBe('claude')
        expect(loaded.nativePermissionMode).toBe('bypassPermissions')
    })
})

describe('native update new-session snapshots', () => {
    const scope = 'hapi:new-task:https://hub.example'
    const snapshot = {
        directory: '/chosen/project',
        text: 'Keep exact text\nincluding a second line',
        form: {
            agent: 'codex' as const,
            model: 'gpt-5.6-terra',
            cursorSelectedBase: 'auto',
            machineId: 'machine-2',
            effort: 'auto' as const,
            modelReasoningEffort: 'max' as const,
            serviceTier: 'standard' as const,
            collaborationMode: 'default' as const,
            copilotAgentMode: 'interactive' as const,
            yoloMode: false,
            nativePermissionMode: 'default' as const,
            grokPermissionMode: 'default' as const,
            sessionType: 'simple' as const,
            worktreeName: '',
        },
    }

    afterEach(() => {
        clearNativeUpdateNewSessionDraft(scope)
        vi.restoreAllMocks()
        window.history.replaceState(null, '', '/')
    })

    it('retains the full form and text without consuming a StrictMode initializer read', () => {
        window.history.replaceState(null, '', '/sessions/new?directory=original')
        saveNativeUpdateNewSessionDraft(scope, snapshot)
        expect(loadNativeUpdateNewSessionDraft(scope)).toMatchObject({ ...snapshot, schemaVersion: 1, draftKey: scope })
        expect(loadNativeUpdateNewSessionDraft(scope)).toMatchObject(snapshot)
        clearNativeUpdateNewSessionDraft(scope)
        expect(loadNativeUpdateNewSessionDraft(scope)).toBeNull()
    })

    it('never replays a snapshot for another Hub or a different route', () => {
        window.history.replaceState(null, '', '/sessions/new')
        saveNativeUpdateNewSessionDraft(scope, snapshot)
        expect(loadNativeUpdateNewSessionDraft('hapi:new-task:https://other.example')).toBeNull()
        window.history.replaceState(null, '', '/sessions/new?shareTransferId=another')
        expect(loadNativeUpdateNewSessionDraft(scope)).toBeNull()
    })

    it('expires abandoned update snapshots', () => {
        vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValue(6 * 60 * 1_000)
        saveNativeUpdateNewSessionDraft(scope, snapshot)
        expect(loadNativeUpdateNewSessionDraft(scope)).toBeNull()
    })

    it('propagates storage failure so the caller can abort activation', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded') })
        expect(() => saveNativeUpdateNewSessionDraft(scope, snapshot)).toThrow('Quota exceeded')
    })
})
