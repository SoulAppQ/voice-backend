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
// We added 'async' here
app.get('/getToken', async (req, res) => {
  // Replace these with your actual LiveKit keys!
  const apiKey = 'APIbm8dK7dHvr3i';
  const apiSecret = 'OWnW1c5taUEwiZzsaDfG1BcQeyn9WAZjWBMaCqz8ZMx';
  
  const roomName = 'general-voice-channel';
  const participantName = 'User-' + Math.floor(Math.random() * 1000);

  const at = new AccessToken(apiKey, apiSecret, { identity: participantName });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

  // We added 'await' here to wait for the token to finish generating
  const token = await at.toJwt();
  
  res.send({ token: token });
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  socket.on('send_message', (data) => socket.broadcast.emit('receive_message', data));
});

server.listen(3001, () => console.log('Signaling server running on port 3001'));