/**
 * The O Club — Client Voice Module
 *
 * High-quality WebRTC audio via Cloudflare Calls SFU.
 * Clubhouse-like experience: speaker detection, speaking indicators,
 * join/leave audio cues, robust reconnection.
 *
 * Architecture:
 * - One RTCPeerConnection per participant (mapped to CF session)
 * - Opus 48kHz for maximum voice clarity
 * - Web Audio API AnalyserNode for real-time speaker detection
 * - Audio cues for join/leave/hand-raise/mute events
 */

// ============ STATE ============

let peerConnection = null;
let localStream = null;
let sessionId = null;
let currentNetId = null;
let currentUserId = null;
let isMuted = true;
let isSpeaker = false;
let analyserNode = null;
let speakingDetectionInterval = null;
let onSpeakingCallback = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Track remote audio elements for cleanup
const remoteAudioElements = new Map(); // mid -> HTMLAudioElement

// Audio context for speaker detection and audio cues
let audioCtx = null;

// ============ AUDIO CUES ============

function getAudioContext() {
    if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    return audioCtx;
}

function playJoinSound() {
    try {
        const ctx = getAudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.15);
    } catch (e) { /* non-critical */ }
}

function playLeaveSound() {
    try {
        const ctx = getAudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(660, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.15);
    } catch (e) { /* non-critical */ }
}

function playPromotedSound() {
    try {
        const ctx = getAudioContext();
        const now = ctx.currentTime;
        [880, 1174.66].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            const start = now + i * 0.12;
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(0.15, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.25);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(start);
            osc.stop(start + 0.25);
        });
    } catch (e) { /* non-critical */ }
}

function playMuteSound() {
    try {
        const ctx = getAudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(200, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.06);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.08);
    } catch (e) { /* non-critical */ }
}

function playUnmuteSound() {
    try {
        const ctx = getAudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(300, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(500, ctx.currentTime + 0.06);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.1);
    } catch (e) { /* non-critical */ }
}

// ============ CORE WebRTC ============

function createPeerConnection() {
    const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
    });

    // Handle incoming remote tracks (other speakers' audio)
    pc.ontrack = (event) => {
        console.log('[VOICE] ontrack fired:', event.track.kind, 'mid:', event.transceiver?.mid, 'readyState:', event.track.readyState);

        if (event.track.kind === 'audio') {
            const audio = new Audio();
            audio.srcObject = new MediaStream([event.track]);
            audio.autoplay = true;
            audio.playsInline = true;
            audio.volume = 1.0;

            const mid = event.transceiver?.mid || `track-${Date.now()}`;
            remoteAudioElements.set(mid, audio);

            audio.play().then(() => {
                console.log('[VOICE] Remote audio playing for mid:', mid);
            }).catch(err => {
                console.warn('[VOICE] Audio autoplay blocked:', err.message);
                const resumeAudio = () => {
                    audio.play().catch(() => {});
                    document.removeEventListener('click', resumeAudio);
                };
                document.addEventListener('click', resumeAudio, { once: true });
            });

            // Speaker detection on remote track
            setupRemoteTrackAnalysis(event.track, mid);
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log('[VOICE] ICE state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            handleConnectionFailure();
        }
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            reconnectAttempts = 0;
            console.log('[VOICE] WebRTC connected to Cloudflare SFU');
        }
    };

    pc.onconnectionstatechange = () => {
        console.log('[VOICE] Connection state:', pc.connectionState);
    };

    return pc;
}

/**
 * Find the Opus payload type from SDP and enhance its fmtp parameters.
 */
function enhanceOpusSdp(sdp) {
    if (!sdp) return sdp;

    // Find Opus payload type from rtpmap line (e.g., "a=rtpmap:111 opus/48000/2")
    const rtpmapMatch = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/);
    if (!rtpmapMatch) return sdp;

    const opusPT = rtpmapMatch[1];
    const fmtpPrefix = `a=fmtp:${opusPT}`;

    const lines = sdp.split('\r\n');
    const enhanced = lines.map(line => {
        if (line.startsWith(fmtpPrefix)) {
            if (!line.includes('maxaveragebitrate')) line += ';maxaveragebitrate=64000';
            if (!line.includes('usedtx')) line += ';usedtx=1';
            if (!line.includes('cbr')) line += ';cbr=0';
        }
        return line;
    });
    return enhanced.join('\r\n');
}

// ============ JOIN / LEAVE ============

/**
 * Join a voice room.
 * @param {number} netId
 * @param {Object} user - { id, username }
 * @param {string} role - host | co-host | speaker | listener
 * @param {Function} onSpeaking - Callback(username, isSpeaking)
 * @returns {Promise<boolean>} Success
 */
export async function joinVoiceRoom(netId, user, role, onSpeaking) {
    if (peerConnection) {
        console.log('[VOICE] Already connected, cleaning up first');
        await leaveVoiceRoom();
    }

    onSpeakingCallback = onSpeaking;
    currentNetId = netId;
    currentUserId = user.id;
    isSpeaker = ['host', 'co-host', 'speaker'].includes(role);

    try {
        // 1. Create CF session via our server
        console.log(`[VOICE] Joining net-${netId} as ${role}...`);
        const joinData = await apiCall(`/api/voice/${netId}/join`, {
            method: 'POST',
            body: JSON.stringify({ userId: user.id, username: user.username, role }),
        });

        if (joinData.error) {
            console.error('[VOICE] Join failed:', joinData.error, joinData.message);
            return false;
        }

        sessionId = joinData.sessionId;
        console.log('[VOICE] Got CF session:', sessionId);

        // 2. Create PeerConnection
        peerConnection = createPeerConnection();

        // 3. Speakers: acquire mic, push track to CF, complete SDP exchange
        if (isSpeaker) {
            await acquireMicrophone();

            // Create SDP offer
            const offer = await peerConnection.createOffer();
            offer.sdp = enhanceOpusSdp(offer.sdp);
            await peerConnection.setLocalDescription(offer);

            // Get the transceiver mid for the audio track
            const audioTransceiver = peerConnection.getTransceivers().find(
                t => t.sender?.track?.kind === 'audio'
            );
            const mid = audioTransceiver?.mid;

            console.log('[VOICE] Pushing local track to CF, mid:', mid);

            // Push local track to CF (this does the SDP exchange)
            const pushResult = await apiCall(`/api/voice/${netId}/publish-track`, {
                method: 'POST',
                body: JSON.stringify({
                    userId: user.id,
                    trackName: `audio-${user.id}`,
                    sessionDescription: {
                        type: 'offer',
                        sdp: peerConnection.localDescription.sdp,
                    },
                    mid,
                }),
            });

            console.log('[VOICE] Push result keys:', Object.keys(pushResult));

            // Set CF's answer as remote description
            if (pushResult.sessionDescription) {
                const answer = new RTCSessionDescription({
                    type: pushResult.sessionDescription.type || 'answer',
                    sdp: pushResult.sessionDescription.sdp,
                });
                await peerConnection.setRemoteDescription(answer);
                console.log('[VOICE] Remote description set, PC state:', peerConnection.signalingState);
            } else {
                console.error('[VOICE] No sessionDescription in push response:', JSON.stringify(pushResult).slice(0, 200));
                return false;
            }

            // Start speaking detection
            if (localStream) {
                startSpeakingDetection(localStream, user.username);
            }

            isMuted = false;
        }
        // Listeners: no push needed, PC stays idle until we pull tracks

        // 4. Pull existing speaker tracks
        if (joinData.speakerTracks?.length > 0) {
            console.log('[VOICE] Pulling', joinData.speakerTracks.length, 'existing speaker tracks');
            for (const track of joinData.speakerTracks) {
                await pullRemoteTrack(track);
            }
        } else {
            console.log('[VOICE] No existing speakers to pull');
        }

        playJoinSound();
        console.log(`[VOICE] Successfully joined net-${netId} as ${role}`);
        return true;
    } catch (err) {
        console.error('[VOICE] Join error:', err);
        cleanup();
        return false;
    }
}

export async function leaveVoiceRoom() {
    if (!currentNetId) return;
    const netId = currentNetId;

    try {
        await apiCall(`/api/voice/${netId}/leave`, {
            method: 'POST',
            body: JSON.stringify({ userId: currentUserId || window.currentUser?.id }),
        });
    } catch (err) {
        console.warn('[VOICE] Leave call failed:', err);
    }

    playLeaveSound();
    cleanup();
    console.log(`[VOICE] Left net-${netId}`);
}

// ============ MICROPHONE ============

async function acquireMicrophone() {
    localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
            channelCount: 1,
        },
    });

    const track = localStream.getAudioTracks()[0];
    peerConnection.addTrack(track, localStream);
    console.log('[VOICE] Microphone acquired:', track.label);
}

export function toggleMuteState() {
    if (!localStream) return false;
    const track = localStream.getAudioTracks()[0];
    if (!track) return false;

    isMuted = !isMuted;
    track.enabled = !isMuted;

    if (isMuted) playMuteSound();
    else playUnmuteSound();

    console.log(`[VOICE] ${isMuted ? 'Muted' : 'Unmuted'}`);
    return isMuted;
}

export function getMuteState() {
    return isMuted;
}

// ============ TRACK PULLING ============

/**
 * Pull a single remote track from another speaker via CF SFU.
 * Handles the full renegotiation cycle.
 */
async function pullRemoteTrack(speakerTrack) {
    if (!peerConnection || !sessionId) {
        console.warn('[VOICE] Cannot pull — no PC or session');
        return;
    }

    const userId = currentUserId || window.currentUser?.id;

    try {
        console.log('[VOICE] Pulling track:', speakerTrack.trackName, 'from session:', speakerTrack.sessionId);

        const result = await apiCall(`/api/voice/${currentNetId}/pull`, {
            method: 'POST',
            body: JSON.stringify({
                userId,
                tracks: [{
                    trackName: speakerTrack.trackName,
                    sessionId: speakerTrack.sessionId,
                }],
            }),
        });

        console.log('[VOICE] Pull result keys:', Object.keys(result),
            'requiresRenegotiation:', result.requiresImmediateRenegotiation,
            'hasSessionDescription:', !!result.sessionDescription);

        // Renegotiate if CF returns a new SDP (always expected after pull)
        if (result.sessionDescription) {
            const sdpType = result.sessionDescription.type || 'offer';
            console.log('[VOICE] Setting remote description type:', sdpType);

            await peerConnection.setRemoteDescription(
                new RTCSessionDescription({
                    type: sdpType,
                    sdp: result.sessionDescription.sdp,
                })
            );

            // Create and send answer back to CF
            const answer = await peerConnection.createAnswer();
            answer.sdp = enhanceOpusSdp(answer.sdp);
            await peerConnection.setLocalDescription(answer);

            console.log('[VOICE] Sending renegotiation answer...');

            await apiCall(`/api/voice/${currentNetId}/renegotiate`, {
                method: 'POST',
                body: JSON.stringify({
                    userId,
                    sessionDescription: {
                        type: 'answer',
                        sdp: peerConnection.localDescription.sdp,
                    },
                }),
            });

            console.log('[VOICE] Renegotiation complete, PC state:', peerConnection.signalingState);
        } else {
            console.warn('[VOICE] Pull response had no sessionDescription — audio may not flow');
        }
    } catch (err) {
        console.error('[VOICE] Pull/renegotiate error:', err);
    }
}

/**
 * Called when a new speaker's track is available (via WebSocket).
 */
export async function onNewSpeaker(netId, userId, speakerTrack) {
    console.log('[VOICE] New speaker track available:', speakerTrack.trackName);
    await pullRemoteTrack(speakerTrack);
    playJoinSound();
}

export function onSpeakerLeft(username) {
    playLeaveSound();
}

// ============ SPEAKER DETECTION ============

function startSpeakingDetection(stream, username) {
    try {
        const ctx = getAudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.4;
        analyser.minDecibels = -80;
        analyser.maxDecibels = -10;
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        let wasSpeaking = false;
        let silenceFrames = 0;

        speakingDetectionInterval = setInterval(() => {
            analyser.getByteFrequencyData(dataArray);
            const voiceBins = dataArray.slice(1, 33);
            const avgVolume = voiceBins.reduce((sum, v) => sum + v, 0) / voiceBins.length;
            const isSpeakingNow = avgVolume > 15 && !isMuted;

            if (isSpeakingNow) {
                silenceFrames = 0;
                if (!wasSpeaking) {
                    wasSpeaking = true;
                    if (onSpeakingCallback) onSpeakingCallback(username, true);
                }
            } else {
                silenceFrames++;
                if (wasSpeaking && silenceFrames > 8) {
                    wasSpeaking = false;
                    if (onSpeakingCallback) onSpeakingCallback(username, false);
                }
            }
        }, 50);

        analyserNode = analyser;
    } catch (err) {
        console.warn('[VOICE] Speaker detection setup failed:', err);
    }
}

function setupRemoteTrackAnalysis(track, mid) {
    try {
        const ctx = getAudioContext();
        const stream = new MediaStream([track]);
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.4;
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        let wasSpeaking = false;
        let silenceFrames = 0;

        const interval = setInterval(() => {
            if (track.readyState === 'ended') {
                clearInterval(interval);
                return;
            }
            analyser.getByteFrequencyData(dataArray);
            const voiceBins = dataArray.slice(1, 33);
            const avgVolume = voiceBins.reduce((sum, v) => sum + v, 0) / voiceBins.length;
            const isSpeakingNow = avgVolume > 12;

            if (isSpeakingNow) {
                silenceFrames = 0;
                if (!wasSpeaking) {
                    wasSpeaking = true;
                    if (onSpeakingCallback) onSpeakingCallback(`_remote_${mid}`, true);
                }
            } else {
                silenceFrames++;
                if (wasSpeaking && silenceFrames > 8) {
                    wasSpeaking = false;
                    if (onSpeakingCallback) onSpeakingCallback(`_remote_${mid}`, false);
                }
            }
        }, 50);

        track.addEventListener('ended', () => clearInterval(interval));
    } catch (err) {
        console.warn('[VOICE] Remote track analysis failed:', err);
    }
}

// ============ ROLE CHANGES ============

export async function onPromotedToSpeaker(netId, user) {
    if (!peerConnection || !sessionId) return false;
    isSpeaker = true;
    playPromotedSound();

    try {
        await acquireMicrophone();
        const offer = await peerConnection.createOffer();
        offer.sdp = enhanceOpusSdp(offer.sdp);
        await peerConnection.setLocalDescription(offer);

        const audioTransceiver = peerConnection.getTransceivers().find(
            t => t.sender?.track?.kind === 'audio'
        );

        const result = await apiCall(`/api/voice/${netId}/publish-track`, {
            method: 'POST',
            body: JSON.stringify({
                userId: user.id,
                trackName: `audio-${user.id}`,
                sessionDescription: {
                    type: 'offer',
                    sdp: peerConnection.localDescription.sdp,
                },
                mid: audioTransceiver?.mid,
            }),
        });

        if (result.sessionDescription) {
            await peerConnection.setRemoteDescription(
                new RTCSessionDescription({
                    type: result.sessionDescription.type || 'answer',
                    sdp: result.sessionDescription.sdp,
                })
            );
        }

        if (localStream) startSpeakingDetection(localStream, user.username);
        isMuted = false;
        console.log('[VOICE] Promoted to speaker — mic live');
        return true;
    } catch (err) {
        console.error('[VOICE] Promotion error:', err);
        return false;
    }
}

export function onDemotedToListener() {
    isSpeaker = false;
    isMuted = true;
    if (localStream) {
        localStream.getAudioTracks().forEach(t => t.stop());
        localStream = null;
    }
    if (speakingDetectionInterval) {
        clearInterval(speakingDetectionInterval);
        speakingDetectionInterval = null;
    }
    playMuteSound();
    console.log('[VOICE] Demoted to listener');
}

// ============ CONNECTION RECOVERY ============

function handleConnectionFailure() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('[VOICE] Max reconnection attempts reached');
        cleanup();
        return;
    }
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 15000);
    console.log(`[VOICE] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    setTimeout(() => {
        if (peerConnection?.iceConnectionState === 'failed' || peerConnection?.iceConnectionState === 'disconnected') {
            peerConnection.restartIce();
        }
    }, delay);
}

// ============ CLEANUP ============

function cleanup() {
    if (speakingDetectionInterval) {
        clearInterval(speakingDetectionInterval);
        speakingDetectionInterval = null;
    }
    if (localStream) {
        localStream.getAudioTracks().forEach(t => t.stop());
        localStream = null;
    }
    for (const [, audio] of remoteAudioElements) {
        audio.srcObject = null;
    }
    remoteAudioElements.clear();
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    sessionId = null;
    currentNetId = null;
    currentUserId = null;
    isSpeaker = false;
    isMuted = true;
    reconnectAttempts = 0;
    onSpeakingCallback = null;
}

// ============ HELPERS ============

async function apiCall(url, options = {}) {
    const res = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options.headers,
        },
    });

    const data = await res.json();

    if (!res.ok) {
        console.error(`[VOICE] API ${res.status}:`, url, data);
        throw new Error(data.error || `API error ${res.status}`);
    }

    return data;
}

// ============ STATUS ============

export function isConnected() {
    return peerConnection?.connectionState === 'connected';
}

export async function checkVoiceConfig() {
    try {
        const config = await apiCall('/api/voice/config');
        return config.enabled;
    } catch {
        return false;
    }
}

export { playJoinSound, playLeaveSound, playPromotedSound, playMuteSound, playUnmuteSound };
