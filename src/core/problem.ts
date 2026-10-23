export interface ProblemFieldError {
  field: string;
  reason: string;
  [key: string]: unknown;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  request_id: string;
  errors?: ProblemFieldError[];
}

export class AppProblem extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly title: string;
  public readonly type: string;
  public readonly detail?: string;
  public readonly errors?: ProblemFieldError[];
  public readonly headers?: Record<string, string>;

  constructor(params: {
    status: number;
    code: string;
    title: string;
    detail?: string;
    typeSlug?: string;
    errors?: ProblemFieldError[];
    headers?: Record<string, string>;
  }) {
    super(params.detail ?? params.title);
    this.status = params.status;
    this.code = params.code;
    this.title = params.title;
    const slug = params.typeSlug ?? params.code.toLowerCase().replace(/_/g, '-');
    this.type = `https://api.gymbuddy.app/problems/${slug}`;
    this.detail = params.detail;
    this.errors = params.errors;
    this.headers = params.headers;
  }

  public toJSON(requestId: string): ProblemDetails {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      code: this.code,
      ...(this.detail ? { detail: this.detail } : {}),
      request_id: requestId,
      ...(this.errors && this.errors.length > 0 ? { errors: this.errors } : {}),
    };
  }
}

export const Problems = {
  unauthorized(detail = 'Authentication token is missing, expired, or invalid.', code = 'UNAUTHORIZED') {
    return new AppProblem({ status: 401, code, title: 'Unauthorized', detail });
  },
  sessionRevoked(detail = 'Session has been revoked or refresh token was reused.') {
    return new AppProblem({
      status: 401,
      code: 'AUTH_SESSION_REVOKED',
      title: 'Session revoked',
      detail,
    });
  },
  forbidden(detail = 'You do not have permission to perform this action.', code = 'FORBIDDEN') {
    return new AppProblem({ status: 403, code, title: 'Forbidden', detail });
  },
  accountSuspended(detail = 'Your account is currently suspended.') {
    return new AppProblem({
      status: 403,
      code: 'ACCOUNT_SUSPENDED',
      title: 'Account suspended',
      detail,
    });
  },
  accountDeletionPending(detail = 'Account has a pending deletion request. Cancel deletion first to resume.') {
    return new AppProblem({
      status: 403,
      code: 'ACCOUNT_DELETION_PENDING',
      title: 'Account deletion pending',
      detail,
    });
  },
  relationshipBlocked(detail = 'Action is not allowed due to relationship restrictions.') {
    return new AppProblem({
      status: 403,
      code: 'RELATIONSHIP_BLOCKED',
      title: 'Relationship restricted',
      detail,
    });
  },
  notFound(resource = 'Resource', code = 'RESOURCE_NOT_FOUND') {
    return new AppProblem({
      status: 404,
      code,
      title: `${resource} not found`,
      detail: `The requested ${resource.toLowerCase()} does not exist or is not accessible.`,
    });
  },
  versionConflict(detail = 'Resource changed; refresh and retry.') {
    return new AppProblem({
      status: 409,
      code: 'VERSION_CONFLICT',
      title: 'Version conflict',
      detail,
      typeSlug: 'version-conflict',
      errors: [{ field: 'version', reason: 'stale' }],
    });
  },
  idempotencyConflict(detail = 'Idempotency-Key was already used with a different request payload.') {
    return new AppProblem({
      status: 409,
      code: 'IDEMPOTENCY_CONFLICT',
      title: 'Idempotency conflict',
      detail,
    });
  },
  conflict(code: string, title: string, detail: string) {
    return new AppProblem({ status: 409, code, title, detail });
  },
  cursorExpired(detail = 'Pagination cursor has expired or is invalid; refresh the list.') {
    return new AppProblem({
      status: 410,
      code: 'CURSOR_EXPIRED',
      title: 'Cursor expired',
      detail,
    });
  },
  invitationExpired(detail = 'Workout invitation has expired.') {
    return new AppProblem({
      status: 410,
      code: 'INVITATION_EXPIRED',
      title: 'Invitation expired',
      detail,
    });
  },
  payloadTooLarge(detail = 'Uploaded payload or file exceeds maximum allowed size.') {
    return new AppProblem({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      title: 'Payload too large',
      detail,
    });
  },
  unsupportedMedia(detail = 'Unsupported media MIME type or corrupted file header.') {
    return new AppProblem({
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      title: 'Unsupported media type',
      detail,
    });
  },
  validation(detail: string, errors?: ProblemFieldError[], code = 'VALIDATION_ERROR') {
    return new AppProblem({
      status: 422,
      code,
      title: 'Validation failed',
      detail,
      errors,
    });
  },
  rateLimited(retryAfterSeconds: number, detail = 'Too many requests; please slow down.') {
    return new AppProblem({
      status: 429,
      code: 'RATE_LIMITED',
      title: 'Too many requests',
      detail,
      headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) },
    });
  },
};
