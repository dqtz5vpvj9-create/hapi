import {
    CREATABLE_AGENT_FLAVORS,
    GROK_PERMISSION_MODES,
    getLaunchPermissionModesForFlavor,
    normalizeCopilotAgentMode,
    resolveHapiYoloPermissionMode,
    type CodexCollaborationMode,
    type CopilotAgentMode,
    type GrokPermissionMode,
    type PermissionMode
} from '@hapi/protocol'
import type { AgentType, LaunchEffort, CodexReasoningEffort, NewSessionServiceTier, SessionType } from './types'
import { LEGACY_YOLO_BRIDGE_AGENTS } from '@/lib/codexFamilyPermissionAgents'

const DRAFT_STORAGE_KEY = 'hapi:new-session-form-draft'

export type NewSessionFormDraft = {
    agent: AgentType
    model: string
    cursorSelectedBase: string
    machineId: string | null
    effort: LaunchEffort
    modelReasoningEffort: CodexReasoningEffort
    serviceTier: NewSessionServiceTier
    collaborationMode: CodexCollaborationMode
    copilotAgentMode: CopilotAgentMode
    yoloMode: boolean
    nativePermissionMode: PermissionMode
    grokPermissionMode: GrokPermissionMode
    sessionType: SessionType
    worktreeName: string
}

export function saveNewSessionFormDraft(draft: NewSessionFormDraft): void {
    try {
        sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft))
    } catch {
        // sessionStorage may be unavailable (private mode, quota)
    }
}

export function loadNewSessionFormDraft(): NewSessionFormDraft | null {
    try {
        const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY)
        return raw ? parseNewSessionFormDraft(JSON.parse(raw)) : null
    } catch {
        return null
    }
}

function parseNewSessionFormDraft(value: unknown): NewSessionFormDraft | null {
    try {
        const parsed = value as Partial<NewSessionFormDraft>
        if (typeof parsed.agent !== 'string' || typeof parsed.model !== 'string') {
            return null
        }
        // Coerce a stale/uncreatable agent (e.g. a pre-removal 'gemini' draft)
        // back to a launchable default. When the agent is coerced, also drop the
        // agent-dependent fields (model / cursor base / effort) so a Gemini
        // draft does not carry a Gemini model into the Claude fallback.
        const restoredAgent: AgentType = (CREATABLE_AGENT_FLAVORS as readonly string[]).includes(parsed.agent)
            ? (parsed.agent as AgentType)
            : 'claude'
        const agentPreserved = restoredAgent === parsed.agent
        return {
            agent: restoredAgent,
            model: agentPreserved ? parsed.model : 'auto',
            cursorSelectedBase: agentPreserved && typeof parsed.cursorSelectedBase === 'string'
                ? parsed.cursorSelectedBase
                : 'auto',
            machineId: typeof parsed.machineId === 'string' ? parsed.machineId : null,
            effort: agentPreserved ? ((parsed.effort as LaunchEffort | undefined) ?? 'auto') : 'auto',
            modelReasoningEffort: agentPreserved
                ? ((parsed.modelReasoningEffort as CodexReasoningEffort | undefined) ?? 'default')
                : 'default',
            serviceTier: agentPreserved && parsed.serviceTier === 'fast' ? 'fast' : 'standard',
            collaborationMode: agentPreserved && parsed.collaborationMode === 'plan' ? 'plan' : 'default',
            copilotAgentMode: agentPreserved
                ? normalizeCopilotAgentMode(parsed.copilotAgentMode)
                : 'interactive',
            yoloMode: Boolean(parsed.yoloMode),
            nativePermissionMode: (() => {
                const modes = getLaunchPermissionModesForFlavor(restoredAgent)
                const parsedMode = parsed.nativePermissionMode as PermissionMode | undefined
                if (agentPreserved && parsedMode && modes.includes(parsedMode)) {
                    return parsedMode
                }
                const yoloBridgeMode = LEGACY_YOLO_BRIDGE_AGENTS.includes(restoredAgent)
                    ? resolveHapiYoloPermissionMode(restoredAgent)
                    : null
                if (agentPreserved && parsedMode === undefined && parsed.yoloMode && yoloBridgeMode && modes.includes(yoloBridgeMode)) {
                    return yoloBridgeMode
                }
                return 'default'
            })(),
            grokPermissionMode: agentPreserved
                && GROK_PERMISSION_MODES.includes(parsed.grokPermissionMode as GrokPermissionMode)
                ? parsed.grokPermissionMode as GrokPermissionMode
                : 'default',
            sessionType: (parsed.sessionType as SessionType | undefined) ?? 'simple',
            worktreeName: typeof parsed.worktreeName === 'string' ? parsed.worktreeName : ''
        }
    } catch {
        return null
    }
}

export function clearNewSessionFormDraft(): void {
    try {
        sessionStorage.removeItem(DRAFT_STORAGE_KEY)
    } catch {
        // ignore
    }
}

/** Restore draft after Browse → /sessions/new?directory=… remount. */
export function shouldRestoreNewSessionFormDraft(args: {
    initialDirectory?: string
    initialMachineId?: string
}): boolean {
    return Boolean(args.initialDirectory?.trim())
}

export function newSessionDraftMatchesMachine(
    draft: NewSessionFormDraft,
    machineId: string | null | undefined
): boolean {
    if (!draft.machineId || !machineId) {
        return true
    }
    return draft.machineId === machineId
}

const NATIVE_UPDATE_DRAFT_PREFIX = 'hapi:native-update:new-session::'
const NATIVE_UPDATE_DRAFT_MAX_AGE_MS = 5 * 60 * 1000

export type NativeUpdateNewSessionDraft = {
    schemaVersion: 1
    draftKey: string
    path: string
    savedAt: number
    directory: string
    text?: string
    form: NewSessionFormDraft
}

/** Separate from browse-return drafts: an update must also retain the chosen machine, path, and exact task text. */
export function saveNativeUpdateNewSessionDraft(
    draftKey: string,
    draft: Pick<NativeUpdateNewSessionDraft, 'form' | 'directory' | 'text'>,
): void {
    const record: NativeUpdateNewSessionDraft = {
        schemaVersion: 1,
        draftKey,
        path: window.location.pathname + window.location.search + window.location.hash,
        savedAt: Date.now(),
        ...draft,
    }
    // Unlike optional browse restoration, a failed durable save aborts the update.
    sessionStorage.setItem(NATIVE_UPDATE_DRAFT_PREFIX + draftKey, JSON.stringify(record))
}

/** Call only after bootstrap confirmed a native-update route restore; loading itself is safe under StrictMode. */
export function loadNativeUpdateNewSessionDraft(draftKey: string): NativeUpdateNewSessionDraft | null {
    try {
        const raw = sessionStorage.getItem(NATIVE_UPDATE_DRAFT_PREFIX + draftKey)
        if (!raw) return null
        const record = JSON.parse(raw) as Partial<NativeUpdateNewSessionDraft> | null
        if (!record || record.schemaVersion !== 1 || record.draftKey !== draftKey
            || record.path !== window.location.pathname + window.location.search + window.location.hash
            || typeof record.savedAt !== 'number' || !Number.isFinite(record.savedAt) || record.savedAt > Date.now()
            || Date.now() - record.savedAt > NATIVE_UPDATE_DRAFT_MAX_AGE_MS
            || typeof record.directory !== 'string' || (record.text !== undefined && typeof record.text !== 'string')) return null
        const form = parseNewSessionFormDraft(record.form)
        return form ? { ...record, form } as NativeUpdateNewSessionDraft : null
    } catch { return null }
}

export function clearNativeUpdateNewSessionDraft(draftKey: string): void {
    try { sessionStorage.removeItem(NATIVE_UPDATE_DRAFT_PREFIX + draftKey) } catch { /* A restore hint cannot block startup. */ }
}
