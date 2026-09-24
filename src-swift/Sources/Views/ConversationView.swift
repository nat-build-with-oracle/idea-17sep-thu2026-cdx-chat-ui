import SwiftUI

struct ConversationView: View {
    @Environment(\.theme) private var theme
    @Bindable var store: AppStore

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 22) {
                        if let chat = store.activeChat {
                            ForEach(buildConversationItems(chat.messages)) { item in
                                switch item {
                                case .message(let messageItem):
                                    MessageRow(message: messageItem.message)
                                        .id(item.id)
                                case .activity(let activityItem):
                                    ActivityView(item: activityItem)
                                        .id(item.id)
                                }
                            }
                        } else {
                            emptyState
                        }
                    }
                    .frame(maxWidth: Metrics.conversationMaxWidth, alignment: .leading)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 34)
                    .padding(.bottom, 28)
                }
                .onChange(of: store.activeChat?.messages.last?.content) { _, _ in
                    guard store.followLatest, let last = store.activeChat?.messages.last else { return }
                    withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
            ComposerView(store: store)
                .padding(.bottom, 18)
                .frame(maxWidth: .infinity)
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("What's the move?")
                .font(theme.reader(.semibold, scale: 1.9))
                .foregroundStyle(theme.palette.ink)
            if let project = store.project(id: store.projectId) {
                Text(project.path)
                    .font(theme.ui())
                    .foregroundStyle(theme.palette.muted)
            }
        }
        .padding(.top, 40)
    }
}

struct MessageRow: View {
    @Environment(\.theme) private var theme
    let message: Message

    var body: some View {
        switch message.role {
        case .user:
            HStack {
                Spacer(minLength: 40)
                Text(message.content)
                    .font(theme.reader())
                    .foregroundStyle(theme.palette.ink)
                    .textSelection(.enabled)
                    .padding(.vertical, 12)
                    .padding(.horizontal, 20)
                    .background(theme.palette.raised, in: .rect(cornerRadius: Metrics.Radius.userBubble))
                    .frame(maxWidth: 760, alignment: .trailing)
            }
        case .assistant:
            VStack(alignment: .leading, spacing: 10) {
                if let error = message.error {
                    Banner(kind: .error, message: error)
                }
                MarkdownView(content: message.content)
                if message.status == .streaming {
                    StatusDot(tone: .accent, pulsing: true)
                }
                if let usage = message.usage {
                    UsageInfoView(usage: usage)
                }
            }
        }
    }
}

struct SessionInboxView: View {
    @Environment(\.theme) private var theme
    @Bindable var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Pick up a thread.")
                .font(theme.reader(.semibold, scale: 1.7))
                .foregroundStyle(theme.palette.ink)

            Picker("", selection: tabBinding) {
                ForEach(InboxTab.allCases, id: \.self) { tab in
                    Text(tab.rawValue.capitalized).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 320)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(sessions, id: \.self) { session in
                        sessionRow(session)
                    }
                }
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task { await store.refreshNativeSessions() }
    }

    private var tabBinding: Binding<InboxTab> {
        Binding(
            get: { store.route.tab },
            set: { store.route = .agents(tab: $0, search: store.route.search) }
        )
    }

    private var sessions: [NativeSession] {
        store.nativeSessions.filter { session in
            switch store.route.tab {
            case .agents: return session.kind == .interactive || session.kind == .background
            case .terminals: return session.existingTerminal != nil
            case .saved: return session.kind == .saved
            }
        }
    }

    private func sessionRow(_ session: NativeSession) -> some View {
        Button {
            guard let sessionId = session.sessionId else {
                store.error = "This process has not created a conversation yet. Refresh once it starts."
                return
            }
            store.route = .native(sessionId: sessionId, tab: store.route.tab, search: store.route.search)
        } label: {
            HStack(spacing: 12) {
                StatusDot(tone: session.pid == nil ? .disabled : .success)
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.name ?? session.sessionId ?? "Session")
                        .font(theme.ui(.semibold))
                        .foregroundStyle(theme.palette.ink)
                        .lineLimit(1)
                    Text(session.cwd)
                        .font(theme.ui(scale: 0.82))
                        .foregroundStyle(theme.palette.placeholder)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                Spacer()
                if let status = session.status {
                    Text(status)
                        .font(theme.ui(scale: 0.8))
                        .foregroundStyle(theme.palette.muted)
                }
            }
            .padding(14)
            .background(theme.palette.panel, in: .rect(cornerRadius: Metrics.Radius.nativeRow))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}
