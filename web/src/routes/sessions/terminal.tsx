import { useWorkspacePanel } from '@/components/SessionWorkspace'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useParams } from '@tanstack/react-router'
import type { Terminal } from '@xterm/xterm'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useSession } from '@/hooks/queries/useSession'
import { useTerminalSocket } from '@/hooks/useTerminalSocket'
import { QuickKeyRows, type QuickInput } from '@/components/QuickKeys/QuickKeys'
import { useLongPress } from '@/hooks/useLongPress'
import { useTranslation } from '@/lib/use-translation'
import { randomId } from '@/lib/randomId'
import { TerminalView } from '@/components/Terminal/TerminalView'
import { applyTerminalModifiers, useTerminalKeys, type TerminalModifier } from '@/components/Terminal/useTerminalKeys'
import { TouchBar } from '@/components/Terminal/termbeam/TouchBar'
import { SelectOverlay } from '@/components/Terminal/termbeam/SelectOverlay'
import { KeyEditor } from '@/components/Terminal/termbeam/KeyEditor'
import { useTouchBarKeys } from '@/components/Terminal/termbeam/useTouchBarKeys'
import { LoadingState } from '@/components/LoadingState'
import { Button } from '@/components/ui/button'
import { isRemoteTerminalSupported } from '@/utils/terminalSupport'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
function BackIcon() {
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
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function SendIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
        </svg>
    )
}

function RetryIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M20 6v6h-6" />
            <path d="M20 12a8 8 0 1 0-2.34 5.66" />
        </svg>
    )
}

function ConnectionIndicator(props: { status: 'idle' | 'connecting' | 'connected' | 'error' }) {
    const isConnected = props.status === 'connected'
    const isConnecting = props.status === 'connecting'
    const label = isConnected ? 'Connected' : isConnecting ? 'Connecting' : 'Offline'
    const colorClass = isConnected
        ? 'bg-emerald-500'
        : isConnecting
          ? 'bg-amber-400 animate-pulse'
          : 'bg-[var(--app-hint)]'

    return (
        <div className="flex items-center" aria-label={label} title={label} role="status">
            <span className={`h-2.5 w-2.5 rounded-full ${colorClass}`} />
        </div>
    )
}

type TerminalInputMode = 'command' | 'direct'
type DirectKeyPage = 'control' | 'navigation' | 'shell' | 'symbols'

const COMPACT_TERMINAL_QUERY = '(max-width: 640px), (pointer: coarse)'

function useCompactTerminalControls(): boolean {
    const [compact, setCompact] = useState(
        () => typeof window !== 'undefined' && window.matchMedia(COMPACT_TERMINAL_QUERY).matches
    )

    useEffect(() => {
        const media = window.matchMedia(COMPACT_TERMINAL_QUERY)
        const update = () => setCompact(media.matches)
        update()
        media.addEventListener('change', update)
        return () => media.removeEventListener('change', update)
    }, [])

    return compact
}

export function buildTerminalCommandSequence(command: string): string {
    const normalized = command.replace(/\r\n|\n/g, '\r')
    return normalized.endsWith('\r') ? normalized : `${normalized}\r`
}

const EXIT_NAVIGATION_DELAY_MS = 700

const DIRECT_KEY_PAGE_IDS: DirectKeyPage[] = ['control', 'navigation', 'shell', 'symbols']

const COMPACT_DIRECT_INPUTS: Record<DirectKeyPage, QuickInput[]> = {
    control: [
        { label: 'Esc', sequence: '\u001b', description: 'Escape' },
        { label: 'Tab', sequence: '\t', description: 'Tab' },
        { label: '⇧Tab', sequence: '\u001b[Z', description: 'Shift Tab' },
        { label: 'Ctrl', description: 'Control', modifier: 'ctrl' },
        { label: 'Alt', description: 'Alternate', modifier: 'alt' },
        { label: 'Space', sequence: ' ', description: 'Space' },
        { label: 'Enter', sequence: '\r', description: 'Enter' },
        { label: 'Ctrl+C', sequence: '\u0003', description: 'Interrupt process' },
        { label: 'Ctrl+D', sequence: '\u0004', description: 'End of input' },
        { label: 'Ctrl+Z', sequence: '\u001a', description: 'Suspend process' },
        { label: 'Ctrl+L', sequence: '\u000c', description: 'Clear screen' },
        // Dedicated: sticky Ctrl + softkey is flaky on mobile IME (Jed save = C-x C-s).
        { label: 'Ctrl+X', sequence: '\u0018', description: 'Cancel / prefix (C-x)' },
        { label: 'Ctrl+S', sequence: '\u0013', description: 'XOFF / search / save (C-s)' },
    ],
    navigation: [
        { label: '←', sequence: '\u001b[D', description: 'Arrow left' },
        { label: '↑', sequence: '\u001b[A', description: 'Arrow up' },
        { label: '↓', sequence: '\u001b[B', description: 'Arrow down' },
        { label: '→', sequence: '\u001b[C', description: 'Arrow right' },
        { label: 'Home', sequence: '\u001b[H', description: 'Home' },
        { label: 'End', sequence: '\u001b[F', description: 'End' },
        { label: 'PgUp', sequence: '\u001b[5~', description: 'Page up' },
        { label: 'PgDn', sequence: '\u001b[6~', description: 'Page down' },
        { label: '⌫', sequence: '\u007f', description: 'Backspace' },
        { label: 'Del', sequence: '\u001b[3~', description: 'Delete' },
        { label: 'Ctrl+A', sequence: '\u0001', description: 'Line start' },
        { label: 'Ctrl+E', sequence: '\u0005', description: 'Line end' },
    ],
    shell: [
        { label: '/', sequence: '/', description: 'Forward slash' },
        { label: '-', sequence: '-', description: 'Hyphen' },
        { label: '|', sequence: '|', description: 'Pipe' },
        { label: '~', sequence: '~', description: 'Tilde' },
        { label: '$', sequence: '$', description: 'Dollar sign' },
        { label: '.', sequence: '.', description: 'Period' },
        { label: '..', sequence: '..', description: 'Parent directory' },
        { label: '\\', sequence: '\\', description: 'Backslash' },
        { label: '&', sequence: '&', description: 'Ampersand' },
        { label: ';', sequence: ';', description: 'Semicolon' },
        { label: '>', sequence: '>', description: 'Redirect output' },
        { label: '>>', sequence: '>>', description: 'Append output' },
    ],
    symbols: [
        { label: '_', sequence: '_', description: 'Underscore' },
        { label: '"', sequence: '"', description: 'Double quote' },
        { label: "'", sequence: "'", description: 'Single quote' },
        { label: '`', sequence: '`', description: 'Backtick' },
        { label: '(', sequence: '(', description: 'Left parenthesis' },
        { label: ')', sequence: ')', description: 'Right parenthesis' },
        { label: '[', sequence: '[', description: 'Left bracket' },
        { label: ']', sequence: ']', description: 'Right bracket' },
        { label: '{', sequence: '{', description: 'Left brace' },
        { label: '}', sequence: '}', description: 'Right brace' },
        { label: '=', sequence: '=', description: 'Equals' },
        { label: ':', sequence: ':', description: 'Colon' },
    ],
}

const BASIC_COMMANDS = [
    { label: 'ls', command: 'ls' },
    { label: 'ls -la', command: 'ls -la' },
    { label: 'pwd', command: 'pwd' },
    { label: 'cd', command: 'cd ' },
    { label: 'git status', command: 'git status' },
    { label: 'git diff', command: 'git diff' },
    { label: 'clear', command: 'clear' },
    { label: 'top', command: 'top' },
]

type TerminalQuickInput = Omit<QuickInput, 'modifier'> & { modifier?: TerminalModifier }

function QuickKeyButton(props: {
    input: TerminalQuickInput
    disabled: boolean
    isActive: boolean
    onPress: (sequence: string) => void
    onToggleModifier: (modifier: TerminalModifier) => void
    compact?: boolean
}) {
    const { input, disabled, isActive, onPress, onToggleModifier, compact = false } = props
    const modifier = input.modifier
    const popupSequence = input.popup?.sequence
    const popupDescription = input.popup?.description
    const hasPopup = Boolean(popupSequence)
    const handleClick = useCallback(() => {
        if (modifier) {
            onToggleModifier(modifier)
            return
        }
        onPress(input.sequence ?? '')
    }, [modifier, onToggleModifier, onPress, input.sequence])

    const longPressHandlers = useLongPress({
        onLongPress: () => {
            if (popupSequence && !modifier) {
                onPress(popupSequence)
            }
        },
        onClick: handleClick,
        disabled,
        interaction: 'touch-only-native-click',
        longPressEnabled: !modifier && hasPopup,
    })

    return (
        <button
            type="button"
            {...longPressHandlers}
            onPointerDown={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
            disabled={disabled}
            aria-pressed={modifier ? isActive : undefined}
            className={`${compact ? 'h-11 min-w-0 w-full rounded-lg bg-[var(--app-secondary-bg)]' : 'flex-1 border-l border-[var(--app-border)] first:border-l-0'} px-2 py-1.5 text-xs font-medium text-[var(--app-fg)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent active:bg-[var(--app-subtle-bg)] sm:px-3 sm:text-sm ${
                isActive ? 'bg-[var(--app-link)] text-[var(--app-bg)]' : 'hover:bg-[var(--app-subtle-bg)]'
            }`}
            aria-label={input.description}
            title={popupDescription ? `${input.description} (long press: ${popupDescription})` : input.description}
        >
            {input.label}
        </button>
    )
}

export default function TerminalPage() {
    const { sessionId } = useParams({ from: '/sessions/$sessionId/terminal' })
    const goBack = useAppGoBack()
    return <SessionTerminal sessionId={sessionId} onBack={goBack} />
}

export function SessionTerminal(props: { sessionId: string; terminalId?: string; onBack: () => void }) {
    const workspacePanel = useWorkspacePanel()
    const { t } = useTranslation()
    const compactControls = useCompactTerminalControls()
    const { sessionId } = props
    const { api, token, baseUrl } = useAppContext()
    const goBack = props.onBack
    const { session } = useSession(api, sessionId)
    const terminalSupported = isRemoteTerminalSupported(session?.metadata)
    // Ordinary routes own a fresh terminal; workspace panes supply a stable ID
    // for reattachment. The Hub rejects a second attached controller of that
    // ID and permits reattachment after the first viewer detaches. Scrollback
    // is keyed by both sessionId and terminalId in userTerminalBuffer.
    const terminalIdRef = useRef<{ sessionId: string; id: string } | null>(null)
    if (terminalIdRef.current?.sessionId !== sessionId) {
        terminalIdRef.current = { sessionId, id: `term-${sessionId}-${randomId()}` }
    }
    const terminalId = props.terminalId ?? terminalIdRef.current.id
    const terminalRef = useRef<Terminal | null>(null)
    const commandInputRef = useRef<HTMLTextAreaElement | null>(null)
    const inputDisposableRef = useRef<{ dispose: () => void } | null>(null)
    const connectOnceRef = useRef(false)
    const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
    const exitNavTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [exitInfo, setExitInfo] = useState<{
        code: number | null
        signal: string | null
    } | null>(null)
    const [inputMode, setInputMode] = useState<TerminalInputMode>('direct')
    const [directKeyPage, setDirectKeyPage] = useState<DirectKeyPage>('control')
    const [snippetsOpen, setSnippetsOpen] = useState(false)
    const [copyOpen, setCopyOpen] = useState(false)
    const [keyEditorOpen, setKeyEditorOpen] = useState(false)
    const { keys: touchBarKeys, updateKeys, settings: toolbarSettings, updateSettings, saveError } = useTouchBarKeys()
    const [moreKeysOpen, setMoreKeysOpen] = useState(false)
    const [commandDraft, setCommandDraft] = useState('')
    const [pasteDialogOpen, setPasteDialogOpen] = useState(false)
    const [manualPasteText, setManualPasteText] = useState('')

    const {
        state: terminalState,
        connect,
        write,
        resize,
        disconnect,
        onOutput,
        onExit,
    } = useTerminalSocket({
        token,
        sessionId,
        terminalId,
        baseUrl,
    })

    useEffect(() => {
        onOutput((data) => {
            terminalRef.current?.write(data)
        })
    }, [onOutput])

    useEffect(() => {
        onExit((code, signal) => {
            setExitInfo({ code, signal })
            terminalRef.current?.write(`\r\n[process exited${code !== null ? ` with code ${code}` : ''}]`)
            if (exitNavTimerRef.current) {
                clearTimeout(exitNavTimerRef.current)
            }
            if (props.terminalId) return
            exitNavTimerRef.current = setTimeout(() => {
                exitNavTimerRef.current = null
                goBack()
            }, EXIT_NAVIGATION_DELAY_MS)
        })
    }, [onExit, goBack, props.terminalId])

    // Raw terminal input AND the quick-key buttons share one sticky-modifier
    // state via the dispatcher, so toggling Ctrl then typing sends the control
    // code. onData is intentionally ungated; the buttons gate via `disabled`.
    const { ctrlActive, altActive, shiftActive, dispatch, toggleModifier, resetModifiers, consumeModifiers, lockedModifiers, lockModifier } = useTerminalKeys(write)

    const handleTerminalMount = useCallback(
        (terminal: Terminal) => {
            terminalRef.current = terminal
            inputDisposableRef.current?.dispose()
            inputDisposableRef.current = terminal.onData((data) => {
                dispatch(data)
            })
            if (!props.terminalId && (!compactControls || inputMode === 'direct')) {
                terminal.focus()
            }
        },
        [compactControls, inputMode, dispatch, props.terminalId]
    )

    const handleResize = useCallback(
        (cols: number, rows: number) => {
            lastSizeRef.current = { cols, rows }
            if (!session?.active || !terminalSupported) {
                return
            }
            if (!connectOnceRef.current) {
                connectOnceRef.current = true
                connect(cols, rows)
            } else {
                resize(cols, rows)
            }
        },
        [session?.active, terminalSupported, connect, resize]
    )

    useEffect(() => {
        if (!session?.active || !terminalSupported) {
            return
        }
        if (connectOnceRef.current) {
            return
        }
        const size = lastSizeRef.current
        if (!size) {
            return
        }
        connectOnceRef.current = true
        connect(size.cols, size.rows)
    }, [session?.active, terminalSupported, connect])

    useEffect(() => {
        connectOnceRef.current = false
        setExitInfo(null)
        setCommandDraft('')
        setInputMode('direct')
        setMoreKeysOpen(false)
        setCopyOpen(false)
        setSnippetsOpen(false)
        setKeyEditorOpen(false)
        setDirectKeyPage('control')
        if (exitNavTimerRef.current) {
            clearTimeout(exitNavTimerRef.current)
            exitNavTimerRef.current = null
        }
        disconnect()
    }, [sessionId, disconnect])

    useEffect(() => {
        return () => {
            inputDisposableRef.current?.dispose()
            connectOnceRef.current = false
            if (exitNavTimerRef.current) {
                clearTimeout(exitNavTimerRef.current)
                exitNavTimerRef.current = null
            }
            disconnect()
        }
    }, [disconnect])

    useEffect(() => {
        if (session?.active === false || !terminalSupported) {
            disconnect()
            connectOnceRef.current = false
        }
    }, [session?.active, terminalSupported, disconnect])

    useEffect(() => {
        if (terminalState.status === 'connecting' || terminalState.status === 'connected') {
            setExitInfo(null)
            if (exitNavTimerRef.current) {
                clearTimeout(exitNavTimerRef.current)
                exitNavTimerRef.current = null
            }
        }
    }, [terminalState.status])

    const quickInputDisabled = !session?.active || terminalState.status !== 'connected'
    const commandSubmitDisabled = quickInputDisabled || commandDraft.trim().length === 0
    const writePlainInput = useCallback(
        (text: string) => {
            if (!text || quickInputDisabled) {
                return false
            }
            resetModifiers()
            if (compactControls && inputMode === 'command') {
                const input = commandInputRef.current
                const start = input?.selectionStart ?? commandDraft.length
                const end = input?.selectionEnd ?? start
                setCommandDraft(commandDraft.slice(0, start) + text + commandDraft.slice(end))
                requestAnimationFrame(() => {
                    input?.focus()
                    input?.setSelectionRange(start + text.length, start + text.length)
                })
                return true
            }
            const terminal = terminalRef.current
            if (terminal) {
                terminal.paste(text)
                terminal.focus()
            } else {
                write(text)
            }
            return true
        },
        [quickInputDisabled, write, resetModifiers, compactControls, inputMode, commandDraft]
    )

    const handlePasteAction = useCallback(async () => {
        if (quickInputDisabled) {
            return
        }
        const readClipboard = navigator.clipboard?.readText
        if (readClipboard) {
            try {
                const clipboardText = await readClipboard.call(navigator.clipboard)
                if (!clipboardText) {
                    return
                }
                if (writePlainInput(clipboardText)) {
                    return
                }
            } catch {
                // Fall through to manual paste modal.
            }
        }
        setManualPasteText('')
        setPasteDialogOpen(true)
    }, [quickInputDisabled, writePlainInput])

    const handleManualPasteSubmit = useCallback(() => {
        if (!manualPasteText.trim()) {
            return
        }
        if (writePlainInput(manualPasteText)) {
            setPasteDialogOpen(false)
            setManualPasteText('')
        }
    }, [manualPasteText, writePlainInput])

    const handleQuickInput = useCallback(
        (sequence: string) => {
            if (quickInputDisabled) {
                return
            }
            const data = terminalRef.current?.modes.applicationCursorKeysMode
                ? sequence.replace(/^\u001b\[([ABCDHF])$/, '\u001bO$1') : sequence
            dispatch(data)
            if (compactControls && inputMode === 'command') {
                commandInputRef.current?.focus()
            } else if (!compactControls || terminalRef.current?.textarea === document.activeElement) {
                terminalRef.current?.focus()
            }
        },
        [quickInputDisabled, compactControls, inputMode, dispatch]
    )

    const handleModifierToggle = useCallback(
        (modifier: TerminalModifier) => {
            if (quickInputDisabled) {
                return
            }
            toggleModifier(modifier)
        },
        [quickInputDisabled, toggleModifier]
    )

    const handleCommandSubmit = useCallback(() => {
        if (commandSubmitDisabled) {
            return
        }
        write(buildTerminalCommandSequence(commandDraft))
        setCommandDraft('')
        resetModifiers()
        requestAnimationFrame(() => commandInputRef.current?.focus())
    }, [commandDraft, commandSubmitDisabled, write, resetModifiers])

    const handleCommandKeyDown = useCallback(
        (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
            const nativeEvent = event.nativeEvent
            const isImeEvent = nativeEvent.isComposing || nativeEvent.keyCode === 229
            if (event.key !== 'Enter' || event.shiftKey || isImeEvent) {
                return
            }
            event.preventDefault()
            handleCommandSubmit()
        },
        [handleCommandSubmit]
    )

    const handleCommandTemplate = useCallback((command: string) => {
        setCommandDraft(command)
        requestAnimationFrame(() => {
            const input = commandInputRef.current
            input?.focus()
            input?.setSelectionRange(command.length, command.length)
        })
    }, [])

    const handleInputModeChange = useCallback(
        (mode: TerminalInputMode) => {
            setInputMode(mode)
            resetModifiers()
            if (mode === 'direct' && terminalRef.current) {
                terminalRef.current.options.disableStdin = false
                terminalRef.current.focus()
            }
        },
        [resetModifiers]
    )

    useEffect(() => {
        if (inputMode === 'command') commandInputRef.current?.focus()
    }, [inputMode])

    const handleRetry = useCallback(() => {
        const size = lastSizeRef.current
        if (!size || !session?.active || !terminalSupported) {
            return
        }
        setExitInfo(null)
        connect(size.cols, size.rows)
    }, [session?.active, terminalSupported, connect])

    if (!session) {
        return (
            <div className="flex h-full items-center justify-center">
                <LoadingState label="Loading session…" className="text-sm" />
            </div>
        )
    }

    const subtitle = session.metadata?.path ?? sessionId
    const status = terminalState.status
    const errorMessage = !terminalSupported
        ? t('terminal.unsupportedWindows')
        : terminalState.status === 'error'
          ? terminalState.error
          : null

    return (
        <div className="flex h-full min-h-0 flex-col">
            {workspacePanel ? <div className="flex justify-end px-4 py-2"><ConnectionIndicator status={status} /></div> : <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-2 p-3 border-b border-[var(--app-border)]">
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">Terminal</div>
                        <div className="truncate text-xs text-[var(--app-hint)]">{subtitle}</div>
                    </div>
                    <ConnectionIndicator status={status} />
                </div>
            </div>}

            {session.active ? null : (
                <div className="mx-auto w-full max-w-content bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                    Session is inactive. Terminal is unavailable.
                </div>
            )}

            {errorMessage ? (
                <div className="mx-auto w-full max-w-content px-3 pt-3">
                    <div className="flex items-center gap-2 rounded-md border border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] p-3 text-xs text-[var(--app-badge-error-text)]">
                        <span className="min-w-0 flex-1">{errorMessage}</span>
                        {session.active && terminalSupported ? (
                            <button
                                type="button"
                                onClick={handleRetry}
                                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-current px-2 font-medium transition-opacity hover:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
                            >
                                <RetryIcon />
                                {t('terminal.retry')}
                            </button>
                        ) : null}
                    </div>
                </div>
            ) : null}

            {exitInfo ? (
                <div className="mx-auto w-full max-w-content px-3 pt-3">
                    <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-xs text-[var(--app-hint)]">
                        Terminal exited
                        {exitInfo.code !== null ? ` with code ${exitInfo.code}` : ''}
                        {exitInfo.signal ? ` (${exitInfo.signal})` : ''}.
                    </div>
                </div>
            ) : null}

            <div className="flex-1 min-h-0 overflow-hidden bg-[var(--app-bg)]">
                <div className="mx-auto h-full w-full max-w-content px-2 py-2 sm:p-3">
                    {terminalSupported ? (
                        <TerminalView
                            onMount={handleTerminalMount}
                            onResize={handleResize}
                            disableStdin={compactControls && inputMode === 'command'}
                            className="h-full w-full"
                        />
                    ) : (
                        <div className="flex h-full items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-4 text-sm text-[var(--app-hint)]">
                            {t('terminal.unsupportedWindows')}
                        </div>
                    )}
                </div>
            </div>

            <div className="bg-[var(--app-bg)] border-t border-[var(--app-border)] pb-[env(safe-area-inset-bottom)]">
                <div className="mx-auto w-full max-w-content px-1">
                    {compactControls ? (
                        <div className="flex flex-col gap-1.5">
                            {inputMode === 'command' ? (
                                <div className="flex items-end gap-2">
                                    <textarea
                                        ref={commandInputRef}
                                        value={commandDraft}
                                        onChange={(event) => setCommandDraft(event.target.value)}
                                        onKeyDown={handleCommandKeyDown}
                                        placeholder={t('terminal.command.placeholder')}
                                        aria-label={t('terminal.command.inputLabel')}
                                        rows={1}
                                        enterKeyHint="send"
                                        autoCapitalize="none"
                                        autoCorrect="off"
                                        spellCheck={false}
                                        disabled={quickInputDisabled}
                                        className="h-11 min-w-0 flex-1 resize-none rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-base leading-6 text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)] focus:border-[var(--app-link)]"
                                    />
                                    <button
                                        type="button"
                                        onClick={handleCommandSubmit}
                                        disabled={commandSubmitDisabled}
                                        aria-label={t('terminal.command.run')}
                                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-[var(--app-button)] text-[var(--app-button-text)] disabled:opacity-40"
                                    >
                                        <SendIcon />
                                    </button>
                                </div>
                            ) : null}
                            {moreKeysOpen ? (
                                <div id="terminal-more-keys" className="max-h-[min(10rem,25dvh)] overflow-y-auto rounded-lg border border-[var(--app-border)] p-2">
                                    {inputMode === 'command' ? (
                                        <div className="grid grid-cols-4 gap-1.5" aria-label={t('terminal.command.shortcuts')}>
                                            {BASIC_COMMANDS.map(item => (
                                                <button
                                                    key={item.label}
                                                    type="button"
                                                    onClick={() => handleCommandTemplate(item.command)}
                                                    disabled={quickInputDisabled}
                                                    className="h-11 truncate rounded-md bg-[var(--app-secondary-bg)] px-1 text-xs font-mono disabled:opacity-50"
                                                >
                                                    {item.label}
                                                </button>
                                            ))}
                                        </div>
                                    ) : (
                                        <>
                                            <div className="mb-2 grid grid-cols-4 gap-1" role="group" aria-label={t('terminal.direct.pages')}>
                                                {DIRECT_KEY_PAGE_IDS.map(page => (
                                                    <button
                                                        key={page}
                                                        type="button"
                                                        onClick={() => setDirectKeyPage(page)}
                                                        aria-pressed={directKeyPage === page}
                                                        className={`h-8 rounded-md text-xs ${directKeyPage === page ? 'bg-[var(--app-secondary-bg)] text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                                                    >
                                                        {t(`terminal.direct.page.${page}`)}
                                                    </button>
                                                ))}
                                            </div>
                                            <div className="grid grid-cols-4 gap-1.5">
                                                {COMPACT_DIRECT_INPUTS[directKeyPage].filter(input => !touchBarKeys.some(key => input.modifier ? key.modifier === input.modifier : key.send === input.sequence && !key.modifier && !key.action)).map(input => (
                                                    <QuickKeyButton
                                                        key={input.label}
                                                        input={input}
                                                        disabled={quickInputDisabled}
                                                        isActive={input.modifier === 'alt' && altActive}
                                                        onPress={handleQuickInput}
                                                        onToggleModifier={handleModifierToggle}
                                                        compact
                                                    />
                                                ))}
                                            </div>
                                        </>
                                    )}
                                </div>
                            ) : null}
                            <TouchBar
                                onCommand={() => handleInputModeChange(inputMode === 'command' ? 'direct' : 'command')}
                                commandMode={inputMode === 'command'}
                                onMoreKeys={() => setMoreKeysOpen(value => !value)}
                                onCustomize={() => setKeyEditorOpen(true)}
                                settings={toolbarSettings}
                                keys={touchBarKeys}
                                disabled={quickInputDisabled}
                                modifiers={{ ctrl: ctrlActive, alt: altActive, shift: shiftActive }}
                                onPress={handleQuickInput}
                                onToggleModifier={handleModifierToggle}
                                resolveSequence={sequence => applyTerminalModifiers(sequence, { ctrl: ctrlActive, alt: altActive, shift: shiftActive }, terminalRef.current?.modes.applicationCursorKeysMode)}
                                onRepeat={sequence => { if (!quickInputDisabled) write(sequence) }}
                                onResetModifiers={consumeModifiers}
                                lockedModifiers={lockedModifiers}
                                onLockModifier={lockModifier}
                                onSnippets={() => { terminalRef.current?.blur(); setSnippetsOpen(true) }}
                                onCopy={() => { terminalRef.current?.blur(); setCopyOpen(true) }}
                                onPaste={() => { void handlePasteAction() }}
                                onKeyboard={() => {
                                    if (inputMode === 'command') {
                                        commandInputRef.current?.blur()
                                        handleInputModeChange('direct')
                                    } else if (terminalRef.current?.textarea === document.activeElement) {
                                        terminalRef.current.blur()
                                    } else {
                                        terminalRef.current?.focus()
                                    }
                                }}
                            />
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2 py-2">
                            <button
                                type="button"
                                onClick={() => {
                                    void handlePasteAction()
                                }}
                                disabled={quickInputDisabled}
                                className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {t('button.paste')}
                            </button>
                            <QuickKeyRows
                                ctrlActive={ctrlActive}
                                altActive={altActive}
                                disabled={quickInputDisabled}
                                onPress={handleQuickInput}
                                onToggleModifier={handleModifierToggle}
                            />
                        </div>
                    )}
                </div>
            </div>

            <Dialog open={snippetsOpen} onOpenChange={setSnippetsOpen}>
                <DialogContent>
                    <DialogHeader><DialogTitle>{t('terminal.keys.snippets')}</DialogTitle><DialogDescription>{t('terminal.keys.escapeHint')}</DialogDescription></DialogHeader>
                    <div className="max-h-[50dvh] overflow-y-auto space-y-1">
                        {touchBarKeys.filter(key => key.id.startsWith('custom-') || key.id.startsWith('ctrl-')).map(key => <button key={key.id} type="button" disabled={quickInputDisabled} className="block w-full rounded-md p-3 text-left text-sm hover:bg-[var(--app-secondary-bg)]" onClick={() => { setSnippetsOpen(false); if (key.action === 'paste') { void handlePasteAction() } else { resetModifiers(); write(key.send); terminalRef.current?.focus() } }}>{key.label}</button>)}
                        {!touchBarKeys.some(key => key.id.startsWith('custom-') || key.id.startsWith('ctrl-')) ? <p className="py-3 text-sm text-[var(--app-hint)]">{t('terminal.keys.emptySnippets')}</p> : null}
                    </div>
                    <Button onClick={() => { setSnippetsOpen(false); setKeyEditorOpen(true) }}>{t('terminal.keys.add')}</Button>
                </DialogContent>
            </Dialog>
            <SelectOverlay terminal={terminalRef.current} open={copyOpen} onClose={() => setCopyOpen(false)} />
            <KeyEditor settings={toolbarSettings} onSettingsChange={updateSettings} open={keyEditorOpen} keys={touchBarKeys} onChange={updateKeys} onClose={() => setKeyEditorOpen(false)} />
            {saveError ? <div role="alert" className="px-3 text-xs text-[var(--app-badge-error-text)]">{t('terminal.keys.saveError')}</div> : null}

            <Dialog
                open={pasteDialogOpen}
                onOpenChange={(open) => {
                    setPasteDialogOpen(open)
                    if (!open) {
                        setManualPasteText('')
                    }
                }}
            >
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t('terminal.paste.fallbackTitle')}</DialogTitle>
                        <DialogDescription>
                            {t('terminal.paste.fallbackDescription')}
                        </DialogDescription>
                    </DialogHeader>
                    <textarea
                        value={manualPasteText}
                        onChange={(event) => setManualPasteText(event.target.value)}
                        placeholder={t('terminal.paste.placeholder')}
                        className="mt-2 min-h-32 w-full resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                        autoCapitalize="none"
                        autoCorrect="off"
                    />
                    <div className="mt-3 flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => {
                                setPasteDialogOpen(false)
                                setManualPasteText('')
                            }}
                        >
                            {t('button.cancel')}
                        </Button>
                        <Button
                            type="button"
                            onClick={handleManualPasteSubmit}
                            disabled={!manualPasteText.trim()}
                        >
                            {t('button.paste')}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    )
}
