import Foundation

struct ActivityResult: Hashable, Sendable {
    var content: JSONValue?
    var isError: Bool
}

struct ActivityTool: Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var input: JSONValue?
    var status: Tool.Status
    var result: ActivityResult?
    /// A result whose tool call is missing from the loaded history.
    var resultOnly: Bool = false

    init(id: String, name: String, input: JSONValue?, status: Tool.Status, result: ActivityResult? = nil, resultOnly: Bool = false) {
        self.id = id
        self.name = name
        self.input = input
        self.status = status
        self.result = result
        self.resultOnly = resultOnly
    }

    init(_ tool: Tool) {
        self.init(id: tool.id, name: tool.name, input: tool.input, status: tool.status)
    }
}

struct UsageEntry: Hashable, Sendable {
    var messageId: String
    var usage: Usage
}

struct ConversationMessageItem: Identifiable, Hashable, Sendable {
    var key: String
    var message: Message

    var id: String { key }
}

struct ConversationActivityItem: Identifiable, Hashable, Sendable {
    var key: String
    var tools: [ActivityTool]
    var usageEntries: [UsageEntry] = []

    var id: String { key }
}

enum ConversationItem: Identifiable, Hashable, Sendable {
    case message(ConversationMessageItem)
    case activity(ConversationActivityItem)

    var id: String {
        switch self {
        case .message(let item): return item.key
        case .activity(let item): return item.key
        }
    }
}

func activitySummary(_ tools: [ActivityTool]) -> String {
    var order: [String] = []
    var counts: [String: Int] = [:]
    for tool in tools {
        if counts[tool.name] == nil { order.append(tool.name) }
        counts[tool.name, default: 0] += 1
    }
    return order.map { name in
        let count = counts[name] ?? 0
        switch name {
        case "Read": return "Read \(count) \(count == 1 ? "file" : "files")"
        case "Write": return "Wrote \(count) \(count == 1 ? "file" : "files")"
        case "Edit": return "Edited \(count) \(count == 1 ? "file" : "files")"
        case "Bash": return "Ran \(count) \(count == 1 ? "command" : "commands")"
        default: return "\(name) \(count)"
        }
    }.joined(separator: " · ")
}

private func displayMessage(_ message: Message, content: String, status: Message.Status?) -> Message {
    var copy = message
    copy.content = content
    copy.status = status
    if var history = message.history {
        history.blocks = content.isEmpty ? [] : [.text(content)]
        copy.history = history
    } else {
        copy.history = nil
    }
    copy.tools = nil
    copy.usage = nil
    return copy
}

/// Flattens native history and live messages into display-order conversation items.
/// Adjacent tool calls/results are one activity item, even when the result arrives in the
/// following native message. Text is always an ordering boundary.
func buildConversationItems(_ messages: [Message]) -> [ConversationItem] {
    enum DisplayOwner {
        case none
        case message(Int)
        case activity
    }

    var items: [ConversationItem] = []
    var pending: ConversationActivityItem?
    var owner = DisplayOwner.none
    var sequence = 0

    func flushActivity() {
        if let group = pending {
            items.append(.activity(group))
            pending = nil
        }
    }

    func addMessage(_ message: Message, _ content: String, _ status: Message.Status? = nil) {
        flushActivity()
        let item = ConversationMessageItem(
            key: "\(message.id):message:\(sequence)",
            message: displayMessage(message, content: content, status: status)
        )
        sequence += 1
        items.append(.message(item))
        owner = .message(items.count - 1)
    }

    func currentActivity(_ message: Message) {
        if pending == nil {
            pending = ConversationActivityItem(key: "\(message.id):activity:\(sequence)", tools: [])
            sequence += 1
        }
        owner = .activity
    }

    func addTool(_ message: Message, _ tool: ActivityTool) {
        currentActivity(message)
        pending?.tools.append(tool)
    }

    func addResult(_ message: Message, _ toolUseId: String, _ content: JSONValue?, _ isError: Bool) {
        currentActivity(message)
        guard var group = pending else { return }
        let match = group.tools.lastIndex { $0.id == toolUseId && $0.result == nil && !$0.resultOnly }
        if let index = match {
            group.tools[index].result = ActivityResult(content: content, isError: isError)
            group.tools[index].status = .complete
        } else {
            group.tools.append(ActivityTool(
                id: toolUseId,
                name: "Tool result",
                input: nil,
                status: .complete,
                result: ActivityResult(content: content, isError: isError),
                resultOnly: true
            ))
        }
        pending = group
    }

    for message in messages {
        owner = .none
        if let blocks = message.history?.blocks, !blocks.isEmpty {
            for block in blocks {
                switch block {
                case .text(let text):
                    addMessage(message, text)
                case .tool(let id, let name, let input, let status):
                    addTool(message, ActivityTool(id: id, name: name, input: input, status: status))
                case .toolResult(let toolUseId, let content, let isError):
                    addResult(message, toolUseId, content, isError ?? false)
                }
            }
        } else {
            // Live tools are deliberately displayed before streamed content, matching the
            // order in which the existing UI exposes them.
            for tool in message.tools ?? [] { addTool(message, ActivityTool(tool)) }
            if !message.content.isEmpty {
                addMessage(message, message.content, message.status == .streaming ? .streaming : nil)
            }
        }

        if message.status == .error || message.status == .interrupted {
            addMessage(message, "", message.status)
        } else if message.history == nil && message.content.isEmpty && (message.tools?.isEmpty ?? true) {
            addMessage(message, "", message.status)
        }

        if message.role == .assistant, let usage = message.usage {
            switch owner {
            case .message(let index):
                if case .message(var item) = items[index] {
                    item.message.usage = usage
                    items[index] = .message(item)
                }
            case .activity:
                pending?.usageEntries.append(UsageEntry(messageId: message.id, usage: usage))
            case .none:
                break
            }
        }
    }

    flushActivity()
    return items
}
