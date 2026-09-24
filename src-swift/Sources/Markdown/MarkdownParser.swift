import Foundation

/// Port of src/markdown-parser.ts. The block and inline models, the scanning order, and the
/// edge cases are deliberately identical to the TypeScript so the native transcript renders
/// the same text the web build does.
enum InlineNode: Hashable, Sendable {
    case text(String)
    case code(String)
    case strong([InlineNode])
    case emphasis([InlineNode])
    case link(href: String, children: [InlineNode])
}

enum MarkdownBlock: Hashable, Sendable {
    case paragraph([InlineNode])
    case heading(level: Int, content: [InlineNode])
    case code(language: String?, value: String)
    case list(ordered: Bool, items: [[InlineNode]])
    case quote([InlineNode])
    case rule
    case table(headers: [[InlineNode]], rows: [[[InlineNode]]])
}

enum MarkdownParser {
    static let inlineDepthLimit = 8

    // MARK: - Links

    /// Mirrors safeLink(): only http/https survive, and the result is the normalized href
    /// that `new URL().href` would produce.
    static func safeLink(_ value: String) -> String? {
        guard var components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty
        else { return nil }
        components.scheme = scheme
        components.host = host.lowercased()
        if components.path.isEmpty { components.path = "/" }
        return components.url?.absoluteString ?? value
    }

    // MARK: - Inline scanner

    static func parseInline(_ input: String, depth: Int = 0) -> [InlineNode] {
        if depth > inlineDepthLimit { return [.text(input)] }

        let characters = Array(input)
        var tokens: [InlineNode] = []
        var cursor = 0

        func pushText(_ value: String) {
            guard !value.isEmpty else { return }
            if case .text(let previous) = tokens.last {
                tokens[tokens.count - 1] = .text(previous + value)
            } else {
                tokens.append(.text(value))
            }
        }

        func index(of character: Character, from start: Int) -> Int? {
            var cursor = max(start, 0)
            while cursor < characters.count {
                if characters[cursor] == character { return cursor }
                cursor += 1
            }
            return nil
        }

        func index(of needle: [Character], from start: Int) -> Int? {
            guard !needle.isEmpty else { return nil }
            var cursor = max(start, 0)
            while cursor + needle.count <= characters.count {
                if Array(characters[cursor..<(cursor + needle.count)]) == needle { return cursor }
                cursor += 1
            }
            return nil
        }

        while cursor < characters.count {
            if characters[cursor] == "\\", cursor + 1 < characters.count {
                pushText(String(characters[cursor + 1]))
                cursor += 2
                continue
            }

            if characters[cursor] == "`", let end = index(of: "`", from: cursor + 1) {
                tokens.append(.code(String(characters[(cursor + 1)..<end])))
                cursor = end + 1
                continue
            }

            if characters[cursor] == "[",
               let labelEnd = index(of: ["]", "("], from: cursor + 1),
               let hrefEnd = index(of: ")", from: labelEnd + 2) {
                let label = String(characters[(cursor + 1)..<labelEnd])
                let raw = String(characters[(labelEnd + 2)..<hrefEnd])
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if let href = safeLink(raw) {
                    tokens.append(.link(href: href, children: parseInline(label, depth: depth + 1)))
                } else {
                    pushText(label)
                }
                cursor = hrefEnd + 1
                continue
            }

            if cursor + 1 < characters.count {
                let pair = [characters[cursor], characters[cursor + 1]]
                if pair == ["*", "*"] || pair == ["_", "_"],
                   let end = index(of: pair, from: cursor + 2), end > cursor + 2 {
                    tokens.append(.strong(parseInline(String(characters[(cursor + 2)..<end]), depth: depth + 1)))
                    cursor = end + 2
                    continue
                }
            }

            if characters[cursor] == "*" || characters[cursor] == "_" {
                let marker = characters[cursor]
                if let end = index(of: marker, from: cursor + 1), end > cursor + 1 {
                    tokens.append(.emphasis(parseInline(String(characters[(cursor + 1)..<end]), depth: depth + 1)))
                    cursor = end + 1
                    continue
                }
            }

            pushText(String(characters[cursor]))
            cursor += 1
        }

        return tokens
    }

    // MARK: - Line patterns

    static func isBlank(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// `^(#{1,4})\s+(.+)$` — five or more hashes never match, because no amount of
    /// backtracking puts whitespace after the run.
    static func matchHeading(_ line: String) -> (level: Int, content: String)? {
        let characters = Array(line)
        var hashes = 0
        while hashes < 4, hashes < characters.count, characters[hashes] == "#" { hashes += 1 }
        guard hashes >= 1, hashes < characters.count, characters[hashes].isWhitespace else { return nil }
        guard let content = restAfterRequiredSpace(characters, from: hashes) else { return nil }
        return (hashes, content)
    }

    /// `^\s*(?:([-+*])|(\d+)\.)\s+(.+)$`
    static func matchList(_ line: String) -> (ordered: Bool, content: String)? {
        let characters = Array(line)
        var cursor = 0
        while cursor < characters.count, characters[cursor].isWhitespace { cursor += 1 }
        guard cursor < characters.count else { return nil }

        var ordered = false
        if characters[cursor] == "-" || characters[cursor] == "+" || characters[cursor] == "*" {
            cursor += 1
        } else {
            var digits = 0
            while cursor + digits < characters.count, characters[cursor + digits].isASCIIDigit { digits += 1 }
            guard digits > 0, cursor + digits < characters.count, characters[cursor + digits] == "." else { return nil }
            ordered = true
            cursor += digits + 1
        }

        guard cursor < characters.count, characters[cursor].isWhitespace else { return nil }
        guard let content = restAfterRequiredSpace(characters, from: cursor) else { return nil }
        return (ordered, content)
    }

    /// `^\s*>\s?(.*)$` — the captured tail may be empty.
    static func matchQuote(_ line: String) -> String? {
        let characters = Array(line)
        var cursor = 0
        while cursor < characters.count, characters[cursor].isWhitespace { cursor += 1 }
        guard cursor < characters.count, characters[cursor] == ">" else { return nil }
        cursor += 1
        if cursor < characters.count, characters[cursor].isWhitespace { cursor += 1 }
        return String(characters[cursor...])
    }

    /// `^\s*(?:-{3,}|\*{3,}|_{3,})\s*$`
    static func isRule(_ line: String) -> Bool {
        let characters = Array(line)
        var cursor = 0
        while cursor < characters.count, characters[cursor].isWhitespace { cursor += 1 }
        guard cursor < characters.count, "-*_".contains(characters[cursor]) else { return false }
        let marker = characters[cursor]
        var run = 0
        while cursor < characters.count, characters[cursor] == marker {
            run += 1
            cursor += 1
        }
        guard run >= 3 else { return false }
        while cursor < characters.count, characters[cursor].isWhitespace { cursor += 1 }
        return cursor == characters.count
    }

    /// `^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$` — note the `+`, which means a
    /// single-column divider is not a table.
    static func isTableDivider(_ line: String) -> Bool {
        let characters = Array(line)
        var cursor = 0

        func skipWhitespace() {
            while cursor < characters.count, characters[cursor].isWhitespace { cursor += 1 }
        }

        func matchCell() -> Bool {
            var probe = cursor
            if probe < characters.count, characters[probe] == ":" { probe += 1 }
            var dashes = 0
            while probe < characters.count, characters[probe] == "-" {
                dashes += 1
                probe += 1
            }
            guard dashes >= 3 else { return false }
            if probe < characters.count, characters[probe] == ":" { probe += 1 }
            cursor = probe
            return true
        }

        skipWhitespace()
        if cursor < characters.count, characters[cursor] == "|" { cursor += 1 }
        skipWhitespace()
        guard matchCell() else { return false }
        skipWhitespace()

        var repetitions = 0
        while cursor < characters.count, characters[cursor] == "|" {
            let restart = cursor
            cursor += 1
            skipWhitespace()
            guard matchCell() else {
                cursor = restart
                break
            }
            skipWhitespace()
            repetitions += 1
        }
        guard repetitions >= 1 else { return false }

        if cursor < characters.count, characters[cursor] == "|" { cursor += 1 }
        skipWhitespace()
        return cursor == characters.count
    }

    /// Splits on unescaped pipes after trimming one outer pipe from each end.
    static func splitTableRow(_ line: String) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("|") { trimmed.removeFirst() }
        if trimmed.hasSuffix("|") { trimmed.removeLast() }

        var cells: [String] = []
        var current = ""
        var escaped = false
        for character in trimmed {
            if character == "|", !escaped {
                cells.append(current.trimmingCharacters(in: .whitespacesAndNewlines))
                current = ""
            } else {
                current.append(character)
            }
            escaped = character == "\\" && !escaped
            if character != "\\" { escaped = false }
        }
        cells.append(current.trimmingCharacters(in: .whitespacesAndNewlines))
        return cells
    }

    /// `^```([^`]*)$` — an info string containing any backtick is not a fence.
    static func matchFence(_ line: String) -> (isFence: Bool, language: String?) {
        guard line.hasPrefix("```") else { return (false, nil) }
        let info = String(line.dropFirst(3))
        guard !info.contains("`") else { return (false, nil) }

        var language = ""
        for character in info.trimmingCharacters(in: .whitespacesAndNewlines) {
            guard character.isASCIILetter || character.isASCIIDigit
                    || character == "_" || character == "." || character == "+" || character == "-"
            else { break }
            language.append(character)
        }
        return (true, language.isEmpty ? nil : language)
    }

    /// `^```\s*$`
    static func isClosingFence(_ line: String) -> Bool {
        line.hasPrefix("```") && line.dropFirst(3).allSatisfy(\.isWhitespace)
    }

    static func startsBlock(_ lines: [String], _ index: Int) -> Bool {
        let line = at(lines, index)
        return isBlank(line)
            || matchHeading(line) != nil
            || matchFence(line).isFence
            || isRule(line)
            || matchList(line) != nil
            || matchQuote(line) != nil
            || (line.contains("|") && isTableDivider(at(lines, index + 1)))
    }

    // MARK: - Block parser

    static func parse(_ source: String) -> [MarkdownBlock] {
        let normalized = source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        let lines = normalized.components(separatedBy: "\n")

        var blocks: [MarkdownBlock] = []
        var index = 0

        while index < lines.count {
            let line = lines[index]
            if isBlank(line) {
                index += 1
                continue
            }

            let fence = matchFence(line)
            if fence.isFence {
                var body: [String] = []
                index += 1
                while index < lines.count, !isClosingFence(lines[index]) {
                    body.append(lines[index])
                    index += 1
                }
                if index < lines.count { index += 1 }
                blocks.append(.code(language: fence.language, value: body.joined(separator: "\n")))
                continue
            }

            if let heading = matchHeading(line) {
                blocks.append(.heading(level: heading.level, content: parseInline(heading.content)))
                index += 1
                continue
            }

            if isRule(line) {
                blocks.append(.rule)
                index += 1
                continue
            }

            if line.contains("|"), isTableDivider(at(lines, index + 1)) {
                let headers = splitTableRow(line).map { parseInline($0) }
                var rows: [[[InlineNode]]] = []
                index += 2
                while index < lines.count, lines[index].contains("|"), !isBlank(lines[index]) {
                    rows.append(splitTableRow(lines[index]).map { parseInline($0) })
                    index += 1
                }
                blocks.append(.table(headers: headers, rows: rows))
                continue
            }

            if let list = matchList(line) {
                var items: [[InlineNode]] = []
                while index < lines.count {
                    guard let item = matchList(lines[index]), item.ordered == list.ordered else { break }
                    items.append(parseInline(item.content))
                    index += 1
                }
                blocks.append(.list(ordered: list.ordered, items: items))
                continue
            }

            if matchQuote(line) != nil {
                var quoted: [String] = []
                while index < lines.count, let part = matchQuote(lines[index]) {
                    quoted.append(part)
                    index += 1
                }
                blocks.append(.quote(parseInline(quoted.joined(separator: "\n"))))
                continue
            }

            var paragraph = [line]
            index += 1
            while index < lines.count, !startsBlock(lines, index) {
                paragraph.append(lines[index])
                index += 1
            }
            blocks.append(.paragraph(parseInline(paragraph.joined(separator: "\n"))))
        }

        return blocks
    }

    // MARK: - Helpers

    private static func at(_ lines: [String], _ index: Int) -> String {
        index >= 0 && index < lines.count ? lines[index] : ""
    }

    /// `\s+(.+)$`: the whitespace run is greedy but always leaves at least one character,
    /// so a heading of nothing but spaces still captures a single trailing space.
    private static func restAfterRequiredSpace(_ characters: [Character], from start: Int) -> String? {
        var cursor = start
        while cursor < characters.count, characters[cursor].isWhitespace { cursor += 1 }
        guard cursor > start else { return nil }
        if cursor < characters.count { return String(characters[cursor...]) }
        guard cursor - start >= 2 else { return nil }
        return String(characters[(cursor - 1)...])
    }
}

private extension Character {
    var isASCIIDigit: Bool { isASCII && ("0"..."9").contains(self) }
    var isASCIILetter: Bool { isASCII && (("a"..."z").contains(self) || ("A"..."Z").contains(self)) }
}
