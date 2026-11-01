-- Plans and immutable diagram versions (backend/README.md "Plans and limits"
-- and "Diagram versions"). Times are Unix milliseconds, like documents'.

-- The account's plan, for its limits (src/plans.ts). Everyone is on 'free'
-- today; an unknown value gets the free plan's limits.
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';

-- Snapshots of one of the user's synced diagrams (src/versions.ts), tagged
-- by the user (e.g. 2026-11-01). Content is never changed after insert.
-- Deleting a version keeps a tombstone (tag and seq, content cleared) so the
-- tag is never reused and `latest` stays honest; deleting the diagram
-- (tombstone or row) or the account deletes all of them.
CREATE TABLE document_versions (
  user_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  -- 1, 2, 3… per diagram, never reused: `latest` is the highest live one.
  seq INTEGER NOT NULL,
  -- /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, case-sensitive, never 'latest'.
  tag TEXT NOT NULL,
  -- The diagram's file name, source and imports (JSON path → source, NULL
  -- without) at the time; all cleared in a tombstone.
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  imports TEXT,
  -- At most 280 characters; NULL without.
  note TEXT,
  -- UTF-8 bytes of the source plus every import's source.
  size INTEGER NOT NULL,
  -- Hex SHA-256 of the canonical form (backend/README.md); '' in a tombstone.
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- A tombstone: deleted at this time. NULL while live.
  deleted_at INTEGER,
  PRIMARY KEY (user_id, document_id, seq),
  UNIQUE (user_id, document_id, tag),
  FOREIGN KEY (user_id, document_id) REFERENCES documents (user_id, id) ON DELETE CASCADE
);
