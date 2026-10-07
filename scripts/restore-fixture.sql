CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (
  id serial PRIMARY KEY, hash text NOT NULL, created_at bigint
);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('synthetic-migration', 1000);
INSERT INTO app_metadata (key, value) VALUES ('library_fixture', 'synthetic-catalog-v1');
INSERT INTO categories (id, name, relative_path) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Gadgets', 'Synthetic/Gadgets');
INSERT INTO projects (id, category_id, relative_path, name, description, tags, designer, source_url, license, notes)
VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
  'Synthetic/Gadgets/Lamp', 'Synthetic Lamp', 'Printed lamp', ARRAY['fixture', 'lamp'],
  'Test Designer', 'https://example.invalid/synthetic', 'Synthetic fixture', 'Keep this note');
INSERT INTO project_boundary_overrides (relative_path, kind) VALUES ('Synthetic/Gadgets/Lamp', 'project');
INSERT INTO assets (id, project_id, relative_path, project_relative_path, name, kind, extension, size_bytes, mtime_ms, content_hash, sort_order)
VALUES ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002',
  'Synthetic/Gadgets/Lamp/part.stl', 'part.stl', 'part.stl', 'mesh', 'stl', 12, 1000, 'fixture-hash-v2', 1);
INSERT INTO asset_versions (id, asset_id, content_hash, size_bytes, mtime_ms) VALUES
  ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000003', 'fixture-hash-v1', 10, 900),
  ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000003', 'fixture-hash-v2', 12, 1000);
UPDATE assets SET current_version_id = '00000000-0000-4000-8000-000000000005'
WHERE id = '00000000-0000-4000-8000-000000000003';
INSERT INTO users (id, username, password_hash, role) VALUES
  ('00000000-0000-4000-8000-000000000006', 'synthetic-operator', 'not-a-real-password-hash', 'operator'),
  ('00000000-0000-4000-8000-000000000007', 'synthetic-requester', 'not-a-real-password-hash', 'requester');
INSERT INTO sessions (id, token_hash, user_id, expires_at) VALUES
  ('00000000-0000-4000-8000-000000000008', 'not-a-real-session-token-hash',
  '00000000-0000-4000-8000-000000000007', '2099-01-01');
INSERT INTO print_requests (id, project_id, project_name, requester_id, status, quantity, material, color, notes, queue_position)
VALUES ('00000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000002',
  'Synthetic Lamp', '00000000-0000-4000-8000-000000000007', 'queued', 2, 'PLA', 'blue', 'Fixture request', 1);
INSERT INTO print_request_files (id, request_id, asset_id, version_id, name, relative_path, file_type, extension, size_bytes, content_hash)
VALUES ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000009',
  '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004',
  'part.stl', 'part.stl', 'mesh', 'stl', 10, 'fixture-hash-v1');
INSERT INTO print_request_history (id, request_id, actor_id, action, from_status, to_status, from_position, to_position, note)
VALUES ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000009',
  '00000000-0000-4000-8000-000000000007', 'submit', NULL, 'requested', NULL, NULL, 'Submitted'),
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000009',
  '00000000-0000-4000-8000-000000000006', 'approve', 'requested', 'queued', NULL, 1, 'Approved'),
  ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000009',
  '00000000-0000-4000-8000-000000000006', 'select_next', 'queued', 'queued', 1, 1, 'Selected');
UPDATE request_queue_state SET revision = 3, selected_next_id = '00000000-0000-4000-8000-000000000009' WHERE id = 1;
