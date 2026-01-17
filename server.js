const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { initDatabase, getDatabase } = require('./db/init');
const { AccessToken } = require('livekit-server-sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// LiveKit configuration (set these in your environment)
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const LIVEKIT_URL = process.env.LIVEKIT_URL || '';

// Initialize database
initDatabase();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

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

// ============ LIVEKIT TOKEN ROUTES ============

// Get LiveKit connection info (for frontend)
app.get('/api/livekit/config', (req, res) => {
    res.json({
        enabled: !!(LIVEKIT_API_KEY && LIVEKIT_API_SECRET && LIVEKIT_URL),
        url: LIVEKIT_URL
    });
});

// Generate LiveKit token for joining a net
app.post('/api/nets/:id/token', async (req, res) => {
    const { userId } = req.body;
    const netId = req.params.id;

    // Check if LiveKit is configured
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
        return res.status(503).json({
            error: 'Audio not configured',
            message: 'LiveKit credentials not set. Audio will be simulated.'
        });
    }

    // Get user info
    const user = db().prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    // Get participant info to determine permissions
    const participant = db().prepare(`
        SELECT * FROM net_participants WHERE net_id = ? AND user_id = ? AND left_at IS NULL
    `).get(netId, userId);

    if (!participant) {
        return res.status(403).json({ error: 'Must join net first' });
    }

    // Determine permissions based on role
    const canPublish = ['host', 'co-host', 'speaker'].includes(participant.role);
    const canSubscribe = true; // Everyone can listen

    try {
        // Create access token
        const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
            identity: user.username,
            name: user.username,
            metadata: JSON.stringify({
                rank: user.rank_code,
                unit: user.unit,
                role: participant.role
            })
        });

        // Add video grant for the specific room (net)
        at.addGrant({
            room: `net-${netId}`,
            roomJoin: true,
            canPublish: canPublish,
            canSubscribe: canSubscribe,
            canPublishData: true // For any data channel needs
        });

        const token = await at.toJwt();

        res.json({
            token,
            url: LIVEKIT_URL,
            room: `net-${netId}`,
            canPublish,
            identity: user.username
        });
    } catch (error) {
        console.error('LiveKit token error:', error);
        res.status(500).json({ error: 'Failed to generate token' });
    }
});

// Update token when role changes (e.g., approved to speak)
app.post('/api/nets/:id/refresh-token', async (req, res) => {
    const { userId } = req.body;
    const netId = req.params.id;

    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
        return res.status(503).json({ error: 'Audio not configured' });
    }

    const user = db().prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const participant = db().prepare(`
        SELECT * FROM net_participants WHERE net_id = ? AND user_id = ? AND left_at IS NULL
    `).get(netId, userId);

    if (!user || !participant) {
        return res.status(404).json({ error: 'Not found' });
    }

    const canPublish = ['host', 'co-host', 'speaker'].includes(participant.role);

    try {
        const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
            identity: user.username,
            name: user.username
        });

        at.addGrant({
            room: `net-${netId}`,
            roomJoin: true,
            canPublish: canPublish,
            canSubscribe: true,
            canPublishData: true
        });

        const token = await at.toJwt();
        res.json({ token, canPublish, url: LIVEKIT_URL });
    } catch (error) {
        res.status(500).json({ error: 'Failed to refresh token' });
    }
});

// Serve index.html for all other routes (SPA support)
app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(PORT, () => {
    console.log(`The O Club Server running on http://localhost:${PORT}`);
    console.log(`WebSocket server ready for real-time updates`);
});
