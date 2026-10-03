import { useCallback, useEffect, useRef, useState } from 'react'

export type TerminalModifier = 'ctrl' | 'alt' | 'shift'
type Modifiers = Record<TerminalModifier, boolean>
const EMPTY_MODIFIERS: Modifiers = { ctrl: false, alt: false, shift: false }

export function applyTerminalModifiers(sequence: string, state: Modifiers, applicationCursorKeys = false): string {
    const parameter = 1 + Number(state.shift) + 2 * Number(state.alt) + 4 * Number(state.ctrl)
    if (parameter === 1) return applicationCursorKeys ? sequence.replace(/^\u001b\[([ABCDHF])$/, '\u001bO$1') : sequence

    // Cursor keys may arrive in normal (CSI) or application (SS3) mode.
    const cursor = /^\u001b(?:\[|O)([ABCDHFPQRS])$/.exec(sequence)
    if (cursor) return `\u001b[1;${parameter}${cursor[1]}`
    const navigation = /^\u001b\[(\d+)~$/.exec(sequence)
    if (navigation) return `\u001b[${navigation[1]};${parameter}~`
    if (sequence === '\t' && state.shift && !state.ctrl && !state.alt) return '\u001b[Z'

    let result = sequence
    if (state.ctrl && result.length === 1) {
        const code = result.toUpperCase().charCodeAt(0)
        if (code >= 64 && code <= 95) result = String.fromCharCode(code - 64)
        else if (result === ' ') result = '\u0000'
        else if (result === '?') result = '\u007f'
    } else if (state.shift && result.length === 1) {
        result = result.toUpperCase()
    }
    return state.alt ? `\u001b${result}` : result
}

export function useTerminalKeys(onSend: (data: string) => void) {
    const [modifiers, setModifiers] = useState<Modifiers>(EMPTY_MODIFIERS)
    const modifiersRef = useRef(modifiers)
    const [lockedModifiers, setLockedModifiers] = useState<Modifiers>(EMPTY_MODIFIERS)
    const lockedRef = useRef(lockedModifiers)
    const onSendRef = useRef(onSend)
    useEffect(() => { onSendRef.current = onSend }, [onSend])

    const resetModifiers = useCallback(() => {
        lockedRef.current = EMPTY_MODIFIERS
        setLockedModifiers(EMPTY_MODIFIERS)
        modifiersRef.current = EMPTY_MODIFIERS
        setModifiers(EMPTY_MODIFIERS)
    }, [])
    const toggleModifier = useCallback((modifier: TerminalModifier) => {
        if (lockedRef.current[modifier]) {
            const locked = { ...lockedRef.current, [modifier]: false }
            lockedRef.current = locked
            setLockedModifiers(locked)
        }
        const next = { ...modifiersRef.current, [modifier]: !modifiersRef.current[modifier] }
        modifiersRef.current = next
        setModifiers(next)
    }, [])
    const lockModifier = useCallback((modifier: TerminalModifier) => {
        const locked = { ...lockedRef.current, [modifier]: !lockedRef.current[modifier] }
        lockedRef.current = locked
        setLockedModifiers(locked)
        const next = { ...modifiersRef.current, [modifier]: locked[modifier] }
        modifiersRef.current = next
        setModifiers(next)
    }, [])
    const consumeModifiers = useCallback(() => {
        modifiersRef.current = lockedRef.current
        setModifiers(lockedRef.current)
    }, [])
    const dispatch = useCallback((sequence: string) => {
        if (!sequence) return
        onSendRef.current(applyTerminalModifiers(sequence, modifiersRef.current))
        consumeModifiers()
    }, [consumeModifiers])

    return {
        ctrlActive: modifiers.ctrl,
        altActive: modifiers.alt,
        shiftActive: modifiers.shift,
        dispatch,
        toggleModifier,
        resetModifiers,
        consumeModifiers,
        lockedModifiers,
        lockModifier,
    }
}
