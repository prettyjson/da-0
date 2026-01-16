const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDatabase, getDatabase } = require('./db/init');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database
initDatabase();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Helper to get DB connection
const db = () => getDatabase();

// ============ AUTH ROUTES (spoofed) ============
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const user = db().prepare('SELECT * FROM users WHERE username = ?').get(username.toUpperCase());

    if (user) {
        // Update online status
        db().prepare('UPDATE users SET is_online = 1 WHERE id = ?').run(user.id);

        // Get badges
        const badges = db().prepare('SELECT badge_name FROM user_badges WHERE user_id = ?').all(user.id);
        user.badges = badges.map(b => b.badge_name);

        res.json({ success: true, user });
    } else {
        // For MVP, create user on login if doesn't exist
        const result = db().prepare(`
            INSERT INTO users (username, is_online, stake_percentage, join_date)
            VALUES (?, 1, 0.1, ?)
        `).run(username.toUpperCase(), new Date().toISOString().slice(0, 10));

        const newUser = db().prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
        newUser.badges = [];
        res.json({ success: true, user: newUser });
    }
});

app.post('/api/auth/logout', (req, res) => {
    const { userId } = req.body;
    if (userId) {
        db().prepare('UPDATE users SET is_online = 0 WHERE id = ?').run(userId);
    }
    res.json({ success: true });
});

// ============ NETWORK STATS ROUTES ============
app.get('/api/stats', (req, res) => {
    const stats = db().prepare('SELECT * FROM network_stats WHERE id = 1').get();
    res.json(stats);
});

// ============ TREASURY ROUTES ============
app.get('/api/treasury', (req, res) => {
    const treasury = db().prepare('SELECT * FROM treasury WHERE id = 1').get();
    res.json(treasury);
});

// ============ USERS/MEMBERS ROUTES ============
app.get('/api/members', (req, res) => {
    const { limit = 50, offset = 0, sort = 'stake_percentage', order = 'DESC' } = req.query;
    const validSorts = ['stake_percentage', 'username', 'join_date', 'rank_code'];
    const sortColumn = validSorts.includes(sort) ? sort : 'stake_percentage';
    const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const members = db().prepare(`
        SELECT * FROM users
        ORDER BY ${sortColumn} ${sortOrder}
        LIMIT ? OFFSET ?
    `).all(parseInt(limit), parseInt(offset));

    const total = db().prepare('SELECT COUNT(*) as count FROM users').get();

    res.json({ members, total: total.count });
});

app.get('/api/members/leaderboard', (req, res) => {
    const { limit = 10 } = req.query;
    const leaders = db().prepare(`
        SELECT id, username, unit, stake_percentage, is_online, rank_code
        FROM users
        ORDER BY stake_percentage DESC
        LIMIT ?
    `).all(parseInt(limit));

    res.json(leaders);
});

app.get('/api/members/:id', (req, res) => {
    const user = db().prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    const badges = db().prepare('SELECT badge_name FROM user_badges WHERE user_id = ?').all(user.id);
    user.badges = badges.map(b => b.badge_name);

    res.json(user);
});

app.get('/api/members/username/:username', (req, res) => {
    const user = db().prepare('SELECT * FROM users WHERE username = ?').get(req.params.username.toUpperCase());
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    const badges = db().prepare('SELECT badge_name FROM user_badges WHERE user_id = ?').all(user.id);
    user.badges = badges.map(b => b.badge_name);

    res.json(user);
});

// ============ PROPOSALS/VOTES ROUTES ============
app.get('/api/proposals', (req, res) => {
    const { status } = req.query;
    let proposals;

    if (status) {
        proposals = db().prepare('SELECT * FROM proposals WHERE status = ? ORDER BY closes_date ASC').all(status);
    } else {
        proposals = db().prepare('SELECT * FROM proposals ORDER BY closes_date DESC').all();
    }

    res.json(proposals);
});

app.get('/api/proposals/:id', (req, res) => {
    const proposal = db().prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
    if (!proposal) {
        return res.status(404).json({ error: 'Proposal not found' });
    }
    res.json(proposal);
});

app.get('/api/proposals/:id/votes', (req, res) => {
    const votes = db().prepare(`
        SELECT uv.*, u.username
        FROM user_votes uv
        JOIN users u ON uv.user_id = u.id
        WHERE uv.proposal_id = ?
    `).all(req.params.id);

    res.json(votes);
});

app.post('/api/proposals/:id/vote', (req, res) => {
    const { userId, vote } = req.body;
    const proposalId = req.params.id;

    // Get user's stake for vote weight
    const user = db().prepare('SELECT stake_percentage FROM users WHERE id = ?').get(userId);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    try {
        // Insert or update vote
        db().prepare(`
            INSERT INTO user_votes (user_id, proposal_id, vote, weight)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, proposal_id) DO UPDATE SET vote = excluded.vote
        `).run(userId, proposalId, vote, user.stake_percentage);

        // Update vote counts
        const voteCounts = db().prepare(`
            SELECT
                SUM(CASE WHEN vote = 'yes' THEN 1 ELSE 0 END) as yes_count,
                SUM(CASE WHEN vote = 'no' THEN 1 ELSE 0 END) as no_count
            FROM user_votes WHERE proposal_id = ?
        `).get(proposalId);

        db().prepare(`
            UPDATE proposals SET yes_count = ?, no_count = ? WHERE id = ?
        `).run(voteCounts.yes_count, voteCounts.no_count, proposalId);

        res.json({ success: true, voteCounts });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/users/:userId/votes', (req, res) => {
    const votes = db().prepare(`
        SELECT uv.*, p.title as proposal_title, p.status as proposal_status
        FROM user_votes uv
        JOIN proposals p ON uv.proposal_id = p.id
        WHERE uv.user_id = ?
    `).all(req.params.userId);

    res.json(votes);
});

// ============ CHANNELS ROUTES ============
app.get('/api/channels', (req, res) => {
    const { type } = req.query;
    let channels;

    if (type) {
        channels = db().prepare('SELECT * FROM channels WHERE type = ?').all(type);
    } else {
        channels = db().prepare('SELECT * FROM channels').all();
    }

    // Add unread counts (mock for now - would need read receipts)
    channels = channels.map(c => ({
        ...c,
        unread_count: c.type === 'dm' ? Math.floor(Math.random() * 6) : Math.floor(Math.random() * 15)
    }));

    res.json(channels);
});

app.get('/api/channels/:id/messages', (req, res) => {
    const { limit = 50, before } = req.query;
    let messages;

    if (before) {
        messages = db().prepare(`
            SELECT m.*, u.username
            FROM messages m
            JOIN users u ON m.user_id = u.id
            WHERE m.channel_id = ? AND m.timestamp < ?
            ORDER BY m.timestamp DESC
            LIMIT ?
        `).all(req.params.id, before, parseInt(limit));
    } else {
        messages = db().prepare(`
            SELECT m.*, u.username
            FROM messages m
            JOIN users u ON m.user_id = u.id
            WHERE m.channel_id = ?
            ORDER BY m.timestamp ASC
            LIMIT ?
        `).all(req.params.id, parseInt(limit));
    }

    res.json(messages);
});

app.post('/api/channels/:id/messages', (req, res) => {
    const { userId, content } = req.body;
    const channelId = req.params.id;

    const result = db().prepare(`
        INSERT INTO messages (channel_id, user_id, content, timestamp)
        VALUES (?, ?, ?, ?)
    `).run(channelId, userId, content, new Date().toISOString());

    const message = db().prepare(`
        SELECT m.*, u.username
        FROM messages m
        JOIN users u ON m.user_id = u.id
        WHERE m.id = ?
    `).get(result.lastInsertRowid);

    res.json(message);
});

// ============ STAGES (VOICE CHANNELS) ROUTES ============
app.get('/api/stages', (req, res) => {
    const stages = db().prepare('SELECT * FROM stages ORDER BY is_live DESC, listener_count DESC').all();
    res.json(stages);
});

app.post('/api/stages/:id/join', (req, res) => {
    db().prepare('UPDATE stages SET listener_count = listener_count + 1 WHERE id = ?').run(req.params.id);
    const stage = db().prepare('SELECT * FROM stages WHERE id = ?').get(req.params.id);
    res.json(stage);
});

app.post('/api/stages/:id/leave', (req, res) => {
    db().prepare('UPDATE stages SET listener_count = MAX(0, listener_count - 1) WHERE id = ?').run(req.params.id);
    const stage = db().prepare('SELECT * FROM stages WHERE id = ?').get(req.params.id);
    res.json(stage);
});

// ============ USER PROFILE ROUTES ============
app.get('/api/profile/:userId', (req, res) => {
    const user = db().prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    const badges = db().prepare('SELECT badge_name FROM user_badges WHERE user_id = ?').all(user.id);
    user.badges = badges.map(b => b.badge_name);

    // Get vote history
    const votes = db().prepare(`
        SELECT uv.*, p.title as proposal_title
        FROM user_votes uv
        JOIN proposals p ON uv.proposal_id = p.id
        WHERE uv.user_id = ?
        ORDER BY uv.voted_at DESC
        LIMIT 10
    `).all(user.id);
    user.recent_votes = votes;

    res.json(user);
});

// ============ INVITE/REFERRAL ROUTES ============

// Generate a random invite code
function generateInviteCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'VET-';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Get week start (Sunday) for invite limit tracking
function getWeekStart() {
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    const weekStart = new Date(now);
    weekStart.setUTCDate(now.getUTCDate() - dayOfWeek);
    weekStart.setUTCHours(0, 0, 0, 0);
    return weekStart.toISOString();
}

// Get user's invites and stats
app.get('/api/invites/:userId', (req, res) => {
    const userId = req.params.userId;
    const weekStart = getWeekStart();

    // Get all invites created by user
    const invites = db().prepare(`
        SELECT i.*, u.username as used_by_username
        FROM invites i
        LEFT JOIN users u ON i.used_by = u.id
        WHERE i.created_by = ?
        ORDER BY i.created_at DESC
    `).all(userId);

    // Count invites created this week
    const weeklyCount = db().prepare(`
        SELECT COUNT(*) as count FROM invites
        WHERE created_by = ? AND created_at >= ?
    `).get(userId, weekStart);

    // Count successful referrals (invites that were used)
    const totalReferrals = db().prepare(`
        SELECT COUNT(*) as count FROM invites
        WHERE created_by = ? AND used_by IS NOT NULL
    `).get(userId);

    res.json({
        invites,
        weeklyInvitesUsed: weeklyCount.count,
        weeklyInvitesRemaining: Math.max(0, 5 - weeklyCount.count),
        totalReferrals: totalReferrals.count
    });
});

// Create a new invite
app.post('/api/invites', (req, res) => {
    const { userId } = req.body;
    const weekStart = getWeekStart();

    // Check weekly limit
    const weeklyCount = db().prepare(`
        SELECT COUNT(*) as count FROM invites
        WHERE created_by = ? AND created_at >= ?
    `).get(userId, weekStart);

    if (weeklyCount.count >= 5) {
        return res.status(429).json({
            error: 'Weekly invite limit reached',
            remaining: 0
        });
    }

    // Generate unique code
    let code;
    let attempts = 0;
    while (attempts < 10) {
        code = generateInviteCode();
        const existing = db().prepare('SELECT id FROM invites WHERE code = ?').get(code);
        if (!existing) break;
        attempts++;
    }

    // Set expiration to 7 days from now
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const result = db().prepare(`
        INSERT INTO invites (code, created_by, expires_at)
        VALUES (?, ?, ?)
    `).run(code, userId, expiresAt.toISOString());

    const invite = db().prepare('SELECT * FROM invites WHERE id = ?').get(result.lastInsertRowid);

    res.json({
        invite,
        remaining: 4 - weeklyCount.count
    });
});

// Use an invite code (during signup)
app.post('/api/invites/use', (req, res) => {
    const { code, userId } = req.body;

    // Find the invite
    const invite = db().prepare('SELECT * FROM invites WHERE code = ?').get(code.toUpperCase());

    if (!invite) {
        return res.status(404).json({ error: 'Invalid invite code' });
    }

    if (invite.used_by) {
        return res.status(400).json({ error: 'Invite code already used' });
    }

    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
        return res.status(400).json({ error: 'Invite code expired' });
    }

    // Mark invite as used
    db().prepare(`
        UPDATE invites SET used_by = ?, used_at = ?
        WHERE id = ?
    `).run(userId, new Date().toISOString(), invite.id);

    // Update user's referred_by
    db().prepare(`
        UPDATE users SET referred_by = ?
        WHERE id = ?
    `).run(invite.created_by, userId);

    // Get referrer info
    const referrer = db().prepare('SELECT id, username FROM users WHERE id = ?').get(invite.created_by);

    res.json({
        success: true,
        referrer
    });
});

// Get who referred a user
app.get('/api/users/:userId/referrer', (req, res) => {
    const user = db().prepare('SELECT referred_by FROM users WHERE id = ?').get(req.params.userId);

    if (!user || !user.referred_by) {
        return res.json({ referrer: null });
    }

    const referrer = db().prepare('SELECT id, username, rank_code, unit FROM users WHERE id = ?').get(user.referred_by);
    res.json({ referrer });
});

// Get users referred by a user
app.get('/api/users/:userId/referrals', (req, res) => {
    const referrals = db().prepare(`
        SELECT id, username, rank_code, unit, join_date, created_at
        FROM users
        WHERE referred_by = ?
        ORDER BY created_at DESC
    `).all(req.params.userId);

    res.json({ referrals, count: referrals.length });
});

// Serve index.html for all other routes (SPA support)
app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`VETNET Terminal Server running on http://localhost:${PORT}`);
});
