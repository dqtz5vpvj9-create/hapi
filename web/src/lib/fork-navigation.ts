/** Keep a confirmed fork destination if only navigation failed. Never retry a POST automatically. */
export function createForkNavigator(
    create: (boundary?: string) => Promise<{ sessionId: string }>,
    navigate: (sessionId: string) => Promise<unknown>,
) {
    const destinations = new Map<string | undefined, string>()
    let pending: Promise<void> | null = null
    return (boundary?: string): Promise<void> => {
        if (pending) return pending
        pending = (async () => {
            let destination = destinations.get(boundary)
            if (!destination) {
                destination = (await create(boundary)).sessionId
                destinations.set(boundary, destination)
            }
            await navigate(destination)
            destinations.delete(boundary)
        })().finally(() => { pending = null })
        return pending
    }
}
