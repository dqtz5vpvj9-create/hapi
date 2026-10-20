import { classifySessionActivity } from '@hapi/protocol'
import type { SessionSummary } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import type { WindowActivityKind } from './windowIdentity'

type Activity = Pick<SessionSummary, 'active' | 'thinking' | 'pendingRequestKinds' | 'backgroundTaskCount' | 'execution' | 'blockingRequestKinds'>

/** Use the same authoritative state as the session list; never infer liveness from output. */
export function WorkspaceActivity({ session, kind: aggregate, label = false }: { session?: Activity; kind?: WindowActivityKind; label?: boolean }) {
    const { t } = useTranslation()
    const { kind } = aggregate ? { kind: aggregate } : classifySessionActivity(session)
    const text = t(kind === 'offline' ? 'misc.offline' : kind === 'idle' ? 'misc.online'
        : kind === 'error' ? 'session.item.error' : kind === 'input' ? 'session.item.needsInput'
        : kind === 'permission' ? 'misc.permissionRequired' : kind === 'running' && session?.execution?.compacting ? 'session.item.compacting' : 'session.item.running')
    return <span className="workspace-activity" data-state={kind} title={text} aria-label={text}>
        <span className="workspace-activity-dot" aria-hidden="true" />
        {label ? <span>{text}</span> : null}
    </span>
}
