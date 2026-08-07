CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  username TEXT,
  avatar_url TEXT,
  coins INTEGER NOT NULL DEFAULT 0,
  gems INTEGER NOT NULL DEFAULT 0,
  energy INTEGER NOT NULL DEFAULT 500,
  last_energy_ts INTEGER NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0,
  last_checkin TEXT,
  total_taps INTEGER NOT NULL DEFAULT 0,
  daily_taps INTEGER NOT NULL DEFAULT 0,
  daily_taps_date TEXT,
  claimed_missions TEXT NOT NULL DEFAULT '[]',
  mining_level INTEGER NOT NULL DEFAULT 1,
  mining_xp INTEGER NOT NULL DEFAULT 0,
  referred_by TEXT,
  referral_count INTEGER NOT NULL DEFAULT 0,
  referral_earnings INTEGER NOT NULL DEFAULT 0,
  claimed_referral_milestones TEXT NOT NULL DEFAULT '[]',
  referred_users TEXT NOT NULL DEFAULT '[]',
  gem_exchange_log TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_players_coins ON players (coins DESC);
