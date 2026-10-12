import type { NativeForkBoundary } from '@hapi/protocol/apiTypes'

export type ForkBoundary = string | NativeForkBoundary

function boundaryKey(boundary: ForkBoundary | undefined): string {
    if (boundary === undefined) return JSON.stringify(['current'])
    if (typeof boundary === 'string') return JSON.stringify(['managed', boundary])
    return JSON.stringify(['native', boundary.threadId, boundary.turnId, boundary.itemId])
}

/** Keep a confirmed fork destination if only navigation failed. Never retry a POST automatically. */
export function createForkNavigator(
    create: (boundary?: ForkBoundary) => Promise<{ sessionId: string }>,
    navigate: (sessionId: string) => Promise<unknown>,
) {
    const destinations = new Map<string, string>()
    let pending: Promise<void> | null = null
    return (boundary?: ForkBoundary): Promise<void> => {
        if (pending) return pending
        const key = boundaryKey(boundary)
        pending = (async () => {
            let destination = destinations.get(key)
            if (!destination) {
                destination = (await create(boundary)).sessionId
                destinations.set(key, destination)
            }
            await navigate(destination)
            destinations.delete(key)
        })().finally(() => { pending = null })
        return pending
    }
}
