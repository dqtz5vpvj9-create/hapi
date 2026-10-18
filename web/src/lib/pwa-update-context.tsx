import { createContext, useContext, type ReactNode } from 'react'
import { usePwaUpdate } from '@/hooks/usePwaUpdate'
import { useNativeUpdate } from '@/hooks/useNativeUpdate'
import { isNativePlatform } from '@/lib/platform'

type PwaUpdateContextValue = ReturnType<typeof usePwaUpdate> & Partial<ReturnType<typeof useNativeUpdate>>

const PwaUpdateContext = createContext<PwaUpdateContextValue | null>(null)

export function PwaUpdateProvider({ children }: { children: ReactNode }) {
    return isNativePlatform()
        ? <NativeUpdateProvider>{children}</NativeUpdateProvider>
        : <BrowserUpdateProvider>{children}</BrowserUpdateProvider>
}

function BrowserUpdateProvider({ children }: { children: ReactNode }) {
    const value = usePwaUpdate()

    return (
        <PwaUpdateContext.Provider value={value}>
            {children}
        </PwaUpdateContext.Provider>
    )
}

function NativeUpdateProvider({ children }: { children: ReactNode }) {
    const value = useNativeUpdate()
    return (
        <PwaUpdateContext.Provider value={value}>
            <div className="contents" inert={value.status === 'applying'}>{children}</div>
        </PwaUpdateContext.Provider>
    )
}

export function usePwaUpdateContext() {
    const value = useContext(PwaUpdateContext)
    if (!value) {
        throw new Error('usePwaUpdateContext must be used within PwaUpdateProvider')
    }
    return value
}
