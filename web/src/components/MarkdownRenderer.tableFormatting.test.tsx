import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { MarkdownRenderer } from './MarkdownRenderer'
const content='| Project | Feature | Status |\n|---|---|---|\n| **[HAPI](https://github.com/tiann/hapi)** | Native sessions | **Supported** |'
describe('Markdown table inline formatting',()=>{
 afterEach(cleanup)
 for(const standalone of [false,true]) it(`renders table links and bold, standalone=${standalone}`,()=>{
  const {container}=render(<I18nProvider><MarkdownRenderer content={content} standalone={standalone}/></I18nProvider>)
  expect(container.querySelectorAll('td')).toHaveLength(3)
  expect(container.querySelector('td strong a')?.getAttribute('href')).toBe('https://github.com/tiann/hapi')
  expect(container.querySelectorAll('td strong')).toHaveLength(2)
  expect(container.textContent).not.toContain('**[')
  expect(container.querySelector('.aui-md-table-wrapper')?.className).toContain('overflow-x-auto')
 })
})
