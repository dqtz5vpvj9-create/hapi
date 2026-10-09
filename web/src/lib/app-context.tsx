import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { ApiClient } from '@/api/client'

import type { WorkspaceStore } from '@/workspace/workspaceStore'

type AppContextValue = {
    workspace?: WorkspaceStore
    workspaceActive?: boolean
    api: ApiClient
    token: string
    baseUrl: string
    executionConnected?: boolean
    titleSuggestionAvailable?: boolean
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppContextProvider(props: {
    value: AppContextValue
    children: ReactNode
}) {
    const { api, token, baseUrl, workspace, workspaceActive, executionConnected, titleSuggestionAvailable } = props.value
    const value = useMemo(() => ({ api, token, baseUrl, workspace, workspaceActive, executionConnected, titleSuggestionAvailable }),
        [api, token, baseUrl, workspace, workspaceActive, executionConnected, titleSuggestionAvailable])
    return (
        <AppContext.Provider value={value}>
            {props.children}
        </AppContext.Provider>
    )
}

export function useOptionalAppContext(): AppContextValue | null {
    return useContext(AppContext)
}

export function useAppContext(): AppContextValue {
    const context = useContext(AppContext)
    if (!context) {
        throw new Error('AppContext is not available')
    }
    return context
}
