import SwiftUI

enum ThemeName: String, CaseIterable, Codable, Sendable {
    case pop, light, dark
}

enum ReadingSize: String, CaseIterable, Codable, Sendable {
    case comfortable, large

    var reader: CGFloat { self == .comfortable ? 17 : 20 }
    var ui: CGFloat { self == .comfortable ? 15 : 17 }
}

struct Palette: Sendable {
    var canvas, sidebar, panel, raised, hover: Color
    var ink, muted, placeholder, rule: Color
    var accent, accentHover, onAccent, link, selection: Color
    var success, warning, warningBg, error, errorBg: Color
    var scrollbar, disabled, disabledInk, buttonHover, dangerButton: Color
    var start, onStart: Color

    static let pop = Palette(
        canvas: .hex("f5f5fc"), sidebar: .hex("ffffff"), panel: .hex("ffffff"),
        raised: .hex("eeeafb"), hover: .hex("e7e1fa"),
        ink: .hex("25243b"), muted: .hex("5d6076"), placeholder: .hex("686b80"), rule: .hex("dcddeb"),
        accent: .hex("6842d8"), accentHover: .hex("5430bd"), onAccent: .hex("ffffff"),
        link: .hex("5132bb"), selection: .hex("d8ccff"),
        success: .hex("198154"), warning: .hex("965010"), warningBg: .hex("fff0d7"),
        error: .hex("a32c39"), errorBg: .hex("ffeaed"),
        scrollbar: .hex("a6a8bb"), disabled: .hex("e1e0eb"), disabledInk: .hex("66677b"),
        buttonHover: .hex("e6defb"), dangerButton: .hex("b43147"),
        start: .hex("d7f36a"), onStart: .hex("263409")
    )

    static let light: Palette = {
        var palette = Palette.pop
        palette.canvas = .hex("f8fafc")
        palette.raised = .hex("f0f3f8")
        palette.hover = .hex("e7edf5")
        palette.ink = .hex("1e293b")
        palette.muted = .hex("536176")
        palette.placeholder = .hex("637085")
        palette.rule = .hex("dce3ec")
        palette.accent = .hex("245fc1")
        palette.accentHover = .hex("194b9e")
        palette.link = .hex("245fc1")
        palette.selection = .hex("ccdefa")
        palette.start = .hex("dce8ff")
        palette.onStart = .hex("143974")
        return palette
    }()

    static let dark = Palette(
        canvas: .hex("171923"), sidebar: .hex("202330"), panel: .hex("262a39"),
        raised: .hex("2d3244"), hover: .hex("393f55"),
        ink: .hex("f2f3fc"), muted: .hex("bec3d6"), placeholder: .hex("adb5cf"), rule: .hex("464d65"),
        accent: .hex("bba5ff"), accentHover: .hex("d0bfff"), onAccent: .hex("241840"),
        link: .hex("b5caff"), selection: .hex("514773"),
        success: .hex("66dca3"), warning: .hex("ffca86"), warningBg: .hex("3b3024"),
        error: .hex("ffb3bd"), errorBg: .hex("432832"),
        scrollbar: .hex("64708e"), disabled: .hex("383e52"), disabledInk: .hex("a6afc6"),
        buttonHover: .hex("46405c"), dangerButton: .hex("a62f48"),
        start: .hex("d7f36a"), onStart: .hex("263409")
    )

    static func named(_ name: ThemeName) -> Palette {
        switch name {
        case .pop: return .pop
        case .light: return .light
        case .dark: return .dark
        }
    }

    /// 5 avatar slots, chosen by a hash of the project name.
    static let avatars: [(background: Color, ink: Color)] = [
        (.hex("56348b"), .hex("e5dafa")),
        (.hex("714609"), .hex("f9e3b4")),
        (.hex("195d51"), .hex("c6eee0")),
        (.hex("963c61"), .hex("fbd6e4")),
        (.hex("2755a0"), .hex("d2e4ff")),
    ]
}

struct Theme: Sendable {
    var name: ThemeName = .pop
    var readingSize: ReadingSize = .comfortable

    var palette: Palette { .named(name) }
    var colorScheme: ColorScheme? { name == .dark ? .dark : .light }

    static let fontName = "Avenir Next"

    func ui(_ weight: Font.Weight = .regular, scale: CGFloat = 1) -> Font {
        .custom(Self.fontName, size: readingSize.ui * scale).weight(weight)
    }

    func reader(_ weight: Font.Weight = .regular, scale: CGFloat = 1) -> Font {
        .custom(Self.fontName, size: readingSize.reader * scale).weight(weight)
    }

    func mono(size: CGFloat) -> Font {
        .system(size: size, weight: .regular, design: .monospaced)
    }
}

enum Metrics {
    static let sidebarMin: CGFloat = 260
    static let sidebarMax: CGFloat = 328
    static let sidebarFraction: CGFloat = 0.213
    static let brandRowHeight: CGFloat = 89
    static let topbarHeight: CGFloat = 60
    static let topbarWithCommand: CGFloat = 94
    static let topbarWithWrappedCommand: CGFloat = 121
    static let conversationMaxWidth: CGFloat = 1000
    static let composerMaxWidth: CGFloat = 940
    static let sessionPanelWidth: CGFloat = 284
    static let sessionPanelNarrow: CGFloat = 250
    static let workspaceMinHeight: CGFloat = 440

    enum Radius {
        static let iconButton: CGFloat = 7
        static let chatRow: CGFloat = 8
        static let button: CGFloat = 8
        static let projectRow: CGFloat = 7
        static let newChat: CGFloat = 14
        static let activityGroup: CGFloat = 14
        static let codeBlock: CGFloat = 12
        static let toolPayload: CGFloat = 10
        static let composer: CGFloat = 24
        static let composerInput: CGFloat = 23
        static let nativeRow: CGFloat = 16
        static let avatar: CGFloat = 17
        static let dialog: CGFloat = 16
        static let mentionMenu: CGFloat = 14
        static let userBubble: CGFloat = 20
    }

    enum Breakpoint {
        static let panelNarrow: CGFloat = 1150
        static let panelOverlay: CGFloat = 940
        static let compact: CGFloat = 759
    }
}

extension Color {
    static func hex(_ value: String) -> Color {
        var hex: UInt64 = 0
        Scanner(string: value).scanHexInt64(&hex)
        return Color(
            .sRGB,
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255,
            opacity: 1
        )
    }
}

private struct ThemeKey: EnvironmentKey {
    static let defaultValue = Theme()
}

extension EnvironmentValues {
    var theme: Theme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}
