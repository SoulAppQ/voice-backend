const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { AccessToken } = require('livekit-server-sdk');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json()); // Required to read incoming passwords

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key-for-now';

// --- AUTO-GENERATE 'CO CO' SERVER ---
async function initDefaultServer() {
  const existing = await prisma.server.findFirst({ where: { name: 'CO CO' } });
  if (!existing) {
    await prisma.server.create({
      data: {
        name: 'CO CO',
        ownerId: 'system',
        channels: { create: [{ name: 'General Lounge' }] }
      }
    });
    console.log('✅ Default CO CO server initialized!');
  }
}
initDefaultServer();

// --- SECURE REGISTRATION ---
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await prisma.user.create({
      data: { username, password: hashedPassword }
    });
    res.json({ message: 'Registration successful!' });
  } catch (error) {
    res.status(400).json({ error: 'Gamertag already taken.' });
  }
});

// --- SECURE LOGIN ---
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await prisma.user.findUnique({ where: { username } });
  
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  
  // Issue a secure identity token for this session
  const authToken = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
  res.json({ authToken, username: user.username, userId: user.id });
});

// --- LIVEKIT TOKEN GENERATOR ---
app.get('/getToken', async (req, res) => {
  const participantName = req.query.username || 'Guest-' + Math.floor(Math.random() * 100);
  const roomName = req.query.room || 'General';

  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY, 
    process.env.LIVEKIT_API_SECRET, 
    { identity: participantName }
  );
  
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  res.send({ token: await at.toJwt() });
});

io.on('connection', (socket) => {
  socket.on('send_message', (data) => socket.broadcast.emit('receive_message', data));
});

server.listen(3001, () => console.log('Signaling server running on port 3001'));