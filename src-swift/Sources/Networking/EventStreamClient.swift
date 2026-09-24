import Foundation

enum StreamEvent: Sendable {
    case connected
    case state(AppState)
    case disconnected(String?)
}

/// `GET /api/events` is Server-Sent Events with exactly one event type, `state`, whose
/// payload is a complete AppState snapshot. Foundation has no EventSource, so frames are
/// parsed off `URLSession.bytes(for:)`.
final class EventStreamClient: Sendable {
    private let client: APIClient
    private let session: URLSession

    init(client: APIClient) {
        self.client = client
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 3600
        configuration.timeoutIntervalForResource = .infinity
        configuration.httpShouldSetCookies = true
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        self.session = URLSession(configuration: configuration)
    }

    func events() -> AsyncStream<StreamEvent> {
        AsyncStream { continuation in
            let task = Task {
                var backoff: Duration = .milliseconds(500)
                while !Task.isCancelled {
                    do {
                        try await self.consume(into: continuation)
                        backoff = .milliseconds(500)
                        continuation.yield(.disconnected(nil))
                    } catch is CancellationError {
                        break
                    } catch {
                        continuation.yield(.disconnected(error.localizedDescription))
                    }
                    if Task.isCancelled { break }
                    try? await Task.sleep(for: backoff)
                    backoff = min(backoff * 2, .seconds(10))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func consume(into continuation: AsyncStream<StreamEvent>.Continuation) async throws {
        var request = client.makeRequest("GET", "/api/events")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 3600

        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(status: 0, message: "Malformed event stream response")
        }
        guard http.statusCode == 200 else {
            for try await _ in bytes { break }
            throw APIError(status: http.statusCode, message: HTTPURLResponse.localizedString(forStatusCode: http.statusCode))
        }
        continuation.yield(.connected)

        var eventName = "message"
        var data = Data()
        var line = Data()

        // Frames are delimited by a blank line, and AsyncLineSequence drops those, so the
        // stream is split on newlines by hand.
        for try await byte in bytes {
            guard byte == 0x0A else {
                line.append(byte)
                continue
            }
            if line.last == 0x0D { line.removeLast() }
            defer { line.removeAll(keepingCapacity: true) }

            if line.isEmpty {
                if eventName == "state", !data.isEmpty {
                    do {
                        continuation.yield(.state(try APIClient.decoder.decode(AppState.self, from: data)))
                    } catch {
                        continuation.yield(.disconnected("Could not read a state update: \(error.localizedDescription)"))
                    }
                }
                eventName = "message"
                data.removeAll(keepingCapacity: true)
                continue
            }
            if line.first == 0x3A { continue }  // keepalive comment
            guard let separator = line.firstIndex(of: 0x3A) else { continue }
            let field = String(decoding: line[line.startIndex..<separator], as: UTF8.self)
            var value = line[line.index(after: separator)...]
            if value.first == 0x20 { value = value.dropFirst() }
            switch field {
            case "event": eventName = String(decoding: value, as: UTF8.self)
            case "data":
                if !data.isEmpty { data.append(0x0A) }
                data.append(contentsOf: value)
            default: break
            }
        }
    }
}
