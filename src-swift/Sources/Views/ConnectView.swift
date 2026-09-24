import SwiftUI

/// Pre-workspace gate, mirroring BackendConnection.tsx.
struct ConnectView: View {
    @Environment(\.theme) private var theme
    let store: AppStore

    @State private var address = BackendTarget.default.url.absoluteString
    @State private var validationError: String?
    @State private var startDetailsOpen = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 24)
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 12) {
                    ClaudeMark(size: 34)
                    Text("Your Claude. Your backend.")
                        .font(theme.reader(.semibold, scale: 1.45))
                        .foregroundStyle(theme.palette.ink)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Backend address")
                        .font(theme.ui(.semibold))
                        .foregroundStyle(theme.palette.muted)
                    TextField("http://127.0.0.1:4318", text: $address)
                        .textFieldStyle(.plain)
                        .font(theme.mono(size: theme.readingSize.ui))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 11)
                        .background(theme.palette.panel, in: .rect(cornerRadius: Metrics.Radius.button))
                        .overlay(
                            RoundedRectangle(cornerRadius: Metrics.Radius.button)
                                .stroke(theme.palette.rule, lineWidth: 1)
                        )
                        .onSubmit(connect)
                    if let validationError {
                        Text(validationError)
                            .font(theme.ui())
                            .foregroundStyle(theme.palette.error)
                    }
                    if let issue = store.connectionIssue {
                        Text(issue)
                            .font(theme.ui())
                            .foregroundStyle(theme.palette.error)
                    }
                }

                Button("Connect", action: connect)
                    .buttonStyle(PrimaryButtonStyle())

                Text("The app talks to a backend you run yourself. Conversations stay on that machine.")
                    .font(theme.ui())
                    .foregroundStyle(theme.palette.muted)

                DisclosureGroup(isExpanded: $startDetailsOpen) {
                    Text("npm start")
                        .font(theme.mono(size: theme.readingSize.ui - 1))
                        .foregroundStyle(theme.palette.ink)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(theme.palette.raised, in: .rect(cornerRadius: Metrics.Radius.codeBlock))
                        .textSelection(.enabled)
                } label: {
                    Text("Start the backend")
                        .font(theme.ui(.semibold))
                        .foregroundStyle(theme.palette.ink)
                }

                VStack(alignment: .leading, spacing: 6) {
                    Label(
                        "Only connect to a backend you trust. It runs Claude Code with your files.",
                        systemImage: "exclamationmark.triangle"
                    )
                    Label(
                        "A remote backend must be reached over your own VPN, never the open internet.",
                        systemImage: "lock"
                    )
                }
                .font(theme.ui())
                .foregroundStyle(theme.palette.muted)
            }
            .padding(34)
            .frame(maxWidth: 560, alignment: .leading)
            .background(theme.palette.panel, in: .rect(cornerRadius: Metrics.Radius.dialog))
            Spacer(minLength: 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.palette.canvas)
        .onAppear {
            if let saved = Preferences.backendAddress { address = saved }
        }
    }

    private func connect() {
        do {
            validationError = nil
            store.connect(to: try BackendTarget.parse(address))
        } catch {
            validationError = error.localizedDescription
        }
    }
}

struct ClaudeMark: View {
    @Environment(\.theme) private var theme
    var size: CGFloat = 24

    var body: some View {
        Image(systemName: "asterisk")
            .font(.system(size: size, weight: .medium))
            .foregroundStyle(theme.palette.accent)
    }
}
