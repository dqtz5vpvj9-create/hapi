import { useMemo } from 'react'
import { useAppContext } from '@/lib/app-context'
import { workspaceStorageKey } from '@/workspace/workspaceStore'
import { DocumentRegistry } from './documentSession'

const registries = new WeakMap<object, { scope: string; registry: DocumentRegistry }>()
export function documentRegistryFor(api: object, scope: string) {
    let entry = registries.get(api)
    if (!entry || entry.scope !== scope) {
        entry = { scope, registry: new DocumentRegistry(scope) }
        registries.set(api, entry)
    }
    return entry.registry
}
export function useDocumentRegistry() {
    const { api, workspace, baseUrl, token } = useAppContext()
    return useMemo(() => {
        if (workspace) return workspace.documents
        return documentRegistryFor(api, workspaceStorageKey(baseUrl, token))
    }, [api, workspace, baseUrl, token])
}
