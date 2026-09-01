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
const { v2: cloudinary } = require('cloudinary');

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());

// Safety net: an uncaught error in any route (ours or a future one) should
// log and keep the process alive, not take down every other endpoint.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (server stayed up):', reason);
});

// ---- FILE UPLOADS (Cloudinary) --------------------------------------------
// IMPORTANT: uploads used to be written to local disk (`uploads/` next to this
// file) and served via express.static. That works fine on a machine that
// never restarts, but Render's web services have an EPHEMERAL filesystem —
// every redeploy, restart, or free-tier spin-down after inactivity wipes
// anything written at runtime. That's why avatars, chat attachments, and
// soundboard clips would vanish after a few minutes or a restart. Files now
// go to Cloudinary instead, so they persist independently of the server
// process/container.
//
// Requires these env vars to be set on Render (Dashboard -> your service ->
// Environment): CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
// (find them on your Cloudinary dashboard after creating a free account).
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.warn(
    'WARNING: Cloudinary env vars are not fully set (CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET). ' +
    'File uploads (avatars, attachments, soundboard clips) will fail until these are configured.'
  );
}

// Streams a buffer up to Cloudinary and resolves with the upload result
// (we mainly care about `.secure_url`). `resourceType` is 'image' for
// avatars/banners/screenshots, 'video' for clips, 'video' for mp3s too
// (Cloudinary files raw audio under its "video" resource type).
function uploadBufferToCloudinary(buffer, { folder, resourceType = 'image', publicId }) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType, public_id: publicId },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/quicktime',
]);
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB, plenty for a short clip

// Memory storage: the file just passes through as a buffer on its way to
// Cloudinary — it's never written to this server's disk.
const upload = multer({
  storage: multer.memoryStorage(),
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
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SOUNDBOARD_BYTES },
  fileFilter: (req, file, cb) => {
    if (!SOUNDBOARD_MIME.has(file.mimetype)) return cb(new Error('Only MP3 clips are supported.'));
    cb(null, true);
  },
});

// ---- CUSTOM EMOJI UPLOADS --------------------------------------------------
// Small, image-only uploads (PNG/JPEG for static, GIF/WEBP for animated).
// `animated` on the CustomEmoji row is set from the file's mimetype below,
// not something the client can lie about.
const EMOJI_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_EMOJI_BYTES = 512 * 1024; // 512KB — emoji should be small, not full images

const emojiUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EMOJI_BYTES },
  fileFilter: (req, file, cb) => {
    if (!EMOJI_MIME.has(file.mimetype)) return cb(new Error('Emoji must be a PNG, JPEG, GIF, or WEBP image.'));
    cb(null, true);
  },
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key-for-now';

// ---- AUTH HELPERS --------------------------------------------------------
// Verifies the JWT signature AND that the user it points to still exists in
// this database. Without the existence check, a stale token (e.g. left over
// after the DB was reset/re-provisioned, or after the account was deleted)
// still passes auth, then blows up downstream as a raw foreign-key
// violation the first time a route does prisma.<model>.create() with
// req.user.id — instead of a clean 401 telling the client to log in again.
async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Missing token' });
  let decoded;
  try {
    decoded = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET); // { id, username }
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  try {
    const exists = await prisma.user.findUnique({ where: { id: decoded.id }, select: { id: true } });
    if (!exists) return res.status(401).json({ error: 'Account no longer exists. Please log in again.' });
  } catch (e) {
    console.error('Auth existence check failed:', e);
    return res.status(500).json({ error: 'Authentication check failed.' });
  }
  req.user = decoded;
  next();
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

// REVIEW: permissions are three hardcoded tiers (owner/admin/member) baked
// directly into requireRole() calls throughout this file — no granular or
// custom roles. Fine for a small friend server, but it'll feel limiting the
// moment someone wants e.g. a "can moderate messages but not delete the
// server / manage channels" role. A real fix means moving from a fixed enum
// to a permission-bits or named-permissions model (per role or per member
// override), which touches every requireRole(['owner','admin']) call site.
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

// ---- SHARED SERIALIZERS ---------------------------------------------------
async function badgesFor(userId) {
  const rows = await prisma.userBadge.findMany({ where: { userId } });
  return rows.map((b) => ({ id: b.id, key: b.key, label: b.label, color: b.color }));
}

function attachmentFromMessage(m) {
  return m.attachmentUrl ? { url: m.attachmentUrl, kind: m.attachmentKind || 'image' } : null;
}

function serializeReaction(r) {
  return { emoji: r.emoji, userId: r.userId, username: r.username };
}

function serializeMessage(m) {
  return {
    id: m.id,
    channelId: m.channelId,
    sender: m.sender,
    senderId: m.senderId,
    senderAvatarUrl: m.senderAvatarUrl,
    content: m.content,
    attachment: attachmentFromMessage(m),
    pinned: m.pinned,
    editedAt: m.editedAt,
    createdAt: m.createdAt,
    reactions: (m.reactions || []).map(serializeReaction),
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
    const isFirstUser = (await prisma.user.count()) === 0;
    const created = await prisma.user.create({ data: { username, password: hashedPassword } });
    // The very first account ever registered gets a permanent "Founder" badge.
    if (isFirstUser) {
      await prisma.userBadge.create({
        data: { userId: created.id, key: 'founder', label: 'Founder', color: '#d4a24c' },
      }).catch(() => {});
    }
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
      statusText: user.statusText,
      statusEmoji: user.statusEmoji,
      badges: await badgesFor(user.id),
    });
  } catch (err) {
    console.error('GET /me failed:', err);
    res.status(500).json({ error: 'Could not load your profile.' });
  }
});

// --- PROFILE: update avatar/banner/status (persisted on the account, not the device) ---
app.patch('/me/profile', authMiddleware, async (req, res) => {
  try {
    const { avatarUrl, bannerUrl, bannerColor, statusText, statusEmoji } = req.body;
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        ...(avatarUrl !== undefined ? { avatarUrl } : {}),
        ...(bannerUrl !== undefined ? { bannerUrl } : {}),
        ...(bannerColor !== undefined ? { bannerColor } : {}),
        ...(statusText !== undefined ? { statusText: statusText ? statusText.slice(0, 100) : null } : {}),
        ...(statusEmoji !== undefined ? { statusEmoji: statusEmoji ? statusEmoji.slice(0, 8) : null } : {}),
      },
    });
    res.json({
      avatarUrl: updated.avatarUrl, bannerUrl: updated.bannerUrl, bannerColor: updated.bannerColor,
      statusText: updated.statusText, statusEmoji: updated.statusEmoji, badges: await badgesFor(updated.id),
    });
    // Let anyone sharing a server with this user refresh their live status pill.
    io.emit('presence_updated', { userId: updated.id, statusText: updated.statusText, statusEmoji: updated.statusEmoji });
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
  try {
    const existing = await getMembership(req.user.id, serverId);
    if (existing) return res.json(existing);

    const serverExists = await prisma.server.findUnique({ where: { id: serverId } });
    if (!serverExists) return res.status(404).json({ error: 'Server not found.' });

    const member = await prisma.serverMember.create({
      data: { userId: req.user.id, serverId, role: 'member' },
    });
    res.json(member);
  } catch (e) {
    console.error('Join server failed:', e);
    res.status(500).json({ error: 'Could not join server. Please try again.' });
  }
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
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
    if (!req.file) return res.status(400).json({ error: 'No file provided.' });
    try {
      const result = await uploadBufferToCloudinary(req.file.buffer, {
        folder: 'soul/profile',
        resourceType: 'image',
      });
      res.json({ url: result.secure_url, mimeType: req.file.mimetype });
    } catch (error) {
      console.error('Profile upload to Cloudinary failed:', error);
      res.status(500).json({ error: 'Upload failed. Please try again.' });
    }
  });
});

// --- SERVERS: delete (owner only — wipes its channels + memberships too) ---
app.delete('/servers/:id', authMiddleware, requireRole(['owner']), async (req, res) => {
  const serverId = req.params.id;
  const channels = await prisma.channel.findMany({ where: { serverId }, select: { id: true } });
  await prisma.$transaction([
    prisma.message.deleteMany({ where: { channelId: { in: channels.map((c) => c.id) } } }),
    prisma.invite.deleteMany({ where: { serverId } }),
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
  
  const type = req.body.type === 'text' ? 'text' : 'voice';
  const isEphemeral = !!req.body.isEphemeral; // 1. Grab it from the request
  
  const channel = await prisma.channel.create({ 
    data: { name, serverId: req.params.id, type, isEphemeral } // 2. Save it to the database
  });
  
  res.json(channel);
});

// --- CHANNELS: delete (owner/admin only, must belong to this server) ---
app.delete('/servers/:id/channels/:channelId', authMiddleware, requireRole(['owner', 'admin']), async (req, res) => {
  const { id: serverId, channelId } = req.params;
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel || channel.serverId !== serverId) return res.status(404).json({ error: 'Room not found.' });

  const remaining = await prisma.channel.count({ where: { serverId } });
  if (remaining <= 1) return res.status(400).json({ error: 'A server needs at least one room.' });

  await prisma.message.deleteMany({ where: { channelId } });
  await prisma.channel.delete({ where: { id: channelId } });
  res.json({ message: 'Room deleted.' });
});

// --- MEMBERS: list / change role (owner/admin only, can't touch the owner) ---
app.get('/servers/:id/members', authMiddleware, requireMembership(), async (req, res) => {
  const members = await prisma.serverMember.findMany({
    where: { serverId: req.params.id },
    include: { user: true },
  });
  const withBadges = await Promise.all(members.map(async (m) => ({
    id: m.id,
    userId: m.userId,
    username: m.user.username,
    role: m.role,
    avatarUrl: m.user.avatarUrl,
    bannerUrl: m.user.bannerUrl,
    bannerColor: m.user.bannerColor,
    statusText: m.user.statusText,
    statusEmoji: m.user.statusEmoji,
    badges: await badgesFor(m.userId),
  })));
  res.json(withBadges);
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
    upload.single('file')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
      if (!req.file) return res.status(400).json({ error: 'No file provided.' });
      const kind = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
      try {
        const result = await uploadBufferToCloudinary(req.file.buffer, {
          folder: 'soul/attachments',
          resourceType: kind, // 'video' or 'image'
        });
        res.json({ url: result.secure_url, mimeType: req.file.mimetype, kind });
      } catch (error) {
        console.error('Attachment upload to Cloudinary failed:', error);
        res.status(500).json({ error: 'Upload failed. Please try again.' });
      }
    });
  }
);

// --- MESSAGES: channel history (paginated) + pinning ------------------------
// Defaults to the latest 50 messages. Pass ?before=<ISO timestamp> (the
// createdAt of the oldest message currently loaded) to page further back —
// this is what powers "load more" when scrolling up through history.
app.get('/servers/:id/channels/:channelId/messages', authMiddleware, requireMembership(), async (req, res) => {
  try {
    const channel = await prisma.channel.findUnique({ where: { id: req.params.channelId } });
    if (!channel || channel.serverId !== req.params.id) return res.status(404).json({ error: 'Room not found.' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const before = req.query.before ? new Date(req.query.before) : null;
    const hasValidCursor = before && !isNaN(before.getTime());

    const messages = await prisma.message.findMany({
      where: {
        channelId: req.params.channelId,
        ...(hasValidCursor ? { createdAt: { lt: before } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { reactions: true },
    });
    // If we got a full page, there may be more/older messages beyond it.
    res.json({ messages: messages.reverse().map(serializeMessage), hasMore: messages.length === limit });
  } catch (err) {
    console.error('GET messages failed:', err);
    res.status(500).json({ error: 'Could not load message history. Has the database migration been run?' });
  }
});

app.get('/servers/:id/channels/:channelId/pinned', authMiddleware, requireMembership(), async (req, res) => {
  try {
    const pinned = await prisma.message.findMany({
      where: { channelId: req.params.channelId, pinned: true },
      orderBy: { createdAt: 'asc' },
      include: { reactions: true },
    });
    res.json(pinned.map(serializeMessage));
  } catch (err) {
    console.error('GET pinned failed:', err);
    res.status(500).json({ error: 'Could not load pinned messages.' });
  }
});

app.post('/servers/:id/channels/:channelId/messages/:messageId/pin', authMiddleware, requireMembership(), async (req, res) => {
  try {
    const msg = await prisma.message.update({ where: { id: req.params.messageId }, data: { pinned: true } });
    const payload = serializeMessage(msg);
    io.to(req.params.channelId).emit('message_pinned', payload);
    res.json(payload);
  } catch (err) {
    res.status(404).json({ error: 'Message not found.' });
  }
});

app.delete('/servers/:id/channels/:channelId/messages/:messageId/pin', authMiddleware, requireMembership(), async (req, res) => {
  try {
    const msg = await prisma.message.update({ where: { id: req.params.messageId }, data: { pinned: false } });
    io.to(req.params.channelId).emit('message_unpinned', { id: msg.id });
    res.json({ id: msg.id });
  } catch (err) {
    res.status(404).json({ error: 'Message not found.' });
  }
});

// --- MESSAGES: edit (sender only) -------------------------------------------
app.patch('/servers/:id/channels/:channelId/messages/:messageId', authMiddleware, requireMembership(), async (req, res) => {
  try {
    const content = (req.body.content || '').trim();
    if (!content) return res.status(400).json({ error: 'Message cannot be empty.' });
    if (content.length > 4000) return res.status(400).json({ error: 'Message is too long.' });

    const msg = await prisma.message.findUnique({ where: { id: req.params.messageId } });
    if (!msg || msg.channelId !== req.params.channelId) return res.status(404).json({ error: 'Message not found.' });
    if (msg.senderId !== req.user.id) return res.status(403).json({ error: 'You can only edit your own messages.' });

    const updated = await prisma.message.update({
      where: { id: msg.id },
      data: { content, editedAt: new Date() },
    });
    const payload = serializeMessage(updated);
    io.to(req.params.channelId).emit('message_edited', payload);
    res.json(payload);
  } catch (err) {
    console.error('PATCH message failed:', err);
    res.status(500).json({ error: 'Could not edit message.' });
  }
});

// --- MESSAGES: delete (sender, or owner/admin) ------------------------------
app.delete('/servers/:id/channels/:channelId/messages/:messageId', authMiddleware, requireMembership(), async (req, res) => {
  try {
    const msg = await prisma.message.findUnique({ where: { id: req.params.messageId } });
    if (!msg || msg.channelId !== req.params.channelId) return res.status(404).json({ error: 'Message not found.' });

    const isSender = msg.senderId === req.user.id;
    const isManager = ['owner', 'admin'].includes(req.membership.role);
    if (!isSender && !isManager) return res.status(403).json({ error: 'Insufficient permissions.' });

    await prisma.message.delete({ where: { id: msg.id } });
    io.to(req.params.channelId).emit('message_deleted', { id: msg.id, channelId: req.params.channelId });
    res.json({ id: msg.id });
  } catch (err) {
    console.error('DELETE message failed:', err);
    res.status(500).json({ error: 'Could not delete message.' });
  }
});

// --- INVITES: create a shareable join code, or join a server by one --------
app.post('/servers/:id/invites', authMiddleware, requireRole(['owner', 'admin']), async (req, res) => {
  const { maxUses, expiresInHours } = req.body || {};
  const invite = await prisma.invite.create({
    data: {
      code: crypto.randomBytes(4).toString('hex'),
      serverId: req.params.id,
      createdById: req.user.id,
      maxUses: maxUses ? parseInt(maxUses, 10) : null,
      expiresAt: expiresInHours ? new Date(Date.now() + expiresInHours * 3600 * 1000) : null,
    },
  });
  res.json(invite);
});

app.get('/servers/:id/invites', authMiddleware, requireRole(['owner', 'admin']), async (req, res) => {
  const invites = await prisma.invite.findMany({ where: { serverId: req.params.id }, orderBy: { createdAt: 'desc' } });
  res.json(invites);
});

app.delete('/servers/:id/invites/:inviteId', authMiddleware, requireRole(['owner', 'admin']), async (req, res) => {
  await prisma.invite.deleteMany({ where: { id: req.params.inviteId, serverId: req.params.id } });
  res.json({ message: 'Invite revoked.' });
});

// Look up (without joining) what an invite code points to, so the client can show a preview.
app.get('/invites/:code', optionalAuth, async (req, res) => {
  const invite = await prisma.invite.findUnique({ where: { code: req.params.code }, include: { server: true } });
  if (!invite) return res.status(404).json({ error: 'Invite not found or expired.' });
  if (invite.expiresAt && invite.expiresAt < new Date()) return res.status(410).json({ error: 'This invite has expired.' });
  if (invite.maxUses && invite.uses >= invite.maxUses) return res.status(410).json({ error: 'This invite has reached its use limit.' });
  res.json({ serverId: invite.serverId, serverName: invite.server.name });
});

app.post('/invites/:code/join', authMiddleware, async (req, res) => {
  const invite = await prisma.invite.findUnique({ where: { code: req.params.code } });
  if (!invite) return res.status(404).json({ error: 'Invite not found or expired.' });
  if (invite.expiresAt && invite.expiresAt < new Date()) return res.status(410).json({ error: 'This invite has expired.' });
  if (invite.maxUses && invite.uses >= invite.maxUses) return res.status(410).json({ error: 'This invite has reached its use limit.' });

  const existing = await getMembership(req.user.id, invite.serverId);
  if (!existing) {
    await prisma.$transaction([
      prisma.serverMember.create({ data: { userId: req.user.id, serverId: invite.serverId, role: 'member' } }),
      prisma.invite.update({ where: { id: invite.id }, data: { uses: { increment: 1 } } }),
    ]);
  }
  res.json({ serverId: invite.serverId });
});

// --- FRIENDS: requests + friend list ----------------------------------------
function friendPairKey(idA, idB) {
  return idA < idB ? { userAId: idA, userBId: idB } : { userAId: idB, userBId: idA };
}

app.get('/friends', authMiddleware, async (req, res) => {
  const friendships = await prisma.friendship.findMany({
    where: { OR: [{ userAId: req.user.id }, { userBId: req.user.id }] },
    include: { userA: true, userB: true },
  });
  res.json(friendships.map((f) => {
    const friend = f.userAId === req.user.id ? f.userB : f.userA;
    return { friendshipId: f.id, id: friend.id, username: friend.username, avatarUrl: friend.avatarUrl, statusText: friend.statusText, statusEmoji: friend.statusEmoji };
  }));
});

app.get('/friends/requests', authMiddleware, async (req, res) => {
  const [incoming, outgoing] = await Promise.all([
    prisma.friendRequest.findMany({ where: { recipientId: req.user.id, status: 'pending' }, include: { sender: true } }),
    prisma.friendRequest.findMany({ where: { senderId: req.user.id, status: 'pending' }, include: { recipient: true } }),
  ]);
  res.json({
    incoming: incoming.map((r) => ({ id: r.id, username: r.sender.username, userId: r.senderId, avatarUrl: r.sender.avatarUrl })),
    outgoing: outgoing.map((r) => ({ id: r.id, username: r.recipient.username, userId: r.recipientId, avatarUrl: r.recipient.avatarUrl })),
  });
});

app.post('/friends/requests', authMiddleware, async (req, res) => {
  const username = (req.body.username || '').trim();
  if (!username) return res.status(400).json({ error: 'Username required.' });
  const target = await prisma.user.findUnique({ where: { username } });
  if (!target) return res.status(404).json({ error: 'No one with that username.' });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't friend yourself." });

  const already = await prisma.friendship.findUnique({ where: { userAId_userBId: friendPairKey(req.user.id, target.id) } });
  if (already) return res.status(400).json({ error: 'Already friends.' });

  try {
    const request = await prisma.friendRequest.create({
      data: { senderId: req.user.id, recipientId: target.id },
    });
    io.to(`user:${target.id}`).emit('friend_request_received', { id: request.id, username: req.user.username, userId: req.user.id });
    res.json(request);
  } catch {
    res.status(400).json({ error: 'Request already sent.' });
  }
});

app.post('/friends/requests/:id/accept', authMiddleware, async (req, res) => {
  const request = await prisma.friendRequest.findUnique({ where: { id: req.params.id } });
  if (!request || request.recipientId !== req.user.id) return res.status(404).json({ error: 'Request not found.' });

  const [friendship] = await prisma.$transaction([
    prisma.friendship.create({ data: friendPairKey(request.senderId, request.recipientId) }),
    prisma.friendRequest.update({ where: { id: request.id }, data: { status: 'accepted' } }),
  ]);
  io.to(`user:${request.senderId}`).emit('friend_request_accepted', { by: req.user.username, userId: req.user.id });
  res.json(friendship);
});

app.post('/friends/requests/:id/decline', authMiddleware, async (req, res) => {
  const request = await prisma.friendRequest.findUnique({ where: { id: req.params.id } });
  if (!request || request.recipientId !== req.user.id) return res.status(404).json({ error: 'Request not found.' });
  await prisma.friendRequest.update({ where: { id: request.id }, data: { status: 'declined' } });
  res.json({ message: 'Declined.' });
});

app.delete('/friends/:userId', authMiddleware, async (req, res) => {
  await prisma.friendship.deleteMany({ where: friendPairKey(req.user.id, req.params.userId) });
  res.json({ message: 'Unfriended.' });
});

// --- DIRECT MESSAGES: history + send (friends only) -------------------------
app.get('/dms/:userId', authMiddleware, async (req, res) => {
  const friendship = await prisma.friendship.findUnique({ where: { userAId_userBId: friendPairKey(req.user.id, req.params.userId) } });
  if (!friendship) return res.status(403).json({ error: 'You can only DM friends.' });

  const messages = await prisma.directMessage.findMany({
    where: {
      OR: [
        { senderId: req.user.id, recipientId: req.params.userId },
        { senderId: req.params.userId, recipientId: req.user.id },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  res.json(messages.map((m) => ({
    id: m.id, senderId: m.senderId, recipientId: m.recipientId, content: m.content,
    attachment: m.attachmentUrl ? { url: m.attachmentUrl, kind: m.attachmentKind || 'image' } : null,
    createdAt: m.createdAt,
  })));
});

app.post('/dms/:userId', authMiddleware, async (req, res) => {
  const friendship = await prisma.friendship.findUnique({ where: { userAId_userBId: friendPairKey(req.user.id, req.params.userId) } });
  if (!friendship) return res.status(403).json({ error: 'You can only DM friends.' });

  const { content, attachment } = req.body;
  if (!content && !attachment) return res.status(400).json({ error: 'Empty message.' });

  const dm = await prisma.directMessage.create({
    data: {
      senderId: req.user.id, recipientId: req.params.userId, content: content || '',
      attachmentUrl: attachment?.url || null, attachmentKind: attachment?.kind || null,
    },
  });
  const payload = {
    id: dm.id, senderId: dm.senderId, recipientId: dm.recipientId, content: dm.content,
    attachment: dm.attachmentUrl ? { url: dm.attachmentUrl, kind: dm.attachmentKind } : null, createdAt: dm.createdAt,
  };
  io.to(`user:${req.params.userId}`).emit('dm_received', payload);
  io.to(`user:${req.user.id}`).emit('dm_received', payload);
  res.json(payload);
});

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
      // Cloudinary treats audio as a 'video' resource type.
      const result = await uploadBufferToCloudinary(req.file.buffer, {
        folder: 'soul/soundboard',
        resourceType: 'video',
      });
      const clip = await prisma.soundboardClip.create({
        data: { name, url: result.secure_url, serverId: req.params.id, uploaderId: req.user.id },
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

// --- CUSTOM EMOJI: list a server's pack ---
app.get('/servers/:id/emojis', authMiddleware, requireMembership(), async (req, res) => {
  try {
    const emojis = await prisma.customEmoji.findMany({
      where: { serverId: req.params.id },
      orderBy: { createdAt: 'asc' },
    });
    res.json(emojis);
  } catch (error) {
    console.error('GET /emojis failed:', error);
    res.status(500).json({ error: 'Could not load this server\'s emoji. Has the database migration been run?' });
  }
});

// --- CUSTOM EMOJI: add one (any member, name must be unique per-server) ---
// This is also the entry point for "importing a pack" from the client:
// the picker's pack-import flow just calls this once per emoji in the pack.
app.post('/servers/:id/emojis', authMiddleware, requireMembership(), (req, res) => {
  emojiUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
    if (!req.file) return res.status(400).json({ error: 'No file provided.' });
    const name = (req.body.name || '').trim().toLowerCase().replace(/[^a-z0-9_+-]/g, '');
    if (!name) return res.status(400).json({ error: 'Emoji needs a name using only letters, numbers, _ or -.' });
    if (name.length > 32) return res.status(400).json({ error: 'Emoji name is too long.' });
    const animated = req.file.mimetype === 'image/gif' || req.file.mimetype === 'image/webp';
    try {
      const result = await uploadBufferToCloudinary(req.file.buffer, { folder: 'soul/emojis', resourceType: 'image' });
      const emoji = await prisma.customEmoji.create({
        data: { name, url: result.secure_url, animated, serverId: req.params.id, uploaderId: req.user.id },
      });
      res.json(emoji);
    } catch (error) {
      if (error.code === 'P2002') return res.status(409).json({ error: `:${name}: is already taken in this server.` });
      console.error('Emoji upload failed:', error);
      res.status(500).json({ error: 'Could not save the emoji. Has the database migration been run?' });
    }
  });
});

// --- CUSTOM EMOJI: remove one (uploader, or owner/admin) ---
app.delete('/servers/:id/emojis/:emojiId', authMiddleware, requireMembership(), async (req, res) => {
  try {
    const emoji = await prisma.customEmoji.findUnique({ where: { id: req.params.emojiId } });
    if (!emoji || emoji.serverId !== req.params.id) return res.status(404).json({ error: 'Emoji not found.' });

    const isUploader = emoji.uploaderId === req.user.id;
    const isManager = ['owner', 'admin'].includes(req.membership.role);
    if (!isUploader && !isManager) return res.status(403).json({ error: 'Insufficient permissions.' });

    await prisma.customEmoji.delete({ where: { id: emoji.id } });
    res.json({ message: 'Emoji deleted.' });
  } catch (error) {
    console.error('DELETE /emojis failed:', error);
    res.status(500).json({ error: 'Could not delete the emoji.' });
  }
});

// --- PLAYLIST: get, add, remove ---
app.get('/channels/:id/playlist', authMiddleware, async (req, res) => {
  try {
    const tracks = await prisma.playlistTrack.findMany({
      where: { channelId: req.params.id },
      orderBy: { createdAt: 'asc' }
    });
    res.json(tracks);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch playlist' });
  }
});

app.post('/channels/:id/playlist', authMiddleware, async (req, res) => {
  try {
    const { videoId, title, url } = req.body;
    const track = await prisma.playlistTrack.create({
      data: {
        channelId: req.params.id,
        videoId, title, url,
        addedById: req.user.id
      }
    });
    res.json(track);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save track' });
  }
});

app.delete('/channels/:id/playlist/:trackId', authMiddleware, async (req, res) => {
  try {
    await prisma.playlistTrack.delete({ where: { id: req.params.trackId } });
    res.json({ message: 'Track deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete track' });
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
  // Text channels never get a voice token — defense-in-depth in case a
  // client bug (or a manually-crafted request) tries to join voice on one.
  if (channel.type === 'text') return res.status(400).json({ error: 'This is a text channel and has no voice room.' });

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

// --- RATE LIMITING: cap how fast one sender can post messages --------------
// Simple in-memory sliding window per userId. Fine for a single-process
// deployment; would need a shared store (e.g. Redis) if this ever runs
// behind multiple server instances.
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX_MESSAGES = 8; // ~1.6 msgs/sec sustained before throttling
const sendTimestamps = new Map(); // userId -> array of send times (ms)

function isRateLimited(userId) {
  const now = Date.now();
  const recent = (sendTimestamps.get(userId) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  const limited = recent.length >= RATE_LIMIT_MAX_MESSAGES;
  if (!limited) recent.push(now);
  sendTimestamps.set(userId, recent);
  return limited;
}

// Periodically drop tracking for users who've been quiet, so this map
// doesn't grow forever across a long-running process.
setInterval(() => {
  const now = Date.now();
  for (const [userId, times] of sendTimestamps) {
    const recent = times.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length === 0) sendTimestamps.delete(userId);
    else sendTimestamps.set(userId, recent);
  }
}, 60 * 1000);

// --- CHAT: scoped per channel, not global ---
io.on('connection', (socket) => {

  socket.on('user_volume_update', (data) => {
    // Broadcast the new volume to everyone else in the channel
    socket.broadcast.to(data.channelId).emit('user_volume_update', data);
  });

  socket.on('telestrator_draw', (data) => {
    // Broadcast drawing coordinates to everyone else in the room
    socket.broadcast.to(data.channelId).emit('telestrator_draw', data);
  });

  socket.on('media_action', (data) => {
  // data: { channelId, type: 'play'|'pause'|'seek'|'enqueue', url, time }
  // Broadcast to everyone in the room EXCEPT the sender
  socket.broadcast.to(data.channelId).emit('media_action', data);
});
  socket.on('join_channel', (channelId) => {
    // leave any previously-joined channel rooms before joining the new one
    [...socket.rooms].forEach((r) => { if (r !== socket.id && !r.startsWith('user:')) socket.leave(r); });
    socket.join(channelId);
  });

  // A private room the socket sits in for its whole session, used to deliver
  // DMs and friend-request notifications straight to a specific person.
  socket.on('identify', (userId) => {
    if (userId) socket.join(`user:${userId}`);
  });

  socket.on('send_message', async (data) => {
    // data: { channelId, sender, senderId, message, attachment?, senderAvatarUrl?, clientId? }
    if (!data?.channelId || !data?.senderId) return;

    if (isRateLimited(data.senderId)) {
      socket.emit('rate_limited', {
        channelId: data.channelId,
        clientId: data.clientId,
        message: "You're sending messages too fast. Slow down a bit and try again.",
      });
      return;
    }

    try {
      const saved = await prisma.message.create({
        data: {
          channelId: data.channelId,
          senderId: data.senderId,
          sender: data.sender,
          senderAvatarUrl: data.senderAvatarUrl || null,
          content: data.message || '',
          attachmentUrl: data.attachment?.url || null,
          attachmentKind: data.attachment?.kind || null,
        },
      });
      // clientId lets the sender's own UI reconcile its optimistic message
      // with the persisted one instead of showing a duplicate.
      io.to(data.channelId).emit('receive_message', { ...serializeMessage(saved), clientId: data.clientId });
    } catch (err) {
      console.error('send_message persist failed:', err);
      // Fall back to a non-persisted broadcast so the room isn't dead in the water
      // even if the DB migration hasn't been run yet. Use io.to (not
      // socket.broadcast.to) so the sender still sees their own message.
      io.to(data.channelId).emit('receive_message', { ...data, id: crypto.randomUUID() });
    }
  });

  socket.on('typing', (data) => {
    socket.broadcast.to(data.channelId).emit('typing', data);
  });

  // Reactions toggle: if this user already reacted with this emoji on this
  // message, remove it; otherwise add it. Broadcasts a small delta (not the
  // full message) so every client in the room can update in place.
  socket.on('toggle_reaction', async (data) => {
    // data: { channelId, messageId, userId, username, emoji }
    if (!data?.channelId || !data?.messageId || !data?.userId || !data?.emoji) return;
    try {
      const existing = await prisma.reaction.findUnique({
        where: { messageId_userId_emoji: { messageId: data.messageId, userId: data.userId, emoji: data.emoji } },
      });
      if (existing) {
        await prisma.reaction.delete({ where: { id: existing.id } });
        io.to(data.channelId).emit('reaction_updated', {
          messageId: data.messageId, emoji: data.emoji, userId: data.userId, username: data.username, added: false,
        });
      } else {
        await prisma.reaction.create({
          data: { messageId: data.messageId, userId: data.userId, username: data.username || 'Someone', emoji: data.emoji },
        });
        io.to(data.channelId).emit('reaction_updated', {
          messageId: data.messageId, emoji: data.emoji, userId: data.userId, username: data.username, added: true,
        });
      }
    } catch (err) {
      console.error('toggle_reaction failed:', err);
    }
  });

  socket.on('play_soundboard', (data) => {
    // data: { channelId, clipId, name, url, sender }
    // Broadcast only — the sender plays their own trigger locally without waiting on a round trip.
    socket.broadcast.to(data.channelId).emit('play_soundboard', data);
  });

  // "Now playing" bar for a voice channel — one person's now-playing state,
  // broadcast to the room so everyone's bar stays in sync.
  socket.on('now_playing_update', (data) => {
    // data: { channelId, title, artist, artworkUrl, isPlaying } or { channelId, title: null } to clear
    io.to(data.channelId).emit('now_playing_update', data);
  });

  socket.on('dm_typing', (data) => {
    // data: { toUserId, fromUsername }
    io.to(`user:${data.toUserId}`).emit('dm_typing', data);
  });

  // Real round-trip latency: client stamps the time, we echo it straight back.
  socket.on('ping_check', (sentAt) => {
    socket.emit('pong_check', sentAt);
  });
});

setInterval(async () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  try {
    const deleted = await prisma.message.deleteMany({
      where: {
        channel: { isEphemeral: true },
        createdAt: { lt: yesterday }
      }
    });
    if (deleted.count > 0) console.log(`[Cleanup] Wiped ${deleted.count} ephemeral messages.`);
  } catch (e) {
    console.error('[Cleanup Error]', e);
  }
}, 60 * 1000); // Check every minute

server.listen(3001, () => console.log('Signaling server running on port 3001'));
