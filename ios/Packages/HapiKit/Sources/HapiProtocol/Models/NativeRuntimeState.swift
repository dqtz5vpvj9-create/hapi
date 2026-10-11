import Foundation

/// Runtime facts reported by the thread's owning Codex transport.
public struct NativeRuntimeState: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable {
        case active, idle, notLoaded, systemError, disconnected
    }
    public enum WaitingOn: String, Codable, Sendable { case approval, input }
    public var owner: String
    public var generation: String
    public var sequence: Int
    public var status: Status
    public var waitingOn: [WaitingOn]
    public var turnId: String?
    public var startedAt: Int?
    public var completedAt: Int?
}
