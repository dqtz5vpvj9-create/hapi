import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Machine } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { MachineIdentityIcon, MachineIdentityProvider } from './MachineIdentityIcon'

beforeEach(() => localStorage.clear())
afterEach(cleanup)

it('keeps the Hub identity on every row, across remount and while the machine is offline', () => {
    const machines = {
        linux: { id: 'linux', metadata: { icon: '🌲' } } as Machine,
        windows: { id: 'windows', metadata: { icon: '🍊' } } as Machine,
    }
    const labels = { linux: 'CHRIS', windows: 'Lis-iMac' }
    const list = (online: Record<string, Machine>) => <I18nProvider>
        <MachineIdentityProvider machines={online} labels={labels}>
            <MachineIdentityIcon machineId="linux" />
            <MachineIdentityIcon machineId="windows" />
            <MachineIdentityIcon machineId="linux" />
        </MachineIdentityProvider>
    </I18nProvider>
    const view = render(list(machines))
    expect(screen.getAllByRole('img', { name: 'CHRIS' }).map(node => node.textContent)).toEqual(['🌲', '🌲'])
    expect(screen.getByRole('img', { name: 'Lis-iMac' })).toHaveTextContent('🍊')
    view.unmount()
    render(list({}))
    expect(screen.getAllByRole('img', { name: 'CHRIS' }).map(node => node.textContent)).toEqual(['🌲', '🌲'])
    expect(screen.getByRole('img', { name: 'Lis-iMac' })).toHaveTextContent('🍊')
})
