import { ChatContentPartSchema, type ChatContentPart } from '@hapi/protocol/artifacts'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { ArtifactCard } from './ArtifactCard'

export function parseContentParts(raw: unknown): ChatContentPart[] | undefined {
    if (!Array.isArray(raw)) return undefined
    const parts = raw.flatMap(value => {
        const parsed = ChatContentPartSchema.safeParse(value)
        return parsed.success ? [parsed.data] : []
    })
    return parts.length ? parts : undefined
}

export function ContentParts({ parts }: { parts: ChatContentPart[] }) {
    return <div className="min-w-0 space-y-2">{parts.map((part, index) => {
        if (part.type === 'text') return <MarkdownRenderer key={index} content={part.text} standalone />
        if (part.type === 'artifact') return <ArtifactCard key={part.artifact.id} artifact={part.artifact} />
        if (part.type === 'resource-link') return <div key={index} className="rounded-lg border border-[var(--app-border)] p-3 text-sm">
            {/^https?:\/\//i.test(part.uri) ? <a href={part.uri} target="_blank" rel="noreferrer">{part.name}</a> : <span>{part.name}</span>}
            <div className="break-all text-xs text-[var(--app-hint)]">{part.uri}</div>
        </div>
        return <div key={index} className="rounded-lg border border-[var(--app-border)] p-3 text-sm text-[var(--app-hint)]">{part.label}</div>
    })}</div>
}

export function richToolParts(result: unknown): ChatContentPart[] | undefined {
    const content = result && typeof result === 'object' && 'content' in result ? result.content : result
    const parts = parseContentParts(content)
    return parts?.some(part => part.type !== 'text') ? parts : undefined
}

export function toolArtifactCount(result: unknown): number {
    return richToolParts(result)?.filter(part => part.type === 'artifact' || part.type === 'resource-link').length ?? 0
}
