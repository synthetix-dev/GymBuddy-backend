-- =============================================================================
-- GymBuddy Deterministic Seed Data (Matches 01-CURRENT-APP-AUDIT.md Fixtures)
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

-- 3. Auth Users (8 App Fixture Users + 2 Staff Admin Users)
INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('00000000-0000-4000-8000-000000000001', 'dmitro@gymbuddy.app', now()),
  ('00000000-0000-4000-8000-000000000002', 'maya@gymbuddy.app', now()),
  ('00000000-0000-4000-8000-000000000003', 'alex@gymbuddy.app', now()),
  ('00000000-0000-4000-8000-000000000004', 'sam@gymbuddy.app', now()),
  ('00000000-0000-4000-8000-000000000005', 'priya@gymbuddy.app', now()),
  ('00000000-0000-4000-8000-000000000006', 'chris@gymbuddy.app', now()),
  ('00000000-0000-4000-8000-000000000007', 'taylor@gymbuddy.app', now()),
  ('00000000-0000-4000-8000-000000000008', 'jordan@gymbuddy.app', now()),
  ('00000000-0000-4000-8000-000000000091', 'moderator@gymbuddy.app', now()),
  ('00000000-0000-4000-8000-000000000092', 'safetylead@gymbuddy.app', now())
ON CONFLICT (id) DO NOTHING;

-- 4. User Profiles
INSERT INTO public.user_profiles (
  user_id, public_code, display_name, birth_date, gender_code, bio,
  experience_level, home_gym_id, city_label, preferred_time, visibility, onboarding_state, account_status
) VALUES
  ('00000000-0000-4000-8000-000000000001', 'GBDMITRO0001', 'Dmitro', '1998-05-14', 'male',
   'Focused on progressive overload, compound lifts, and clean high-protein cooking.',
   'advanced', '20000000-0000-4000-8000-000000000001', 'Kyiv', 'evening', 'discoverable', 'complete', 'active'),
  ('00000000-0000-4000-8000-000000000002', 'GBMAYAKYIV02', 'Maya', '1999-08-21', 'female',
   'Strength + HIIT blocks 4x/week. Looking for a consistent evening training partner.',
   'intermediate', '20000000-0000-4000-8000-000000000001', 'Kyiv', 'evening', 'discoverable', 'complete', 'active'),
  ('00000000-0000-4000-8000-000000000003', 'GBALEXKYIV03', 'Alex', '1996-02-10', 'male',
   'Powerlifting prep & heavy squats. Always happy to spot.',
   'advanced', '20000000-0000-4000-8000-000000000002', 'Kyiv', 'morning', 'discoverable', 'complete', 'active'),
  ('00000000-0000-4000-8000-000000000004', 'GBSAMKYIV004', 'Sam', '2000-11-03', 'non_binary',
   'Hybrid athlete: 10K tempo runs + functional strength.',
   'intermediate', '20000000-0000-4000-8000-000000000002', 'Kyiv', 'morning', 'discoverable', 'complete', 'active'),
  ('00000000-0000-4000-8000-000000000005', 'GBPRIYAKV005', 'Priya', '1997-04-19', 'female',
   'Mobility, olympic lifts, and macro-friendly meal prep enthusiast.',
   'advanced', '20000000-0000-4000-8000-000000000003', 'Kyiv', 'evening', 'discoverable', 'complete', 'active'),
  ('00000000-0000-4000-8000-000000000006', 'GBCHRISKV006', 'Chris', '1995-09-12', 'male',
   'Calisthenics & weighted pull-ups.',
   'intermediate', '20000000-0000-4000-8000-000000000004', 'Kyiv', 'afternoon', 'discoverable', 'complete', 'active'),
  ('00000000-0000-4000-8000-000000000007', 'GBTAYLORKV07', 'Taylor', '2001-01-25', 'female',
   'Starting strength & conditioning journey!',
   'beginner', '20000000-0000-4000-8000-000000000001', 'Kyiv', 'evening', 'discoverable', 'complete', 'active'),
  ('00000000-0000-4000-8000-000000000008', 'GBJORDANKV08', 'Jordan', '1994-07-08', 'male',
   'Marathoner adding 3x strength days.',
   'intermediate', '20000000-0000-4000-8000-000000000003', 'Kyiv', 'early_morning', 'discoverable', 'complete', 'active')
ON CONFLICT (user_id) DO UPDATE SET
  public_code = EXCLUDED.public_code,
  display_name = EXCLUDED.display_name,
  birth_date = EXCLUDED.birth_date,
  gender_code = EXCLUDED.gender_code,
  bio = EXCLUDED.bio,
  experience_level = EXCLUDED.experience_level,
  home_gym_id = EXCLUDED.home_gym_id,
  city_label = EXCLUDED.city_label,
  preferred_time = EXCLUDED.preferred_time,
  visibility = EXCLUDED.visibility,
  onboarding_state = EXCLUDED.onboarding_state,
  account_status = EXCLUDED.account_status;

UPDATE public.user_profiles
SET visibility = 'hidden'
WHERE user_id IN ('00000000-0000-4000-8000-000000000091', '00000000-0000-4000-8000-000000000092');

-- 5. User Settings
INSERT INTO public.user_settings (user_id, discovery_radius_km, discovery_visible)
SELECT user_id, 15, true FROM public.user_profiles
ON CONFLICT (user_id) DO NOTHING;

-- 6. User Locations (Kyiv coordinates with 30-day TTL)
INSERT INTO public.user_locations (user_id, latitude, longitude, coarse_geohash, accuracy_m, captured_at, expires_at) VALUES
  ('00000000-0000-4000-8000-000000000001', 50.4388, 30.5233, public.gb_coarse_geohash(50.4388, 30.5233), 25, now(), now() + INTERVAL '30 days'),
  ('00000000-0000-4000-8000-000000000002', 50.4420, 30.5210, public.gb_coarse_geohash(50.4420, 30.5210), 30, now(), now() + INTERVAL '30 days'),
  ('00000000-0000-4000-8000-000000000003', 50.4342, 30.5081, public.gb_coarse_geohash(50.4342, 30.5081), 35, now(), now() + INTERVAL '30 days'),
  ('00000000-0000-4000-8000-000000000004', 50.4310, 30.5120, public.gb_coarse_geohash(50.4310, 30.5120), 40, now(), now() + INTERVAL '30 days'),
  ('00000000-0000-4000-8000-000000000005', 50.4265, 30.5384, public.gb_coarse_geohash(50.4265, 30.5384), 25, now(), now() + INTERVAL '30 days'),
  ('00000000-0000-4000-8000-000000000006', 50.4220, 30.5170, public.gb_coarse_geohash(50.4220, 30.5170), 30, now(), now() + INTERVAL '30 days'),
  ('00000000-0000-4000-8000-000000000007', 50.4400, 30.5250, public.gb_coarse_geohash(50.4400, 30.5250), 25, now(), now() + INTERVAL '30 days'),
  ('00000000-0000-4000-8000-000000000008', 50.4280, 30.5350, public.gb_coarse_geohash(50.4280, 30.5350), 30, now(), now() + INTERVAL '30 days')
ON CONFLICT (user_id) DO NOTHING;

-- 7. User Interests
INSERT INTO public.user_interests (user_id, interest_id, proficiency) VALUES
  ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'advanced'),
  ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'advanced'),
  ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000008', 'intermediate'),
  ('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'intermediate'),
  ('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003', 'advanced'),
  ('00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'advanced'),
  ('00000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000008', 'advanced')
ON CONFLICT DO NOTHING;

-- 8. Mutual Connection between Dmitro and Maya
INSERT INTO public.user_relationships (actor_id, target_id, type) VALUES
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'connect'),
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'connect')
ON CONFLICT DO NOTHING;

-- 9. Sample Feed Posts (Text, Recipe, Workout)
INSERT INTO public.posts (id, author_id, type, status, body, visibility, published_at) VALUES
  ('30000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'workout', 'published',
   'Upper body strength + 15 min EMOM finisher at Apollo Next! Who is training tomorrow evening?', 'community', now() - INTERVAL '2 hours'),
  ('30000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000005', 'recipe', 'published',
   'Post-workout High-Protein Greek Yogurt Chicken Bowl — ready in 20 minutes and hits 52g protein.', 'community', now() - INTERVAL '4 hours'),
  ('30000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'text', 'published',
   'Hit a clean 5x5 squat session today. Focusing on pause reps made a huge difference in stability.', 'community', now() - INTERVAL '6 hours')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workout_updates (post_id, activity, duration_minutes, calories_burned, gym_id) VALUES
  ('30000000-0000-4000-8000-000000000001', 'Upper Body Strength & EMOM', 75, 540, '20000000-0000-4000-8000-000000000001')
ON CONFLICT (post_id) DO NOTHING;

INSERT INTO public.recipes (post_id, title, subtitle, difficulty, calories, protein_g, carbs_g, fat_g, prep_minutes, servings) VALUES
  ('30000000-0000-4000-8000-000000000002', 'High-Protein Herbed Chicken Rice Bowl', 'Macro-balanced post-training recovery meal', 'easy', 580, 52, 58, 14, 20, 2)
ON CONFLICT (post_id) DO NOTHING;

INSERT INTO public.recipe_ingredients (id, recipe_post_id, position, text, quantity, unit) VALUES
  ('31000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', 0, 'Chicken breast fillet, cubed', 400, 'g'),
  ('31000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 1, 'Cooked jasmine rice', 300, 'g'),
  ('31000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000002', 2, 'Greek yogurt 2%', 120, 'g')
ON CONFLICT (recipe_post_id, position) DO NOTHING;

INSERT INTO public.recipe_steps (id, recipe_post_id, position, instruction) VALUES
  ('32000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', 0, 'Season chicken with garlic, oregano, lemon zest, and sear for 6-7 minutes.'),
  ('32000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 1, 'Assemble warm jasmine rice, seared chicken, and herbed Greek yogurt dressing.')
ON CONFLICT (recipe_post_id, position) DO NOTHING;

-- 10. Admin Staff Roles (MFA verified)
INSERT INTO public.admin_users (user_id, email, role, mfa_verified, status) VALUES
  ('00000000-0000-4000-8000-000000000091', 'moderator@gymbuddy.app', 'moderator', true, 'active'),
  ('00000000-0000-4000-8000-000000000092', 'safetylead@gymbuddy.app', 'safety_lead', true, 'active')
ON CONFLICT (user_id) DO NOTHING;
