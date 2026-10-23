import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public protocol SecureTokenStorage: Sendable {
    func getAccessToken() async -> String?
    func saveAccessToken(_ access: String) async
    func clearTokens() async
}

public actor InMemorySecureTokenStorage: SecureTokenStorage {
    private var accessToken: String?

    public init(accessToken: String? = nil) {
        self.accessToken = accessToken
    }

    public func getAccessToken() async -> String? { accessToken }
    public func saveAccessToken(_ access: String) async {
        self.accessToken = access
    }
    public func clearTokens() async {
        self.accessToken = nil
    }
}

public enum HTTPMethod: String, Sendable {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case patch = "PATCH"
    case delete = "DELETE"
}

public actor GymBuddyAPIClient {
    public let baseURL: URL
    private let tokenStorage: SecureTokenStorage
    private let urlSession: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

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
        query: [URLQueryItem] = [],
        idempotencyKey: UUID? = nil,
        authorized: Bool = true,
        bodyData: Data? = nil
    ) async throws -> URLRequest {
        let trimmed = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let baseEndpoint = baseURL.appendingPathComponent(trimmed)
        var components = URLComponents(url: baseEndpoint, resolvingAgainstBaseURL: false)
        if !query.isEmpty {
            components?.queryItems = query
        }
        let endpoint = components?.url ?? baseEndpoint
        var request = URLRequest(url: endpoint)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("req_\(UUID().uuidString.lowercased())", forHTTPHeaderField: "X-Request-ID")

        if authorized, let token = await tokenStorage.getAccessToken() {
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

    public func request<Response: Decodable & Sendable>(
        _ responseType: Response.Type = Response.self,
        path: String,
        method: HTTPMethod = .get,
        query: [URLQueryItem] = [],
        idempotencyKey: UUID? = nil,
        authorized: Bool = true
    ) async throws -> Response {
        let urlRequest = try await makeAuthorizedRequest(
            path: path,
            method: method.rawValue,
            query: query,
            idempotencyKey: idempotencyKey,
            authorized: authorized,
            bodyData: nil
        )
        return try await execute(urlRequest, decodeAs: responseType)
    }

    public func request<Response: Decodable & Sendable, Body: Encodable & Sendable>(
        _ responseType: Response.Type = Response.self,
        path: String,
        method: HTTPMethod = .post,
        query: [URLQueryItem] = [],
        idempotencyKey: UUID? = nil,
        authorized: Bool = true,
        body: Body
    ) async throws -> Response {
        let bodyData = try encoder.encode(body)
        let urlRequest = try await makeAuthorizedRequest(
            path: path,
            method: method.rawValue,
            query: query,
            idempotencyKey: idempotencyKey,
            authorized: authorized,
            bodyData: bodyData
        )
        return try await execute(urlRequest, decodeAs: responseType)
    }

    public func requestVoid(
        path: String,
        method: HTTPMethod = .post,
        query: [URLQueryItem] = [],
        idempotencyKey: UUID? = nil,
        authorized: Bool = true
    ) async throws {
        let urlRequest = try await makeAuthorizedRequest(
            path: path,
            method: method.rawValue,
            query: query,
            idempotencyKey: idempotencyKey,
            authorized: authorized,
            bodyData: nil
        )
        _ = try await executeRaw(urlRequest)
    }

    public func requestVoid<Body: Encodable & Sendable>(
        path: String,
        method: HTTPMethod = .post,
        query: [URLQueryItem] = [],
        idempotencyKey: UUID? = nil,
        authorized: Bool = true,
        body: Body
    ) async throws {
        let bodyData = try encoder.encode(body)
        let urlRequest = try await makeAuthorizedRequest(
            path: path,
            method: method.rawValue,
            query: query,
            idempotencyKey: idempotencyKey,
            authorized: authorized,
            bodyData: bodyData
        )
        _ = try await executeRaw(urlRequest)
    }

    private func executeRaw(_ urlRequest: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await urlSession.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200..<300).contains(http.statusCode) else {
            if let problem = try? decoder.decode(APIProblemDetails.self, from: data) {
                throw problem
            }
            throw URLError(.badServerResponse)
        }
        return (data, http)
    }

    private func execute<Response: Decodable & Sendable>(
        _ urlRequest: URLRequest,
        decodeAs responseType: Response.Type
    ) async throws -> Response {
        let (data, _) = try await executeRaw(urlRequest)
        return try decoder.decode(responseType, from: data)
    }
}
