import { useTranslation } from '@/lib/use-translation'
import { panes, type WorkspaceStore } from './workspaceStore'

/** Shared by the chat menu and the terminal/empty-pane menu. */
export function WorkspacePaneActions(props: { id: string; store: WorkspaceStore; onPick: () => void; onClose: () => void; onMoveNew: (id: string) => void }) {
    const { t } = useTranslation()
    const run = (action: () => void) => { props.store.focus(props.id); props.onClose(); action() }
    const split = (axis: 'horizontal' | 'vertical') => run(() => { props.store.split(axis); props.onPick() })
    const temporary = props.store.get().workspaces.some(w => props.store.isTemporary(w.id) && panes(w.root).some(p => p.id === props.id))
    return <div className="workspace-pane-actions" role="group" aria-label={t('workspace.paneActions')}>
        <button type="button" role="menuitem" onClick={() => run(props.onPick)}>{t('workspace.choose')}</button>
        <button type="button" role="menuitem" onClick={() => split('horizontal')}>{t('workspace.splitRight')}</button>
        <button type="button" role="menuitem" onClick={() => split('vertical')}>{t('workspace.splitBelow')}</button>
        <button type="button" role="menuitem" onClick={() => run(() => props.store.zoom())}>{t('workspace.zoom')}</button>
        {!temporary && props.store.get().workspaces.filter(w => !props.store.isTemporary(w.id) && !panes(w.root).some(p => p.id === props.id)).map(w =>
            <button type="button" role="menuitem" key={w.id} onClick={() => run(() => props.store.movePane(props.id, w.id))}>{t('workspace.moveTo')} {w.name}</button>)}
        {!temporary ? <button type="button" role="menuitem" onClick={() => run(() => props.onMoveNew(props.id))}>{t('workspace.moveNew')}</button> : null}
        <button type="button" role="menuitem" onClick={() => run(() => props.store.closePane(props.id))}>{t('workspace.closePane')}</button>
    </div>
}
