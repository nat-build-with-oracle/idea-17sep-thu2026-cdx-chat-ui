import SwiftUI

struct SidebarView: View {
    @Environment(\.theme) private var theme
    @Bindable var store: AppStore

    @State private var repositorySearch = ""
    @State private var repositoryLimit = 20

    var body: some View {
        VStack(spacing: 0) {
            brandRow
            primaryNav
            Divider().overlay(theme.palette.rule)
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    repositoriesSection
                    recentsSection
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 16)
            }
            Divider().overlay(theme.palette.rule)
            BackendConnectionInfo(store: store)
        }
        .background(theme.palette.sidebar)
    }

    private var brandRow: some View {
        HStack(spacing: 10) {
            ClaudeMark(size: 22)
            Text("ARRA Claude Code")
                .font(theme.ui(.semibold, scale: 1.2))
                .foregroundStyle(theme.palette.ink)
            Spacer()
            IconButton(systemName: "magnifyingglass", help: "Search projects (⌘K)") {}
        }
        .padding(.horizontal, 16)
        .frame(height: Metrics.brandRowHeight)
    }

    private var primaryNav: some View {
        VStack(spacing: 4) {
            navRow(title: "New chat", icon: "square.and.pencil", selected: store.route.isConversation) {
                store.route = .new(projectId: store.projectId)
            }
            navRow(title: "Your chats", icon: "tray.full", selected: !store.route.isConversation) {
                store.route = .agents(tab: store.route.tab, search: "")
            }
            navRow(title: "Live Timeline", icon: "chart.bar.doc.horizontal", selected: false) {
                openTimeline()
            }
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 12)
    }

    private func navRow(title: String, icon: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .frame(width: 18)
                Text(title)
                    .font(theme.ui(selected ? .semibold : .regular))
                Spacer()
            }
            .foregroundStyle(selected ? theme.palette.accent : theme.palette.ink)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(selected ? theme.palette.raised : .clear, in: .rect(cornerRadius: Metrics.Radius.newChat))
        }
        .buttonStyle(.plain)
    }

    private var repositoriesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Repositories")
                    .font(theme.ui(.semibold))
                    .foregroundStyle(theme.palette.muted)
                Spacer()
                IconButton(systemName: "arrow.clockwise", help: "Refresh repositories") {
                    Task { await store.refreshRepositories() }
                }
            }
            if let root = store.repositoryInventory.root {
                Text(root)
                    .font(theme.ui(scale: 0.86))
                    .foregroundStyle(theme.palette.placeholder)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            TextField("Filter repositories", text: $repositorySearch)
                .textFieldStyle(.plain)
                .font(theme.ui())
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(theme.palette.raised, in: .rect(cornerRadius: Metrics.Radius.projectRow))

            ForEach(visibleRepositories) { repository in
                repositoryRow(repository)
            }

            if filteredRepositories.count > repositoryLimit {
                Button("Show more") { repositoryLimit += 20 }
                    .buttonStyle(.plain)
                    .font(theme.ui(.semibold))
                    .foregroundStyle(theme.palette.link)
            }
        }
    }

    private func repositoryRow(_ repository: Repository) -> some View {
        Button {
            store.projectId = nil
            store.route = .new(projectId: nil)
            Task { await openRepository(repository) }
        } label: {
            HStack(spacing: 10) {
                ProjectAvatar(name: repository.name, size: 28)
                VStack(alignment: .leading, spacing: 1) {
                    Text(store.state.repositoryPreferences?.names?[repository.path] ?? repository.name)
                        .font(theme.ui())
                        .foregroundStyle(theme.palette.ink)
                        .lineLimit(1)
                    Text(repository.path)
                        .font(theme.ui(scale: 0.8))
                        .foregroundStyle(theme.palette.placeholder)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                Spacer()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    private var recentsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Picked up here")
                .font(theme.ui(.semibold))
                .foregroundStyle(theme.palette.muted)
            if store.chats.isEmpty {
                Text("No conversations yet.")
                    .font(theme.ui())
                    .foregroundStyle(theme.palette.placeholder)
            }
            ForEach(store.chats) { chat in
                Button {
                    store.route = .chat(chatId: chat.id)
                } label: {
                    HStack(spacing: 8) {
                        if chat.status == .running {
                            StatusDot(tone: .accent, pulsing: true)
                        }
                        Text(chat.title)
                            .font(theme.ui(store.route.chatId == chat.id ? .semibold : .regular))
                            .foregroundStyle(store.route.chatId == chat.id ? theme.palette.accent : theme.palette.ink)
                            .lineLimit(1)
                        Spacer()
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(
                        store.route.chatId == chat.id ? theme.palette.raised : .clear,
                        in: .rect(cornerRadius: Metrics.Radius.chatRow)
                    )
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var filteredRepositories: [Repository] {
        let query = repositorySearch.trimmingCharacters(in: .whitespaces).lowercased()
        let hidden = store.preferences.hiddenRepositories
        return store.repositoryInventory.repositories.filter { repository in
            guard !hidden.contains(repository.path) else { return false }
            guard !query.isEmpty else { return true }
            return repository.name.lowercased().contains(query) || repository.path.lowercased().contains(query)
        }
    }

    private var visibleRepositories: [Repository] {
        Array(filteredRepositories.prefix(repositoryLimit))
    }

    private func openRepository(_ repository: Repository) async {
        do {
            let project = try await store.client.createProject(name: repository.name, path: repository.path)
            store.projectId = project.id
            store.route = .new(projectId: project.id)
        } catch {
            store.show(error: error)
        }
    }

    private func openTimeline() {
        var components = URLComponents(url: store.backend.url, resolvingAgainstBaseURL: false)
        components?.port = store.backend.isLoopback ? 47881 : 47882
        components?.queryItems = [URLQueryItem(name: "view", value: "timeline")]
        if let url = components?.url { NSWorkspace.shared.open(url) }
    }
}

struct BackendConnectionInfo: View {
    @Environment(\.theme) private var theme
    let store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                StatusDot(tone: store.connected ? .success : .warning, pulsing: !store.connected)
                Text(label)
                    .font(theme.ui(.semibold))
                    .foregroundStyle(theme.palette.ink)
                Spacer()
                IconButton(systemName: "gearshape", help: "Appearance") {}
            }
            Text(store.backend.origin)
                .font(theme.mono(size: theme.readingSize.ui - 3))
                .foregroundStyle(theme.palette.muted)
                .lineLimit(1)
            Text("Conversations stay on your chosen backend")
                .font(theme.ui(scale: 0.8))
                .foregroundStyle(theme.palette.placeholder)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var label: String {
        if !store.connected { return "Reconnecting…" }
        return store.backend.isLoopback ? "Local on this Mac" : "Backend connected"
    }
}
