-- Users table
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT,
    rank_code TEXT,
    rank_title TEXT,
    unit TEXT,
    mos TEXT,
    service_years TEXT,
    deployment_history TEXT,
    clearance TEXT,
    stake_percentage REAL DEFAULT 0,
    join_date TEXT,
    is_online INTEGER DEFAULT 0,
    last_dividend REAL DEFAULT 0,
    referred_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (referred_by) REFERENCES users(id)
);

-- User badges (awards/decorations)
CREATE TABLE IF NOT EXISTS user_badges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    badge_name TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Treasury (single record for network finances)
CREATE TABLE IF NOT EXISTS treasury (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    balance REAL DEFAULT 0,
    member_dues REAL DEFAULT 0,
    investments REAL DEFAULT 0,
    pending REAL DEFAULT 0,
    monthly_spending REAL DEFAULT 0,
    operations_spending REAL DEFAULT 0,
    member_services_spending REAL DEFAULT 0,
    admin_spending REAL DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Proposals/Votes
CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    initiated_date TEXT NOT NULL,
    closes_date TEXT NOT NULL,
    quorum_required INTEGER DEFAULT 67,
    status TEXT DEFAULT 'active',
    yes_count INTEGER DEFAULT 0,
    no_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- User votes on proposals
CREATE TABLE IF NOT EXISTS user_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    proposal_id INTEGER NOT NULL,
    vote TEXT NOT NULL,
    weight REAL DEFAULT 0,
    voted_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (proposal_id) REFERENCES proposals(id),
    UNIQUE(user_id, proposal_id)
);

-- Chat channels
CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'channel',
    is_private INTEGER DEFAULT 0,
    member_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Channel members (for DMs and private channels)
CREATE TABLE IF NOT EXISTS channel_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    FOREIGN KEY (channel_id) REFERENCES channels(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(channel_id, user_id)
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (channel_id) REFERENCES channels(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Voice stages
CREATE TABLE IF NOT EXISTS stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_live INTEGER DEFAULT 0,
    listener_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Network stats (aggregate data)
CREATE TABLE IF NOT EXISTS network_stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total_members INTEGER DEFAULT 0,
    annual_income REAL DEFAULT 0,
    active_nodes INTEGER DEFAULT 0,
    uptime_percentage REAL DEFAULT 99.97,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Invites (referral system)
CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    created_by INTEGER NOT NULL,
    used_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    used_at TEXT,
    expires_at TEXT,
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (used_by) REFERENCES users(id)
);
