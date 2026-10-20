import { render, waitFor } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useActiveSuggestions, type Suggestion } from '@/hooks/useActiveSuggestions'

const suggestions: Suggestion[] = [
    { key: '$lark-base', text: '$lark-base', label: '$lark-base', description: 'Base' },
    { key: '$lark-calendar', text: '$lark-calendar', label: '$lark-calendar', description: 'Calendar' }
]

describe('useActiveSuggestions handler churn', () => {
    it('does not re-render itself into a loop when only the handler identity changes', async () => {
        const calls = vi.fn(async (_query: string) => suggestions)

        function Harness() {
            const [, setTick] = useState(0)
            // A fresh callback on every render, like a parent whose memo
            // dependencies (session list, machine labels) change frequently.
            const handler = (query: string) => calls(query)
            useEffect(() => {
                const id = setInterval(() => setTick((value) => value + 1), 100)
                return () => clearInterval(id)
            }, [])
            useActiveSuggestions('$', handler)
            return null
        }

        render(<Harness />)
        await waitFor(() => expect(calls).toHaveBeenCalled())
        await new Promise((resolve) => setTimeout(resolve, 500))
        // Parent renders may still refresh the handler, but each result is
        // equal, so the hook must not re-render itself into an endless loop.
        expect(calls.mock.calls.length).toBeLessThanOrEqual(8)
    })
})
