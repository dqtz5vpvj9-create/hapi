import { useCallback, useSyncExternalStore } from 'react'
import { useGlassSurface } from '@/themes/glass/GlassScene'
import { loadNewTaskDraft, saveNewTaskDraft, subscribeNewTaskDraft } from '@/lib/new-task-draft'
import { useTranslation } from '@/lib/use-translation'

export function NewTaskInput(props: { hub?: string | null; onContinue: () => void }) {
    const { t } = useTranslation()
    const text = useSyncExternalStore(
        useCallback(listener => subscribeNewTaskDraft(props.hub, listener), [props.hub]),
        useCallback(() => loadNewTaskDraft(props.hub), [props.hub])
    )
    const glass = useGlassSurface<HTMLFormElement>()
    const proceed = () => props.onContinue()
    return <form ref={glass} className="app-glass app-new-task-input" onSubmit={event => { event.preventDefault(); proceed() }}>
        <button type="button" onClick={proceed} aria-label={t('sessions.task.options')} title={t('sessions.task.options')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <input value={text} onChange={event => { saveNewTaskDraft(props.hub, event.target.value) }}
            onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }}
            placeholder={t('sessions.task.placeholder')} aria-label={t('sessions.task.label')} />
        <button className="app-new-task-next" type="submit" aria-label={t('sessions.task.continue')} title={t('sessions.task.continue')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
        </button>
    </form>
}
