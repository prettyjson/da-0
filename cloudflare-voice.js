/**
 * Cloudflare Calls (Realtime SFU) - Server Module
 *
 * Manages voice rooms via Cloudflare's REST API.
 * No room abstraction from CF — we build our own using in-memory state.
 *
 * Architecture:
 * - Each participant gets a CF "session" (maps 1:1 to RTCPeerConnection)
 * - Speakers push audio tracks (location: "local")
 * - Listeners pull audio tracks from all speakers (location: "remote")
 * - Server manages room state and coordinates track routing
 */

const CF_API_BASE = 'https://rtc.live.cloudflare.com/v1';
const CF_APP_ID = process.env.CF_APP_ID || '';
const CF_APP_SECRET = process.env.CF_APP_SECRET || '';

// In-memory room state
// roomId -> { participants: Map<userId, ParticipantState>, createdAt }
const rooms = new Map();

/**
 * @typedef {Object} ParticipantState
 * @property {string} sessionId - Cloudflare session ID
 * @property {string} userId
 * @property {string} username
 * @property {string} role - host | co-host | speaker | listener
 * @property {boolean} isMuted
 * @property {string|null} trackName - Published track name (speakers only)
 * @property {string[]} pulledTracks - Track names this participant is pulling
 */

// ============ CLOUDFLARE API HELPERS ============

function cfHeaders() {
    return {
        'Authorization': `Bearer ${CF_APP_SECRET}`,
        'Content-Type': 'application/json',
    };
}

async function cfFetch(path, options = {}) {
    const url = `${CF_API_BASE}/apps/${CF_APP_ID}${path}`;
    const res = await fetch(url, {
        ...options,
        headers: { ...cfHeaders(), ...options.headers },
    });

    if (!res.ok) {
        const body = await res.text();
        console.error(`[CF] ${options.method || 'GET'} ${path} failed (${res.status}):`, body);
        throw new Error(`Cloudflare API error: ${res.status} - ${body}`);
    }

    return res.json();
}

// ============ SESSION MANAGEMENT ============

/**
 * Create a new Cloudflare session for a participant.
 * Returns { sessionId, sessionDescription (SDP offer) }
 */
async function createSession() {
    const data = await cfFetch('/sessions/new', { method: 'POST', body: '{}' });
    return {
        sessionId: data.sessionId,
        sessionDescription: data.sessionDescription, // SDP offer from CF
    };
}

/**
 * Send SDP answer to Cloudflare to complete the WebRTC handshake.
 */
async function sendAnswer(sessionId, sdpAnswer) {
    const data = await cfFetch(`/sessions/${sessionId}/renegotiate`, {
        method: 'PUT',
        body: JSON.stringify({
            sessionDescription: {
                type: 'answer',
                sdp: sdpAnswer,
            },
        }),
    });
    return data;
}

/**
 * Renegotiate a session (when tracks change).
 * CF sends a new SDP offer that the client must answer.
 */
async function renegotiate(sessionId) {
    const data = await cfFetch(`/sessions/${sessionId}/renegotiate`, {
        method: 'GET',
    });
    return data;
}

// ============ TRACK MANAGEMENT ============

/**
 * Push a local audio track to Cloudflare (speaker publishes their mic).
 * Client sends their SDP with the audio track, CF returns updated SDP.
 */
async function pushTrack(sessionId, trackData) {
    const data = await cfFetch(`/sessions/${sessionId}/tracks/new`, {
        method: 'POST',
        body: JSON.stringify({
            sessionDescription: trackData.sessionDescription,
            tracks: [{
                location: 'local',
                trackName: trackData.trackName,
            }],
        }),
    });
    return data;
}

/**
 * Pull remote audio tracks from other speakers in the room.
 * Returns updated SDP with the remote tracks.
 */
async function pullTracks(sessionId, tracks) {
    const data = await cfFetch(`/sessions/${sessionId}/tracks/new`, {
        method: 'POST',
        body: JSON.stringify({
            tracks: tracks.map(t => ({
                location: 'remote',
                trackName: t.trackName,
                sessionId: t.sessionId, // Session that published this track
            })),
        }),
    });
    return data;
}

/**
 * Close specific tracks on a session.
 */
async function closeTracks(sessionId, trackMids, force = false) {
    const data = await cfFetch(`/sessions/${sessionId}/tracks/close`, {
        method: 'PUT',
        body: JSON.stringify({
            tracks: trackMids.map(mid => ({ mid })),
            force,
        }),
    });
    return data;
}

/**
 * Close an entire session (participant leaves).
 */
async function closeSession(sessionId) {
    try {
        await cfFetch(`/sessions/${sessionId}/tracks/close`, {
            method: 'PUT',
            body: JSON.stringify({ force: true, tracks: [] }),
        });
    } catch (err) {
        // Session may already be closed
        console.log(`[CF] Session ${sessionId} close error (may be already closed):`, err.message);
    }
}

// ============ ROOM MANAGEMENT (Application Layer) ============

/**
 * Get or create a room for a net.
 */
function getRoom(netId) {
    const roomId = `net-${netId}`;
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            participants: new Map(),
            createdAt: Date.now(),
        });
    }
    return rooms.get(roomId);
}

/**
 * Add a participant to a room. Creates their CF session.
 * Returns the session info needed for WebRTC handshake.
 */
async function joinRoom(netId, userId, username, role) {
    const room = getRoom(netId);

    // If already in room, return existing session
    const existing = room.participants.get(String(userId));
    if (existing) {
        return { sessionId: existing.sessionId, alreadyJoined: true };
    }

    // Create CF session
    const session = await createSession();

    const participant = {
        sessionId: session.sessionId,
        userId: String(userId),
        username,
        role,
        isMuted: role === 'listener',
        trackName: null,
        pulledTracks: [],
    };

    room.participants.set(String(userId), participant);

    console.log(`[CF] ${username} joined room net-${netId} as ${role} (session: ${session.sessionId})`);

    return {
        sessionId: session.sessionId,
        sessionDescription: session.sessionDescription,
        alreadyJoined: false,
        // Tell the client which tracks to pull (all current speakers)
        speakerTracks: getSpeakerTracks(netId, userId),
    };
}

/**
 * Get all speaker tracks in a room (excluding a specific user).
 */
function getSpeakerTracks(netId, excludeUserId) {
    const room = rooms.get(`net-${netId}`);
    if (!room) return [];

    const tracks = [];
    for (const [uid, p] of room.participants) {
        if (uid !== String(excludeUserId) && p.trackName && !p.isMuted) {
            tracks.push({
                trackName: p.trackName,
                sessionId: p.sessionId,
                username: p.username,
            });
        }
    }
    return tracks;
}

/**
 * Handle a speaker publishing their audio track.
 * After they push, notify all other participants to pull this new track.
 */
async function onTrackPublished(netId, userId, trackName) {
    const room = rooms.get(`net-${netId}`);
    if (!room) return;

    const participant = room.participants.get(String(userId));
    if (!participant) return;

    participant.trackName = trackName;

    console.log(`[CF] ${participant.username} published track: ${trackName}`);

    // Return info about this track so other participants can pull it
    return {
        trackName,
        sessionId: participant.sessionId,
        username: participant.username,
    };
}

/**
 * Remove a participant from a room. Cleans up their CF session.
 * Returns the list of remaining participants who need to stop pulling this user's track.
 */
async function leaveRoom(netId, userId) {
    const room = rooms.get(`net-${netId}`);
    if (!room) return { affectedUsers: [] };

    const participant = room.participants.get(String(userId));
    if (!participant) return { affectedUsers: [] };

    // Close the CF session
    await closeSession(participant.sessionId);

    // Remove from room
    room.participants.delete(String(userId));

    console.log(`[CF] ${participant.username} left room net-${netId}`);

    // If this was a speaker, other participants need to stop pulling their track
    const affectedUsers = [];
    if (participant.trackName) {
        for (const [uid, p] of room.participants) {
            if (p.pulledTracks.includes(participant.trackName)) {
                affectedUsers.push(uid);
                p.pulledTracks = p.pulledTracks.filter(t => t !== participant.trackName);
            }
        }
    }

    // Clean up empty rooms
    if (room.participants.size === 0) {
        rooms.delete(`net-${netId}`);
        console.log(`[CF] Room net-${netId} closed (empty)`);
    }

    return { affectedUsers, removedTrack: participant.trackName };
}

/**
 * End a room entirely. Close all sessions.
 */
async function endRoom(netId) {
    const room = rooms.get(`net-${netId}`);
    if (!room) return;

    console.log(`[CF] Ending room net-${netId} (${room.participants.size} participants)`);

    // Close all sessions in parallel
    const closePromises = [];
    for (const [, p] of room.participants) {
        closePromises.push(closeSession(p.sessionId));
    }
    await Promise.allSettled(closePromises);

    rooms.delete(`net-${netId}`);
}

/**
 * Update participant role in a room.
 * Returns whether the role change affects audio (e.g., listener -> speaker).
 */
function updateRole(netId, userId, newRole) {
    const room = rooms.get(`net-${netId}`);
    if (!room) return { changed: false };

    const participant = room.participants.get(String(userId));
    if (!participant) return { changed: false };

    const wasSpeaker = ['host', 'co-host', 'speaker'].includes(participant.role);
    const isSpeaker = ['host', 'co-host', 'speaker'].includes(newRole);

    participant.role = newRole;

    // If demoted from speaker, mark track as removed
    if (wasSpeaker && !isSpeaker && participant.trackName) {
        const removedTrack = participant.trackName;
        participant.trackName = null;
        participant.isMuted = true;
        return { changed: true, becameSpeaker: false, becameListener: true, removedTrack };
    }

    // If promoted to speaker
    if (!wasSpeaker && isSpeaker) {
        participant.isMuted = false;
        return { changed: true, becameSpeaker: true, becameListener: false };
    }

    return { changed: false };
}

/**
 * Update mute state for a participant.
 */
function setMuted(netId, userId, isMuted) {
    const room = rooms.get(`net-${netId}`);
    if (!room) return;

    const participant = room.participants.get(String(userId));
    if (participant) {
        participant.isMuted = isMuted;
    }
}

/**
 * Get room state (for diagnostics / debugging).
 */
function getRoomState(netId) {
    const room = rooms.get(`net-${netId}`);
    if (!room) return null;

    const participants = [];
    for (const [uid, p] of room.participants) {
        participants.push({
            userId: uid,
            username: p.username,
            role: p.role,
            isMuted: p.isMuted,
            hasTrack: !!p.trackName,
            trackName: p.trackName,
            pulledTracks: p.pulledTracks.length,
        });
    }

    return { netId, participants, createdAt: room.createdAt };
}

/**
 * Check if Cloudflare Calls is configured.
 */
function isEnabled() {
    return !!(CF_APP_ID && CF_APP_SECRET);
}

module.exports = {
    isEnabled,
    createSession,
    sendAnswer,
    renegotiate,
    pushTrack,
    pullTracks,
    closeTracks,
    closeSession,
    getRoom,
    joinRoom,
    leaveRoom,
    endRoom,
    onTrackPublished,
    getSpeakerTracks,
    updateRole,
    setMuted,
    getRoomState,
};
