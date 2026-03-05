const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { initDatabase, getDatabase } = require('./db/init');
const cfVoice = require('./cloudflare-voice');

const app = express();
const PORT = process.env.PORT || 3001;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Initialize database
initDatabase();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased limit for base64 image uploads
// Serve Vite build output in production, root dir in development
const isProduction = process.env.NODE_ENV === 'production';
const staticDir = isProduction ? path.join(__dirname, 'dist') : __dirname;
app.use(express.static(staticDir));

// Helper to get DB connection
const db = () => getDatabase();

// ============ WEBSOCKET SETUP ============
// Track connected clients by net ID
const netClients = new Map(); // netId -> Set of WebSocket clients

wss.on('connection', (ws) => {
    console.log('WebSocket client connected');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // Handle subscription to net updates
            if (data.type === 'subscribe' && data.netId) {
                const netIdStr = String(data.netId);
                if (!netClients.has(netIdStr)) {
                    netClients.set(netIdStr, new Set());
                }
                netClients.get(netIdStr).add(ws);
                ws.currentNetId = netIdStr;
                console.log(`Client subscribed to net ${netIdStr}`);
            }

            // Handle unsubscribe
            if (data.type === 'unsubscribe' && ws.currentNetId) {
                const clients = netClients.get(ws.currentNetId);
                if (clients) {
                    clients.delete(ws);
                }
                ws.currentNetId = null;
                console.log('Client unsubscribed from net');
            }
        } catch (err) {
            console.error('Error parsing WebSocket message:', err);
        }
    });

    ws.on('close', () => {
        // Clean up subscriptions
        if (ws.currentNetId) {
            const clients = netClients.get(ws.currentNetId);
            if (clients) {
                clients.delete(ws);
                if (clients.size === 0) {
                    netClients.delete(ws.currentNetId);
                }
            }
        }
        console.log('WebSocket client disconnected');
    });
});

// Broadcast function to send updates to all clients subscribed to a specific net
function broadcastToNet(netId, event, data) {
    const clients = netClients.get(String(netId));
    if (!clients) return;

    const message = JSON.stringify({ event, data, netId });

    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });

    console.log(`Broadcast ${event} to ${clients.size} clients in net ${netId}`);
}

// Broadcast to all connected clients
function broadcastToAll(event, data) {
    const message = JSON.stringify({ event, data });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });

    console.log(`Broadcast ${event} to ${wss.clients.size} clients`);
}

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

// ============ CDP AUTH SYNC ============
// Called after Coinbase CDP wallet login to create/update user in our DB
app.post('/api/auth/sync', (req, res) => {
    const { cdpUserId, email, walletAddress } = req.body;

    if (!walletAddress) {
        return res.status(400).json({ error: 'Wallet address required' });
    }

    try {
        // Check if user exists by wallet address
        let user = db().prepare('SELECT * FROM users WHERE username = ?').get(walletAddress.toUpperCase());

        if (user) {
            // Existing user - update online status
            db().prepare('UPDATE users SET is_online = 1 WHERE id = ?').run(user.id);
            const badges = db().prepare('SELECT badge_name FROM user_badges WHERE user_id = ?').all(user.id);
            user.badges = badges.map(b => b.badge_name);
            res.json({ success: true, user, isNewUser: false });
        } else {
            // New user - create account (pending DD-214 verification)
            const callsign = email
                ? email.split('@')[0].toUpperCase().replace(/[^A-Z0-9]/g, '_')
                : walletAddress.slice(0, 10).toUpperCase();

            const result = db().prepare(`
                INSERT INTO users (username, email, is_online, stake_percentage, join_date)
                VALUES (?, ?, 1, 0.1, ?)
            `).run(callsign, email || null, new Date().toISOString().slice(0, 10));

            const newUser = db().prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
            newUser.badges = [];

            res.json({
                success: true,
                user: newUser,
                isNewUser: true,
                // New users must complete DD-214 verification
                requiresVerification: true,
            });
        }
    } catch (error) {
        console.error('Auth sync error:', error);
        res.status(500).json({ error: 'Failed to sync user' });
    }
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

// Search users (for DM creation)
app.get('/api/users/search', (req, res) => {
    const { q } = req.query;

    if (!q || q.trim().length < 2) {
        return res.json([]);
    }

    const searchTerm = `%${q.toUpperCase()}%`;
    const users = db().prepare(`
        SELECT id, username, rank_code, rank_title, unit
        FROM users
        WHERE username LIKE ?
        ORDER BY username ASC
        LIMIT 20
    `).all(searchTerm);

    res.json(users);
});

// ============ POINTS SYSTEM ============

// Point values and multipliers
const POINTS_CONFIG = {
    actions: {
        accepted_into_network: 500,
        monthly_dues: 50,
        donation_per_dollar: 1,
        referral_accepted: 300,
        profile_complete: 50,
        first_chat_message: 25,
    },
    tiers: [
        { name: 'FIRST_100', threshold: 100, multipliers: { accepted_into_network: 5, monthly_dues: 3, donation_per_dollar: 2, referral_accepted: 3, profile_complete: 2, first_chat_message: 2 } },
        { name: 'FIRST_1000', threshold: 1000, multipliers: { accepted_into_network: 2, monthly_dues: 1.5, donation_per_dollar: 1.25, referral_accepted: 1.5, profile_complete: 1.5, first_chat_message: 1 } },
        { name: 'STANDARD', threshold: Infinity, multipliers: { accepted_into_network: 1, monthly_dues: 1, donation_per_dollar: 1, referral_accepted: 1, profile_complete: 1, first_chat_message: 1 } },
    ]
};

// Get current multiplier tier based on member count
function getCurrentTier(memberCount) {
    for (const tier of POINTS_CONFIG.tiers) {
        if (memberCount < tier.threshold) return tier;
    }
    return POINTS_CONFIG.tiers[POINTS_CONFIG.tiers.length - 1];
}

// Get multiplier breakdown (publicly displayed)
app.get('/api/points/multipliers', (req, res) => {
    try {
        const stats = db().prepare('SELECT total_members FROM network_stats WHERE id = 1').get();
        const memberCount = stats ? stats.total_members : 0;
        const currentTier = getCurrentTier(memberCount);

        res.json({
            memberCount,
            currentTier: currentTier.name,
            tiers: POINTS_CONFIG.tiers.map(t => ({
                name: t.name,
                threshold: t.threshold === Infinity ? null : t.threshold,
                multipliers: t.multipliers,
                isActive: t.name === currentTier.name,
            })),
            basePoints: POINTS_CONFIG.actions,
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load multipliers' });
    }
});

// Get leaderboard (ranked by points)
app.get('/api/leaderboard', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        // For now, use stub data. Will query points from Supabase when wired up.
        const leaders = db().prepare(`
            SELECT id, username, rank_code, unit, stake_percentage, is_online
            FROM users
            ORDER BY stake_percentage DESC
            LIMIT ?
        `).all(limit);

        // Map stake_percentage to points for now (stub)
        const leaderboard = leaders.map((u, i) => ({
            rank: i + 1,
            callsign: u.username,
            unit: u.unit,
            points: Math.floor(u.stake_percentage * 1000),
            isOnline: u.is_online === 1,
        }));

        res.json({ leaderboard });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load leaderboard' });
    }
});

// Get point breakdown for a specific user
app.get('/api/points/:userId', (req, res) => {
    // Stub - will be replaced with Supabase query on points_ledger
    res.json({
        totalPoints: 0,
        rank: 0,
        breakdown: [],
    });
});

// ============ PROPOSALS/VOTES ROUTES (DEPRECATED - Vote tab removed for V1) ============
/*
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
*/

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

    // Add reactions to each message
    messages.forEach(msg => {
        const reactions = db().prepare(`
            SELECT mr.emoji, mr.user_id, u.username
            FROM message_reactions mr
            JOIN users u ON mr.user_id = u.id
            WHERE mr.message_id = ?
            ORDER BY mr.created_at
        `).all(msg.id);

        // Group by emoji
        const grouped = {};
        reactions.forEach(r => {
            if (!grouped[r.emoji]) {
                grouped[r.emoji] = { count: 0, users: [] };
            }
            grouped[r.emoji].count++;
            grouped[r.emoji].users.push({ id: r.user_id, username: r.username });
        });

        msg.reactions = grouped;
    });

    res.json(messages);
});

app.post('/api/channels/:id/messages', (req, res) => {
    const { userId, content, replyToId, attachmentUrl, attachmentType } = req.body;
    const channelId = req.params.id;

    const result = db().prepare(`
        INSERT INTO messages (channel_id, user_id, content, reply_to_id, attachment_url, attachment_type, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(channelId, userId, content || '', replyToId || null, attachmentUrl || null, attachmentType || null, new Date().toISOString());

    const message = db().prepare(`
        SELECT m.*, u.username
        FROM messages m
        JOIN users u ON m.user_id = u.id
        WHERE m.id = ?
    `).get(result.lastInsertRowid);

    // Broadcast message to all clients
    broadcastToAll('channel:message', { channelId, message });

    res.json(message);
});

// Toggle reaction on a message
app.post('/api/messages/:id/reactions', (req, res) => {
    const { userId, emoji } = req.body;
    const messageId = req.params.id;

    // Check if reaction already exists
    const existing = db().prepare(`
        SELECT * FROM message_reactions
        WHERE message_id = ? AND user_id = ? AND emoji = ?
    `).get(messageId, userId, emoji);

    if (existing) {
        // Remove reaction
        db().prepare(`
            DELETE FROM message_reactions
            WHERE message_id = ? AND user_id = ? AND emoji = ?
        `).run(messageId, userId, emoji);
    } else {
        // Add reaction
        db().prepare(`
            INSERT INTO message_reactions (message_id, user_id, emoji, created_at)
            VALUES (?, ?, ?, ?)
        `).run(messageId, userId, emoji, new Date().toISOString());
    }

    // Get all reactions for this message with user details
    const reactions = db().prepare(`
        SELECT mr.emoji, mr.user_id, u.username
        FROM message_reactions mr
        JOIN users u ON mr.user_id = u.id
        WHERE mr.message_id = ?
        ORDER BY mr.created_at
    `).all(messageId);

    // Group by emoji
    const grouped = {};
    reactions.forEach(r => {
        if (!grouped[r.emoji]) {
            grouped[r.emoji] = { count: 0, users: [] };
        }
        grouped[r.emoji].count++;
        grouped[r.emoji].users.push({ id: r.user_id, username: r.username });
    });

    // Get channel ID for broadcasting
    const message = db().prepare('SELECT channel_id FROM messages WHERE id = ?').get(messageId);

    // Broadcast reaction update to all clients
    broadcastToAll('message:reactions', {
        messageId: parseInt(messageId),
        channelId: message.channel_id,
        reactions: grouped
    });

    res.json({ reactions: grouped });
});

// Get reactions for a message
app.get('/api/messages/:id/reactions', (req, res) => {
    const messageId = req.params.id;

    const reactions = db().prepare(`
        SELECT mr.emoji, mr.user_id, u.username
        FROM message_reactions mr
        JOIN users u ON mr.user_id = u.id
        WHERE mr.message_id = ?
        ORDER BY mr.created_at
    `).all(messageId);

    // Group by emoji
    const grouped = {};
    reactions.forEach(r => {
        if (!grouped[r.emoji]) {
            grouped[r.emoji] = { count: 0, users: [] };
        }
        grouped[r.emoji].count++;
        grouped[r.emoji].users.push({ id: r.user_id, username: r.username });
    });

    res.json({ reactions: grouped });
});

// Create a new channel
app.post('/api/channels', (req, res) => {
    const { userId, name, isPrivate } = req.body;

    if (!name || name.trim().length === 0) {
        return res.status(400).json({ error: 'Channel name is required' });
    }

    // Check if channel name already exists
    const existing = db().prepare('SELECT * FROM channels WHERE name = ? AND type = ?').get(name.toUpperCase(), 'channel');
    if (existing) {
        return res.status(400).json({ error: 'Channel name already exists' });
    }

    const result = db().prepare(`
        INSERT INTO channels (name, type, is_private, member_count, created_at)
        VALUES (?, 'channel', ?, 0, ?)
    `).run(name.toUpperCase(), isPrivate ? 1 : 0, new Date().toISOString());

    const channel = db().prepare('SELECT * FROM channels WHERE id = ?').get(result.lastInsertRowid);

    // Add creator as member if private
    if (isPrivate) {
        db().prepare(`
            INSERT INTO channel_members (channel_id, user_id)
            VALUES (?, ?)
        `).run(channel.id, userId);
    }

    // Broadcast new channel to all clients
    broadcastToAll('channel:created', channel);

    res.json(channel);
});

// Create or get existing DM
app.post('/api/dms/create', (req, res) => {
    const { userId, targetUserId } = req.body;

    if (!targetUserId) {
        return res.status(400).json({ error: 'Target user is required' });
    }

    if (userId === targetUserId) {
        return res.status(400).json({ error: 'Cannot create DM with yourself' });
    }

    // Check if DM already exists between these two users
    const existingDMs = db().prepare(`
        SELECT c.* FROM channels c
        WHERE c.type = 'dm'
        AND c.id IN (
            SELECT channel_id FROM channel_members WHERE user_id = ?
        )
        AND c.id IN (
            SELECT channel_id FROM channel_members WHERE user_id = ?
        )
    `).all(userId, targetUserId);

    if (existingDMs.length > 0) {
        // DM already exists, return it with member info
        const dm = existingDMs[0];
        const members = db().prepare(`
            SELECT u.id, u.username FROM users u
            JOIN channel_members cm ON cm.user_id = u.id
            WHERE cm.channel_id = ?
        `).all(dm.id);
        return res.json({ ...dm, members });
    }

    // Create new DM channel
    const targetUser = db().prepare('SELECT username FROM users WHERE id = ?').get(targetUserId);
    if (!targetUser) {
        return res.status(404).json({ error: 'Target user not found' });
    }

    const dmName = `DM_${targetUser.username}`;

    const result = db().prepare(`
        INSERT INTO channels (name, type, is_private, member_count, created_at)
        VALUES (?, 'dm', 1, 2, ?)
    `).run(dmName, new Date().toISOString());

    const channelId = result.lastInsertRowid;

    // Add both users as members
    db().prepare(`INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)`).run(channelId, userId);
    db().prepare(`INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)`).run(channelId, targetUserId);

    const dm = db().prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    const members = db().prepare(`
        SELECT u.id, u.username FROM users u
        JOIN channel_members cm ON cm.user_id = u.id
        WHERE cm.channel_id = ?
    `).all(channelId);

    // Broadcast new DM to both users
    broadcastToAll('dm:created', { ...dm, members });

    res.json({ ...dm, members });
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

// ============ NETS (AUDIO ROOMS) ROUTES ============

// Get all live/scheduled nets
app.get('/api/nets', (req, res) => {
    const { status = 'live' } = req.query;
    const nets = db().prepare(`
        SELECT n.*, u.username as host_username, u.rank_code as host_rank,
        (SELECT COUNT(*) FROM net_participants WHERE net_id = n.id AND left_at IS NULL) as participant_count,
        (SELECT COUNT(*) FROM net_participants WHERE net_id = n.id AND role IN ('speaker', 'co-host', 'host') AND left_at IS NULL) as speaker_count
        FROM nets n
        JOIN users u ON n.host_id = u.id
        WHERE n.status = ?
        ORDER BY n.started_at DESC
    `).all(status);
    res.json(nets);
});

// Create a new net
app.post('/api/nets', (req, res) => {
    const { userId, name, description } = req.body;

    const result = db().prepare(`
        INSERT INTO nets (name, description, host_id, status, started_at)
        VALUES (?, ?, ?, 'live', ?)
    `).run(name, description || null, userId, new Date().toISOString());

    // Add host as participant
    db().prepare(`
        INSERT INTO net_participants (net_id, user_id, role, is_muted)
        VALUES (?, ?, 'host', 0)
    `).run(result.lastInsertRowid, userId);

    const net = db().prepare(`
        SELECT n.*, u.username as host_username
        FROM nets n
        JOIN users u ON n.host_id = u.id
        WHERE n.id = ?
    `).get(result.lastInsertRowid);

    // Broadcast new net to all clients
    broadcastToAll('net:created', net);

    res.json(net);
});

// Get a single net with participants
app.get('/api/nets/:id', (req, res) => {
    const net = db().prepare(`
        SELECT n.*, u.username as host_username, u.rank_code as host_rank
        FROM nets n
        JOIN users u ON n.host_id = u.id
        WHERE n.id = ?
    `).get(req.params.id);

    if (!net) {
        return res.status(404).json({ error: 'Net not found' });
    }

    const participants = db().prepare(`
        SELECT np.*, u.username, u.rank_code, u.unit
        FROM net_participants np
        JOIN users u ON np.user_id = u.id
        WHERE np.net_id = ? AND np.left_at IS NULL
        ORDER BY
            CASE np.role
                WHEN 'host' THEN 1
                WHEN 'co-host' THEN 2
                WHEN 'speaker' THEN 3
                ELSE 4
            END
    `).all(req.params.id);

    const pendingRequests = db().prepare(`
        SELECT sr.*, u.username
        FROM speak_requests sr
        JOIN users u ON sr.user_id = u.id
        WHERE sr.net_id = ? AND sr.status = 'pending'
    `).all(req.params.id);

    net.participants = participants;
    net.pendingRequests = pendingRequests;
    net.speakerCount = participants.filter(p => ['host', 'co-host', 'speaker'].includes(p.role)).length;
    net.listenerCount = participants.filter(p => p.role === 'listener').length;

    res.json(net);
});

// Join a net as listener (or reclaim host role if original host)
app.post('/api/nets/:id/join', (req, res) => {
    const { userId } = req.body;
    const netId = req.params.id;

    // Check if already in net
    const existing = db().prepare(`
        SELECT * FROM net_participants WHERE net_id = ? AND user_id = ? AND left_at IS NULL
    `).get(netId, userId);

    if (existing) {
        return res.json({ success: true, participant: existing, message: 'Already in net' });
    }

    // Check if user is the original host of this net
    const net = db().prepare('SELECT * FROM nets WHERE id = ?').get(netId);
    const isOriginalHost = net && net.host_id === userId;

    // Check if was in net before (rejoin)
    const previous = db().prepare(`
        SELECT * FROM net_participants WHERE net_id = ? AND user_id = ?
    `).get(netId, userId);

    // Determine role: original host reclaims host role, others join as listener
    const role = isOriginalHost ? 'host' : 'listener';
    const isMuted = isOriginalHost ? 0 : 1;

    if (previous) {
        db().prepare(`
            UPDATE net_participants SET left_at = NULL, joined_at = ?, role = ?, is_muted = ?
            WHERE net_id = ? AND user_id = ?
        `).run(new Date().toISOString(), role, isMuted, netId, userId);
    } else {
        db().prepare(`
            INSERT INTO net_participants (net_id, user_id, role, is_muted)
            VALUES (?, ?, ?, ?)
        `).run(netId, userId, role, isMuted);
    }

    const participant = db().prepare(`
        SELECT np.*, u.username FROM net_participants np
        JOIN users u ON np.user_id = u.id
        WHERE np.net_id = ? AND np.user_id = ?
    `).get(netId, userId);

    // Broadcast participant update to all clients in this net
    broadcastToNet(netId, 'net:participant:join', participant);

    res.json({ success: true, participant, hostReclaimed: isOriginalHost });
});

// Leave a net
app.post('/api/nets/:id/leave', (req, res) => {
    const { userId } = req.body;
    const netId = req.params.id;

    db().prepare(`
        UPDATE net_participants SET left_at = ?
        WHERE net_id = ? AND user_id = ?
    `).run(new Date().toISOString(), netId, userId);

    // Broadcast participant leave to all clients in this net
    broadcastToNet(netId, 'net:participant:leave', { userId });

    res.json({ success: true });
});

// End a net (host only)
app.post('/api/nets/:id/end', (req, res) => {
    const { userId } = req.body;
    const netId = req.params.id;

    const net = db().prepare('SELECT * FROM nets WHERE id = ?').get(netId);
    if (!net) {
        return res.status(404).json({ error: 'Net not found' });
    }

    // Check if user is host or co-host
    const participant = db().prepare(`
        SELECT * FROM net_participants WHERE net_id = ? AND user_id = ? AND role IN ('host', 'co-host')
    `).get(netId, userId);

    if (!participant && net.host_id !== userId) {
        return res.status(403).json({ error: 'Only hosts can end the net' });
    }

    db().prepare(`
        UPDATE nets SET status = 'ended', ended_at = ?
        WHERE id = ?
    `).run(new Date().toISOString(), netId);

    // Mark all participants as left
    db().prepare(`
        UPDATE net_participants SET left_at = ?
        WHERE net_id = ? AND left_at IS NULL
    `).run(new Date().toISOString(), netId);

    // End voice room
    cfVoice.endRoom(netId).catch(err => console.error('Voice room end error:', err));

    // Broadcast net ended to all clients (including participants)
    broadcastToAll('net:ended', { netId });

    res.json({ success: true });
});

// Invite co-host
app.post('/api/nets/:id/invite-cohost', (req, res) => {
    const { userId, targetUserId } = req.body;
    const netId = req.params.id;

    // Verify requester is host
    const net = db().prepare('SELECT * FROM nets WHERE id = ? AND host_id = ?').get(netId, userId);
    if (!net) {
        return res.status(403).json({ error: 'Only hosts can invite co-hosts' });
    }

    // Update target user's role
    db().prepare(`
        UPDATE net_participants SET role = 'co-host', is_muted = 0
        WHERE net_id = ? AND user_id = ?
    `).run(netId, targetUserId);

    res.json({ success: true });
});

// Request to speak
app.post('/api/nets/:id/request-speak', (req, res) => {
    const { userId } = req.body;
    const netId = req.params.id;

    // Check if already requested
    const existing = db().prepare(`
        SELECT * FROM speak_requests WHERE net_id = ? AND user_id = ? AND status = 'pending'
    `).get(netId, userId);

    if (existing) {
        return res.json({ success: true, request: existing, message: 'Request already pending' });
    }

    const result = db().prepare(`
        INSERT INTO speak_requests (net_id, user_id, status)
        VALUES (?, ?, 'pending')
    `).run(netId, userId);

    const request = db().prepare(`
        SELECT sr.*, u.username
        FROM speak_requests sr
        JOIN users u ON sr.user_id = u.id
        WHERE sr.id = ?
    `).get(result.lastInsertRowid);

    // Broadcast new speak request to all clients in this net (hosts need to see it)
    broadcastToNet(netId, 'net:request:new', request);

    res.json({ success: true, request });
});

// Get pending speak requests (for hosts)
app.get('/api/nets/:id/speak-requests', (req, res) => {
    const requests = db().prepare(`
        SELECT sr.*, u.username, u.rank_code
        FROM speak_requests sr
        JOIN users u ON sr.user_id = u.id
        WHERE sr.net_id = ? AND sr.status = 'pending'
        ORDER BY sr.requested_at ASC
    `).all(req.params.id);
    res.json(requests);
});

// Approve speaker
app.post('/api/nets/:id/approve-speaker', (req, res) => {
    const { userId, targetUserId, requestId } = req.body;
    const netId = req.params.id;

    // Verify requester is host/co-host
    const participant = db().prepare(`
        SELECT * FROM net_participants WHERE net_id = ? AND user_id = ? AND role IN ('host', 'co-host')
    `).get(netId, userId);

    if (!participant) {
        return res.status(403).json({ error: 'Only hosts can approve speakers' });
    }

    // Check max speakers limit (10)
    const speakerCount = db().prepare(`
        SELECT COUNT(*) as count FROM net_participants
        WHERE net_id = ? AND role IN ('host', 'co-host', 'speaker') AND left_at IS NULL
    `).get(netId);

    if (speakerCount.count >= 10) {
        return res.status(400).json({ error: 'Maximum 10 speakers allowed. Demote someone first.' });
    }

    // Update speak request
    db().prepare(`
        UPDATE speak_requests SET status = 'approved', resolved_at = ?, resolved_by = ?
        WHERE id = ?
    `).run(new Date().toISOString(), userId, requestId);

    // Update participant role
    db().prepare(`
        UPDATE net_participants SET role = 'speaker', is_muted = 0
        WHERE net_id = ? AND user_id = ?
    `).run(netId, targetUserId);

    // Update voice room role
    cfVoice.updateRole(netId, targetUserId, 'speaker');

    // Broadcast role change to all clients in this net
    broadcastToNet(netId, 'net:participant:role', { userId: targetUserId, role: 'speaker', isMuted: false });

    res.json({ success: true });
});

// Deny speaker request
app.post('/api/nets/:id/deny-speaker', (req, res) => {
    const { userId, requestId } = req.body;
    const netId = req.params.id;

    // Verify requester is host/co-host
    const participant = db().prepare(`
        SELECT * FROM net_participants WHERE net_id = ? AND user_id = ? AND role IN ('host', 'co-host')
    `).get(netId, userId);

    if (!participant) {
        return res.status(403).json({ error: 'Only hosts can deny speakers' });
    }

    db().prepare(`
        UPDATE speak_requests SET status = 'denied', resolved_at = ?, resolved_by = ?
        WHERE id = ?
    `).run(new Date().toISOString(), userId, requestId);

    // Broadcast request denial to all clients in this net
    broadcastToNet(netId, 'net:request:denied', { requestId });

    res.json({ success: true });
});

// Demote speaker back to listener
app.post('/api/nets/:id/demote-speaker', (req, res) => {
    const { userId, targetUserId } = req.body;
    const netId = req.params.id;

    // Verify requester is host/co-host
    const participant = db().prepare(`
        SELECT * FROM net_participants WHERE net_id = ? AND user_id = ? AND role IN ('host', 'co-host')
    `).get(netId, userId);

    if (!participant) {
        return res.status(403).json({ error: 'Only hosts can demote speakers' });
    }

    db().prepare(`
        UPDATE net_participants SET role = 'listener', is_muted = 1
        WHERE net_id = ? AND user_id = ?
    `).run(netId, targetUserId);

    // Update voice room role
    const voiceChange = cfVoice.updateRole(netId, targetUserId, 'listener');
    if (voiceChange.removedTrack) {
        broadcastToNet(netId, 'voice:track:removed', {
            trackName: voiceChange.removedTrack,
            userId: targetUserId,
        });
    }

    // Broadcast role change to all clients in this net
    broadcastToNet(netId, 'net:participant:role', { userId: targetUserId, role: 'listener', isMuted: true });

    res.json({ success: true });
});

// Toggle mute (for speakers)
app.post('/api/nets/:id/toggle-mute', (req, res) => {
    const { userId } = req.body;
    const netId = req.params.id;

    const participant = db().prepare(`
        SELECT * FROM net_participants WHERE net_id = ? AND user_id = ?
    `).get(netId, userId);

    if (!participant || participant.role === 'listener') {
        return res.status(403).json({ error: 'Only speakers can toggle mute' });
    }

    const newMuteState = participant.is_muted ? 0 : 1;
    db().prepare(`
        UPDATE net_participants SET is_muted = ?
        WHERE net_id = ? AND user_id = ?
    `).run(newMuteState, netId, userId);

    // Sync mute state with voice room
    cfVoice.setMuted(netId, userId, Boolean(newMuteState));

    // Broadcast mute state change to all clients in this net
    broadcastToNet(netId, 'net:participant:mute', { userId, isMuted: Boolean(newMuteState) });

    res.json({ success: true, is_muted: newMuteState });
});

// Get net chat messages
app.get('/api/nets/:id/messages', (req, res) => {
    const { limit = 100 } = req.query;
    const messages = db().prepare(`
        SELECT nm.*, u.username, u.rank_code
        FROM net_messages nm
        JOIN users u ON nm.user_id = u.id
        WHERE nm.net_id = ?
        ORDER BY nm.timestamp ASC
        LIMIT ?
    `).all(req.params.id, parseInt(limit));
    res.json(messages);
});

// Send net chat message
app.post('/api/nets/:id/messages', (req, res) => {
    const { userId, content } = req.body;
    const netId = req.params.id;

    // Verify user is in net
    const participant = db().prepare(`
        SELECT * FROM net_participants WHERE net_id = ? AND user_id = ? AND left_at IS NULL
    `).get(netId, userId);

    if (!participant) {
        return res.status(403).json({ error: 'Must be in net to send messages' });
    }

    const result = db().prepare(`
        INSERT INTO net_messages (net_id, user_id, content, timestamp)
        VALUES (?, ?, ?, ?)
    `).run(netId, userId, content, new Date().toISOString());

    const message = db().prepare(`
        SELECT nm.*, u.username, u.rank_code
        FROM net_messages nm
        JOIN users u ON nm.user_id = u.id
        WHERE nm.id = ?
    `).get(result.lastInsertRowid);

    // Broadcast new message to all clients in this net
    broadcastToNet(netId, 'net:message', message);

    res.json(message);
});

// ============ CLOUDFLARE VOICE ROUTES ============

// Check if voice is configured
app.get('/api/voice/config', (req, res) => {
    res.json({ enabled: cfVoice.isEnabled() });
});

// Join a voice room — creates a CF session, returns SDP offer
app.post('/api/voice/:netId/join', async (req, res) => {
    const { userId, username, role } = req.body;
    const netId = req.params.netId;

    if (!cfVoice.isEnabled()) {
        return res.status(503).json({
            error: 'Voice not configured',
            message: 'Cloudflare Calls credentials not set.',
        });
    }

    try {
        const result = await cfVoice.joinRoom(netId, userId, username, role);
        res.json(result);
    } catch (error) {
        console.error('Voice join error:', error);
        res.status(500).json({ error: 'Failed to join voice room' });
    }
});

// Push local track to CF + do SDP exchange (speakers only)
// Also registers the track and broadcasts to other participants.
app.post('/api/voice/:netId/publish-track', async (req, res) => {
    const { userId, trackName, sessionDescription, mid } = req.body;
    const netId = req.params.netId;

    try {
        const room = cfVoice.getRoom(netId);
        const participant = room.participants.get(String(userId));
        if (!participant) {
            return res.status(404).json({ error: 'Not in voice room' });
        }

        console.log(`[CF] Publishing track ${trackName} for ${participant.username} (session: ${participant.sessionId}, mid: ${mid})`);

        // Push local track to CF — sends SDP offer, gets answer
        const result = await cfVoice.pushTrack(participant.sessionId, {
            sessionDescription,
            trackName,
            mid,
        });

        console.log(`[CF] Push response: hasAnswer=${!!result.sessionDescription}, renegotiate=${result.requiresImmediateRenegotiation}`);

        // Register track in room state
        const trackInfo = await cfVoice.onTrackPublished(netId, userId, trackName);

        // Notify other participants to pull this new track
        if (trackInfo) {
            broadcastToNet(netId, 'voice:track:new', trackInfo);
        }

        res.json(result);
    } catch (error) {
        console.error('Voice publish-track error:', error);
        res.status(500).json({ error: 'Failed to publish track' });
    }
});

// Pull remote tracks from other speakers
app.post('/api/voice/:netId/pull', async (req, res) => {
    const { userId, tracks } = req.body;
    const netId = req.params.netId;

    try {
        const room = cfVoice.getRoom(netId);
        const participant = room.participants.get(String(userId));
        if (!participant) {
            console.error(`[CF] Pull: user ${userId} not found in room net-${netId}`);
            return res.status(404).json({ error: 'Not in voice room' });
        }

        console.log(`[CF] ${participant.username} pulling tracks:`, tracks.map(t => t.trackName));

        const result = await cfVoice.pullTracks(participant.sessionId, tracks);

        // Track which tracks this participant is pulling
        tracks.forEach(t => {
            if (!participant.pulledTracks.includes(t.trackName)) {
                participant.pulledTracks.push(t.trackName);
            }
        });

        res.json(result);
    } catch (error) {
        console.error('Voice pull error:', error);
        res.status(500).json({ error: 'Failed to pull tracks' });
    }
});

// Renegotiate session (role change, track changes)
app.post('/api/voice/:netId/renegotiate', async (req, res) => {
    const { userId, sessionDescription } = req.body;
    const netId = req.params.netId;

    try {
        const room = cfVoice.getRoom(netId);
        const participant = room.participants.get(String(userId));
        if (!participant) {
            return res.status(404).json({ error: 'Not in voice room' });
        }

        const result = await cfVoice.sendAnswer(participant.sessionId, sessionDescription.sdp);
        res.json(result);
    } catch (error) {
        console.error('Voice renegotiate error:', error);
        res.status(500).json({ error: 'Failed to renegotiate' });
    }
});

// Leave voice room
app.post('/api/voice/:netId/leave', async (req, res) => {
    const { userId } = req.body;
    const netId = req.params.netId;

    try {
        const result = await cfVoice.leaveRoom(netId, userId);

        // Notify other participants to stop pulling this user's track
        if (result.removedTrack) {
            broadcastToNet(netId, 'voice:track:removed', {
                trackName: result.removedTrack,
                userId,
            });
        }

        res.json({ ok: true });
    } catch (error) {
        console.error('Voice leave error:', error);
        res.status(500).json({ error: 'Failed to leave voice room' });
    }
});

// Debug: get voice room state
app.get('/api/voice/:netId/state', (req, res) => {
    const state = cfVoice.getRoomState(req.params.netId);
    res.json(state || { error: 'No active voice room' });
});

// ============ MEMBERSHIP / DUES ============

// Get membership status for current user
app.get('/api/membership/:userId', (req, res) => {
    // Stub - will query Supabase for membership_status, dues_paid_through, trial_ends_at
    res.json({
        status: 'active',
        duesPaidThrough: '2026-03-31',
        autoRenew: true,
        monthlyAmount: 10,
    });
});

// Enable auto-dues (store signed EIP-712 permission)
app.post('/api/membership/enable-dues', (req, res) => {
    const { userId, walletAddress, signedPermission } = req.body;
    // Stub - will store in Supabase spend_permissions table
    // See spend-permissions.js for the full pattern
    res.json({ success: true, message: 'Auto-dues enabled' });
});

// Disable auto-dues (revoke permission)
app.post('/api/membership/disable-dues', (req, res) => {
    const { userId } = req.body;
    // Stub - will set revoked_at on spend_permissions, member stays active through paid period
    res.json({ success: true, message: 'Auto-dues disabled. Active through end of paid period.' });
});

// Make a one-time donation
app.post('/api/donations', (req, res) => {
    const { userId, amount, txHash } = req.body;
    // Stub - will insert into donations table
    res.json({ success: true, pointsAwarded: Math.floor(amount * 1) });
});

// Get network health metrics
app.get('/api/network-health', (req, res) => {
    try {
        const stats = db().prepare('SELECT * FROM network_stats WHERE id = 1').get();
        const totalMembers = stats ? stats.total_members : 0;

        // Stub health metrics - will be real when Supabase is wired
        res.json({
            activeMembers: totalMembers,
            newThisMonth: 3,
            churned: 0,
            reclaimed: 0,
            churnRate: '0%',
            reclaimRate: '0%',
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load network health' });
    }
});

// ============ LOCATIONS / MAP ============

// Get all primary locations for the map
app.get('/api/locations/map', (req, res) => {
    try {
        // For now, return stub data until Supabase is wired up
        // This will be replaced with real DB queries
        const stubLocations = [
            { lat: 38.9072, lng: -77.0369, callsign: 'COL_HAYES_R', city: 'Washington DC', country: 'USA' },
            { lat: 33.7490, lng: -84.3880, callsign: 'MAJ_CHEN_L', city: 'Atlanta', country: 'USA' },
            { lat: 32.7767, lng: -96.7970, callsign: 'CSGT_RODRIGUEZ', city: 'Dallas', country: 'USA' },
            { lat: 36.1627, lng: -86.7816, callsign: 'LCDR_PATEL_K', city: 'Nashville', country: 'USA' },
            { lat: 47.6062, lng: -122.3321, callsign: 'CPT_BROOKS_M', city: 'Seattle', country: 'USA' },
            { lat: 21.3069, lng: -157.8583, callsign: 'MAJ_TANAKA_S', city: 'Honolulu', country: 'USA' },
            { lat: 51.5074, lng: -0.1278, callsign: 'LT_WILLIAMS_D', city: 'London', country: 'UK' },
            { lat: 48.8566, lng: 2.3522, callsign: 'COL_DUBOIS_P', city: 'Paris', country: 'France' },
            { lat: 35.6762, lng: 139.6503, callsign: 'LCDR_NAKAMURA', city: 'Tokyo', country: 'Japan' },
            { lat: 49.2827, lng: -123.1207, callsign: 'CPT_FRASER_A', city: 'Vancouver', country: 'Canada' },
            { lat: 1.3521, lng: 103.8198, callsign: 'MAJ_LIM_W', city: 'Singapore', country: 'Singapore' },
            { lat: -33.8688, lng: 151.2093, callsign: 'LTCOL_KEMP_J', city: 'Sydney', country: 'Australia' },
        ];

        // Calculate stats
        const cities = new Set(stubLocations.map(l => l.city));
        const countries = new Set(stubLocations.map(l => l.country));

        res.json({
            locations: stubLocations,
            stats: {
                members: stubLocations.length,
                cities: cities.size,
                countries: countries.size,
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load map data' });
    }
});

// Get user's locations (max 3)
app.get('/api/locations/:userId', (req, res) => {
    // Stub - will be replaced with Supabase query
    res.json({ locations: [] });
});

// Add/update a location
app.post('/api/locations', (req, res) => {
    // Stub - will be replaced with Supabase insert
    const { userId, city, country, isPrimary, label } = req.body;
    res.json({ success: true, message: 'Location saved' });
});

// Delete a location
app.delete('/api/locations/:locationId', (req, res) => {
    // Stub - will be replaced with Supabase delete
    res.json({ success: true });
});

// Serve index.html for all other routes (SPA support)
app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
});

server.listen(PORT, () => {
    console.log(`The O Club Server running on http://localhost:${PORT}`);
    console.log(`WebSocket server ready for real-time updates`);
});
