import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import type { Machine } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'

const STORAGE_KEY = 'hapi-machine-icons'
const MachineIdentityContext = createContext<{ icons: Record<string, string>; labels: Record<string, string> }>({ icons: {}, labels: {} })

export function MachineIdentityProvider(props: {
    machines: Record<string, Machine>
    labels: Record<string, string>
    children: ReactNode
}) {
    const icons = useMemo(() => {
        // Cache server-assigned identities so an offline Runner keeps its icon.
        let cached: Record<string, string> = {}
        try { cached = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') } catch { /* Storage may be unavailable. */ }
        const result = { ...cached }
        for (const machine of Object.values(props.machines)) {
            if (machine.metadata?.icon) result[machine.id] = machine.metadata.icon
        }
        return result
    }, [props.machines])
    useEffect(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(icons)) } catch { /* Storage may be unavailable. */ }
    }, [icons])
    const value = useMemo(() => ({ icons, labels: props.labels }), [icons, props.labels])
    return <MachineIdentityContext.Provider value={value}>{props.children}</MachineIdentityContext.Provider>
}

export function MachineIdentityIcon(props: { machineId?: string | null; className?: string }) {
    const { icons, labels } = useContext(MachineIdentityContext)
    const { t } = useTranslation()
    const label = props.machineId ? labels[props.machineId] ?? props.machineId.slice(0, 8) : t('machine.unknown')
    return <span
        className={`app-machine-identity ${props.className ?? 'app-session-machine-icon'}`}
        data-machine-id={props.machineId}
        title={label}
        aria-label={label}
        role="img"
    >{props.machineId ? icons[props.machineId] ?? '▱' : '▱'}</span>
}
