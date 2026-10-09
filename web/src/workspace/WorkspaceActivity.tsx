import type { SessionSummary } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'

type Activity = Pick<SessionSummary, 'active' | 'thinking' | 'pendingRequestKinds' | 'backgroundTaskCount'>

/** Use the same authoritative state as the session list; never infer liveness from output. */
export function WorkspaceActivity({ session, label = false }: { session?: Activity; label?: boolean }) {
    const { t } = useTranslation()
    const kind = !session?.active ? 'offline'
        : session.pendingRequestKinds.includes('permission') ? 'permission'
        : session.pendingRequestKinds.includes('input') ? 'input'
        : session.thinking ? 'running'
        : session.backgroundTaskCount > 0 ? 'background' : 'idle'
    const text = t(kind === 'offline' ? 'misc.offline' : kind === 'idle' ? 'misc.online'
        : kind === 'input' ? 'session.item.needsInput' : `session.item.${kind}`)
    return <span className="workspace-activity" data-state={kind} title={text} aria-label={text}>
        <span className="workspace-activity-dot" aria-hidden="true" />
        {label ? <span>{text}</span> : null}
    </span>
}
