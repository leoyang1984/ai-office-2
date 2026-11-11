CREATE TABLE conversation_events (
  seq INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  turn_id TEXT NOT NULL REFERENCES agent_runs(id),
  type TEXT NOT NULL CHECK(type IN ('queued', 'started', 'delta', 'tool', 'completed', 'failed')),
  text TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX conversation_events_scope ON conversation_events(conversation_id, seq);
