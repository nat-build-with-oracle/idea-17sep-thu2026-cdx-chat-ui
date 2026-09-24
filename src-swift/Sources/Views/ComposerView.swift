import SwiftUI

struct ComposerView: View {
    @Environment(\.theme) private var theme
    @Bindable var store: AppStore

    @State private var draft = ""
    @FocusState private var focused: Bool

    private var isRunning: Bool { store.activeChat?.status == .running }

    var body: some View {
        VStack(spacing: 8) {
            HStack(alignment: .bottom, spacing: 10) {
                TextEditor(text: $draft)
                    .focused($focused)
                    .font(theme.reader())
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 24, maxHeight: 220)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 6)

                Button(action: submit) {
                    Image(systemName: isRunning ? "stop.fill" : "arrow.up")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(width: 40, height: 40)
                        .foregroundStyle(theme.palette.onAccent)
                        .background(sendEnabled ? theme.palette.accent : theme.palette.disabled, in: .circle)
                }
                .buttonStyle(.plain)
                .disabled(!sendEnabled)
                .keyboardShortcut(.return, modifiers: [])
            }
            .padding(12)
            .background(theme.palette.panel, in: .rect(cornerRadius: Metrics.Radius.composer))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.Radius.composer)
                    .stroke(theme.palette.rule, lineWidth: 1)
            )

            HStack(spacing: 12) {
                ModelPicker(store: store)
                Spacer()
                Text("Enter to send · Shift-Enter for a new line")
                    .font(theme.ui(scale: 0.8))
                    .foregroundStyle(theme.palette.placeholder)
            }
        }
        .frame(maxWidth: Metrics.composerMaxWidth)
        .padding(.top, 12)
        .onAppear { draft = store.preferences.draft(for: draftScope) }
        .onChange(of: draft) { _, value in store.preferences.setDraft(value, for: draftScope) }
        .onChange(of: store.route) { _, _ in draft = store.preferences.draft(for: draftScope) }
    }

    private var draftScope: String {
        switch store.route {
        case .chat(let id): return id
        case .new(let projectId): return "new:\(projectId ?? "")"
        case .agents, .native: return "new:"
        }
    }

    private var sendEnabled: Bool {
        if isRunning { return true }
        return !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !store.busy
    }

    private func submit() {
        if isRunning {
            guard let chatId = store.activeChat?.id else { return }
            Task { await store.stop(chatId: chatId) }
            return
        }
        let content = draft
        draft = ""
        store.preferences.setDraft("", for: draftScope)
        Task {
            await store.send(content)
            focused = true
        }
    }
}

struct ModelPicker: View {
    @Environment(\.theme) private var theme
    @Bindable var store: AppStore

    var body: some View {
        Picker("Model", selection: $store.model) {
            ForEach(store.health?.chatModels ?? ["sonnet", "opus", "haiku"], id: \.self) { model in
                Text(model.capitalized).tag(model)
            }
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .font(theme.ui())
        .frame(width: 130)
    }
}
