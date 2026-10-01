import { describe, expect, it } from 'vitest';
import { AppServerEventConverter } from './appServerEventConverter';

describe('Code Mode tool details', () => {
    it('preserves freeform code and multimodal output blocks and ignores duplicate starts', () => {
        const converter = new AppServerEventConverter();
        const input = 'text(await tools.exec_command({cmd:"pwd"}));';
        const params = { threadId: 'thread', turnId: 'turn', item: { type: 'custom_tool_call', name: 'exec', call_id: 'call', input } };
        expect(converter.handleNotification('rawResponseItem/completed', params)).toEqual([
            expect.objectContaining({ type: 'codex_tool_call_begin', name: 'exec', call_id: 'call', input })
        ]);
        expect(converter.handleNotification('rawResponseItem/completed', params)).toEqual([]);
        const output = [{ type: 'input_text', text: '/project' }, { type: 'image', image_url: 'test' }];
        expect(converter.handleNotification('rawResponseItem/completed', { ...params, item: { type: 'custom_tool_call_output', call_id: 'call', output } })).toEqual([
            expect.objectContaining({ type: 'codex_tool_call_end', output })
        ]);
    });
});
