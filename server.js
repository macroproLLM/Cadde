const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// rooms[roomId] = { users: [], channels: [] }
const rooms = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-room', ({ roomId, nickname }) => {
        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = {
                users: [],
                channels: ['Genel', 'Oyun', 'Müzik'], // Default channels
                ownerId: socket.id // First user is owner
            };
        }

        // Ensure uniqueness
        const existingIndex = rooms[roomId].users.findIndex(u => u.id === socket.id);
        if (existingIndex !== -1) {
            rooms[roomId].users[existingIndex].nickname = nickname;
        } else {
            rooms[roomId].users.push({ id: socket.id, nickname, channel: null });
        }

        // Check if room has no owner (e.g. previous owner left), assign to this user
        if (!rooms[roomId].ownerId) {
            rooms[roomId].ownerId = socket.id;
        }

        // Initial sync
        socket.emit('init-room-state', {
            users: rooms[roomId].users,
            channels: rooms[roomId].channels,
            ownerId: rooms[roomId].ownerId // Send ownerId to client
        });

        // Notify others
        io.to(roomId).emit('user-list-update', rooms[roomId].users);

        console.log(`${nickname} joined room: ${roomId}`);
    });

    socket.on('create-channel', ({ roomId, channelName }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (room.ownerId !== socket.id) return; // Only owner

        if (!room.channels.includes(channelName)) {
            room.channels.push(channelName);
            io.to(roomId).emit('init-room-state', {
                users: room.users,
                channels: room.channels,
                ownerId: room.ownerId
            });
        }
    });

    socket.on('delete-channel', ({ roomId, channelName }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (room.ownerId !== socket.id) return; // Only owner

        const idx = room.channels.indexOf(channelName);
        if (idx !== -1) {
            room.channels.splice(idx, 1);

            // Move users in this channel to lobby (null)
            room.users.forEach(u => {
                if (u.channel === channelName) u.channel = null;
            });

            // Notify everyone of new state
            io.to(roomId).emit('init-room-state', {
                users: room.users,
                channels: room.channels,
                ownerId: room.ownerId
            });
            // Also update user list locations
            io.to(roomId).emit('user-list-update', room.users);
        }
    });

    socket.on('kick-user', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (room.ownerId !== socket.id) return; // Only owner

        // Find and remove user
        const idx = room.users.findIndex(u => u.id === targetId);
        if (idx !== -1) {
            // Emit a specific event to the target so they can handle it (e.g. alert and window.location.reload)
            io.to(targetId).emit('kicked');

            // Force disconnect logic on server side
            const targetSocket = io.sockets.sockets.get(targetId);
            if (targetSocket) {
                targetSocket.leave(roomId);
            }

            room.users.splice(idx, 1);
            io.to(roomId).emit('user-list-update', room.users);
        }
    });

    socket.on('mute-user', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (room.ownerId !== socket.id) return; // Only owner
        io.to(targetId).emit('muted');
    });

    socket.on('join-channel', ({ roomId, channelName }) => {
        const room = rooms[roomId];
        if (!room) return;

        const user = room.users.find(u => u.id === socket.id);
        if (user) {
            user.channel = channelName;
            io.to(roomId).emit('user-list-update', room.users);
            console.log(`${user.nickname} moved to channel: ${channelName}`);
        }
    });

    socket.on('send-message', ({ roomId, message, nickname }) => {
        io.to(roomId).emit('new-message', {
            id: Date.now(),
            nickname,
            text: message,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
    });

    // simple-peer signaling with trickle: false
    socket.on('signal', ({ to, from, signal }) => {
        io.to(to).emit('signal', { from, signal });
    });

    socket.on('voice-state', ({ roomId, isSpeaking }) => {
        socket.to(roomId).emit('voice-state-update', { id: socket.id, isSpeaking });
    });

    // Screen Sharing Events
    socket.on('screen-share-started', ({ roomId, channelName }) => {
        socket.to(roomId).emit('user-screen-share-started', { id: socket.id, nickname: users[socket.id]?.nickname, channelName });
    });

    socket.on('screen-share-stopped', ({ roomId }) => {
        socket.to(roomId).emit('user-screen-share-stopped', { id: socket.id });
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const index = rooms[roomId].users.findIndex(u => u.id === socket.id);
            if (index !== -1) {
                rooms[roomId].users.splice(index, 1);

                // If owner left, assign new owner to the next user (if any)
                if (rooms[roomId].ownerId === socket.id) {
                    if (rooms[roomId].users.length > 0) {
                        rooms[roomId].ownerId = rooms[roomId].users[0].id;
                        // Notify new owner (sending full state update defines it)
                        io.to(roomId).emit('init-room-state', {
                            users: rooms[roomId].users,
                            channels: rooms[roomId].channels,
                            ownerId: rooms[roomId].ownerId
                        });
                    } else {
                        rooms[roomId].ownerId = null;
                        // Optionally delete room if empty
                        // delete rooms[roomId];
                    }
                }

                io.to(roomId).emit('user-list-update', rooms[roomId].users);
            }
        }
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});
