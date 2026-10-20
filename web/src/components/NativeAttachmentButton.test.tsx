import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { NativeAttachmentButton } from './NativeAttachmentButton'
afterEach(() => { cleanup(); localStorage.clear() })
it.each([['en', 'Add attachments', 'Photos', 'Files'], ['zh-CN', '添加附件', '照片', '文件']])('renders translated picker controls in %s', (locale, title, photos, files) => {
    localStorage.setItem('hapi-lang', locale)
    render(<I18nProvider><NativeAttachmentButton onFiles={vi.fn()}>Attach</NativeAttachmentButton></I18nProvider>)
    fireEvent.click(screen.getByText('Attach'))
    expect(screen.getByRole('dialog').textContent).toContain(title)
    expect(screen.getByRole('button', { name: photos })).toBeTruthy()
    expect(screen.getByRole('button', { name: files })).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).not.toContain('attachments.picker.')
})
