CREATE SEQUENCE "public"."project_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TEMP TABLE project_id_transition ON COMMIT DROP AS
  SELECT id AS old_id, nextval('project_id_seq') AS new_id FROM projects ORDER BY created_at, id;--> statement-breakpoint
CREATE FUNCTION pg_temp.print_pantry_project_id(old_uuid uuid) RETURNS bigint
  LANGUAGE sql AS 'SELECT new_id FROM project_id_transition WHERE old_id = old_uuid';--> statement-breakpoint
ALTER TABLE assets DROP CONSTRAINT assets_project_id_projects_id_fk;--> statement-breakpoint
ALTER TABLE print_requests DROP CONSTRAINT print_requests_project_id_projects_id_fk;--> statement-breakpoint
ALTER TABLE projects ALTER COLUMN id DROP DEFAULT;--> statement-breakpoint
ALTER TABLE assets ALTER COLUMN project_id TYPE bigint USING pg_temp.print_pantry_project_id(project_id);--> statement-breakpoint
ALTER TABLE print_requests ALTER COLUMN project_id TYPE bigint USING pg_temp.print_pantry_project_id(project_id);--> statement-breakpoint
ALTER TABLE projects ALTER COLUMN id TYPE bigint USING pg_temp.print_pantry_project_id(id);--> statement-breakpoint
ALTER TABLE projects ALTER COLUMN id SET DEFAULT nextval('project_id_seq');--> statement-breakpoint
ALTER SEQUENCE project_id_seq OWNED BY projects.id;--> statement-breakpoint
ALTER TABLE assets ADD CONSTRAINT assets_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES projects(id);--> statement-breakpoint
ALTER TABLE print_requests ADD CONSTRAINT print_requests_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES projects(id);--> statement-breakpoint
DROP FUNCTION pg_temp.print_pantry_project_id(uuid);