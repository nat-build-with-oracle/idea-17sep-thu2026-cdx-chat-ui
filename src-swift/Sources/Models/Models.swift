import Foundation

struct Repository: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var path: String
    var modifiedAt: Double
}

struct RepositoryInventory: Codable, Hashable, Sendable {
    var root: String?
    var repositories: [Repository]
    var warning: String?
}

struct Project: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var path: String
    var canonicalPath: String?
    var createdAt: String
}

struct Tool: Codable, Hashable, Sendable, Identifiable {
    enum Status: String, Codable, Sendable { case running, complete }
    var id: String
    var name: String
    var input: JSONValue?
    var status: Status
}

struct Usage: Codable, Hashable, Sendable {
    enum Scope: String, Codable, Sendable { case allModels, mainAgent, apiMessage }
    var inputTokens: Int
    var outputTokens: Int
    var cacheReadInputTokens: Int?
    var cacheCreationInputTokens: Int?
    var costUsd: Double?
    var scope: Scope?
}

enum HistoryBlock: Codable, Hashable, Sendable {
    case text(String)
    case tool(id: String, name: String, input: JSONValue?, status: Tool.Status)
    case toolResult(toolUseId: String, content: JSONValue?, isError: Bool?)

    private enum CodingKeys: String, CodingKey {
        case type, text, id, name, input, status, toolUseId, content, isError
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "text":
            self = .text(try container.decode(String.self, forKey: .text))
        case "tool":
            self = .tool(
                id: try container.decode(String.self, forKey: .id),
                name: try container.decode(String.self, forKey: .name),
                input: try container.decodeIfPresent(JSONValue.self, forKey: .input),
                status: try container.decode(Tool.Status.self, forKey: .status)
            )
        case "toolResult":
            self = .toolResult(
                toolUseId: try container.decode(String.self, forKey: .toolUseId),
                content: try container.decodeIfPresent(JSONValue.self, forKey: .content),
                isError: try container.decodeIfPresent(Bool.self, forKey: .isError)
            )
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: container, debugDescription: "Unknown history block type \(other)"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let text):
            try container.encode("text", forKey: .type)
            try container.encode(text, forKey: .text)
        case .tool(let id, let name, let input, let status):
            try container.encode("tool", forKey: .type)
            try container.encode(id, forKey: .id)
            try container.encode(name, forKey: .name)
            try container.encodeIfPresent(input, forKey: .input)
            try container.encode(status, forKey: .status)
        case .toolResult(let toolUseId, let content, let isError):
            try container.encode("toolResult", forKey: .type)
            try container.encode(toolUseId, forKey: .toolUseId)
            try container.encodeIfPresent(content, forKey: .content)
            try container.encodeIfPresent(isError, forKey: .isError)
        }
    }
}

struct MessageHistory: Codable, Hashable, Sendable {
    var sourceUuid: String
    var parentToolUseId: String?
    var blocks: [HistoryBlock]
}

struct Message: Codable, Hashable, Sendable, Identifiable {
    enum Role: String, Codable, Sendable { case user, assistant }
    enum Status: String, Codable, Sendable { case streaming, complete, error, interrupted }

    var id: String
    var role: Role
    var content: String
    var createdAt: String
    var nativeSourceIds: [String]?
    var appOnly: Bool?
    var history: MessageHistory?
    var status: Status?
    var tools: [Tool]?
    var error: String?
    var usage: Usage?
}

enum PermissionMode: String, Codable, Sendable, CaseIterable {
    case bypassPermissions
    case `default`
}

struct ChatSync: Codable, Hashable, Sendable {
    enum Status: String, Codable, Sendable { case synced, error }
    var status: Status
    var checkedAt: String
    var sourceHash: String?
    var messageCount: Int?
    var error: String?
}

struct Chat: Codable, Hashable, Sendable, Identifiable {
    enum Status: String, Codable, Sendable { case idle, running }

    var id: String
    var title: String
    var projectId: String?
    var sessionId: String?
    var model: String
    var provider: String?
    var permissionMode: PermissionMode
    var createdAt: String
    var updatedAt: String
    var messages: [Message]
    var status: Status
    var sync: ChatSync?
    var nativeImported: Bool?
    var historyUnavailable: Bool?
    var historyTruncated: Bool?
    var historyNextOffset: Int?
}

struct SerializedRepositoryPreferences: Codable, Hashable, Sendable {
    enum ThreadSort: String, Codable, Sendable { case updated, name }
    var favorites: [String]?
    var names: [String: String]?
    var threadSorts: [String: ThreadSort]?
}

struct AppState: Codable, Hashable, Sendable {
    var projects: [Project]
    var chats: [Chat]
    var repositoryPreferences: SerializedRepositoryPreferences?

    static let empty = AppState(projects: [], chats: [], repositoryPreferences: nil)
}

struct Health: Codable, Hashable, Sendable {
    struct SessionNaming: Codable, Hashable, Sendable {
        var summaryModels: [String]
        var namingModel: String
    }
    var ok: Bool
    var allowAnyOrigin: Bool?
    var claudeAvailable: Bool
    var claudeVersion: String?
    var cwd: String
    var chatModels: [String]?
    var sessionNaming: SessionNaming?
}

struct SessionNameTarget: Codable, Hashable, Sendable {
    enum Kind: String, Codable, Sendable { case chat, native }
    var kind: Kind
    var id: String
}

struct SessionNameResult: Codable, Hashable, Sendable {
    var summary: String
    var suggestions: [String]
    var summaryModel: String
    var namingModel: String
    var truncated: Bool
    var messageCount: Int
}

struct NativeSession: Codable, Hashable, Sendable {
    enum Kind: String, Codable, Sendable { case saved, interactive, background }
    enum Action: String, Codable, Sendable { case openTerminal, resumeAfterExit, resume, unavailable }

    struct ExistingTerminal: Codable, Hashable, Sendable {
        var sessionName: String
        var target: String
        var paneId: String
        var attachCommand: String
    }

    var id: String?
    var sessionId: String?
    var cwd: String
    var canonicalPath: String?
    var kind: Kind
    var name: String?
    var pid: Int?
    var startedAt: Double?
    var updatedAt: Double?
    var state: String?
    var status: String?
    var waitingFor: String?
    var action: Action
    var terminalCommand: String?
    var existingTerminal: ExistingTerminal?
    var readOnlyReason: String?
}

struct HistoryPage: Codable, Hashable, Sendable {
    var messages: [Message]
    var nextOffset: Int?
}
