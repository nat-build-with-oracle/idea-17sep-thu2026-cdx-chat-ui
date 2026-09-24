import AppKit
import SwiftUI

/// Port of src/tmux-command.ts.
enum TmuxCommand {
    static let maxNameLength = 96

    static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    static func asciiSlug(_ value: String) -> String {
        let folded = value.folding(options: [.diacriticInsensitive], locale: .init(identifier: "en_US_POSIX")).lowercased()
        var slug = ""
        var pendingDash = false
        for character in folded {
            if character.isASCII, character.isLetter || character.isNumber {
                if pendingDash, !slug.isEmpty { slug.append("-") }
                pendingDash = false
                slug.append(character)
            } else {
                pendingDash = true
            }
        }
        return slug
    }

    static func basename(_ value: String?) -> String {
        guard var value, !value.isEmpty else { return "" }
        while value.hasSuffix("/") || value.hasSuffix("\\") { value.removeLast() }
        return value.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
    }

    static func windowName(sessionId: String, title: String?) -> String {
        let fallback = asciiSlug(String(sessionId.prefix(8)))
        let label = asciiSlug(title ?? "").isEmpty ? (fallback.isEmpty ? "session" : fallback) : asciiSlug(title ?? "")
        return trimDashes(String(label.prefix(maxNameLength)))
    }

    static func sessionName(sessionId: String, cwd: String?, title: String?) -> String {
        let repository = asciiSlug(basename(cwd)).isEmpty ? "claude" : asciiSlug(basename(cwd))
        let combined = "\(repository)-\(windowName(sessionId: sessionId, title: title))"
        return trimDashes(String(combined.prefix(maxNameLength)))
    }

    static func resumeCommand(sessionId: String, cwd: String?, title: String?, dangerous: Bool = false) -> String {
        let name = sessionName(sessionId: sessionId, cwd: cwd, title: title)
        let window = windowName(sessionId: sessionId, title: title)
        let claude = "claude --resume \(shellQuote(sessionId))" + (dangerous ? " --dangerously-skip-permissions" : "")
        let directory = cwd.map { " -c \(shellQuote($0))" } ?? ""
        return """
        tmux new-session -d -s \(shellQuote(name)) -n \(shellQuote(window))\(directory) \(shellQuote(claude)) &&
        tmux set-option -t \(shellQuote(name)) status-left-length 100 &&
        maw a \(shellQuote(name))
        """
    }

    static func plainResume(sessionId: String, dangerous: Bool = false) -> String {
        "claude --resume \(shellQuote(sessionId))" + (dangerous ? " --dangerously-skip-permissions" : "")
    }

    static func oneShot(sessionId: String, dangerous: Bool = false) -> String {
        "claude --resume \(shellQuote(sessionId)) -p 'test'" + (dangerous ? " --dangerously-skip-permissions" : "")
    }

    private static func trimDashes(_ value: String) -> String {
        var result = value
        while result.hasSuffix("-") { result.removeLast() }
        return result
    }
}

/// Port of SessionCommand.tsx — the topbar CLI helper.
struct SessionCommandView: View {
    @Environment(\.theme) private var theme
    let chat: Chat
    let cwd: String?
    let readOnly: Bool
    var onCopy: (String) -> Void

    @State private var showAll = false

    var body: some View {
        if let sessionId = chat.sessionId {
            VStack(alignment: .leading, spacing: 8) {
                if readOnly {
                    Text("This conversation is read-only; resume it from a terminal instead.")
                        .font(theme.ui(scale: 0.82))
                        .foregroundStyle(theme.palette.muted)
                } else {
                    HStack(spacing: 8) {
                        Button {
                            copy(TmuxCommand.plainResume(sessionId: sessionId), toast: "Resume command copied")
                        } label: {
                            Text(TmuxCommand.plainResume(sessionId: sessionId))
                                .font(theme.mono(size: theme.readingSize.ui - 3))
                                .foregroundStyle(theme.palette.ink)
                                .lineLimit(1)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(theme.palette.raised, in: .rect(cornerRadius: 6))
                        }
                        .buttonStyle(.plain)
                        .help("Copy the resume command")

                        Button("Copy new tmux") {
                            copy(
                                TmuxCommand.resumeCommand(sessionId: sessionId, cwd: cwd, title: chat.title),
                                toast: "New tmux command copied · paste in your terminal"
                            )
                        }
                        .buttonStyle(SubtleButtonStyle())

                        Button("Copy -p test") {
                            copy(
                                TmuxCommand.oneShot(sessionId: sessionId),
                                toast: "One-shot test copied · running it adds a turn and uses Claude quota"
                            )
                        }
                        .buttonStyle(SubtleButtonStyle())
                    }
                }

                DisclosureGroup(isExpanded: $showAll) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Full-access variants skip every permission prompt. Only run them in a repository you trust.")
                            .font(theme.ui(scale: 0.82))
                            .foregroundStyle(theme.palette.muted)
                        commandCard("Resume", TmuxCommand.plainResume(sessionId: sessionId))
                        commandCard("New tmux", TmuxCommand.resumeCommand(sessionId: sessionId, cwd: cwd, title: chat.title))
                        commandCard("One-shot sync test", TmuxCommand.oneShot(sessionId: sessionId))
                        commandCard(
                            "Resume · full access",
                            TmuxCommand.plainResume(sessionId: sessionId, dangerous: true),
                            dangerous: true
                        )
                        commandCard(
                            "New tmux · full access",
                            TmuxCommand.resumeCommand(sessionId: sessionId, cwd: cwd, title: chat.title, dangerous: true),
                            dangerous: true
                        )
                        commandCard(
                            "One-shot test · full access",
                            TmuxCommand.oneShot(sessionId: sessionId, dangerous: true),
                            dangerous: true
                        )
                    }
                    .padding(.top, 8)
                } label: {
                    Text("Show all commands")
                        .font(theme.ui(.semibold, scale: 0.86))
                        .foregroundStyle(theme.palette.link)
                }
            }
        }
    }

    private func commandCard(_ title: String, _ command: String, dangerous: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title)
                    .font(theme.ui(.semibold, scale: 0.86))
                    .foregroundStyle(theme.palette.ink)
                Spacer()
                Button("Copy") { copy(command, toast: "\(title) copied") }
                    .buttonStyle(.plain)
                    .font(theme.ui(.semibold, scale: 0.82))
                    .foregroundStyle(theme.palette.link)
            }
            Text(command)
                .font(theme.mono(size: theme.readingSize.ui - 4))
                .foregroundStyle(theme.palette.muted)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(theme.palette.raised, in: .rect(cornerRadius: Metrics.Radius.toolPayload))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.Radius.toolPayload)
                .stroke(dangerous ? theme.palette.warning : .clear, lineWidth: 1)
        )
    }

    private func copy(_ value: String, toast: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
        onCopy(toast)
    }
}
