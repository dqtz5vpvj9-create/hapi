/**
 * ACP agents (DSH, Gemini, Kimi, OpenCode, …) report lowercase, generic tool
 * names such as `bash`, `read`, `edit` and `write`. The web UI's tool views,
 * grouping rules and permission footers are keyed by the canonical Claude /
 * Codex names, so those calls fall back to the generic "tool card" and lose
 * command summaries, file previews and intent labels.
 *
 * Normalising the name when messages are read keeps recently stored and
 * already-persisted history consistent, while `nativeTitle` still preserves
 * the agent's original label for display.
 */
const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
    bash: 'Bash',
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    multiedit: 'MultiEdit',
    glob: 'Glob',
    grep: 'Grep',
    ls: 'LS',
    webfetch: 'WebFetch',
    websearch: 'WebSearch',
    todowrite: 'TodoWrite',
    notebookread: 'NotebookRead',
    notebookedit: 'NotebookEdit',
}

export function canonicalToolName(name: string): string {
    const trimmed = name.trim()
    if (trimmed === '') return name
    return TOOL_NAME_ALIASES[trimmed.toLowerCase()] ?? name
}
