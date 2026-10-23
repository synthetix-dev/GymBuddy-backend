import Foundation

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
