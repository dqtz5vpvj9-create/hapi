import type { ComponentType } from 'react'
import { getExternalStoreMessages, useAuiState } from '@assistant-ui/react'

/** Adjacent assistant blocks share a presentation container whose first ID can
 * change on prepend. The source part ID remains stable across that regrouping. */
export function withReadingPart<P extends object>(Component: ComponentType<P>): ComponentType<P> {
    return function ReadingPart(props: P) {
        const id = useAuiState(({ part }) => getExternalStoreMessages<{ id?: string }>(part)[0]?.id)
        return <div id={id ? `hapi-reading-${id}` : undefined} data-hapi-reading-part>
            <Component {...props} />
        </div>
    }
}
