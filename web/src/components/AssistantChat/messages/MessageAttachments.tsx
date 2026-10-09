import { ArtifactCard } from '@/components/Artifacts/ArtifactCard'
import type { AttachmentMetadata } from '@/types/api'
import { isImageMimeType } from '@/lib/fileAttachments'
import { useTranslation } from '@/lib/use-translation'
import { ImagePreview } from '@/components/ImagePreview'

function ImageAttachment(props: { attachment: AttachmentMetadata }) {
    const { attachment } = props
    const { t } = useTranslation()
    return (
        <ImagePreview
            frame="attachment"
            loadingLabel={t('artifact.loading')} errorLabel={t('artifact.imageError')}
            src={attachment.previewUrl ?? ''}
            fileName={attachment.filename}
            label={attachment.filename}
            buttonClassName="relative overflow-hidden rounded-lg text-left cursor-zoom-in"
            imageClassName="max-h-48 max-w-full object-contain"
            caption={(
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-2 py-1.5">
                    <span className="text-xs text-white/90 line-clamp-1">
                        {attachment.filename}
                    </span>
                </div>
            )}
        />
    )
}

function FileAttachment(props: { attachment: AttachmentMetadata }) {
    const { attachment } = props
    return <ArtifactCard artifact={attachment.artifact ?? { id: attachment.id, fileName: attachment.filename, mimeType: attachment.mimeType, size: attachment.size }} previewUrl={attachment.previewUrl} />
}

export function MessageAttachments(props: { attachments: AttachmentMetadata[] }) {
    const { attachments } = props
    if (!attachments || attachments.length === 0) return null

    const images = attachments.filter(a => isImageMimeType(a.mimeType) && a.previewUrl)
    const files = attachments.filter(a => !isImageMimeType(a.mimeType) || !a.previewUrl)

    return (
        <div className="mt-2 flex flex-col gap-2">
            {images.length > 0 && (
                <div
                    className="hapi-share-media-grid flex flex-wrap gap-2"
                    data-hapi-image-count={images.length}
                >
                    {images.map(attachment => (
                        <ImageAttachment key={attachment.id} attachment={attachment} />
                    ))}
                </div>
            )}
            {files.length > 0 && (
                <div className="flex flex-col gap-1.5">
                    {files.map(attachment => (
                        <FileAttachment key={attachment.id} attachment={attachment} />
                    ))}
                </div>
            )}
        </div>
    )
}
