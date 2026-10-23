import crypto from 'node:crypto';
import type pg from 'pg';
import { Problems } from '../../core/problem.js';
import { executeIdempotentCommand, computeRequestHash } from '../../core/idempotency.js';

export type AdminRole =
  | 'support'
  | 'moderator'
  | 'safety_lead'
  | 'ops'
  | 'auditor'
  | 'super_admin';

export async function assertAdminRoleAndMfa(
  client: pg.PoolClient,
  userId: string,
  allowedRoles: AdminRole[]
): Promise<{ user_id: string; role: AdminRole; email: string }> {
  const res = await client.query<{
    user_id: string;
    email: string;
    role: AdminRole;
    mfa_verified: boolean;
    status: string;
  }>(
    `SELECT user_id, email, role::text AS role, mfa_verified, status
     FROM public.admin_users
     WHERE user_id = $1`,
    [userId]
  );

  if (res.rowCount === 0 || res.rows[0]!.status !== 'active') {
    throw Problems.forbidden('Admin role is required.');
  }

  const admin = res.rows[0]!;
  if (!admin.mfa_verified) {
    throw Problems.forbidden('Admin Multi-Factor Authentication (MFA) verification is required.', 'ADMIN_MFA_REQUIRED');
  }

  if (!allowedRoles.includes(admin.role)) {
    throw Problems.forbidden(
      `Admin role "${admin.role}" is not permitted for this operation.`,
      'ADMIN_INSUFFICIENT_ROLE'
    );
  }

  return { user_id: admin.user_id, role: admin.role, email: admin.email };
}

export async function listAdminReportsQuery(
  client: pg.PoolClient,
  adminUserId: string,
  params: { status?: string; limit?: number; requestId: string }
) {
  const admin = await assertAdminRoleAndMfa(client, adminUserId, [
    'moderator',
    'safety_lead',
    'super_admin',
    'auditor',
  ]);

  const limit = Math.min(100, Math.max(1, params.limit ?? 20));

  const res = await client.query<{
    case_id: string;
    report_id: string;
    target_type: string;
    target_id: string;
    subject_user_id: string | null;
    reason: string;
    details: string;
    status: string;
    severity: string;
    evidence_snapshot: Record<string, unknown>;
    created_at: Date;
    version: string;
  }>(
    `SELECT
       mc.id AS case_id,
       r.id AS report_id,
       r.target_type::text,
       r.target_id::text,
       mc.subject_user_id,
       r.reason,
       r.details,
       mc.status::text,
       mc.severity::text,
       r.evidence_snapshot,
       r.created_at,
       mc.version::text
     FROM public.moderation_cases mc
     JOIN public.reports r ON r.id = mc.report_id
     WHERE ($1::text IS NULL OR mc.status::text = $1::text)
     ORDER BY mc.severity DESC, r.created_at ASC
     LIMIT $2`,
    [params.status ?? null, limit]
  );

  await client.query(
    `INSERT INTO public.audit_logs (
       actor_type, actor_id, action, resource_type, resource_id, request_id, metadata
     ) VALUES ('admin', $1, 'admin.reports_queue_viewed', 'moderation_queue', 'list', $2, $3::jsonb)`,
    [admin.user_id, params.requestId, JSON.stringify({ role: admin.role, count: res.rowCount })]
  );

  return {
    data: res.rows.map((row) => ({
      case_id: row.case_id,
      report_id: row.report_id,
      target_type: row.target_type,
      target_id: row.target_id,
      subject_user_id: row.subject_user_id,
      reason: row.reason,
      details: row.details,
      status: row.status,
      severity: row.severity,
      evidence_snapshot: row.evidence_snapshot,
      version: Number(row.version),
      created_at: row.created_at.toISOString(),
    })),
    page: { next_cursor: null, has_more: false },
  };
}

export async function executeModerationActionCommand(
  client: pg.PoolClient,
  adminUserId: string,
  caseId: string,
  idempotencyKey: string,
  body: {
    action:
      | 'no_action'
      | 'warn'
      | 'content_hide'
      | 'interaction_limit'
      | 'temporary_suspend'
      | 'permanent_suspend'
      | 'restore';
    reason: string;
    duration_hours?: number;
    approved_by_admin_id?: string;
    version?: number;
  },
  requestId: string
) {
  const admin = await assertAdminRoleAndMfa(client, adminUserId, [
    'moderator',
    'safety_lead',
    'super_admin',
  ]);

  if (!body.reason || body.reason.trim().length < 3) {
    throw Problems.validation('Moderation action requires a policy reason (min 3 chars).', [
      { field: 'reason', reason: 'required' },
    ]);
  }

  // Dual control for permanent suspension (12-ADMIN-MODERATION.md)
  if (body.action === 'permanent_suspend') {
    if (!['safety_lead', 'super_admin'].includes(admin.role)) {
      throw Problems.forbidden(
        'Permanent suspension requires safety_lead or super_admin role.',
        'ADMIN_INSUFFICIENT_ROLE'
      );
    }
    if (!body.approved_by_admin_id || body.approved_by_admin_id === admin.user_id) {
      throw Problems.forbidden(
        'Permanent suspension requires two-person approval (approved_by_admin_id).',
        'DUAL_CONTROL_REQUIRED'
      );
    }
    await assertAdminRoleAndMfa(client, body.approved_by_admin_id, [
      'moderator',
      'safety_lead',
      'super_admin',
    ]);
  }

  const requestHash = computeRequestHash('POST', `/v1/admin/cases/${caseId}/actions`, body);

  return executeIdempotentCommand(client, {
    scope: `POST:/v1/admin/cases/${caseId}/actions`,
    userId: adminUserId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      const caseRes = await client.query<{
        id: string;
        report_id: string;
        target_type: string;
        target_id: string;
        subject_user_id: string | null;
        status: string;
        version: string;
      }>(
        `SELECT id, report_id, target_type::text, target_id::text, subject_user_id, status::text, version::text
         FROM public.moderation_cases
         WHERE id = $1
         FOR UPDATE`,
        [caseId]
      );

      if (caseRes.rowCount === 0) throw Problems.notFound('Moderation case');
      const mc = caseRes.rows[0]!;

      if (body.version !== undefined && Number(mc.version) !== body.version) {
        throw Problems.versionConflict();
      }

      const beforeHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(mc))
        .digest('hex');

      const expiresAt =
        body.duration_hours && body.duration_hours > 0
          ? new Date(Date.now() + body.duration_hours * 3600 * 1000).toISOString()
          : null;

      const actRes = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO public.moderation_actions (
           case_id, admin_id, approved_by_admin_id, action, target_type, target_id, reason, expires_at
         ) VALUES ($1, $2, $3, $4, $5::public.report_target_type, $6::uuid, $7, $8::timestamptz)
         RETURNING id, created_at`,
        [
          caseId,
          admin.user_id,
          body.approved_by_admin_id ?? null,
          body.action,
          mc.target_type,
          mc.target_id,
          body.reason.trim(),
          expiresAt,
        ]
      );

      // Apply target domain mutation
      if (body.action === 'content_hide') {
        if (mc.target_type === 'post') {
          await client.query(
            `UPDATE public.posts SET status = 'hidden', version = version + 1 WHERE id = $1::uuid`,
            [mc.target_id]
          );
        } else if (mc.target_type === 'comment') {
          await client.query(
            `UPDATE public.comments SET status = 'hidden', version = version + 1 WHERE id = $1::uuid`,
            [mc.target_id]
          );
        }
      } else if (
        (body.action === 'temporary_suspend' || body.action === 'permanent_suspend') &&
        mc.subject_user_id
      ) {
        await client.query(
          `UPDATE public.user_profiles
           SET account_status = 'suspended',
               suspended_until = $2::timestamptz,
               version = version + 1
           WHERE user_id = $1`,
          [mc.subject_user_id, body.action === 'temporary_suspend' ? expiresAt : null]
        );
      } else if (body.action === 'restore' && mc.subject_user_id) {
        await client.query(
          `UPDATE public.user_profiles
           SET account_status = 'active', suspended_until = NULL, version = version + 1
           WHERE user_id = $1`,
          [mc.subject_user_id]
        );
      }

      const nextCaseStatus = body.action === 'no_action' ? 'dismissed' : 'actioned';

      await client.query(
        `UPDATE public.moderation_cases
         SET status = $2::public.report_status,
             assignee_admin_id = $3,
             version = version + 1,
             closed_at = now()
         WHERE id = $1`,
        [caseId, nextCaseStatus, admin.user_id]
      );

      await client.query(
        `UPDATE public.reports SET status = $2::public.report_status WHERE id = $1`,
        [mc.report_id, nextCaseStatus]
      );

      const afterHash = crypto
        .createHash('sha256')
        .update(JSON.stringify({ ...mc, status: nextCaseStatus, action: body.action }))
        .digest('hex');

      await client.query(
        `INSERT INTO public.audit_logs (
           actor_type, actor_id, action, resource_type, resource_id,
           request_id, before_hash, after_hash, metadata
         ) VALUES ('admin', $1, $2, 'moderation_case', $3, $4, $5, $6, $7::jsonb)`,
        [
          admin.user_id,
          `moderation.${body.action}`,
          caseId,
          requestId,
          beforeHash,
          afterHash,
          JSON.stringify({
            target_type: mc.target_type,
            target_id: mc.target_id,
            approved_by_admin_id: body.approved_by_admin_id ?? null,
          }),
        ]
      );

      return {
        statusCode: 200,
        body: {
          data: {
            action_id: actRes.rows[0]!.id,
            case_id: caseId,
            action: body.action,
            case_status: nextCaseStatus,
            created_at: actRes.rows[0]!.created_at.toISOString(),
          },
        },
      };
    },
  });
}
