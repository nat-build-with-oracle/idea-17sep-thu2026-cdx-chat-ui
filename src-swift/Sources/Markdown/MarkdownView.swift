import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

/// Port of src/Markdown.tsx. Block geometry follows the `.markdown` rules in
/// src/styles.css: line-height 1.8, the per-element margins, and the 75ch paragraph measure.
struct MarkdownView: View {
    let content: String
    var clampsParagraphMeasure = true

    @Environment(\.theme) private var theme

    var body: some View {
        let blocks = MarkdownParser.parse(content)
        let size = theme.readingSize.reader
        let styler = InlineStyler(theme: theme, baseSize: size)

        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { offset, block in
                if offset > 0 {
                    Color.clear.frame(height: collapsedGap(blocks[offset - 1], block))
                }
                blockView(block, styler: styler, size: size)
            }
        }
        .foregroundStyle(theme.palette.ink)
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock, styler: InlineStyler, size: CGFloat) -> some View {
        switch block {
        case .paragraph(let content):
            paragraph(styler.render(content), size: size)

        case .heading(let level, let content):
            let metrics = MarkdownMetrics.heading(level)
            Text(styler.render(content, size: metrics.size, weight: .semibold))
                .tracking(metrics.tracking)
                .lineSpacing(MarkdownMetrics.lineSpacing(size: metrics.size, multiple: metrics.lineHeight))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .code(let language, let value):
            CodeBlockView(language: language, value: value, baseSize: size)

        case .list(let ordered, let items):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { offset, item in
                    HStack(alignment: .firstTextBaseline, spacing: 0) {
                        Text(ordered ? "\(offset + 1)." : "•")
                            .font(.custom(Theme.fontName, size: size))
                            .foregroundStyle(theme.palette.ink)
                            .frame(width: 24, alignment: .trailing)
                        paragraph(styler.render(item), size: size)
                            .padding(.leading, 4)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

        case .quote(let content):
            HStack(alignment: .top, spacing: 0) {
                Rectangle()
                    .fill(theme.palette.rule)
                    .frame(width: 1)
                Text(styler.render(content))
                    .lineSpacing(MarkdownMetrics.lineSpacing(size: size, multiple: MarkdownMetrics.bodyLineHeight))
                    .foregroundStyle(theme.palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 18)
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)

        case .rule:
            Rectangle()
                .fill(theme.palette.hover)
                .frame(height: 1)
                .frame(maxWidth: .infinity)

        case .table(let headers, let rows):
            MarkdownTableView(headers: headers, rows: rows, styler: styler, baseSize: size)
        }
    }

    private func paragraph(_ text: AttributedString, size: CGFloat) -> some View {
        Text(text)
            .lineSpacing(MarkdownMetrics.lineSpacing(size: size, multiple: MarkdownMetrics.bodyLineHeight))
            .fixedSize(horizontal: false, vertical: true)
            .frame(
                maxWidth: clampsParagraphMeasure ? MarkdownMetrics.measure(characters: 75, size: size) : .infinity,
                alignment: .leading
            )
    }

    /// CSS collapses adjacent vertical margins to the larger of the two.
    private func collapsedGap(_ previous: MarkdownBlock, _ next: MarkdownBlock) -> CGFloat {
        max(MarkdownMetrics.margins(previous).bottom, MarkdownMetrics.margins(next).top)
    }
}

// MARK: - Inline rendering

/// Inline tokens become one AttributedString so the paragraph wraps as a single run of text,
/// the way the browser lays out mixed `<strong>` / `<code>` / `<a>` content.
struct InlineStyler {
    let theme: Theme
    let baseSize: CGFloat

    func render(
        _ nodes: [InlineNode],
        size: CGFloat? = nil,
        weight: Font.Weight = .regular,
        bold: Bool = false,
        italic: Bool = false,
        href: String? = nil
    ) -> AttributedString {
        let size = size ?? baseSize
        var result = AttributedString()

        for node in nodes {
            switch node {
            case .text(let value):
                var piece = AttributedString(value)
                piece.font = font(size: size, weight: bold ? .semibold : weight, italic: italic)
                apply(link: href, to: &piece)
                result += piece

            case .code(let value):
                var piece = AttributedString(value)
                piece.font = .system(
                    size: size * MarkdownMetrics.codeScale,
                    weight: bold ? .semibold : weight,
                    design: .monospaced
                )
                piece.backgroundColor = theme.palette.raised
                apply(link: href, to: &piece)
                result += piece

            case .strong(let children):
                result += render(children, size: size, weight: weight, bold: true, italic: italic, href: href)

            case .emphasis(let children):
                result += render(children, size: size, weight: weight, bold: bold, italic: true, href: href)

            case .link(let target, let children):
                result += render(children, size: size, weight: weight, bold: bold, italic: italic, href: target)
            }
        }

        return result
    }

    private func apply(link href: String?, to piece: inout AttributedString) {
        guard let href, let url = URL(string: href) else { return }
        piece.link = url
        piece.foregroundColor = theme.palette.link
        piece.underlineStyle = .single
    }

    private func font(size: CGFloat, weight: Font.Weight, italic: Bool) -> Font {
        let font = Font.custom(Theme.fontName, size: size).weight(weight)
        return italic ? font.italic() : font
    }
}

// MARK: - Code block

private struct CodeBlockView: View {
    let language: String?
    let value: String
    let baseSize: CGFloat

    @Environment(\.theme) private var theme
    @State private var copied = false
    @State private var hovering = false
    @State private var resetTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Text(language ?? "text")
                    .font(.custom(Theme.fontName, size: 12))
                Spacer(minLength: 0)
                Button(action: copy) {
                    Text(copied ? "Copied" : "Copy")
                        .font(.custom(Theme.fontName, size: 12))
                        .padding(.horizontal, 5)
                        .frame(minHeight: 28)
                        .foregroundStyle(hovering ? theme.palette.ink : theme.palette.muted)
                        .background(hovering ? theme.palette.hover : .clear, in: RoundedRectangle(cornerRadius: 4))
                }
                .buttonStyle(.plain)
                .onHover { hovering = $0 }
                .accessibilityLabel(copied ? "Code copied" : "Copy code")
            }
            .padding(.horizontal, 15)
            .padding(.vertical, 9)
            .foregroundStyle(theme.palette.muted)
            .background(theme.palette.raised)

            ScrollView(.horizontal) {
                Text(value)
                    .font(.system(size: baseSize * MarkdownMetrics.codeScale, design: .monospaced))
                    .lineSpacing(
                        MarkdownMetrics.lineSpacing(
                            size: baseSize * MarkdownMetrics.codeScale,
                            multiple: MarkdownMetrics.codeLineHeight
                        )
                    )
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 16)
                    .textSelection(.enabled)
            }
        }
        .background(theme.palette.panel)
        .clipShape(RoundedRectangle(cornerRadius: Metrics.Radius.codeBlock))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.Radius.codeBlock)
                .stroke(theme.palette.rule, lineWidth: 1)
        )
        .frame(maxWidth: .infinity, alignment: .leading)
        .onDisappear { resetTask?.cancel() }
    }

    private func copy() {
        #if canImport(AppKit)
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(value, forType: .string)
        #endif
        copied = true
        resetTask?.cancel()
        resetTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(1600))
            guard !Task.isCancelled else { return }
            copied = false
        }
    }
}

// MARK: - Table

private struct MarkdownTableView: View {
    let headers: [[InlineNode]]
    let rows: [[[InlineNode]]]
    let styler: InlineStyler
    let baseSize: CGFloat

    @Environment(\.theme) private var theme

    private var columnCount: Int {
        max(headers.count, rows.map(\.count).max() ?? 0)
    }

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(headers.enumerated()), id: \.offset) { offset, cell in
                        cellText(cell, weight: .medium, color: theme.palette.muted)
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                            .padding(padding(for: offset))
                    }
                }
                divider

                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { offset, cell in
                            cellText(cell, weight: offset == 0 ? .medium : .regular, color: theme.palette.ink)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(minWidth: 55, alignment: .leading)
                                .padding(padding(for: offset))
                        }
                    }
                    divider
                }
            }
            .frame(minWidth: 360, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var divider: some View {
        Rectangle()
            .fill(theme.palette.rule)
            .frame(height: 1)
            .gridCellColumns(columnCount)
    }

    private func cellText(_ cell: [InlineNode], weight: Font.Weight, color: Color) -> some View {
        Text(styler.render(cell, size: baseSize * 0.95, weight: weight))
            .foregroundStyle(color)
            .multilineTextAlignment(.leading)
    }

    /// `th + th, td + td { padding-left: 22px }` replaces the 5px default on later columns.
    private func padding(for column: Int) -> EdgeInsets {
        EdgeInsets(top: 10, leading: column == 0 ? 5 : 22, bottom: 10, trailing: 5)
    }
}

// MARK: - Metrics

enum MarkdownMetrics {
    static let bodyLineHeight: CGFloat = 1.8
    static let codeLineHeight: CGFloat = 1.7
    static let codeScale: CGFloat = 0.87

    struct Margins {
        let top: CGFloat
        let bottom: CGFloat
    }

    static func margins(_ block: MarkdownBlock) -> Margins {
        switch block {
        case .paragraph: return Margins(top: 0, bottom: 17)
        case .heading(let level, _):
            switch level {
            case 1: return Margins(top: 23, bottom: 10)
            case 2: return Margins(top: 27, bottom: 12)
            case 3: return Margins(top: 23, bottom: 10)
            default: return Margins(top: 20, bottom: 8)
            }
        case .code: return Margins(top: 20, bottom: 20)
        case .list: return Margins(top: 12, bottom: 20)
        case .quote: return Margins(top: 20, bottom: 20)
        case .rule: return Margins(top: 24, bottom: 24)
        case .table: return Margins(top: 24, bottom: 24)
        }
    }

    static func heading(_ level: Int) -> (size: CGFloat, lineHeight: CGFloat, tracking: CGFloat) {
        switch level {
        case 1: return (36, 1.3, 36 * -0.025)
        case 2: return (24, 1.4, 24 * -0.02)
        case 3: return (19, bodyLineHeight, 0)
        default: return (17, bodyLineHeight, 0)
        }
    }

    /// SwiftUI's lineSpacing is the gap *between* lines, so the font's own line height has
    /// to come off the CSS line-height first.
    static func lineSpacing(size: CGFloat, multiple: CGFloat) -> CGFloat {
        max(0, multiple * size - naturalLineHeight(size: size))
    }

    static func measure(characters: CGFloat, size: CGFloat) -> CGFloat {
        #if canImport(AppKit)
        let font = NSFont(name: Theme.fontName, size: size) ?? NSFont.systemFont(ofSize: size)
        let advance = ("0" as NSString).size(withAttributes: [.font: font]).width
        return advance * characters
        #else
        return size * 0.55 * characters
        #endif
    }

    private static func naturalLineHeight(size: CGFloat) -> CGFloat {
        #if canImport(AppKit)
        let font = NSFont(name: Theme.fontName, size: size) ?? NSFont.systemFont(ofSize: size)
        return font.ascender - font.descender + font.leading
        #else
        return size * 1.2
        #endif
    }
}
