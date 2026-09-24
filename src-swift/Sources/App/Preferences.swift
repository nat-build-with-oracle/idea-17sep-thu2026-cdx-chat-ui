import Foundation

/// Mirrors the localStorage keys App.tsx persists. Keys are namespaced per backend origin
/// so drafts and selection never leak between a local and a remote backend; appearance is
/// deliberately global, as in the web build.
struct Preferences {
    private let defaults: UserDefaults
    private let target: BackendTarget

    init(target: BackendTarget, defaults: UserDefaults = .standard) {
        self.target = target
        self.defaults = defaults
    }

    // MARK: - Global

    var appearance: Theme {
        get {
            let name = ThemeName(rawValue: defaults.string(forKey: "cc:appearance:theme") ?? "") ?? .pop
            let size = ReadingSize(rawValue: defaults.string(forKey: "cc:appearance:size") ?? "") ?? .comfortable
            return Theme(name: name, readingSize: size)
        }
        nonmutating set {
            defaults.set(newValue.name.rawValue, forKey: "cc:appearance:theme")
            defaults.set(newValue.readingSize.rawValue, forKey: "cc:appearance:size")
        }
    }

    static var backendAddress: String? {
        get { UserDefaults.standard.string(forKey: "cc:backend-address") }
        set { UserDefaults.standard.set(newValue, forKey: "cc:backend-address") }
    }

    // MARK: - Per backend

    var selectedChatId: String? {
        get { string("selected") }
        nonmutating set { set("selected", newValue) }
    }

    var projectId: String? {
        get { string("project") }
        nonmutating set { set("project", newValue) }
    }

    var followLatest: Bool {
        get { defaults.object(forKey: key("follow-latest")) as? Bool ?? true }
        nonmutating set { defaults.set(newValue, forKey: key("follow-latest")) }
    }

    var hiddenRepositories: Set<String> {
        get { Set(defaults.stringArray(forKey: key("hidden-repositories")) ?? []) }
        nonmutating set { defaults.set(Array(newValue), forKey: key("hidden-repositories")) }
    }

    var projectSearchScope: String? {
        get { string("project-search-scope") }
        nonmutating set { set("project-search-scope", newValue) }
    }

    var repositoryPreferences: SerializedRepositoryPreferences? {
        get {
            guard let data = defaults.data(forKey: key("repository-preferences")) else { return nil }
            return try? APIClient.decoder.decode(SerializedRepositoryPreferences.self, from: data)
        }
        nonmutating set {
            guard let newValue, let data = try? APIClient.encoder.encode(newValue) else {
                defaults.removeObject(forKey: key("repository-preferences"))
                return
            }
            defaults.set(data, forKey: key("repository-preferences"))
        }
    }

    func draft(for scope: String) -> String {
        string("draft:\(scope)") ?? ""
    }

    func setDraft(_ value: String, for scope: String) {
        set("draft:\(scope)", value.isEmpty ? nil : value)
    }

    func mentions(for scope: String) -> [String] {
        defaults.stringArray(forKey: key("mentions:\(scope)")) ?? []
    }

    func setMentions(_ value: [String], for scope: String) {
        if value.isEmpty {
            defaults.removeObject(forKey: key("mentions:\(scope)"))
        } else {
            defaults.set(value, forKey: key("mentions:\(scope)"))
        }
    }

    // MARK: - Plumbing

    private func key(_ name: String) -> String { target.storageKey(name) }

    private func string(_ name: String) -> String? {
        defaults.string(forKey: key(name))
    }

    private func set(_ name: String, _ value: String?) {
        if let value {
            defaults.set(value, forKey: key(name))
        } else {
            defaults.removeObject(forKey: key(name))
        }
    }
}
