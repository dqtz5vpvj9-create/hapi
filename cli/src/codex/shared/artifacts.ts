import { basename } from 'node:path';
import { artifactMimeFromFilename, CODEX_ARTIFACT_PREFIX, MAX_ARTIFACT_BYTES, type ArtifactRef, type ArtifactReadResponse, type ChatContentPart } from '@hapi/protocol/artifacts';
import { decodeGeneratedImageBase64, detectDisplayMediaMimeType, readBoundedRegularFile } from '@/modules/common/generatedImages';
import { readFileArtifact } from '@/modules/common/handlers/artifacts';
import { record, string } from './gateway';

type Locator = { threadId: string; turnId: string; itemId: string; index: number };
type Source = { kind: 'file'; path: string; trusted: boolean } | { kind: 'inline'; data: string } | { kind: 'remote'; url: string } | { kind: 'mcp'; server: string; uri: string; originCallId: string };
type Resource = { ref: ArtifactRef; source: Source };

/** Project descriptors, never read files or carry their bytes into hub messages. */
export function projectNativeContent(threadId: string, turnId: string, item: Record<string, unknown>): {
    parts: ChatContentPart[]; resources: Resource[];
} {
    const parts: ChatContentPart[] = [];
    const resources: Resource[] = [];
    const add = (source: Source, mimeType: string, fileName: string, label?: string) => {
        const locator: Locator = { threadId, turnId, itemId: String(item.id), index: resources.length };
        const ref: ArtifactRef = { id: CODEX_ARTIFACT_PREFIX + Buffer.from(JSON.stringify(locator)).toString('base64url'), fileName, mimeType, ...(label ? { label } : {}), ...(source.kind === 'remote' ? { externalUrl: source.url } : {}) };
        resources.push({ ref, source });
        parts.push({ type: 'artifact', artifact: ref });
    };
    const url = (value: string, mimeType: string, fileName: string) => {
        if (value.startsWith('data:')) add({ kind: 'inline', data: value }, mimeType, fileName);
        else if (/^https?:\/\//i.test(value)) add({ kind: 'remote', url: value }, mimeType, fileName);
        else parts.push({ type: 'unsupported', label: `${fileName}: unsupported resource address` });
    };
    const visit = (value: unknown, depth = 0): void => {
        if (depth > 8) { parts.push({ type: 'unsupported', label: 'Nested tool content cannot be previewed' }); return; }
        if (typeof value === 'string') {
            // Function tools sometimes wrap MCP content in a JSON string.
            if (value.trimStart().startsWith('{') || value.trimStart().startsWith('[')) {
                try { const parsed: unknown = JSON.parse(value); visit(parsed, depth + 1); return; } catch { /* ordinary text */ }
            }
            if (value) parts.push({ type: 'text', text: value });
            return;
        }
        if (Array.isArray(value)) { for (const part of value) visit(part, depth + 1); return; }
        const part = record(value);
        if ('Ok' in part || 'Err' in part) { visit(part.Ok ?? part.Err, depth + 1); return; }
        const type = part.type;
        if (['text', 'inputText', 'input_text', 'output_text'].includes(String(type))) {
            if (typeof part.text === 'string') parts.push({ type: 'text', text: part.text });
        } else if (type === 'mention' || type === 'skill') {
            parts.push({ type: 'text', text: type === 'skill' ? `$${part.name}` : `@"${part.path}"` });
        } else if (type === 'localImage' || type === 'localAudio') {
            const path = string(part.path);
            if (path) add({ kind: 'file', path, trusted: true }, artifactMimeFromFilename(path), basename(path));
        } else if (type === 'image' || type === 'audio' || type === 'inputImage' || type === 'inputAudio' || type === 'input_image' || type === 'input_audio') {
            const media = type === 'audio' || type === 'inputAudio' || type === 'input_audio' ? 'audio' : 'image';
            const mime = string(part.mimeType) ?? string(part.mime_type) ?? (media === 'audio' ? 'audio/wav' : 'image/png');
            const address = string(part.url) ?? string(part.imageUrl) ?? string(part.image_url) ?? string(part.audioUrl) ?? string(part.audio_url);
            const name = string(part.name) ?? `${media}-${resources.length + 1}`;
            if (typeof part.data === 'string') add({ kind: 'inline', data: `data:${mime};base64,${part.data}` }, mime, name);
            else if (address) url(address, mime, name);
            else parts.push({ type: 'unsupported', label: `${name}: resource bytes are not available` });
        } else if (type === 'resource') {
            const resource = record(part.resource);
            const mime = string(resource.mimeType) ?? 'text/plain';
            const name = string(resource.uri)?.split('/').at(-1) || 'resource';
            if (typeof resource.blob === 'string') add({ kind: 'inline', data: `data:${mime};base64,${resource.blob}` }, mime, name);
            else if (typeof resource.text === 'string') {
                add({ kind: 'inline', data: `data:${mime};base64,${Buffer.from(resource.text).toString('base64')}` }, mime, name);
            }
        } else if (type === 'resource_link') {
            const uri = string(part.uri);
            if (uri && item.type === 'mcpToolCall') add({ kind: 'mcp', server: String(item.server), uri, originCallId: String(item.id) }, string(part.mimeType) ?? 'application/octet-stream', string(part.name) ?? 'Resource');
            else parts.push({ type: 'resource-link', name: string(part.name) ?? 'Resource', uri: uri ?? '' });
        } else if (type === 'encrypted_content') {
            parts.push({ type: 'unsupported', label: 'Encrypted tool content' });
        } else if (typeof part.text === 'string') {
            parts.push({ type: 'text', text: part.text });
        } else if (Array.isArray(part.content) || Array.isArray(part.contentItems)) {
            visit(part.content ?? part.contentItems, depth + 1);
            if (part.structuredContent != null) parts.push({ type: 'text', text: JSON.stringify(part.structuredContent, null, 2) });
        } else if (part.image_url || part.imageUrl || part.audio_url || part.audioUrl) {
            visit({ ...part, type: part.audio_url || part.audioUrl ? 'input_audio' : 'input_image' }, depth + 1);
        } else if (value != null) {
            if (string(part.type)) parts.push({ type: 'unsupported', label: `Unsupported content: ${part.type}` });
            else parts.push({ type: 'text', text: JSON.stringify(value, null, 2) });
        }
    };
    if (item.type === 'userMessage') {
        visit(item.content);
        // HAPI supplies a leading @path list to the model. Keep those references
        // in native history, but show the actual attachments in the user bubble.
        const paths = Array.isArray(item.content) ? item.content.flatMap(part => record(part).type === 'localImage' || record(part).type === 'localAudio' ? [String(record(part).path)] : []) : [];
        const first = parts[0];
        if (first?.type === 'text') {
            let text = first.text;
            // Non-image uploads reach Codex as an explicit leading @path list.
            // Recognize that whole paragraph, never paths in ordinary prose.
            const paragraph = text.split('\n\n', 1)[0];
            const references = [...paragraph.matchAll(/@"([^"]+)"|@(\S+)/g)];
            if (references.length && paragraph.replace(/@"([^"]+)"|@(\S+)/g, '').trim() === '') {
                const referencedPaths = references.map(match => match[1] ?? match[2]);
                if (referencedPaths.every(path => path.startsWith('/') || /^[a-z]:[\\/]/i.test(path))) {
                    const represented = {
                        image: resources.filter(resource => resource.ref.mimeType.startsWith('image/')).length,
                        audio: resources.filter(resource => resource.ref.mimeType.startsWith('audio/')).length
                    };
                    for (const path of referencedPaths) {
                        const mime = artifactMimeFromFilename(path);
                        const category = mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : null;
                        if (paths.includes(path) || (category && represented[category] > 0)) {
                            if (category) represented[category]--;
                        } else add({ kind: 'file', path, trusted: false }, mime, basename(path));
                    }
                    text = text.slice(paragraph.length).trimStart();
                }
            }
            first.text = text;
            if (!text) parts.shift();
        }
    }
    else if (item.type === 'imageGeneration') {
        const path = string(item.savedPath) ?? string(item.saved_path);
        if (item.failure != null || item.status === 'failed') parts.push({ type: 'unsupported', label: string(record(item.failure).message) ?? 'Image generation failed' });
        else if (path) add({ kind: 'file', path, trusted: true }, artifactMimeFromFilename(path), basename(path), 'Generated image');
        else if (typeof item.result === 'string' && item.result) add({ kind: 'inline', data: item.result }, 'image/png', 'generated-image.png', 'Generated image');
        else parts.push({ type: 'unsupported', label: 'Generated image bytes are not available' });
    } else if (item.type === 'imageView') {
        const path = string(item.path);
        // Codex publishes imageView after its native image tool has read this
        // path. The browser can only request the recorded item, never a path.
        if (path) add({ kind: 'file', path, trusted: true }, artifactMimeFromFilename(path).startsWith('image/') ? artifactMimeFromFilename(path) : 'image/png', basename(path), 'Viewed image');
    } else if (item.type === 'mcpToolCall' && item.server === 'hapi' && ['display_image', 'display_video', 'display_media'].includes(String(item.tool)) && item.error == null && item.status === 'completed' && item.result != null && !('Err' in record(item.result)) && record(record(item.result).Ok ?? item.result).isError !== true) {
        const args = record(item.arguments);
        const path = string(args.path);
        if (path) add({ kind: 'file', path, trusted: true }, artifactMimeFromFilename(path), string(args.title) ?? basename(path));
    } else {
        visit(item.type === 'dynamicToolCall' ? item.contentItems : item.type === 'functionCallOutput' ? item.output : item.result);
        const ui = record(item.mcpAppUi);
        if (string(ui.resourceUri) && item.type === 'mcpToolCall') add({ kind: 'mcp', server: String(item.server), uri: String(ui.resourceUri), originCallId: String(item.id) }, 'text/html', 'App preview');
    }
    return { parts, resources };
}

export function nativeArtifactLocator(id: string): Locator | null {
    if (!id.startsWith(CODEX_ARTIFACT_PREFIX) || id.length > 4096) return null;
    try {
        const value = record(JSON.parse(Buffer.from(id.slice(CODEX_ARTIFACT_PREFIX.length), 'base64url').toString()));
        if (typeof value.threadId !== 'string' || typeof value.turnId !== 'string' || typeof value.itemId !== 'string' || !Number.isInteger(value.index) || Number(value.index) < 0) return null;
        return value as Locator;
    } catch { return null; }
}

export async function readNativeArtifact(id: string, workingDirectory: string,
    ownsThread: (threadId: string) => Promise<boolean>, request: (method: string, params: Record<string, unknown>) => Promise<unknown>, sessionId = ''): Promise<ArtifactReadResponse> {
    const locator = nativeArtifactLocator(id);
    if (!locator || !await ownsThread(locator.threadId)) return { success: false, code: 'denied', error: 'Resource does not belong to this conversation' };
    let cursor: string | undefined;
    let item: Record<string, unknown> | undefined;
    do {
        const page = record(await request('thread/items/list', { threadId: locator.threadId, turnId: locator.turnId, limit: 100, sortDirection: 'asc', ...(cursor ? { cursor } : {}) }));
        const entries = Array.isArray(page.data) ? page.data : [];
        item = entries.map(entry => record(record(entry).item)).find(candidate => candidate.id === locator.itemId);
        cursor = string(page.nextCursor);
    } while (!item && cursor);
    if (!item) return { success: false, code: 'missing', error: 'The original conversation item is no longer available' };
    const resource = projectNativeContent(locator.threadId, locator.turnId, item).resources[locator.index];
    if (!resource || resource.ref.id !== id) return { success: false, code: 'missing', error: 'Resource is no longer available' };
    const { source, ref } = resource;
    if (source.kind === 'remote') return { success: false, code: 'unsupported', error: 'Remote resources must be opened at their original address' };
    try {
        let bytes: Buffer;
        let mime = ref.mimeType;
        if (source.kind === 'file') {
            if (!source.trusted) return readFileArtifact({ path: source.path, sessionId, mimeType: ref.mimeType }, workingDirectory);
            bytes = await readBoundedRegularFile(source.path, MAX_ARTIFACT_BYTES);
            const detected = detectDisplayMediaMimeType(bytes);
            if (mime.startsWith('image/') && detected === 'application/octet-stream' && mime !== 'image/svg+xml') return { success: false, code: 'unsupported', error: 'Unsupported image content' };
            if (detected !== 'application/octet-stream') mime = detected;
        } else {
            let data: string;
            if (source.kind === 'mcp') {
                const response = record(await request('mcp/resource/read', { threadId: locator.threadId, server: source.server, uri: source.uri, originCallId: source.originCallId }));
                const contents = Array.isArray(response.contents) ? response.contents.map(record) : [];
                const content = contents.find(value => value.uri === source.uri) ?? contents[0];
                if (!content) return { success: false, code: 'missing', error: 'MCP resource has no readable content' };
                mime = string(content.mimeType) ?? mime;
                if (typeof content.text === 'string') {
                    if (Buffer.byteLength(content.text) > MAX_ARTIFACT_BYTES) return { success: false, code: 'too-large', error: 'Resource exceeds the 25 MiB preview limit' };
                    data = `data:${mime};base64,${Buffer.from(content.text).toString('base64')}`;
                } else data = `data:${mime};base64,${String(content.blob ?? '')}`;
            } else data = source.data;
            const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(data);
            if (match) mime = match[1];
            const decoded = decodeGeneratedImageBase64(match ? match[2] : data);
            if (!decoded) return { success: false, code: 'too-large', error: 'Resource exceeds the 25 MiB preview limit' };
            bytes = decoded;
            const detected = detectDisplayMediaMimeType(bytes);
            if (mime.startsWith('image/') && detected === 'application/octet-stream' && mime !== 'image/svg+xml') return { success: false, code: 'unsupported', error: 'Unsupported image content' };
            if (detected !== 'application/octet-stream') mime = detected;
        }
        return { success: true, content: bytes.toString('base64'), mimeType: mime, fileName: ref.fileName };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, code: message.includes('too large') ? 'too-large' : 'missing', error: message.includes('too large') ? 'Resource exceeds the 25 MiB preview limit' : source.kind === 'mcp' ? `MCP resource is unavailable: ${message}` : 'The original file is no longer available' };
    }
}
