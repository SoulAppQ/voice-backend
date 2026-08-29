const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { AccessToken } = require('livekit-server-sdk');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- LIVEKIT TOKEN GENERATOR ---
app.get('/getToken', async (req, res) => {
  const participantName = req.query.username || 'Guest-' + Math.floor(Math.random() * 100);
  const roomName = req.query.room || 'General';

  // Pull keys securely from environment variables
  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY, 
    process.env.LIVEKIT_API_SECRET, 
    { identity: participantName }
  );
  
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

  const token = await at.toJwt();
  res.send({ token: token });
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  socket.on('send_message', (data) => socket.broadcast.emit('receive_message', data));
});

server.listen(3001, () => console.log('Signaling server running on port 3001'));