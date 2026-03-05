import { initMap, updateMapMarkers, updateMapStats } from './map.js';
import { initWallet, sendEmailOTP, verifyOTP, loginWithGoogle, signOut, syncUserWithBackend, getWalletAddress } from './wallet.js';
import {
    joinVoiceRoom, leaveVoiceRoom, toggleMuteState, getMuteState,
    onNewSpeaker, onSpeakerLeft, onPromotedToSpeaker, onDemotedToListener,
    checkVoiceConfig, isConnected, playJoinSound, playLeaveSound,
} from './voice.js';

// Global state
let currentStep = 1;
let verificationData = {
    dd214: null,
    driverLicense: null,
    rank: null,
    name: null,
    badges: [],
    units: []
};
let webcamStream = null;
let currentUser = null;
let channelIdMap = {}; // Maps channel names to IDs

// API Helper
const API_BASE = '';
async function api(endpoint, options = {}) {
    const res = await fetch(`${API_BASE}${endpoint}`, {
        headers: { 'Content-Type': 'application/json', ...options.headers },
        ...options
    });
    return res.json();
}

// Format currency
function formatCurrency(num) {
    return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatLargeNumber(num) {
    return num.toLocaleString('en-US');
}

// Auth Functions
let otpFlowId = null;

function hideAllAuthForms() {
    ['wallet-login-form', 'otp-form', 'login-form', 'signup-form'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
}

function showWalletLogin() {
    hideAllAuthForms();
    document.getElementById('wallet-login-form').classList.remove('hidden');
}

function showLegacyLogin() {
    hideAllAuthForms();
    document.getElementById('login-form').classList.remove('hidden');
}

function showSignup() {
    hideAllAuthForms();
    document.getElementById('signup-form').classList.remove('hidden');
}

function showLogin() {
    showLegacyLogin();
}

// CDP Wallet Login - Email OTP
async function handleWalletLogin() {
    const email = document.getElementById('wallet-email').value;
    if (!email) return;

    try {
        const result = await sendEmailOTP(email);
        otpFlowId = result.flowId;

        hideAllAuthForms();
        document.getElementById('otp-form').classList.remove('hidden');
        document.getElementById('otp-email-display').textContent = email;
        document.getElementById('otp-code').focus();
    } catch (err) {
        console.error('Email OTP failed:', err);
        alert('Failed to send verification code. Please try again.');
    }
}

// CDP Wallet Login - Verify OTP
async function handleVerifyOTP() {
    const otp = document.getElementById('otp-code').value;
    if (!otp || !otpFlowId) return;

    try {
        const result = await verifyOTP(otpFlowId, otp);

        // Sync with our backend
        const syncResult = await syncUserWithBackend({
            cdpUserId: result.user.cdpUserId,
            email: result.user.email,
            walletAddress: result.user.walletAddress,
        });

        if (syncResult.success) {
            currentUser = syncResult.user;
            localStorage.setItem('vetnet_session', JSON.stringify({
                userId: currentUser.id,
                username: currentUser.username,
                walletAddress: result.user.walletAddress,
            }));

            if (syncResult.requiresVerification) {
                // New user - go to DD-214 verification
                document.getElementById('auth-screen').classList.add('hidden');
                document.getElementById('verification-screen').classList.remove('hidden');
            } else {
                // Existing verified user - go to main app
                document.getElementById('auth-screen').classList.add('hidden');
                document.getElementById('main-app').classList.remove('hidden');
                await loadAllData();
            }
        }
    } catch (err) {
        console.error('OTP verification failed:', err);
        alert('Invalid code. Please try again.');
    }
}

// CDP Wallet Login - Google OAuth
async function handleGoogleLogin() {
    try {
        await loginWithGoogle();
        // Page will redirect to Google, then back
    } catch (err) {
        console.error('Google login failed:', err);
        alert('Google login failed. Please try again.');
    }
}

async function handleLogin() {
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;

    if (username && password) {
        try {
            const result = await api('/api/auth/login', {
                method: 'POST',
                body: JSON.stringify({ username, password })
            });

            if (result.success) {
                currentUser = result.user;

                // Save session to localStorage for persistence
                localStorage.setItem('vetnet_session', JSON.stringify({
                    userId: currentUser.id,
                    username: currentUser.username
                }));

                document.getElementById('auth-screen').classList.add('hidden');
                document.getElementById('main-app').classList.add('active');
                document.getElementById('current-user').textContent = currentUser.username;

                // Load all data
                await loadAllData();
            }
        } catch (err) {
            console.error('Login error:', err);
            // Don't show error for spoofed login - just log it
        }
    } else {
        showTerminalAlert('ERROR: Please enter username and password');
    }
}

// Check for saved session on page load
async function checkSavedSession() {
    const saved = localStorage.getItem('vetnet_session');
    if (saved) {
        try {
            const session = JSON.parse(saved);
            // Re-authenticate with saved username
            const result = await api('/api/auth/login', {
                method: 'POST',
                body: JSON.stringify({ username: session.username, password: 'auto' })
            });

            if (result.success) {
                currentUser = result.user;
                document.getElementById('auth-screen').classList.add('hidden');
                document.getElementById('main-app').classList.add('active');
                document.getElementById('current-user').textContent = currentUser.username;
                await loadAllData();
                return true;
            }
        } catch (err) {
            console.error('Session restore failed:', err);
            localStorage.removeItem('vetnet_session');
        }
    }
    return false;
}

// Initialize CDP wallet and check for existing session on page load
async function initApp() {
    // Try CDP wallet init first (handles OAuth redirect returns)
    try {
        const walletResult = await initWallet();
        if (walletResult.signedIn && walletResult.user) {
            // User returned from OAuth redirect or has active session
            const syncResult = await syncUserWithBackend(walletResult.user);
            if (syncResult.success) {
                currentUser = syncResult.user;
                document.getElementById('auth-screen').classList.add('hidden');
                document.getElementById('main-app').classList.add('active');
                document.getElementById('current-user').textContent = currentUser.username;
                await loadAllData();
                return;
            }
        }
    } catch (err) {
        console.warn('[WALLET] CDP init skipped:', err.message);
    }

    // Fallback to saved session (legacy login)
    await checkSavedSession();
}

document.addEventListener('DOMContentLoaded', initApp);

async function startVerification() {
    const email = document.getElementById('signup-email').value;
    const username = document.getElementById('signup-username').value;
    const password = document.getElementById('signup-password').value;

    if (email && username && password) {
        // Start verification flow
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('verification-screen').classList.remove('hidden');
        document.getElementById('current-user').textContent = username.toUpperCase();
    } else {
        showTerminalAlert('ERROR: Please fill in all fields');
    }
}

async function logout() {
    if (await showTerminalConfirm('Are you sure you want to logout?')) {
        if (currentUser) {
            await api('/api/auth/logout', {
                method: 'POST',
                body: JSON.stringify({ userId: currentUser.id })
            });
        }
        currentUser = null;

        // Clear saved session
        localStorage.removeItem('vetnet_session');

        document.getElementById('main-app').classList.remove('active');
        document.getElementById('auth-screen').classList.remove('hidden');
        document.getElementById('login-username').value = '';
        document.getElementById('login-password').value = '';
    }
}

// Load all data from APIs
async function loadAllData() {
    await Promise.all([
        loadNetworkStats(),
        loadTreasury(),
        loadLeaderboard(),
        loadMembers(),
        loadChannels(),
        loadNets(),
        loadNetsInOverview(),
        loadUserProfile(),
        loadNetworkMap(),
        loadMultipliers()
    ]);
}

// Load world map with member locations
async function loadNetworkMap() {
    try {
        initMap('network-map');
        const data = await api('/api/locations/map');
        if (data.locations) {
            updateMapMarkers(data.locations);
        }
        if (data.stats) {
            updateMapStats(data.stats);
        }
    } catch (err) {
        // Map is non-critical, just init empty
        initMap('network-map');
    }
}

// Load network stats
async function loadNetworkStats() {
    try {
        const [stats, treasury] = await Promise.all([
            api('/api/stats'),
            api('/api/treasury'),
        ]);

        const totalEl = document.getElementById('stat-total-members');
        if (totalEl) totalEl.textContent = formatLargeNumber(stats.total_members || 0);

        const activeEl = document.getElementById('stat-active');
        if (activeEl) activeEl.textContent = formatLargeNumber(stats.active_nodes || stats.total_members || 0);

        const treasuryEl = document.getElementById('stat-treasury');
        if (treasuryEl) treasuryEl.textContent = formatCurrency(treasury.balance || 0);

        if (currentUser) {
            const pointsEl = document.getElementById('stat-user-points');
            if (pointsEl) pointsEl.textContent = formatLargeNumber(Math.floor((currentUser.stake_percentage || 0) * 1000));

            const rankEl = document.getElementById('stat-user-rank');
            if (rankEl) rankEl.textContent = '#' + (currentUser.rank || '--');

            const statusEl = document.getElementById('stat-membership-status');
            if (statusEl) statusEl.textContent = 'VERIFIED';
        }
    } catch (err) {
        console.error('Failed to load network stats:', err);
    }
}

// Load treasury data
async function loadTreasury() {
    try {
        const [treasury, health] = await Promise.all([
            api('/api/treasury'),
            api('/api/network-health'),
        ]);

        // Treasury balance
        const balanceEl = document.getElementById('treasury-balance');
        if (balanceEl) balanceEl.textContent = formatCurrency(treasury.balance || 0);

        const duesEl = document.getElementById('treasury-dues');
        if (duesEl) duesEl.textContent = formatCurrency(treasury.member_dues || 0);

        const donationsEl = document.getElementById('treasury-donations');
        if (donationsEl) donationsEl.textContent = formatCurrency(treasury.donations_total || 0);

        // Allocation percentages
        const mktEl = document.getElementById('treasury-marketing');
        if (mktEl) mktEl.textContent = (treasury.marketing_pct || 40) + '%';
        const hostEl = document.getElementById('treasury-hosting');
        if (hostEl) hostEl.textContent = (treasury.hosting_pct || 30) + '%';
        const resEl = document.getElementById('treasury-reserve');
        if (resEl) resEl.textContent = (treasury.reserve_pct || 30) + '%';

        // Network health
        const activeEl = document.getElementById('health-active');
        if (activeEl) activeEl.textContent = formatLargeNumber(health.activeMembers || 0);
        const newEl = document.getElementById('health-new');
        if (newEl) newEl.textContent = health.newThisMonth || 0;
        const churnedEl = document.getElementById('health-churned');
        if (churnedEl) churnedEl.textContent = health.churned || 0;
        const reclaimedEl = document.getElementById('health-reclaimed');
        if (reclaimedEl) reclaimedEl.textContent = health.reclaimed || 0;
        const churnRateEl = document.getElementById('health-churn-rate');
        if (churnRateEl) churnRateEl.textContent = health.churnRate || '0%';
        const reclaimRateEl = document.getElementById('health-reclaim-rate');
        if (reclaimRateEl) reclaimRateEl.textContent = health.reclaimRate || '0%';
    } catch (err) {
        console.error('Failed to load treasury:', err);
    }
}

// Load leaderboard
async function loadLeaderboard() {
    try {
        const data = await api('/api/leaderboard?limit=6');
        const rows = data.leaderboard || [];
        const container = document.getElementById('leaderboard-rows');
        if (!container) return;

        container.innerHTML = '';

        rows.forEach(member => {
            const row = document.createElement('div');
            row.className = 'table-row';
            row.innerHTML = `
                <div class="table-cell rank">${String(member.rank).padStart(3, '0')}</div>
                <div class="table-cell">${member.callsign}</div>
                <div class="table-cell">${member.unit || 'N/A'}</div>
                <div class="table-cell percentage">${formatLargeNumber(member.points)}</div>
                <div class="table-cell ${member.isOnline ? 'error-text' : ''}" style="${!member.isOnline ? 'color: #666;' : ''}">${member.isOnline ? '●' : '○'}</div>
            `;
            container.appendChild(row);
        });

        // Show current user's position
        if (currentUser) {
            const rankDisplay = document.getElementById('user-rank-display');
            if (rankDisplay) {
                rankDisplay.textContent = `YOUR POSITION: #${currentUser.rank || '?'} of ${rows.length}`;
            }
        }
    } catch (err) {
        console.error('Failed to load leaderboard:', err);
    }
}

// Load multiplier breakdown (publicly visible)
async function loadMultipliers() {
    try {
        const data = await api('/api/points/multipliers');
        const container = document.getElementById('multiplier-table');
        const badge = document.getElementById('current-tier-badge');
        if (!container) return;

        if (badge) {
            badge.textContent = `${data.memberCount} MEMBERS | ${data.currentTier} ACTIVE`;
        }

        const actions = Object.keys(data.basePoints);
        const actionLabels = {
            accepted_into_network: 'ACCEPTED INTO NETWORK',
            monthly_dues: 'MONTHLY DUES ($10)',
            donation_per_dollar: 'DONATION (PER $1)',
            referral_accepted: 'REFERRAL (ACCEPTED)',
            profile_complete: 'PROFILE COMPLETE',
            first_chat_message: 'FIRST CHAT MESSAGE',
        };

        let html = '<table><thead><tr><th>ACTION</th><th>BASE</th>';
        data.tiers.forEach(tier => {
            const label = tier.name.replace('_', ' ');
            html += `<th class="${tier.isActive ? 'tier-active' : 'tier-inactive'}">${label}${tier.isActive ? ' ◄' : ''}</th>`;
        });
        html += '</tr></thead><tbody>';

        actions.forEach(action => {
            const base = data.basePoints[action];
            html += `<tr><td>${actionLabels[action] || action}</td><td>${base}</td>`;
            data.tiers.forEach(tier => {
                const mult = tier.multipliers[action];
                const pts = Math.floor(base * mult);
                const cls = tier.isActive ? 'tier-active multiplier-value' : 'tier-inactive';
                html += `<td class="${cls}">${mult}x (${formatLargeNumber(pts)})</td>`;
            });
            html += '</tr>';
        });

        html += '</tbody></table>';
        container.innerHTML = html;
    } catch (err) {
        console.error('Failed to load multipliers:', err);
    }
}

// Load members
async function loadMembers() {
    try {
        const { members } = await api('/api/members?limit=20');
        const container = document.getElementById('members-directory-rows');
        if (!container) return;

        container.innerHTML = '';

        members.forEach((member, index) => {
            const row = document.createElement('div');
            row.className = 'table-row';
            const points = Math.floor((member.stake_percentage || 0) * 1000);
            row.innerHTML = `
                <div class="table-cell rank">${String(index + 1).padStart(3, '0')}</div>
                <div class="table-cell">${member.username}</div>
                <div class="table-cell">${member.unit || 'N/A'}</div>
                <div class="table-cell percentage">${formatLargeNumber(points)}</div>
                <div class="table-cell ${member.is_online ? 'error-text' : ''}" style="${!member.is_online ? 'color: #666;' : ''}">${member.is_online ? '●' : '○'}</div>
            `;
            container.appendChild(row);
        });
    } catch (err) {
        console.error('Failed to load members:', err);
    }
}

// Load channels
async function loadChannels() {
    const channels = await api('/api/channels');
    const chatList = document.querySelector('.chat-list');

    chatList.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div style="font-weight: bold; color: #00ff41;">CHANNELS</div>
            <button onclick="openCreateChannelModal()" style="font-size: 9px; padding: 2px 6px; background: rgba(0, 255, 65, 0.1); border: 1px solid #00ff41; color: #00ff41; cursor: pointer;">+ NEW</button>
        </div>
    `;

    const regularChannels = channels.filter(c => c.type === 'channel');
    const dmChannels = channels.filter(c => c.type === 'dm');

    regularChannels.forEach((channel, index) => {
        channelIdMap[channel.name.toLowerCase()] = channel.id;
        const room = document.createElement('div');
        room.className = `chat-room${index === 0 ? ' active' : ''}`;
        room.onclick = () => switchChannel(channel.id, channel.name);
        room.innerHTML = `
            <span style="margin-right: 8px;">#</span>
            <span>${channel.name}</span>
            <span class="unread-count">${channel.unread_count || '--'}</span>
        `;
        chatList.appendChild(room);
    });

    const dmHeader = document.createElement('div');
    dmHeader.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin: 15px 0 10px 0;">
            <div style="font-weight: bold; color: #00ff41;">DIRECT_MSG</div>
            <button onclick="openNewDMModal()" style="font-size: 9px; padding: 2px 6px; background: rgba(0, 255, 65, 0.1); border: 1px solid #00ff41; color: #00ff41; cursor: pointer;">+ NEW</button>
        </div>
    `;
    chatList.appendChild(dmHeader);

    dmChannels.forEach(channel => {
        channelIdMap[channel.name.toLowerCase()] = channel.id;
        const displayName = channel.name.replace('DM_', '');
        const room = document.createElement('div');
        room.className = 'chat-room';
        room.onclick = () => switchChannel(channel.id, displayName, true);
        room.innerHTML = `
            <span style="margin-right: 8px;">@</span>
            <span>${displayName}</span>
            <span class="unread-count">${channel.unread_count || '--'}</span>
        `;
        chatList.appendChild(room);
    });

    // Load first channel messages
    if (regularChannels.length > 0) {
        await loadMessages(regularChannels[0].id, regularChannels[0].name);
    }
}

let currentChannelId = null;
let messagesMap = new Map(); // Store messages by ID for quick lookup

async function switchChannel(channelId, channelName, isDM = false) {
    const rooms = document.querySelectorAll('.chat-room');
    rooms.forEach(room => room.classList.remove('active'));
    event.target.closest('.chat-room').classList.add('active');

    // Clear reply and image state when switching channels
    cancelReply();
    cancelImage();

    currentChannelId = channelId;
    await loadMessages(channelId, channelName, isDM);
}

let replyToMessageId = null;
let replyToUsername = null;
let selectedImageData = null;

async function loadMessages(channelId, channelName, isDM = false) {
    currentChannelId = channelId;
    const messages = await api(`/api/channels/${channelId}/messages`);

    const chatHeader = document.getElementById('chat-header');
    const chatMessages = document.getElementById('chat-messages');

    chatHeader.textContent = isDM ? `DM: ${channelName}` : `#${channelName} - ${messages.length} messages`;
    chatMessages.innerHTML = '';

    messages.forEach(msg => {
        appendMessage(msg, chatMessages);
    });

    chatMessages.scrollTop = chatMessages.scrollHeight;
}

let contextMenuData = { messageId: null, username: null, content: null };

function appendMessage(msg, container) {
    // Store message in map for quick lookup
    messagesMap.set(msg.id, msg);

    const timestamp = new Date(msg.timestamp);
    const timeStr = `[${String(timestamp.getHours()).padStart(2, '0')}${String(timestamp.getMinutes()).padStart(2, '0')}]`;

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';
    messageDiv.dataset.messageId = msg.id;
    messageDiv.dataset.username = msg.username;
    messageDiv.dataset.content = msg.content || '';

    let replyHTML = '';
    if (msg.reply_to_id) {
        const replyToMsg = messagesMap.get(msg.reply_to_id);
        const replyUsername = replyToMsg ? replyToMsg.username : 'Unknown';
        const replyPreview = replyToMsg ? (replyToMsg.content || '[Image]').substring(0, 50) : 'Message not found';
        replyHTML = `
            <div onclick="scrollToMessage('${msg.reply_to_id}')" style="padding: 4px 8px; margin-bottom: 4px; border-left: 2px solid #00ff41; background: rgba(0, 255, 65, 0.05); font-size: 9px; cursor: pointer;"
                 onmouseover="this.style.background='rgba(0, 255, 65, 0.1)'"
                 onmouseout="this.style.background='rgba(0, 255, 65, 0.05)'">
                <div style="color: #888;">↩ Replying to <span style="color: #ffaa00;">${replyUsername}</span></div>
                <div style="color: #666; margin-top: 2px;">${replyPreview}</div>
            </div>
        `;
    }

    let imageHTML = '';
    if (msg.attachment_url && msg.attachment_type && msg.attachment_type.startsWith('image/')) {
        imageHTML = `
            <div style="margin-top: 8px;">
                <img src="${msg.attachment_url}" style="max-width: 300px; max-height: 300px; border: 1px solid #00ff41; cursor: pointer;" onclick="window.open('${msg.attachment_url}', '_blank')" />
            </div>
        `;
    }

    messageDiv.innerHTML = `
        <div class="message-header">
            <span>${msg.username}</span>
            <span class="timestamp">${timeStr}</span>
        </div>
        ${replyHTML}
        <div>${msg.content || ''}</div>
        ${imageHTML}
        <div class="message-reactions" id="reactions-${msg.id}"></div>
    `;

    // Add right-click handler
    messageDiv.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        showContextMenu(e, msg.id, msg.username, msg.content || '');
    });

    // Add long-press handler for mobile
    let pressTimer;
    messageDiv.addEventListener('touchstart', function(e) {
        pressTimer = setTimeout(function() {
            const touch = e.touches[0];
            showContextMenu({ clientX: touch.clientX, clientY: touch.clientY }, msg.id, msg.username, msg.content || '');
        }, 500);
    });

    messageDiv.addEventListener('touchend', function() {
        clearTimeout(pressTimer);
    });

    messageDiv.addEventListener('touchmove', function() {
        clearTimeout(pressTimer);
    });

    if (!container) {
        container = document.getElementById('chat-messages');
    }
    container.appendChild(messageDiv);

    // Render reactions AFTER the message is in the DOM
    renderReactions(msg.id, msg.reactions || {});
}

async function sendMessage() {
    const input = document.getElementById('message-input');
    const message = input.value.trim();

    if ((message || selectedImageData) && currentChannelId && currentUser) {
        const payload = {
            userId: currentUser.id,
            content: message,
            replyToId: replyToMessageId,
            attachmentUrl: selectedImageData,
            attachmentType: selectedImageData ? 'image/jpeg' : null
        };

        await api(`/api/channels/${currentChannelId}/messages`, {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        // Message will be broadcast via WebSocket - no need to manually append
        input.value = '';
        cancelReply();
        cancelImage();
    }
}

// Add Enter key and paste support to message input
document.addEventListener('DOMContentLoaded', function() {
    const messageInput = document.getElementById('message-input');

    // Enter key to send message
    messageInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Paste image support
    messageInput.addEventListener('paste', async function(e) {
        const items = e.clipboardData?.items;
        if (!items) return;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            // Check if the item is an image
            if (item.type.startsWith('image/')) {
                e.preventDefault();

                const file = item.getAsFile();
                if (!file) continue;

                // Validate file size (20MB limit)
                if (file.size > 20 * 1024 * 1024) {
                    alert('Image too large. Maximum size is 20MB.');
                    return;
                }

                // Read the image as base64
                const reader = new FileReader();
                reader.onload = function(event) {
                    selectedImageData = event.target.result;

                    // Show preview
                    const preview = document.getElementById('image-preview');
                    const previewImg = document.getElementById('preview-img');
                    previewImg.src = selectedImageData;
                    preview.style.display = 'block';
                };
                reader.readAsDataURL(file);
                break;
            }
        }
    });
});

function setReplyTo(messageId, username, content) {
    replyToMessageId = messageId;
    replyToUsername = username;

    document.getElementById('reply-indicator').style.display = 'block';
    document.getElementById('reply-to-user').textContent = username;
    document.getElementById('reply-to-preview').textContent = content.substring(0, 50) + (content.length > 50 ? '...' : '');
    document.getElementById('message-input').focus();
}

function cancelReply() {
    replyToMessageId = null;
    replyToUsername = null;
    document.getElementById('reply-indicator').style.display = 'none';
}

function scrollToMessage(messageId) {
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    if (messageElement) {
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Highlight the message briefly
        messageElement.style.background = 'rgba(0, 255, 65, 0.2)';
        setTimeout(() => {
            messageElement.style.background = '';
        }, 1500);
    }
}

// ============ MESSAGE REACTIONS ============
let currentReactionMessageId = null;

function renderReactions(messageId, reactions) {
    const container = document.getElementById(`reactions-${messageId}`);
    if (!container) return;

    container.innerHTML = '';

    // Render each reaction type
    if (reactions && Object.keys(reactions).length > 0) {
        Object.keys(reactions).forEach(emoji => {
            const reactionData = reactions[emoji];
            const userReacted = currentUser && reactionData.users.some(u => u.id === currentUser.id);

            const reactionEl = document.createElement('div');
            reactionEl.className = 'reaction-item' + (userReacted ? ' user-reacted' : '');
            reactionEl.innerHTML = `${emoji} <span style="color: #666;">${reactionData.count}</span>`;
            reactionEl.dataset.emoji = emoji;
            reactionEl.dataset.messageId = messageId;

            // Click to toggle reaction
            reactionEl.addEventListener('click', function(e) {
                e.stopPropagation();
                toggleReaction(messageId, emoji);
            });

            // Touch handling for mobile
            reactionEl.addEventListener('touchend', function(e) {
                e.preventDefault();
                e.stopPropagation();
                toggleReaction(messageId, emoji);
            });

            // Hover to show who reacted (desktop only)
            reactionEl.addEventListener('mouseenter', function(e) {
                showReactionTooltip(e, reactionData.users);
            });

            reactionEl.addEventListener('mouseleave', function() {
                hideReactionTooltip();
            });

            container.appendChild(reactionEl);
        });
    }

    // Always add "+" button to add new reactions
    const addBtn = document.createElement('div');
    addBtn.className = 'reaction-add-btn';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        showReactionPicker(e, messageId);
    });
    addBtn.addEventListener('touchend', function(e) {
        e.preventDefault();
        e.stopPropagation();
        showReactionPicker(e, messageId);
    });
    container.appendChild(addBtn);
}

async function toggleReaction(messageId, emoji) {
    if (!currentUser) {
        console.error('No current user');
        return;
    }

    if (!messageId) {
        console.error('No message ID provided to toggleReaction');
        return;
    }

    console.log('Toggling reaction:', { messageId, emoji, userId: currentUser.id });

    try {
        const response = await api(`/api/messages/${messageId}/reactions`, {
            method: 'POST',
            body: JSON.stringify({ userId: currentUser.id, emoji })
        });

        console.log('Reaction toggle response:', response);

        // Update will come via WebSocket, but update locally for immediate feedback
        renderReactions(messageId, response.reactions);
    } catch (err) {
        console.error('Failed to toggle reaction:', err);
        showToast('Failed to add reaction');
    }
}

async function addReaction(emoji) {
    const messageId = currentReactionMessageId;
    if (!messageId) {
        console.error('No message ID set for reaction');
        return;
    }

    closeReactionPicker();
    await toggleReaction(messageId, emoji);
}

function showReactionPicker(event, messageId) {
    const picker = document.getElementById('reaction-picker');
    const backdrop = document.getElementById('reaction-picker-backdrop');
    currentReactionMessageId = messageId;

    // Clear previous emojis
    picker.innerHTML = '';

    // Available reaction emojis
    const emojis = ['👍', '👎', '😊', '🤮', '😅', '😂', '🔫', '💥', '🔥'];

    // Create emoji buttons with proper event handling
    emojis.forEach(emoji => {
        const emojiBtn = document.createElement('div');
        emojiBtn.className = 'reaction-picker-emoji';
        emojiBtn.textContent = emoji;

        // Handle both click and touch
        const handleReaction = function(e) {
            e.preventDefault();
            e.stopPropagation();
            addReaction(emoji);
        };

        emojiBtn.addEventListener('click', handleReaction);
        emojiBtn.addEventListener('touchend', handleReaction);

        picker.appendChild(emojiBtn);
    });

    // Check if mobile (screen width < 768px)
    const isMobile = window.innerWidth < 768;

    if (isMobile) {
        // On mobile, show backdrop and center the picker
        backdrop.style.display = 'block';
        backdrop.addEventListener('click', closeReactionPicker, { once: true });
        backdrop.addEventListener('touchend', closeReactionPicker, { once: true });

        picker.style.left = '50%';
        picker.style.top = '50%';
        picker.style.transform = 'translate(-50%, -50%)';
        picker.style.position = 'fixed';
    } else {
        // On desktop, position near the click
        picker.style.position = 'absolute';
        picker.style.transform = 'none';
        picker.style.left = event.pageX + 'px';
        picker.style.top = (event.pageY - 60) + 'px';

        // Close picker when clicking outside (desktop only)
        setTimeout(() => {
            document.addEventListener('click', closeReactionPicker, { once: true });
        }, 200);
    }

    picker.classList.add('show');

    event.stopPropagation();
    if (event.preventDefault) event.preventDefault();
}

function closeReactionPicker() {
    const picker = document.getElementById('reaction-picker');
    const backdrop = document.getElementById('reaction-picker-backdrop');

    picker.classList.remove('show');
    backdrop.style.display = 'none';
    currentReactionMessageId = null;
}

let reactionTooltip = null;

function showReactionTooltip(event, users) {
    hideReactionTooltip();

    reactionTooltip = document.createElement('div');
    reactionTooltip.className = 'reaction-tooltip';
    reactionTooltip.textContent = users.map(u => u.username).join(', ');

    document.body.appendChild(reactionTooltip);

    // Position tooltip
    const rect = event.target.getBoundingClientRect();
    reactionTooltip.style.left = rect.left + 'px';
    reactionTooltip.style.top = (rect.top - reactionTooltip.offsetHeight - 5) + 'px';
}

function hideReactionTooltip() {
    if (reactionTooltip) {
        reactionTooltip.remove();
        reactionTooltip = null;
    }
}

// ============ MESSAGE CONTEXT MENU ============
function showContextMenu(event, messageId, username, content) {
    const menu = document.getElementById('message-context-menu');

    // Store message data for context menu actions
    contextMenuData = { messageId, username, content };

    // Position the menu
    menu.style.display = 'block';
    menu.style.left = event.clientX + 'px';
    menu.style.top = event.clientY + 'px';

    // Close menu when clicking anywhere else
    setTimeout(() => {
        document.addEventListener('click', closeContextMenu, { once: true });
    }, 0);
}

function closeContextMenu() {
    document.getElementById('message-context-menu').style.display = 'none';
}

function contextMenuReact() {
    if (contextMenuData.messageId) {
        // Show reaction picker
        const messageEl = document.querySelector(`[data-message-id="${contextMenuData.messageId}"]`);
        if (messageEl) {
            const rect = messageEl.getBoundingClientRect();
            showReactionPicker({ pageX: rect.left + 50, pageY: rect.bottom - 30 }, contextMenuData.messageId);
        }
    }
    closeContextMenu();
}

function contextMenuReply() {
    if (contextMenuData.messageId) {
        setReplyTo(contextMenuData.messageId, contextMenuData.username, contextMenuData.content);
    }
    closeContextMenu();
}

function contextMenuCopyText() {
    if (contextMenuData.content) {
        navigator.clipboard.writeText(contextMenuData.content).then(() => {
            showToast('Text copied');
        }).catch(() => {
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = contextMenuData.content;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            showToast('Text copied');
        });
    }
    closeContextMenu();
}

function handleImageSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Check file type
    if (!file.type.startsWith('image/')) {
        showToast('Please select an image file');
        return;
    }

    // Check file size (20MB limit)
    if (file.size > 20 * 1024 * 1024) {
        showToast('Image too large (max 20MB)');
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        selectedImageData = e.target.result;
        document.getElementById('preview-img').src = selectedImageData;
        document.getElementById('image-preview').style.display = 'block';
    };
    reader.readAsDataURL(file);
}

function cancelImage() {
    selectedImageData = null;
    document.getElementById('image-preview').style.display = 'none';
    document.getElementById('image-upload-input').value = '';
}

// ============ CHANNEL CREATION ============
function openCreateChannelModal() {
    document.getElementById('create-channel-modal').classList.add('show');
    document.getElementById('new-channel-name').value = '';
    document.getElementById('channel-is-private').checked = false;
}

function closeCreateChannelModal(event) {
    if (!event || event.target.id === 'create-channel-modal') {
        document.getElementById('create-channel-modal').classList.remove('show');
    }
}

async function createChannel() {
    const name = document.getElementById('new-channel-name').value.trim();
    const isPrivate = document.getElementById('channel-is-private').checked;

    if (!name) {
        showToast('Please enter a channel name');
        return;
    }

    try {
        await api('/api/channels', {
            method: 'POST',
            body: JSON.stringify({ userId: currentUser.id, name, isPrivate })
        });

        showToast('Channel created!');
        closeCreateChannelModal();
        await loadChannels();
    } catch (err) {
        showToast('Error creating channel');
    }
}

// ============ DM CREATION ============
let dmSearchTimeout = null;

function openNewDMModal() {
    document.getElementById('new-dm-modal').classList.add('show');
    document.getElementById('dm-user-search').value = '';
    document.getElementById('user-search-results').style.display = 'none';
    document.getElementById('user-search-results').innerHTML = '';
}

function closeNewDMModal(event) {
    if (!event || event.target.id === 'new-dm-modal') {
        document.getElementById('new-dm-modal').classList.remove('show');
    }
}

async function searchUsers() {
    const query = document.getElementById('dm-user-search').value.trim();

    if (query.length < 2) {
        document.getElementById('user-search-results').style.display = 'none';
        return;
    }

    // Debounce search
    if (dmSearchTimeout) clearTimeout(dmSearchTimeout);

    dmSearchTimeout = setTimeout(async () => {
        try {
            const users = await api(`/api/users/search?q=${encodeURIComponent(query)}`);
            const resultsDiv = document.getElementById('user-search-results');

            if (users.length === 0) {
                resultsDiv.innerHTML = '<div style="padding: 10px; color: #888;">No users found</div>';
            } else {
                resultsDiv.innerHTML = users.map(user => `
                    <div onclick="createDM(${user.id}, '${user.username}')" style="padding: 8px 10px; cursor: pointer; border-bottom: 1px solid #004d15; hover: background: rgba(0, 255, 65, 0.05);" onmouseover="this.style.background='rgba(0, 255, 65, 0.05)'" onmouseout="this.style.background='transparent'">
                        <div style="font-weight: bold; color: #00ff41;">${user.username}</div>
                        <div style="font-size: 9px; color: #888;">${user.rank_code} - ${user.unit || 'N/A'}</div>
                    </div>
                `).join('');
            }

            resultsDiv.style.display = 'block';
        } catch (err) {
            console.error('Search error:', err);
        }
    }, 300);
}

async function createDM(targetUserId, targetUsername) {
    try {
        const dm = await api('/api/dms/create', {
            method: 'POST',
            body: JSON.stringify({ userId: currentUser.id, targetUserId })
        });

        closeNewDMModal();
        await loadChannels();

        // Switch to the new DM
        const displayName = dm.name.replace('DM_', '');
        await switchChannel(dm.id, displayName, true);

        showToast(`DM with ${targetUsername} ready`);
    } catch (err) {
        showToast('Error creating DM');
    }
}

// Load user profile
async function loadUserProfile() {
    if (!currentUser) return;

    const profile = await api(`/api/profile/${currentUser.id}`);
    currentUser = { ...currentUser, ...profile };

    document.getElementById('profile-username').textContent = profile.username;
    document.getElementById('profile-rank').textContent = `${profile.rank_code} ${profile.rank_title}`;
    document.getElementById('profile-unit').textContent = profile.unit?.replace(/_/g, ' ') || 'N/A';

    // Update other profile fields
    const profileRows = document.querySelectorAll('.profile-row .stat-value');
    if (profileRows.length >= 8) {
        profileRows[2].textContent = profile.mos || 'N/A';
        profileRows[3].textContent = profile.service_years || 'N/A';
        profileRows[4].textContent = profile.deployment_history || 'N/A';
        profileRows[5].textContent = profile.clearance || 'N/A';
        profileRows[6].textContent = profile.stake_percentage + '%';
        profileRows[7].textContent = profile.join_date || 'N/A';
    }

    // Update badges
    const badgesContainer = document.getElementById('profile-badges');
    if (profile.badges && profile.badges.length > 0) {
        badgesContainer.innerHTML = profile.badges.map(badge =>
            `<div class="badge">${badge}</div>`
        ).join('');
    }

    // Load referral data
    await loadReferralData();
}

// ============ REFERRAL SYSTEM ============

let currentInviteCode = null;

// Toast notification helper
function showToast(message) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
}

// Terminal-style modals
let terminalModalResolve = null;

function showTerminalAlert(message) {
    const modal = document.getElementById('terminal-modal');
    const messageDiv = document.getElementById('terminal-modal-message');
    const buttonsDiv = document.getElementById('terminal-modal-buttons');

    messageDiv.textContent = message;
    buttonsDiv.innerHTML = '<button onclick="closeTerminalModal()" style="padding: 8px 20px; background: rgba(0, 255, 65, 0.1); border: 1px solid #00ff41; color: #00ff41; cursor: pointer; font-family: \'JetBrains Mono\', monospace; font-size: 11px;">OK</button>';
    modal.style.display = 'flex';
}

function showTerminalConfirm(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('terminal-modal');
        const messageDiv = document.getElementById('terminal-modal-message');
        const buttonsDiv = document.getElementById('terminal-modal-buttons');

        terminalModalResolve = resolve;

        messageDiv.textContent = message;
        buttonsDiv.innerHTML = `
            <button onclick="closeTerminalModal(false)" style="padding: 8px 20px; background: rgba(255, 0, 0, 0.1); border: 1px solid #ff0000; color: #ff0000; cursor: pointer; font-family: 'JetBrains Mono', monospace; font-size: 11px;">CANCEL</button>
            <button onclick="closeTerminalModal(true)" style="padding: 8px 20px; background: rgba(0, 255, 65, 0.1); border: 1px solid #00ff41; color: #00ff41; cursor: pointer; font-family: 'JetBrains Mono', monospace; font-size: 11px;">CONFIRM</button>
        `;
        modal.style.display = 'flex';
    });
}

function closeTerminalModal(result) {
    const modal = document.getElementById('terminal-modal');
    modal.style.display = 'none';

    if (terminalModalResolve) {
        terminalModalResolve(result === true);
        terminalModalResolve = null;
    }
}

// Load referral data for current user
async function loadReferralData() {
    if (!currentUser) return;

    try {
        // Get invite stats
        const inviteData = await api(`/api/invites/${currentUser.id}`);
        document.getElementById('invites-remaining').textContent = inviteData.weeklyInvitesRemaining;
        document.getElementById('total-referrals').textContent = inviteData.totalReferrals;

        // Check if user was referred by someone
        const referrerData = await api(`/api/users/${currentUser.id}/referrer`);
        if (referrerData.referrer) {
            document.getElementById('referred-by-section').classList.remove('hidden');
            document.getElementById('referred-by-name').textContent = referrerData.referrer.username;
        }

        // Load list of people this user has referred
        const referralsData = await api(`/api/users/${currentUser.id}/referrals`);
        if (referralsData.count > 0) {
            document.getElementById('referrals-list').classList.remove('hidden');
            const container = document.getElementById('referrals-container');
            container.innerHTML = referralsData.referrals.map(r =>
                `<div class="referral-badge">${r.username}</div>`
            ).join('');
        }

        // Show most recent unused invite if exists
        const unusedInvite = inviteData.invites.find(i => !i.used_by);
        if (unusedInvite) {
            currentInviteCode = unusedInvite.code;
            document.getElementById('current-invite-code').textContent = unusedInvite.code;
            document.getElementById('invite-code-display').classList.remove('hidden');
        }
    } catch (err) {
        console.error('Error loading referral data:', err);
    }
}

// Generate a new invite code
async function generateInvite() {
    if (!currentUser) return;

    try {
        const result = await api('/api/invites', {
            method: 'POST',
            body: JSON.stringify({ userId: currentUser.id })
        });

        if (result.error) {
            showToast(result.error);
            return;
        }

        currentInviteCode = result.invite.code;
        document.getElementById('current-invite-code').textContent = result.invite.code;
        document.getElementById('invite-code-display').classList.remove('hidden');
        document.getElementById('invites-remaining').textContent = result.remaining;

        showToast('INVITE_CODE_GENERATED!');
    } catch (err) {
        showToast('ERROR_GENERATING_INVITE');
    }
}

// Copy invite code to clipboard
async function copyInviteCode() {
    if (!currentInviteCode) return;

    try {
        await navigator.clipboard.writeText(currentInviteCode);
        showToast('CODE_COPIED: ' + currentInviteCode);
    } catch (err) {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = currentInviteCode;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        showToast('CODE_COPIED: ' + currentInviteCode);
    }
}

// Share invite via native share or copy link
async function shareInvite() {
    if (!currentInviteCode) return;

    const shareText = `Join VETNET - the credentialed veterans network. Use my invite code: ${currentInviteCode}`;
    const shareUrl = window.location.origin + '?invite=' + currentInviteCode;

    if (navigator.share) {
        try {
            await navigator.share({
                title: 'VETNET Invite',
                text: shareText,
                url: shareUrl
            });
            showToast('INVITE_SHARED!');
        } catch (err) {
            if (err.name !== 'AbortError') {
                copyInviteCode();
            }
        }
    } else {
        // Fallback: copy to clipboard
        try {
            await navigator.clipboard.writeText(shareText + '\n' + shareUrl);
            showToast('INVITE_LINK_COPIED!');
        } catch (err) {
            copyInviteCode();
        }
    }
}

// Check for invite code in URL on page load
function checkInviteCode() {
    const urlParams = new URLSearchParams(window.location.search);
    const inviteCode = urlParams.get('invite');
    if (inviteCode) {
        // Store for use during signup
        sessionStorage.setItem('pendingInviteCode', inviteCode);
        showToast('INVITE_CODE_DETECTED: ' + inviteCode);
    }
}

// Call on page load
document.addEventListener('DOMContentLoaded', checkInviteCode);

// ============ NETS (AUDIO ROOMS) SYSTEM ============

let currentNetId = null;
let currentNetData = null;
let netRefreshInterval = null;
let netChatRefreshInterval = null;

// WebSocket for real-time updates
let ws = null;
let wsReconnectAttempts = 0;
const WS_MAX_RECONNECT_ATTEMPTS = 5;

// Voice state
let voiceEnabled = false;

// Check if voice (Cloudflare Calls) is configured on server
async function checkVoiceEnabled() {
    voiceEnabled = await checkVoiceConfig();
    console.log('Voice enabled:', voiceEnabled);
}

// Initialize voice check on page load
document.addEventListener('DOMContentLoaded', checkVoiceEnabled);

// ============ WEBSOCKET REAL-TIME UPDATES ============

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    console.log('Connecting to WebSocket:', wsUrl);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('✓ WebSocket connected');
        wsReconnectAttempts = 0;

        // If we're in a net, subscribe to updates
        if (currentNetId) {
            ws.send(JSON.stringify({ type: 'subscribe', netId: currentNetId }));
        }
    };

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            handleWebSocketMessage(message);
        } catch (err) {
            console.error('Error parsing WebSocket message:', err);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };

    ws.onclose = () => {
        console.log('WebSocket disconnected');
        ws = null;

        // Attempt to reconnect if we haven't exceeded max attempts
        if (wsReconnectAttempts < WS_MAX_RECONNECT_ATTEMPTS) {
            wsReconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), 30000);
            console.log(`Reconnecting WebSocket in ${delay}ms (attempt ${wsReconnectAttempts}/${WS_MAX_RECONNECT_ATTEMPTS})`);
            setTimeout(connectWebSocket, delay);
        }
    };
}

function handleWebSocketMessage(message) {
    const { event, data, netId } = message;

    console.log('WebSocket event:', event, data);

    // Handle global events (not specific to a net)
    switch (event) {
        case 'net:created':
            // New net was created - refresh the net lists
            loadNets();
            loadNetsInOverview();
            return;

        case 'net:ended':
            // A net ended - refresh the net lists
            loadNets();
            loadNetsInOverview();
            // If we're in the net that ended, close it
            if (currentNetId && String(data.netId) === String(currentNetId)) {
                closeNetRoom();
                showToast('NET_ENDED by host');
            }
            return;

        case 'channel:created':
            // New channel created - refresh channel list
            loadChannels();
            return;

        case 'dm:created':
            // New DM created - refresh channel list
            loadChannels();
            return;

        case 'channel:message':
            // New message in a channel - only append if we're viewing that channel
            if (currentChannelId && String(data.channelId) === String(currentChannelId)) {
                const chatMessages = document.getElementById('chat-messages');
                appendMessage(data.message, chatMessages);
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }
            return;

        case 'message:reactions':
            // Reaction update for a message
            if (currentChannelId && String(data.channelId) === String(currentChannelId)) {
                renderReactions(data.messageId, data.reactions);
            }
            return;
    }

    // Only process net-specific messages for the current net
    if (netId && String(netId) !== String(currentNetId)) {
        return;
    }

    switch (event) {
        case 'net:message':
            // New chat message received
            appendNetMessage(data);
            break;

        case 'net:participant:join':
            playJoinSound();
            loadNetRoom();
            break;

        case 'net:participant:leave':
            playLeaveSound();
            loadNetRoom();
            break;

        case 'net:participant:role':
            // If this user was promoted/demoted, handle voice change
            if (data.userId === currentUser?.id) {
                const isSpeaker = ['host', 'co-host', 'speaker'].includes(data.role);
                if (isSpeaker) {
                    onPromotedToSpeaker(currentNetId, currentUser);
                } else {
                    onDemotedToListener();
                }
            }
            loadNetRoom();
            break;

        case 'net:participant:mute':
        case 'net:request:new':
        case 'net:request:denied':
            loadNetRoom();
            break;

        case 'voice:track:new':
            // New speaker track — pull it
            if (data.username !== currentUser?.username) {
                onNewSpeaker(currentNetId, currentUser?.id, data);
            }
            break;

        case 'voice:track:removed':
            // Speaker left or was demoted
            onSpeakerLeft(data.username);
            break;

        default:
            console.log('Unhandled WebSocket event:', event);
    }
}

function appendNetMessage(message) {
    const chatContainer = document.getElementById('net-chat-messages');
    if (!chatContainer) return;

    const shouldScroll = chatContainer.scrollTop + chatContainer.clientHeight >= chatContainer.scrollHeight - 50;

    const time = new Date(message.timestamp);
    const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';
    messageDiv.style.marginBottom = '8px';
    messageDiv.innerHTML = `
        <span style="color: #ffaa00;">${message.username}</span>
        <span style="color: #666; font-size: 9px;">[${timeStr}]</span>
        <div>${message.content}</div>
    `;

    chatContainer.appendChild(messageDiv);

    if (shouldScroll) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }
}

// Connect WebSocket on page load
document.addEventListener('DOMContentLoaded', connectWebSocket);

// ============ VOICE (Cloudflare Calls) ============

// Speaking state tracking for UI indicators
const speakingUsers = new Set();

/**
 * Handle speaking state changes from the voice module.
 * Updates speaker cards with speaking glow indicator.
 */
function handleSpeakingChange(username, isSpeaking) {
    if (isSpeaking) {
        speakingUsers.add(username);
    } else {
        speakingUsers.delete(username);
    }

    // Update speaker cards UI
    document.querySelectorAll('.speaker-card').forEach(card => {
        const nameEl = card.querySelector('.speaker-name');
        if (nameEl?.textContent === username) {
            card.classList.toggle('speaking', isSpeaking);
        }
    });

    // Update mini player speakers
    document.querySelectorAll('.mini-speaker').forEach(el => {
        if (el.dataset.username === username) {
            el.classList.toggle('speaking', isSpeaking);
        }
    });
}

/**
 * Connect to voice room for a net.
 */
async function connectToVoiceRoom(netId, role) {
    if (!voiceEnabled) {
        // Re-check — initial async check may not have completed yet
        voiceEnabled = await checkVoiceConfig();
    }
    if (!voiceEnabled) {
        console.log('Voice not available');
        return false;
    }

    try {
        const success = await joinVoiceRoom(
            netId,
            currentUser,
            role,
            handleSpeakingChange, // speaking callback
            null // track added callback
        );

        if (success) {
            showToast('AUDIO_CONNECTED');
        }
        return success;
    } catch (err) {
        console.error('Voice connection error:', err);
        showToast('Audio connection failed');
        return false;
    }
}

/**
 * Disconnect from voice room.
 */
async function disconnectVoiceRoom() {
    await leaveVoiceRoom();
    speakingUsers.clear();
}

// Load all live nets
async function loadNets() {
    try {
        const nets = await api('/api/nets?status=live');
        const container = document.getElementById('nets-container');

        if (nets.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; color: #666; padding: 30px;">
                    <div style="font-size: 24px; margin-bottom: 10px;">📻</div>
                    <div>No live nets right now</div>
                    <div style="font-size: 10px; margin-top: 5px;">Be the first to start one!</div>
                </div>
            `;
            return;
        }

        container.innerHTML = nets.map(net => `
            <div class="net-item" onclick="joinNet(${net.id})">
                <span class="net-item-live">●</span>
                <div class="net-item-info">
                    <div class="net-item-name">${net.name}</div>
                    <div class="net-item-host">Host: ${net.host_username}</div>
                </div>
                <div class="net-item-stats">
                    <div class="net-item-count">${net.participant_count}</div>
                    <div>listening</div>
                    <div style="margin-top: 5px;">${net.speaker_count} speakers</div>
                </div>
            </div>
        `).join('');
    } catch (err) {
        console.error('Error loading nets:', err);
    }
}

// Also update the overview stages section to show nets
async function loadNetsInOverview() {
    try {
        const nets = await api('/api/nets?status=live');
        const stagesContainer = document.querySelector('.live-stages');

        if (!stagesContainer) return;

        // Clear and rebuild (avoid innerHTML += which destroys event handlers)
        stagesContainer.innerHTML = '';

        const header = document.createElement('div');
        header.style.cssText = 'font-weight: bold; margin-bottom: 15px; color: #00ff41;';
        header.textContent = 'LIVE_NETS';
        stagesContainer.appendChild(header);

        if (nets.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.style.cssText = 'text-align: center; color: #666; padding: 20px;';
            emptyMsg.innerHTML = '<div>No live nets</div>';
            stagesContainer.appendChild(emptyMsg);
        } else {
            nets.slice(0, 4).forEach(net => {
                const stageItem = document.createElement('div');
                stageItem.className = 'stage-item';
                stageItem.style.cursor = 'pointer';
                stageItem.onclick = () => joinNet(net.id);
                stageItem.innerHTML = `
                    <span class="live-indicator">●</span>
                    <span>${net.name}</span>
                    <span class="stage-listeners">${net.participant_count}</span>
                `;
                stagesContainer.appendChild(stageItem);
            });
        }

        // Add button as DOM element to preserve event handlers
        const buttonContainer = document.createElement('div');
        buttonContainer.style.marginTop = '15px';
        const startButton = document.createElement('button');
        startButton.className = 'btn-primary';
        startButton.style.cssText = 'font-size: 10px; padding: 8px;';
        startButton.textContent = '+ START_NET';
        startButton.onclick = showCreateNetModal;
        buttonContainer.appendChild(startButton);
        stagesContainer.appendChild(buttonContainer);
    } catch (err) {
        console.error('Error loading nets in overview:', err);
    }
}

// Show create net modal
function showCreateNetModal() {
    document.getElementById('create-net-modal').classList.add('show');
    document.getElementById('new-net-name').focus();
}

// Close create net modal
function closeCreateNetModal(event) {
    if (!event || event.target.id === 'create-net-modal') {
        document.getElementById('create-net-modal').classList.remove('show');
        document.getElementById('new-net-name').value = '';
        document.getElementById('new-net-description').value = '';
    }
}

// Create a new net
async function createNet() {
    if (!currentUser) return;

    const name = document.getElementById('new-net-name').value.trim().toUpperCase().replace(/\s+/g, '_');
    const description = document.getElementById('new-net-description').value.trim();

    if (!name) {
        showToast('Please enter a net name');
        return;
    }

    try {
        const net = await api('/api/nets', {
            method: 'POST',
            body: JSON.stringify({ userId: currentUser.id, name, description })
        });

        closeCreateNetModal();
        showToast('NET_CREATED! You are now LIVE');
        await joinNet(net.id);
        await loadNets();
        await loadNetsInOverview();
    } catch (err) {
        showToast('Error creating net');
    }
}

// Join a net
async function joinNet(netId) {
    if (!currentUser) return;

    try {
        await api(`/api/nets/${netId}/join`, {
            method: 'POST',
            body: JSON.stringify({ userId: currentUser.id })
        });

        currentNetId = netId;
        await loadNetRoom();
        document.getElementById('net-popup').classList.add('show');

        // Subscribe to WebSocket updates for this net
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'subscribe', netId: currentNetId }));
            console.log('Subscribed to WebSocket updates for net', currentNetId);
        }

        // Connect to Cloudflare voice room
        const myParticipant = (await api(`/api/nets/${netId}`)).participants?.find(p => p.user_id === currentUser.id);
        const myRole = myParticipant?.role || 'listener';
        await connectToVoiceRoom(netId, myRole);

        // Keep chat polling as fallback (reduced frequency since WebSocket handles it)
        netChatRefreshInterval = setInterval(loadNetChat, 30000);
        // Keep room state polling as fallback in case WebSocket drops
        netRefreshInterval = setInterval(loadNetRoom, 10000);

    } catch (err) {
        showToast('Error joining net');
    }
}

// Track previous role for token refresh
let previousNetRole = null;

// Load net room data
async function loadNetRoom() {
    if (!currentNetId) return;

    try {
        const net = await api(`/api/nets/${currentNetId}`);
        currentNetData = net;

        // Update header
        document.getElementById('net-room-name').textContent = net.name;
        document.getElementById('net-room-host').textContent = `Hosted by: ${net.host_username}`;

        // Get current user's role
        const myParticipant = net.participants.find(p => p.user_id === currentUser.id);
        const myRole = myParticipant?.role || 'listener';
        const isHost = myRole === 'host' || myRole === 'co-host';

        // Check if role upgraded to speaker - voice module handles promotion via WebSocket
        previousNetRole = myRole;

        // Render speakers (Clubhouse-style: prominent cards with speaking glow)
        const speakers = net.participants.filter(p => ['host', 'co-host', 'speaker'].includes(p.role));
        const speakersGrid = document.getElementById('speakers-grid');
        speakersGrid.innerHTML = speakers.map(speaker => {
            const isSpeakingNow = speakingUsers.has(speaker.username);
            return `
            <div class="speaker-card ${speaker.role}${isSpeakingNow ? ' speaking' : ''}${speaker.is_muted ? ' muted' : ''}">
                <div class="speaker-avatar-ring${isSpeakingNow ? ' active' : ''}">
                    <div class="speaker-avatar">${speaker.username.charAt(0)}</div>
                </div>
                ${speaker.is_muted ? '<span class="speaker-muted-badge">MIC OFF</span>' : ''}
                <div class="speaker-name">${speaker.username}</div>
                <div class="speaker-role">${speaker.role.toUpperCase()}</div>
                ${isHost && speaker.role === 'speaker' ? `
                    <button class="request-btn deny" style="margin-top: 5px;" onclick="demoteSpeaker(${speaker.user_id})">DEMOTE</button>
                ` : ''}
            </div>
        `}).join('');

        // Render listeners (Clubhouse-style: smaller avatars in a row)
        const listeners = net.participants.filter(p => p.role === 'listener');
        document.getElementById('listeners-count').textContent = `LISTENERS: ${listeners.length}`;
        document.getElementById('listeners-list').innerHTML = listeners.map(listener => `
            <div class="listener-avatar" title="${listener.username}">
                <div class="listener-avatar-circle">${listener.username.charAt(0)}</div>
                <div class="listener-name">${listener.username}</div>
            </div>
        `).join('');

        // Render speak requests (for hosts only)
        const requestsPanel = document.getElementById('requests-panel');
        if (isHost && net.pendingRequests?.length > 0) {
            requestsPanel.classList.remove('hidden');
            document.getElementById('requests-list').innerHTML = net.pendingRequests.map(req => `
                <div class="request-item">
                    <span>${req.username} wants to speak</span>
                    <div class="request-actions">
                        <button class="request-btn approve" onclick="approveSpeaker(${req.id}, ${req.user_id})">APPROVE</button>
                        <button class="request-btn deny" onclick="denySpeaker(${req.id})">DENY</button>
                    </div>
                </div>
            `).join('');
        } else {
            requestsPanel.classList.add('hidden');
        }

        // Render controls based on role
        renderNetControls(myRole, myParticipant?.is_muted);

        // Also update mini player if it's visible
        if (document.getElementById('net-mini-player').classList.contains('show')) {
            updateMiniPlayer();
        }

    } catch (err) {
        console.error('Error loading net room:', err);
    }
}

// Render net controls based on user role
function renderNetControls(role, isMuted) {
    const controls = document.getElementById('net-controls');
    let html = '';

    if (role === 'host' || role === 'co-host') {
        html += `
            <button class="net-control-btn ${isMuted ? 'unmute' : 'mute'}" onclick="toggleMute()">
                ${isMuted ? '🎤 UNMUTE' : '🔇 MUTE'}
            </button>
            <button class="net-control-btn danger" onclick="endNet()">END_NET</button>
        `;
    } else if (role === 'speaker') {
        html += `
            <button class="net-control-btn ${isMuted ? 'unmute' : 'mute'}" onclick="toggleMute()">
                ${isMuted ? '🎤 UNMUTE' : '🔇 MUTE'}
            </button>
        `;
    } else {
        html += `
            <button class="net-control-btn request" onclick="requestToSpeak()">✋ REQUEST_TO_SPEAK</button>
        `;
    }

    html += `<button class="net-control-btn" onclick="leaveNet()">LEAVE_NET</button>`;
    controls.innerHTML = html;
}

// Load net chat messages
async function loadNetChat() {
    if (!currentNetId) return;

    try {
        const messages = await api(`/api/nets/${currentNetId}/messages`);
        const chatContainer = document.getElementById('net-chat-messages');
        const shouldScroll = chatContainer.scrollTop + chatContainer.clientHeight >= chatContainer.scrollHeight - 50;

        chatContainer.innerHTML = messages.map(msg => {
            const time = new Date(msg.timestamp);
            const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
            return `
                <div class="message" style="margin-bottom: 8px;">
                    <span style="color: #ffaa00;">${msg.username}</span>
                    <span style="color: #666; font-size: 9px;">[${timeStr}]</span>
                    <div>${msg.content}</div>
                </div>
            `;
        }).join('');

        if (shouldScroll) {
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }
    } catch (err) {
        console.error('Error loading net chat:', err);
    }
}

// Send net chat message
async function sendNetMessage() {
    if (!currentNetId || !currentUser) return;

    const input = document.getElementById('net-chat-input');
    const content = input.value.trim();
    if (!content) return;

    try {
        await api(`/api/nets/${currentNetId}/messages`, {
            method: 'POST',
            body: JSON.stringify({ userId: currentUser.id, content })
        });
        input.value = '';
        await loadNetChat();
    } catch (err) {
        showToast('Error sending message');
    }
}

// Toggle mute (for speakers)
async function toggleMute() {
    if (!currentNetId || !currentUser) return;

    try {
        const result = await api(`/api/nets/${currentNetId}/toggle-mute`, {
            method: 'POST',
            body: JSON.stringify({ userId: currentUser.id })
        });

        console.log('Mute toggle result:', result.is_muted);

        // Toggle actual microphone via voice module
        toggleMuteState();

        await loadNetRoom();
    } catch (err) {
        console.error('Error toggling mute:', err);
        showToast('Error toggling mute');
    }
}

// Request to speak
async function requestToSpeak() {
    if (!currentNetId || !currentUser) return;

    try {
        const result = await api(`/api/nets/${currentNetId}/request-speak`, {
            method: 'POST',
            body: JSON.stringify({ userId: currentUser.id })
        });
        showToast(result.message || 'Request sent to host');
    } catch (err) {
        showToast('Error requesting to speak');
    }
}

// Approve speaker (host only)
async function approveSpeaker(requestId, targetUserId) {
    if (!currentNetId || !currentUser) return;

    try {
        const result = await api(`/api/nets/${currentNetId}/approve-speaker`, {
            method: 'POST',
            body: JSON.stringify({ userId: currentUser.id, targetUserId, requestId })
        });

        if (result.error) {
            showToast(result.error);
        } else {
            showToast('Speaker approved');
            await loadNetRoom();
        }
    } catch (err) {
        showToast('Error approving speaker');
    }
}

// Deny speaker (host only)
async function denySpeaker(requestId) {
    if (!currentNetId || !currentUser) return;

    try {
        await api(`/api/nets/${currentNetId}/deny-speaker`, {
            method: 'POST',
            body: JSON.stringify({ userId: currentUser.id, requestId })
        });
        showToast('Request denied');
        await loadNetRoom();
    } catch (err) {
        showToast('Error denying speaker');
    }
}

// Demote speaker back to listener (host only)
async function demoteSpeaker(targetUserId) {
    if (!currentNetId || !currentUser) return;

    try {
        await api(`/api/nets/${currentNetId}/demote-speaker`, {
            method: 'POST',
            body: JSON.stringify({ userId: currentUser.id, targetUserId })
        });
        showToast('Speaker demoted to listener');
        await loadNetRoom();
    } catch (err) {
        showToast('Error demoting speaker');
    }
}

// Leave net
async function leaveNet() {
    if (!currentNetId || !currentUser) return;

    try {
        await api(`/api/nets/${currentNetId}/leave`, {
            method: 'POST',
            body: JSON.stringify({ userId: currentUser.id })
        });
        closeNetRoom();
        showToast('Left the net');
        await loadNets();
        await loadNetsInOverview();
    } catch (err) {
        showToast('Error leaving net');
    }
}

// End net (host only)
async function endNet() {
    if (!currentNetId || !currentUser) return;

    const confirmed = await showTerminalConfirm('Are you sure you want to end this net? All participants will be disconnected.');
    if (!confirmed) return;

    try {
        await api(`/api/nets/${currentNetId}/end`, {
            method: 'POST',
            body: JSON.stringify({ userId: currentUser.id })
        });
        closeNetRoom();
        showToast('Net ended');
        await loadNets();
        await loadNetsInOverview();
    } catch (err) {
        showToast('Error ending net');
    }
}

// Close net room popup
function closeNetRoom() {
    document.getElementById('net-popup').classList.remove('show');
    document.getElementById('net-mini-player').classList.remove('show');

    // Unsubscribe from WebSocket updates
    if (ws && ws.readyState === WebSocket.OPEN && currentNetId) {
        ws.send(JSON.stringify({ type: 'unsubscribe' }));
        console.log('Unsubscribed from WebSocket updates');
    }

    currentNetId = null;
    currentNetData = null;
    previousNetRole = null;

    // Disconnect from voice room
    disconnectVoiceRoom();

    // Clear intervals
    if (netRefreshInterval) {
        clearInterval(netRefreshInterval);
        netRefreshInterval = null;
    }
    if (netChatRefreshInterval) {
        clearInterval(netChatRefreshInterval);
        netChatRefreshInterval = null;
    }
}

// Minimize net to mini player
function minimizeNet() {
    if (!currentNetData) return;

    // Hide full popup
    document.getElementById('net-popup').classList.remove('show');

    // Update and show mini player
    document.getElementById('mini-player-name').textContent = currentNetData.name;
    updateMiniPlayer();
    document.getElementById('net-mini-player').classList.add('show');

    showToast('Net minimized - tap to expand');
}

// Expand from mini player to full popup
function expandNet() {
    document.getElementById('net-mini-player').classList.remove('show');
    document.getElementById('net-popup').classList.add('show');
}

// Update mini player display
function updateMiniPlayer() {
    if (!currentNetData) return;

    const speakers = currentNetData.participants?.filter(p =>
        ['host', 'co-host', 'speaker'].includes(p.role)
    ) || [];
    const listeners = currentNetData.participants?.filter(p => p.role === 'listener') || [];

    // Update speakers display with speaking indicators
    const speakersEl = document.getElementById('mini-player-speakers');
    speakersEl.innerHTML = speakers.slice(0, 4).map(s => {
        const isSpeakingNow = speakingUsers.has(s.username);
        return `<span class="mini-speaker${isSpeakingNow ? ' speaking' : ''}" data-username="${s.username}">${s.is_muted ? '🔇' : '🎤'} ${s.username}</span>`;
    }).join('');

    if (speakers.length > 4) {
        speakersEl.innerHTML += `<span class="mini-speaker">+${speakers.length - 4}</span>`;
    }

    // Update stats
    document.getElementById('mini-player-stats').textContent =
        `${speakers.length} speaker${speakers.length !== 1 ? 's' : ''} · ${listeners.length} listener${listeners.length !== 1 ? 's' : ''}`;

    // Update mute button based on current user's state
    const myParticipant = currentNetData.participants?.find(p => p.user_id === currentUser?.id);
    const muteBtn = document.getElementById('mini-player-mute');

    if (myParticipant && ['host', 'co-host', 'speaker'].includes(myParticipant.role)) {
        muteBtn.style.display = 'block';
        if (myParticipant.is_muted) {
            muteBtn.className = 'mini-player-mute muted';
            muteBtn.textContent = '🎤 UNMUTE';
        } else {
            muteBtn.className = 'mini-player-mute unmuted';
            muteBtn.textContent = '🔇 MUTE';
        }
    } else {
        muteBtn.style.display = 'none';
    }
}

// Add enter key handler for net chat
document.addEventListener('DOMContentLoaded', function() {
    const netChatInput = document.getElementById('net-chat-input');
    if (netChatInput) {
        netChatInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                sendNetMessage();
            }
        });
    }
});

// Verification Flow Functions
function goToStep(stepNumber) {
    // Hide current step
    document.querySelectorAll('.verification-step').forEach(step => {
        step.classList.remove('active');
    });

    // Show new step
    document.getElementById(`step-${stepNumber}`).classList.add('active');
    currentStep = stepNumber;

    // Update progress
    const progress = (stepNumber / 4) * 100;
    document.getElementById('verification-progress').textContent = `STEP ${stepNumber}/4`;
    document.getElementById('progress-fill').style.width = `${progress}%`;
    document.getElementById('progress-fill').textContent = `${progress}%`;

    // Special handling for step 3 (face verification)
    if (stepNumber === 3) {
        setTimeout(() => {
            document.getElementById('start-face-capture').classList.remove('hidden');
        }, 500);
    }
}

// Cancel verification flow and return to login
async function cancelVerification() {
    // Use custom modal with clearer button labels
    const modal = document.getElementById('terminal-modal');
    const messageDiv = document.getElementById('terminal-modal-message');
    const buttonsDiv = document.getElementById('terminal-modal-buttons');

    const confirmPromise = new Promise((resolve) => {
        terminalModalResolve = resolve;
        messageDiv.textContent = 'Exit verification process? Your progress will be lost.';
        buttonsDiv.innerHTML = `
            <button onclick="closeTerminalModal(false)" style="padding: 8px 20px; background: rgba(0, 255, 65, 0.1); border: 1px solid #00ff41; color: #00ff41; cursor: pointer; font-family: 'JetBrains Mono', monospace; font-size: 11px;">STAY</button>
            <button onclick="closeTerminalModal(true)" style="padding: 8px 20px; background: rgba(255, 0, 0, 0.1); border: 1px solid #ff0000; color: #ff0000; cursor: pointer; font-family: 'JetBrains Mono', monospace; font-size: 11px;">EXIT</button>
        `;
        modal.style.display = 'flex';
    });

    const confirmed = await confirmPromise;
    if (!confirmed) return;

    // Reset to step 1
    currentStep = 1;
    document.querySelectorAll('.verification-step').forEach(step => {
        step.classList.remove('active');
    });
    document.getElementById('step-1').classList.add('active');

    // Reset progress
    document.getElementById('verification-progress').textContent = 'STEP 1/4';
    document.getElementById('progress-fill').style.width = '25%';
    document.getElementById('progress-fill').textContent = '25%';

    // Reset all verification data and UI state
    verificationData = { rank: null, name: null, badges: [], units: [] };

    // Reset file inputs
    document.getElementById('dd214-file').value = '';
    document.getElementById('license-file').value = '';

    // Hide status displays
    document.getElementById('dd214-status').classList.add('hidden');
    document.getElementById('license-status').classList.add('hidden');

    // Reset upload zones
    document.getElementById('dd214-upload-zone').classList.remove('has-file');
    document.getElementById('license-upload-zone').classList.remove('has-file');

    // Hide continue buttons
    document.getElementById('step-1-continue').classList.add('hidden');
    document.getElementById('step-2-continue').classList.add('hidden');

    // Stop any webcam stream if active
    if (window.currentStream) {
        window.currentStream.getTracks().forEach(track => track.stop());
        window.currentStream = null;
    }

    // Hide verification screen and show auth screen
    document.getElementById('verification-screen').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
}

// DD-214 Upload Handler
function handleDD214Upload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    document.getElementById('dd214-upload-zone').classList.add('has-file');
    document.getElementById('dd214-status').classList.remove('hidden');
    
    // Simulate OCR processing
    setTimeout(() => {
        document.getElementById('dd214-file-status').textContent = 'COMPLETE';
        document.getElementById('dd214-file-status').className = 'status-success';
        
        setTimeout(() => {
            document.getElementById('dd214-ocr-status').textContent = 'EXTRACTING...';
            document.getElementById('dd214-ocr-status').className = 'status-pending';
            
            setTimeout(() => {
                document.getElementById('dd214-ocr-status').textContent = 'COMPLETE';
                document.getElementById('dd214-ocr-status').className = 'status-success';
                
                // Mock extracted data
                verificationData.rank = 'O-3';
                verificationData.name = 'JAMES MARTINEZ';
                verificationData.badges = ['AIRBORNE', 'RANGER', 'CIB'];
                verificationData.units = ['82ND_AIRBORNE'];
                
                document.getElementById('dd214-rank-status').textContent = 'O-3 CAPTAIN (OFFICER)';
                document.getElementById('dd214-rank-status').className = 'status-success';
                
                setTimeout(() => {
                    document.getElementById('dd214-discharge-status').textContent = 'HONORABLE';
                    document.getElementById('dd214-discharge-status').className = 'status-success';
                    
                    document.getElementById('step-1-continue').classList.remove('hidden');
                }, 800);
            }, 1500);
        }, 800);
    }, 1000);
}

// Driver's License Upload Handler
function handleDLUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    document.getElementById('dl-upload-zone').classList.add('has-file');
    document.getElementById('dl-status').classList.remove('hidden');
    
    // Simulate processing
    setTimeout(() => {
        document.getElementById('dl-file-status').textContent = 'COMPLETE';
        document.getElementById('dl-file-status').className = 'status-success';
        
        setTimeout(() => {
            document.getElementById('dl-name-status').textContent = 'EXTRACTING...';
            document.getElementById('dl-name-status').className = 'status-pending';
            
            setTimeout(() => {
                document.getElementById('dl-name-status').textContent = 'JAMES R MARTINEZ';
                document.getElementById('dl-name-status').className = 'status-success';
                
                setTimeout(() => {
                    document.getElementById('dl-match-status').textContent = 'VERIFIED (98% MATCH)';
                    document.getElementById('dl-match-status').className = 'status-success';
                    
                    setTimeout(() => {
                        document.getElementById('dl-photo-status').textContent = 'COMPLETE';
                        document.getElementById('dl-photo-status').className = 'status-success';
                        
                        document.getElementById('step-2-continue').classList.remove('hidden');
                    }, 800);
                }, 1000);
            }, 1500);
        }, 800);
    }, 1000);
}

// Face Verification
async function startFaceVerification() {
    document.getElementById('start-face-capture').classList.add('hidden');
    document.getElementById('face-status').classList.remove('hidden');
    
    try {
        // Request camera access
        webcamStream = await navigator.mediaDevices.getUserMedia({ video: true });
        document.getElementById('webcam-video').srcObject = webcamStream;
        
        document.getElementById('face-camera-status').textContent = 'GRANTED';
        document.getElementById('face-camera-status').className = 'status-success';
        document.getElementById('liveness-instructions').textContent = 'POSITION YOUR FACE IN THE CENTER...';
        document.getElementById('liveness-instructions').style.color = '#ffaa00';
        
        // Simulate face detection
        setTimeout(() => {
            document.getElementById('face-detect-status').textContent = 'FACE DETECTED';
            document.getElementById('face-detect-status').className = 'status-success';
            document.getElementById('liveness-instructions').textContent = 'PLEASE BLINK...';
            
            setTimeout(() => {
                document.getElementById('face-liveness-status').textContent = 'BLINK DETECTED';
                document.getElementById('face-liveness-status').className = 'status-success';
                document.getElementById('liveness-instructions').textContent = 'TURN YOUR HEAD LEFT...';
                
                setTimeout(() => {
                    document.getElementById('liveness-instructions').textContent = 'TURN YOUR HEAD RIGHT...';
                    
                    setTimeout(() => {
                        document.getElementById('face-liveness-status').textContent = 'LIVENESS VERIFIED';
                        document.getElementById('liveness-instructions').textContent = 'COMPARING WITH DRIVER\'S LICENSE...';
                        
                        setTimeout(() => {
                            document.getElementById('face-match-status').textContent = 'MATCH CONFIRMED (94%)';
                            document.getElementById('face-match-status').className = 'status-success';
                            document.getElementById('liveness-instructions').textContent = 'VERIFICATION COMPLETE!';
                            document.getElementById('liveness-instructions').style.color = '#00ff41';
                            
                            // Stop webcam
                            if (webcamStream) {
                                webcamStream.getTracks().forEach(track => track.stop());
                            }
                            
                            document.getElementById('step-3-continue').classList.remove('hidden');
                        }, 2000);
                    }, 1500);
                }, 1500);
            }, 2000);
        }, 2000);
        
    } catch (error) {
        document.getElementById('face-camera-status').textContent = 'DENIED';
        document.getElementById('face-camera-status').className = 'status-error';
        document.getElementById('liveness-instructions').textContent = 'CAMERA ACCESS REQUIRED';
        document.getElementById('liveness-instructions').style.color = '#ff0000';
    }
}

// Complete Verification
function completeVerification() {
    // Update final display
    document.getElementById('final-rank').textContent = verificationData.rank + ' CAPTAIN';
    document.getElementById('final-badges').textContent = verificationData.badges.join(', ');
    document.getElementById('final-units').textContent = verificationData.units.join(', ');
    
    // Transition to main app
    setTimeout(() => {
        document.getElementById('verification-screen').classList.add('hidden');
        document.getElementById('main-app').classList.add('active');
        
        // Update profile with verified data
        document.getElementById('profile-rank').textContent = verificationData.rank + ' CAPTAIN';
        document.getElementById('profile-unit').textContent = verificationData.units[0].replace('_', ' ');
        document.getElementById('user-leaderboard-unit').textContent = verificationData.units[0];
        
        // Update badges
        const badgesHtml = verificationData.badges.map(badge => 
            `<div class="badge">${badge}</div>`
        ).join('');
        document.getElementById('profile-badges').innerHTML = badgesHtml;
    }, 1000);
}

// Main App Functions
function showSection(sectionName) {
    const sections = document.querySelectorAll('.section');
    sections.forEach(section => section.classList.remove('active'));

    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(tab => tab.classList.remove('active'));

    document.getElementById(sectionName).classList.add('active');
    event.target.classList.add('active');
}

function showProfile() {
    document.getElementById('profile-popup').classList.add('show');
}

function closeProfile(event) {
    if (!event || event.target.id === 'profile-popup' || event.target.classList.contains('profile-close')) {
        document.getElementById('profile-popup').classList.remove('show');
    }
}

document.addEventListener('DOMContentLoaded', function() {
    const messageInput = document.getElementById('message-input');
    if (messageInput) {
        messageInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                sendMessage();
            }
        });
    }

    // Close context menu on scroll
    const chatMessages = document.getElementById('chat-messages');
    if (chatMessages) {
        chatMessages.addEventListener('scroll', closeContextMenu);
    }

    // Close context menu on Escape key
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            closeContextMenu();
        }
    });
});

setInterval(function() {
    const now = new Date();
    const timeStr = now.toISOString().substr(8, 2) + 'AUG25_' +
                   now.toISOString().substr(11, 2) +
                   now.toISOString().substr(14, 2) + 'Z';

    const systemInfo = document.querySelector('.system-info');
    if (systemInfo) {
        systemInfo.innerHTML = `SYSTEM_STATUS: OPERATIONAL | PING: ${Math.floor(Math.random() * 30 + 20)}ms | LAST_SYNC: ${timeStr}`;
    }
}, 30000);

// Expose functions to global scope for inline HTML event handlers
Object.assign(window, {
    cancelImage, cancelReply, cancelVerification,
    closeCreateChannelModal, closeCreateNetModal, closeNetRoom,
    closeNewDMModal, closeProfile, closeTerminalModal,
    completeVerification, contextMenuCopyText, contextMenuReact,
    contextMenuReply, copyInviteCode, createChannel, createNet,
    expandNet, generateInvite, goToStep, handleDLUpload,
    handleImageSelect, handleLogin, joinNet, logout,
    minimizeNet, searchUsers, sendMessage, sendNetMessage,
    shareInvite, showCreateNetModal, showLogin, showProfile,
    showSection, showSignup, startFaceVerification,
    startVerification, switchChannel, toggleMute, leaveNet,
    endNet, requestToSpeak, approveSpeaker, denySpeaker, demoteSpeaker,
    handleDD214Upload,
    // CDP wallet auth
    handleWalletLogin, handleVerifyOTP, handleGoogleLogin,
    showWalletLogin, showLegacyLogin,
});
