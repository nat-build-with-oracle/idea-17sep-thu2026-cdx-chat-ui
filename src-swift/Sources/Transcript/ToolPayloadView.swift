import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

extension Theme {
    /// CSS sizes these off `calc(var(--reader-size) - Npx)`, not off a scale factor.
    func transcriptFont(minus points: CGFloat, weight: Font.Weight = .regular) -> Font {
        .custom(Theme.fontName, size: readingSize.reader - points).weight(weight)
    }

    func transcriptMono(minus points: CGFloat) -> Font {
        mono(size: readingSize.reader - points)
    }
}

struct ToolPayloadView: View {
    let label: String
    let value: FormattedToolValue
    var error: Bool = false

    @Environment(\.theme) private var theme
    @State private var raw = false
    @State private var copied = CopyState.idle
    @State private var copyResetTask: Task<Void, Never>?

    private enum CopyState {
        case idle, copied, failed
    }

    private var content: String { raw ? value.raw : value.content }
    private var shell: Bool { !raw && value.language == .shell }

    private var lineCount: Int {
        content.isEmpty ? 0 : content.components(separatedBy: "\n").count
    }

    private var meta: String {
        if raw { return "raw" }
        switch value.language {
        case .shell: return "shell"
        case .json: return "JSON"
        case .text: return "\(lineCount) \(lineCount == 1 ? "line" : "lines")"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            toolbar
            if content.isEmpty {
                Text("No output returned.")
                    .font(theme.transcriptFont(minus: 3))
                    .foregroundStyle(theme.palette.muted)
                    .padding(.horizontal, 15)
                    .padding(.top, 7)
                    .padding(.bottom, 14)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ScrollView {
                    text
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 15)
                        .padding(.top, 12)
                        .padding(.bottom, 16)
                }
                .frame(maxHeight: 300)
                .overlay(alignment: .top) {
                    Rectangle()
                        .fill(theme.palette.rule)
                        .frame(height: 1)
                }
            }
        }
        .background(shell ? theme.palette.raised : theme.palette.canvas)
        .clipShape(RoundedRectangle(cornerRadius: Metrics.Radius.toolPayload, style: .continuous))
        .padding(.top, 12)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(label) panel")
    }

    private var toolbar: some View {
        HStack(spacing: 12) {
            HStack(spacing: 7) {
                Image(systemName: shell ? "terminal" : "doc")
                    .font(.system(size: 14))
                Text(label)
                    .fontWeight(.semibold)
                Text(meta)
                    .foregroundStyle(theme.palette.muted)
                    .fontWeight(.regular)
            }
            .foregroundStyle(error ? theme.palette.error : theme.palette.ink)
            .lineLimit(1)

            Spacer(minLength: 0)

            HStack(spacing: 4) {
                if value.hasRaw {
                    PayloadButton(active: raw) {
                        raw.toggle()
                    } label: {
                        Text("Raw")
                    }
                    .accessibilityLabel("Show raw \(label.lowercased())")
                }
                PayloadButton(active: false) {
                    copy()
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: copied == .copied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 13))
                        Text(copied == .copied ? "Copied" : copied == .failed ? "Copy failed" : "Copy")
                    }
                }
                .accessibilityLabel("Copy \(label.lowercased())")
            }
        }
        .font(theme.transcriptFont(minus: 5))
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(minHeight: 40)
    }

    @ViewBuilder
    private var text: some View {
        if shell {
            Text(highlighted)
                .font(theme.transcriptMono(minus: 3))
                .lineSpacing((theme.readingSize.reader - 3) * 0.65)
        } else {
            Text(content)
                .font(theme.transcriptMono(minus: 3))
                .foregroundStyle(theme.palette.ink)
                .lineSpacing((theme.readingSize.reader - 3) * 0.65)
        }
    }

    private var highlighted: AttributedString {
        var result = AttributedString()
        for token in ToolFormat.highlightShell(content) {
            var run = AttributedString(token.text)
            switch token.type {
            case .plain:
                run.foregroundColor = theme.palette.ink
            case .string:
                run.foregroundColor = theme.palette.success
            case .variable:
                run.foregroundColor = theme.palette.link
            case .operator:
                run.foregroundColor = theme.palette.accent
                run.font = theme.transcriptMono(minus: 3).weight(.semibold)
            case .comment:
                run.foregroundColor = theme.palette.muted
                run.font = theme.transcriptMono(minus: 3).italic()
            }
            result += run
        }
        return result
    }

    private func copy() {
        var succeeded = false
        #if canImport(AppKit)
        NSPasteboard.general.clearContents()
        succeeded = NSPasteboard.general.setString(content, forType: .string)
        #endif
        copied = succeeded ? .copied : .failed
        copyResetTask?.cancel()
        copyResetTask = Task {
            try? await Task.sleep(for: .milliseconds(1800))
            guard !Task.isCancelled else { return }
            copied = .idle
        }
    }
}

private struct PayloadButton<Label: View>: View {
    let active: Bool
    let action: () -> Void
    @ViewBuilder let label: Label

    @Environment(\.theme) private var theme
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            label
                .lineLimit(1)
                .padding(.horizontal, 7)
                .padding(.vertical, 4)
                .frame(minHeight: 30)
                .foregroundStyle(active || hovering ? theme.palette.accent : theme.palette.muted)
                .background(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(active || hovering ? theme.palette.raised : .clear)
                )
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}
