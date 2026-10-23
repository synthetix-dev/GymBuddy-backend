import fs from 'node:fs/promises';
import path from 'node:path';

export async function generateSwiftSdk(): Promise<{ packageDir: string; files: string[] }> {
  const packageDir = path.resolve(process.cwd(), 'sdk/swift/GymBuddyBackendSDK');
  const sourcesDir = path.join(packageDir, 'Sources/GymBuddyBackendSDK');
  const testsDir = path.join(packageDir, 'Tests/GymBuddyBackendSDKTests');

  await fs.mkdir(sourcesDir, { recursive: true });
  await fs.mkdir(testsDir, { recursive: true });

  const packageSwift = `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "GymBuddyBackendSDK",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "GymBuddyBackendSDK",
            targets: ["GymBuddyBackendSDK"]
        )
    ],
    targets: [
        .target(
            name: "GymBuddyBackendSDK",
            path: "Sources/GymBuddyBackendSDK"
        ),
        .testTarget(
            name: "GymBuddyBackendSDKTests",
            dependencies: ["GymBuddyBackendSDK"],
            path: "Tests/GymBuddyBackendSDKTests"
        )
    ]
)
`;

  const dtosSwift = `import Foundation

// =============================================================================
// Generated from openapi/openapi.yaml (08-API-CONTRACT.md & 09-IOS-INTEGRATION.md)
// =============================================================================

public struct APIPage: Codable, Sendable, Equatable {
    public let nextCursor: String?
    public let hasMore: Bool

    enum CodingKeys: String, CodingKey {
        case nextCursor = "next_cursor"
        case hasMore = "has_more"
    }
}

public struct APIProblemErrorField: Codable, Sendable, Equatable {
    public let field: String
    public let reason: String
}

public struct APIProblemDetails: Codable, Error, Sendable, Equatable {
    public let type: String
    public let title: String
    public let status: Int
    public let code: String
    public let detail: String?
    public let requestId: String
    public let errors: [APIProblemErrorField]?

    enum CodingKeys: String, CodingKey {
        case type, title, status, code, detail, errors
        case requestId = "request_id"
    }
}

public enum OnboardingNextStep: String, Codable, Sendable {
    case profile
    case permissions
    case discover
}

public enum AccountStatusDTO: String, Codable, Sendable {
    case active
    case suspended
    case deletionPending = "deletion_pending"
    case deleted
}

public struct InterestDTO: Codable, Sendable, Equatable, Identifiable {
    public let id: UUID
    public let slug: String
    public let label: String
    public let proficiency: String
}

public struct PhotoDTO: Codable, Sendable, Equatable, Identifiable {
    public let id: UUID
    public let mediaObjectId: UUID
    public let position: Int
    public let isAvatar: Bool
    public let url: String

    enum CodingKeys: String, CodingKey {
        case id, position, url
        case mediaObjectId = "media_object_id"
        case isAvatar = "is_avatar"
    }
}

public struct ProfileDTO: Codable, Sendable, Equatable, Identifiable {
    public let id: UUID
    public let publicCode: String
    public let displayName: String
    public let bio: String
    public let genderCode: String?
    public let ageYears: Int?
    public let experienceLevel: String?
    public let preferredTime: String?
    public let homeGymId: UUID?
    public let homeGymName: String?
    public let cityLabel: String?
    public let distanceKm: Double?
    public let compatibilityScore: Int?
    public let version: Int

    enum CodingKeys: String, CodingKey {
        case id, bio, version
        case publicCode = "public_code"
        case displayName = "display_name"
        case genderCode = "gender_code"
        case ageYears = "age_years"
        case experienceLevel = "experience_level"
        case preferredTime = "preferred_time"
        case homeGymId = "home_gym_id"
        case homeGymName = "home_gym_name"
        case cityLabel = "city_label"
        case distanceKm = "distance_km"
        case compatibilityScore = "compatibility_score"
    }
}

public struct BootstrapPayloadDTO: Codable, Sendable, Equatable {
    public let nextStep: OnboardingNextStep
    public let accountStatus: AccountStatusDTO
    public let profile: ProfileDTO?
    public let unreadNotificationsCount: Int?

    enum CodingKeys: String, CodingKey {
        case profile
        case nextStep = "next_step"
        case accountStatus = "account_status"
        case unreadNotificationsCount = "unread_notifications_count"
    }
}

public struct DataEnvelope<T: Codable & Sendable>: Codable, Sendable {
    public let data: T
}

public struct PaginatedEnvelope<T: Codable & Sendable>: Codable, Sendable {
    public let data: [T]
    public let page: APIPage
}

public struct MessageDTO: Codable, Sendable, Equatable, Identifiable {
    public let id: UUID
    public let conversationId: UUID
    public let senderId: UUID?
    public let clientMessageId: UUID
    public let serverSeq: Int
    public let kind: String
    public let body: String
    public let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, kind, body
        case conversationId = "conversation_id"
        case senderId = "sender_id"
        case clientMessageId = "client_message_id"
        case serverSeq = "server_seq"
        case createdAt = "created_at"
    }
}

public struct SendMessageRequestDTO: Codable, Sendable, Equatable {
    public let clientMessageId: UUID
    public let kind: String
    public let body: String?
    public let attachmentIds: [UUID]?

    public init(clientMessageId: UUID, kind: String = "text", body: String? = nil, attachmentIds: [UUID]? = nil) {
        self.clientMessageId = clientMessageId
        self.kind = kind
        self.body = body
        self.attachmentIds = attachmentIds
    }

    enum CodingKeys: String, CodingKey {
        case kind, body
        case clientMessageId = "client_message_id"
        case attachmentIds = "attachment_ids"
    }
}

public struct RealtimeEnvelopeDTO: Codable, Sendable, Equatable {
    public let eventId: String
    public let type: String
    public let occurredAt: String
    public let aggregateId: String
    public let sequence: Int?

    enum CodingKeys: String, CodingKey {
        case type, sequence
        case eventId = "event_id"
        case occurredAt = "occurred_at"
        case aggregateId = "aggregate_id"
    }
}
`;

  const clientSwift = `import Foundation

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
        request.setValue("req_\\(UUID().uuidString.lowercased())", forHTTPHeaderField: "X-Request-ID")

        if let token = await tokenStorage.getAccessToken() {
            request.setValue("Bearer \\(token)", forHTTPHeaderField: "Authorization")
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
`;

  const testsSwift = `import XCTest
@testable import GymBuddyBackendSDK

final class GymBuddySDKTests: XCTestCase {
    func testDecodeProblemDetails() throws {
        let json = """
        {
          "type": "https://api.gymbuddy.app/problems/version-conflict",
          "title": "Version conflict",
          "status": 409,
          "code": "VERSION_CONFLICT",
          "detail": "Resource changed; refresh and retry.",
          "request_id": "req_01",
          "errors": [{"field": "version", "reason": "stale"}]
        }
        """.data(using: .utf8)!

        let problem = try JSONDecoder().decode(APIProblemDetails.self, from: json)
        XCTAssertEqual(problem.status, 409)
        XCTAssertEqual(problem.code, "VERSION_CONFLICT")
        XCTAssertEqual(problem.errors?.first?.field, "version")
    }

    func testDecodeBootstrapAndMessageEnvelope() async throws {
        let msgJson = """
        {
          "data": {
            "id": "99a00000-0000-4000-8000-000000000001",
            "conversation_id": "8b000000-0000-4000-8000-000000000001",
            "client_message_id": "4ac00000-0000-4000-8000-000000000001",
            "server_seq": 91,
            "kind": "text",
            "body": "Thursday at 18:00 works!",
            "created_at": "2026-10-23T16:31:04Z"
          }
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(DataEnvelope<MessageDTO>.self, from: msgJson)
        XCTAssertEqual(decoded.data.serverSeq, 91)
        XCTAssertEqual(decoded.data.body, "Thursday at 18:00 works!")

        let storage = InMemorySecureTokenStorage(accessToken: "jwt_123", refreshToken: "ref_123")
        let client = GymBuddyAPIClient(baseURL: URL(string: "https://api.gymbuddy.app/v1")!, tokenStorage: storage)
        let idem = UUID()
        let req = try await client.makeAuthorizedRequest(path: "/conversations/123/messages", method: "POST", idempotencyKey: idem)
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer jwt_123")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Idempotency-Key"), idem.uuidString.lowercased())
    }
}
`;

  const files = [
    path.join(packageDir, 'Package.swift'),
    path.join(sourcesDir, 'GymBuddyDTOs.swift'),
    path.join(sourcesDir, 'GymBuddyAPIClient.swift'),
    path.join(testsDir, 'GymBuddySDKTests.swift'),
  ];

  await fs.writeFile(files[0]!, packageSwift, 'utf8');
  await fs.writeFile(files[1]!, dtosSwift, 'utf8');
  await fs.writeFile(files[2]!, clientSwift, 'utf8');
  await fs.writeFile(files[3]!, testsSwift, 'utf8');

  return { packageDir, files };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateSwiftSdk()
    .then((res) => {
      console.log('Generated Swift 6 SDK at:', res.packageDir);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
