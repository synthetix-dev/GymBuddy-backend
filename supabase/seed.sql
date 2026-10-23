-- =============================================================================
-- GymBuddy Cloud-Safe Reference Catalog Seed Data
-- =============================================================================
-- NOTE: Test/fixture users must NOT be inserted directly into auth.users in SQL.
-- Use `pnpm db:seed` (scripts/seed.ts) which provisions test users via the
-- Supabase Auth Admin API (`/auth/v1/admin/users`).
-- =============================================================================

-- 1. Interests Catalog
INSERT INTO public.interests (id, slug, label, category) VALUES
  ('10000000-0000-4000-8000-000000000001', 'strength_training', 'Strength Training', 'fitness'),
  ('10000000-0000-4000-8000-000000000002', 'powerlifting', 'Powerlifting', 'fitness'),
  ('10000000-0000-4000-8000-000000000003', 'hiit', 'HIIT & Conditioning', 'fitness'),
  ('10000000-0000-4000-8000-000000000004', 'running', 'Running', 'cardio'),
  ('10000000-0000-4000-8000-000000000005', 'mobility_yoga', 'Mobility & Yoga', 'recovery'),
  ('10000000-0000-4000-8000-000000000006', 'crossfit', 'Functional & CrossFit', 'fitness'),
  ('10000000-0000-4000-8000-000000000007', 'calisthenics', 'Calisthenics', 'fitness'),
  ('10000000-0000-4000-8000-000000000008', 'nutrition', 'Meal Prep & Nutrition', 'nutrition')
ON CONFLICT (slug) DO NOTHING;

-- 2. Kyiv Gyms Catalog
INSERT INTO public.gyms (id, name, city, address, latitude, longitude, verified) VALUES
  ('20000000-0000-4000-8000-000000000001', 'Apollo Next Gulliver', 'Kyiv', 'Sportyvna Square 1A, Kyiv', 50.4388, 30.5233, true),
  ('20000000-0000-4000-8000-000000000002', 'Smartass Fitness Club', 'Kyiv', 'Zhylianska St 41A, Kyiv', 50.4342, 30.5081, true),
  ('20000000-0000-4000-8000-000000000003', 'Sport Life Pechersk', 'Kyiv', 'Lesia Ukrainka Blvd 26, Kyiv', 50.4265, 30.5384, true),
  ('20000000-0000-4000-8000-000000000004', 'Fizmat Podil', 'Kyiv', 'Velyka Vasylkivska St 100, Kyiv', 50.4220, 30.5170, true)
ON CONFLICT (id) DO NOTHING;
