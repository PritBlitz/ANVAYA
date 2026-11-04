-- 0011_repository_reconnect.sql — let a repository move to another workspace (tracker B-10).
--
-- external_repository_id was globally unique and disconnecting keeps the row for its history, so
-- a repository connected once could never be connected in another workspace. It is now unique per
-- workspace, and unique globally only among rows still attached to a workspace: a disabled
-- repository still belongs to its workspace, a disconnected one does not.

ALTER TABLE repositories DROP CONSTRAINT repositories_external_repository_id_key;

ALTER TABLE repositories
  ADD CONSTRAINT uq_repositories_org_external UNIQUE (organization_id, external_repository_id);

CREATE UNIQUE INDEX uq_repositories_external_attached
  ON repositories (external_repository_id)
  WHERE status <> 'disconnected';
