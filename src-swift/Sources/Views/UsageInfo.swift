import Foundation
import SwiftUI

/// Port of src/usage-format.ts.
enum UsageFormat {
    static func tokenCount(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 0
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }

    /// Significant digits keep genuinely small costs from rounding to a misleading "$0.00".
    static func usdCost(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.usesSignificantDigits = true
        formatter.minimumSignificantDigits = 1
        formatter.maximumSignificantDigits = 6
        return formatter.string(from: NSNumber(value: value)) ?? "$\(value)"
    }

    static func totalInputTokens(_ usage: Usage) -> Int {
        usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
    }

    static func summary(_ usage: Usage) -> String {
        let input = totalInputTokens(usage)
        var parts = [
            "\(tokenCount(input)) \(input == 1 ? "token" : "tokens") in",
            "\(tokenCount(usage.outputTokens)) \(usage.outputTokens == 1 ? "token" : "tokens") out",
        ]
        if let cost = usage.costUsd { parts.append(usdCost(cost)) }
        return parts.joined(separator: " · ")
    }

    static func scopeNote(_ usage: Usage) -> String {
        switch usage.scope {
        case .allModels: return "Reported API usage across all models, not context-window size."
        case .mainAgent: return "Main-agent API usage only; subagents and auxiliary calls are excluded. Not context-window size."
        case .apiMessage: return "Reported usage for this API response, not context-window size."
        case nil: return "Reported API usage, not context-window size."
        }
    }
}

struct UsageInfoView: View {
    @Environment(\.theme) private var theme
    let usage: Usage

    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 4) {
                row("Uncached input", UsageFormat.tokenCount(usage.inputTokens))
                if let cacheRead = usage.cacheReadInputTokens {
                    row("Cache read", UsageFormat.tokenCount(cacheRead))
                }
                if let cacheWrite = usage.cacheCreationInputTokens {
                    row("Cache write", UsageFormat.tokenCount(cacheWrite))
                }
                row("Output", UsageFormat.tokenCount(usage.outputTokens))
                if let cost = usage.costUsd {
                    row("Estimated cost", UsageFormat.usdCost(cost))
                }
                Text(UsageFormat.scopeNote(usage))
                    .font(theme.ui(scale: 0.8))
                    .foregroundStyle(theme.palette.placeholder)
                    .padding(.top, 4)
            }
            .padding(.top, 6)
        } label: {
            Text(UsageFormat.summary(usage))
                .font(theme.ui(scale: 0.86))
                .foregroundStyle(theme.palette.muted)
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .foregroundStyle(theme.palette.muted)
            Spacer()
            Text(value)
                .foregroundStyle(theme.palette.ink)
                .monospacedDigit()
        }
        .font(theme.ui(scale: 0.86))
    }
}

/// Port of TranscriptSyncStatus.tsx.
struct TranscriptSyncStatusView: View {
    @Environment(\.theme) private var theme
    let chat: Chat
    let connected: Bool
    let syncing: Bool
    var onSync: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            StatusDot(tone: tone, pulsing: chat.status == .running)
            Text(label)
                .font(theme.ui(.semibold, scale: 0.86))
                .foregroundStyle(theme.palette.ink)
            Text(detail)
                .font(theme.ui(scale: 0.86))
                .foregroundStyle(theme.palette.muted)
                .lineLimit(1)
            Spacer()
            Button("Sync now", action: onSync)
                .buttonStyle(SubtleButtonStyle())
                .disabled(syncing || chat.status == .running || !connected)
        }
    }

    private var label: String {
        if !connected { return "Disconnected" }
        if chat.status == .running { return "Live response" }
        guard let sync = chat.sync else { return "Checking Claude history" }
        return sync.status == .synced ? "Synced with Claude" : "Sync needs attention"
    }

    private var detail: String {
        if !connected { return "Reconnect to check the Claude transcript." }
        if chat.status == .running { return "Claude is still writing this turn." }
        guard let sync = chat.sync else { return "Reading the native transcript." }
        if sync.status == .error { return sync.error ?? "The transcript could not be read." }
        guard let count = sync.messageCount else { return "" }
        return "\(count) messages checked."
    }

    private var tone: StatusDot.Tone {
        if !connected { return .warning }
        if chat.status == .running { return .accent }
        guard let sync = chat.sync else { return .disabled }
        return sync.status == .synced ? .success : .error
    }
}

/// Port of HistoryLoadControls.tsx.
struct HistoryLoadControls: View {
    @Environment(\.theme) private var theme
    let hasMore: Bool
    let loading: Bool
    let pagesAdded: Int
    let notice: String?
    var onLoadMore: () -> Void
    var onLoadAll: () -> Void
    var onStop: () -> Void

    var body: some View {
        if hasMore || loading || notice != nil {
            VStack(alignment: .leading, spacing: 6) {
                if loading {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(pagesAdded > 0 ? "Loading history · \(pagesAdded) pages added" : "Loading history…")
                            .font(theme.ui(scale: 0.86))
                            .foregroundStyle(theme.palette.muted)
                        Button("Stop loading", action: onStop)
                            .buttonStyle(SubtleButtonStyle())
                    }
                } else if hasMore {
                    HStack(spacing: 8) {
                        Button {
                            onLoadAll()
                        } label: {
                            Label("Load all remaining", systemImage: "arrow.down.circle")
                        }
                        .buttonStyle(PrimaryButtonStyle())

                        Button {
                            onLoadMore()
                        } label: {
                            Label("Load more", systemImage: "chevron.down")
                        }
                        .buttonStyle(SubtleButtonStyle())
                    }
                }
                if let notice, !loading {
                    Text(notice)
                        .font(theme.ui(scale: 0.86))
                        .foregroundStyle(theme.palette.muted)
                }
            }
        }
    }
}
