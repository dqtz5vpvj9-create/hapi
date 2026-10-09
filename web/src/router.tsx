import { WorkspaceIcon } from '@/workspace/WorkspaceIcon'
import { getRecentSessionWarmup } from '@/lib/recent-session-warmup'
import { SessionPaneController } from '@/components/SessionPaneController'
import { SessionListHeaderActions } from '@/components/SessionListHeaderActions'
import { loadNewTaskDraft, saveNewTaskDraft, stageNewTaskDraft } from '@/lib/new-task-draft'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Navigate, Outlet, createRootRoute, createRoute, createRouter, lazyRouteComponent, useLocation, useMatchRoute, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { getScrollRestorationKey } from '@/lib/scrollRestorationKey'
import { getSessionListSelectionNavigation, PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { App } from '@/App'
import { SessionWorkspace, type WorkspaceView } from '@/components/SessionWorkspace'
import { isRemoteTerminalSupported } from '@/utils/terminalSupport'

import { SessionList } from '@/components/SessionList'
import { SessionQuickSwitcher } from '@/components/SessionQuickSwitcher'
import { NewSession } from '@/components/NewSession'
import { WorkspaceBrowser } from '@/components/WorkspaceBrowser'
import { LoadingState } from '@/components/LoadingState'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { isTelegramApp } from '@/hooks/useTelegram'
import { useSidebarResize } from '@/hooks/useSidebarResize'

import { useMachines } from '@/hooks/queries/useMachines'
import { useMachineLabels } from '@/hooks/useMachineLabels'
import { useSession } from '@/hooks/queries/useSession'

import { useSessions } from '@/hooks/queries/useSessions'

import { queryKeys } from '@/lib/query-keys'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'

import { initializeSessionLastSeen } from '@/lib/sessionLastSeen'
import { useSelectedSessionSeen } from '@/hooks/useSelectedSessionSeen'
import { useSessionBrowserTitle } from '@/hooks/useSessionBrowserTitle'

import { getSupersedingSessionId, prepareFollowSupersedingSession, shouldFollowSupersedingSession } from '@/routes/sessions/followSupersedingSession'

import FilesPage from '@/routes/sessions/files'
import FilePage from '@/routes/sessions/file'
import TerminalPage from '@/routes/sessions/terminal'
import SettingsLayout from '@/routes/settings/layout'
import SettingsHubPage from '@/routes/settings'
import SettingsGeneralPage from '@/routes/settings/general'
import SettingsDisplayPage from '@/routes/settings/display'
import SettingsChatPage from '@/routes/settings/chat'
import SettingsVoicePage from '@/routes/settings/voice'
import SettingsVoiceVoicesPage from '@/routes/settings/voice-voices'
import SettingsVoiceAdvancedPage from '@/routes/settings/voice-advanced'
import SettingsMachinesPage from '@/routes/settings/machines'
import SettingsAboutPage from '@/routes/settings/about'
import SettingsStoragePage from '@/routes/settings/storage'
import SettingsUsagePage from '@/routes/settings/usage'
import SharePage from '@/routes/share'
import { setSharePendingTransfer } from '@/lib/sharePendingState'
import { deleteShareTransfer, parseShareSearch } from '@/lib/shareTransfer'

function BackIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function PlusIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

function FolderOpenIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
    )
}

function SettingsIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    )
}

function SessionsPage() {
    const [quickSwitchOpen, setQuickSwitchOpen] = useState(false)
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey || event.shiftKey) return
            if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return
            if (document.querySelector('[role="dialog"]')) return
            event.preventDefault()
            setQuickSwitchOpen(true)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [])
    const { api, baseUrl, workspace, titleSuggestionAvailable = false } = useAppContext()
    const navigate = useNavigate()
    const pathname = useLocation({ select: location => location.pathname })
    const matchRoute = useMatchRoute()
    const { t } = useTranslation()
    const { addToast } = useToast()
    const { sessions, isLoading, error, refetch } = useSessions(api)
    const [initializedHub, setInitializedHub] = useState<string | null>(null)
    const { machines } = useMachines(api, true)
    const handleRefresh = useCallback(() => {
        return (async () => {
            try {
                await refetch()
            } catch (error) {
                addToast({
                    title: t('sessions.refresh.failed.title'),
                    body: error instanceof Error ? error.message : t('dialog.error.default'),
                    sessionId: '',
                    url: ''
                })
            }
        })()
    }, [addToast, refetch, t])

    const machineLabelsById = useMachineLabels(machines)
    const machinesById = useMemo(() => {
        const byId: Record<string, typeof machines[number]> = {}
        for (const machine of machines) {
            byId[machine.id] = machine
        }
        return byId
    }, [machines])
    // Workspace browsing is opt-in per runner (`--workspace-root`); only show
    // browse affordances when at least one machine reported roots.
    const canBrowse = useMemo(
        () => machines.some(m => (m.metadata?.workspaceRoots?.length ?? 0) > 0),
        [machines]
    )
    const sessionMatch = matchRoute({ to: '/sessions/$sessionId', fuzzy: true })
    const workspaceState = useSyncExternalStore(workspace?.subscribe ?? (() => () => {}), workspace?.get ?? (() => null))
    const listView = useLocation({ select: location => location.search.view === 'list' })
    const isSessionsIndex = pathname === '/sessions' || pathname === '/sessions/'
    const selectingWorkspace = isSessionsIndex && listView && workspaceState?.mode === 'workspace'
    const focusedResource = workspace?.focusedPane()?.resource
    const selectedSessionId = pathname === '/sessions/workspace' || selectingWorkspace
        ? focusedResource?.kind === 'chat' ? focusedResource.sessionId : null
        : sessionMatch && sessionMatch.sessionId !== 'new' ? sessionMatch.sessionId : null
    const selectedSession = useMemo(
        () => selectedSessionId ? sessions.find((session) => session.id === selectedSessionId) ?? null : null,
        [selectedSessionId, sessions]
    )
    useEffect(() => {
        if (isLoading || error) {
            return
        }
        initializeSessionLastSeen(baseUrl, sessions)
        setInitializedHub(baseUrl)
    }, [baseUrl, error, isLoading, sessions])
    useSelectedSessionSeen(selectedSessionId, selectedSession?.updatedAt)
    const isWorkspace = pathname === '/sessions/workspace'
    const selectSession = (id: string) => {
        if ((isWorkspace || selectingWorkspace) && workspace) {
            if (workspace.openSession(id)) getRecentSessionWarmup(api).switchTo(id)
            if (selectingWorkspace) navigate({ to: '/sessions/workspace', ...PRESERVE_SESSION_SIDEBAR_SCROLL })
        } else navigate(getSessionListSelectionNavigation(id))
    }
    const openSessionInPane = (id: string, axis: 'horizontal' | 'vertical') => {
        if (!workspace) return
        if (!isWorkspace && !selectingWorkspace) workspace.enter(selectedSessionId)
        if (workspace.openSession(id, axis)) getRecentSessionWarmup(api).switchTo(id)
        if (!isWorkspace) navigate({ to: '/sessions/workspace', ...PRESERVE_SESSION_SIDEBAR_SCROLL })
    }
    const modeControl = <button type="button" className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]" aria-label={t(selectingWorkspace ? 'workspace.return' : 'workspace.mode')} title={t(selectingWorkspace ? 'workspace.return' : isWorkspace ? 'workspace.single' : 'workspace.modeWorkspace')} aria-pressed={isWorkspace || selectingWorkspace}
        onClick={() => {
            if (!workspace) return
            if (selectingWorkspace) navigate({ to: '/sessions/workspace', ...PRESERVE_SESSION_SIDEBAR_SCROLL })
            else if (isWorkspace) { const id = workspace.leave(); navigate(id ? getSessionListSelectionNavigation(id) : { to: '/sessions' }) }
            else { workspace.enter(selectedSessionId); navigate({ to: '/sessions/workspace', ...PRESERVE_SESSION_SIDEBAR_SCROLL }) }
        }}><WorkspaceIcon /></button>
    const sidebar = useSidebarResize(isWorkspace)
    const handleNewSessionInDirectory = useCallback((args: { machineId: string | null; directory: string }) => {
        navigate({
            to: '/sessions/new',
            search: args.machineId
                ? { directory: args.directory, machineId: args.machineId }
                : { directory: args.directory },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate])

    return (
        <>
            <SessionQuickSwitcher
                open={quickSwitchOpen}
                onOpenChange={setQuickSwitchOpen}
                sessions={sessions}
                machineLabelsById={machineLabelsById}
                onSelect={selectSession}
            />
            <div className="app-session-layout flex h-full min-h-0" data-workspace-layout={isWorkspace || undefined}>
            <div
                className={`app-session-sidebar-frame ${isSessionsIndex ? 'flex' : 'hidden split:flex'} w-full shrink-0 flex-col bg-[var(--app-bg)]`}
                style={{ '--sidebar-w': `${sidebar.width}px` } as React.CSSProperties}
            >
                <div className="app-session-sidebar flex min-h-0 flex-1 flex-col pt-[env(safe-area-inset-top)]">
                    {error ? (
                        <div className="mx-auto w-full max-w-content px-3 py-2">
                            <div className="text-sm text-red-600">{error}</div>
                        </div>
                    ) : null}
                    <SessionList
                        key={initializedHub === baseUrl ? 'last-seen-ready' : 'last-seen-pending'}
                        sessions={sessions}
                        selectedSessionId={selectedSessionId}
                        onSelect={selectSession}
                        onOpenPane={workspace ? openSessionInPane : undefined}
                        onNewSession={() => navigate({
                            to: '/sessions/new',
                            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
                        })}
                        hub={baseUrl}
                        onStartTask={machineId => navigate({ to: '/sessions/new', search: machineId ? { machineId } : {}, ...PRESERVE_SESSION_SIDEBAR_SCROLL })}
                        onNewSessionInDirectory={handleNewSessionInDirectory}
                        onBrowse={canBrowse ? () => navigate({ to: '/browse' }) : undefined}
                        onRefresh={handleRefresh}
                        isLoading={isLoading}
                        renderHeader={false}
                        headerActions={<SessionListHeaderActions
                            compact={isWorkspace}
                            viewModeControl={isWorkspace ? undefined : modeControl}
                            onSwitch={() => setQuickSwitchOpen(true)}
                            onBrowse={canBrowse ? () => navigate({ to: '/browse' }) : undefined}
                            onSettings={() => navigate({ to: '/settings' })}
                            onNew={() => navigate({ to: '/sessions/new', ...PRESERVE_SESSION_SIDEBAR_SCROLL })}
                        />}
                        api={api}
                        titleSuggestionAvailable={titleSuggestionAvailable}
                        machineLabelsById={machineLabelsById}
                        machinesById={machinesById}
                    />
                </div>
            </div>

            {/* Resize handle - desktop only */}
            <div
                className="sidebar-resize-handle hidden split:block shrink-0"
                data-dragging={sidebar.isDragging || undefined}
                onPointerDown={sidebar.onPointerDown}
            />

            <div className={`${isSessionsIndex ? 'hidden split:flex' : 'flex'} min-w-0 flex-1 flex-col bg-[var(--app-bg)]`}>
                <div className="flex-1 min-h-0">
                    <Outlet />
                </div>
            </div>
            </div>
        </>
    )
}

function SessionsIndexPage() {
    const { workspace } = useAppContext()
    const { view } = useSearch({ from: '/sessions/' })
    return view !== 'list' && workspace?.get().mode === 'workspace' ? <Navigate to="/sessions/workspace" replace /> : null
}

function SessionPage() {
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    const { outline } = useSearch({ from: '/sessions/$sessionId' })
    const navigate = useNavigate()
    const goBack = useCallback(() => { navigate({ to: '/sessions', ...PRESERVE_SESSION_SIDEBAR_SCROLL }) }, [navigate])
    return <SessionPaneController sessionId={sessionId} outline={outline} onBack={goBack} />
}

function SessionDetailRoute() {
    const { api } = useAppContext()
    const pathname = useLocation({ select: location => location.pathname })
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    const navigate = useNavigate()
    const { session, notFound: sessionNotFound } = useSession(api, sessionId)
    useSessionBrowserTitle(session)
    const basePath = `/sessions/${sessionId}`
    const isChat = pathname === basePath || pathname === `${basePath}/`
    const workspaceSearch = useSearch({ strict: false })
    const view: WorkspaceView = pathname.endsWith('/terminal') ? 'terminal'
        : pathname.endsWith('/file') ? 'file'
        : workspaceSearch.tab === 'directories' ? 'directories' : 'changes'
    const supersedingSessionId = getSupersedingSessionId(sessionId, session?.metadata)
    const observedSessionRef = useRef<{
        sessionId: string
        supersedingSessionId: string | null
    } | null>(null)
    const currentSessionRef = useRef<string | null>(sessionId)
    currentSessionRef.current = sessionId
    useEffect(() => () => { currentSessionRef.current = null }, [])

    useEffect(() => {
        if (!session) {
            return
        }
        const shouldFollow = shouldFollowSupersedingSession(
            observedSessionRef.current,
            sessionId,
            session.metadata
        )
        observedSessionRef.current = { sessionId, supersedingSessionId }
        if (!shouldFollow || !supersedingSessionId) return
        void prepareFollowSupersedingSession(sessionId, supersedingSessionId).then(() => {
            if (currentSessionRef.current !== sessionId) return
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: supersedingSessionId },
                replace: true,
                ...PRESERVE_SESSION_SIDEBAR_SCROLL,
            })
        })
    }, [navigate, session, sessionId, supersedingSessionId])

    useEffect(() => {
        if (!sessionNotFound) {
            return
        }
        navigate({
            to: '/sessions',
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, sessionNotFound, sessionId])

    if (sessionNotFound) {
        return (
            <div className="flex-1 flex items-center justify-center p-4">
                <LoadingState label="Session not found. Returning to sessions…" className="text-sm" />
            </div>
        )
    }

    return <SessionWorkspace
        key={sessionId}
        open={!isChat}
        view={view}
        path={session?.metadata?.path}
        terminalAvailable={!!session?.active && isRemoteTerminalSupported(session.metadata)}
        filesAvailable={!!session?.metadata?.path}
        onSelect={(next) => {
            if (next === 'terminal') {
                navigate({ to: '/sessions/$sessionId/terminal', params: { sessionId }, ...PRESERVE_SESSION_SIDEBAR_SCROLL })
            } else {
                navigate({ to: '/sessions/$sessionId/files', params: { sessionId }, search: { tab: next }, ...PRESERVE_SESSION_SIDEBAR_SCROLL })
            }
        }}
        onClose={() => navigate({ to: '/sessions/$sessionId', params: { sessionId }, ...PRESERVE_SESSION_SIDEBAR_SCROLL })}
        chat={<SessionPage />}
        panel={<Outlet />}
    />
}

function NewSessionPage() {
    const { api, baseUrl } = useAppContext()
    const navigate = useNavigate()
    const goBack = useAppGoBack()
    const queryClient = useQueryClient()
    const { machines, isLoading: machinesLoading, error: machinesError } = useMachines(api, true)
    const { t } = useTranslation()
    const [initialTask, setInitialTask] = useState(() => loadNewTaskDraft(baseUrl))
    const updateInitialTask = (text: string) => { setInitialTask(text); saveNewTaskDraft(baseUrl, text) }
    const handleCreated = (sessionId: string) => stageNewTaskDraft(baseUrl, sessionId, initialTask)
    const { directory: initialDirectory, machineId: initialMachineId, shareTransferId } = newSessionRoute.useSearch()

    const handleCancel = useCallback(() => {
        if (shareTransferId) {
            void deleteShareTransfer(shareTransferId)
        }
        navigate({
            to: '/sessions',
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, shareTransferId])

    const handleSuccess = useCallback((sessionId: string) => {
        if (shareTransferId) {
            setSharePendingTransfer(shareTransferId, sessionId)
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        // Replace current page with /sessions to clear spawn flow from history
        navigate({
            to: '/sessions',
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
        // Then navigate to new session
        requestAnimationFrame(() => {
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId },
                ...PRESERVE_SESSION_SIDEBAR_SCROLL,
            })
        })
    }, [navigate, queryClient, shareTransferId])

    const handleChooseFolder = useCallback((args: { machineId: string | null; directory: string }) => {
        // Forward the currently-selected machine so /browse opens scoped to
        // it rather than falling back to `hapi:lastMachineId`, which can
        // disagree if the user changed machines without yet creating a
        // session. Preserve shareTransferId so a share-target spawn that
        // detours through /browse still seeds the composer after success.
        const search: { machineId?: string; shareTransferId?: string } = {}
        if (args.machineId) search.machineId = args.machineId
        if (shareTransferId) search.shareTransferId = shareTransferId
        navigate({ to: '/browse', search })
    }, [navigate, shareTransferId])

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] p-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
                {!isTelegramApp() && (
                    <button
                        type="button"
                        onClick={goBack}
                        aria-label={t('common.back')}
                        className="app-page-back flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                )}
                <div className="flex-1 font-semibold">{t('newSession.title')}</div>
            </div>

            <div
                className="app-scroll-y flex-1 min-h-0"
                style={{ paddingBottom: 'calc(var(--app-floating-bottom-offset, 0px) + env(safe-area-inset-bottom))' }}
            >
                {machinesError ? (
                    <div className="p-3 text-sm text-red-600">
                        {machinesError}
                    </div>
                ) : null}

                <NewSession
                    api={api}
                    machines={machines}
                    isLoading={machinesLoading}
                    onCancel={handleCancel}
                    onSuccess={handleSuccess}
                    onChooseFolder={handleChooseFolder}
                    initialTask={initialTask}
                    onInitialTaskChange={updateInitialTask}
                    onCreated={handleCreated}
                    initialDirectory={initialDirectory}
                    initialMachineId={initialMachineId}
                />
            </div>
        </div>
    )
}

function BrowsePage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const goBack = useAppGoBack()
    const { machines, isLoading: machinesLoading } = useMachines(api, true)
    const { t } = useTranslation()
    const { machineId: initialMachineId, shareTransferId } = browseRoute.useSearch()

    const handleStartSession = useCallback((machineId: string, directory: string) => {
        navigate({
            to: '/sessions/new',
            search: shareTransferId
                ? { directory, machineId, shareTransferId }
                : { directory, machineId }
        })
    }, [navigate, shareTransferId])

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] p-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
                {!isTelegramApp() && (
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                )}
                <div className="flex-1 font-semibold">{t('browse.title')}</div>
            </div>

            <div className="flex-1 min-h-0">
                <WorkspaceBrowser
                    api={api}
                    machines={machines}
                    machinesLoading={machinesLoading}
                    onStartSession={handleStartSession}
                    initialMachineId={initialMachineId}
                />
            </div>
        </div>
    )
}

const rootRoute = createRootRoute({
    component: App,
})

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <Navigate to="/sessions" replace />,
})

const sessionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions',
    component: SessionsPage,
})

const workspaceRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: 'workspace',
    component: lazyRouteComponent(() => import('@/workspace/WorkspaceShell'), 'WorkspaceShell'),
})

const sessionsIndexRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: '/',
    validateSearch: (search: Record<string, unknown>): { view?: 'list' } => search.view === 'list' ? { view: 'list' } : {},
    component: SessionsIndexPage,
})

const sessionDetailRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: '$sessionId',
    validateSearch: (search: Record<string, unknown>): { outline?: boolean } => {
        const outline = search.outline === true || search.outline === 'true'
        return outline ? { outline: true } : {}
    },
    component: SessionDetailRoute,
})

const sessionFilesRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'files',
    validateSearch: (search: Record<string, unknown>): { tab?: 'changes' | 'directories'; query?: string } => {
        const tabValue = typeof search.tab === 'string' ? search.tab : undefined
        const tab = tabValue === 'directories'
            ? 'directories'
            : tabValue === 'changes'
                ? 'changes'
                : undefined
        const query = typeof search.query === 'string' && search.query.length > 0
            ? search.query
            : undefined

        return {
            ...(tab ? { tab } : {}),
            ...(query ? { query } : {}),
        }
    },
    component: FilesPage,
})

const sessionTerminalRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'terminal',
    component: TerminalPage,
})

type SessionFileSearch = {
    document?: string
    path: string
    staged?: boolean
    tab?: 'changes' | 'directories'
    query?: string
    origin?: 'chat'
}

const sessionFileRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'file',
    validateSearch: (search: Record<string, unknown>): SessionFileSearch => {
        const path = typeof search.path === 'string' ? search.path : ''
        const staged = search.staged === true || search.staged === 'true'
            ? true
            : search.staged === false || search.staged === 'false'
                ? false
                : undefined

        const tabValue = typeof search.tab === 'string' ? search.tab : undefined
        const tab = tabValue === 'directories'
            ? 'directories'
            : tabValue === 'changes'
                ? 'changes'
                : undefined
        const query = typeof search.query === 'string' && search.query.length > 0
            ? search.query
            : undefined
        const origin = search.origin === 'chat' ? 'chat' : undefined

        const result: SessionFileSearch = { path }
        if (typeof search.document === 'string') result.document = search.document
        if (staged !== undefined) {
            result.staged = staged
        }
        if (tab !== undefined) {
            result.tab = tab
        }
        if (query !== undefined) {
            result.query = query
        }
        if (origin !== undefined) {
            result.origin = origin
        }
        return result
    },
    component: FilePage,
})

type NewSessionSearch = {
    directory?: string
    machineId?: string
    shareTransferId?: string
}

const newSessionRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: 'new',
    validateSearch: (search: Record<string, unknown>): NewSessionSearch => {
        const result: NewSessionSearch = {}
        if (typeof search.directory === 'string' && search.directory) {
            result.directory = search.directory
        }
        if (typeof search.machineId === 'string' && search.machineId) {
            result.machineId = search.machineId
        }
        if (typeof search.shareTransferId === 'string' && search.shareTransferId) {
            result.shareTransferId = search.shareTransferId
        }
        return result
    },
    component: NewSessionPage,
})

const browseRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/browse',
    validateSearch: (search: Record<string, unknown>): { machineId?: string; shareTransferId?: string } => {
        const result: { machineId?: string; shareTransferId?: string } = {}
        if (typeof search.machineId === 'string' && search.machineId) {
            result.machineId = search.machineId
        }
        if (typeof search.shareTransferId === 'string' && search.shareTransferId) {
            result.shareTransferId = search.shareTransferId
        }
        return result
    },
    component: BrowsePage,
})

const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: SettingsLayout,
})

const settingsIndexRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: '/',
    component: SettingsHubPage,
})

const settingsGeneralRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'general',
    component: SettingsGeneralPage,
})

const settingsDisplayRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'display',
    component: SettingsDisplayPage,
})

const settingsChatRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'chat',
    component: SettingsChatPage,
})

const settingsVoiceRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'voice',
    component: SettingsVoicePage,
})

const settingsVoiceVoicesRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'voice/voices',
    component: SettingsVoiceVoicesPage,
})

const settingsVoiceAdvancedRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'voice/advanced',
    component: SettingsVoiceAdvancedPage,
})

const settingsMachinesRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'machines',
    component: SettingsMachinesPage,
})

const settingsAboutRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'about',
    component: SettingsAboutPage,
})

const settingsStorageRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'storage',
    component: SettingsStoragePage,
})

const settingsUsageRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'usage',
    component: SettingsUsagePage,
})

// Web Share Target landing route. Service worker (`web/src/sw.ts`)
// intercepts the manifest's `POST /share` and 303-redirects here with an
// IDB transfer id. `error=ingest` is set when the SW failed to write IDB.
// Native / deep-link clients open `/share#url=&text=&title=` (fragment, not
// query) so shared content is never part of the HTTP request line.
const shareRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/share',
    validateSearch: (search: Record<string, unknown>) => parseShareSearch(search),
    component: SharePage,
})

export const routeTree = rootRoute.addChildren([
    indexRoute,
    sessionsRoute.addChildren([
            workspaceRoute,
        sessionsIndexRoute,
        newSessionRoute,
        sessionDetailRoute.addChildren([
            sessionTerminalRoute,
            sessionFilesRoute,
            sessionFileRoute,
        ]),
    ]),
    browseRoute,
    settingsRoute.addChildren([
        settingsIndexRoute,
        settingsGeneralRoute,
        settingsDisplayRoute,
        settingsChatRoute,
        settingsVoiceRoute,
        settingsVoiceVoicesRoute,
        settingsVoiceAdvancedRoute,
        settingsMachinesRoute,
        settingsStorageRoute,
        settingsUsageRoute,
        settingsAboutRoute,
    ]),
    shareRoute,
])

type RouterHistory = Parameters<typeof createRouter>[0]['history']

export function createAppRouter(history?: RouterHistory) {
    return createRouter({
        routeTree,
        history,
        scrollRestoration: true,
        getScrollRestorationKey,
    })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
    interface Register {
        router: AppRouter
    }
}
