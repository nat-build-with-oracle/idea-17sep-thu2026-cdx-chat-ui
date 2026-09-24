import SwiftUI

struct IconButton: View {
    @Environment(\.theme) private var theme
    let systemName: String
    var help: String = ""
    var action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 15, weight: .regular))
                .frame(width: 34, height: 34)
                .foregroundStyle(hovering ? theme.palette.ink : theme.palette.muted)
                .background(hovering ? theme.palette.hover : .clear, in: .rect(cornerRadius: Metrics.Radius.iconButton))
        }
        .buttonStyle(.plain)
        .help(help)
        .onHover { hovering = $0 }
    }
}

struct StatusDot: View {
    enum Tone { case success, warning, accent, error, disabled }

    @Environment(\.theme) private var theme
    var tone: Tone = .success
    var pulsing = false

    @State private var dim = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 9, height: 9)
            .opacity(pulsing && dim ? 0.35 : 1)
            .animation(pulsing ? .easeInOut(duration: 1.7).repeatForever(autoreverses: true) : nil, value: dim)
            .onAppear { if pulsing { dim = true } }
    }

    private var color: Color {
        switch tone {
        case .success: return theme.palette.success
        case .warning: return theme.palette.warning
        case .accent: return theme.palette.accent
        case .error: return theme.palette.error
        case .disabled: return theme.palette.disabledInk
        }
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(theme.ui(.semibold))
            .padding(.horizontal, 16)
            .padding(.vertical, 9)
            .foregroundStyle(isEnabled ? theme.palette.onAccent : theme.palette.disabledInk)
            .background(
                isEnabled ? (configuration.isPressed ? theme.palette.accentHover : theme.palette.accent) : theme.palette.disabled,
                in: .rect(cornerRadius: Metrics.Radius.button)
            )
    }
}

struct SubtleButtonStyle: ButtonStyle {
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(theme.ui())
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .foregroundStyle(isEnabled ? theme.palette.ink : theme.palette.disabledInk)
            .background(
                configuration.isPressed ? theme.palette.buttonHover : theme.palette.raised,
                in: .rect(cornerRadius: Metrics.Radius.button)
            )
    }
}

struct Banner: View {
    enum Kind { case error, warning }

    @Environment(\.theme) private var theme
    let kind: Kind
    let message: String
    var onDismiss: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: kind == .error ? "exclamationmark.circle" : "exclamationmark.triangle")
                .foregroundStyle(kind == .error ? theme.palette.error : theme.palette.warning)
            Text(message)
                .font(theme.ui())
                .foregroundStyle(theme.palette.ink)
            Spacer(minLength: 8)
            if let onDismiss {
                Button("Dismiss", action: onDismiss)
                    .buttonStyle(.plain)
                    .font(theme.ui(.semibold))
                    .foregroundStyle(theme.palette.muted)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 11)
        .background(kind == .error ? theme.palette.errorBg : theme.palette.warningBg)
    }
}

struct Toast: View {
    @Environment(\.theme) private var theme
    let message: String

    var body: some View {
        Text(message)
            .font(theme.ui())
            .foregroundStyle(theme.palette.ink)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(theme.palette.hover, in: .rect(cornerRadius: 10))
            .shadow(color: .black.opacity(0.33), radius: 12, y: 5)
            .padding(.bottom, 27)
    }
}

/// 5 avatar slots keyed by a hash of the project name, same as the web build.
struct ProjectAvatar: View {
    @Environment(\.theme) private var theme
    let name: String
    var size: CGFloat = 34

    var body: some View {
        let slot = Self.slot(for: name)
        Text(String(name.prefix(1)).uppercased())
            .font(.custom(Theme.fontName, size: size * 0.44).weight(.semibold))
            .frame(width: size, height: size)
            .foregroundStyle(Palette.avatars[slot].ink)
            .background(Palette.avatars[slot].background, in: .rect(cornerRadius: Metrics.Radius.avatar))
    }

    static func slot(for name: String) -> Int {
        var hash = 0
        for scalar in name.unicodeScalars {
            hash = (hash &* 31 &+ Int(scalar.value)) % 1_000_003
        }
        return abs(hash) % Palette.avatars.count
    }
}
