import Foundation

/// Execution snapshots carry a durable hub revision, independent of delivery stream.
public func stripStaleExecutionPatch(currentVersion: Int?, patch: SessionPatch) -> SessionPatch {
    let newer = patch.executionVersion.map { $0 > (currentVersion ?? 0) } ?? (currentVersion == nil)
    if newer { return patch }
    var next = patch
    next.active = nil
    next.thinking = nil
    next.activeAt = nil
    next.activeTurnStartedAt = nil
    next.execution = nil
    next.executionVersion = nil
    next.backgroundTaskCount = nil
    next.model = nil
    next.modelReasoningEffort = nil
    next.effort = nil
    next.serviceTier = nil
    next.permissionMode = nil
    next.collaborationMode = nil
    next.copilotAgentMode = nil
    return next
}

/// Version-monotonicity gate for structured patches carrying
/// metadata / agentState / todos / teamState.
///
/// SSE reconnects and the dual-connection model can replay an OLDER patch
/// after the cache already holds newer state; applying it would regress
/// resume / session-id / pending-request state. Strictly newer only —
/// the same version arriving twice must also be dropped.
public func isNewerVersionedPatch(patchVersion: Int, cachedVersion: Int) -> Bool {
    patchVersion > cachedVersion
}

/// True when applying `patch` to `session` would change nothing that renders.
///
/// Keep-alive patches re-send fields about every ~10 s in which typically
/// only `activeAt` moves. Relative-time labels only change at minute
/// boundaries, so a sub-minute `activeAt` delta is treated as invisible;
/// an `activeAt` move of ≥ 60 s stays render-relevant.
public func isRenderIrrelevantSessionPatch(session: Session, patch: SessionPatch) -> Bool {
    if let value = patch.executionVersion, value != session.executionVersion { return false }
    if let field = patch.execution, field.wireValue != session.execution { return false }
    if let value = patch.active, value != session.active { return false }
    if let value = patch.thinking, value != session.thinking { return false }
    if let field = patch.activeTurnStartedAt, field.wireValue != session.activeTurnStartedAt { return false }
    if let value = patch.activeAt {
        if abs(value - session.activeAt) < 60_000 {
            // Sub-minute keep-alive move: skipped, contributes nothing.
        } else if value != session.activeAt {
            return false
        }
    }
    if let value = patch.updatedAt, value != session.updatedAt { return false }
    // Versioned wrappers never equal the session's plain fields in the TS
    // reference (object identity), so their presence is always relevant.
    if patch.metadata != nil { return false }
    if patch.agentState != nil { return false }
    if patch.todos != nil { return false }
    if patch.teamState != nil { return false }
    if let field = patch.model, field.wireValue != session.model { return false }
    if let field = patch.modelReasoningEffort, field.wireValue != session.modelReasoningEffort { return false }
    if let field = patch.effort, field.wireValue != session.effort { return false }
    if let field = patch.serviceTier, field.wireValue != session.serviceTier { return false }
    if let value = patch.permissionMode, value != session.permissionMode { return false }
    if let value = patch.collaborationMode, value != session.collaborationMode { return false }
    if let value = patch.copilotAgentMode, value != session.copilotAgentMode { return false }
    if let value = patch.backgroundTaskCount, value != session.backgroundTaskCount { return false }
    // `Session` carries no scratchlistUpdatedAt, so its presence is always
    // "new information" in the TS reference (undefined !== number).
    if patch.scratchlistUpdatedAt != nil { return false }
    return true
}

/// Apply a validated `SessionPatch` onto a detail `Session`.
///
/// Returns `nil` when nothing render-relevant changed so callers can keep
/// the prior value (and object identity semantics of the reference client).
/// Field-by-field only — versioned `{version, value}` wrappers are unwrapped
/// under the strict `>` gate and never assigned wholesale.
public func applySessionDetailPatch(session: Session, patch: SessionPatch) -> Session? {
    let patch = stripStaleExecutionPatch(currentVersion: session.executionVersion, patch: patch)
    if isRenderIrrelevantSessionPatch(session: session, patch: patch) {
        return nil
    }
    var next = session
    var changed = false

    func assign<Value: Equatable>(_ keyPath: WritableKeyPath<Session, Value>, _ value: Value) {
        if next[keyPath: keyPath] != value {
            next[keyPath: keyPath] = value
            changed = true
        }
    }

    if let value = patch.executionVersion { assign(\.executionVersion, value) }
    if let field = patch.execution { assign(\.execution, field.wireValue) }
    if let field = patch.activeTurnStartedAt { assign(\.activeTurnStartedAt, field.wireValue) }
    if let value = patch.active { assign(\.active, value) }
    if let value = patch.thinking { assign(\.thinking, value) }
    if let value = patch.activeAt { assign(\.activeAt, value) }
    // Monotonic with the hub's applySessionPatch: a rejected stale
    // metadata/agentState replay must not rewind updatedAt.
    if let value = patch.updatedAt { assign(\.updatedAt, max(next.updatedAt, value)) }
    if let field = patch.model { assign(\.model, field.wireValue) }
    if let field = patch.modelReasoningEffort { assign(\.modelReasoningEffort, field.wireValue) }
    if let field = patch.effort { assign(\.effort, field.wireValue) }
    // TS uses hasOwnProperty + `?? null` here; PatchField already encodes
    // presence, so explicit-null clears exactly like the reference.
    if let field = patch.serviceTier { assign(\.serviceTier, field.wireValue) }
    if let value = patch.permissionMode { assign(\.permissionMode, value as PermissionMode?) }
    if let value = patch.collaborationMode { assign(\.collaborationMode, value as CodexCollaborationMode?) }
    if let value = patch.copilotAgentMode { assign(\.copilotAgentMode, value as CopilotAgentMode?) }
    if let value = patch.backgroundTaskCount { assign(\.backgroundTaskCount, value as Int?) }

    // Version gates: dual SSE can deliver duplicates out of order. Only mark
    // changed when a strictly newer version lands.
    if let wrapper = patch.todos,
       isNewerVersionedPatch(patchVersion: wrapper.version, cachedVersion: next.todosUpdatedAt ?? 0) {
        next.todos = wrapper.value
        next.todosUpdatedAt = wrapper.version
        changed = true
    }
    if let wrapper = patch.teamState,
       isNewerVersionedPatch(patchVersion: wrapper.version, cachedVersion: next.teamStateUpdatedAt ?? 0) {
        // `nil` value = TeamDelete clear.
        next.teamState = wrapper.value
        next.teamStateUpdatedAt = wrapper.version
        changed = true
    }
    if let wrapper = patch.metadata,
       isNewerVersionedPatch(patchVersion: wrapper.version, cachedVersion: next.metadataVersion) {
        next.metadata = wrapper.value
        next.metadataVersion = wrapper.version
        changed = true
    }
    if let wrapper = patch.agentState,
       isNewerVersionedPatch(patchVersion: wrapper.version, cachedVersion: next.agentStateVersion) {
        next.agentState = wrapper.value
        next.agentStateVersion = wrapper.version
        changed = true
    }

    // scratchlistUpdatedAt remains a refetch trigger.

    return changed ? next : nil
}
