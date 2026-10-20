import type { QoderPermissionMode } from '@hapi/protocol/modes'

/** HAPI permission ids for Qoder CN; the launcher translates them to ACP mode ids. */
export type PermissionMode = QoderPermissionMode

/**
 * Qoder CN is remote-only and reads its configuration from the session, not
 * from the queued message, so the queue only needs one mode tag.
 */
export type QoderMode = 'qoder'
