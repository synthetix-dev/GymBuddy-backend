import Foundation

public protocol SecureTokenStorage: Sendable {
    func getAccessToken() async -> String?
    func getRefreshToken() async -> String?
    func saveTokens(access: String, refresh: String) async
    func clearTokens() async
}

public actor InMemorySecureTokenStorage: SecureTokenStorage {
    private var accessToken: String?
    private var refreshToken: String?

    public init(accessToken: String? = nil, refreshToken: String? = nil) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
    }

    public func getAccessToken() async -> String? { accessToken }
    public func getRefreshToken() async -> String? { refreshToken }
    public func saveTokens(access: String, refresh: String) async {
        self.accessToken = access
        self.refreshToken = refresh
    }
    public func clearTokens() async {
        self.accessToken = nil
        self.refreshToken = nil
    }
}

public actor GymBuddyAPIClient {
    public let baseURL: URL
    private let tokenStorage: SecureTokenStorage
    private let urlSession: URLSession

    public init(
        baseURL: URL,
        tokenStorage: SecureTokenStorage,
        urlSession: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.tokenStorage = tokenStorage
        self.urlSession = urlSession
    }

    public func makeAuthorizedRequest(
        path: String,
        method: String = "GET",
        idempotencyKey: UUID? = nil,
        bodyData: Data? = nil
    ) async throws -> URLRequest {
        let endpoint = baseURL.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
        var request = URLRequest(url: endpoint)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("req_\(UUID().uuidString.lowercased())", forHTTPHeaderField: "X-Request-ID")

        if let token = await tokenStorage.getAccessToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let idempotencyKey {
            request.setValue(idempotencyKey.uuidString.lowercased(), forHTTPHeaderField: "Idempotency-Key")
        }
        if let bodyData {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = bodyData
        }
        return request
    }
}
