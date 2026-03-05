/**
 * The O Club — Client Voice Module
 *
 * High-quality WebRTC audio via Cloudflare Calls SFU.
 * Clubhouse-like experience: speaker detection, speaking indicators,
 * join/leave audio cues, robust reconnection.
 *
 * Architecture:
 * - One RTCPeerConnection per participant (mapped to CF session)
 * - Opus 48kHz stereo for maximum voice clarity
 * - Web Audio API AnalyserNode for real-time speaker detection
 * - Audio cues for join/leave/hand-raise/mute events
 */

// ============ STATE ============

let peerConnection = null;
let localStream = null;
let sessionId = null;
let currentNetId = null;
let isMuted = true;
let isSpeaker = false;
let audioContext = null;
let analyserNode = null;
let speakingDetectionInterval = null;
let onSpeakingCallback = null;
let onTrackAddedCallback = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Track remote audio elements
const remoteAudioElements = new Map(); // trackName -> HTMLAudioElement
// Track MID mapping for Cloudflare
const trackMidMap = new Map(); // trackName -> mid

// Audio context for speaker detection and audio cues
let audioCtx = null;

// ============ AUDIO CUES ============
// Generate subtle audio cues using Web Audio API (no external files needed)

function getAudioContext() {
    if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    return audioCtx;
}

/**
 * Play a subtle "pop" sound when someone joins.
 * Warm, rounded tone — like Clubhouse's join sound.
 */
function playJoinSound() {
    try {
        const ctx = getAudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
        osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08); // E6

        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.15);
    } catch (e) { /* audio cue is non-critical */ }
}

/**
 * Play a softer "pop down" when someone leaves.
 */
function playLeaveSound() {
    try {
        const ctx = getAudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(660, ctx.currentTime); // E5
        osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.12); // A4

        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.15);
    } catch (e) { /* audio cue is non-critical */ }
}

/**
 * Play a "ding" when hand raise is approved (you got promoted to speaker).
 */
function playPromotedSound() {
    try {
        const ctx = getAudioContext();
        const now = ctx.currentTime;

        // Two-note ascending chime
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
    } catch (e) { /* audio cue is non-critical */ }
}

/**
 * Play a subtle "thunk" when muted.
 */
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
    } catch (e) { /* audio cue is non-critical */ }
}

/**
 * Play a subtle "pop up" when unmuted.
 */
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
    } catch (e) { /* audio cue is non-critical */ }
}

// ============ CORE WebRTC ============

/**
 * Create a high-quality RTCPeerConnection with Opus 48kHz config.
 */
function createPeerConnection() {
    const pc = new RTCPeerConnection({
        iceServers: [], // Cloudflare SFU handles TURN/relay
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
    });

    // Handle incoming remote tracks (other speakers' audio)
    pc.ontrack = (event) => {
        console.log('[VOICE] Remote track received:', event.track.kind, 'mid:', event.transceiver.mid);

        if (event.track.kind === 'audio') {
            const audio = new Audio();
            audio.srcObject = new MediaStream([event.track]);
            audio.autoplay = true;
            audio.playsInline = true;
            audio.volume = 1.0;

            // Store with the transceiver mid for cleanup
            const mid = event.transceiver.mid;
            remoteAudioElements.set(mid, audio);

            audio.play().catch(err => {
                console.warn('[VOICE] Audio autoplay blocked, retrying...', err);
                // Retry on user interaction
                const resumeAudio = () => {
                    audio.play().catch(() => {});
                    document.removeEventListener('click', resumeAudio);
                    document.removeEventListener('touchstart', resumeAudio);
                };
                document.addEventListener('click', resumeAudio, { once: true });
                document.addEventListener('touchstart', resumeAudio, { once: true });
            });

            // Set up speaker detection on this remote track
            setupRemoteTrackAnalysis(event.track, mid);

            if (onTrackAddedCallback) {
                onTrackAddedCallback(mid);
            }
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log('[VOICE] ICE state:', pc.iceConnectionState);

        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            handleConnectionFailure();
        }
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            reconnectAttempts = 0;
        }
    };

    pc.onconnectionstatechange = () => {
        console.log('[VOICE] Connection state:', pc.connectionState);
    };

    return pc;
}

/**
 * Modify SDP to force high-quality Opus settings.
 * - 48000 Hz sample rate
 * - Stereo
 * - High bitrate (64kbps for voice clarity)
 * - DTX (discontinuous transmission) for bandwidth savings during silence
 */
function enhanceOpusSdp(sdp) {
    // Find the Opus payload type
    const lines = sdp.split('\r\n');
    const enhanced = lines.map(line => {
        // Enhance Opus fmtp line
        if (line.startsWith('a=fmtp:') && line.includes('opus')) {
            // Add high-quality parameters
            if (!line.includes('maxaveragebitrate')) {
                line += ';maxaveragebitrate=64000';
            }
            if (!line.includes('stereo')) {
                line += ';stereo=1';
            }
            if (!line.includes('sprop-stereo')) {
                line += ';sprop-stereo=1';
            }
            if (!line.includes('usedtx')) {
                line += ';usedtx=1';
            }
            if (!line.includes('cbr')) {
                line += ';cbr=0'; // Variable bitrate for better quality
            }
        }
        return line;
    });
    return enhanced.join('\r\n');
}

// ============ JOIN / LEAVE ============

/**
 * Join a voice room.
 * @param {number} netId - The net to join
 * @param {Object} user - { id, username }
 * @param {string} role - host | co-host | speaker | listener
 * @param {Function} onSpeaking - Callback(username, isSpeaking) for speaking indicators
 * @param {Function} onTrackAdded - Callback(mid) when a remote track is received
 * @returns {Promise<boolean>} Success
 */
export async function joinVoiceRoom(netId, user, role, onSpeaking, onTrackAdded) {
    if (peerConnection) {
        console.log('[VOICE] Already connected, cleaning up first');
        await leaveVoiceRoom();
    }

    onSpeakingCallback = onSpeaking;
    onTrackAddedCallback = onTrackAdded;
    currentNetId = netId;
    isSpeaker = ['host', 'co-host', 'speaker'].includes(role);

    try {
        // 1. Request a CF session from our server
        const joinData = await apiCall(`/api/voice/${netId}/join`, {
            method: 'POST',
            body: JSON.stringify({ userId: user.id, username: user.username, role }),
        });

        if (joinData.error) {
            console.log('[VOICE] Voice not available:', joinData.message);
            return false;
        }

        sessionId = joinData.sessionId;

        // 2. Create PeerConnection
        peerConnection = createPeerConnection();

        // 3. If we're a speaker, get mic and add track
        if (isSpeaker) {
            await acquireMicrophone();
        }

        // Add a transceiver for receiving audio even if we're just a listener
        if (!isSpeaker) {
            peerConnection.addTransceiver('audio', { direction: 'recvonly' });
        }

        // 4. Create offer
        const offer = await peerConnection.createOffer();
        offer.sdp = enhanceOpusSdp(offer.sdp);
        await peerConnection.setLocalDescription(offer);

        // 5. Send offer to server, get CF's answer
        const answerData = await apiCall(`/api/voice/${netId}/answer`, {
            method: 'POST',
            body: JSON.stringify({
                userId: user.id,
                sessionDescription: {
                    type: 'offer',
                    sdp: peerConnection.localDescription.sdp,
                },
            }),
        });

        if (answerData.sessionDescription) {
            const answer = new RTCSessionDescription({
                type: 'answer',
                sdp: answerData.sessionDescription.sdp,
            });
            await peerConnection.setRemoteDescription(answer);
        }

        // 6. If speaker, notify server we published our track
        if (isSpeaker && localStream) {
            await apiCall(`/api/voice/${netId}/publish`, {
                method: 'POST',
                body: JSON.stringify({
                    userId: user.id,
                    trackName: `audio-${user.id}`,
                }),
            });
        }

        // 7. Pull existing speaker tracks
        if (joinData.speakerTracks?.length > 0) {
            await pullSpeakerTracks(netId, user.id, joinData.speakerTracks);
        }

        // 8. Start local speaker detection if we're a speaker
        if (isSpeaker && localStream) {
            startSpeakingDetection(localStream, user.username);
        }

        isMuted = !isSpeaker;
        playJoinSound();

        console.log(`[VOICE] Joined net-${netId} as ${role}`);
        return true;
    } catch (err) {
        console.error('[VOICE] Join error:', err);
        cleanup();
        return false;
    }
}

/**
 * Leave the current voice room. Full cleanup.
 */
export async function leaveVoiceRoom() {
    if (!currentNetId) return;

    const netId = currentNetId;

    try {
        await apiCall(`/api/voice/${netId}/leave`, {
            method: 'POST',
            body: JSON.stringify({ userId: getCurrentUserId() }),
        });
    } catch (err) {
        console.warn('[VOICE] Leave API call failed:', err);
    }

    playLeaveSound();
    cleanup();
    console.log(`[VOICE] Left net-${netId}`);
}

// ============ MICROPHONE ============

/**
 * Acquire microphone with high-quality constraints.
 */
async function acquireMicrophone() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 48000,
                channelCount: 1, // Mono for voice (better quality than stereo for speech)
                latency: 0, // Request lowest latency
            },
        });

        // Add audio track to peer connection
        const track = localStream.getAudioTracks()[0];
        peerConnection.addTrack(track, localStream);

        console.log('[VOICE] Microphone acquired:', track.label);
        return true;
    } catch (err) {
        console.error('[VOICE] Microphone error:', err);
        throw new Error('Microphone access denied. Check browser permissions.');
    }
}

/**
 * Toggle mute state. Stops/starts the actual audio track.
 */
export function toggleMuteState() {
    if (!localStream) return false;

    const track = localStream.getAudioTracks()[0];
    if (!track) return false;

    isMuted = !isMuted;
    track.enabled = !isMuted;

    if (isMuted) {
        playMuteSound();
    } else {
        playUnmuteSound();
    }

    console.log(`[VOICE] ${isMuted ? 'Muted' : 'Unmuted'}`);
    return isMuted;
}

/**
 * Get current mute state.
 */
export function getMuteState() {
    return isMuted;
}

// ============ TRACK PULLING (Receiving other speakers) ============

/**
 * Pull audio tracks from other speakers via CF SFU.
 */
async function pullSpeakerTracks(netId, userId, tracks) {
    if (!peerConnection || !sessionId) return;

    try {
        const result = await apiCall(`/api/voice/${netId}/pull`, {
            method: 'POST',
            body: JSON.stringify({ userId, tracks }),
        });

        // If CF requires renegotiation, handle it
        if (result.requiresImmediateRenegotiation && result.sessionDescription) {
            const offer = new RTCSessionDescription({
                type: 'offer',
                sdp: result.sessionDescription.sdp,
            });
            await peerConnection.setRemoteDescription(offer);

            const answer = await peerConnection.createAnswer();
            answer.sdp = enhanceOpusSdp(answer.sdp);
            await peerConnection.setLocalDescription(answer);

            // Send answer back to CF
            await apiCall(`/api/voice/${netId}/renegotiate`, {
                method: 'POST',
                body: JSON.stringify({
                    userId,
                    sessionDescription: {
                        type: 'answer',
                        sdp: peerConnection.localDescription.sdp,
                    },
                }),
            });
        }
    } catch (err) {
        console.error('[VOICE] Error pulling tracks:', err);
    }
}

/**
 * Called when a new speaker joins — pull their track.
 */
export async function onNewSpeaker(netId, userId, speakerTrack) {
    await pullSpeakerTracks(netId, userId, [speakerTrack]);
    playJoinSound();
}

/**
 * Called when a speaker leaves — clean up their audio.
 */
export function onSpeakerLeft(username) {
    playLeaveSound();
    // Remote tracks are automatically cleaned up when CF closes them
}

// ============ SPEAKER DETECTION ============

/**
 * Set up real-time speaking detection on the local microphone.
 * Uses Web Audio API AnalyserNode for accurate voice activity detection.
 */
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
        const SILENCE_THRESHOLD = 8; // Frames of silence before "stopped speaking"
        const VOLUME_THRESHOLD = 15; // Min average volume to count as speaking

        speakingDetectionInterval = setInterval(() => {
            analyser.getByteFrequencyData(dataArray);

            // Calculate average volume (focus on voice frequency range ~85-3000Hz)
            // At 48kHz with fftSize 512, each bin = ~93.75Hz
            // Voice range bins: ~1 (93Hz) to ~32 (3000Hz)
            const voiceBins = dataArray.slice(1, 33);
            const avgVolume = voiceBins.reduce((sum, v) => sum + v, 0) / voiceBins.length;

            const isSpeakingNow = avgVolume > VOLUME_THRESHOLD && !isMuted;

            if (isSpeakingNow) {
                silenceFrames = 0;
                if (!wasSpeaking) {
                    wasSpeaking = true;
                    if (onSpeakingCallback) {
                        onSpeakingCallback(username, true);
                    }
                }
            } else {
                silenceFrames++;
                if (wasSpeaking && silenceFrames > SILENCE_THRESHOLD) {
                    wasSpeaking = false;
                    if (onSpeakingCallback) {
                        onSpeakingCallback(username, false);
                    }
                }
            }
        }, 50); // 20 checks/second for responsive UI

        analyserNode = analyser;
    } catch (err) {
        console.warn('[VOICE] Speaker detection setup failed:', err);
    }
}

/**
 * Set up speaking detection on a remote audio track.
 */
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
                    // We use mid as identifier since we don't know the username here
                    // The UI layer maps mid -> username via the room state
                    if (onSpeakingCallback) {
                        onSpeakingCallback(`_remote_${mid}`, true);
                    }
                }
            } else {
                silenceFrames++;
                if (wasSpeaking && silenceFrames > 8) {
                    wasSpeaking = false;
                    if (onSpeakingCallback) {
                        onSpeakingCallback(`_remote_${mid}`, false);
                    }
                }
            }
        }, 50);

        // Store interval for cleanup
        track.addEventListener('ended', () => clearInterval(interval));
    } catch (err) {
        console.warn('[VOICE] Remote track analysis setup failed:', err);
    }
}

// ============ ROLE CHANGES ============

/**
 * Handle promotion to speaker (was listener, now can speak).
 */
export async function onPromotedToSpeaker(netId, user) {
    if (!peerConnection || !sessionId) return false;

    isSpeaker = true;
    playPromotedSound();

    try {
        // Acquire mic
        await acquireMicrophone();

        // Create new offer with the audio track
        const offer = await peerConnection.createOffer();
        offer.sdp = enhanceOpusSdp(offer.sdp);
        await peerConnection.setLocalDescription(offer);

        // Send to server for renegotiation
        const result = await apiCall(`/api/voice/${netId}/renegotiate`, {
            method: 'POST',
            body: JSON.stringify({
                userId: user.id,
                sessionDescription: {
                    type: 'offer',
                    sdp: peerConnection.localDescription.sdp,
                },
            }),
        });

        if (result.sessionDescription) {
            const answer = new RTCSessionDescription({
                type: 'answer',
                sdp: result.sessionDescription.sdp,
            });
            await peerConnection.setRemoteDescription(answer);
        }

        // Notify server of published track
        await apiCall(`/api/voice/${netId}/publish`, {
            method: 'POST',
            body: JSON.stringify({
                userId: user.id,
                trackName: `audio-${user.id}`,
            }),
        });

        // Start speaking detection
        if (localStream) {
            startSpeakingDetection(localStream, user.username);
        }

        isMuted = false;
        console.log('[VOICE] Promoted to speaker — mic enabled');
        return true;
    } catch (err) {
        console.error('[VOICE] Promotion error:', err);
        return false;
    }
}

/**
 * Handle demotion back to listener.
 */
export function onDemotedToListener() {
    isSpeaker = false;
    isMuted = true;

    // Stop mic
    if (localStream) {
        localStream.getAudioTracks().forEach(t => t.stop());
        localStream = null;
    }

    // Stop speaking detection
    if (speakingDetectionInterval) {
        clearInterval(speakingDetectionInterval);
        speakingDetectionInterval = null;
    }

    playMuteSound();
    console.log('[VOICE] Demoted to listener — mic disabled');
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
    console.log(`[VOICE] Connection issue, reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    setTimeout(() => {
        if (peerConnection?.iceConnectionState === 'failed' || peerConnection?.iceConnectionState === 'disconnected') {
            // Try ICE restart
            peerConnection.restartIce();
        }
    }, delay);
}

// ============ CLEANUP ============

function cleanup() {
    // Stop speaking detection
    if (speakingDetectionInterval) {
        clearInterval(speakingDetectionInterval);
        speakingDetectionInterval = null;
    }

    // Stop local audio
    if (localStream) {
        localStream.getAudioTracks().forEach(t => t.stop());
        localStream = null;
    }

    // Remove remote audio elements
    for (const [, audio] of remoteAudioElements) {
        audio.srcObject = null;
        audio.remove();
    }
    remoteAudioElements.clear();
    trackMidMap.clear();

    // Close peer connection
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    sessionId = null;
    currentNetId = null;
    isSpeaker = false;
    isMuted = true;
    reconnectAttempts = 0;
    onSpeakingCallback = null;
    onTrackAddedCallback = null;
}

// ============ HELPERS ============

function getCurrentUserId() {
    // Get from the app's current user state
    return window.currentUser?.id;
}

async function apiCall(url, options = {}) {
    const res = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options.headers,
        },
    });
    return res.json();
}

// ============ STATUS ============

/**
 * Check if voice is currently connected.
 */
export function isConnected() {
    return peerConnection?.connectionState === 'connected';
}

/**
 * Check if Cloudflare voice is configured on the server.
 */
export async function checkVoiceConfig() {
    try {
        const config = await apiCall('/api/voice/config');
        return config.enabled;
    } catch {
        return false;
    }
}

/**
 * Get connection quality info.
 */
export async function getConnectionStats() {
    if (!peerConnection) return null;

    try {
        const stats = await peerConnection.getStats();
        let result = { rtt: 0, packetsLost: 0, jitter: 0 };

        stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                result.rtt = report.currentRoundTripTime * 1000; // ms
            }
            if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                result.packetsLost = report.packetsLost || 0;
                result.jitter = report.jitter || 0;
            }
        });

        return result;
    } catch {
        return null;
    }
}

// Export audio cue functions for use by the UI
export { playJoinSound, playLeaveSound, playPromotedSound, playMuteSound, playUnmuteSound };
