import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public actor GymBuddyRealtimeClient {
    public typealias TokenProvider = @Sendable () async -> String?
    public typealias CatchUpHandler = @Sendable () async -> Void

    private let endpoint: URL
    private let tokenProvider: TokenProvider
    private let catchUp: CatchUpHandler
    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var worker: Task<Void, Never>?
    private var topics = Set<String>()
    private var continuation: AsyncStream<RealtimeEnvelopeDTO>.Continuation?
    private var stopped = true

    public init(baseURL: URL, session: URLSession = .shared, tokenProvider: @escaping TokenProvider, catchUp: @escaping CatchUpHandler = {}) {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        var path = components.path
        if path.hasSuffix("/") { path.removeLast() }
        components.path = "\(path)/realtime"
        self.endpoint = components.url!
        self.session = session
        self.tokenProvider = tokenProvider
        self.catchUp = catchUp
    }

    public func events() -> AsyncStream<RealtimeEnvelopeDTO> {
        AsyncStream { continuation in
            self.continuation = continuation
            continuation.onTermination = { [weak self] _ in Task { await self?.disconnect() } }
        }
    }

    public func connect() {
        guard stopped else { return }
        stopped = false
        worker = Task { [weak self] in await self?.connectionLoop() }
    }

    public func disconnect() {
        stopped = true
        worker?.cancel()
        worker = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    public func subscribe(conversationID: UUID) async {
        let topic = "conversation:\(conversationID.uuidString.lowercased())"
        topics.insert(topic)
        try? await sendJSON(["action": "subscribe", "topic": topic])
    }

    private func connectionLoop() async {
        var attempt = 0
        while !stopped && !Task.isCancelled {
            guard let token = await tokenProvider() else {
                try? await Task.sleep(for: .seconds(2))
                continue
            }
            do {
                var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
                components.queryItems = [URLQueryItem(name: "token", value: token)]
                guard let url = components.url else { return }
                let socket = session.webSocketTask(with: url)
                task = socket
                socket.resume()
                if attempt > 0 { await catchUp() }
                attempt = 0
                for topic in topics { try await sendJSON(["action": "subscribe", "topic": topic]) }
                try await receiveLoop(socket)
            } catch is CancellationError {
                return
            } catch {
                task?.cancel(with: .abnormalClosure, reason: nil)
                task = nil
                attempt += 1
                let capped = min(30.0, pow(2.0, Double(min(attempt, 5))))
                let jitter = Double.random(in: 0...(capped * 0.25))
                try? await Task.sleep(for: .seconds(capped + jitter))
            }
        }
    }

    private func receiveLoop(_ socket: URLSessionWebSocketTask) async throws {
        while !stopped && !Task.isCancelled {
            let message = try await socket.receive()
            let data: Data
            switch message {
            case .data(let value): data = value
            case .string(let value): data = Data(value.utf8)
            @unknown default: continue
            }
            if let envelope = try? JSONDecoder().decode(RealtimeEnvelopeDTO.self, from: data) {
                continuation?.yield(envelope)
            }
        }
    }

    private func sendJSON(_ object: [String: String]) async throws {
        guard let task else { return }
        let data = try JSONSerialization.data(withJSONObject: object)
        try await task.send(.data(data))
    }
}
