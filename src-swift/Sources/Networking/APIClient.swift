import Foundation

struct APIError: LocalizedError, Hashable, Sendable {
    var status: Int
    var message: String

    var errorDescription: String? { message }

    /// The backend uses 409 for every "not allowed right now" guard (running, read-only,
    /// unsynced history); the UI distinguishes those from hard failures.
    var isConflict: Bool { status == 409 }
}

final class APIClient: Sendable {
    let baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession? = nil) {
        self.baseURL = baseURL
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpShouldSetCookies = true
            configuration.httpCookieAcceptPolicy = .always
            configuration.timeoutIntervalForRequest = 30
            self.session = URLSession(configuration: configuration)
        }
    }

    // MARK: - State and status

    func state() async throws -> AppState {
        try await request("GET", "/api/state")
    }

    func health() async throws -> Health {
        try await request("GET", "/api/health")
    }

    // MARK: - Chats

    struct CreateChatBody: Encodable, Sendable {
        var title: String?
        var projectId: String?
        var model: String?
        var permissionMode: PermissionMode?
        var provider: String?
    }

    func createChat(_ body: CreateChatBody) async throws -> Chat {
        try await request("POST", "/api/chats", body: body)
    }

    struct UpdateChatBody: Encodable, Sendable {
        var title: String?
        var projectId: String?
        var model: String?
        var permissionMode: PermissionMode?
    }

    func updateChat(id: String, _ body: UpdateChatBody) async throws -> Chat {
        try await request("PATCH", "/api/chats/\(escape(id))", body: body)
    }

    func deleteChat(id: String) async throws {
        try await requestVoid("DELETE", "/api/chats/\(escape(id))")
    }

    struct SendMessageBody: Encodable, Sendable {
        var content: String
    }

    func sendMessage(chatId: String, content: String) async throws -> Chat {
        try await request("POST", "/api/chats/\(escape(chatId))/messages", body: SendMessageBody(content: content))
    }

    func stopChat(id: String) async throws -> Chat {
        try await request("POST", "/api/chats/\(escape(id))/stop", body: EmptyBody())
    }

    func syncChat(id: String) async throws -> Chat {
        try await request("POST", "/api/chats/\(escape(id))/sync", body: EmptyBody())
    }

    func loadChatHistory(id: String) async throws -> Chat {
        try await request("POST", "/api/chats/\(escape(id))/history", body: EmptyBody())
    }

    // MARK: - Projects and repositories

    struct CreateProjectBody: Encodable, Sendable {
        var name: String
        var path: String
    }

    func createProject(name: String, path: String) async throws -> Project {
        try await request("POST", "/api/projects", body: CreateProjectBody(name: name, path: path))
    }

    func repositories() async throws -> RepositoryInventory {
        try await request("GET", "/api/repositories")
    }

    struct RepositoryPreferencesBody: Encodable, Sendable {
        var favorites: [String]?
        var names: [String: String]?
        var threadSorts: [String: SerializedRepositoryPreferences.ThreadSort]?
        var seedIfEmpty: Bool?
    }

    func updateRepositoryPreferences(
        _ body: RepositoryPreferencesBody
    ) async throws -> SerializedRepositoryPreferences {
        try await request("POST", "/api/repository-preferences", body: body)
    }

    // MARK: - Native sessions

    private struct NativeSessionsResponse: Decodable, Sendable {
        var sessions: [NativeSession]
    }

    func nativeSessions() async throws -> [NativeSession] {
        let response: NativeSessionsResponse = try await request("GET", "/api/native-sessions")
        return response.sessions
    }

    func nativeSessionMessages(id: String, offset: Int, limit: Int) async throws -> HistoryPage {
        try await request(
            "GET",
            "/api/native-sessions/\(escape(id))/messages",
            query: [URLQueryItem(name: "offset", value: String(offset)), URLQueryItem(name: "limit", value: String(limit))]
        )
    }

    struct ImportNativeSessionBody: Encodable, Sendable {
        var model: String?
        var permissionMode: PermissionMode?
    }

    func importNativeSession(id: String, _ body: ImportNativeSessionBody) async throws -> Chat {
        try await request("POST", "/api/native-sessions/\(escape(id))/import", body: body)
    }

    struct RenameNativeSessionBody: Encodable, Sendable {
        var title: String
    }

    struct RenameNativeSessionResponse: Decodable, Sendable {
        var session: NativeSession
        var chat: Chat?
    }

    func renameNativeSession(id: String, title: String) async throws -> RenameNativeSessionResponse {
        try await request("PATCH", "/api/native-sessions/\(escape(id))", body: RenameNativeSessionBody(title: title))
    }

    // MARK: - Session naming

    struct SuggestNamesBody: Encodable, Sendable {
        var target: SessionNameTarget
        var summaryModel: String
    }

    func suggestSessionNames(target: SessionNameTarget, summaryModel: String) async throws -> SessionNameResult {
        try await request(
            "POST",
            "/api/session-names/suggest",
            body: SuggestNamesBody(target: target, summaryModel: summaryModel)
        )
    }

    struct AliasBody: Encodable, Sendable {
        var target: SessionNameTarget
        var title: String
        var expectedTitle: String
    }

    private struct AliasResponse: Decodable, Sendable {
        var title: String
    }

    func saveSessionAlias(target: SessionNameTarget, title: String, expectedTitle: String) async throws -> String {
        let response: AliasResponse = try await request(
            "POST",
            "/api/session-names/alias",
            body: AliasBody(target: target, title: title, expectedTitle: expectedTitle)
        )
        return response.title
    }

    // MARK: - Request plumbing

    struct EmptyBody: Encodable, Sendable {}

    func makeRequest(_ method: String, _ path: String, query: [URLQueryItem] = []) -> URLRequest {
        var components = URLComponents(
            url: baseURL.appendingPathComponent(path.hasPrefix("/") ? String(path.dropFirst()) : path),
            resolvingAgainstBaseURL: false
        )
        if !query.isEmpty { components?.queryItems = query }
        var request = URLRequest(url: components?.url ?? baseURL)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // No Origin header on purpose: the backend's approvedOrigin() unconditionally
        // allows requests that carry none, which sidesteps the CORS allowlist entirely.
        return request
    }

    private func request<Response: Decodable>(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = []
    ) async throws -> Response {
        try decode(try await perform(makeRequest(method, path, query: query)))
    }

    private func request<Body: Encodable, Response: Decodable>(
        _ method: String,
        _ path: String,
        body: Body
    ) async throws -> Response {
        try decode(try await perform(makeRequest(method, path, body: body)))
    }

    private func requestVoid(_ method: String, _ path: String) async throws {
        _ = try await perform(makeRequest(method, path, body: EmptyBody()))
    }

    private func makeRequest<Body: Encodable>(_ method: String, _ path: String, body: Body) -> URLRequest {
        var request = makeRequest(method, path)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? Self.encoder.encode(body)
        return request
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(status: 0, message: "Malformed response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError(status: http.statusCode, message: Self.errorMessage(from: data, status: http.statusCode))
        }
        return data
    }

    private func decode<Response: Decodable>(_ data: Data) throws -> Response {
        if Response.self == EmptyResponse.self, let empty = EmptyResponse() as? Response { return empty }
        do {
            return try Self.decoder.decode(Response.self, from: data)
        } catch {
            throw APIError(status: 0, message: "Could not read the backend response: \(error.localizedDescription)")
        }
    }

    struct EmptyResponse: Decodable, Sendable {}

    private static func errorMessage(from data: Data, status: Int) -> String {
        struct Envelope: Decodable { var error: String }
        if let envelope = try? decoder.decode(Envelope.self, from: data), !envelope.error.isEmpty {
            return envelope.error
        }
        return HTTPURLResponse.localizedString(forStatusCode: status)
    }

    private func escape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? component
    }

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        return decoder
    }()

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        return encoder
    }()
}
