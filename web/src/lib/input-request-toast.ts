import type { I18nContextValue } from './i18n-context'

/** Hub-authored input-request title; question text stays in its original language. */
export function translateInputRequestTitle(title: string, t: I18nContextValue['t']): string | null {
    const match = title.trim().match(/^(.+) needs your input$/)
    if (!match) return null
    return t('toast.input.title', { agent: match[1] })
}

/** Classify the hub's canonical wire title before localization. */
export function incomingToastKind(title: string): 'ready' | undefined {
    return title.trim() === 'Ready for input' ? 'ready' : undefined
}
