import Foundation

enum ToolValueLanguage: String, Hashable, Sendable {
    case shell, json, text
}

struct FormattedToolValue: Hashable, Sendable {
    var label: String
    var language: ToolValueLanguage
    var content: String
    var raw: String
    var hasRaw: Bool
}

struct ShellHighlightToken: Hashable, Sendable {
    enum Kind: String, Hashable, Sendable {
        case plain, string, variable, `operator`, comment
    }

    var type: Kind
    var text: String
}

enum ToolFormat {
    // MARK: - Serialization

    /// Mirrors serializeToolValue(): strings pass through, everything else becomes
    /// JSON.stringify(value, null, 2).
    static func serialize(_ value: JSONValue?) -> String {
        guard let value else { return "undefined" }
        if case .string(let text) = value { return text }
        return stringify(value, indent: 0)
    }

    private static func stringify(_ value: JSONValue, indent: Int) -> String {
        let pad = String(repeating: " ", count: indent + 2)
        let closePad = String(repeating: " ", count: indent)
        switch value {
        case .null:
            return "null"
        case .bool(let flag):
            return flag ? "true" : "false"
        case .int(let number):
            return String(number)
        case .double(let number):
            return number == number.rounded() && number.magnitude < 1e15
                ? String(Int(number))
                : String(number)
        case .string(let text):
            return quote(text)
        case .array(let values):
            if values.isEmpty { return "[]" }
            let body = values.map { pad + stringify($0, indent: indent + 2) }.joined(separator: ",\n")
            return "[\n\(body)\n\(closePad)]"
        case .object(let members):
            if members.isEmpty { return "{}" }
            // JSON object key order is lost when decoding into a dictionary, so keys are
            // emitted in sorted order to stay deterministic.
            let body = members.keys.sorted().map { key in
                pad + quote(key) + ": " + stringify(members[key] ?? .null, indent: indent + 2)
            }.joined(separator: ",\n")
            return "{\n\(body)\n\(closePad)}"
        }
    }

    private static func quote(_ text: String) -> String {
        var out = "\""
        for character in text.unicodeScalars {
            switch character {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if character.value < 0x20 {
                    out += String(format: "\\u%04x", character.value)
                } else {
                    out.unicodeScalars.append(character)
                }
            }
        }
        return out + "\""
    }

    private static func parsedJSONContainer(_ text: String) -> JSONValue? {
        guard let data = text.data(using: .utf8),
              let parsed = try? JSONDecoder().decode(JSONValue.self, from: data)
        else { return nil }
        switch parsed {
        case .object, .array: return parsed
        default: return nil
        }
    }

    // MARK: - Formatting

    private static func formatGeneralValue(_ value: JSONValue?) -> FormattedToolValue {
        let raw = serialize(value)
        switch value {
        case .object, .array:
            return FormattedToolValue(label: "", language: .json, content: raw, raw: raw, hasRaw: false)
        case .string(let text):
            if let parsed = parsedJSONContainer(text) {
                let content = serialize(parsed)
                return FormattedToolValue(label: "", language: .json, content: content, raw: raw, hasRaw: content != raw)
            }
        default:
            break
        }
        return FormattedToolValue(label: "", language: .text, content: raw, raw: raw, hasRaw: false)
    }

    static func toolInput(name: String, input: JSONValue?) -> FormattedToolValue {
        let raw = serialize(input)
        if name == "Bash", let members = input?.objectValue, let command = members["command"]?.stringValue {
            return FormattedToolValue(label: "Command", language: .shell, content: command, raw: raw, hasRaw: true)
        }
        var value = formatGeneralValue(input)
        value.label = "Input"
        return value
    }

    static func toolResult(_ value: JSONValue?) -> FormattedToolValue {
        formatGeneralValue(value)
    }

    // MARK: - Shell highlighting

    private static func isVariableNameCharacter(_ character: Character) -> Bool {
        character.isASCII && (character.isLetter || character.isNumber || character == "_")
    }

    private static func isOperatorCharacter(_ character: Character) -> Bool {
        "&|;<>()".contains(character)
    }

    private static func isShellWhitespace(_ character: Character) -> Bool {
        character == " " || character == "\t" || character == "\n" || character == "\r"
    }

    private static func variableEnd(_ source: [Character], _ start: Int) -> Int {
        guard source[start] == "$", start + 1 < source.count else { return start }
        let next = source[start + 1]
        if next == "{" {
            var cursor = start + 2
            while cursor < source.count && source[cursor] != "}" { cursor += 1 }
            return cursor < source.count ? cursor + 1 : source.count
        }
        if "?!#$-@*".contains(next) { return start + 2 }
        if !isVariableNameCharacter(next) { return start }
        var cursor = start + 2
        while cursor < source.count && isVariableNameCharacter(source[cursor]) { cursor += 1 }
        return cursor
    }

    /// A lossless, best-effort shell display tokenizer. It deliberately does not validate
    /// shell syntax or assign execution meaning to the source.
    static func highlightShell(_ source: String) -> [ShellHighlightToken] {
        let characters = Array(source)
        let count = characters.count
        var tokens: [ShellHighlightToken] = []

        func push(_ type: ShellHighlightToken.Kind, _ range: Range<Int>) {
            guard !range.isEmpty else { return }
            let text = String(characters[range])
            if var previous = tokens.last, previous.type == type {
                previous.text += text
                tokens[tokens.count - 1] = previous
            } else {
                tokens.append(ShellHighlightToken(type: type, text: text))
            }
        }

        var cursor = 0
        while cursor < count {
            let character = characters[cursor]

            if character == "\\" {
                let end = min(cursor + 2, count)
                push(.plain, cursor..<end)
                cursor = end
                continue
            }

            if character == "'" || character == "`" {
                let quote = character
                let start = cursor
                cursor += 1
                while cursor < count {
                    if characters[cursor] == "\\" && quote == "`" {
                        cursor = min(cursor + 2, count)
                    } else {
                        let current = characters[cursor]
                        cursor += 1
                        if current == quote { break }
                    }
                }
                push(.string, start..<cursor)
                continue
            }

            if character == "\"" {
                var segmentStart = cursor
                cursor += 1
                while cursor < count {
                    if characters[cursor] == "\\" {
                        cursor = min(cursor + 2, count)
                        continue
                    }
                    if characters[cursor] == "$" {
                        let end = variableEnd(characters, cursor)
                        if end > cursor {
                            push(.string, segmentStart..<cursor)
                            push(.variable, cursor..<end)
                            cursor = end
                            segmentStart = cursor
                            continue
                        }
                    }
                    let current = characters[cursor]
                    cursor += 1
                    if current == "\"" { break }
                }
                push(.string, segmentStart..<cursor)
                continue
            }

            if character == "$" {
                let end = variableEnd(characters, cursor)
                if end > cursor {
                    push(.variable, cursor..<end)
                    cursor = end
                    continue
                }
            }

            if character == "#",
               cursor == 0 || isShellWhitespace(characters[cursor - 1]) || isOperatorCharacter(characters[cursor - 1]) {
                let start = cursor
                while cursor < count && characters[cursor] != "\n" { cursor += 1 }
                push(.comment, start..<cursor)
                continue
            }

            if isOperatorCharacter(character) {
                let start = cursor
                cursor += 1
                while cursor < count && isOperatorCharacter(characters[cursor]) { cursor += 1 }
                push(.operator, start..<cursor)
                continue
            }

            let start = cursor
            cursor += 1
            while cursor < count {
                let next = characters[cursor]
                if next == "\\" || next == "'" || next == "`" || next == "\"" || next == "$"
                    || isOperatorCharacter(next)
                    || (next == "#" && (isShellWhitespace(characters[cursor - 1]) || isOperatorCharacter(characters[cursor - 1]))) {
                    break
                }
                cursor += 1
            }
            push(.plain, start..<cursor)
        }

        return tokens
    }
}
