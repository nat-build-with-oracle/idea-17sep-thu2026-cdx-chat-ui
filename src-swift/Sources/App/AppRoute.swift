import Foundation

enum InboxTab: String, CaseIterable, Codable, Sendable {
    case agents, terminals, saved
}

/// Mirrors src/routes.ts. The web build keeps these in the URL hash; the app keeps them in
/// memory, but the same parse/serialize pair is retained so deep links keep working.
enum AppRoute: Hashable, Sendable {
    case new(projectId: String?)
    case chat(chatId: String)
    case agents(tab: InboxTab, search: String)
    case native(sessionId: String, tab: InboxTab, search: String)

    static let searchLimit = 500
    static let identifierLimit = 200

    /// `new` collapses into `chat` for layout decisions, exactly as App.tsx does.
    var isConversation: Bool {
        switch self {
        case .new, .chat: return true
        case .agents, .native: return false
        }
    }

    var chatId: String? {
        if case .chat(let id) = self { return id }
        return nil
    }

    var tab: InboxTab {
        switch self {
        case .agents(let tab, _), .native(_, let tab, _): return tab
        case .new, .chat: return .agents
        }
    }

    var search: String {
        switch self {
        case .agents(_, let search), .native(_, _, let search): return search
        case .new, .chat: return ""
        }
    }

    static func validIdentifier(_ value: String, allowingSlash: Bool = false) -> String? {
        guard !value.isEmpty, value.count <= identifierLimit else { return nil }
        guard !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        guard allowingSlash || !value.contains("/") else { return nil }
        return value
    }

    static func parse(hash: String) -> AppRoute {
        var path = hash
        if path.hasPrefix("#") { path.removeFirst() }
        if path.hasPrefix("/") { path.removeFirst() }
        guard !path.isEmpty else { return .new(projectId: nil) }

        let parts = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let segments = parts[0].split(separator: "/").map(String.init)
        let query = parts.count > 1 ? parseQuery(String(parts[1])) : [:]
        let tab = InboxTab(rawValue: query["tab"] ?? "") ?? .agents
        let search = String((query["q"] ?? "").prefix(searchLimit))

        switch segments.first {
        case "chats":
            guard segments.count > 1, let id = validIdentifier(decode(segments[1])) else { return .new(projectId: nil) }
            return .chat(chatId: id)
        case "sessions":
            guard segments.count > 1 else { return .agents(tab: tab, search: search) }
            guard let id = validIdentifier(decode(segments[1])) else { return .agents(tab: tab, search: search) }
            return .native(sessionId: id, tab: tab, search: search)
        case "new":
            let projectId = query["project"].flatMap { validIdentifier($0, allowingSlash: true) }
            return .new(projectId: projectId)
        default:
            return .new(projectId: nil)
        }
    }

    var hash: String {
        switch self {
        case .new(let projectId):
            guard let projectId, !projectId.isEmpty else { return "#/new" }
            return "#/new?project=\(encode(projectId))"
        case .chat(let chatId):
            return "#/chats/\(encode(chatId))"
        case .agents(let tab, let search):
            return "#/sessions" + queryString(tab: tab, search: search)
        case .native(let sessionId, let tab, let search):
            return "#/sessions/\(encode(sessionId))" + queryString(tab: tab, search: search)
        }
    }

    private func queryString(tab: InboxTab, search: String) -> String {
        var items: [String] = []
        if tab != .agents { items.append("tab=\(tab.rawValue)") }
        if !search.isEmpty { items.append("q=\(encode(search))") }
        return items.isEmpty ? "" : "?" + items.joined(separator: "&")
    }

    private func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private static func decode(_ value: String) -> String {
        value.removingPercentEncoding ?? value
    }

    private static func parseQuery(_ query: String) -> [String: String] {
        var result: [String: String] = [:]
        for pair in query.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let name = parts.first.map(String.init) else { continue }
            let value = parts.count > 1 ? String(parts[1]) : ""
            result[name] = value.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? value
        }
        return result
    }
}
