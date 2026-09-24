import SwiftUI

@main
struct ARRAChatApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
                .frame(minWidth: 860, minHeight: Metrics.workspaceMinHeight)
        }
        .defaultSize(width: 1280, height: 860)
        .windowToolbarStyle(.unified)
    }
}
