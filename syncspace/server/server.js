// =============================================================================
// Synapse Backend Server v2.0
// WebSocket hub · JWT auth · Chat · File board · Kanban · History replay · Admin
// =============================================================================
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT            = process.env.PORT || 3000;
const JWT_SECRET      = process.env.JWT_SECRET || 'synapse-dev-secret-change-in-prod';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const WEB_DIR         = path.join(__dirname, '..', 'web');

const LIMITS = {
  name:        32,
  key:         64,
  valueChars:  100_000,
  keysPerRoom: 200,
  peersPerRoom: 50,
  chatMsg:     2000,
  fileBytes:   2 * 1024 * 1024, // 2 MB data URL
  cursorPerSec: 60,
  setPerSec:    40,
  chatPerSec:   8,
  filePerMin:   10,
};

const EMPTY_ROOM_TTL_MS = 15 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

// ---------------------------------------------------------------------------
// JWT helpers (tiny inline implementation — no additional library needed)
// ---------------------------------------------------------------------------
function makeToken(payload) {
  const jwt = require('jsonwebtoken');
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    const jwt = require('jsonwebtoken');
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-memory room registry
// ---------------------------------------------------------------------------
const rooms = new Map();

// room shape: { id, state: Map, version, peers: Map, emptySince, padDebounceTimer, lastPadTypist }

const COLORS = ['#4f46e5','#059669','#d97706','#db2777','#0284c7','#7c3aed','#dc2626','#16a34a','#0891b2','#9333ea'];

const validId   = s  => typeof s === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(s);
const colorFor  = id => COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const publicPeer = p => ({ id: p.id, name: p.name, color: p.color });

function rateLimit(peer, kind, maxPerSec) {
  const now    = Date.now();
  const bucket = peer.buckets[kind] || (peer.buckets[kind] = { t: now, count: 0 });
  if (now - bucket.t >= 1000) { bucket.t = now; bucket.count = 0; }
  return ++bucket.count <= maxPerSec;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url   = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // ['api','auth','token'] etc.

  // ── Health check ──────────────────────────────────────────────────────────
  if (url.pathname === '/health') {
    return jsonOk(res, {
      ok: true, service: 'synapse', version: '2.0.0',
      rooms: rooms.size, db: db.isDbConnected(),
      uptime: Math.round(process.uptime()),
    });
  }

  // ── Auth: issue JWT token ─────────────────────────────────────────────────
  // POST /api/auth/token  { displayName, clientId? }
  if (req.method === 'POST' && url.pathname === '/api/auth/token') {
    const body = await readBody(req);
    let data;
    try { data = JSON.parse(body); } catch { return jsonErr(res, 400, 'bad_json'); }

    const displayName = String(data.displayName || 'Guest').trim().slice(0, LIMITS.name) || 'Guest';
    const clientId    = validId(data.clientId) ? data.clientId : uuidv4().replace(/-/g, '').slice(0, 16);
    const color       = colorFor(clientId);
    const token       = makeToken({ clientId, displayName, color });

    return jsonOk(res, { ok: true, token, clientId, displayName, color });
  }

  // ── REST API ──────────────────────────────────────────────────────────────
  if (url.pathname.startsWith('/api/room/') && parts[0] === 'api' && parts[1] === 'room') {
    const roomCode = parts[2];
    const resource = parts[3];
    if (!validId(roomCode)) return jsonErr(res, 400, 'bad_room_code');

    // GET /api/room/:code/notepad-history
    if (req.method === 'GET' && resource === 'notepad-history') {
      const versions = await db.getPadVersions(roomCode, 50);
      return jsonOk(res, { ok: true, roomCode, versions });
    }

    // GET /api/room/:code/counter-history
    if (req.method === 'GET' && resource === 'counter-history') {
      const actions = await db.getCounterActions(roomCode, 50);
      return jsonOk(res, { ok: true, roomCode, actions });
    }

    // GET /api/room/:code/chat
    if (req.method === 'GET' && resource === 'chat') {
      const messages = await db.getChatMessages(roomCode, 80);
      return jsonOk(res, { ok: true, roomCode, messages });
    }

    // GET /api/room/:code/files
    if (req.method === 'GET' && resource === 'files') {
      const files = await db.getFileBoard(roomCode, 30);
      return jsonOk(res, { ok: true, roomCode, files });
    }

    // GET /api/room/:code/files/:fileId  — full data_url for download
    if (req.method === 'GET' && resource === 'files' && parts[4]) {
      const file = await db.getFileById(roomCode, parts[4]);
      if (!file) return jsonErr(res, 404, 'file_not_found');
      return jsonOk(res, { ok: true, file });
    }

    // GET /api/room/:code/admin  — room statistics dashboard
    if (req.method === 'GET' && resource === 'admin') {
      const stats = await db.getRoomStats(roomCode);
      return jsonOk(res, { ok: true, roomCode, stats });
    }
  }

  // ── Static file server ────────────────────────────────────────────────────
  const reqPath  = url.pathname === '/' ? '/index.html' : url.pathname;
  const fullPath = path.normalize(path.join(WEB_DIR, reqPath));

  if (!fullPath.startsWith(WEB_DIR)) {
    res.writeHead(403); return res.end('403 Forbidden');
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      // SPA fallback
      return fs.readFile(path.join(WEB_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('404'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({
  server,
  maxPayload: 4 * 1024 * 1024, // 4 MB (for file uploads)
  verifyClient: ({ origin }) => ALLOWED_ORIGINS.length === 0 || !origin || ALLOWED_ORIGINS.includes(origin),
});

const send       = (ws, msg) => { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(msg)); } catch {} } };
const broadcast  = (room, msg, exceptId = null) => { for (const p of room.peers.values()) { if (p.id !== exceptId) send(p.ws, msg); } };
const broadcastAll = (room, msg) => { for (const p of room.peers.values()) send(p.ws, msg); };

wss.on('connection', (ws) => {
  let peer = null;
  let room = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch {
      return send(ws, { t: 'error', code: 'bad_json', message: 'Message must be valid JSON' });
    }

    if (!msg || typeof msg.t !== 'string') {
      return send(ws, { t: 'error', code: 'bad_message', message: 'Missing message type "t"' });
    }

    // ────────────────────────────────────────────────────────────────────────
    // JOIN
    // ────────────────────────────────────────────────────────────────────────
    if (msg.t === 'join') {
      if (peer) return send(ws, { t: 'error', code: 'already_joined' });
      if (!validId(msg.room)) return send(ws, { t: 'error', code: 'bad_room' });

      // Resolve identity: prefer JWT, fall back to msg fields
      let clientId    = null;
      let displayName = 'Guest';
      let color       = COLORS[0];

      if (msg.token) {
        const claims = verifyToken(msg.token);
        if (claims) {
          clientId    = claims.clientId;
          displayName = claims.displayName;
          color       = claims.color || colorFor(clientId);
        }
      }

      if (!clientId) {
        clientId    = validId(msg.clientId) ? msg.clientId : uuidv4().replace(/-/g, '').slice(0, 16);
        displayName = String(msg.name || 'Guest').trim().slice(0, LIMITS.name) || 'Guest';
        color       = colorFor(clientId);
      }

      // Get or create room
      room = rooms.get(msg.room);
      if (!room) {
        const durable = await db.getRoom(msg.room);
        const state   = new Map();
        state.set('pad',     durable.pad_text || '');
        state.set('counter', durable.counter_value || 0);
        state.set('tasks',   durable.tasks || []);
        state.set('kanban',  durable.kanban || { todo: [], doing: [], done: [] });

        room = { id: msg.room, state, version: 1, peers: new Map(), emptySince: null, padDebounceTimer: null, lastPadTypist: null };
        rooms.set(msg.room, room);
      }

      // Handle reconnect / room-full
      const existing = room.peers.get(clientId);
      if (!existing && room.peers.size >= LIMITS.peersPerRoom) {
        room = null;
        return send(ws, { t: 'error', code: 'room_full' });
      }
      if (existing) {
        try { existing.ws.removeAllListeners('close'); existing.ws.terminate(); } catch {}
        room.peers.delete(clientId);
      }

      peer = { id: clientId, name: displayName, color, ws, buckets: {} };
      room.peers.set(clientId, peer);
      room.emptySince = null;

      // Persist user session
      db.upsertUser({ clientId, displayName, color, roomCode: msg.room }).catch(() => {});

      // Fetch history
      const [notepadHistory, counterHistory, chatHistory, fileBoard] = await Promise.all([
        db.getPadVersions(msg.room, 30),
        db.getCounterActions(msg.room, 30),
        db.getChatMessages(msg.room, 80),
        db.getFileBoard(msg.room, 20),
      ]);

      // Welcome
      send(ws, {
        t: 'welcome',
        id: clientId, room: msg.room, version: room.version,
        state: Object.fromEntries(room.state),
        peers: [...room.peers.values()].map(publicPeer),
        notepadHistory, counterHistory, chatHistory, fileBoard,
        dbConnected: db.isDbConnected(),
        myColor: color,
      });

      broadcast(room, { t: 'peer-join', peer: publicPeer(peer) }, clientId);
      return;
    }

    if (!peer || !room) return send(ws, { t: 'error', code: 'not_joined' });

    // ────────────────────────────────────────────────────────────────────────
    // SET (state mutation)
    // ────────────────────────────────────────────────────────────────────────
    if (msg.t === 'set') {
      const key = msg.key;
      if (typeof key !== 'string' || !key || key.length > LIMITS.key)
        return send(ws, { t: 'error', code: 'bad_key' });
      if (!rateLimit(peer, 'set', LIMITS.setPerSec))
        return send(ws, { t: 'error', code: 'rate_limited' });

      // ── Collaborative Notepad ──
      if (key === 'pad') {
        const text = String(msg.value || '');
        if (text.length > LIMITS.valueChars) return send(ws, { t: 'error', code: 'too_big' });

        room.state.set('pad', text);
        room.version++;

        broadcast(room, { t: 'state', key: 'pad', value: text, by: peer.id, v: room.version }, peer.id);

        room.lastPadTypist = { savedText: text, displayName: peer.name, clientId: peer.id, cursorPosition: typeof msg.cursorPosition === 'number' ? msg.cursorPosition : null };

        if (room.padDebounceTimer) clearTimeout(room.padDebounceTimer);
        const roomCode = room.id;
        const snap = { ...room.lastPadTypist };

        room.padDebounceTimer = setTimeout(async () => {
          try {
            const ver = await db.savePadVersion(roomCode, snap);
            broadcastAll(room, { t: 'notepad_version_added', version: ver });
            db.incrementUserStat(peer.id, 'charCount', text.length).catch(() => {});
          } catch (err) { console.error('[Server] savePadVersion:', err.message); }
        }, 2000);
        return;
      }

      // ── Kanban board ──
      if (key === 'kanban') {
        room.state.set('kanban', msg.value);
        room.version++;
        db.saveRoomField(room.id, 'kanban', msg.value).catch(() => {});
        broadcast(room, { t: 'state', key: 'kanban', value: msg.value, by: peer.id, v: room.version }, peer.id);
        return;
      }

      // ── Tasks ──
      if (key === 'tasks') {
        room.state.set('tasks', msg.value);
        room.version++;
        db.saveRoomField(room.id, 'tasks', msg.value).catch(() => {});
        broadcast(room, { t: 'state', key: 'tasks', value: msg.value, by: peer.id, v: room.version }, peer.id);
        return;
      }

      // Generic key
      if (msg.value === undefined) {
        room.state.delete(key);
      } else {
        const serialized = JSON.stringify(msg.value);
        if (serialized.length > LIMITS.valueChars) return send(ws, { t: 'error', code: 'too_big' });
        if (!room.state.has(key) && room.state.size >= LIMITS.keysPerRoom) return send(ws, { t: 'error', code: 'too_many_keys' });
        room.state.set(key, msg.value);
      }
      room.version++;
      broadcast(room, { t: 'state', key, value: msg.value, by: peer.id, v: room.version }, peer.id);
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // COUNTER ACTION
    // ────────────────────────────────────────────────────────────────────────
    if (msg.t === 'counter_action') {
      try {
        const { resultingValue, actionRecord } = await db.applyCounterAction(room.id, {
          actionType: String(msg.action || 'inc'),
          amount:     Number(msg.amount) || 1,
          displayName: peer.name,
          clientId:    peer.id,
        });
        room.state.set('counter', resultingValue);
        room.version++;
        const stateMsg  = { t: 'state', key: 'counter', value: resultingValue, by: peer.id, v: room.version };
        const actionMsg = { t: 'counter_action_added', action: actionRecord };
        broadcastAll(room, stateMsg);
        broadcastAll(room, actionMsg);
        db.incrementUserStat(peer.id, 'actionsCount', 1).catch(() => {});
      } catch (err) {
        console.error('[Server] counter_action error:', err.message);
        send(ws, { t: 'error', code: 'counter_error' });
      }
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // RESTORE NOTEPAD VERSION
    // ────────────────────────────────────────────────────────────────────────
    if (msg.t === 'restore_version') {
      try {
        const target = await db.getPadVersionById(room.id, msg.versionId);
        if (!target) return send(ws, { t: 'error', code: 'version_not_found' });

        const text = target.saved_text;
        room.state.set('pad', text);
        room.version++;

        const stateMsg = { t: 'state', key: 'pad', value: text, by: peer.id, v: room.version };
        broadcastAll(room, stateMsg);

        const newVer = await db.savePadVersion(room.id, {
          savedText: text, displayName: `${peer.name} (restored #${target.id})`,
          clientId: peer.id, cursorPosition: 0,
        });
        broadcastAll(room, { t: 'notepad_version_added', version: newVer });
      } catch (err) {
        console.error('[Server] restore_version error:', err.message);
        send(ws, { t: 'error', code: 'restore_error' });
      }
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // CURSOR
    // ────────────────────────────────────────────────────────────────────────
    if (msg.t === 'cursor') {
      if (!rateLimit(peer, 'cursor', LIMITS.cursorPerSec)) return;
      if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
      broadcast(room, { t: 'cursor', id: peer.id, x: msg.x, y: msg.y }, peer.id);
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // CHAT MESSAGE
    // ────────────────────────────────────────────────────────────────────────
    if (msg.t === 'chat') {
      if (!rateLimit(peer, 'chat', LIMITS.chatPerSec)) return send(ws, { t: 'error', code: 'rate_limited' });
      const text = String(msg.message || '').trim().slice(0, LIMITS.chatMsg);
      if (!text) return;

      try {
        const record = await db.saveChatMessage(room.id, {
          clientId: peer.id, displayName: peer.name, color: peer.color,
          message: text, replyToId: msg.replyToId || null,
        });
        broadcastAll(room, { t: 'chat', message: record });
      } catch (err) {
        console.error('[Server] chat error:', err.message);
        send(ws, { t: 'error', code: 'chat_error' });
      }
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // CHAT REACTION
    // ────────────────────────────────────────────────────────────────────────
    if (msg.t === 'chat_react') {
      const emoji = String(msg.emoji || '').slice(0, 8);
      if (!emoji || !msg.messageId) return;
      try {
        await db.addChatReaction(room.id, msg.messageId, emoji, peer.id);
        broadcastAll(room, { t: 'chat_react', messageId: msg.messageId, emoji, clientId: peer.id });
      } catch (err) { console.error('[Server] chat_react error:', err.message); }
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // FILE UPLOAD (base64 data URL via WebSocket)
    // ────────────────────────────────────────────────────────────────────────
    if (msg.t === 'file_upload') {
      if (!rateLimit(peer, 'file', LIMITS.filePerMin)) return send(ws, { t: 'error', code: 'rate_limited' });
      const dataUrl  = String(msg.dataUrl  || '');
      const fileName = String(msg.fileName || 'file').slice(0, 256);
      const fileType = String(msg.fileType || 'application/octet-stream').slice(0, 64);
      const fileSize = Number(msg.fileSize) || 0;
      const caption  = String(msg.caption  || '').slice(0, 500);

      if (!dataUrl) return send(ws, { t: 'error', code: 'empty_file' });
      if (dataUrl.length > LIMITS.fileBytes * 1.4) // base64 overhead ~1.37x
        return send(ws, { t: 'error', code: 'file_too_large', message: `Max 2 MB per file` });

      try {
        const record = await db.saveFileUpload(room.id, {
          clientId: peer.id, displayName: peer.name,
          fileName, fileType, fileSize, caption,
          dataUrl, // stored in DB, not broadcast
        });

        // Broadcast metadata only (no data_url — clients fetch via REST)
        const { data_url, ...meta } = record;
        broadcastAll(room, { t: 'file_added', file: meta });
        send(ws, { t: 'file_upload_ok', file: meta });
      } catch (err) {
        console.error('[Server] file_upload error:', err.message);
        send(ws, { t: 'error', code: 'file_error' });
      }
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // QUICK SHOUT
    // ────────────────────────────────────────────────────────────────────────
    if (msg.t === 'quick_shout') {
      const text = String(msg.message || '').trim().slice(0, 240);
      if (!text) return;
      const shout = { t: 'quick_shout', id: uuidv4().slice(0, 8), message: text, from: peer.name, color: peer.color, clientId: peer.id, time: Date.now() };
      broadcastAll(room, shout);
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // EMOJI REACTION
    // ────────────────────────────────────────────────────────────────────────
    if (msg.t === 'reaction') {
      const emoji = String(msg.emoji || '🚀').slice(0, 8);
      broadcast(room, { t: 'reaction', emoji, from: peer.name, time: Date.now() }, peer.id);
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // PING
    // ────────────────────────────────────────────────────────────────────────
    if (msg.t === 'ping') return send(ws, { t: 'pong', ts: Date.now() });

    send(ws, { t: 'error', code: 'unknown_type', message: `Unknown message type "${msg.t}"` });
  });

  ws.on('close', () => {
    if (!peer || !room) return;
    if (room.peers.get(peer.id) === peer) {
      room.peers.delete(peer.id);
      broadcast(room, { t: 'peer-leave', id: peer.id });
      if (room.peers.size === 0) room.emptySince = Date.now();
    }
  });

  ws.on('error', () => {});
});

// ---------------------------------------------------------------------------
// Heartbeat & garbage collection
// ---------------------------------------------------------------------------
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [id, r] of rooms) {
    if (r.emptySince && now - r.emptySince > EMPTY_ROOM_TTL_MS) {
      if (r.padDebounceTimer) clearTimeout(r.padDebounceTimer);
      rooms.delete(id);
    }
  }
}, 30_000);
heartbeat.unref();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function jsonOk(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function jsonErr(res, status, code, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: code, message: message || code }));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', d => { buf += d; if (buf.length > 8 * 1024 * 1024) reject(new Error('Body too large')); });
    req.on('end',  () => resolve(buf));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function start() {
  await db.initDb();
  server.listen(PORT, () => {
    console.log(`⚡ Synapse v2 listening on http://localhost:${PORT}`);
    console.log(`📡 WebSocket ready on ws://localhost:${PORT}`);
    console.log(`💾 Database: ${db.isDbConnected() ? 'PostgreSQL' : 'In-memory'}`);
  });
}

if (require.main === module) {
  start().catch(err => { console.error('Fatal startup error:', err); process.exit(1); });
}

module.exports = { server, wss, rooms, start };
