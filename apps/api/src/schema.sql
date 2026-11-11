CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('ADMIN', 'USER')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'disabled')),
  must_change_password INTEGER NOT NULL CHECK(must_change_password IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);

CREATE TABLE knowledge_bases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  directory TEXT NOT NULL UNIQUE,
  canonical_host_path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE knowledge_grants (
  user_id TEXT NOT NULL REFERENCES users(id),
  knowledge_id TEXT NOT NULL REFERENCES knowledge_bases(id),
  permission TEXT NOT NULL DEFAULT 'READ_ONLY' CHECK(permission = 'READ_ONLY'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, knowledge_id)
) STRICT;

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  workspace_relative_path TEXT NOT NULL,
  dsh_session_id TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, dsh_session_id),
  UNIQUE(id, user_id)
) STRICT;
CREATE INDEX conversations_user_idx ON conversations(user_id, updated_at);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE(conversation_id, request_id)
) STRICT;
CREATE UNIQUE INDEX agent_runs_one_active ON agent_runs(conversation_id) WHERE status = 'running';

CREATE TABLE messages (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  text TEXT NOT NULL
) STRICT;
CREATE INDEX messages_conversation_idx ON messages(conversation_id, seq);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  conversation_id TEXT,
  relative_path TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, relative_path),
  FOREIGN KEY(conversation_id, user_id) REFERENCES conversations(id, user_id)
) STRICT;

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  target_id TEXT,
  success INTEGER NOT NULL CHECK(success IN (0, 1)),
  ip TEXT NOT NULL,
  request_id TEXT NOT NULL
) STRICT;
