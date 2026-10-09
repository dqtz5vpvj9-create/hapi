// A supersession notification can arrive before the resume HTTP response.
// Keep the source composer mounted until its submitted draft has been handed
// over; mounting the target early would hydrate an empty draft.
const pending = new Map<string, Set<Promise<void>>>()

export function beginComposerSessionResolution(sessionId: string): () => void {
    let finish!: () => void
    const operation = new Promise<void>(resolve => { finish = resolve })
    const operations = pending.get(sessionId) ?? new Set<Promise<void>>()
    operations.add(operation)
    pending.set(sessionId, operations)
    return () => {
        operations.delete(operation)
        if (operations.size === 0) pending.delete(sessionId)
        finish()
    }
}

export async function awaitComposerSessionResolution(sessionId: string): Promise<void> {
    await Promise.all(pending.get(sessionId) ?? [])
}
