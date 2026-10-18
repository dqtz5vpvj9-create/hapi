import { createContext, useContext } from 'react'
import type { useNavigate } from '@tanstack/react-router'
import type { DocumentRef } from '@hapi/protocol/documents'

export type FileWorkbenchNavigation = {
    sessionId: string
    open: (ref: DocumentRef) => void
    reveal: (path: string) => void
    navigate: ReturnType<typeof useNavigate>
}
export const FileWorkbenchNavigationContext = createContext<FileWorkbenchNavigation | null>(null)
export const useFileWorkbenchNavigation = () => useContext(FileWorkbenchNavigationContext)
