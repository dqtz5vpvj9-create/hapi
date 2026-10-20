import { useId, useState, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { useTranslation } from '@/lib/use-translation'
import './model-effort-picker.css'

export type ModelEffortOption = { value: string | null; label: string; group?: string }
export type ModelEffortPickerProps = {
    models: ModelEffortOption[]
    model: string | null
    modelLabel?: string
    onModelChange: (value: string | null) => void
    efforts?: ModelEffortOption[]
    effort?: string | null
    onEffortChange?: (value: string | null) => void
    fast?: boolean
    onFastChange?: (fast: boolean) => void
    onClearFast?: () => void
    disabledHint?: string
    disabled?: boolean
    triggerDisabled?: boolean
    controlsDisabled?: boolean
    loading?: boolean
    error?: string | null
    notice?: string
    modelControls?: ReactNode
    effortControls?: ReactNode
}

/** Presentation only: capabilities and confirmed settings belong to the caller. */
export function ModelEffortPicker(props: ModelEffortPickerProps) {
    const { t } = useTranslation()
    const controlsDisabled = Boolean(props.disabled || props.controlsDisabled)
    const [open, setOpen] = useState(false)
    const [page, setPage] = useState<'effort' | 'model'>('effort')
    const sliderId = useId()
    const headingId = useId()
    const efforts = props.efforts ?? []
    const selectedIndex = efforts.findIndex(option => option.value === (props.effort ?? null))
    const selectedEffort = efforts[selectedIndex]
    const modelLabel = props.modelLabel ?? props.models.find(option => option.value === props.model)?.label ?? props.model ?? t('misc.model')
    const effortLabel = selectedEffort?.label ?? props.effort
    const invalidEffort = efforts.length > 0 && selectedIndex < 0
    const caption = [modelLabel, effortLabel].filter(Boolean).join(' · ')
    return <Popover.Root modal open={open} onOpenChange={next => { setOpen(next); if (next) setPage('effort') }}>
        <Popover.Trigger asChild>
            <button type="button" className="model-effort-capsule" aria-label={caption} title={caption} disabled={Boolean(props.disabled || props.triggerDisabled)}>
                {props.fast ? <span aria-label="Fast" className="model-effort-lightning">ϟ</span> : null}
                <span className="model-effort-caption">{caption}</span><span aria-hidden="true">⌄</span>
            </button>
        </Popover.Trigger>
        <Popover.Portal>
            <Popover.Content aria-labelledby={headingId} className="model-effort-popover" side="top" align="start" sideOffset={10} collisionPadding={12}
                onEscapeKeyDown={event => { if (event.isComposing || event.keyCode === 229) event.preventDefault() }}>
                <div className="model-effort-heading">
                    {page === 'model' ? <button type="button" className="model-effort-icon" aria-label={t('common.back')} onClick={() => setPage('effort')}>‹</button> : null}
                    <h2 id={headingId}>{page === 'model' ? t('misc.model') : t('misc.reasoningEffort')}</h2>
                    <Popover.Close className="model-effort-icon" aria-label={t('composer.modelPicker.close')}>×</Popover.Close>
                </div>
                {controlsDisabled && props.disabledHint ? <div role="status" className="model-effort-notice">{props.disabledHint}</div> : null}
                {props.loading ? <div role="status" className="model-effort-notice">{t('loading')}</div> : null}
                {props.error ? <div role="alert" className="model-effort-error">{props.error}</div> : null}
                {props.notice ? <div role="status" className="model-effort-notice">{props.notice}</div> : null}
                {page === 'model' ? <div className="model-effort-models">
                    {props.modelControls ?? props.models.map((option, index) => <div key={option.value ?? '__default'}>
                        {option.group && option.group !== props.models[index - 1]?.group ? <div className="model-effort-group">{option.group}</div> : null}
                        <button type="button" className="model-effort-model-row" aria-pressed={props.model === option.value}
                            disabled={controlsDisabled} onClick={() => { props.onModelChange(option.value); setPage('effort') }}>
                            <span>{option.label}</span>{props.model === option.value ? <span aria-hidden="true" className="model-effort-check">✓</span> : null}
                        </button>
                    </div>)}
                </div> : <>
                    <button type="button" className="model-effort-model-row model-effort-current" onClick={() => setPage('model')}>
                        <span>{modelLabel}</span><span aria-hidden="true">›</span>
                    </button>
                    {props.effortControls ?? (efforts.length > 0 && props.onEffortChange ? <div className="model-effort-slider">
                        <label htmlFor={sliderId}>{t('misc.reasoningEffort')}</label>
                        {invalidEffort && !props.error ? <div role="alert" className="model-effort-error">{t('composer.modelPicker.chooseEffort')}</div> : null}
                        <input id={sliderId} type="range" min={0} max={Math.max(0, efforts.length - 1)} step={1}
                            value={selectedIndex < 0 ? 0 : selectedIndex} disabled={controlsDisabled || efforts.length < 2}
                            aria-valuetext={selectedEffort?.label ?? t('composer.modelPicker.chooseEffort')}
                            onChange={event => props.onEffortChange?.(efforts[Number(event.target.value)].value)} />
                        <div className="model-effort-stops">
                            {efforts.map(option => <button type="button" key={option.value ?? '__default'}
                                disabled={controlsDisabled} aria-pressed={option.value === (props.effort ?? null)}
                                onClick={() => props.onEffortChange?.(option.value)}>{option.label}</button>)}
                        </div>
                    </div> : null)}
                    {props.onClearFast ? <button type="button" className="model-effort-model-row" disabled={controlsDisabled} onClick={props.onClearFast}>{t('newTask.clearFast')}</button> : null}
                    {props.onFastChange ? <div className="model-effort-fast">
                        <span>ϟ&nbsp; Fast</span><button type="button" role="switch" aria-label="Fast" aria-checked={Boolean(props.fast)}
                            disabled={controlsDisabled} onClick={() => props.onFastChange?.(!props.fast)}><span /></button>
                    </div> : null}
                </>}
            </Popover.Content>
        </Popover.Portal>
    </Popover.Root>
}
