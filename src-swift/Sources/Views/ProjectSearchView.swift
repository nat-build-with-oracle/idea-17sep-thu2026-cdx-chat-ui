import SwiftUI

/// Port of src/project-search.ts.
enum ProjectSearchScope: String, CaseIterable, Sendable {
    case all, project, oracle

    var label: String {
        switch self {
        case .all: return "All"
        case .project: return "Projects"
        case .oracle: return "Oracles"
        }
    }

    static func parse(_ value: String?) -> ProjectSearchScope {
        ProjectSearchScope(rawValue: value ?? "") ?? .all
    }
}

enum ProjectSearch {
    static func isOracle(_ repository: Repository) -> Bool {
        var path = repository.path
        while path.hasSuffix("/") { path.removeLast() }
        return path.split(separator: "/").last?.lowercased().hasSuffix("-oracle") ?? false
    }

    static func matches(
        _ repositories: [Repository],
        query: String,
        scope: ProjectSearchScope
    ) -> [Repository] {
        var needle = query.trimmingCharacters(in: .whitespaces)
        if needle.hasPrefix("@") { needle.removeFirst() }
        needle = needle.trimmingCharacters(in: .whitespaces).lowercased()
        return repositories.filter { repository in
            let oracle = isOracle(repository)
            let inScope = scope == .all || (scope == .oracle ? oracle : !oracle)
            return inScope && "\(repository.name) \(repository.path)".lowercased().contains(needle)
        }
    }
}

/// ⌘K modal, mirroring ProjectSearch.tsx.
struct ProjectSearchView: View {
    @Environment(\.theme) private var theme
    @Bindable var store: AppStore
    @Binding var isPresented: Bool

    @State private var query = ""
    @State private var scope: ProjectSearchScope = .all
    @State private var highlighted = 0
    @FocusState private var focused: Bool

    private static let rowLimit = 100

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            TextField("Search repositories", text: $query)
                .textFieldStyle(.plain)
                .font(theme.reader())
                .focused($focused)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(theme.palette.raised, in: .rect(cornerRadius: Metrics.Radius.button))
                .onSubmit { open(results.indices.contains(highlighted) ? results[highlighted] : nil) }

            HStack(spacing: 8) {
                ForEach(ProjectSearchScope.allCases, id: \.self) { option in
                    Button(option.label) {
                        scope = option
                        highlighted = 0
                        store.preferences.projectSearchScope = option.rawValue
                    }
                    .buttonStyle(.plain)
                    .font(theme.ui(scope == option ? .semibold : .regular))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .foregroundStyle(scope == option ? theme.palette.canvas : theme.palette.ink)
                    .background(scope == option ? theme.palette.ink : theme.palette.raised, in: .capsule)
                }
                Spacer()
                Text("\(results.count) matches")
                    .font(theme.ui(scale: 0.8))
                    .foregroundStyle(theme.palette.placeholder)
            }

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(results.enumerated()), id: \.element.id) { index, repository in
                            Button { open(repository) } label: {
                                HStack(spacing: 10) {
                                    ProjectAvatar(name: repository.name, size: 26)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(repository.name)
                                            .font(theme.ui())
                                            .foregroundStyle(theme.palette.ink)
                                        Text(repository.path)
                                            .font(theme.ui(scale: 0.78))
                                            .foregroundStyle(theme.palette.placeholder)
                                            .lineLimit(1)
                                            .truncationMode(.head)
                                    }
                                    Spacer()
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 7)
                                .background(
                                    index == highlighted ? theme.palette.hover : .clear,
                                    in: .rect(cornerRadius: Metrics.Radius.projectRow)
                                )
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .id(repository.id)
                        }
                    }
                }
                .frame(height: 360)
                .onChange(of: highlighted) { _, index in
                    guard results.indices.contains(index) else { return }
                    proxy.scrollTo(results[index].id, anchor: .center)
                }
            }
        }
        .padding(22)
        .frame(width: 620)
        .background(theme.palette.panel, in: .rect(cornerRadius: Metrics.Radius.dialog))
        .onAppear {
            scope = ProjectSearchScope.parse(store.preferences.projectSearchScope)
            focused = true
        }
        .onKeyPress(.downArrow) {
            highlighted = min(highlighted + 1, max(results.count - 1, 0))
            return .handled
        }
        .onKeyPress(.upArrow) {
            highlighted = max(highlighted - 1, 0)
            return .handled
        }
        .onKeyPress(.escape) {
            isPresented = false
            return .handled
        }
    }

    private var results: [Repository] {
        Array(
            ProjectSearch.matches(store.repositoryInventory.repositories, query: query, scope: scope)
                .prefix(Self.rowLimit)
        )
    }

    private func open(_ repository: Repository?) {
        guard let repository else { return }
        isPresented = false
        Task {
            do {
                let project = try await store.client.createProject(name: repository.name, path: repository.path)
                store.projectId = project.id
                store.route = .new(projectId: project.id)
            } catch {
                store.show(error: error)
            }
        }
    }
}
