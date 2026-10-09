import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { RunnerSetupHint } from './RunnerSetupHint'
it('offers runner setup without launching an agent or exposing a credential', () => {
    render(<I18nProvider><RunnerSetupHint /></I18nProvider>)
    expect(screen.getByText('hapi auth login')).toBeInTheDocument()
    expect(screen.getByText('hapi runner start')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
})
