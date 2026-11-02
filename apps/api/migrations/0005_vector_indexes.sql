-- 0005_vector_indexes.sql — approximate nearest-neighbour indexes (B-5).
-- HNSW over cosine distance. Queries also filter by snapshot/repository and
-- embedding model, so they run with hnsw.iterative_scan (pgvector >= 0.8) to
-- keep returning full candidate sets after filtering; the planner still picks
-- an exact scan when the filtered set is small.

CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw
  ON code_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding_hnsw
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
