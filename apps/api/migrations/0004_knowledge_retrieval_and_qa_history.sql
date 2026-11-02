-- 0004_knowledge_retrieval_and_qa_history.sql
-- Knowledge notes become retrievable evidence (chunked, optionally embedded),
-- and answered repository questions are kept per user.

CREATE TABLE knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  start_line integer NOT NULL CHECK (start_line > 0),
  end_line integer NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL,
  embedding vector(768),
  embedding_model text,
  embedding_version text,
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', regexp_replace(content, '([a-z])([A-Z])|[_./\\-]', '\1 \2', 'g'))
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index),
  CHECK (end_line >= start_line),
  CHECK (embedding IS NULL OR (embedding_model IS NOT NULL AND embedding_version IS NOT NULL))
);
CREATE INDEX idx_knowledge_chunks_repo ON knowledge_chunks(repository_id);
CREATE INDEX idx_knowledge_chunks_search ON knowledge_chunks USING gin (search_vector);

CREATE TABLE repository_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question text NOT NULL,
  answer text NOT NULL,
  insufficient_evidence boolean NOT NULL,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  limitations jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider text,
  model text,
  mode text,
  commit_sha text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_repository_questions_user ON repository_questions(repository_id, user_id, created_at DESC, id DESC);
