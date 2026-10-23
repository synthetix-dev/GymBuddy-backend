import Foundation

public extension GymBuddyAPIClient {
    // MARK: Authentication
    func signInWithApple(_ body: AppleSignInRequestDTO) async throws -> AuthSessionDTO {
        let envelope: DataEnvelope<AuthSessionDTO> = try await request(path: "auth/apple", method: .post, authorized: false, body: body)
        return envelope.data
    }

    // MARK: Session/Profile
    func bootstrap() async throws -> BootstrapPayloadDTO {
        let envelope: DataEnvelope<BootstrapPayloadDTO> = try await request(path: "me/bootstrap")
        return envelope.data
    }

    func getMyProfile() async throws -> ProfileDTO {
        let envelope: DataEnvelope<ProfileDTO> = try await request(path: "me/profile")
        return envelope.data
    }

    func updateMyProfile(_ body: ProfilePatchDTO, idempotencyKey: UUID = UUID()) async throws -> ProfileDTO {
        let envelope: DataEnvelope<ProfileDTO> = try await request(path: "me/profile", method: .patch, idempotencyKey: idempotencyKey, body: body)
        return envelope.data
    }

    func getProfile(id: UUID) async throws -> ProfileDTO {
        let envelope: DataEnvelope<ProfileDTO> = try await request(path: "profiles/\(id.uuidString.lowercased())")
        return envelope.data
    }

    func getSettings() async throws -> UserSettingsDTO {
        let envelope: DataEnvelope<UserSettingsDTO> = try await request(path: "me/settings")
        return envelope.data
    }

    func updateSettings(_ body: SettingsPatchDTO) async throws -> UserSettingsDTO {
        let envelope: DataEnvelope<UserSettingsDTO> = try await request(path: "me/settings", method: .patch, body: body)
        return envelope.data
    }

    // MARK: Discover
    func discover(cursor: String? = nil, limit: Int = 20, radiusKm: Int? = nil) async throws -> PaginatedEnvelope<ProfileDTO> {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        if let radiusKm { query.append(URLQueryItem(name: "radius_km", value: String(radiusKm))) }
        return try await request(path: "discover", query: query)
    }

    func performDiscoverAction(profileID: UUID, action: String, idempotencyKey: UUID = UUID()) async throws {
        let body = DiscoverActionRequestDTO(action: action)
        _ = try await request(DataEnvelope<DiscoverActionResultDTO>.self, path: "discover/\(profileID.uuidString.lowercased())/actions", method: .post, idempotencyKey: idempotencyKey, body: body)
    }

    // MARK: Feed
    func feed(cursor: String? = nil, limit: Int = 20, mode: String = "for_you") async throws -> PaginatedEnvelope<PostDTO> {
        var query = [URLQueryItem(name: "limit", value: String(limit)), URLQueryItem(name: "mode", value: mode)]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await request(path: "feed", query: query)
    }

    func createPost(_ body: CreatePostRequestDTO, idempotencyKey: UUID = UUID()) async throws -> PostDTO {
        let envelope: DataEnvelope<PostDTO> = try await request(path: "posts", method: .post, idempotencyKey: idempotencyKey, body: body)
        return envelope.data
    }

    func setPostLiked(id: UUID, liked: Bool) async throws {
        if liked {
            _ = try await request(DataEnvelope<PostInteractionDTO>.self, path: "posts/\(id.uuidString.lowercased())/like", method: .put)
        } else {
            _ = try await request(DataEnvelope<PostInteractionDTO>.self, path: "posts/\(id.uuidString.lowercased())/like", method: .delete)
        }
    }

    func setPostSaved(id: UUID, saved: Bool) async throws {
        try await requestVoid(path: "posts/\(id.uuidString.lowercased())/save", method: saved ? .put : .delete)
    }

    // MARK: Chat
    func conversations(archived: Bool = false) async throws -> PaginatedEnvelope<ConversationDTO> {
        try await request(path: "conversations", query: [URLQueryItem(name: "archived", value: archived ? "true" : "false")])
    }

    func createConversation(participantID: UUID, idempotencyKey: UUID = UUID()) async throws -> ConversationDTO {
        let envelope: DataEnvelope<ConversationDTO> = try await request(path: "conversations", method: .post, idempotencyKey: idempotencyKey, body: ParticipantRequestDTO(participantId: participantID))
        return envelope.data
    }

    func messages(conversationID: UUID, afterSequence: Int? = nil, beforeSequence: Int? = nil, limit: Int = 50) async throws -> PaginatedEnvelope<MessageDTO> {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let afterSequence { query.append(URLQueryItem(name: "after_seq", value: String(afterSequence))) }
        if let beforeSequence { query.append(URLQueryItem(name: "before_seq", value: String(beforeSequence))) }
        return try await request(path: "conversations/\(conversationID.uuidString.lowercased())/messages", query: query)
    }

    func sendMessage(conversationID: UUID, body: SendMessageRequestDTO, idempotencyKey: UUID = UUID()) async throws -> MessageDTO {
        let envelope: DataEnvelope<MessageDTO> = try await request(path: "conversations/\(conversationID.uuidString.lowercased())/messages", method: .post, idempotencyKey: idempotencyKey, body: body)
        return envelope.data
    }

    func updateReadState(conversationID: UUID, lastReadSequence: Int) async throws {
        _ = try await request(DataEnvelope<ReadStateResultDTO>.self, path: "conversations/\(conversationID.uuidString.lowercased())/read-state", method: .put, body: ReadStateRequestDTO(lastReadSeq: lastReadSequence))
    }

    func sendTyping(conversationID: UUID, isTyping: Bool) async throws {
        try await requestVoid(path: "conversations/\(conversationID.uuidString.lowercased())/typing", method: .post, body: TypingRequestDTO(isTyping: isTyping))
    }

    // MARK: Media
    func createUploadIntent(_ body: UploadIntentRequestDTO, idempotencyKey: UUID = UUID()) async throws -> UploadIntentDTO {
        let envelope: DataEnvelope<UploadIntentDTO> = try await request(path: "me/photos/upload-intents", method: .post, idempotencyKey: idempotencyKey, body: body)
        return envelope.data
    }

    func completeUpload(mediaID: UUID, body: CompleteUploadRequestDTO, idempotencyKey: UUID = UUID()) async throws -> MediaReadyDTO {
        let envelope: DataEnvelope<MediaReadyDTO> = try await request(path: "me/photos/\(mediaID.uuidString.lowercased())/complete", method: .post, idempotencyKey: idempotencyKey, body: body)
        return envelope.data
    }

    // MARK: Push
    func registerPushDevice(_ body: PushDeviceRequestDTO) async throws -> PushDeviceDTO {
        let envelope: DataEnvelope<PushDeviceDTO> = try await request(path: "push-devices", method: .post, body: body)
        return envelope.data
    }

    func revokePushDevice(id: UUID) async throws {
        try await requestVoid(path: "push-devices/\(id.uuidString.lowercased())", method: .delete)
    }

    // MARK: Workouts
    func workoutSessions(state: String = "upcoming") async throws -> PaginatedEnvelope<WorkoutSessionDTO> {
        try await request(path: "me/workout-sessions", query: [URLQueryItem(name: "state", value: state)])
    }

    func createWorkoutSession(_ body: CreateWorkoutSessionRequestDTO, idempotencyKey: UUID = UUID()) async throws -> WorkoutSessionDTO {
        let envelope: DataEnvelope<WorkoutSessionDTO> = try await request(path: "workout-sessions", method: .post, idempotencyKey: idempotencyKey, body: body)
        return envelope.data
    }

    func inviteToWorkout(sessionID: UUID, body: WorkoutInvitationRequestDTO, idempotencyKey: UUID = UUID()) async throws -> WorkoutInvitationDTO {
        let envelope: DataEnvelope<WorkoutInvitationDTO> = try await request(path: "workout-sessions/\(sessionID.uuidString.lowercased())/invitations", method: .post, idempotencyKey: idempotencyKey, body: body)
        return envelope.data
    }

    func transitionWorkoutInvitation(id: UUID, action: String, version: Int, idempotencyKey: UUID = UUID()) async throws -> WorkoutInvitationDTO {
        let envelope: DataEnvelope<WorkoutInvitationDTO> = try await request(path: "workout-invitations/\(id.uuidString.lowercased())/\(action)", method: .post, idempotencyKey: idempotencyKey, body: VersionRequestDTO(version: version))
        return envelope.data
    }
}

public struct DiscoverActionResultDTO: Codable, Sendable, Equatable { public let action: String?; public let connected: Bool? }
public struct PostInteractionDTO: Codable, Sendable, Equatable { public let isLiked: Bool?; public let likesCount: Int?; enum CodingKeys: String, CodingKey { case isLiked = "is_liked"; case likesCount = "likes_count" } }
public struct ReadStateResultDTO: Codable, Sendable, Equatable { public let lastReadSeq: Int; enum CodingKeys: String, CodingKey { case lastReadSeq = "last_read_seq" } }
