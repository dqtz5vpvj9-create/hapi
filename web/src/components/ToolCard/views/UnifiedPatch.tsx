import type { PatchFile } from '../patchPresentation'
import { patchHunkRows } from '../patchPresentation'
import { useCodeWrap } from '@/hooks/useCodeWrap'
import { WrapIcon } from '@/components/icons'
import { useTranslation } from '@/lib/use-translation'

/** The caller caps the rows; line numbers always refer to the served hunks. */
export function UnifiedPatch({ files, showWrapToggle = false }: { files: PatchFile[]; showWrapToggle?: boolean }) {
    const { t } = useTranslation()
    const { codeWrap, setCodeWrap } = useCodeWrap()
    return <div className="min-w-0 overflow-x-auto rounded-lg border border-[var(--app-border)]">
        {showWrapToggle ? <div className="flex justify-end border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-1">
            <button type="button" data-hapi-code-wrap-toggle="true" data-hapi-share-export-exclude="true"
                data-hapi-wrap-enable-label={t('code.wrap.enable')} data-hapi-wrap-disable-label={t('code.wrap.disable')}
                title={t(codeWrap ? 'code.wrap.disable' : 'code.wrap.enable')} aria-label={t(codeWrap ? 'code.wrap.disable' : 'code.wrap.enable')} aria-pressed={codeWrap}
                className="rounded-md p-1 text-[var(--app-hint)] hover:bg-[var(--app-code-copy-hover-bg)] hover:text-[var(--app-fg)]"
                onClick={event => { event.stopPropagation(); setCodeWrap(!codeWrap) }}>
                <WrapIcon className="h-3.5 w-3.5" />
            </button>
        </div> : null}
        {files.map((file, fileIndex) => <section key={fileIndex} data-patch-file={file.newPath ?? file.oldPath ?? ''}>
            {file.oldPath || file.newPath ? <div className="break-all border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 font-mono text-xs">
                {file.oldPath === file.newPath || !file.oldPath ? file.newPath : `${file.oldPath} → ${file.newPath ?? ''}`}
            </div> : null}
            {file.hunks.map((hunk, hunkIndex) => <div key={hunkIndex} data-patch-hunk={hunk.header}>
                <div className="whitespace-pre-wrap break-all bg-[var(--app-subtle-bg)] px-3 py-1 font-mono text-xs text-[var(--app-hint)]">{hunk.header}</div>
                <table className="w-full border-collapse font-mono text-xs leading-5" aria-label={hunk.header}>
                    <tbody>{patchHunkRows(hunk).map((row, rowIndex) => <tr key={rowIndex} data-patch-kind={row.kind}
                        className={row.kind === 'add' ? 'bg-[var(--app-diff-added-bg)]' : row.kind === 'del' ? 'bg-[var(--app-diff-removed-bg)]' : ''}>
                        <td className="w-12 select-none px-2 text-right align-top text-[var(--app-hint)]" data-old-line={row.old}>{row.old}</td>
                        <td className="w-12 select-none px-2 text-right align-top text-[var(--app-hint)]" data-new-line={row.new}>{row.new}</td>
                        <td className="w-4 select-none text-center align-top text-[var(--app-hint)]">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}</td>
                        <td className={codeWrap ? 'whitespace-pre-wrap break-all px-2 align-top' : 'whitespace-pre px-2 align-top'}>{row.text || '\u00a0'}</td>
                    </tr>)}</tbody>
                </table>
            </div>)}
        </section>)}
    </div>
}
