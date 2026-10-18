import { forwardRef, useMemo, type ComponentPropsWithoutRef } from 'react'
import { ComposerPrimitive, useAui, useAuiState } from '@assistant-ui/react'
import { NativeAttachmentButton } from '@/components/NativeAttachmentButton'
import { isNativePlatform } from '@/lib/platform'

type ComposerAttachmentPickerProps = ComponentPropsWithoutRef<'button'>

const NativeComposerAttachmentPicker = forwardRef<HTMLButtonElement, ComposerAttachmentPickerProps>((props, ref) => {
    const aui = useAui()
    const runtimeDisabled = useAuiState(state => state.thread.isDisabled || !state.composer.isEditing)
    const scope = useMemo(() => ({}), [aui.composer, aui.optional.threadListItem])
    return <NativeAttachmentButton {...props} ref={ref} selectionScope={scope}
        disabled={props.disabled || runtimeDisabled}
        onFiles={async (files, isCurrent) => {
            for (const file of files) {
                if (!isCurrent()) return
                await aui.composer().addAttachment(file)
            }
        }} />
})
NativeComposerAttachmentPicker.displayName = 'NativeComposerAttachmentPicker'

export const ComposerAttachmentPicker = forwardRef<HTMLButtonElement, ComposerAttachmentPickerProps>((props, ref) =>
    isNativePlatform()
        ? <NativeComposerAttachmentPicker {...props} ref={ref} />
        : <ComposerPrimitive.AddAttachment {...props} ref={ref} />,
)
ComposerAttachmentPicker.displayName = 'ComposerAttachmentPicker'
