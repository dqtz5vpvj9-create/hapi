import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { panes, WorkspaceUpdateRequestSchema } from '@hapi/protocol/workspaces'
import type { SyncEvent } from '@hapi/protocol'
import { ZodError } from 'zod'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

export function createWorkspacesRoutes(store: Store, publish: (event: SyncEvent) => void): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('/workspaces/*', bodyLimit({ maxSize: 1024 * 1024 }))
    app.get('/workspaces', c => {
        c.header('Cache-Control', 'no-store')
        return c.json(store.workspaces.get(c.get('namespace')))
    })
    app.post('/workspaces/operations', async c => {
        const parsed = WorkspaceUpdateRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid workspace operation' }, 400)
        const namespace = c.get('namespace'), command = parsed.data.operation.command
        if (store.workspaces.hasOperation(namespace, parsed.data.operation.id)) {
            return c.json({ status: 'duplicate', snapshot: store.workspaces.get(namespace) })
        }
        const resources = command.type === 'bind' ? [command.resource]
            : command.type === 'split' ? [command.added.resource]
            : command.type === 'layout' && command.added ? [command.added.resource]
            : command.type === 'create' || command.type === 'restore' ? panes(command.workspace.root).map(p => p.resource)
            : command.type === 'import' ? command.workspaces.flatMap(w => panes(w.root).map(p => p.resource)) : []
        // Geometry operations cannot change bindings. New references must belong to this namespace.
        if (resources.some(resource => resource.kind !== 'empty' && !store.sessions.getSessionByNamespace(resource.sessionId, namespace))) {
            return c.json({ error: 'Session not found' }, 404)
        }
        for (const resource of resources) {
            if (resource.kind !== 'document' || resource.document.kind !== 'file' || !resource.document.machineId) continue
            const session = store.sessions.getSessionByNamespace(resource.sessionId, namespace)
            const metadata = session?.metadata
            const machineId = metadata && typeof metadata === 'object' && 'machineId' in metadata ? metadata.machineId : undefined
            if (machineId !== resource.document.machineId) return c.json({ error: 'Document machine does not match its source session' }, 403)
        }
        try {
            const result = store.workspaces.update(namespace, parsed.data)
            if (result.status === 'applied') publish({ type: 'workspaces-updated', namespace, revision: result.snapshot.revision })
            return c.json(result, result.status === 'conflict' ? 409 : 200)
        } catch (error) {
            if (error instanceof ZodError) return c.json({ error: 'Workspace identities must remain unique' }, 400)
            throw error
        }
    })
    return app
}
