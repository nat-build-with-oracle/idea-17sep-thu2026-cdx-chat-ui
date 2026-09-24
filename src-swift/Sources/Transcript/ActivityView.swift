import SwiftUI

struct ActivityView: View {
    let item: ConversationActivityItem

    @Environment(\.theme) private var theme
    @State private var expanded = false

    private var running: Bool { item.tools.contains { $0.status == .running } }
    private var errors: Int { item.tools.filter { $0.result?.isError == true }.count }

    private var recentDetail: String {
        guard running else { return "" }
        let recent = item.tools.last { $0.status == .running } ?? item.tools.last
        return recent.map(ActivityDetail.detail(for:)) ?? ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            summary
            if expanded {
                Rectangle()
                    .fill(theme.palette.rule)
                    .frame(height: 1)
                VStack(spacing: 0) {
                    ForEach(Array(item.tools.enumerated()), id: \.offset) { index, tool in
                        ActivityRowView(tool: tool)
                        if index < item.tools.count - 1 {
                            Rectangle()
                                .fill(theme.palette.rule)
                                .frame(height: 1)
                        }
                    }
                }
                .padding(.horizontal, 18)
                .padding(.bottom, 6)
            }
        }
        .background(theme.palette.panel)
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.Radius.activityGroup, style: .continuous)
                .strokeBorder(theme.palette.rule, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Metrics.Radius.activityGroup, style: .continuous))
        .padding(.top, 14)
        .padding(.bottom, 24)
    }

    private var summary: some View {
        Button {
            expanded.toggle()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: running ? "terminal" : errors > 0 ? "info.circle" : "checkmark")
                    .font(.system(size: 16))
                let summaryText = activitySummary(item.tools)
                Text(running ? "Working" : "Activity")
                    + Text(summaryText.isEmpty ? "" : " · \(summaryText)")
                if !recentDetail.isEmpty {
                    Text(recentDetail)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .help(recentDetail)
                }
                if errors > 0 {
                    Text("\(errors) \(errors == 1 ? "error" : "errors")")
                        .fontWeight(.semibold)
                        .foregroundStyle(theme.palette.error)
                        .fixedSize()
                }
                if running { ActivityDot() }
                Spacer(minLength: 0)
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .medium))
                    .rotationEffect(.degrees(expanded ? 180 : 0))
                    .padding(.trailing, 3)
            }
            .font(theme.transcriptFont(minus: 4))
            .foregroundStyle(theme.palette.muted)
            .lineLimit(1)
            .padding(.horizontal, 15)
            .padding(.vertical, 12)
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct ActivityRowView: View {
    let tool: ActivityTool

    @Environment(\.theme) private var theme

    private var error: Bool { tool.result?.isError == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            heading
            if !tool.resultOnly {
                let input = ToolFormat.toolInput(name: tool.name, input: tool.input)
                ToolPayloadView(label: input.label, value: input)
            }
            if let result = tool.result {
                ToolPayloadView(
                    label: error ? "Error output" : "Output",
                    value: ToolFormat.toolResult(result.content),
                    error: error
                )
            } else {
                Text(tool.status == .running ? "Waiting for output…" : "No output in the loaded history.")
                    .font(theme.transcriptFont(minus: 4))
                    .foregroundStyle(theme.palette.muted)
                    .padding(.top, 12)
            }
            if tool.resultOnly {
                Text("Tool call details are not available in the loaded history.")
                    .font(theme.transcriptFont(minus: 4))
                    .foregroundStyle(theme.palette.muted)
                    .padding(.top, 12)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 19)
    }

    private var heading: some View {
        HStack(spacing: 11) {
            Image(systemName: tool.name == "Bash" ? "terminal" : "doc")
                .font(.system(size: 17))
                .foregroundStyle(theme.palette.accent)
                .frame(width: 34, height: 34)
                .background(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(theme.palette.raised)
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(tool.name)
                    .font(theme.transcriptFont(minus: 3, weight: .semibold))
                    .foregroundStyle(theme.palette.ink)
                let detail = ActivityDetail.detail(for: tool)
                if !detail.isEmpty {
                    Text(detail)
                        .font(theme.transcriptFont(minus: 5))
                        .foregroundStyle(theme.palette.muted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .help(detail)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            state
        }
        .padding(.bottom, 14)
    }

    private var state: some View {
        HStack(spacing: 5) {
            if error {
                Image(systemName: "info.circle").font(.system(size: 13))
                Text("Error")
            } else if tool.status == .running {
                ActivityDot()
                Text("Running")
            } else {
                Image(systemName: "checkmark")
                    .font(.system(size: 13))
                    .foregroundStyle(theme.palette.success)
                Text("Done")
            }
        }
        .font(theme.transcriptFont(minus: 5))
        .foregroundStyle(error ? theme.palette.error : theme.palette.muted)
        .fixedSize()
    }
}

struct ActivityDot: View {
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        Circle()
            .fill(theme.palette.accent)
            .frame(width: 6, height: 6)
            .opacity(dim ? 0.35 : 1)
            .animation(
                reduceMotion ? nil : .easeInOut(duration: 0.85).repeatForever(autoreverses: true),
                value: dim
            )
            .onAppear { if !reduceMotion { dim = true } }
            .accessibilityLabel("Running")
    }
}

enum ActivityDetail {
    static func basename(_ value: String) -> String {
        let trimmed = value.replacingOccurrences(of: "[\\\\/]+$", with: "", options: .regularExpression)
        let parts = trimmed.split(whereSeparator: { $0 == "/" || $0 == "\\" })
        return parts.last.map(String.init) ?? value
    }

    static func detail(for tool: ActivityTool) -> String {
        guard let input = tool.input?.objectValue else { return "" }
        if let file = ["file_path", "path"].compactMap({ input[$0]?.stringValue }).first {
            return basename(file)
        }
        guard let detail = ["description", "pattern", "to", "command"]
            .compactMap({ input[$0]?.stringValue }).first
        else { return "" }
        let firstLine = detail.components(separatedBy: "\n").first ?? detail
        return firstLine.count > 72 ? String(firstLine.prefix(69)) + "…" : firstLine
    }
}
