import Foundation
import Observation

@MainActor
@Observable
final class AppStore {
    // MARK: - Connection

    private(set) var backend: BackendTarget
    private(set) var client: APIClient
    private(set) var state = AppState.empty
    private(set) var health: Health?
    private(set) var loaded = false
    private(set) var connected = false
    private(set) var connectionIssue: String?
    private(set) var connectionAttempt = 0

    // MARK: - Workspace

    var route: AppRoute = .new(projectId: nil)
    var model = "sonnet"
    var permission: PermissionMode = .bypassPermissions
    var projectId: String?
    var theme: Theme {
        didSet { preferences.appearance = theme }
    }
    var followLatest: Bool {
        didSet { preferences.followLatest = followLatest }
    }

    private(set) var repositoryInventory = RepositoryInventory(root: nil, repositories: [], warning: nil)
    private(set) var repositoriesLoading = false
    private(set) var nativeSessions: [NativeSession] = []
    private(set) var nativeListLoaded = false

    var error: String?
    var toast: String?
    var busy = false

    private(set) var preferences: Preferences
    private var eventTask: Task<Void, Never>?
    private var nativeRefreshTask: Task<Void, Never>?
    private var streamStateSeen = false
    private var toastTask: Task<Void, Never>?

    init(backend: BackendTarget = .default) {
        self.backend = backend
        self.client = APIClient(baseURL: backend.url)
        let preferences = Preferences(target: backend)
        self.preferences = preferences
        self.theme = preferences.appearance
        self.followLatest = preferences.followLatest
        self.projectId = preferences.projectId
    }

    // MARK: - Derived

    var chats: [Chat] { state.chats }
    var projects: [Project] { state.projects }

    var activeChat: Chat? {
        guard let id = route.chatId else { return nil }
        return state.chats.first { $0.id == id }
    }

    func project(id: String?) -> Project? {
        guard let id else { return nil }
        return state.projects.first { $0.id == id }
    }

    /// Mirrors src/claude-chat.ts: anything that is not a Claude chat on a known model is
    /// read-only, and every mutating affordance must be hidden for it.
    func isReadOnly(_ chat: Chat) -> Bool {
        let provider = chat.provider ?? "claude"
        guard provider == "claude" else { return true }
        return !["sonnet", "opus", "haiku"].contains(chat.model)
    }

    // MARK: - Lifecycle

    func connect(to target: BackendTarget? = nil) {
        if let target, target != backend {
            backend = target
            client = APIClient(baseURL: target.url)
            preferences = Preferences(target: target)
            Preferences.backendAddress = target.origin
            state = .empty
            loaded = false
        }
        connectionAttempt += 1
        connected = false
        connectionIssue = nil
        streamStateSeen = false

        eventTask?.cancel()
        let client = client
        let events = EventStreamClient(client: client)

        Task { [weak self] in
            do {
                let state = try await client.state()
                guard let self, !self.streamStateSeen else { return }
                self.apply(state)
            } catch {
                guard let self, !self.streamStateSeen else { return }
                self.connectionIssue = error.localizedDescription
            }
        }
        Task { [weak self] in
            let health = try? await client.health()
            if let health { self?.health = health }
        }

        eventTask = Task { [weak self] in
            for await event in events.events() {
                guard let self else { return }
                switch event {
                case .connected:
                    self.connected = true
                    self.connectionIssue = nil
                case .state(let state):
                    self.streamStateSeen = true
                    self.connected = true
                    self.apply(state)
                case .disconnected(let reason):
                    self.connected = false
                    if let reason { self.connectionIssue = reason }
                }
            }
        }

        startNativeRefresh()
        Task { await refreshRepositories() }
    }

    func disconnect() {
        eventTask?.cancel()
        nativeRefreshTask?.cancel()
        eventTask = nil
        nativeRefreshTask = nil
        connected = false
    }

    private func apply(_ next: AppState) {
        state = next
        loaded = true
        connectionIssue = nil
    }

    // MARK: - Native sessions

    /// Poll every 5 s, double the delay up to 30 s after a failure, and never overlap a
    /// refresh — same cadence as src/native-session-refresh.ts.
    private func startNativeRefresh() {
        nativeRefreshTask?.cancel()
        nativeRefreshTask = Task { [weak self] in
            var delay: Duration = .seconds(5)
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    let sessions = try await self.client.nativeSessions()
                    self.nativeSessions = sessions
                    self.nativeListLoaded = true
                    delay = .seconds(5)
                } catch {
                    delay = min(delay * 2, .seconds(30))
                }
                try? await Task.sleep(for: delay)
            }
        }
    }

    func refreshNativeSessions() async {
        do {
            nativeSessions = try await client.nativeSessions()
            nativeListLoaded = true
        } catch {
            show(error: error)
        }
    }

    func refreshRepositories() async {
        repositoriesLoading = true
        defer { repositoriesLoading = false }
        do {
            repositoryInventory = try await client.repositories()
        } catch {
            show(error: error)
        }
    }

    // MARK: - Actions

    func send(_ content: String) async {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let chat: Chat
            if let existing = activeChat {
                chat = existing
            } else {
                chat = try await client.createChat(
                    .init(title: nil, projectId: projectId, model: model, permissionMode: permission, provider: nil)
                )
                route = .chat(chatId: chat.id)
                preferences.selectedChatId = chat.id
            }
            let updated = try await client.sendMessage(chatId: chat.id, content: trimmed)
            merge(updated)
        } catch {
            show(error: error)
        }
    }

    func stop(chatId: String) async {
        do {
            merge(try await client.stopChat(id: chatId))
        } catch {
            show(error: error)
        }
    }

    func sync(chatId: String) async {
        do {
            merge(try await client.syncChat(id: chatId))
        } catch {
            show(error: error)
        }
    }

    func loadMoreHistory(chatId: String) async {
        do {
            merge(try await client.loadChatHistory(id: chatId))
        } catch {
            show(error: error)
        }
    }

    func deleteChat(id: String) async {
        do {
            try await client.deleteChat(id: id)
            state.chats.removeAll { $0.id == id }
            if route.chatId == id { route = .new(projectId: projectId) }
        } catch {
            show(error: error)
        }
    }

    func rename(chatId: String, title: String) async {
        do {
            merge(try await client.updateChat(id: chatId, .init(title: title)))
        } catch {
            show(error: error)
        }
    }

    /// The POST/PATCH responses carry a newer chat than the last SSE snapshot; splice it in
    /// rather than waiting for the next broadcast so the UI never flickers backwards.
    private func merge(_ chat: Chat) {
        if let index = state.chats.firstIndex(where: { $0.id == chat.id }) {
            state.chats[index] = chat
        } else {
            state.chats.insert(chat, at: 0)
        }
    }

    // MARK: - Notices

    func show(error: Error) {
        self.error = error.localizedDescription
    }

    func show(toast message: String) {
        toast = message
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(2600))
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
    }
}
