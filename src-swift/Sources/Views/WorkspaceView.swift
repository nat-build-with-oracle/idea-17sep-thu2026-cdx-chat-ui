import SwiftUI

struct RootView: View {
    @State private var store = AppStore()

    var body: some View {
        Group {
            if store.loaded || store.connected {
                WorkspaceView(store: store)
            } else {
                ConnectView(store: store)
            }
        }
        .environment(\.theme, store.theme)
        .preferredColorScheme(store.theme.colorScheme)
        .task {
            if let saved = Preferences.backendAddress, let target = try? BackendTarget.parse(saved) {
                store.connect(to: target)
            } else {
                store.connect()
            }
        }
    }
}

struct WorkspaceView: View {
    @Environment(\.theme) private var theme
    @Bindable var store: AppStore

    var body: some View {
        HStack(spacing: 0) {
            SidebarView(store: store)
                .frame(width: sidebarWidth)
            Divider().overlay(theme.palette.rule)
            mainPane
        }
        .frame(minHeight: Metrics.workspaceMinHeight)
        .background(theme.palette.canvas)
        .overlay(alignment: .bottom) {
            if let toast = store.toast {
                Toast(message: toast)
            }
        }
    }

    private var sidebarWidth: CGFloat {
        min(max(Metrics.sidebarMin, 320), Metrics.sidebarMax)
    }

    private var mainPane: some View {
        VStack(spacing: 0) {
            TopbarView(store: store)
            if let error = store.error {
                Banner(kind: .error, message: error) { store.error = nil }
            }
            if store.health?.claudeAvailable == false {
                Banner(kind: .warning, message: "Claude Code is not available on the backend machine.")
            }
            if let warning = store.repositoryInventory.warning {
                Banner(kind: .warning, message: warning)
            }
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var content: some View {
        switch store.route {
        case .new, .chat:
            ConversationView(store: store)
        case .agents, .native:
            SessionInboxView(store: store)
        }
    }
}

struct TopbarView: View {
    @Environment(\.theme) private var theme
    @Bindable var store: AppStore

    var body: some View {
        HStack(spacing: 12) {
            if case .native = store.route {
                IconButton(systemName: "chevron.left", help: "Back to your chats") {
                    store.route = .agents(tab: store.route.tab, search: store.route.search)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(theme.ui(.semibold, scale: 1.1))
                    .foregroundStyle(theme.palette.ink)
                    .lineLimit(1)
                if let sessionId = store.activeChat?.sessionId {
                    Text(sessionId)
                        .font(theme.mono(size: theme.readingSize.ui - 4))
                        .foregroundStyle(theme.palette.placeholder)
                        .textSelection(.enabled)
                        .lineLimit(1)
                }
            }
            Spacer()
            AppearanceMenu(store: store)
        }
        .padding(.horizontal, 18)
        .frame(height: Metrics.topbarHeight)
        .background(theme.palette.panel)
        .overlay(alignment: .bottom) {
            Divider().overlay(theme.palette.rule)
        }
    }

    private var title: String {
        switch store.route {
        case .new: return "New chat"
        case .chat: return store.activeChat?.title ?? "Chat"
        case .agents: return "Your chats"
        case .native(let sessionId, _, _):
            return store.nativeSessions.first { $0.sessionId == sessionId }?.name ?? "Session"
        }
    }
}

struct AppearanceMenu: View {
    @Environment(\.theme) private var theme
    @Bindable var store: AppStore

    var body: some View {
        Menu {
            Picker("Theme", selection: themeBinding) {
                ForEach(ThemeName.allCases, id: \.self) { name in
                    Text(name.rawValue.capitalized).tag(name)
                }
            }
            Picker("Reading size", selection: sizeBinding) {
                ForEach(ReadingSize.allCases, id: \.self) { size in
                    Text(size.rawValue.capitalized).tag(size)
                }
            }
        } label: {
            Image(systemName: "textformat.size")
        }
        .menuStyle(.borderlessButton)
        .frame(width: 44)
    }

    private var themeBinding: Binding<ThemeName> {
        Binding(get: { store.theme.name }, set: { store.theme.name = $0 })
    }

    private var sizeBinding: Binding<ReadingSize> {
        Binding(get: { store.theme.readingSize }, set: { store.theme.readingSize = $0 })
    }
}
