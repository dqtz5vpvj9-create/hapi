import { useCallback, useMemo, useSyncExternalStore, type SetStateAction } from 'react'
import type { ApiClient } from '@/api/client'
import type { RequestUserInputQuestion } from './requestUserInput'

type QuestionState = { selected: string[]; userNote: string }
type Draft = {
    step: number
    answers: Record<string, QuestionState>
    loading: boolean
    error: string | null
    submitted: boolean
}
const clients = new WeakMap<ApiClient, Map<string, QuestionDraft>>()

class QuestionDraft {
    private listeners = new Set<() => void>()
    constructor(private state: Draft) {}
    get = () => this.state
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    update<K extends keyof Draft>(key: K, value: SetStateAction<Draft[K]>) {
        const next = typeof value === 'function' ? (value as (previous: Draft[K]) => Draft[K])(this.state[key]) : value
        if (Object.is(next, this.state[key])) return
        this.state = { ...this.state, [key]: next }
        this.listeners.forEach(listener => listener())
    }
}

/** A pending reply belongs to its session/tool, not a virtual row or workspace. */
export function useQuestionDraft(api: ApiClient, sessionId: string, toolId: string, questions: RequestUserInputQuestion[]) {
    const store = useMemo(() => {
        let entries = clients.get(api)
        if (!entries) { entries = new Map(); clients.set(api, entries) }
        const key = JSON.stringify([sessionId, toolId])
        let entry = entries.get(key)
        if (!entry) {
            entry = new QuestionDraft({ step: 0, answers: Object.fromEntries(questions.map(q => [q.id, { selected: [], userNote: q.prefill ?? '' }])), loading: false, error: null, submitted: false })
            entries.set(key, entry)
        }
        return entry
    }, [api, sessionId, toolId])
    const draft = useSyncExternalStore(store.subscribe, store.get)
    return {
        ...draft,
        setStep: useCallback((value: SetStateAction<number>) => store.update('step', value), [store]),
        setStateByQuestion: useCallback((value: SetStateAction<Draft['answers']>) => store.update('answers', value), [store]),
        setError: useCallback((value: string | null) => store.update('error', value), [store]),
        begin: () => {
            if (store.get().loading || store.get().submitted) return false
            store.update('loading', true)
            store.update('error', null)
            return true
        },
        finish: (success: boolean) => {
            if (success) { store.update('submitted', true); store.update('answers', {}); store.update('step', 0) }
            store.update('loading', false)
        },
    }
}
