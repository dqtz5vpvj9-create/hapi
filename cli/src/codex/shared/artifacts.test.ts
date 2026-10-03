import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { projectNativeContent, readNativeArtifact } from './artifacts';
import { readFileArtifact } from '@/modules/common/handlers/artifacts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XcAAAAASUVORK5CYII=';
const projection = (item: Record<string, unknown>) => projectNativeContent('thread', 'turn', item);
const read = (id: string, item: Record<string, unknown>, directory = '/workspace') => readNativeArtifact(id, directory, async thread => thread === 'thread',
    async () => ({ data: [{ turnId: 'turn', item }], nextCursor: null }));

describe('native chat artifacts', () => {
    it('preserves mixed content in order without embedding bytes in descriptors', async () => {
        const item = { id: 'input', type: 'userMessage', content: [
            { type: 'text', text: 'Before' }, { type: 'image', url: `data:image/png;base64,${png}` },
            { type: 'text', text: 'After' }, { type: 'audio', url: 'data:audio/wav;base64,UklGRgAAAABXQVZF' }
        ] };
        const { parts, resources } = projection(item);
        expect(parts.map(part => part.type)).toEqual(['text', 'artifact', 'text', 'artifact']);
        expect(JSON.stringify(parts)).not.toContain(png);
        expect(await read(resources[0].ref.id, item)).toMatchObject({ success: true, content: png, mimeType: 'image/png' });
    });
    it('recovers generation content without savedPath after projection state is gone', async () => {
        const item = { id: 'generated', type: 'imageGeneration', status: 'completed', result: png };
        const id = projection(item).resources[0].ref.id;
        expect(await read(id, structuredClone(item))).toMatchObject({ success: true, content: png });
    });
    it('shows unavailable file-ID input and generation failure rather than dropping them', () => {
        expect(projection({ id: 'input', type: 'userMessage', content: [{ type: 'image', fileId: 'file-1' }] }).parts[0]).toMatchObject({ type: 'unsupported' });
        expect(projection({ id: 'failure', type: 'imageGeneration', failure: { message: 'Quota exceeded' } }).parts[0]).toEqual({ type: 'unsupported', label: 'Quota exceeded' });
    });
    it('keeps MCP and dynamic images in their tool results with structured text', () => {
        const mcp = projection({ id: 'tool', type: 'mcpToolCall', result: { content: [{ type: 'text', text: 'Caption' }, { type: 'image', mimeType: 'image/png', data: png }], structuredContent: { count: 1 } } });
        expect(mcp.parts.map(part => part.type)).toEqual(['text', 'artifact', 'text']);
        const dynamic = projection({ id: 'dynamic', type: 'dynamicToolCall', contentItems: [{ type: 'inputImage', imageUrl: `data:image/png;base64,${png}` }, { type: 'inputText', text: 'Caption' }] });
        expect(dynamic.parts.map(part => part.type)).toEqual(['artifact', 'text']);
    });
    it('restores function output arrays and JSON-wrapped MCP content', () => {
        const output = [{ type: 'input_image', image_url: `data:image/png;base64,${png}` }];
        expect(projection({ id: 'function', type: 'functionCallOutput', output }).resources).toHaveLength(1);
        expect(projection({ id: 'function', type: 'functionCallOutput', output: JSON.stringify({ content: [{ type: 'image', data: png }] }) }).resources).toHaveLength(1);
    });
    it('checks conversation ownership before reading any item', async () => {
        const request = vi.fn();
        const id = projection({ id: 'generated', type: 'imageGeneration', result: png }).resources[0].ref.id;
        expect(await readNativeArtifact(id, '/workspace', async () => false, request)).toMatchObject({ code: 'denied' });
        expect(request).not.toHaveBeenCalled();
        expect(await readNativeArtifact('codex-artifact:invalid', '/workspace', async () => true, request)).toMatchObject({ code: 'denied' });
    });
    it('reads MCP resources only from the original call and URI', async () => {
        const item = { id: 'mcp', type: 'mcpToolCall', server: 'reports', result: { content: [{ type: 'resource_link', name: 'Chart', uri: 'ui://chart', mimeType: 'text/html' }] } };
        const request = vi.fn(async (method: string) => method === 'thread/items/list' ? { data: [{ item }], nextCursor: null }
            : { contents: [{ uri: 'ui://chart', mimeType: 'text/html', text: '<button>Chart</button>' }] });
        const response = await readNativeArtifact(projection(item).resources[0].ref.id, '/workspace', async () => true, request);
        expect(response).toMatchObject({ success: true, mimeType: 'text/html' });
        expect(request).toHaveBeenLastCalledWith('mcp/resource/read', { threadId: 'thread', server: 'reports', uri: 'ui://chart', originCallId: 'mcp' });
    });
    it('retains explicit HTTP resources without fetching them through the agent', async () => {
        const item = { id: 'input', type: 'userMessage', content: [{ type: 'image', url: 'https://example.com/image.png' }] };
        const { resources } = projection(item);
        expect(resources[0].ref.externalUrl).toBe('https://example.com/image.png');
        expect(await read(resources[0].ref.id, item)).toMatchObject({ code: 'unsupported' });
    });
    it('removes only the generated leading image path references from bubble text', () => {
        const result = projection({ id: 'input', type: 'userMessage', content: [
            { type: 'text', text: '@/uploads/a.png\n\nCheck this; keep /other/path.txt.' }, { type: 'localImage', path: '/uploads/a.png' }
        ] });
        expect(result.parts[0]).toEqual({ type: 'text', text: 'Check this; keep /other/path.txt.' });
        expect(projection({ id: 'input', type: 'userMessage', content: [
            { type: 'text', text: '@/uploads/a.pngExtra is a different path' }, { type: 'localImage', path: '/uploads/a.png' }
        ] }).parts[0]).toEqual({ type: 'text', text: '@/uploads/a.pngExtra is a different path' });
    });
    it('restores explicit document attachment lists without interpreting prose paths', async () => {
        const item = { id: 'docs', type: 'userMessage', content: [{ type: 'text', text: '@/workspace/report.pdf @/workspace/results.csv\n\nCompare these files.' }] };
        const result = projection(item);
        expect(result.parts.map(part => part.type)).toEqual(['text', 'artifact', 'artifact']);
        expect(result.parts[0]).toEqual({ type: 'text', text: 'Compare these files.' });
        expect(result.resources.map(resource => resource.ref.mimeType)).toEqual(['application/pdf', 'text/csv']);
        expect(await read(result.resources[0].ref.id, item)).toMatchObject({ code: 'missing' });
        expect(projection({ id: 'plain', type: 'userMessage', content: [{ type: 'text', text: 'Read /workspace/report.pdf' }] }).resources).toHaveLength(0);
        const denied = { id: 'docs', type: 'userMessage', content: [{ type: 'text', text: '@/etc/passwd' }] };
        expect(await read(projection(denied).resources[0].ref.id, denied)).toMatchObject({ code: 'denied' });
    });
    it('does not duplicate path references when Codex has converted uploads into inline images', () => {
        const result = projection({ id: 'input', type: 'userMessage', content: [
            { type: 'text', text: '@/uploads/a.jpg @/uploads/b.jpg\n\nCompare these.' },
            { type: 'image', url: `data:image/png;base64,${png}` },
            { type: 'image', url: `data:image/png;base64,${png}` }
        ] });
        expect(result.resources).toHaveLength(2);
        expect(result.parts.map(part => part.type)).toEqual(['text', 'artifact', 'artifact']);
        expect(result.parts[0]).toEqual({ type: 'text', text: 'Compare these.' });
    });
    it('reads only recorded native image-view files and rejects non-image bytes', async () => {
        const directory = await mkdtemp('/mnt/cache/data-cache/hapi-artifact-view-test-');
        const file = join(directory, 'view.png');
        const item = { id: 'view', type: 'imageView', path: file };
        try {
            await writeFile(file, Buffer.from(png, 'base64'));
            expect(await read(projection(item).resources[0].ref.id, item)).toMatchObject({ success: true, content: png });
            await writeFile(file, 'This is not an image');
            expect(await read(projection(item).resources[0].ref.id, item)).toMatchObject({ code: 'unsupported' });
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
    it('does not authorize files from a failed HAPI display result', () => {
        const result = projection({ id: 'failed', type: 'mcpToolCall', server: 'hapi', tool: 'display_image', status: 'completed', arguments: { path: '/private/image.png' }, result: { content: [{ type: 'text', text: 'Denied' }], isError: true } });
        expect(result.resources).toHaveLength(0);
        expect(result.parts).toEqual([{ type: 'text', text: 'Denied' }]);
    });
    it('loads saved files afresh, keeps missing descriptors and enforces path boundaries', async () => {
        const directory = await mkdtemp('/mnt/cache/data-cache/hapi-artifact-test-');
        const file = join(directory, 'report.html');
        try {
            const item = { id: 'display', type: 'mcpToolCall', server: 'hapi', tool: 'display_media', status: 'completed', arguments: { path: file }, result: { content: [], isError: false } };
            await writeFile(file, '<p>First</p>');
            const id = projection(item).resources[0].ref.id;
            expect(Buffer.from((await read(id, item, directory)).content!, 'base64').toString()).toBe('<p>First</p>');
            await writeFile(file, '<p>Second</p>');
            expect(Buffer.from((await read(id, item, directory)).content!, 'base64').toString()).toBe('<p>Second</p>');
            expect(await readFileArtifact({ path: '/etc/passwd', sessionId: 'session' }, directory)).toMatchObject({ code: 'denied' });
            await symlink('/etc/passwd', join(directory, 'escape.txt'));
            expect(await readFileArtifact({ path: 'escape.txt', sessionId: 'session' }, directory)).toMatchObject({ code: 'denied' });
            await rm(file);
            expect(await read(id, item, directory)).toMatchObject({ code: 'missing' });
            expect(projection(item).resources).toHaveLength(1);
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
});
