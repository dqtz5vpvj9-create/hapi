import { isDeepStrictEqual } from 'node:util'

type Json = Record<string, unknown>
const record = (value: unknown): Json => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
export type ResponsesReplayStep = {
    id: string
    prompt: string | (() => string)
    reply?: 'message' | 'question' | 'command' | 'plan'
    toolResult?: { from: string; check: (output: string) => boolean }
}

function readInput(body: Json) {
    if (!Array.isArray(body.input)) throw new Error('Responses replay requires an input array.')
    const items = body.input.map(record)
    let lastUser = -1
    items.forEach((item, index) => { if (item.role === 'user') lastUser = index })
    if (lastUser < 0) throw new Error('Responses replay requires a user message.')
    const user = items[lastUser]
    const prompt = typeof user.content === 'string' ? user.content : Array.isArray(user.content)
        ? user.content.map(record).filter(part => part.type === 'input_text').map(part => String(part.text ?? '')).join('\n') : ''
    return { user, prompt, outputs: items.slice(lastUser + 1).filter(item => item.type === 'function_call_output') }
}

function titleRequest(body: Json, prompt: string): boolean {
    // Codex runs an asynchronous, tool-free structured title request. This is
    // an explicit bounded auxiliary channel, never a wildcard reply for an
    // unknown agent turn. See upstream tui/src/app/thread_title.rs and
    // tui/src/temporary_structured_request.rs in openai/codex.
    const format = record(record(body.text).format), schema = record(format.schema)
    const properties = record(schema.properties)
    return Array.isArray(body.tools) && body.tools.length === 0
        && prompt.startsWith('Generate a concise, single-line task title')
        && format.type === 'json_schema' && schema.type === 'object'
        && schema.additionalProperties === false && isDeepStrictEqual(schema.required, ['title'])
        && isDeepStrictEqual(Object.keys(properties), ['title']) && record(properties.title).type === 'string'
}

function sse(id: string, item: Json): string {
    const events = [
        { type: 'response.created', response: { id } },
        { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
    ]
    return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

/** Test boundary only: replies are a finite script, not a second agent engine. */
export class ResponsesReplay {
    private cursor = 0
    private auxiliary = 0
    private readonly failures: string[] = []
    constructor(private readonly steps: readonly ResponsesReplayStep[], private readonly model = 'mock-model', private readonly maxTitles = 24) {
        if (new Set(steps.map(step => step.id)).size !== steps.length) throw new Error('Replay step IDs must be unique.')
    }
    fail(message: string): never {
        this.failures.push(message)
        throw new Error(message)
    }
    respond(body: Json): string {
        try {
            if (body.model !== this.model || body.stream !== true) throw new Error('Unexpected model or non-streaming Responses request.')
            const { user, prompt, outputs } = readInput(body)
            if (titleRequest(body, prompt)) {
                if (++this.auxiliary > this.maxTitles || outputs.length) throw new Error('Auxiliary title response budget exceeded or tool output appeared.')
                const id = `title_${this.auxiliary}`
                return sse(id, { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: '{"title":"Verify shared clients"}' }] })
            }
            const step = this.steps[this.cursor]
            if (!step) throw new Error(`Unexpected extra model request after ${this.steps.length} scripted responses.`)
            const expectedPrompt = typeof step.prompt === 'function' ? step.prompt() : step.prompt
            if (prompt !== expectedPrompt) throw new Error(`Replay ${step.id}: unexpected user prompt; expected ${JSON.stringify(expectedPrompt)}, received ${JSON.stringify(prompt)}.`)
            if (step.toolResult) {
                if (outputs.length !== 1 || outputs[0].call_id !== `call_${step.toolResult.from}`
                    || !step.toolResult.check(String(outputs[0].output ?? ''))) throw new Error(`Replay ${step.id}: missing, foreign or incorrect tool result.`)
            } else if (outputs.length) throw new Error(`Replay ${step.id}: unexpected tool result.`)
            const id = `response_${step.id}`
            const item: Json = step.reply === 'question' ? {
                type: 'function_call', call_id: `call_${step.id}`, name: 'request_user_input', arguments: JSON.stringify({
                    questions: [{ id: 'choice', header: 'Choice', question: 'Choose a shared client', options: [
                        { label: 'Terminal', description: 'Native answer' }, { label: 'Web', description: 'Web answer' },
                    ] }],
                }),
            } : step.reply === 'command' ? {
                type: 'function_call', call_id: `call_${step.id}`, name: 'exec_command', arguments: JSON.stringify({ cmd: 'printf "ROOT=%s\\n" "$HAPI_SESSION_ID"' }),
            } : {
                type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: step.reply === 'plan'
                    ? '<proposed_plan>\n# Shared test plan\n\n1. Inspect the source\n2. Implement and verify\n</proposed_plan>'
                    : `MOCK_DONE ${JSON.stringify(user)} ${JSON.stringify(outputs)}` }],
            }
            this.cursor++
            return sse(id, item)
        } catch (error) { return this.fail(error instanceof Error ? error.message : String(error)) }
    }
    assertConsumed(): void {
        const remaining = this.steps.slice(this.cursor).map(step => step.id)
        if (this.failures.length || remaining.length) {
            throw new Error(`Responses replay incomplete. Failures: ${JSON.stringify(this.failures)}. Unused steps: ${JSON.stringify(remaining)}.`)
        }
    }
    receipt() { return { consumed: this.cursor, expected: this.steps.length, auxiliaryTitles: this.auxiliary, failures: [...this.failures] } }
}
