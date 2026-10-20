import { useEffect, useId, useState, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { ChevronUp } from './TaskIcons'

/** A visible launch setting that opens the existing form control. */
export function LaunchControl(props: {
    label: string
    value: string
    icon?: ReactNode
    className?: string
    disabled: boolean
    children: ReactNode
}) {
    const [open, setOpen] = useState(false)
    const labelId = useId()

    useEffect(() => {
        if (props.disabled) setOpen(false)
    }, [props.disabled])

    return (
        <div className={`new-task-field ${props.className ?? ''}`}>
            <span id={labelId} className="sr-only">{props.label}</span>
            <Popover.Root open={open} onOpenChange={setOpen}>
                <Popover.Trigger asChild>
                    <button type="button" className="new-task-pill" disabled={props.disabled}
                        aria-label={`${props.label}: ${props.value}`} title={props.value}>
                        {props.icon ? <span className="new-task-pill-icon" aria-hidden="true">{props.icon}</span> : null}
                        <span className="new-task-pill-value">{props.value}</span>
                        <span className="new-task-pill-chevron" aria-hidden="true"><ChevronUp size={12} /></span>
                    </button>
                </Popover.Trigger>
                <Popover.Portal>
                    <Popover.Content aria-labelledby={labelId} align="start" sideOffset={8} collisionPadding={12}
                        className="new-task-control-popover"
                        onEscapeKeyDown={event => {
                            if (event.isComposing || event.keyCode === 229) event.preventDefault()
                        }}>
                        {props.children}
                    </Popover.Content>
                </Popover.Portal>
            </Popover.Root>
        </div>
    )
}
