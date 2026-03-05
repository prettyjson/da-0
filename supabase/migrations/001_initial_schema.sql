-- ============================================================
-- The O Club - Initial Supabase Schema
-- Migrated from SQLite, extended for V1
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE,
    wallet_address TEXT UNIQUE,
    rank_code TEXT,
    rank_title TEXT,
    unit TEXT,
    mos TEXT,
    service_years TEXT,
    deployment_history TEXT,
    clearance TEXT,
    bio TEXT,
    photo_url TEXT,
    linkedin_url TEXT,
    x_handle TEXT,
    referral_code TEXT UNIQUE,
    referred_by UUID REFERENCES users(id),
    points INTEGER DEFAULT 0,
    verification_status TEXT DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected')),
    membership_status TEXT DEFAULT 'trial' CHECK (membership_status IN ('trial', 'active', 'inactive', 'cancelled')),
    trial_ends_at TIMESTAMPTZ,
    dues_paid_through DATE,
    is_online BOOLEAN DEFAULT FALSE,
    join_date TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- USER BADGES (awards/decorations)
-- ============================================================
CREATE TABLE user_badges (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    badge_name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TREASURY (single record for network finances)
-- ============================================================
CREATE TABLE treasury (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    balance NUMERIC(18, 2) DEFAULT 0,
    member_dues NUMERIC(18, 2) DEFAULT 0,
    donations_total NUMERIC(18, 2) DEFAULT 0,
    monthly_spending NUMERIC(18, 2) DEFAULT 0,
    marketing_pct NUMERIC(5, 2) DEFAULT 40,
    hosting_pct NUMERIC(5, 2) DEFAULT 30,
    reserve_pct NUMERIC(5, 2) DEFAULT 30,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CHANNELS (chat)
-- ============================================================
CREATE TABLE channels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    type TEXT DEFAULT 'channel' CHECK (type IN ('channel', 'dm')),
    is_private BOOLEAN DEFAULT FALSE,
    member_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE channel_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(channel_id, user_id)
);

-- ============================================================
-- MESSAGES
-- ============================================================
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    reply_to_id UUID REFERENCES messages(id),
    attachment_url TEXT,
    attachment_type TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE message_reactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(message_id, user_id, emoji)
);

-- ============================================================
-- STAGES (legacy voice rooms)
-- ============================================================
CREATE TABLE stages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    is_live BOOLEAN DEFAULT FALSE,
    listener_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- NETWORK STATS (aggregate)
-- ============================================================
CREATE TABLE network_stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total_members INTEGER DEFAULT 0,
    active_members INTEGER DEFAULT 0,
    new_this_month INTEGER DEFAULT 0,
    churned_this_month INTEGER DEFAULT 0,
    reclaimed_this_month INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INVITES / REFERRALS
-- ============================================================
CREATE TABLE invites (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code TEXT UNIQUE NOT NULL,
    created_by UUID NOT NULL REFERENCES users(id),
    used_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ
);

CREATE TABLE referrals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    referrer_id UUID NOT NULL REFERENCES users(id),
    referred_id UUID NOT NULL REFERENCES users(id),
    points_awarded INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(referrer_id, referred_id)
);

-- ============================================================
-- NETS (audio rooms - like Twitter Spaces)
-- ============================================================
CREATE TABLE nets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    description TEXT,
    host_id UUID NOT NULL REFERENCES users(id),
    status TEXT DEFAULT 'live' CHECK (status IN ('live', 'ended', 'scheduled')),
    is_recording BOOLEAN DEFAULT FALSE,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    scheduled_for TIMESTAMPTZ,
    max_speakers INTEGER DEFAULT 10
);

CREATE TABLE net_participants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    net_id UUID NOT NULL REFERENCES nets(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'listener' CHECK (role IN ('host', 'co-host', 'speaker', 'listener')),
    is_muted BOOLEAN DEFAULT TRUE,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    left_at TIMESTAMPTZ,
    UNIQUE(net_id, user_id)
);

CREATE TABLE speak_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    net_id UUID NOT NULL REFERENCES nets(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES users(id)
);

CREATE TABLE net_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    net_id UUID NOT NULL REFERENCES nets(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- POINTS SYSTEM
-- ============================================================
CREATE TABLE points_ledger (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PAYMENTS
-- ============================================================
CREATE TABLE dues_payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    amount NUMERIC(18, 6) NOT NULL,
    tx_hash TEXT,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    is_prorated BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE donations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    amount NUMERIC(18, 6) NOT NULL,
    tx_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SPEND PERMISSIONS (EIP-712 for recurring dues)
-- ============================================================
CREATE TABLE spend_permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    wallet_address TEXT NOT NULL,
    signature TEXT NOT NULL,
    allowance NUMERIC(18, 6) NOT NULL,
    period INTEGER NOT NULL,
    start_time BIGINT NOT NULL,
    end_time BIGINT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    approved_on_chain BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);

-- ============================================================
-- MEMBER LOCATIONS (world map)
-- ============================================================
CREATE TABLE member_locations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT,
    city TEXT NOT NULL,
    country TEXT NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    is_primary BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Max 3 locations per user enforced at application level

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_users_wallet ON users(wallet_address);
CREATE INDEX idx_users_referral_code ON users(referral_code);
CREATE INDEX idx_users_membership_status ON users(membership_status);
CREATE INDEX idx_points_ledger_user ON points_ledger(user_id);
CREATE INDEX idx_points_ledger_created ON points_ledger(created_at);
CREATE INDEX idx_dues_payments_user ON dues_payments(user_id);
CREATE INDEX idx_donations_user ON donations(user_id);
CREATE INDEX idx_messages_channel ON messages(channel_id);
CREATE INDEX idx_messages_created ON messages(created_at);
CREATE INDEX idx_member_locations_user ON member_locations(user_id);
CREATE INDEX idx_member_locations_primary ON member_locations(is_primary) WHERE is_primary = TRUE;
CREATE INDEX idx_spend_permissions_user ON spend_permissions(user_id);
CREATE INDEX idx_spend_permissions_active ON spend_permissions(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX idx_net_participants_net ON net_participants(net_id);
CREATE INDEX idx_net_participants_user ON net_participants(user_id);

-- ============================================================
-- INITIAL DATA
-- ============================================================
INSERT INTO treasury (id, balance, member_dues, donations_total) VALUES (1, 0, 0, 0);
INSERT INTO network_stats (id, total_members, active_members) VALUES (1, 0, 0);
