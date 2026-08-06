CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  coins INTEGER NOT NULL DEFAULT 0,
  energy INTEGER NOT NULL DEFAULT 500,
  last_energy_ts INTEGER NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0,
  last_checkin TEXT,
  total_taps INTEGER NOT NULL DEFAULT 0,
  daily_taps INTEGER NOT NULL DEFAULT 0,
  daily_taps_date TEXT,
  claimed_missions TEXT NOT NULL DEFAULT '[]',
  avatar_url TEXT,
  username TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_players_coins ON players (coins DESC);
