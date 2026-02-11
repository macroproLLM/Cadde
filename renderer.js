const { ipcRenderer } = require('electron');
const io = require('socket.io-client');
const Peer = require('simple-peer');

// --- Configurable Server URL ---
// const SERVER_URL = 'http://localhost:3000';
const SERVER_URL = 'https://cadde.onrender.com'; // Production URL

let socket;
let myNickname = '';
let myRoomId = '';
let currentChannel = null;
let ownerId = null; // Track who is the owner

// Audio Globals
let hardwareStream = null; // The raw mic stream
let localStream = null;    // The stream sent to peers (possibly processed)
let audioContext;
let analyzer;
let isSpeaking = false;

// Audio States
let isMuted = false;
let isDeaf = false;
let isNoiseSuppressionEnabled = false; // ANC State

let devices = { input: [], output: [] };
let selectedInput = 'default';
let selectedOutput = 'default';

// peers[socketId] = Peer instance
const peers = {};
const remoteStreams = {}; // Keep track for deafen logic

// UI Elements
const root = document.getElementById('root');

function setupWindowControls() {
    const minBtn = document.getElementById('min-btn');
    const maxBtn = document.getElementById('max-btn');
    const closeBtn = document.getElementById('close-btn');

    if (minBtn) minBtn.onclick = () => ipcRenderer.send('window-minimize');
    if (maxBtn) maxBtn.onclick = () => ipcRenderer.send('window-maximize');
    if (closeBtn) closeBtn.onclick = () => ipcRenderer.send('window-close');
}

function showLogin() {
    root.innerHTML = `
        <div class="title-bar">
            <div class="title-bar-drag">GhostChat</div>
            <div class="window-controls">
                <div class="control-btn" id="min-btn">－</div>
                <div class="control-btn" id="max-btn">▢</div>
                <div class="control-btn close" id="close-btn">✕</div>
            </div>
        </div>
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: calc(100% - 32px);">
            <div style="background: var(--bg-sidebar); padding: 40px; border-radius: 12px; width: 440px; box-shadow: 0 10px 30px rgba(0,0,0,0.3);">
                <h1 style="text-align: center; margin-bottom: 8px; font-size: 24px;">GhostChat</h1>
                <p style="text-align: center; color: var(--text-muted); margin-bottom: 32px; font-size: 14px;">Arkadaşlarınla konuşmaya hazır mısın?</p>
                
                <div class="input-group" style="margin-bottom: 20px;">
                    <label class="input-label">Takma Ad</label>
                    <input type="text" id="nickname-input" style="width: 100%; padding: 12px;" placeholder="Nasıl görünmek istersin?">
                </div>
                
                <div class="input-group" style="margin-bottom: 32px;">
                    <label class="input-label">Oda Kodu</label>
                    <input type="text" id="room-input" style="width: 100%; padding: 12px;" placeholder="Oda kodu girin...">
                </div>
                
                <button id="join-btn" class="btn-primary" style="width: 100%; padding: 14px; font-size: 16px; border: none; border-radius: 6px; background-color: var(--bg-accent); color: white; cursor: pointer; transition: background 0.2s;">Giriş Yap</button>
            </div>
        </div>
    `;

    setupWindowControls();

    document.getElementById('join-btn').onclick = () => {
        const nick = document.getElementById('nickname-input').value;
        const code = document.getElementById('room-input').value;
        if (nick && code) {
            myNickname = nick;
            myRoomId = code;
            initApp();
        } else {
            alert('Lütfen tüm alanları doldurun!');
        }
    };
}

async function initApp() {
    await updateDeviceList();
    await startLocalAudio();

    socket = io(SERVER_URL);

    socket.on('connect', () => {
        socket.emit('join-room', { roomId: myRoomId, nickname: myNickname });
        renderMainView();
    });

    socket.on('init-room-state', (state) => {
        // state: { users, channels, ownerId }
        ownerId = state.ownerId;
        renderChannels(state.channels, state.users);
        refreshUserLists(state.users);
        updateOwnerControls();
    });

    socket.on('new-message', addMessage);
    socket.on('user-list-update', (users) => {
        refreshUserLists(users);
        // We also need to re-render channels to show users moving between them
        // To do this efficiently, we might need the current channel list.
        // For simplicity, we can ask for state again or store channels locally.
        // Let's rely on init-room-state for channel updates, but for users moving, we need to know channels.
        // Limitation: If we only get users, we can't re-render channels if we don't have the channel list variable.
        // Solved: we will store channels in a global var or just extract from DOM? 
        // Better: let's request full sync or store `currentAllChannels` global.
        if (currentAllChannels.length > 0) {
            renderChannels(currentAllChannels, users);
        }
    });

    socket.on('voice-state-update', handleVoiceStateUpdate);

    socket.on('signal', ({ from, signal }) => {
        if (!peers[from]) {
            peers[from] = createPeer(from, false);
        }
        peers[from].signal(signal);
    });

    socket.on('user-disconnected', (id) => {
        removePeer(id);
    });

    socket.on('kicked', () => {
        alert('Bu odadan atıldınız!');
        window.location.reload();
    });
}

function renderMainView() {
    root.innerHTML = `
        <div class="title-bar">
            <div class="title-bar-drag">GhostChat - #${myRoomId}</div>
            <div class="window-controls">
                <div class="control-btn" id="min-btn">－</div>
                <div class="control-btn" id="max-btn">▢</div>
                <div class="control-btn close" id="close-btn">✕</div>
            </div>
        </div>
        <div class="app-container">
            <!-- Sidebar Left: Channels -->
            <div class="sidebar sidebar-left">
                <div class="sidebar-header">GhostChat</div>
                <div class="sidebar-content">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding-right: 8px;">
                        <div class="sidebar-label">SESLİ KANALLAR</div>
                        <div id="add-channel-btn" style="cursor: pointer; font-size: 16px; color: var(--text-muted); display: none;">+</div>
                    </div>
                    <div id="channel-list"></div>
                </div>
                
                <!-- Bottom Panel -->
                <div class="user-panel">
                    <div class="avatar" id="me-avatar">${myNickname[0].toUpperCase()}</div>
                    <div style="flex: 1; min-width: 0;">
                        <div style="font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${myNickname}</div>
                        <div style="font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 4px;">
                            <div id="self-status" class="status-indicator"></div>
                            <span id="self-status-text">Seste Değil</span>
                        </div>
                    </div>
                    <div class="panel-controls">
                         <button class="icon-btn ${isNoiseSuppressionEnabled ? 'active-anc' : ''}" id="anc-toggle-btn" title="Gürültü Engelleme (ANC)">⚡</button>
                        <button class="icon-btn" id="mute-toggle" title="Mikrofonu Kapat">🎤</button>
                        <button class="icon-btn" id="deafen-toggle" title="Sesleri Kapat">🎧</button>
                        <button class="icon-btn" id="settings-btn" title="Ayarlar">⚙️</button>
                    </div>
                </div>
                
                <!-- Connection Panel (Appears when in voice) -->
                <div id="voice-control-panel" style="display: none; height: 40px; background: #1e1f22; border-top: 1px solid var(--border); padding: 0 12px; display: flex; align-items: center; justify-content: space-between;">
                    <div style="color: var(--success); font-size: 11px; font-weight: 700;">BAĞLANDI</div>
                    <button class="icon-btn disconnect" id="voice-disconnect" title="Bağlantıyı Kes" style="font-size: 20px;">📞</button>
                </div>
            </div>
            
            <!-- Center: Chat -->
            <div class="main-content">
                <div id="messages-container"></div>
                <div class="chat-input-wrapper">
                    <div class="chat-input-container">
                        <input type="text" id="chat-input" placeholder="#kanalına mesaj gönder">
                    </div>
                </div>
            </div>
            
            <!-- Sidebar Right: Members -->
            <div class="sidebar sidebar-right">
                <div class="sidebar-header">Kişiler</div>
                <div class="sidebar-content">
                    <div class="sidebar-label">ÇEVRİMİÇİ — <span id="member-count">0</span></div>
                    <div id="member-list"></div>
                </div>
            </div>
        </div>
    `;

    setupWindowControls();
    setupMainControls();
    updateVoiceUI();
}

function setupMainControls() {
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.onkeydown = (e) => {
            if (e.key === 'Enter' && chatInput.value.trim()) {
                socket.emit('send-message', {
                    roomId: myRoomId,
                    nickname: myNickname,
                    message: chatInput.value
                });
                chatInput.value = '';
            }
        };
    }

    document.getElementById('settings-btn').onclick = showSettings;
    document.getElementById('anc-toggle-btn').onclick = toggleNoiseSuppression;
    document.getElementById('mute-toggle').onclick = toggleMute;
    document.getElementById('deafen-toggle').onclick = toggleDeafen;
    document.getElementById('voice-disconnect').onclick = leaveVoice;

    // Add Channel Button Logic
    document.getElementById('add-channel-btn').onclick = () => {
        const name = prompt("Kanal Adı:");
        if (name) {
            socket.emit('create-channel', { roomId: myRoomId, channelName: name });
        }
    };

    // Close context menu on click elsewhere
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('ctx-menu');
        if (menu) menu.remove();
    });
}

function updateOwnerControls() {
    const btn = document.getElementById('add-channel-btn');
    if (btn) {
        btn.style.display = (socket?.id === ownerId || ownerId === socket?.id) ? 'block' : 'none';
    }
}

// --- Voice Control Actions ---

async function toggleNoiseSuppression() {
    isNoiseSuppressionEnabled = !isNoiseSuppressionEnabled;
    const btn = document.getElementById('anc-toggle-btn');
    if (btn) {
        btn.classList.toggle('active-anc', isNoiseSuppressionEnabled);
        // Visual feedback
        btn.style.transform = "scale(0.9)";
        setTimeout(() => btn.style.transform = "scale(1)", 100);
    }

    // Also update settings modal if open
    const modalToggle = document.getElementById('anc-toggle');
    if (modalToggle) {
        modalToggle.classList.toggle('active', isNoiseSuppressionEnabled);
    }

    await startLocalAudio(); // Apply changes

    // Refresh peers with new track
    if (localStream) {
        const newTrack = localStream.getAudioTracks()[0];
        Object.values(peers).forEach(peer => {
            if (peer.streams[0]) {
                const oldTrack = peer.streams[0].getAudioTracks()[0];
                if (oldTrack && newTrack) {
                    peer.replaceTrack(oldTrack, newTrack, peer.streams[0]);
                }
            }
        });
    }
}

function toggleMute() {
    isMuted = !isMuted;
    const btn = document.getElementById('mute-toggle');
    if (localStream) {
        localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
    }
    btn.innerText = isMuted ? '🔇' : '🎤';
    btn.classList.toggle('active', isMuted);
}

function toggleDeafen() {
    isDeaf = !isDeaf;
    const btn = document.getElementById('deafen-toggle');

    Object.keys(remoteStreams).forEach(id => {
        remoteStreams[id].muted = isDeaf;
    });

    if (isDeaf && !isMuted) toggleMute();
    else if (!isDeaf && isMuted) toggleMute();

    btn.innerText = isDeaf ? '🔇' : '🎧';
    btn.classList.toggle('active', isDeaf);
}

function leaveVoice() {
    if (!currentChannel) return;

    Object.keys(peers).forEach(removePeer);

    currentChannel = null;
    socket.emit('join-channel', { roomId: myRoomId, channelName: null });

    updateVoiceUI();
}

function updateVoiceUI() {
    const vPanel = document.getElementById('voice-control-panel');
    const statusText = document.getElementById('self-status-text');
    const statusIndicator = document.getElementById('self-status');

    if (!vPanel || !statusText) return;

    if (currentChannel) {
        vPanel.style.display = 'flex';
        statusText.innerText = currentChannel;
        statusIndicator.classList.add('connected');
    } else {
        vPanel.style.display = 'none';
        statusText.innerText = 'Seste Değil';
        statusIndicator.classList.remove('connected');
    }

    // Refresh channel list to update icons
    if (currentAllChannels.length > 0) {
        renderChannels(currentAllChannels, currentUsers);
    }
}

// --- List Refreshing ---

let currentAllChannels = [];
let currentUsers = [];

function renderChannels(channels, users = []) {
    currentAllChannels = channels;
    currentUsers = users;
    const list = document.getElementById('channel-list');
    if (!list) return;
    list.innerHTML = '';

    channels.forEach(ch => {
        const item = document.createElement('div');
        const isActive = currentChannel === ch;
        item.className = `list-item ${isActive ? 'active-channel' : ''}`;

        const icon = isActive ? '🔊' : '#';

        item.innerHTML = `
            <span style="width: 20px; text-align: center; font-size: ${isActive ? '16px' : '18px'}">${icon}</span> 
            <span>${ch}</span>
        `;

        // Left-click to join
        item.onclick = (e) => {
            e.stopPropagation();
            joinVoiceChannel(ch);
        };

        // Right-click context menu for channels (Owner)
        item.oncontextmenu = (e) => {
            if (socket.id === ownerId) {
                showContextMenu(e.clientX, e.clientY, [
                    { label: 'Kanalı Sil', action: () => socket.emit('delete-channel', { roomId: myRoomId, channelName: ch }), danger: true }
                ]);
            }
        };

        list.appendChild(item);

        // Render users INSIDE this channel
        const usersInChannel = users.filter(u => u.channel === ch);
        if (usersInChannel.length > 0) {
            const subList = document.createElement('div');
            subList.style.paddingLeft = '28px'; // Indent
            subList.style.marginBottom = '4px';

            usersInChannel.forEach(u => {
                const userItem = document.createElement('div');
                userItem.className = 'list-item channel-user';
                userItem.style.padding = '4px 8px';
                userItem.style.fontSize = '13px';
                userItem.innerHTML = `
                   <div class="avatar" style="width: 16px; height: 16px; font-size: 8px; margin-right: 8px;">${u.nickname[0].toUpperCase()}</div>
                   <span>${u.nickname}</span>
               `;

                // Prevent clicking user triggers join logic 
                userItem.onclick = (e) => e.stopPropagation();

                // Right-click on user (Owner)
                userItem.oncontextmenu = (e) => {
                    e.stopPropagation();
                    if (socket.id === ownerId && u.id !== socket.id) {
                        showContextMenu(e.clientX, e.clientY, [
                            { label: 'Odadan At', action: () => socket.emit('kick-user', { roomId: myRoomId, targetId: u.id }), danger: true }
                        ]);
                    }
                };

                subList.appendChild(userItem);
            });
            list.appendChild(subList);
        }
    });
}

function showContextMenu(x, y, options) {
    const existing = document.getElementById('ctx-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'ctx-menu';
    menu.style.position = 'fixed';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.backgroundColor = '#111215';
    menu.style.padding = '6px 8px';
    menu.style.borderRadius = '4px';
    menu.style.boxShadow = '0 8px 16px rgba(0,0,0,0.4)';
    menu.style.zIndex = '9999';
    menu.style.minWidth = '120px';

    options.forEach(opt => {
        const div = document.createElement('div');
        div.innerText = opt.label;
        div.style.padding = '8px 12px';
        div.style.fontSize = '13px';
        div.style.cursor = 'pointer';
        div.style.color = opt.danger ? '#da373c' : '#dbdee1';
        div.style.borderRadius = '2px';

        div.onmouseover = () => { div.style.backgroundColor = opt.danger ? '#da373c' : '#4752c4'; div.style.color = 'white'; };
        div.onmouseout = () => { div.style.backgroundColor = 'transparent'; div.style.color = opt.danger ? '#da373c' : '#dbdee1'; };

        div.onclick = () => {
            opt.action();
            menu.remove();
        };
        menu.appendChild(div);
    });

    document.body.appendChild(menu);
}

function refreshUserLists(users) {
    const memberList = document.getElementById('member-list');
    const memberCount = document.getElementById('member-count');
    if (!memberList) return;

    memberList.innerHTML = '';
    memberCount.innerText = users.length;

    users.forEach(user => {
        // Handle Peer creation if in same channel
        if (currentChannel && user.channel === currentChannel && user.id !== socket.id) {
            if (!peers[user.id]) {
                // Deterministic initiator: Only initiate if my ID is 'greater'
                if (socket.id > user.id) {
                    peers[user.id] = createPeer(user.id, true);
                }
            }
        }

        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = `
            <div class="avatar" id="avatar-${user.id}" style="width: 24px; height: 24px; font-size: 11px;">${user.nickname[0].toUpperCase()}</div>
            <div style="flex: 1; font-size: 14px;">${user.nickname}</div>
            <div id="status-${user.id}" class="status-indicator ${user.channel ? 'connected' : ''}"></div>
        `;
        memberList.appendChild(div);
    });
}

function joinVoiceChannel(channelName) {
    if (currentChannel === channelName) return;

    // Disconnect old peers
    Object.keys(peers).forEach(removePeer);

    currentChannel = channelName;
    socket.emit('join-channel', { roomId: myRoomId, channelName });
    playConnectionSound();
    updateVoiceUI();
}

function playConnectionSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.connect(gain);
        gain.connect(ctx.destination);

        // Nice "ding" sound
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);

        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);

        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.5);
    } catch (e) {
        console.error("Sound play failed", e);
    }
}

// --- Peer Logic ---

function createPeer(userId, initiator) {
    const streamToSend = localStream || hardwareStream;

    const peer = new Peer({
        initiator: initiator,
        trickle: true, // Enable trickle ICE for better connectivity
        stream: streamToSend,
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { urls: 'stun:stun4.l.google.com:19302' }
            ]
        }
    });

    peer.on('signal', (data) => {
        socket.emit('signal', { to: userId, from: socket.id, signal: data });
    });

    peer.on('connect', () => {
        console.log(`Peer connected: ${userId} - Connection established`);
    });

    peer.on('error', (err) => {
        console.error(`Peer error with ${userId}:`, err);
    });

    peer.on('stream', (stream) => {
        console.log(`Received stream from ${userId}`, stream);
        const audio = document.createElement('audio'); // Create element
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.playsInline = true; // For wider compatibility
        audio.muted = isDeaf;

        // Attach to DOM (hidden) to satisfy some browser autoplay policies
        audio.style.display = 'none';
        document.body.appendChild(audio);

        if (selectedOutput !== 'default') {
            if (typeof audio.setSinkId === 'function') {
                audio.setSinkId(selectedOutput).catch(err => console.warn('setSinkId failed', err));
            }
        }

        // Explicit play attempt
        audio.play().catch(e => console.error(`Audio play failed for ${userId}:`, e));

        remoteStreams[userId] = audio;
    });

    peer.on('close', () => removePeer(userId));
    peers[userId] = peer;
    return peer;
}

function removePeer(id) {
    if (peers[id]) {
        peers[id].destroy();
        delete peers[id];
    }
    if (remoteStreams[id]) {
        remoteStreams[id].pause();
        if (remoteStreams[id].parentNode) {
            remoteStreams[id].parentNode.removeChild(remoteStreams[id]);
        }
        delete remoteStreams[id];
    }
    const indicator = document.getElementById(`status-${id}`);
    if (indicator) indicator.classList.remove('connected');
}

// --- Utilities ---

async function startLocalAudio() {
    // Validate context state. If suspended, resume.
    if (audioContext && audioContext.state === 'suspended') {
        await audioContext.resume();
    }

    // Stop previous streams
    if (hardwareStream) hardwareStream.getTracks().forEach(t => t.stop());
    // Note: localStream might be a Destination stream, which doesn't have 'stop' on tracks the same way via source, 
    // but good practice to stop tracks if they exist.
    if (localStream && localStream !== hardwareStream) {
        localStream.getTracks().forEach(t => t.stop());
    }

    try {
        hardwareStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                deviceId: selectedInput ? { exact: selectedInput } : undefined,
                echoCancellation: true,
                // If ANC is on, ask browser for heavy lifting too
                noiseSuppression: isNoiseSuppressionEnabled ? { ideal: true } : false,
                autoGainControl: true
            }
        });

        // Hybrid ANC Logic
        if (isNoiseSuppressionEnabled) {
            if (audioContext) audioContext.close();
            audioContext = new AudioContext();

            const source = audioContext.createMediaStreamSource(hardwareStream);
            const highpass = audioContext.createBiquadFilter();

            // Highpass Filter: Cuts low frequency rumble (fans, traffic, bumps)
            highpass.type = 'highpass';
            highpass.frequency.value = 100; // 100Hz cutoff

            const destination = audioContext.createMediaStreamDestination();

            source.connect(highpass);
            highpass.connect(destination);

            localStream = destination.stream;
        } else {
            localStream = hardwareStream;
        }

        setupVoiceActivityDetection(localStream);
        return true;

    } catch (err) {
        console.error('Mic error:', err);
        return false;
    }
}

function setupVoiceActivityDetection(stream) {
    // If using audioContext from ANC, reuse it. Otherwise create new for analysis.
    if (!audioContext || audioContext.state === 'closed') {
        audioContext = new AudioContext();
    }

    // Create a new source for analysis specifically if needed, but we can reuse the graph?
    // Be careful not to create loops. 
    // Safest is to just create a separate analyser input from the stream provided.

    const source = audioContext.createMediaStreamSource(stream);
    analyzer = audioContext.createAnalyser();
    analyzer.fftSize = 512;
    source.connect(analyzer);

    const bufferLength = analyzer.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const checkSpeaking = () => {
        analyzer.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
        let average = sum / bufferLength;

        const speaking = average > 15;
        if (speaking !== isSpeaking) {
            isSpeaking = speaking;
            if (socket?.connected) socket.emit('voice-state', { roomId: myRoomId, isSpeaking });
            updateUserSpeakingUI(socket?.id || 'me', isSpeaking);
        }
        requestAnimationFrame(checkSpeaking);
    };
    checkSpeaking();
}

function updateUserSpeakingUI(id, speaking) {
    const avatar = (id === socket?.id || id === 'me') ? document.getElementById('me-avatar') : document.getElementById(`avatar-${id}`);
    if (avatar) {
        if (speaking) avatar.classList.add('speaking');
        else avatar.classList.remove('speaking');
    }
}

function handleVoiceStateUpdate({ id, isSpeaking }) {
    updateUserSpeakingUI(id, isSpeaking);
}

function addMessage(data) {
    const container = document.getElementById('messages-container');
    if (!container) return;
    const msgEl = document.createElement('div');
    msgEl.style = "display: flex; gap: 16px; margin-bottom: 20px;";
    msgEl.innerHTML = `
        <div class="avatar" style="flex-shrink: 0;">${data.nickname[0].toUpperCase()}</div>
        <div style="min-width: 0;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 2px;">
                <span style="font-weight: 600; color: var(--text-primary);">${data.nickname}</span>
                <span style="font-size: 11px; color: var(--text-muted);">${data.timestamp}</span>
            </div>
            <div style="color: var(--text-secondary); line-height: 1.4; word-wrap: break-word; user-select: text;">${data.text}</div>
        </div>
    `;
    container.appendChild(msgEl);
    container.scrollTop = container.scrollHeight;
}

async function updateDeviceList() {
    const allDevices = await navigator.mediaDevices.enumerateDevices();
    devices.input = allDevices.filter(d => d.kind === 'audioinput');
    devices.output = allDevices.filter(d => d.kind === 'audiooutput');
}

function showSettings() {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    // Setting HTML
    overlay.innerHTML = `
        <div class="modal">
            <div class="modal-sidebar">
                <div class="sidebar-label">Ayarlar</div>
                <div class="list-item active">Ses & Görüntü</div>
                <div style="margin-top: auto; padding: 12px; cursor: pointer; color: var(--bg-danger);" id="logout-btn">Çıkış Yap</div>
            </div>
            <div class="modal-content">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px;">
                    <h2 style="font-size: 20px;">Ses Ayarları</h2>
                    <button class="icon-btn" id="close-settings" style="font-size: 24px;">✕</button>
                </div>
                
                <div class="input-group">
                    <label class="input-label">Mikrofon</label>
                    <select id="input-device-select">
                        ${devices.input.map(d => `<option value="${d.deviceId}" ${d.deviceId === selectedInput ? 'selected' : ''}>${d.label || 'Mikrofon'}</option>`).join('')}
                    </select>
                </div>
                
                <div class="input-group" style="margin-top: 24px;">
                    <label class="input-label">Hoparlör</label>
                    <select id="output-device-select">
                        ${devices.output.map(d => `<option value="${d.deviceId}" ${d.deviceId === selectedOutput ? 'selected' : ''}>${d.label || 'Hoparlör'}</option>`).join('')}
                    </select>
                </div>
                
                <div style="margin-top: 32px; border-top: 1px solid var(--border); padding-top: 24px;">
                    <h3 style="font-size: 14px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 16px;">Gelişmiş Ses İşleme</h3>
                    
                    <div class="setting-item">
                        <div>
                            <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">Gürültü Engelleme (ANC)</div>
                            <div style="font-size: 12px; color: var(--text-secondary);">Arka plan gürültüsünü ve uğultuyu filtreler.</div>
                        </div>
                        <div id="anc-toggle" class="toggle-switch ${isNoiseSuppressionEnabled ? 'active' : ''}"></div>
                    </div>
                </div>

            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('close-settings').onclick = () => overlay.remove();
    document.getElementById('logout-btn').onclick = () => window.location.reload();

    // Device Select Logic
    document.getElementById('input-device-select').onchange = async (e) => {
        selectedInput = e.target.value;
        await startLocalAudio();
    };
    document.getElementById('output-device-select').onchange = (e) => {
        selectedOutput = e.target.value;
    };

    // ANC Toggle Logic
    const ancToggle = document.getElementById('anc-toggle');
    ancToggle.onclick = toggleNoiseSuppression; // Reuse same function
}

showLogin();
