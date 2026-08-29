const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');
const cors = require('cors');
const { AccessToken } = require('livekit-server-sdk');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());

// Safety net: an uncaught error in any route (ours or a future one) should
// log and keep the process alive, not take down every other endpoint.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (server stayed up):', reason);
});

// ---- CLIP/SCREENSHOT UPLOADS ---------------------------------------------
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
app.use('/uploads', express.static(UPLOAD_DIR));

const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/quicktime',
]);
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB, plenty for a short clip

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 10);
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) return cb(new Error('Unsupported file type.'));
    cb(null, true);
  },
});

// ---- SOUNDBOARD UPLOADS ---------------------------------------------------
// Separate, tighter multer instance: MP3 only, small size cap ("lightweight clips").
const SOUNDBOARD_MIME = new Set(['audio/mpeg', 'audio/mp3']);
const MAX_SOUNDBOARD_BYTES = 2 * 1024 * 1024; // 2MB — soundboard clips should be short

const soundboardUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.mp3`),
  }),
  limits: { fileSize: MAX_SOUNDBOARD_BYTES },
  fileFilter: (req, file, cb) => {
    if (!SOUNDBOARD_MIME.has(file.mimetype)) return cb(new Error('Only MP3 clips are supported.'));
    cb(null, true);
  },
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key-for-now';

// ---- AUTH HELPERS --------------------------------------------------------
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET); // { id, username }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header) {
    try { req.user = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET); } catch { /* ignore */ }
  }
  next();
}

async function getMembership(userId, serverId) {
  return prisma.serverMember.findUnique({ where: { userId_serverId: { userId, serverId } } });
}

function requireMembership() {
  return async (req, res, next) => {
    const membership = await getMembership(req.user.id, req.params.id);
    if (!membership) return res.status(403).json({ error: 'Not a member of this server' });
    req.membership = membership;
    next();
  };
}

function requireRole(roles) {
  return async (req, res, next) => {
    const membership = await getMembership(req.user.id, req.params.id);
    if (!membership || !roles.includes(membership.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    req.membership = membership;
    next();
  };
}

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
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await prisma.user.create({ data: { username, password: hashedPassword } });
    res.json({ message: 'Registration successful!' });
  } catch (error) {
    res.status(400).json({ error: 'Gamertag already taken.' });
  }
});

// --- SECURE LOGIN ---
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await prisma.user.findUnique({ where: { username } });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const authToken = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({
      authToken,
      username: user.username,
      userId: user.id,
      avatarUrl: user.avatarUrl,
      bannerUrl: user.bannerUrl,
      bannerColor: user.bannerColor,
    });
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({
      id: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      bannerUrl: user.bannerUrl,
      bannerColor: user.bannerColor,
    });
  } catch (err) {
    console.error('GET /me failed:', err);
    res.status(500).json({ error: 'Could not load your profile.' });
  }
});

// --- PROFILE: update avatar/banner (persisted on the account, not the device) ---
app.patch('/me/profile', authMiddleware, async (req, res) => {
  try {
    const { avatarUrl, bannerUrl, bannerColor } = req.body;
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        ...(avatarUrl !== undefined ? { avatarUrl } : {}),
        ...(bannerUrl !== undefined ? { bannerUrl } : {}),
        ...(bannerColor !== undefined ? { bannerColor } : {}),
      },
    });
    res.json({ avatarUrl: updated.avatarUrl, bannerUrl: updated.bannerUrl, bannerColor: updated.bannerColor });
  } catch (err) {
    // Most common cause: the DB migration adding these columns hasn't been run yet.
    console.error('PATCH /me/profile failed:', err);
    res.status(500).json({ error: 'Could not save your profile. Has the database migration been run?' });
  }
});

// --- SERVERS: list/search (public-ish, but shows membership if logged in) ---
app.get('/servers', optionalAuth, async (req, res) => {
  const search = (req.query.search || '').trim();
  const servers = await prisma.server.findMany({
    where: search ? { name: { contains: search, mode: 'insensitive' } } : undefined,
    include: { members: true, channels: true },
    orderBy: { createdAt: 'asc' },
  });

  res.json(servers.map((s) => ({
    id: s.id,
    name: s.name,
    memberCount: s.members.length,
    channelCount: s.channels.length,
    isMember: req.user ? s.members.some((m) => m.userId === req.user.id) : false,
    myRole: req.user ? (s.members.find((m) => m.userId === req.user.id)?.role || null) : null,
  })));
});

// --- SERVERS: create (creator becomes owner + gets a default channel) ---
app.post('/servers', authMiddleware, async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Server name required.' });

  const newServer = await prisma.server.create({
    data: {
      name,
      ownerId: req.user.id,
      channels: { create: [{ name: 'General Lounge' }] },
      members: { create: [{ userId: req.user.id, role: 'owner' }] },
    },
    include: { channels: true, members: true },
  });
  res.json(newServer);
});

// --- SERVERS: join / leave ---
app.post('/servers/:id/join', authMiddleware, async (req, res) => {
  const serverId = req.params.id;
  const existing = await getMembership(req.user.id, serverId);
  if (existing) return res.json(existing);

  const serverExists = await prisma.server.findUnique({ where: { id: serverId } });
  if (!serverExists) return res.status(404).json({ error: 'Server not found.' });

  const member = await prisma.serverMember.create({
    data: { userId: req.user.id, serverId, role: 'member' },
  });
  res.json(member);
});

app.post('/servers/:id/leave', authMiddleware, async (req, res) => {
  const membership = await getMembership(req.user.id, req.params.id);
  if (!membership) return res.status(400).json({ error: 'Not a member of this server.' });
  if (membership.role === 'owner') {
    return res.status(400).json({ error: 'Owners cannot leave their own server.' });
  }
  await prisma.serverMember.delete({ where: { id: membership.id } });
  res.json({ message: 'Left server.' });
});

// --- PROFILE UPLOADS: avatar/banner images or GIFs, any logged-in user ---
app.post('/profile/upload', authMiddleware, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
    if (!req.file) return res.status(400).json({ error: 'No file provided.' });
    res.json({ url: `/uploads/${req.file.filename}`, mimeType: req.file.mimetype });
  });
});

// --- SERVERS: delete (owner only — wipes its channels + memberships too) ---
app.delete('/servers/:id', authMiddleware, requireRole(['owner']), async (req, res) => {
  const serverId = req.params.id;
  await prisma.$transaction([
    prisma.serverMember.deleteMany({ where: { serverId } }),
    prisma.channel.deleteMany({ where: { serverId } }),
    prisma.server.delete({ where: { id: serverId } }),
  ]);
  res.json({ message: 'Server deleted.' });
});

// --- CHANNELS: list / create (create = owner/admin only) ---
app.get('/servers/:id/channels', authMiddleware, requireMembership(), async (req, res) => {
  const channels = await prisma.channel.findMany({ where: { serverId: req.params.id } });
  res.json(channels);
});

app.post('/servers/:id/channels', authMiddleware, requireRole(['owner', 'admin']), async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Channel name required.' });
  const channel = await prisma.channel.create({ data: { name, serverId: req.params.id } });
  res.json(channel);
});

// --- CHANNELS: delete (owner/admin only, must belong to this server) ---
app.delete('/servers/:id/channels/:channelId', authMiddleware, requireRole(['owner', 'admin']), async (req, res) => {
  const { id: serverId, channelId } = req.params;
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel || channel.serverId !== serverId) return res.status(404).json({ error: 'Room not found.' });

  const remaining = await prisma.channel.count({ where: { serverId } });
  if (remaining <= 1) return res.status(400).json({ error: 'A server needs at least one room.' });

  await prisma.channel.delete({ where: { id: channelId } });
  res.json({ message: 'Room deleted.' });
});

// --- MEMBERS: list / change role (owner/admin only, can't touch the owner) ---
app.get('/servers/:id/members', authMiddleware, requireMembership(), async (req, res) => {
  const members = await prisma.serverMember.findMany({
    where: { serverId: req.params.id },
    include: { user: true },
  });
  res.json(members.map((m) => ({
    id: m.id,
    userId: m.userId,
    username: m.user.username,
    role: m.role,
    avatarUrl: m.user.avatarUrl,
    bannerUrl: m.user.bannerUrl,
    bannerColor: m.user.bannerColor,
  })));
});

app.post('/servers/:id/members/:userId/role', authMiddleware, requireRole(['owner', 'admin']), async (req, res) => {
  const { role } = req.body;
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Role must be admin or member.' });

  const target = await getMembership(req.params.userId, req.params.id);
  if (!target) return res.status(404).json({ error: 'Member not found.' });
  if (target.role === 'owner') return res.status(400).json({ error: "Can't change the owner's role." });

  const updated = await prisma.serverMember.update({ where: { id: target.id }, data: { role } });
  res.json(updated);
});

// --- MEMBERS: remove from server (owner/admin only, can't touch the owner) ---
app.delete('/servers/:id/members/:userId', authMiddleware, requireRole(['owner', 'admin']), async (req, res) => {
  const target = await getMembership(req.params.userId, req.params.id);
  if (!target) return res.status(404).json({ error: 'Member not found.' });
  if (target.role === 'owner') return res.status(400).json({ error: "Can't remove the owner." });

  await prisma.serverMember.delete({ where: { id: target.id } });
  res.json({ message: 'Member removed.' });
});

// --- CHAT ATTACHMENTS: upload a screenshot/clip, get back a URL to share ---
// Membership is checked so only people in the server can drop files for it.
app.post(
  '/servers/:id/upload',
  authMiddleware,
  requireMembership(),
  (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
      if (!req.file) return res.status(400).json({ error: 'No file provided.' });
      res.json({
        url: `/uploads/${req.file.filename}`,
        mimeType: req.file.mimetype,
        kind: req.file.mimetype.startsWith('video/') ? 'video' : 'image',
      });
    });
  }
);

// --- SOUNDBOARD: list clips for a server (any member) ---
app.get('/servers/:id/soundboard', authMiddleware, requireMembership(), async (req, res) => {
  try {
    const clips = await prisma.soundboardClip.findMany({
      where: { serverId: req.params.id },
      orderBy: { createdAt: 'asc' },
    });
    res.json(clips);
  } catch (error) {
    console.error('GET /soundboard failed:', error);
    res.status(500).json({ error: 'Could not load soundboard clips. Has the database migration been run?' });
  }
});

// --- SOUNDBOARD: upload a clip (any member, MP3 only, 2MB cap) ---
app.post('/servers/:id/soundboard', authMiddleware, requireMembership(), (req, res) => {
  soundboardUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
    if (!req.file) return res.status(400).json({ error: 'No file provided.' });
    const name = (req.body.name || req.file.originalname || 'clip').trim().slice(0, 40);
    try {
      const clip = await prisma.soundboardClip.create({
        data: { name, url: `/uploads/${req.file.filename}`, serverId: req.params.id, uploaderId: req.user.id },
      });
      res.json(clip);
    } catch (error) {
      console.error('Soundboard upload failed:', error);
      res.status(500).json({ error: 'Could not save the clip. Has the database migration been run?' });
    }
  });
});

// --- SOUNDBOARD: delete a clip (uploader, or owner/admin) ---
app.delete('/servers/:id/soundboard/:clipId', authMiddleware, requireMembership(), async (req, res) => {
  try {
    const clip = await prisma.soundboardClip.findUnique({ where: { id: req.params.clipId } });
    if (!clip || clip.serverId !== req.params.id) return res.status(404).json({ error: 'Clip not found.' });

    const isUploader = clip.uploaderId === req.user.id;
    const isManager = ['owner', 'admin'].includes(req.membership.role);
    if (!isUploader && !isManager) return res.status(403).json({ error: 'Insufficient permissions.' });

    await prisma.soundboardClip.delete({ where: { id: clip.id } });
    res.json({ message: 'Clip deleted.' });
  } catch (error) {
    console.error('DELETE /soundboard failed:', error);
    res.status(500).json({ error: 'Could not delete the clip.' });
  }
});

// --- LIVEKIT TOKEN GENERATOR ---
// Identity now comes from the verified JWT (not a client-supplied query param),
// and the caller must actually belong to the channel's server.
app.get('/getToken', authMiddleware, async (req, res) => {
  const channelId = req.query.channelId;
  if (!channelId) return res.status(400).json({ error: 'channelId is required.' });

  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) return res.status(404).json({ error: 'Channel not found.' });

  const membership = await getMembership(req.user.id, channel.serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member of this server.' });

  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
    { identity: req.user.username }
  );
  at.addGrant({ roomJoin: true, room: channelId, canPublish: true, canSubscribe: true });
  res.send({ token: await at.toJwt() });
});

// --- CHAT: scoped per channel, not global ---
io.on('connection', (socket) => {
  socket.on('join_channel', (channelId) => {
    // leave any previously-joined channel rooms before joining the new one
    [...socket.rooms].forEach((r) => { if (r !== socket.id) socket.leave(r); });
    socket.join(channelId);
  });

  socket.on('send_message', (data) => {
    // data: { channelId, sender, message, attachment?, senderAvatarUrl? }
    socket.broadcast.to(data.channelId).emit('receive_message', data);
  });

  socket.on('play_soundboard', (data) => {
    // data: { channelId, clipId, name, url, sender }
    // Broadcast only — the sender plays their own trigger locally without waiting on a round trip.
    socket.broadcast.to(data.channelId).emit('play_soundboard', data);
  });

  // Real round-trip latency: client stamps the time, we echo it straight back.
  socket.on('ping_check', (sentAt) => {
    socket.emit('pong_check', sentAt);
  });
});

server.listen(3001, () => console.log('Signaling server running on port 3001'));