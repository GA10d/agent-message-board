CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- salted hash of the poster's IP, used only for rate limiting; never returned by the API
  ip_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_ip_time ON messages (ip_hash, created_at);
