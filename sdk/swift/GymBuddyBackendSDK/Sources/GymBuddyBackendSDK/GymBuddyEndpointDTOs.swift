import Foundation

public struct AuthSessionDTO: Codable, Sendable, Equatable {
    public let accessToken: String
    public let refreshToken: String
    public let userId: UUID?
    public let sessionId: UUID?
    public let isNewUser: Bool?
    public let nextStep: OnboardingNextStep?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case userId = "user_id"
        case sessionId = "session_id"
        case isNewUser = "is_new_user"
        case nextStep = "next_step"
    }
}

public struct AppleSignInRequestDTO: Codable, Sendable, Equatable {
    public let appleSub: String
    public let email: String?
    public let displayName: String?
    public let nonce: String
    public let deviceName: String
    public let appVersion: String
    public let identityToken: String?
    public let authorizationCode: String?

    public init(appleSub: String, email: String?, displayName: String?, nonce: String, deviceName: String, appVersion: String, identityToken: String? = nil, authorizationCode: String? = nil) {
        self.appleSub = appleSub
        self.email = email
        self.displayName = displayName
        self.nonce = nonce
        self.deviceName = deviceName
        self.appVersion = appVersion
        self.identityToken = identityToken
        self.authorizationCode = authorizationCode
    }

    enum CodingKeys: String, CodingKey {
        case email, nonce
        case appleSub = "apple_sub"
        case displayName = "display_name"
        case deviceName = "device_name"
        case appVersion = "app_version"
        case identityToken = "identity_token"
        case authorizationCode = "authorization_code"
    }
}

public struct RefreshSessionRequestDTO: Codable, Sendable, Equatable {
    public let refreshToken: String
    public init(refreshToken: String) { self.refreshToken = refreshToken }
    enum CodingKeys: String, CodingKey { case refreshToken = "refresh_token" }
}

public struct ProfilePatchDTO: Codable, Sendable, Equatable {
    public var displayName: String?
    public var birthDate: String?
    public var genderCode: String?
    public var bio: String?
    public var experienceLevel: String?
    public var preferredTime: String?
    public var homeGymId: UUID?
    public var onboardingState: String?
    public var interestIds: [UUID]?
    public let version: Int

    public init(displayName: String? = nil, birthDate: String? = nil, genderCode: String? = nil, bio: String? = nil, experienceLevel: String? = nil, preferredTime: String? = nil, homeGymId: UUID? = nil, onboardingState: String? = nil, interestIds: [UUID]? = nil, version: Int) {
        self.displayName = displayName; self.birthDate = birthDate; self.genderCode = genderCode
        self.bio = bio; self.experienceLevel = experienceLevel; self.preferredTime = preferredTime
        self.homeGymId = homeGymId; self.onboardingState = onboardingState; self.interestIds = interestIds; self.version = version
    }

    enum CodingKeys: String, CodingKey {
        case bio, version
        case displayName = "display_name"
        case birthDate = "birth_date"
        case genderCode = "gender_code"
        case experienceLevel = "experience_level"
        case preferredTime = "preferred_time"
        case homeGymId = "home_gym_id"
        case onboardingState = "onboarding_state"
        case interestIds = "interest_ids"
    }
}

public struct UserSettingsDTO: Codable, Sendable, Equatable {
    public let discoveryRadiusKm: Int?
    public let discoveryVisible: Bool?
    public let showAge: Bool?
    public let showDistance: Bool?
    public let showOnlineStatus: Bool?
    public let pushEnabled: Bool?
    public let pushMessages: Bool?
    public let pushMessagePreview: Bool?
    public let pushWorkouts: Bool?
    public let pushSocial: Bool?
    public let quietHoursStart: String?
    public let quietHoursEnd: String?
    public let timezone: String?
    public let version: Int?

    enum CodingKeys: String, CodingKey {
        case timezone, version
        case discoveryRadiusKm = "discovery_radius_km"
        case discoveryVisible = "discovery_visible"
        case showAge = "show_age"
        case showDistance = "show_distance"
        case showOnlineStatus = "show_online_status"
        case pushEnabled = "push_enabled"
        case pushMessages = "push_messages"
        case pushMessagePreview = "push_message_preview"
        case pushWorkouts = "push_workouts"
        case pushSocial = "push_social"
        case quietHoursStart = "quiet_hours_start"
        case quietHoursEnd = "quiet_hours_end"
    }
}

public struct SettingsPatchDTO: Codable, Sendable, Equatable {
    public var discoveryRadiusKm: Int?
    public var discoveryVisible: Bool?
    public var showAge: Bool?
    public var showDistance: Bool?
    public var showOnlineStatus: Bool?
    public var pushEnabled: Bool?
    public var pushMessages: Bool?
    public var pushMessagePreview: Bool?
    public var pushWorkouts: Bool?
    public var pushSocial: Bool?
    public var quietHoursStart: String?
    public var quietHoursEnd: String?
    public var timezone: String?

    public init(discoveryRadiusKm: Int? = nil, discoveryVisible: Bool? = nil, showAge: Bool? = nil, showDistance: Bool? = nil, showOnlineStatus: Bool? = nil, pushEnabled: Bool? = nil, pushMessages: Bool? = nil, pushMessagePreview: Bool? = nil, pushWorkouts: Bool? = nil, pushSocial: Bool? = nil, quietHoursStart: String? = nil, quietHoursEnd: String? = nil, timezone: String? = nil) {
        self.discoveryRadiusKm = discoveryRadiusKm; self.discoveryVisible = discoveryVisible
        self.showAge = showAge; self.showDistance = showDistance; self.showOnlineStatus = showOnlineStatus
        self.pushEnabled = pushEnabled; self.pushMessages = pushMessages; self.pushMessagePreview = pushMessagePreview
        self.pushWorkouts = pushWorkouts; self.pushSocial = pushSocial
        self.quietHoursStart = quietHoursStart; self.quietHoursEnd = quietHoursEnd; self.timezone = timezone
    }

    enum CodingKeys: String, CodingKey {
        case timezone
        case discoveryRadiusKm = "discovery_radius_km"
        case discoveryVisible = "discovery_visible"
        case showAge = "show_age"
        case showDistance = "show_distance"
        case showOnlineStatus = "show_online_status"
        case pushEnabled = "push_enabled"
        case pushMessages = "push_messages"
        case pushMessagePreview = "push_message_preview"
        case pushWorkouts = "push_workouts"
        case pushSocial = "push_social"
        case quietHoursStart = "quiet_hours_start"
        case quietHoursEnd = "quiet_hours_end"
    }
}

public struct PostMediaDTO: Codable, Sendable, Equatable {
    public let mediaObjectId: UUID
    public let position: Int
    public let altText: String?
    public let url: String?
    enum CodingKeys: String, CodingKey { case position, url; case mediaObjectId = "media_object_id"; case altText = "alt_text" }
}

public struct RecipeIngredientDTO: Codable, Sendable, Equatable { public let position: Int?; public let text: String; public let quantity: Double?; public let unit: String? }
public struct RecipeStepDTO: Codable, Sendable, Equatable { public let position: Int?; public let instruction: String }
public struct RecipeDTO: Codable, Sendable, Equatable {
    public let title: String; public let subtitle: String?; public let difficulty: String?
    public let calories: Int; public let proteinG: Int?; public let carbsG: Int?; public let fatG: Int?
    public let prepMinutes: Int?; public let servings: Int?
    public let ingredients: [RecipeIngredientDTO]?; public let steps: [RecipeStepDTO]?
    enum CodingKeys: String, CodingKey { case title, subtitle, difficulty, calories, servings, ingredients, steps; case proteinG = "protein_g"; case carbsG = "carbs_g"; case fatG = "fat_g"; case prepMinutes = "prep_minutes" }
}

public struct WorkoutUpdateDTO: Codable, Sendable, Equatable {
    public let activity: String; public let durationMinutes: Int; public let caloriesBurned: Int?
    public let gymId: UUID?; public let gymName: String?
    enum CodingKeys: String, CodingKey { case activity; case durationMinutes = "duration_minutes"; case caloriesBurned = "calories_burned"; case gymId = "gym_id"; case gymName = "gym_name" }
}

public struct PostDTO: Codable, Sendable, Equatable, Identifiable {
    public let id: UUID; public let type: String; public let status: String?; public let author: ProfileDTO
    public let body: String; public let visibility: String?; public let likesCount: Int?; public let commentsCount: Int?
    public let savesCount: Int?; public let isLiked: Bool?; public let isSaved: Bool?; public let media: [PostMediaDTO]?
    public let recipe: RecipeDTO?; public let workout: WorkoutUpdateDTO?; public let feedReason: String?
    public let publishedAt: String?; public let createdAt: String; public let updatedAt: String?; public let version: Int
    enum CodingKeys: String, CodingKey {
        case id, type, status, author, body, visibility, media, recipe, workout, version
        case likesCount = "likes_count"; case commentsCount = "comments_count"; case savesCount = "saves_count"
        case isLiked = "is_liked"; case isSaved = "is_saved"; case feedReason = "feed_reason"
        case publishedAt = "published_at"; case createdAt = "created_at"; case updatedAt = "updated_at"
    }
}

public struct CreatePostRequestDTO: Codable, Sendable, Equatable {
    public let type: String; public let body: String; public let visibility: String?
    public let attachmentIds: [UUID]?; public let recipe: RecipeInputDTO?; public let workout: WorkoutInputDTO?
    public init(type: String, body: String, visibility: String? = nil, attachmentIds: [UUID]? = nil, recipe: RecipeInputDTO? = nil, workout: WorkoutInputDTO? = nil) {
        self.type = type; self.body = body; self.visibility = visibility; self.attachmentIds = attachmentIds; self.recipe = recipe; self.workout = workout
    }
    enum CodingKeys: String, CodingKey { case type, body, visibility, recipe, workout; case attachmentIds = "attachment_ids" }
}

public struct RecipeInputDTO: Codable, Sendable, Equatable {
    public let title: String; public let subtitle: String?; public let difficulty: String?; public let calories: Int
    public let proteinG: Int?; public let carbsG: Int?; public let fatG: Int?; public let prepMinutes: Int?; public let servings: Int?
    public let ingredients: [RecipeIngredientDTO]?; public let steps: [RecipeStepDTO]?
    public init(title: String, subtitle: String? = nil, difficulty: String? = nil, calories: Int, proteinG: Int? = nil, carbsG: Int? = nil, fatG: Int? = nil, prepMinutes: Int? = nil, servings: Int? = nil, ingredients: [RecipeIngredientDTO]? = nil, steps: [RecipeStepDTO]? = nil) {
        self.title = title; self.subtitle = subtitle; self.difficulty = difficulty; self.calories = calories; self.proteinG = proteinG; self.carbsG = carbsG; self.fatG = fatG; self.prepMinutes = prepMinutes; self.servings = servings; self.ingredients = ingredients; self.steps = steps
    }
    enum CodingKeys: String, CodingKey { case title, subtitle, difficulty, calories, servings, ingredients, steps; case proteinG = "protein_g"; case carbsG = "carbs_g"; case fatG = "fat_g"; case prepMinutes = "prep_minutes" }
}

public struct WorkoutInputDTO: Codable, Sendable, Equatable {
    public let activity: String; public let durationMinutes: Int; public let caloriesBurned: Int?; public let gymId: UUID?
    public init(activity: String, durationMinutes: Int, caloriesBurned: Int? = nil, gymId: UUID? = nil) { self.activity = activity; self.durationMinutes = durationMinutes; self.caloriesBurned = caloriesBurned; self.gymId = gymId }
    enum CodingKeys: String, CodingKey { case activity; case durationMinutes = "duration_minutes"; case caloriesBurned = "calories_burned"; case gymId = "gym_id" }
}

public struct ConversationDTO: Codable, Sendable, Equatable, Identifiable {
    public let id: UUID; public let type: String; public let participant: ProfileDTO
    public let lastSeq: Int; public let lastReadSeq: Int?; public let unreadCount: Int
    public let isPinned: Bool?; public let isArchived: Bool?; public let membershipVersion: Int?; public let lastMessageAt: String?
    enum CodingKeys: String, CodingKey { case id, type, participant; case lastSeq = "last_seq"; case lastReadSeq = "last_read_seq"; case unreadCount = "unread_count"; case isPinned = "is_pinned"; case isArchived = "is_archived"; case membershipVersion = "membership_version"; case lastMessageAt = "last_message_at" }
}

public struct UploadIntentRequestDTO: Codable, Sendable, Equatable {
    public let purpose: String; public let mimeType: String; public let byteSize: Int; public let sha256: String
    public init(purpose: String, mimeType: String, byteSize: Int, sha256: String) { self.purpose = purpose; self.mimeType = mimeType; self.byteSize = byteSize; self.sha256 = sha256 }
    enum CodingKeys: String, CodingKey { case purpose, sha256; case mimeType = "mime_type"; case byteSize = "byte_size" }
}

public struct UploadIntentDTO: Codable, Sendable, Equatable {
    public let mediaObjectId: UUID; public let bucket: String; public let objectPath: String; public let uploadURL: URL; public let expiresAt: String; public let maxBytes: Int
    enum CodingKeys: String, CodingKey { case bucket; case mediaObjectId = "media_object_id"; case objectPath = "object_path"; case uploadURL = "upload_url"; case expiresAt = "expires_at"; case maxBytes = "max_bytes" }
}

public struct CompleteUploadRequestDTO: Codable, Sendable, Equatable {
    public let sha256: String; public let headerBytesHex: String; public let width: Int; public let height: Int; public let setAsAvatar: Bool
    public init(sha256: String, headerBytesHex: String, width: Int, height: Int, setAsAvatar: Bool = false) { self.sha256 = sha256; self.headerBytesHex = headerBytesHex; self.width = width; self.height = height; self.setAsAvatar = setAsAvatar }
    enum CodingKeys: String, CodingKey { case sha256, width, height; case headerBytesHex = "header_bytes_hex"; case setAsAvatar = "set_as_avatar" }
}

public struct MediaReadyDTO: Codable, Sendable, Equatable { public let id: UUID; public let status: String; public let width: Int; public let height: Int; public let exifStripped: Bool; public let variants: [String]; enum CodingKeys: String, CodingKey { case id, status, width, height, variants; case exifStripped = "exif_stripped" } }

public struct PushDeviceRequestDTO: Codable, Sendable, Equatable {
    public let token: String; public let environment: String; public let bundleId: String; public let deviceName: String
    public init(token: String, environment: String, bundleId: String, deviceName: String) { self.token = token; self.environment = environment; self.bundleId = bundleId; self.deviceName = deviceName }
    enum CodingKeys: String, CodingKey { case token, environment; case bundleId = "bundle_id"; case deviceName = "device_name" }
}

public struct PushDeviceDTO: Codable, Sendable, Equatable, Identifiable {
    public let id: UUID; public let environment: String; public let bundleId: String; public let deviceName: String; public let tokenSuffix: String; public let lastSeenAt: String
    enum CodingKeys: String, CodingKey { case id, environment; case bundleId = "bundle_id"; case deviceName = "device_name"; case tokenSuffix = "token_suffix"; case lastSeenAt = "last_seen_at" }
}

public struct DiscoverActionRequestDTO: Codable, Sendable, Equatable { public let action: String; public init(action: String) { self.action = action } }
public struct ParticipantRequestDTO: Codable, Sendable, Equatable { public let participantId: UUID; public init(participantId: UUID) { self.participantId = participantId }; enum CodingKeys: String, CodingKey { case participantId = "participant_id" } }
public struct ReadStateRequestDTO: Codable, Sendable, Equatable { public let lastReadSeq: Int; public init(lastReadSeq: Int) { self.lastReadSeq = lastReadSeq }; enum CodingKeys: String, CodingKey { case lastReadSeq = "last_read_seq" } }
public struct TypingRequestDTO: Codable, Sendable, Equatable { public let isTyping: Bool; public init(isTyping: Bool) { self.isTyping = isTyping }; enum CodingKeys: String, CodingKey { case isTyping = "is_typing" } }

public struct CreateWorkoutSessionRequestDTO: Codable, Sendable, Equatable {
    public let title: String?; public let activity: String; public let gymId: UUID?; public let coarseLocation: String?
    public let startsAt: String; public let timezone: String; public let durationMinutes: Int; public let capacity: Int; public let notes: String?
    public init(title: String? = nil, activity: String, gymId: UUID? = nil, coarseLocation: String? = nil, startsAt: String, timezone: String, durationMinutes: Int = 60, capacity: Int = 2, notes: String? = nil) {
        self.title = title; self.activity = activity; self.gymId = gymId; self.coarseLocation = coarseLocation
        self.startsAt = startsAt; self.timezone = timezone; self.durationMinutes = durationMinutes; self.capacity = capacity; self.notes = notes
    }
    enum CodingKeys: String, CodingKey { case title, activity, timezone, capacity, notes; case gymId = "gym_id"; case coarseLocation = "coarse_location"; case startsAt = "starts_at"; case durationMinutes = "duration_minutes" }
}

public struct WorkoutSessionDTO: Codable, Sendable, Equatable, Identifiable {
    public let id: UUID; public let creatorId: UUID; public let title: String; public let activity: String; public let gymId: UUID?
    public let coarseLocation: String; public let startsAt: String; public let timezone: String; public let durationMinutes: Int
    public let capacity: Int; public let confirmedCount: Int; public let status: String; public let notes: String?; public let revision: Int; public let version: Int
    enum CodingKeys: String, CodingKey { case id, title, activity, timezone, capacity, status, notes, revision, version; case creatorId = "creator_id"; case gymId = "gym_id"; case coarseLocation = "coarse_location"; case startsAt = "starts_at"; case durationMinutes = "duration_minutes"; case confirmedCount = "confirmed_count" }
}

public struct WorkoutInvitationRequestDTO: Codable, Sendable, Equatable {
    public let inviteeId: UUID; public let message: String?; public let expiresAt: String?
    public init(inviteeId: UUID, message: String? = nil, expiresAt: String? = nil) { self.inviteeId = inviteeId; self.message = message; self.expiresAt = expiresAt }
    enum CodingKeys: String, CodingKey { case message; case inviteeId = "invitee_id"; case expiresAt = "expires_at" }
}

public struct WorkoutInvitationDTO: Codable, Sendable, Equatable, Identifiable {
    public let id: UUID; public let sessionId: UUID; public let inviterId: UUID?; public let inviteeId: UUID?; public let status: String; public let expiresAt: String?; public let version: Int
    enum CodingKeys: String, CodingKey { case id, status, version; case sessionId = "session_id"; case inviterId = "inviter_id"; case inviteeId = "invitee_id"; case expiresAt = "expires_at" }
}

public struct VersionRequestDTO: Codable, Sendable, Equatable { public let version: Int; public init(version: Int) { self.version = version } }
