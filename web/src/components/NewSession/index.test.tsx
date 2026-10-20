import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render as renderBase, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactElement } from 'react'
import type { ApiClient } from '@/api/client'
import type { Machine, PiModelSummary } from '@/types/api'
import { createNewTaskDelivery, saveNewTaskDelivery } from './newTaskDelivery'
import { loadNativeUpdateNewSessionDraft, saveNewSessionFormDraft } from './newSessionFormDraft'
import * as attachmentDrafts from '@/lib/composer-attachment-drafts'
import * as nativeUpdateReload from '@/lib/nativeUpdateReload'
import {
    loadPreferredLaunchSettings,
    savePreferredAgent,
    savePreferredLaunchSettings,
    savePreferredYoloMode
} from './preferences'

function render(ui: ReactElement) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return renderBase(ui, { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> })
}

const mocks = vi.hoisted(() => ({
    native: false,
    pickAttachments: vi.fn(),
    spawnSession: vi.fn(),
    onSuccess: vi.fn(),
    notification: vi.fn(),
    checkPathsExists: vi.fn(),
    availableAgents: [
        'agy', 'claude', 'codex', 'dsh', 'copilot', 'cursor', 'grok', 'kimi', 'opencode', 'pi', 'qoder'
    ].map((agent) => ({ agent, available: true })) as Array<{ agent: string; available: boolean; reason?: 'not_found' | 'invalid_configuration' }>,
    refreshAgentAvailability: vi.fn(),
    agentAvailabilityFetching: false,
    agentAvailabilityLoading: false,
    agentAvailabilityError: null as string | null,
    outsideWorkspaceRoots: [] as string[],
    codexModelsLoading: false,
    agyModelsLoading: false,
    agyModels: [{ modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' }],
    directoryExists: undefined as boolean | undefined,
    copilotModels: [] as Array<{ modelId: string; name?: string }>,
    copilotModelsLoading: false,
    kimiModels: [] as Array<{ modelId: string; name?: string; provider?: string }>,
    kimiModelsLoading: false,
    kimiModelsError: null as string | null,
    opencodeModels: [] as Array<{ modelId: string; name?: string }>,
    opencodeCurrentModelId: null as string | null,
    opencodeModelsLoading: false,
    opencodeVariants: null as Record<string, string[]> | null,
    opencodeVariantsLoading: false,
    opencodeVariantsEnabled: false,
    piDialogSelection: ['pi-native-1'] as string[],
    piModels: [] as PiModelSummary[],
    piModelsLoading: false,
    piModelsError: null as string | null,
    nextModelValue: 'gpt-5.6-terra',
    refetchSessions: vi.fn(),
    addToast: vi.fn(),
    getShareTransfer: vi.fn().mockResolvedValue(null)
}))

vi.mock('@/lib/shareTransfer', () => ({ getShareTransfer: (...args: unknown[]) => mocks.getShareTransfer(...args) }))
vi.mock('@/lib/platform', () => ({ isNativePlatform: () => mocks.native }))
vi.mock('@/lib/nativeAttachments', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/nativeAttachments')>(),
    pickNativeAttachments: mocks.pickAttachments,
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('@/lib/toast-context', () => ({
    useToast: () => ({ addToast: mocks.addToast })
}))
vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({ haptic: { notification: mocks.notification } })
}))
vi.mock('@/hooks/mutations/useSpawnSession', () => ({
    useSpawnSession: () => ({
        spawnSession: mocks.spawnSession,
        isPending: false,
        error: null
    })
}))
vi.mock('@/hooks/queries/useSessions', () => ({
    useSessions: () => ({ sessions: [], refetch: mocks.refetchSessions })
}))
vi.mock('@/hooks/useRecentPaths', () => ({
    useRecentPaths: () => ({
        getRecentPaths: () => [],
        addRecentPath: vi.fn(),
        getLastUsedMachineId: () => null,
        setLastUsedMachineId: vi.fn()
    })
}))
vi.mock('@/hooks/useMachinePathsExists', () => ({
    useMachinePathsExists: () => ({
        pathExistence: { 'C:\\repo': mocks.directoryExists },
        outsideWorkspaceRoots: new Set(mocks.outsideWorkspaceRoots),
        checkPathsExists: mocks.checkPathsExists
    })
}))
vi.mock('@/hooks/queries/useAgentAvailability', () => ({
    useAgentAvailability: () => ({
        agents: mocks.availableAgents,
        isLoading: mocks.agentAvailabilityLoading,
        isFetching: mocks.agentAvailabilityFetching,
        error: mocks.agentAvailabilityError,
        upgradeRequired: false,
        refetch: mocks.refreshAgentAvailability
    })
}))
vi.mock('@/hooks/useDirectorySuggestions', () => ({
    useDirectorySuggestions: () => []
}))
vi.mock('@/hooks/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [[], -1, vi.fn(), vi.fn(), vi.fn()]
}))
vi.mock('@/hooks/queries/useCodexModels', () => ({
    useCodexModels: () => ({
        models: [
            {
                id: 'gpt-5.6-sol',
                displayName: 'GPT-5.6 Sol',
                isDefault: true,
                supportedReasoningEfforts: ['low', 'high', 'xhigh']
            },
            {
                id: 'gpt-5.6-terra',
                displayName: 'GPT-5.6 Terra',
                isDefault: false,
                supportedReasoningEfforts: ['low', 'high', 'max']
            }
        ],
        isLoading: mocks.codexModelsLoading,
        error: null
    })
}))
vi.mock('@/hooks/queries/useAgyModels', () => ({
    useAgyModels: () => ({
        availableModels: mocks.agyModels,
        currentModelId: null,
        isLoading: mocks.agyModelsLoading,
        error: null,
        refetch: vi.fn()
    })
}))
vi.mock('@/hooks/queries/useCursorModelsForMachine', () => ({
    useCursorModelsForMachine: () => ({
        availableModels: [],
        cliModelSkus: [],
        currentModelId: null,
        isLoading: false,
        error: null,
        refetch: vi.fn()
    })
}))
vi.mock('@/hooks/queries/useOpencodeModelsForCwd', () => ({
    useOpencodeModelsForCwd: () => ({
        availableModels: mocks.opencodeModels,
        currentModelId: mocks.opencodeCurrentModelId,
        isLoading: mocks.opencodeModelsLoading,
        error: null,
        refetch: vi.fn()
    })
}))
vi.mock('@/hooks/queries/useOpencodeModelVariants', () => ({
    useOpencodeModelVariants: (args: { enabled: boolean }) => {
        mocks.opencodeVariantsEnabled = args.enabled
        return {
            variants: mocks.opencodeVariants,
            isLoading: mocks.opencodeVariantsLoading,
            error: null
        }
    }
}))
vi.mock('@/hooks/queries/useGrokModelsForCwd', () => ({
    useGrokModelsForCwd: () => ({
        availableModels: [],
        currentModelId: null,
        autoPermissionModeSupported: null,
        isLoading: false,
        error: null
    })
}))
vi.mock('@/hooks/queries/useCopilotModelsForCwd', () => ({
    useCopilotModelsForCwd: () => ({
        availableModels: mocks.copilotModels,
        currentModelId: null,
        isLoading: mocks.copilotModelsLoading,
        error: null
    })
}))
vi.mock('@/hooks/queries/useKimiModelsForCwd', () => ({
    useKimiModelsForCwd: () => ({
        availableModels: mocks.kimiModels,
        currentModelId: null,
        isLoading: mocks.kimiModelsLoading,
        error: mocks.kimiModelsError
    })
}))
vi.mock('@/hooks/queries/usePiModelsForMachine', () => ({
    usePiModelsForMachine: () => ({
        availableModels: mocks.piModels,
        currentModelId: null,
        isLoading: mocks.piModelsLoading,
        error: mocks.piModelsError
    })
}))
vi.mock('../../utils/formatRunnerSpawnError', () => ({
    formatRunnerSpawnError: () => null
}))
vi.mock('@/components/CodexSessionSyncDialog', () => ({
    CodexSessionSyncDialog: (props: { isOpen: boolean; isLoading: boolean; sessions: Array<{ id: string }>; error?: string | null; onRetry: () => void; onConfirm: (ids: string[]) => Promise<void>; onSearchChange: (search: string, cwd: string | null) => void; hasMore: boolean; onLoadMore: () => void }) => props.isOpen ? (
        <>
            <div data-testid="codex-list-error">{props.error}</div>
            <div data-testid="codex-search-results">{props.sessions.map(session => session.id).join(',')}</div>
            <input data-testid="codex-search" onChange={event => props.onSearchChange(event.target.value, null)} />
            {props.hasMore ? <button data-testid="codex-more" disabled={props.isLoading} onClick={props.onLoadMore}>more</button> : null}
            <button data-testid="codex-retry" onClick={props.onRetry}>retry</button>
            <button data-testid="import-codex" disabled={props.isLoading || props.sessions.length === 0} onClick={() => void props.onConfirm(props.sessions.map((s) => s.id))}>import</button>
        </>
    ) : null
}))
vi.mock('@/components/PiSessionImportDialog', () => ({
    PiSessionImportDialog: (props: { isOpen: boolean; sessions: Array<{ id: string }>; onClose: () => void; onConfirm: (ids: string[]) => Promise<void> }) => props.isOpen ? (
        <>
            <div data-testid="pi-session-ids">{props.sessions.map((session) => session.id).join(',')}</div>
            <button type="button" data-testid="close-pi-history" onClick={props.onClose}>close pi history</button>
            <button type="button" data-testid="select-pi-history" disabled={props.sessions.length === 0} onClick={() => void props.onConfirm(mocks.piDialogSelection)}>
                select pi history
            </button>
        </>
    ) : null
}))
vi.mock('./DirectorySection', () => ({ DirectorySection: () => null }))
vi.mock('./CopilotAgentModeSelector', () => ({ CopilotAgentModeSelector: () => null }))
vi.mock('./OpencodeModelSelector', () => ({
    OpencodeModelSelector: (props: { selectedModel: string | null | undefined; onModelChange: (model: string | null) => void }) => (
        <>
            <button type="button" data-testid="opencode-model-default" onClick={() => props.onModelChange(null)}>default</button>
            <button type="button" data-testid="opencode-model-pick" onClick={() => props.onModelChange('provider/model')}>pick</button>
            <div data-testid="opencode-model">{props.selectedModel ?? 'default'}</div>
        </>
    )
}))
vi.mock('./AgyModelSelector', () => ({
    AgyModelSelector: (props: { selectedModel: string | null; onModelChange: (model: string | null) => void }) => (
        <button type="button" data-testid="agy-model" onClick={() => props.onModelChange('gemini-3.6-flash-low')}>
            {props.selectedModel ?? 'auto'}
        </button>
    )
}))
vi.mock('./EffortField', () => ({
    EffortField: (props: { effort: string; reasoningEffort: string; opencodeVariantOptions?: string[] | null; onReasoningEffortChange: (v: string) => void }) => (
        <>
            <div data-testid="launch-effort">{props.effort}</div>
            <div data-testid="opencode-variants">{props.opencodeVariantOptions?.join(',') ?? 'static'}</div>
            <button type="button" data-testid="reasoning" onClick={() => props.onReasoningEffortChange('max')}>
                {props.reasoningEffort}
            </button>
        </>
    )
}))
vi.mock('./ModelSelector', () => ({
    ModelSelector: (props: {
        model: string
        options?: Array<{ value: string; label: string }>
        onModelChange: (model: string) => void
    }) => (
        <>
            <button type="button" data-testid="model" onClick={() => props.onModelChange(mocks.nextModelValue)}>
                {props.model}
            </button>
            <div data-testid="model-options">{props.options?.map((option) => option.label).join(',')}</div>
        </>
    )
}))
vi.mock('./ActionButtons', () => ({
    ActionButtons: (props: { onCreate: () => void; onChooseFolder?: () => void; canCreate: boolean }) => (
        <>
            <button type="button" data-testid="create" disabled={!props.canCreate} onClick={props.onCreate}>create</button>
            {props.onChooseFolder ? <button type="button" data-testid="browse" onClick={props.onChooseFolder}>browse</button> : null}
        </>
    )
}))

import { NewSession } from './index'

const machine = { id: 'machine-1' } as Machine
const api = { sendMessage: vi.fn().mockResolvedValue(undefined) } as unknown as ApiClient

describe('NewSession launch preferences', () => {
    afterEach(() => { vi.restoreAllMocks() })
    beforeEach(() => {
        mocks.native = false
        mocks.pickAttachments.mockReset().mockResolvedValue([])
        localStorage.clear()
        sessionStorage.clear()
        mocks.spawnSession.mockReset()
        mocks.onSuccess.mockReset()
        mocks.notification.mockReset()
        mocks.checkPathsExists.mockReset()
        mocks.checkPathsExists.mockImplementation(async () => ({
            exists: { 'C:\\repo': mocks.directoryExists }
        }))
        mocks.availableAgents.splice(
            0,
            mocks.availableAgents.length,
            ...['agy', 'claude', 'codex', 'dsh', 'copilot', 'cursor', 'grok', 'kimi', 'opencode', 'pi', 'qoder']
                .map((agent) => ({ agent, available: true }))
        )
        mocks.refreshAgentAvailability.mockReset()
        mocks.agentAvailabilityFetching = false
        mocks.agentAvailabilityLoading = false
        mocks.agentAvailabilityError = null
        mocks.outsideWorkspaceRoots = []
        mocks.codexModelsLoading = false
        mocks.agyModelsLoading = false
        mocks.agyModels = [{ modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' }]
        mocks.directoryExists = true
        mocks.copilotModels = []
        mocks.copilotModelsLoading = false
        mocks.kimiModels = []
        mocks.kimiModelsLoading = false
        mocks.kimiModelsError = null
        mocks.opencodeModels = [{ modelId: 'provider/current', name: 'Current' }]
        mocks.opencodeCurrentModelId = 'provider/current'
        mocks.opencodeModelsLoading = false
        mocks.opencodeVariants = null
        mocks.opencodeVariantsLoading = false
        mocks.opencodeVariantsEnabled = false
        mocks.piDialogSelection = ['pi-native-1']
        mocks.piModels = []
        mocks.piModelsLoading = false
        mocks.piModelsError = null
        mocks.nextModelValue = 'gpt-5.6-terra'
        mocks.refetchSessions.mockReset()
        mocks.refetchSessions.mockResolvedValue(undefined)
        mocks.addToast.mockReset()
        mocks.getShareTransfer.mockReset().mockResolvedValue(null)
        savePreferredAgent('codex')
    })

    it('defaults a shared project session to its advertised root without requiring directory input', async () => {
        const scopedMachine = { ...machine, metadata: { host: 'Training', platform: 'linux', happyCliVersion: '1',
            capabilities: ['shared-project'], workspaceRoots: ['/training'], homeDir: '/training' } } as Machine
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'new-shared-session' })
        mocks.checkPathsExists.mockResolvedValue({ exists: { '/training': true } })
        render(<NewSession api={api} machines={[scopedMachine]} onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('create')).not.toBeDisabled())
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            machineId: machine.id, directory: '/training', sessionType: 'simple'
        })))
        expect(mocks.onSuccess).toHaveBeenCalledWith('new-shared-session')
    })

    it('defaults a regular machine to its home directory instead of leaving create disabled', async () => {
        const home = 'C:\\Users\\lixinrui'
        const scopedMachine = { ...machine, metadata: { host: 'Lis-iMac', platform: 'win32', happyCliVersion: '1',
            workspaceRoots: [home], homeDir: home } } as Machine
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'new-home-session' })
        mocks.checkPathsExists.mockResolvedValue({ exists: { [home]: true } })
        render(<NewSession api={api} machines={[scopedMachine]} initialMachineId="machine-1" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('create')).not.toBeDisabled())
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            machineId: machine.id, directory: home
        })))
    })

    it('shows the launch controls and a named primary action without opening settings', async () => {
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory={'C:\\repo'}
            initialTask="Inspect the project" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        const create = screen.getByRole('button', { name: 'newTask.createAndSend' })
        await waitFor(() => expect(create).toBeEnabled())
        expect(create).toHaveTextContent('newTask.createAndSend')
        expect(screen.getByRole('button', { name: 'newSession.agent: Codex' })).toBeVisible()
        expect(screen.getByRole('button', { name: 'misc.permissionMode: Default' })).toBeVisible()
        expect(screen.getByRole('button', { name: 'newSession.directory: C:\\repo' })).toBeVisible()
        expect(screen.getByRole('combobox', { name: 'newSession.machine' })).toBeVisible()
        expect(screen.getByRole('button', { name: 'newSession.type: newSession.type.simple' })).toBeVisible()
        const model = screen.getByRole('group', { name: 'newSession.model · misc.reasoningEffort' })
        expect(within(model).getByRole('button')).toBeVisible()
        expect(within(model).queryByText('newSession.model · misc.reasoningEffort')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'newTask.moreSettings' })).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByRole('button', { name: 'codexConnect.choose' })).not.toBeInTheDocument()
        expect(screen.getByText('newSession.collaborationMode')).not.toBeVisible()
        expect(screen.queryByRole('button', { name: 'newSession.advanced' })).not.toBeInTheDocument()
        expect(mocks.spawnSession).not.toHaveBeenCalled()
    })

    it('reveals secondary options and preserves their selections after collapsing', async () => {
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'planned-task' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory={'C:\\repo'}
            initialTask="Plan the changes" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        const more = screen.getByRole('button', { name: 'newTask.moreSettings' })
        const options = document.getElementById(more.getAttribute('aria-controls')!)!
        expect(options).not.toBeVisible()
        fireEvent.click(more)
        expect(more).toHaveAttribute('aria-expanded', 'true')
        expect(within(options).getByRole('button', { name: 'codexConnect.choose' })).toBeVisible()
        fireEvent.change(within(options).getByRole('combobox'), { target: { value: 'plan' } })
        fireEvent.click(more)
        expect(options).not.toBeVisible()
        fireEvent.click(more)
        expect(within(options).getByRole('combobox')).toHaveValue('plan')
        fireEvent.click(more)

        const create = screen.getByRole('button', { name: 'newTask.createAndSend' })
        await waitFor(() => expect(create).toBeEnabled())
        fireEvent.click(create)
        await waitFor(() => expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'codex', collaborationMode: 'plan'
        })))
    })

    it('edits the visible model, effort and permission controls and sends the selected launch settings', async () => {
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'configured-task' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory={'C:\\repo'}
            initialTask="Inspect the project" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        const model = screen.getByRole('group', { name: 'newSession.model · misc.reasoningEffort' })
        await waitFor(() => expect(within(model).getByRole('button')).toBeEnabled())
        fireEvent.click(within(model).getByRole('button'))
        fireEvent.click(screen.getByRole('button', { name: 'Default' }))
        fireEvent.click(screen.getByRole('button', { name: 'GPT-5.6 Terra' }))
        fireEvent.click(screen.getByRole('button', { name: 'max' }))
        fireEvent.click(screen.getByRole('button', { name: 'composer.modelPicker.close' }))
        expect(within(model).getByRole('button')).toHaveTextContent('GPT-5.6 Terra · max')

        fireEvent.click(screen.getByRole('button', { name: 'misc.permissionMode: Default' }))
        fireEvent.change(screen.getByRole('combobox', { name: 'misc.permissionMode' }), { target: { value: 'yolo' } })
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
        expect(screen.getByRole('button', { name: 'misc.permissionMode: Yolo' })).toBeVisible()
        expect(mocks.spawnSession).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'newTask.createAndSend' }))
        await waitFor(() => expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'codex', model: 'gpt-5.6-terra', modelReasoningEffort: 'max', permissionMode: 'yolo'
        })))
    })

    it('edits the agent, directory and worktree using the existing controls', async () => {
        const taskApi = { ...api, listMachineDirectory: vi.fn().mockResolvedValue({ success: true, entries: [] }) } as unknown as ApiClient
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'worktree-task' })
        render(<NewSession api={taskApi} machines={[machine]} initialMachineId="machine-1" initialDirectory={'C:\\repo'}
            initialTask="Inspect the project" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        const agent = screen.getByRole('button', { name: 'newSession.agent: Codex' })
        await waitFor(() => expect(agent).toBeEnabled())
        fireEvent.click(agent)
        fireEvent.click(screen.getByRole('radio', { name: 'Claude' }))
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
        expect(screen.getByRole('button', { name: 'newSession.agent: Claude' })).toBeVisible()

        const directory = screen.getByRole('button', { name: 'newSession.directory: C:\\repo' })
        fireEvent.click(directory)
        await waitFor(() => expect(taskApi.listMachineDirectory).toHaveBeenCalled())
        fireEvent.change(screen.getByRole('textbox', { name: 'newSession.directory' }), { target: { value: '/project' } })
        fireEvent.click(screen.getByRole('button', { name: 'directoryPicker.selectNamed' }))
        expect(screen.getByRole('button', { name: 'newSession.directory: /project' })).toBeVisible()
        await waitFor(() => expect(directory).toHaveFocus())

        fireEvent.click(screen.getByRole('button', { name: 'newSession.type: newSession.type.simple' }))
        fireEvent.click(screen.getByRole('radio', { name: 'newSession.type.worktree' }))
        const worktree = screen.getByPlaceholderText('newSession.type.worktree.placeholder')
        expect(worktree).toHaveFocus()
        fireEvent.change(worktree, { target: { value: 'feature-ui' } })
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
        expect(screen.getByRole('button', { name: 'newSession.type: newSession.type.worktree · feature-ui' })).toBeVisible()
        fireEvent.click(screen.getByRole('button', { name: 'newTask.createAndSend' }))
        await waitFor(() => expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'claude', directory: '/project', sessionType: 'worktree', worktreeName: 'feature-ui'
        })))
    })

    it.each([
        ['no directory', 'newSession.directoryRequired'],
        ['offline machine', 'newTask.machineRequired'],
        ['loading machines', 'loading.machines'],
        ['loading agents', 'newSession.agentAvailabilityLoading'],
        ['failed agent discovery', 'newSession.agentAvailabilityFailed'],
        ['unavailable agent', 'newSession.agentUnavailable'],
        ['outside workspace', 'newSession.directoryOutsideWorkspaceRoots'],
        ['restoring attachments', 'newTask.restoringAttachments'],
        ['validating model', 'newTask.checkingSettings'],
    ])('explains a disabled primary action for %s', async (state, reason) => {
        if (state === 'loading agents') mocks.agentAvailabilityLoading = true
        if (state === 'failed agent discovery') mocks.agentAvailabilityError = 'offline'
        if (state === 'unavailable agent') mocks.availableAgents.splice(0)
        if (state === 'outside workspace') mocks.outsideWorkspaceRoots = ['C:\\repo']
        if (state === 'restoring attachments') vi.spyOn(attachmentDrafts, 'getDraftAttachments').mockReturnValue(new Promise(() => {}))
        if (state === 'validating model') {
            mocks.codexModelsLoading = true
            savePreferredLaunchSettings('machine-1', 'codex', { model: 'gpt-5.6-terra', cursorSelectedBase: 'auto', effort: 'auto', modelReasoningEffort: 'max' })
        }
        render(<NewSession api={api} machines={state === 'offline machine' ? [] : [machine]} initialMachineId="machine-1"
            initialDirectory={state === 'no directory' ? '' : 'C:\\repo'} isLoading={state === 'loading machines'}
            initialTask="Inspect the project" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        const create = screen.getByRole('button', { name: 'newTask.createAndSend' })
        await waitFor(() => expect(create).toHaveAccessibleDescription(reason))
        expect(create).toBeDisabled()
        expect(document.getElementById(create.getAttribute('aria-describedby')!)).toBeVisible()
        expect(mocks.spawnSession).not.toHaveBeenCalled()
    })

    it('creates a session without a task and opens the chat without sending a message', async () => {
        const sendMessage = vi.fn().mockResolvedValue(undefined)
        const onCreated = vi.fn()
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'empty-session' })
        render(<NewSession api={{ sendMessage } as unknown as ApiClient} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo"
            initialTask="" onCreated={onCreated} onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        const create = screen.getByRole('button', { name: 'newTask.createSession' })
        await waitFor(() => expect(create).toBeEnabled())
        expect(screen.getByText('newTask.emptyHint')).toBeVisible()
        fireEvent.click(create)
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('empty-session'))
        expect(mocks.spawnSession).toHaveBeenCalledTimes(1)
        expect(sendMessage).not.toHaveBeenCalled()
        expect(onCreated).toHaveBeenCalledWith('empty-session', undefined)
        expect(onCreated.mock.invocationCallOrder[0]).toBeLessThan(mocks.onSuccess.mock.invocationCallOrder[0])
        expect(mocks.notification).toHaveBeenCalledWith('success')
    })

    it('switches the primary action back to create and send once the task has text', async () => {
        function TaskComposer() {
            const [task, setTask] = useState('')
            return <NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo"
                initialTask={task} onInitialTaskChange={setTask} onSuccess={mocks.onSuccess} onCancel={() => {}} />
        }
        render(<TaskComposer />)
        const create = screen.getByRole('button', { name: 'newTask.createSession' })
        await waitFor(() => expect(create).toBeEnabled())
        expect(screen.getByText('newTask.emptyHint')).toBeVisible()
        fireEvent.change(screen.getByRole('textbox', { name: 'sessions.task.initial' }), { target: { value: 'Inspect the project' } })
        await waitFor(() => expect(screen.getByRole('button', { name: 'newTask.createAndSend' })).toBeEnabled())
        expect(screen.queryByText('newTask.emptyHint')).not.toBeInTheDocument()
    })

    it('shows progress as the disabled action reason while creating', async () => {
        mocks.checkPathsExists.mockReturnValue(new Promise(() => {}))
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory={'C:\\repo'}
            initialTask="Inspect the project" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'newTask.createAndSend' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'newTask.createAndSend' }))
        const create = screen.getByRole('button', { name: 'newTask.sending' })
        expect(create).toBeDisabled()
        expect(create).toHaveAccessibleDescription('newTask.sending')
        expect(document.getElementById(create.getAttribute('aria-describedby')!)).toBeVisible()
        expect(screen.getByRole('button', { name: 'newSession.directory: C:\\repo' })).toBeDisabled()
    })

    it('keeps missing-directory confirmation and explains why a missing worktree cannot launch', async () => {
        mocks.directoryExists = false
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'new-folder-task' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory={'C:\\repo'}
            initialTask="Inspect the project" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'newTask.createAndSend' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'newSession.type: newSession.type.simple' }))
        fireEvent.click(screen.getByRole('radio', { name: 'newSession.type.worktree' }))
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
        expect(screen.getByRole('button', { name: 'newTask.createAndSend' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'newTask.createAndSend' })).toHaveAccessibleDescription('session.directoryMissingWorktree')
        fireEvent.click(screen.getByRole('button', { name: 'newSession.type: newSession.type.worktree' }))
        fireEvent.click(screen.getByRole('radio', { name: /newSession.type.simple/ }))
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
        fireEvent.click(screen.getByRole('button', { name: 'newTask.createAndSend' }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'session.createAndCreateDirectory' })).toBeEnabled())
        expect(mocks.spawnSession).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'session.createAndCreateDirectory' }))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('new-folder-task'))
    })

    it('keeps the initial task on launch failure and sends it before navigating after success', async () => {
        const onCreated = vi.fn(), onChange = vi.fn()
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo"
            initialTask="Inspect the list" onInitialTaskChange={onChange} onCreated={onCreated}
            onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        const task = screen.getByRole('textbox', { name: 'sessions.task.initial' })
        expect(task).toHaveValue('Inspect the list')
        fireEvent.change(task, { target: { value: 'Inspect the list and children' } })
        expect(onChange).toHaveBeenCalledWith('Inspect the list and children')
        await waitFor(() => expect(screen.getByRole('button', { name: 'newTask.createAndSend' })).toBeEnabled())
        mocks.spawnSession.mockResolvedValueOnce({ type: 'error', message: 'Synthetic failure' })
        fireEvent.click(screen.getByRole('button', { name: 'newTask.createAndSend' }))
        await waitFor(() => expect(screen.getByText('Synthetic failure')).toBeTruthy())
        expect(onCreated).not.toHaveBeenCalled()
        expect(mocks.onSuccess).not.toHaveBeenCalled()
        mocks.spawnSession.mockResolvedValueOnce({ type: 'success', sessionId: 'fresh-session' })
        fireEvent.click(screen.getByRole('button', { name: 'newTask.retryDelivery' }))
        await waitFor(() => expect(onCreated).toHaveBeenCalledWith('fresh-session', undefined))
        expect(api.sendMessage).toHaveBeenCalledWith('fresh-session', 'Inspect the list', expect.any(String), undefined)
        expect(mocks.onSuccess).toHaveBeenCalledWith('fresh-session')
        expect(onCreated.mock.invocationCallOrder[0]).toBeLessThan(mocks.onSuccess.mock.invocationCallOrder[0])
    })

    it('reuses the created session and message identity after a failed send and remount', async () => {
        const sendMessage = vi.fn().mockRejectedValueOnce(new Error('Send timeout')).mockResolvedValueOnce(undefined)
        const taskApi = { sendMessage } as unknown as ApiClient
        const props = { api: taskApi, machines: [machine], initialMachineId: 'machine-1', initialDirectory: '/project', initialTask: 'Keep exact text', draftKey: 'reload-test', onSuccess: mocks.onSuccess, onCancel: () => {} }
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'created-once' })
        const view = render(<NewSession {...props} />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'newTask.createAndSend' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'newTask.createAndSend' }))
        await waitFor(() => expect(screen.getByText('Send timeout')).toBeTruthy())
        expect(screen.getByRole('textbox', { name: 'sessions.task.initial' })).toHaveValue('Keep exact text')
        expect(mocks.onSuccess).not.toHaveBeenCalled()
        view.unmount()
        render(<NewSession {...props} initialTask="" />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'newTask.retryDelivery' })).toBeEnabled())
        expect(screen.getByRole('textbox', { name: 'sessions.task.initial' })).toHaveValue('Keep exact text')
        fireEvent.click(screen.getByRole('button', { name: 'newTask.retryDelivery' }))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('created-once'))
        expect(mocks.spawnSession).toHaveBeenCalledTimes(1)
        expect(sendMessage.mock.calls[0]).toEqual(sendMessage.mock.calls[1])
    })

    it('allows frozen delivery retry even if live capability selection becomes invalid', async () => {
        const delivery = { ...createNewTaskDelivery('Frozen task', []), sessionId: 'known-session' }
        saveNewTaskDelivery('invalid-after-failure', delivery)
        saveNewSessionFormDraft({ agent: 'codex', model: 'gpt-5.6-terra', cursorSelectedBase: 'auto', machineId: 'machine-1', effort: 'auto', modelReasoningEffort: 'xhigh', serviceTier: 'standard', collaborationMode: 'default', copilotAgentMode: 'interactive', yoloMode: false, nativePermissionMode: 'default', grokPermissionMode: 'default', sessionType: 'simple', worktreeName: '' })
        const sendMessage = vi.fn().mockResolvedValue(undefined)
        render(<NewSession api={{ sendMessage } as unknown as ApiClient} machines={[machine]} draftKey="invalid-after-failure" initialMachineId="machine-1" initialDirectory="/project" initialTask="Frozen task" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByText('newTask.invalidSelection')).toBeTruthy())
        await waitFor(() => expect(screen.getByRole('button', { name: 'newTask.retryDelivery' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'newTask.retryDelivery' }))
        await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('known-session', 'Frozen task', delivery.localId, undefined))
        expect(mocks.spawnSession).not.toHaveBeenCalled()
    })

    it('sends shared-file-only new tasks and retains their files after upload failure', async () => {
        mocks.getShareTransfer.mockResolvedValue({ title: '', text: '', url: '', createdAt: 1, files: [{ name: 'notes.txt', type: 'text/plain', blob: new Blob(['notes']) }] })
        const uploadFile = vi.fn().mockRejectedValueOnce(new Error('Upload failed')).mockResolvedValue({ success: true, path: '/uploads/notes.txt' })
        const sendMessage = vi.fn().mockResolvedValue(undefined)
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'shared-session' })
        render(<NewSession api={{ uploadFile, sendMessage } as unknown as ApiClient} machines={[machine]} draftKey="share-file-test" shareTransferId="transfer-1" initialMachineId="machine-1" initialDirectory="/project" initialTask="" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByText('notes.txt')).toBeTruthy())
        fireEvent.click(screen.getByRole('button', { name: 'newTask.createAndSend' }))
        await waitFor(() => expect(screen.getByText('Upload failed')).toBeTruthy())
        expect(screen.getByText('notes.txt')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'newTask.retryDelivery' }))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('shared-session'))
        expect(mocks.spawnSession).toHaveBeenCalledTimes(1)
        expect(sendMessage).toHaveBeenCalledWith('shared-session', '', expect.any(String), [expect.objectContaining({ filename: 'notes.txt', path: '/uploads/notes.txt' })])
    })

    it('keeps native picks in the local new-task draft and uses the existing upload pipeline on Send', async () => {
        mocks.native = true
        const file = new File(['original image bytes'], 'IMG_0007.HEIC', { type: 'image/heic' })
        mocks.pickAttachments.mockResolvedValue([file])
        const uploadFile = vi.fn().mockResolvedValue({ success: true, path: '/uploads/photo.heic' })
        const sendMessage = vi.fn().mockResolvedValue(undefined)
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'native-task' })
        render(<NewSession api={{ uploadFile, sendMessage } as unknown as ApiClient} machines={[machine]}
            draftKey="native-file-test" initialMachineId="machine-1" initialDirectory="/project" initialTask="Inspect this photo"
            onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'newTask.attachFiles' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'newTask.attachFiles' }))
        fireEvent.click(screen.getByRole('button', { name: 'attachments.picker.photos' }))
        await waitFor(() => expect(screen.getByText('IMG_0007.HEIC')).toBeInTheDocument())
        expect(mocks.spawnSession).not.toHaveBeenCalled()
        expect(uploadFile).not.toHaveBeenCalled()
        expect(document.querySelector('input[type="file"]')).toBeNull()

        // Dismissing another selection retains the already selected original.
        mocks.pickAttachments.mockResolvedValueOnce([])
        fireEvent.click(screen.getByRole('button', { name: 'newTask.attachFiles' }))
        fireEvent.click(screen.getByRole('button', { name: 'attachments.picker.files' }))
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(screen.getByText('IMG_0007.HEIC')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'newTask.createAndSend' }))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('native-task'))
        expect(uploadFile).toHaveBeenCalledWith('native-task', 'IMG_0007.HEIC', btoa('original image bytes'), 'image/heic')
        expect(sendMessage).toHaveBeenCalledWith('native-task', 'Inspect this photo', expect.any(String), [expect.objectContaining({
            filename: 'IMG_0007.HEIC', mimeType: 'image/heic', size: file.size, path: '/uploads/photo.heic',
        })])
    })

    it('waits for the new-task attachment draft transaction before a native update reload', async () => {
        mocks.native = true
        let finish!: () => void
        const flush = vi.spyOn(attachmentDrafts, 'flushDraftAttachmentWrites').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
        render(<NewSession api={api} machines={[machine]} draftKey="native-update-task" initialMachineId="machine-1"
            initialDirectory="C:\\repo" initialTask="Keep the current new task" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'newTask.createAndSend' })).toBeEnabled())
        let prepared = false
        const preparing = nativeUpdateReload.prepareNativeUpdateReload().then(() => { prepared = true })
        await waitFor(() => expect(flush).toHaveBeenCalledWith('native-update-task'))
        expect(prepared).toBe(false)
        finish()
        await preparing
        expect(prepared).toBe(true)
        expect(loadNativeUpdateNewSessionDraft('native-update-task')).toMatchObject({ text: 'Keep the current new task' })
    })

    it('restores the chosen machine, directory, model and effort after a native update instead of reverting to route defaults', async () => {
        mocks.native = true
        vi.spyOn(attachmentDrafts, 'flushDraftAttachmentWrites').mockResolvedValue()
        const props = {
            api, machines: [machine, { ...machine, id: 'machine-2' }], draftKey: 'native-update-form',
            initialMachineId: 'machine-1', initialDirectory: 'C:\\repo', onSuccess: mocks.onSuccess, onCancel: () => {},
        }
        const view = render(<NewSession {...props} />)
        fireEvent.change(screen.getByRole('combobox', { name: 'newSession.machine' }), { target: { value: 'machine-2' } })
        view.rerender(<NewSession {...props} initialDirectory="/chosen-folder" />)
        fireEvent.click(screen.getByTestId('model'))
        fireEvent.click(screen.getByTestId('reasoning'))
        await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
        await nativeUpdateReload.prepareNativeUpdateReload()
        expect(loadNativeUpdateNewSessionDraft('native-update-form')).toMatchObject({
            directory: '/chosen-folder', form: { machineId: 'machine-2', model: 'gpt-5.6-terra', modelReasoningEffort: 'max' },
        })
        view.unmount()
        nativeUpdateReload.restoreNativeUpdateRoute()
        render(<NewSession {...props} />)
        await waitFor(() => expect(screen.getByTestId('model')).toHaveTextContent('gpt-5.6-terra'))
        expect(screen.getByRole('combobox', { name: 'newSession.machine' })).toHaveValue('machine-2')
        expect(screen.getByTestId('reasoning')).toHaveTextContent('max')
        expect(loadNativeUpdateNewSessionDraft('native-update-form')).toBeNull()
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-2', directory: '/chosen-folder', model: 'gpt-5.6-terra', modelReasoningEffort: 'max',
        })))
    })

    it('aborts native updates when new-task files cannot be saved', async () => {
        mocks.native = true
        vi.spyOn(attachmentDrafts, 'flushDraftAttachmentWrites').mockRejectedValue(new Error('Attachment transaction failed'))
        render(<NewSession api={api} machines={[machine]} draftKey="native-update-write-error" initialMachineId="machine-1"
            initialDirectory="C:\\repo" initialTask="Keep this task" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'newTask.createAndSend' })).toBeEnabled())
        await expect(nativeUpdateReload.prepareNativeUpdateReload()).rejects.toThrow('Attachment transaction failed')
        expect(loadNativeUpdateNewSessionDraft('native-update-write-error')).toBeNull()
        expect(sessionStorage.getItem('hapi:native-update-route')).toBeNull()
    })

    it('aborts native updates while new-task file hydration is incomplete', async () => {
        mocks.native = true
        vi.spyOn(attachmentDrafts, 'getDraftAttachments').mockReturnValue(new Promise(() => {}))
        render(<NewSession api={api} machines={[machine]} draftKey="native-update-loading" initialTask="Keep this task"
            onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await expect(nativeUpdateReload.prepareNativeUpdateReload()).rejects.toThrow('draft is still loading')
        expect(sessionStorage.getItem('hapi:native-update-route')).toBeNull()
    })

    it('aborts native updates during a pending spawn so request identity cannot be lost', async () => {
        mocks.native = true
        let finish!: (value: { type: 'success'; sessionId: string }) => void
        mocks.spawnSession.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
        render(<NewSession api={api} machines={[machine]} draftKey="native-update-pending" initialMachineId="machine-1"
            initialDirectory="C:\\repo" initialTask="Keep this task" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'newTask.createAndSend' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'newTask.createAndSend' }))
        await waitFor(() => expect(mocks.spawnSession).toHaveBeenCalledTimes(1))
        await expect(nativeUpdateReload.prepareNativeUpdateReload()).rejects.toThrow('pending session operation')
        await act(async () => { finish({ type: 'success', sessionId: 'finished-after-update-abort' }) })
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('finished-after-update-abort'))
    })

    it('finishes the frozen old share without consuming a newly routed share payload', async () => {
        const delivery = { ...createNewTaskDelivery('Original shared task', []), sessionId: 'old-session', shareTransferId: 'old-share' }
        saveNewTaskDelivery('late-share-test', delivery)
        const onCreated = vi.fn()
        const sendMessage = vi.fn().mockResolvedValue(undefined)
        render(<NewSession api={{ sendMessage } as unknown as ApiClient} machines={[]} draftKey="late-share-test" shareTransferId="new-share" initialTask="Different task" onCreated={onCreated} onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'newTask.retryDelivery' })).toBeEnabled())
        expect(screen.getByRole('textbox', { name: 'sessions.task.initial' })).toHaveValue('Original shared task')
        expect(mocks.getShareTransfer).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'newTask.retryDelivery' }))
        await waitFor(() => expect(onCreated).toHaveBeenCalledWith('old-session', 'old-share'))
        expect(sendMessage).toHaveBeenCalledWith('old-session', 'Original shared task', delivery.localId, undefined)
        expect(mocks.spawnSession).not.toHaveBeenCalled()
    })

    it.each(['agy', 'opencode'] as const)('keeps an unavailable explicit %s model and requires a supported choice in the new-task picker', async (agent) => {
        savePreferredAgent(agent)
        mocks.directoryExists = true
        mocks.opencodeModels = [{ modelId: 'provider/available', name: 'Available model' }]
        mocks.opencodeCurrentModelId = 'provider/available'
        saveNewSessionFormDraft({ agent, model: 'missing-model', cursorSelectedBase: 'auto', machineId: 'machine-1', effort: 'auto', modelReasoningEffort: 'default', serviceTier: 'standard', collaborationMode: 'default', copilotAgentMode: 'interactive', yoloMode: false, nativePermissionMode: 'default', grokPermissionMode: 'default', sessionType: 'simple', worktreeName: '' })
        render(<NewSession api={api} machines={[machine]} draftKey={`unsupported-${agent}`} initialMachineId="machine-1" initialDirectory={'C:\\repo'} initialTask="Keep the selected model" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByText('newTask.invalidSelection')).toBeTruthy())
        expect(screen.getByRole('button', { name: 'newTask.createAndSend' })).toBeDisabled()
        const capsule = screen.getByRole('button', { name: /missing-model/ })
        fireEvent.click(capsule)
        fireEvent.click(screen.getByRole('button', { name: /missing-model/ }))
        fireEvent.click(screen.getByRole('button', { name: 'newSession.model.default' }))
        await waitFor(() => expect(screen.queryByText('newTask.invalidSelection')).toBeNull())
        expect(mocks.spawnSession).not.toHaveBeenCalled()
    })

    it('does not submit IME confirmation Enter or Shift+Enter', async () => {
        render(<NewSession api={api} machines={[machine]} draftKey="ime-test" initialMachineId="machine-1" initialDirectory="/project" initialTask="Draft" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'newTask.createAndSend' })).toBeEnabled())
        const input = screen.getByRole('textbox', { name: 'sessions.task.initial' })
        fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
        fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
        fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
        expect(mocks.spawnSession).not.toHaveBeenCalled()
    })

    it('connects the selected native thread and opens its binding without importing or spawning', async () => {
        const onCreated = vi.fn()
        const codexApi = {
            getCodexSessions: vi.fn().mockResolvedValue({ success: true, machineId: 'machine-1', sessions: [{ id: 'native-1', title: 'History', cwd: '/project', file: '/fixture.jsonl', modifiedAt: 1 }] }),
            connectCodexSession: vi.fn().mockResolvedValue({ sessionId: 'native-binding-1', threadId: 'native-1', connectionState: 'attached' }),
            syncCodexSession: vi.fn(),
            getCodexDuplicateSessions: vi.fn().mockResolvedValue({ success: true, duplicates: [] }),
            resumeSession: vi.fn()
        } as unknown as ApiClient
        render(<NewSession api={codexApi} machines={[machine]} initialMachineId="machine-1" initialDirectory="/project" initialTask="Keep this task" onCreated={onCreated} onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        fireEvent.click(screen.getByRole('button', { name: 'newTask.moreSettings' }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'codexConnect.choose' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'codexConnect.choose' }))
        await waitFor(() => expect(screen.getByTestId('import-codex')).toBeEnabled())
        fireEvent.click(screen.getByTestId('import-codex'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('native-binding-1'))
        expect(codexApi.connectCodexSession).toHaveBeenCalledWith('native-1', 'machine-1')
        expect(codexApi.syncCodexSession).not.toHaveBeenCalled()
        expect(codexApi.resumeSession).not.toHaveBeenCalled()
        expect(mocks.spawnSession).not.toHaveBeenCalled()
        expect(onCreated).not.toHaveBeenCalled()
        expect(screen.getByRole('textbox', { name: 'sessions.task.initial' })).toHaveValue('Keep this task')
    })

    it('ignores a late native connection result after the selected machine changes', async () => {
        let resolve!: (value: unknown) => void;
        const codexApi = {
            getCodexSessions: vi.fn().mockResolvedValue({ success: true, sessions: [{ id: 'native-1' }] }),
            connectCodexSession: vi.fn().mockImplementation(() => new Promise(done => { resolve = done; })),
            getCodexDuplicateSessions: vi.fn().mockResolvedValue({ success: true, duplicates: [] })
        } as unknown as ApiClient;
        render(<NewSession api={codexApi} machines={[machine, { ...machine, id: 'machine-2' }]} initialMachineId="machine-1" initialDirectory="/project" onSuccess={mocks.onSuccess} onCancel={() => {}} />);
        await waitFor(() => expect(screen.getByRole('button', { name: 'codexConnect.choose' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'codexConnect.choose' }));
        await waitFor(() => expect(screen.getByTestId('import-codex')).toBeEnabled());
        fireEvent.click(screen.getByTestId('import-codex'));
        fireEvent.change(screen.getByRole('combobox', { name: 'newSession.machine' }), { target: { value: 'machine-2' } });
        await act(async () => resolve({ sessionId: 'late-binding', threadId: 'native-1', connectionState: 'attached' }));
        expect(mocks.onSuccess).not.toHaveBeenCalled();
    });

    it('keeps the selected machine and shows the connection failure when it temporarily goes offline', async () => {
        let rejectConnection!: (error: Error) => void
        const codexApi = {
            getCodexSessions: vi.fn().mockResolvedValue({ success: true, machineId: 'machine-1', sessions: [{ id: 'native-1' }] }),
            connectCodexSession: vi.fn().mockImplementation(() => new Promise((_, reject) => { rejectConnection = reject })),
        } as unknown as ApiClient
        const props = { api: codexApi, initialMachineId: 'machine-1', initialDirectory: '/project', onSuccess: mocks.onSuccess, onCancel: vi.fn() }
        const otherMachine = { ...machine, id: 'machine-2' }
        const view = render(<NewSession {...props} machines={[machine, otherMachine]} />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'codexConnect.choose' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'codexConnect.choose' }))
        await waitFor(() => expect(screen.getByTestId('import-codex')).toBeEnabled())
        fireEvent.click(screen.getByTestId('import-codex'))
        view.rerender(<NewSession {...props} machines={[otherMachine]} />)
        await act(async () => rejectConnection(new Error('Selected Runner disconnected')))
        expect(screen.getByTestId('codex-search-results')).toHaveTextContent('native-1')
        expect(screen.getByTestId('codex-list-error')).toHaveTextContent('Selected Runner disconnected')
        expect(mocks.onSuccess).not.toHaveBeenCalled()
        view.rerender(<NewSession {...props} machines={[machine, otherMachine]} />)
        expect(screen.getByRole('combobox', { name: 'newSession.machine' })).toHaveValue('machine-1')
    })

    it('opens the confirmed binding when a directory update arrives during connection', async () => {
        let resolveConnection!: (value: unknown) => void
        const codexApi = {
            getCodexSessions: vi.fn().mockResolvedValue({ success: true, machineId: 'machine-1', sessions: [{ id: 'native-1' }] }),
            connectCodexSession: vi.fn().mockImplementation(() => new Promise(resolve => { resolveConnection = resolve })),
        } as unknown as ApiClient
        const props = { api: codexApi, machines: [machine], initialMachineId: 'machine-1', onSuccess: mocks.onSuccess, onCancel: vi.fn() }
        const view = render(<NewSession {...props} initialDirectory="/project" />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'codexConnect.choose' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'codexConnect.choose' }))
        await waitFor(() => expect(screen.getByTestId('import-codex')).toBeEnabled())
        fireEvent.click(screen.getByTestId('import-codex'))
        view.rerender(<NewSession {...props} initialDirectory="/another-directory" />)
        await act(async () => resolveConnection({ sessionId: 'confirmed-binding', threadId: 'native-1', connectionState: 'attached' }))
        expect(mocks.onSuccess).toHaveBeenCalledWith('confirmed-binding')
    })

    it('opens a confirmed connection despite a transient online-list removal', async () => {
        let resolveConnection!: (value: unknown) => void
        const codexApi = {
            getCodexSessions: vi.fn().mockResolvedValue({ success: true, machineId: 'machine-1', sessions: [{ id: 'native-1' }] }),
            connectCodexSession: vi.fn().mockImplementation(() => new Promise(resolve => { resolveConnection = resolve })),
        } as unknown as ApiClient
        const props = { api: codexApi, initialMachineId: 'machine-1', onSuccess: mocks.onSuccess, onCancel: vi.fn() }
        const otherMachine = { ...machine, id: 'machine-2' }
        const view = render(<NewSession {...props} machines={[machine, otherMachine]} />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'codexConnect.choose' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'codexConnect.choose' }))
        await waitFor(() => expect(screen.getByTestId('import-codex')).toBeEnabled())
        fireEvent.click(screen.getByTestId('import-codex'))
        view.rerender(<NewSession {...props} machines={[otherMachine]} />)
        await act(async () => resolveConnection({ sessionId: 'confirmed-binding', threadId: 'native-1', connectionState: 'attached' }))
        expect(mocks.onSuccess).toHaveBeenCalledWith('confirmed-binding')
    })

    it('warms the catalog before opening and reuses the same in-flight request', async () => {
        savePreferredAgent('codex')
        let finish!: (value: unknown) => void
        const codexApi = { getCodexSessions: vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve })) } as unknown as ApiClient
        render(<NewSession api={codexApi} machines={[{ ...machine, active: true }]} initialMachineId="machine-1" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(codexApi.getCodexSessions).toHaveBeenCalledTimes(1))
        expect(screen.queryByTestId('codex-search-results')).not.toBeInTheDocument()
        await waitFor(() => expect(screen.getByRole('button', { name: 'codexConnect.choose' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'codexConnect.choose' }))
        await act(async () => finish({ success: true, sessions: [{ id: 'warm' }], nextCursor: null }))
        expect(screen.getByTestId('codex-search-results')).toHaveTextContent('warm')
        expect(codexApi.getCodexSessions).toHaveBeenCalledTimes(1)
    })

    it('debounces incremental searches, resets the cursor, and rejects an older page arriving during debounce', async () => {
        let finishOldPage!: (value: unknown) => void
        const codexApi = {
            getCodexSessions: vi.fn()
                .mockResolvedValueOnce({ success: true, sessions: [{ id: 'recent' }], nextCursor: 50 })
                .mockImplementationOnce(() => new Promise(resolve => { finishOldPage = resolve }))
                .mockResolvedValue({ success: true, sessions: [{ id: 'old-o-debug' }], nextCursor: null })
        } as unknown as ApiClient
        render(<NewSession api={codexApi} machines={[machine]} initialMachineId="machine-1" initialDirectory="/project" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'codexConnect.choose' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'codexConnect.choose' }))
        await waitFor(() => expect(screen.getByTestId('codex-more')).toBeEnabled())
        fireEvent.click(screen.getByTestId('codex-more'))
        expect(codexApi.getCodexSessions).toHaveBeenLastCalledWith(null, 'machine-1', { search: '', cursor: 50, limit: 50 })
        fireEvent.change(screen.getByTestId('codex-search'), { target: { value: 'o-' } })
        fireEvent.change(screen.getByTestId('codex-search'), { target: { value: 'o-debug' } })
        await act(async () => finishOldPage({ success: true, sessions: [{ id: 'stale' }], nextCursor: 100 }))
        expect(screen.getByTestId('codex-search-results')).toBeEmptyDOMElement()
        await waitFor(() => expect(screen.getByTestId('codex-search-results')).toHaveTextContent('old-o-debug'))
        expect(codexApi.getCodexSessions).toHaveBeenCalledTimes(3)
        expect(codexApi.getCodexSessions).toHaveBeenLastCalledWith(null, 'machine-1', { search: 'o-debug', cursor: undefined, limit: 50 })
        expect(screen.queryByTestId('codex-more')).not.toBeInTheDocument()
    })

    it('appends subsequent search pages without duplicate sessions', async () => {
        const codexApi = {
            getCodexSessions: vi.fn()
                .mockResolvedValueOnce({ success: true, sessions: [{ id: 'first' }], nextCursor: 50 })
                .mockResolvedValueOnce({ success: true, sessions: [{ id: 'first' }, { id: 'second' }], nextCursor: null })
        } as unknown as ApiClient
        render(<NewSession api={codexApi} machines={[machine]} initialMachineId="machine-1" initialDirectory="/project" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'codexConnect.choose' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'codexConnect.choose' }))
        await waitFor(() => expect(screen.getByTestId('codex-more')).toBeEnabled())
        fireEvent.click(screen.getByTestId('codex-more'))
        await waitFor(() => expect(screen.getByTestId('codex-search-results')).toHaveTextContent('first,second'))
    })

    it('surfaces an unavailable Codex list in the dialog and retries successfully', async () => {
        const codexApi = { getCodexSessions: vi.fn().mockRejectedValueOnce(new Error('Runner unavailable')).mockResolvedValueOnce({ success: true, sessions: [{ id: 'native-1' }] }) } as unknown as ApiClient
        render(<NewSession api={codexApi} machines={[machine]} initialMachineId="machine-1" initialDirectory="/project" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'codexConnect.choose' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'codexConnect.choose' }))
        await waitFor(() => expect(screen.getByTestId('codex-list-error')).toHaveTextContent('Runner unavailable'))
        fireEvent.click(screen.getByTestId('codex-retry'))
        await waitFor(() => expect(screen.getByTestId('import-codex')).toBeEnabled())
        expect(screen.getByTestId('codex-list-error')).toBeEmptyDOMElement()
    })

    it('hides unavailable Agents and falls back to the first available Agent', async () => {
        savePreferredAgent('claude')
        mocks.availableAgents.splice(
            0,
            mocks.availableAgents.length,
            { agent: 'codex', available: true }
        )

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => expect(screen.getByDisplayValue('codex')).toBeChecked())
        expect(screen.queryByDisplayValue('claude')).not.toBeInTheDocument()
    })

    it.each([false, true])('reveals DSH diagnostics and refreshes the machine catalog in the new-task form: %s', async (newTask) => {
        savePreferredAgent('claude')
        mocks.availableAgents.splice(0, mocks.availableAgents.length,
            { agent: 'claude', available: true },
            { agent: 'codex', available: true },
            { agent: 'dsh', available: false, reason: 'invalid_configuration' }
        )
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo"
            initialTask={newTask ? 'Inspect project' : undefined} onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        if (newTask) {
            await waitFor(() => expect(screen.getByRole('button', { name: 'newSession.agent: Claude' })).toBeEnabled())
            fireEvent.click(screen.getByRole('button', { name: 'newSession.agent: Claude' }))
        }

        expect(screen.queryByText('DeepSeek Harness (DSH)')).not.toBeInTheDocument()
        await waitFor(() => expect(screen.getByRole('button', { name: 'newSession.otherAgents' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'newSession.otherAgents' }))
        const dsh = screen.getByText('DeepSeek Harness (DSH)').closest('li')!
        expect(within(dsh).getByText('newSession.agentConfigurationInvalid')).toBeInTheDocument()
        expect(screen.queryByDisplayValue('dsh')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'newSession.refreshAgents' }))
        expect(mocks.refreshAgentAvailability).toHaveBeenCalledOnce()
        expect(mocks.spawnSession).not.toHaveBeenCalled()
    })

    it('refuses a directory rejected by workspace-root validation', async () => {
        mocks.checkPathsExists.mockImplementation(async ([path]: string[]) => ({
            exists: { [path]: false },
            outsideWorkspaceRoots: [path]
        }))
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'unexpected' })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(screen.getByText('newSession.directoryOutsideWorkspaceRoots')).toBeInTheDocument())
        expect(mocks.spawnSession).not.toHaveBeenCalled()
    })

    it('restores the last successful model and reasoning effort for the machine and agent', async () => {
        savePreferredLaunchSettings('machine-1', 'codex', {
            model: 'gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'xhigh',
            permissionMode: 'safe-yolo'
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('gpt-5.6-sol')
            expect(screen.getByTestId('reasoning')).toHaveTextContent('xhigh')
            expect(screen.getByRole('combobox', { name: 'misc.permissionMode' })).toHaveValue('default')
        })
    })

    it('does not migrate a legacy YOLO value owned by a non-Codex agent', async () => {
        savePreferredAgent('claude')
        savePreferredYoloMode(true)

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByDisplayValue('codex'))

        await waitFor(() => {
            expect(screen.getByRole('combobox', { name: 'misc.permissionMode' })).toHaveValue('default')
        })
    })

    it('migrates a legacy YOLO value when Codex was the preferred agent', async () => {
        savePreferredAgent('codex')
        savePreferredYoloMode(true)

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByRole('combobox', { name: 'misc.permissionMode' })).toHaveValue('yolo')
        })
    })

    it('shows discovered Copilot models for the selected directory', async () => {
        mocks.copilotModels = [
            { modelId: 'gpt-5.6', name: 'GPT-5.6' },
            { modelId: 'auto', name: 'Auto' }
        ]

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByLabelText('Copilot'))

        await waitFor(() => {
            expect(screen.getByTestId('model-options')).toHaveTextContent('Auto,GPT-5.6')
        })
    })

    it('disables creation while a remembered Copilot model is being validated', async () => {
        mocks.copilotModelsLoading = true
        savePreferredAgent('copilot')
        savePreferredLaunchSettings('machine-1', 'copilot', {
            model: 'gpt-5.6',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'default'
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => expect(screen.getByTestId('create')).toBeDisabled())
    })

    it('shows dynamic Kimi models with Default for the selected directory', async () => {
        mocks.kimiModels = [
            { modelId: 'GLM-5.3-flash', name: 'thehive / GLM-5.3-flash', provider: 'thehive' },
            { modelId: 'deepseek-v4.1-flash', name: 'thehive / hive-deepseek', provider: 'thehive' },
            { modelId: 'hyper-glm-5.3-flash', name: 'charm-hyper / Hyper · GLM-5.3-Flash', provider: 'charm-hyper' },
            { modelId: 'openrouter-union-alpha', provider: 'openrouter' }
        ]

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory={'C:\\repo'}
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByDisplayValue('kimi'))

        await waitFor(() => {
            expect(screen.getByTestId('model-options')).toHaveTextContent(
                'Default,thehive — thehive / GLM-5.3-flash,thehive — thehive / hive-deepseek,charm-hyper — charm-hyper / Hyper · GLM-5.3-Flash,openrouter — openrouter-union-alpha'
            )
        })
    })

    it('restores a remembered Kimi alias instead of resetting it to Default', async () => {
        mocks.kimiModels = [
            { modelId: 'GLM-5.3-flash', provider: 'thehive' }
        ]
        savePreferredAgent('kimi')
        savePreferredLaunchSettings('machine-1', 'kimi', {
            model: 'GLM-5.3-flash',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'default'
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory={'C:\\repo'}
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('GLM-5.3-flash')
            expect(screen.getByTestId('create')).toBeEnabled()
        })
    })

    it('resets a remembered Kimi alias that the dynamic catalog no longer lists', async () => {
        mocks.kimiModels = [
            { modelId: 'GLM-5.3-flash', provider: 'thehive' }
        ]
        savePreferredAgent('kimi')
        savePreferredLaunchSettings('machine-1', 'kimi', {
            model: 'retired-alias',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'default'
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory={'C:\\repo'}
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('auto')
        })
        expect(screen.getByTestId('create')).toBeEnabled()
    })

    it.each([
        ['model', 'gpt-5.6-sol', 'default'],
        ['reasoning effort', 'auto', 'xhigh']
    ])('disables creation while a remembered dynamic %s is being validated', async (
        _setting,
        model,
        modelReasoningEffort
    ) => {
        mocks.codexModelsLoading = true
        savePreferredLaunchSettings('machine-1', 'codex', {
            model,
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => expect(screen.getByTestId('create')).toBeDisabled())
    })

    it.each([
        ['grok', {
            model: 'grok-4',
            cursorSelectedBase: 'auto',
            effort: 'high',
            modelReasoningEffort: 'default'
        }],
        ['opencode', {
            model: 'provider/model',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'high'
        }]
    ] as const)('disables creation while %s cwd existence is unresolved', async (
        agent,
        settings
    ) => {
        mocks.directoryExists = undefined
        savePreferredAgent(agent)
        savePreferredLaunchSettings('machine-1', agent, settings)

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => expect(screen.getByTestId('create')).toBeDisabled())
    })

    it('saves changed launch settings only after creation succeeds', async () => {
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'session-1' })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        expect(loadPreferredLaunchSettings('machine-1', 'codex')).toBeNull()
        fireEvent.click(screen.getByTestId('model'))
        fireEvent.click(screen.getByTestId('reasoning'))
        fireEvent.change(screen.getByRole('combobox', { name: 'misc.permissionMode' }), { target: { value: 'yolo' } })
        expect(loadPreferredLaunchSettings('machine-1', 'codex')).toBeNull()
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'yolo' }))
        expect(loadPreferredLaunchSettings('machine-1', 'codex')).toEqual({
            model: 'gpt-5.6-terra',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'max',
            permissionMode: 'yolo'
        })
    })

    it('restores the AGY model from a browse-return draft', async () => {
        savePreferredAgent('agy')
        saveNewSessionFormDraft({
            agent: 'agy', model: 'gemini-3.6-flash-low', cursorSelectedBase: 'auto', machineId: 'machine-1',
            effort: 'auto', modelReasoningEffort: 'default', serviceTier: 'standard', collaborationMode: 'default',
            copilotAgentMode: 'interactive', yoloMode: false, nativePermissionMode: 'default',
            grokPermissionMode: 'default', sessionType: 'simple', worktreeName: ''
        })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('gemini-3.6-flash-low'))
    })

    it('falls back to Default when a browse-return AGY model is no longer advertised', async () => {
        savePreferredAgent('agy')
        saveNewSessionFormDraft({
            agent: 'agy', model: 'removed-model', cursorSelectedBase: 'auto', machineId: 'machine-1',
            effort: 'auto', modelReasoningEffort: 'default', serviceTier: 'standard', collaborationMode: 'default',
            copilotAgentMode: 'interactive', yoloMode: false, nativePermissionMode: 'default',
            grokPermissionMode: 'default', sessionType: 'simple', worktreeName: ''
        })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('auto'))
    })

    it('keeps an AGY model the user picked here when the machine catalog changes under the form', async () => {
        // The machine refreshes its catalog in the background, so the list can
        // change while the form is open. A model the user chose is theirs to
        // keep — unlike a restored one, which the two tests above drop.
        savePreferredAgent('agy')
        const view = render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        fireEvent.click(screen.getByTestId('agy-model'))
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('gemini-3.6-flash-low'))

        mocks.agyModels = [{ modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' }]
        view.rerender(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('gemini-3.6-flash-low'))
    })

    it('falls back to Default when a preferred AGY model is no longer advertised', async () => {
        savePreferredAgent('agy')
        savePreferredLaunchSettings('machine-1', 'agy', { model: 'removed-model', cursorSelectedBase: 'auto', effort: 'auto', modelReasoningEffort: 'default' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('auto'))
    })

    it('blocks Create while a remembered AGY model is awaiting catalog validation', async () => {
        savePreferredAgent('agy')
        savePreferredLaunchSettings('machine-1', 'agy', { model: 'gemini-3.6-flash-low', cursorSelectedBase: 'auto', effort: 'auto', modelReasoningEffort: 'default' })
        mocks.agyModelsLoading = true
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('create')).toBeDisabled())
    })

    it('passes the selected DSH permission mode to the runner', async () => {
        savePreferredAgent('dsh')
        savePreferredYoloMode(true)
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'dsh-session' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('dsh-session'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'dsh',
            yolo: undefined,
            permissionMode: 'default'
        }))
    })

    it('shows DSH managed model and effort status with a visible permission control', async () => {
        savePreferredAgent('dsh')
        savePreferredYoloMode(true)
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'dsh-task' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo"
            initialTask="Inspect this project" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        const model = screen.getByText('newSession.dshManagedModel')
        expect(model.closest('button')).toBeNull()
        expect(screen.queryByRole('button', { name: 'auto · auto' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'misc.permissionMode: Default' })).toHaveTextContent('Default')
        expect(screen.getByRole('button', { name: 'misc.permissionMode: Default' })).not.toHaveTextContent('Yolo')
        await waitFor(() => expect(screen.getByRole('button', { name: 'newTask.createAndSend' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'newTask.createAndSend' }))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('dsh-task'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'dsh', model: undefined, effort: undefined, yolo: undefined, permissionMode: 'default'
        }))
    })

    it('passes the Qoder CN flavor and managed permission mode to the runner', async () => {
        savePreferredAgent('qoder')
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'qoder-session' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('qoder-session'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'qoder',
            model: undefined,
            yolo: undefined,
            permissionMode: 'default'
        }))
    })

    it('explains that Qoder CN model selection happens in the composer', async () => {
        savePreferredAgent('qoder')
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'qoder-task' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo"
            initialTask="Inspect this project" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        const hint = screen.getByText('newSession.qoderManagedModel')
        expect(hint.closest('button')).toBeNull()
        await waitFor(() => expect(screen.getByRole('button', { name: 'newTask.createAndSend' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'newTask.createAndSend' }))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('qoder-task'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'qoder', model: undefined, yolo: undefined, permissionMode: 'default'
        }))
    })

    it('lets Claude create with a chosen permission mode instead of the global YOLO toggle', async () => {
        savePreferredAgent('claude')
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'claude-session' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        fireEvent.change(screen.getByRole('combobox', { name: 'misc.permissionMode' }), { target: { value: 'plan' } })
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('claude-session'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'claude',
            yolo: undefined,
            permissionMode: 'plan'
        }))
    })

    it('does not carry a permission mode picked under another flavor into the Claude spawn payload', async () => {
        savePreferredAgent('codex')
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'claude-session' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        // Starts as codex; picking the mocked native-select button sets the
        // shared nativePermissionMode state to 'yolo', a value 'claude' does
        // not carry in its own permission catalog.
        await waitFor(() => expect(screen.getByDisplayValue('codex')).toBeChecked())
        fireEvent.change(screen.getByRole('combobox', { name: 'misc.permissionMode' }), { target: { value: 'yolo' } })
        fireEvent.click(screen.getByDisplayValue('claude'))
        await waitFor(() => expect(screen.getByDisplayValue('claude')).toBeChecked())
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('claude-session'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'claude',
            permissionMode: 'default'
        }))
    })

    it('migrates a legacy YOLO value owned by Claude to bypassPermissions', async () => {
        savePreferredAgent('claude')
        savePreferredYoloMode(true)

        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        await waitFor(() => {
            expect(screen.getByRole('combobox', { name: 'misc.permissionMode' })).toHaveValue('bypassPermissions')
        })
    })

    it('does not preselect bypassPermissions for Claude from a legacy YOLO value owned by another flavor', async () => {
        // hapi:newSession:yolo is a flavor-agnostic global key. The legacyYoloAgent
        // snapshot (captured once at mount, see index.tsx) is what stops a YOLO
        // toggle left on under cursor from silently preselecting bypassPermissions
        // the next time Claude is picked.
        savePreferredAgent('cursor')
        savePreferredYoloMode(true)

        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        await waitFor(() => expect(screen.getByDisplayValue('cursor')).toBeChecked())
        fireEvent.click(screen.getByDisplayValue('claude'))

        await waitFor(() => {
            expect(screen.getByRole('combobox', { name: 'misc.permissionMode' })).toHaveValue('default')
        })
    })

    it('keeps an explicit OpenCode Default selection instead of restoring a concrete model', async () => {
        savePreferredAgent('opencode')
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'opencode-session' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        // The catalog advertises a concrete default; the user picks Default.
        fireEvent.click(screen.getByTestId('opencode-model-default'))
        await waitFor(() => expect(screen.getByTestId('opencode-model')).toHaveTextContent('default'))
        await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('opencode-session'))
        // Spawn omits model and the explicit Default choice sticks.
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ agent: 'opencode', model: undefined }))
        expect(screen.getByTestId('opencode-model')).toHaveTextContent('default')
    })

    it('uses the probed current model variants for an explicit OpenCode Default selection', async () => {
        savePreferredAgent('opencode')
        mocks.opencodeVariants = { 'provider/current': ['low', 'high'] }
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        fireEvent.click(screen.getByTestId('opencode-model-default'))
        await waitFor(() => expect(screen.getByTestId('opencode-variants')).toHaveTextContent('low,high'))
        expect(mocks.opencodeVariantsEnabled).toBe(true)
    })

    it('waits for OpenCode variants before launching a non-default effort', async () => {
        savePreferredAgent('opencode')
        mocks.opencodeVariantsLoading = true
        const view = render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        fireEvent.click(screen.getByTestId('reasoning'))
        expect(screen.getByTestId('create')).toBeDisabled()

        mocks.opencodeVariantsLoading = false
        mocks.opencodeVariants = { 'provider/current': ['max'] }
        view.rerender(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
    })

    it('does not probe OpenCode variants until the working directory is verified', () => {
        savePreferredAgent('opencode')
        mocks.directoryExists = undefined
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        expect(mocks.opencodeVariantsEnabled).toBe(false)
    })

    it('restores a remembered OpenCode model when it is still advertised', async () => {
        savePreferredAgent('opencode')
        savePreferredLaunchSettings('machine-1', 'opencode', { model: 'provider/model', cursorSelectedBase: 'auto', effort: 'auto', modelReasoningEffort: 'high' })
        mocks.opencodeModels = [{ modelId: 'provider/model', name: 'Model' }]
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('opencode-model')).toHaveTextContent('provider/model'))
    })

    it('persists the selected AGY model only after a successful launch', async () => {
        savePreferredAgent('agy')
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'agy-session' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        fireEvent.click(screen.getByTestId('agy-model'))
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('agy-session'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ agent: 'agy', model: 'gemini-3.6-flash-low' }))
        expect(loadPreferredLaunchSettings('machine-1', 'agy')?.model).toBe('gemini-3.6-flash-low')
    })

    it('does not overwrite AGY model preference after a failed launch', async () => {
        savePreferredAgent('agy')
        savePreferredLaunchSettings('machine-1', 'agy', { model: 'gemini-3.5-flash-low', cursorSelectedBase: 'auto', effort: 'auto', modelReasoningEffort: 'default' })
        mocks.agyModels = [
            { modelId: 'gemini-3.5-flash-low', name: 'Gemini 3.5 Flash (Low)' },
            { modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' }
        ]
        mocks.spawnSession.mockResolvedValue({ type: 'error', message: 'spawn failed' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('gemini-3.5-flash-low'))
        fireEvent.click(screen.getByTestId('agy-model'))
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.notification).toHaveBeenCalledWith('error'))
        expect(loadPreferredLaunchSettings('machine-1', 'agy')?.model).toBe('gemini-3.5-flash-low')
    })

    it('spawns only once when Create is activated twice during directory validation', async () => {
        let finishDirectoryCheck!: (result: { exists: Record<string, boolean> }) => void
        mocks.checkPathsExists.mockReturnValue(new Promise((resolve) => {
            finishDirectoryCheck = resolve
        }))
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'session-1' })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        const create = screen.getByTestId('create')
        fireEvent.click(create)
        fireEvent.click(create)
        finishDirectoryCheck({ exists: { 'C:\\repo': true } })

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.checkPathsExists).toHaveBeenCalledTimes(1)
        expect(mocks.spawnSession).toHaveBeenCalledTimes(1)
    })

    it('imports the selected Pi history and resumes the canonical HAPI session', async () => {
        savePreferredAgent('pi')
        const piApi = {
            getPiSessions: vi.fn().mockResolvedValue({
                success: true,
                machineId: 'machine-1',
                sessions: [{
                    id: 'pi-native-1',
                    title: 'Existing Pi session',
                    cwd: 'C:\\repo',
                    file: 'C:\\pi-native-1.jsonl',
                    modifiedAt: 1,
                    messageCount: 2
                }]
            }),
            importPiSessions: vi.fn().mockResolvedValue({
                success: true,
                machineId: 'machine-1',
                results: [{ piSessionId: 'pi-native-1', hapiSessionId: 'hapi-imported-1', action: 'created', appended: 2 }]
            }),
            reopenSession: vi.fn().mockResolvedValue({ ok: true, sessionId: 'hapi-imported-1', resumed: true })
        } as unknown as ApiClient

        render(
            <NewSession
                api={piApi}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'piImport.inline.choose' }))
        await waitFor(() => expect(screen.getByTestId('select-pi-history')).toBeEnabled())
        fireEvent.click(screen.getByTestId('select-pi-history'))
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('hapi-imported-1'))
        expect(piApi.importPiSessions).toHaveBeenCalledWith({
            sessionIds: ['pi-native-1'],
            cwd: 'C:\\repo',
            machineId: 'machine-1'
        })
        expect(piApi.reopenSession).toHaveBeenCalledWith('hapi-imported-1')
        expect(mocks.spawnSession).not.toHaveBeenCalled()
    })

    it('discards a stale Pi scan after switching machines', async () => {
        savePreferredAgent('pi')
        mocks.piDialogSelection = ['pi-machine-b']
        const machineA = { id: 'machine-a' } as Machine
        const machineB = { id: 'machine-b' } as Machine
        let resolveMachineA!: (value: Awaited<ReturnType<ApiClient['getPiSessions']>>) => void
        let resolveMachineB!: (value: Awaited<ReturnType<ApiClient['getPiSessions']>>) => void
        const machineAScan = new Promise<Awaited<ReturnType<ApiClient['getPiSessions']>>>((resolve) => {
            resolveMachineA = resolve
        })
        const machineBScan = new Promise<Awaited<ReturnType<ApiClient['getPiSessions']>>>((resolve) => {
            resolveMachineB = resolve
        })
        const piApi = {
            getPiSessions: vi.fn((_cwd: string | null, selectedMachineId: string) => (
                selectedMachineId === machineA.id ? machineAScan : machineBScan
            )),
            importPiSessions: vi.fn().mockResolvedValue({
                success: true,
                machineId: machineB.id,
                results: [{ piSessionId: 'pi-machine-b', hapiSessionId: 'hapi-machine-b', action: 'created', appended: 1 }]
            }),
            reopenSession: vi.fn().mockResolvedValue({ ok: true, sessionId: 'hapi-machine-b', resumed: true })
        } as unknown as ApiClient

        render(
            <NewSession
                api={piApi}
                machines={[machineA, machineB]}
                initialMachineId={machineA.id}
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'piImport.inline.choose' }))
        fireEvent.click(screen.getByTestId('close-pi-history'))
        fireEvent.change(screen.getByLabelText('newSession.machine'), { target: { value: machineB.id } })
        fireEvent.click(screen.getByRole('button', { name: 'piImport.inline.choose' }))
        await act(async () => {
            resolveMachineB({
                success: true,
                machineId: machineB.id,
                sessions: [{ id: 'pi-machine-b', title: 'Machine B', cwd: 'C:\\repo', file: 'B.jsonl', modifiedAt: 2, messageCount: 1 }]
            })
            await machineBScan
        })
        await waitFor(() => expect(screen.getByTestId('pi-session-ids')).toHaveTextContent('pi-machine-b'))

        await act(async () => {
            resolveMachineA({
                success: true,
                machineId: machineA.id,
                sessions: [{ id: 'pi-machine-a', title: 'Machine A', cwd: 'C:\\repo', file: 'A.jsonl', modifiedAt: 1, messageCount: 1 }]
            })
            await machineAScan
        })
        expect(screen.getByTestId('pi-session-ids')).toHaveTextContent('pi-machine-b')
        expect(screen.getByTestId('pi-session-ids')).not.toHaveTextContent('pi-machine-a')

        fireEvent.click(screen.getByTestId('select-pi-history'))
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('hapi-machine-b'))
        expect(piApi.importPiSessions).toHaveBeenCalledWith({
            sessionIds: ['pi-machine-b'],
            cwd: 'C:\\repo',
            machineId: machineB.id
        })
    })

    it('refreshes successful Pi imports even when another batch item fails', async () => {
        savePreferredAgent('pi')
        mocks.piDialogSelection = ['pi-native-1', 'pi-native-2']
        const piApi = {
            getPiSessions: vi.fn().mockResolvedValue({
                success: true,
                machineId: 'machine-1',
                sessions: [1, 2].map((index) => ({
                    id: `pi-native-${index}`,
                    title: `Pi ${index}`,
                    cwd: 'C:\\repo',
                    file: `C:\\pi-${index}.jsonl`,
                    modifiedAt: index,
                    messageCount: 1
                }))
            }),
            importPiSessions: vi.fn().mockResolvedValue({
                success: false,
                machineId: 'machine-1',
                results: [
                    { piSessionId: 'pi-native-1', hapiSessionId: 'hapi-1', action: 'created', appended: 1 },
                    { piSessionId: 'pi-native-2', hapiSessionId: 'hapi-2', error: { code: 'session_active', message: 'active' } }
                ]
            })
        } as unknown as ApiClient

        render(
            <NewSession
                api={piApi}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'piImport.inline.choose' }))
        await waitFor(() => expect(screen.getByTestId('select-pi-history')).toBeEnabled())
        fireEvent.click(screen.getByTestId('select-pi-history'))

        await waitFor(() => expect(mocks.refetchSessions).toHaveBeenCalled())
        expect(piApi.getPiSessions).toHaveBeenCalledTimes(2)
        expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({
            title: 'piImport.success.title',
            body: 'piImport.success.body'
        }))
        expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'piImport.failed.title' }))
    })

    it('does not save changed launch settings when creation fails', async () => {
        mocks.spawnSession.mockResolvedValue({ type: 'error', message: 'spawn failed' })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByTestId('model'))
        fireEvent.click(screen.getByTestId('reasoning'))
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.notification).toHaveBeenCalledWith('error'))
        expect(mocks.onSuccess).not.toHaveBeenCalled()
        expect(loadPreferredLaunchSettings('machine-1', 'codex')).toBeNull()
    })

    it('keeps the browse-return draft ahead of the saved launch preference', async () => {
        savePreferredAgent('claude')
        savePreferredLaunchSettings('machine-1', 'codex', {
            model: 'gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'xhigh'
        })
        saveNewSessionFormDraft({
            agent: 'codex',
            model: 'gpt-5.6-terra',
            cursorSelectedBase: 'auto',
            machineId: 'machine-1',
            effort: 'auto',
            modelReasoningEffort: 'max',
            serviceTier: 'standard',
            collaborationMode: 'default',
            copilotAgentMode: 'interactive',
            yoloMode: false,
            nativePermissionMode: 'default',
            grokPermissionMode: 'default',
            sessionType: 'simple',
            worktreeName: ''
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('gpt-5.6-terra')
            expect(screen.getByTestId('reasoning')).toHaveTextContent('max')
        })
    })

    it('resets a restored Pi model that left the machine catalog', async () => {
        savePreferredAgent('pi')
        mocks.piModels = [
            { provider: 'openai-codex', modelId: 'gpt-5.6-sol' },
        ]
        savePreferredLaunchSettings('machine-1', 'pi', {
            model: 'openai-codex/stale-model',
            cursorSelectedBase: 'auto',
            effort: 'high',
            modelReasoningEffort: 'default',
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('auto')
            expect(screen.getByTestId('launch-effort')).toHaveTextContent('auto')
        })
    })

    it('resets a restored effort the Default Pi selection cannot offer', async () => {
        savePreferredAgent('pi')
        mocks.piModels = [
            {
                provider: 'openai-codex',
                modelId: 'gpt-5.6-sol',
                reasoning: true,
                thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
            },
        ]
        // Default model (auto) renders the effort field without a map, which
        // hides xhigh — the restored hidden level must not survive into create.
        savePreferredLaunchSettings('machine-1', 'pi', {
            model: 'auto',
            cursorSelectedBase: 'auto',
            effort: 'xhigh',
            modelReasoningEffort: 'default',
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('launch-effort')).toHaveTextContent('auto')
        })
    })

    it('keeps a restored xhigh effort when the selected model map opts in', async () => {
        savePreferredAgent('pi')
        mocks.piModels = [
            {
                provider: 'openai-codex',
                modelId: 'gpt-5.6-sol',
                reasoning: true,
                thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
            },
        ]
        savePreferredLaunchSettings('machine-1', 'pi', {
            model: 'openai-codex/gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'xhigh',
            modelReasoningEffort: 'default',
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('openai-codex/gpt-5.6-sol')
            expect(screen.getByTestId('launch-effort')).toHaveTextContent('xhigh')
        })
    })

    it('does not submit a hidden restored effort when Pi model discovery fails', async () => {
        savePreferredAgent('pi')
        // A failed catalog never resolves the restored model, so the effort
        // field renders with an undefined map and hides xhigh. Creation is not
        // blocked on error (only on loading), so the hidden level must have
        // been reconciled away rather than forwarded.
        mocks.piModels = []
        mocks.piModelsError = 'probe failed'
        savePreferredLaunchSettings('machine-1', 'pi', {
            model: 'openai-codex/gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'xhigh',
            modelReasoningEffort: 'default',
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('launch-effort')).toHaveTextContent('auto')
        })

        act(() => {
            mocks.spawnSession.mockImplementation(async () => ({ type: 'success', sessionId: 'session-1' }))
        })
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'pi',
            effort: undefined,
        }))
    })

    it('shows Pi machine models and thinking-level effort and forwards both on create', async () => {
        savePreferredAgent('pi')
        mocks.piModels = [
            { provider: 'openai-codex', modelId: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
            { provider: 'opencode-go', modelId: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        ]

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            // Provider-qualified options surfaced through the unified ModelSelector.
            expect(screen.getByTestId('model-options')).toHaveTextContent('GPT-5.6 Sol')
            expect(screen.getByTestId('model-options')).toHaveTextContent('DeepSeek V4 Pro')
        })

        // Select the second provider's model and a thinking level.
        act(() => {
            mocks.spawnSession.mockImplementation(async () => ({ type: 'success', sessionId: 'session-1' }))
        })
        mocks.nextModelValue = 'opencode-go/deepseek-v4-pro'
        fireEvent.click(screen.getByTestId('model'))
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'pi',
            model: 'opencode-go/deepseek-v4-pro',
        }))
    })
})

 it('keeps the task draft and setup hint before a machine is selected', () => {
    mocks.spawnSession.mockClear()
    render(<NewSession api={api} machines={[]} initialTask="keep my draft" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
    expect(screen.getByText('setup.title')).toBeTruthy()
    expect(screen.queryByText('newSession.noAvailableAgents')).toBeNull()
    expect(screen.getByDisplayValue('keep my draft')).toBeTruthy()
    expect(mocks.spawnSession).not.toHaveBeenCalled()
})
