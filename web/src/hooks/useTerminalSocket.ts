import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Manager, type Socket } from 'socket.io-client'
import type { TerminalOutputStream } from '@hapi/protocol'
import { TerminalOutputTracker, type TerminalOutputIssue } from '@/lib/terminal-output'

type TerminalConnectionState =
    | { status: 'idle' }
    | { status: 'connecting' }
    | { status: 'connected' }
    | { status: 'error'; error: string }

type UseTerminalSocketOptions = {
    baseUrl: string
    token: string
    sessionId: string
    terminalId: string
}

type TerminalReadyPayload = {
    terminalId: string
    replayProtocol?: 1
}

type TerminalOutputPayload = {
    terminalId: string
    data: string
    stream?: TerminalOutputStream
}

type TerminalExitPayload = {
    terminalId: string
    code: number | null
    signal: string | null
}

type TerminalErrorPayload = {
    terminalId: string
    message: string
}

export function useTerminalSocket(options: UseTerminalSocketOptions): {
    state: TerminalConnectionState
    connect: (cols: number, rows: number) => void
    write: (data: string) => void
    resize: (cols: number, rows: number) => void
    disconnect: () => void
    onOutput: (handler: (data: string) => boolean | void) => void
    resetOutputReceiver: () => void
    outputIssue: TerminalOutputIssue
    onExit: (handler: (code: number | null, signal: string | null) => void) => void
} {
    const [state, setState] = useState<TerminalConnectionState>({ status: 'idle' })
    const socketRef = useRef<Socket | null>(null)
    const outputHandlerRef = useRef<(data: string) => boolean | void>(() => false)
    const outputTrackerRef = useRef(new TerminalOutputTracker())
    const inputReadyRef = useRef(false)
    const readyReceivedRef = useRef(false)
    const replayReceivedRef = useRef(false)
    const [outputIssue, setOutputIssue] = useState<TerminalOutputIssue>(null)
    const exitHandlerRef = useRef<(code: number | null, signal: string | null) => void>(() => {})
    const sessionIdRef = useRef(options.sessionId)
    const terminalIdRef = useRef(options.terminalId)
    const tokenRef = useRef(options.token)
    const baseUrlRef = useRef(options.baseUrl)
    const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)

    useLayoutEffect(() => {
        if (sessionIdRef.current !== options.sessionId || terminalIdRef.current !== options.terminalId) {
            outputTrackerRef.current.reset()
            inputReadyRef.current = false
            readyReceivedRef.current = false
            replayReceivedRef.current = false
            setOutputIssue(null)
        }
        sessionIdRef.current = options.sessionId
        terminalIdRef.current = options.terminalId
        baseUrlRef.current = options.baseUrl
    }, [options.sessionId, options.terminalId, options.baseUrl])

    useEffect(() => {
        tokenRef.current = options.token
        const socket = socketRef.current
        if (!socket) {
            return
        }
        if (!options.token) {
            if (socket.connected) {
                socket.disconnect()
            }
            return
        }
        socket.auth = { token: options.token }
        if (socket.connected) {
            socket.disconnect()
            socket.connect()
        }
    }, [options.token])

    const isCurrentTerminal = useCallback((terminalId: string) => terminalId === terminalIdRef.current, [])

    const emitCreate = useCallback((socket: Socket, size: { cols: number; rows: number }) => {
        inputReadyRef.current = false
        readyReceivedRef.current = false
        replayReceivedRef.current = false
        socket.emit('terminal:create', {
            sessionId: sessionIdRef.current,
            terminalId: terminalIdRef.current,
            cols: size.cols,
            rows: size.rows,
            replayProtocol: 1,
            ...(outputTrackerRef.current.cursor ? { outputCursor: outputTrackerRef.current.cursor } : {})
        })
    }, [])

    const setErrorState = useCallback((message: string) => {
        setState({ status: 'error', error: message })
    }, [])

    const connect = useCallback((cols: number, rows: number) => {
        lastSizeRef.current = { cols, rows }
        const token = tokenRef.current
        const sessionId = sessionIdRef.current
        const terminalId = terminalIdRef.current

        if (!token || !sessionId || !terminalId) {
            setErrorState('Missing terminal credentials.')
            return
        }

        if (socketRef.current) {
            const socket = socketRef.current
            socket.auth = { token }
            if (socket.connected) {
                emitCreate(socket, { cols, rows })
            } else {
                socket.connect()
            }
            setState({ status: 'connecting' })
            return
        }

        const manager = new Manager(baseUrlRef.current, {
            path: '/socket.io/',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            transports: ['polling', 'websocket'],
            // Skip the HTTP long-polling phase on reconnects once a websocket
            // upgrade has succeeded — see useAgentTerminalSocket.
            rememberUpgrade: true,
            autoConnect: false
        })
        const socket = manager.socket('/terminal', {
            auth: { token }
        })

        socketRef.current = socket
        setState({ status: 'connecting' })

        socket.on('connect', () => {
            outputTrackerRef.current.reconnect()
            setOutputIssue(outputTrackerRef.current.issue)
            const size = lastSizeRef.current ?? { cols, rows }
            setState({ status: 'connecting' })
            emitCreate(socket, size)
        })

        socket.on('terminal:ready', (payload: TerminalReadyPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            readyReceivedRef.current = true
            const tracker = outputTrackerRef.current
            if (!payload.replayProtocol && tracker.cursor && !replayReceivedRef.current) tracker.issue = 'legacy'
            inputReadyRef.current = !tracker.blocked && (payload.replayProtocol !== 1 || replayReceivedRef.current)
            setOutputIssue(tracker.issue)
            setState({ status: 'connected' })
        })

        socket.on('terminal:output', (payload: TerminalOutputPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            const tracker = outputTrackerRef.current
            tracker.receive(payload.data, payload.stream, outputHandlerRef.current)
            if (payload.stream?.replay && tracker.cursor && !tracker.blocked) replayReceivedRef.current = true
            if (tracker.blocked) inputReadyRef.current = false
            else if (readyReceivedRef.current && replayReceivedRef.current) inputReadyRef.current = true
            setOutputIssue(tracker.issue)
        })

        socket.on('terminal:exit', (payload: TerminalExitPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            inputReadyRef.current = false
            exitHandlerRef.current(payload.code, payload.signal)
            setErrorState('Terminal exited.')
        })

        socket.on('terminal:error', (payload: TerminalErrorPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            inputReadyRef.current = false
            setErrorState(payload.message)
        })

        socket.on('connect_error', (error) => {
            const message = error instanceof Error ? error.message : 'Connection error'
            setErrorState(message)
        })

        socket.on('disconnect', (reason) => {
            inputReadyRef.current = false
            if (reason === 'io client disconnect') {
                setState({ status: 'idle' })
                return
            }
            setErrorState(`Disconnected: ${reason}`)
        })

        socket.connect()
    }, [emitCreate, setErrorState, isCurrentTerminal])

    const write = useCallback((data: string) => {
        const socket = socketRef.current
        if (!socket || !socket.connected || !inputReadyRef.current || outputTrackerRef.current.blocked) {
            return
        }
        socket.emit('terminal:write', { terminalId: terminalIdRef.current, data })
    }, [])

    const resize = useCallback((cols: number, rows: number) => {
        lastSizeRef.current = { cols, rows }
        const socket = socketRef.current
        if (!socket || !socket.connected) {
            return
        }
        socket.emit('terminal:resize', { terminalId: terminalIdRef.current, cols, rows })
    }, [])

    const disconnect = useCallback(() => {
        inputReadyRef.current = false
        const socket = socketRef.current
        if (!socket) {
            return
        }
        socket.removeAllListeners()
        socket.disconnect()
        socketRef.current = null
        setState({ status: 'idle' })
    }, [])

    const resetOutputReceiver = useCallback(() => {
        inputReadyRef.current = false
        outputTrackerRef.current.reset()
        setOutputIssue(null)
        // Reattach the same shell with a fresh viewer. This also works with old
        // Hubs, which replay only when the socket id changes. Never close the PTY.
        if (socketRef.current) {
            // A new receiver needs a new Socket object too: otherwise buffered
            // packets from the old receiver could be flushed before reconnect.
            const size = lastSizeRef.current
            disconnect()
            if (size) connect(size.cols, size.rows)
        }
    }, [connect, disconnect])

    const onOutput = useCallback((handler: (data: string) => boolean | void) => {
        outputHandlerRef.current = handler
    }, [])

    const onExit = useCallback((handler: (code: number | null, signal: string | null) => void) => {
        exitHandlerRef.current = handler
    }, [])

    return {
        state,
        connect,
        write,
        resize,
        disconnect,
        onOutput,
        resetOutputReceiver,
        outputIssue,
        onExit
    }
}
