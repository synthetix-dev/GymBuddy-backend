import XCTest
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

        let storage = InMemorySecureTokenStorage(accessToken: "jwt_123")
        let client = GymBuddyAPIClient(baseURL: URL(string: "https://api.gymbuddy.app/v1")!, tokenStorage: storage)
        let idem = UUID()
        let req = try await client.makeAuthorizedRequest(path: "/conversations/123/messages", method: "POST", idempotencyKey: idem)
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer jwt_123")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Idempotency-Key"), idem.uuidString.lowercased())
    }
}
