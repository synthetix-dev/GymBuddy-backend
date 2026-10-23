# ADR-001: Supabase EU + Modular Monolith Command Layer

- **Status:** Accepted
- **Date:** 2026-10-23
- **Refs:** `00-EXECUTIVE-SUMMARY.md`, `02-SYSTEM-ARCHITECTURE.md`, `15-SCALING-COSTS.md`

## Context
GymBuddy is a relational, geo-aware social and fitness coordination iOS product requiring strong consistency for workout capacities, 1:1 chat message ordering, bilateral user blocking, and media authorization.

## Decision
1. **Primary Data Store:** PostgreSQL 17 with `postgis` (plus portable SQL spatial helpers), `pg_trgm`, `citext`, and `pgcrypto` hosted on Supabase Pro in the EU region.
2. **Authorization Defense-in-Depth:** Every table in `public` enforces Row Level Security (`ENABLE` + `FORCE ROW LEVEL SECURITY`) with default-deny policies (`O/M/V/S/A`).
3. **Command Execution Layer:** All multi-row domain transitions (`send-message`, `accept-invitation`, `create-upload`, `delete-account`, `report-content`, `block-user`) run inside explicit PostgreSQL transactions exposed through a modular TypeScript command layer (compatible with both Supabase Edge Functions and a standalone Node/Fastify/HTTP server) backed by SQL RPCs.
4. **Side Effects:** External side effects (APNs push, emails, media variant generation, reminders, GDPR exports/deletions) use the **Transactional Outbox** pattern (`outbox_events` claimed via `FOR UPDATE SKIP LOCKED`).

## Consequences
- Zero vendor lock-in on business logic and SQL schema: the entire backend runs identically against local PostgreSQL 17, Supabase EU, or any managed PostgreSQL + container host.
- Realtime and APNs are strictly notification hints; PostgreSQL remains the sole canonical source of truth.
