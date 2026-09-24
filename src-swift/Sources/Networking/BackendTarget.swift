import Foundation

/// Native counterpart of src/backend-target.ts. The web build derives the backend from the
/// page URL; the app stores one instead, but keeps the same validation and the same
/// per-origin namespacing so drafts and selection do not leak between backends.
struct BackendTarget: Hashable, Sendable {
    static let `default` = BackendTarget(url: URL(string: "http://127.0.0.1:4318")!)

    var url: URL

    var origin: String {
        guard let scheme = url.scheme, let host = url.host else { return url.absoluteString }
        if let port = url.port { return "\(scheme)://\(host):\(port)" }
        return "\(scheme)://\(host)"
    }

    var isLoopback: Bool {
        guard let host = url.host?.lowercased() else { return false }
        return ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
    }

    static func parse(_ input: String) throws -> BackendTarget {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw BackendTargetError.empty
        }
        guard !trimmed.contains(where: { $0.isWhitespace || $0 == "\\" }) else {
            throw BackendTargetError.malformed
        }
        let candidate = trimmed.contains("://") ? trimmed : "http://\(trimmed)"
        guard let components = URLComponents(string: candidate),
              let scheme = components.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              let host = components.host, !host.isEmpty, !host.contains("*"),
              components.user == nil, components.password == nil,
              components.path.isEmpty || components.path == "/",
              components.query == nil, components.fragment == nil
        else {
            throw BackendTargetError.notAnOrigin
        }
        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        origin.port = components.port
        guard let url = origin.url else { throw BackendTargetError.notAnOrigin }
        return BackendTarget(url: url)
    }

    /// Mirrors workspaceStorageKey(): drafts and selection stay isolated per backend.
    func storageKey(_ key: String) -> String {
        isLoopback && url.port == 4318 ? "cc:\(key)" : "cc:backend:\(origin):\(key)"
    }
}

enum BackendTargetError: LocalizedError, Hashable, Sendable {
    case empty
    case malformed
    case notAnOrigin

    var errorDescription: String? {
        switch self {
        case .empty, .malformed:
            return "Use an address such as http://127.0.0.1:4318."
        case .notAnOrigin:
            return "Choose an HTTP(S) backend origin with an optional port. No paths, credentials, or query parameters."
        }
    }
}
