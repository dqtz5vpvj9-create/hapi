package app.hapi.protocol.wire

import kotlinx.serialization.Serializable

/** Runtime facts from the owning native transport, ordered independently of SSE. */
@Serializable
data class NativeRuntimeState(
    val owner: String,
    val generation: String,
    val sequence: Long,
    val status: String,
    val waitingOn: List<String>,
    val turnId: String?,
    val startedAt: Long?,
    val completedAt: Long?,
) {
    init {
        require(sequence >= 0)
        require(status in setOf("active", "idle", "notLoaded", "systemError", "disconnected"))
        require(waitingOn.all { it == "approval" || it == "input" })
    }
}
