// SyncSpace Backend Server
// Real-time WebSocket room coordination + static HTTP demo server
// Reference: PROTOCOL.md

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const LIMITS = {
  name: 24,
  key: 64,
  valueChars: 10000,
  keysPerRoom: 100,
  peersPerRoom: 25,
  cursorPerSec: 60,
  setPerSec: 30
};

const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000; // 10 minutes
const WEB_DIR = path.join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

// Room storage: roomId -> { state: Map, version: number, peers: Map(id -> peer), emptySince: timestamp|null }
const rooms = new Map();

const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = new URL(req.url, 'http://localhost');

  // Health check endpoint
  if (parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      service: 'syncspace',
      rooms: rooms.size,
      uptime: Math.round(process.uptime()),
      timestamp: Date.now()
    }));
  }

  // Serve static demo files
  const reqPath = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
  const fullPath = path.normalize(path.join(WEB_DIR, reqPath));

  // Security: prevent path traversal attacks
  if (!fullPath.startsWith(WEB_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      // Fallback for SPA routing if requested
      const indexPath = path.join(WEB_DIR, 'index.html');
      fs.readFile(indexPath, (fallbackErr, fallbackData) => {
        if (fallbackErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('404 Not Found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fallbackData);
      });
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({
  server,
  maxPayload: 16 * 1024, // 16 KB max message payload
  verifyClient: ({ origin }) => {
    if (ALLOWED_ORIGINS.length === 0 || !origin) return true;
    return ALLOWED_ORIGINS.includes(origin);
  }
});

const send = (ws, msg) => {
  if (ws && ws.readyState === 1) { // 1 = OPEN
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      // socket closed during send
    }
  }
};

const broadcast = (room, msg, exceptId = null) => {
  for (const peer of room.peers.values()) {
    if (peer.id !== exceptId) {
      send(peer.ws, msg);
    }
  }
};

const publicPeer = p => ({ id: p.id, name: p.name, color: p.color });

const COLORS = [
  '#6366f1', // Indigo
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#ec4899', // Pink
  '#06b6d4', // Cyan
  '#8b5cf6', // Purple
  '#ef4444', // Red
  '#84cc16'  // Lime
];

const validId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(s);

function allowRateLimit(peer, kind, maxPerSec) {
  const now = Date.now();
  const bucket = peer.buckets[kind] || (peer.buckets[kind] = { t: now, count: 0 });
  if (now - bucket.t >= 1000) {
    bucket.t = now;
    bucket.count = 0;
  }
  return ++bucket.count <= maxPerSec;
}

wss.on('connection', (ws) => {
  let peer = null;
  let room = null;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { t: 'error', code: 'bad_json', message: 'Message must be valid JSON' });
    }

    if (!msg || typeof msg.t !== 'string') {
      return send(ws, { t: 'error', code: 'bad_message', message: 'Missing message type "t"' });
    }

    // Handle Join
    if (msg.t === 'join') {
      if (peer) {
        return send(ws, { t: 'error', code: 'already_joined', message: 'Already joined a room on this connection' });
      }
      if (!validId(msg.room)) {
        return send(ws, { t: 'error', code: 'bad_room', message: 'Room must be 1-32 chars: letters, numbers, - or _' });
      }

      const id = validId(msg.clientId) ? msg.clientId : Math.random().toString(36).slice(2, 10);
      room = rooms.get(msg.room);
      if (!room) {
        room = { state: new Map(), version: 0, peers: new Map(), emptySince: null };
        rooms.set(msg.room, room);
      }

      // Reconnecting client with same ID terminates former socket
      const existing = room.peers.get(id);
      if (!existing && room.peers.size >= LIMITS.peersPerRoom) {
        room = null;
        return send(ws, { t: 'error', code: 'room_full', message: `Room is full (max ${LIMITS.peersPerRoom})` });
      }

      if (existing) {
        try {
          existing.ws.removeAllListeners('close');
          existing.ws.terminate();
        } catch {}
        room.peers.delete(id);
      }

      const name = String(msg.name || 'Guest').slice(0, LIMITS.name);
      const colorHash = [...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
      const color = COLORS[colorHash % COLORS.length];

      peer = { id, name, color, ws, buckets: {} };
      room.peers.set(id, peer);
      room.emptySince = null;

      // Welcome handshake with complete room state and active peer presence
      send(ws, {
        t: 'welcome',
        id,
        room: msg.room,
        version: room.version,
        state: Object.fromEntries(room.state),
        peers: [...room.peers.values()].map(publicPeer)
      });

      // Announce arrival to all other peers in the room
      broadcast(room, { t: 'peer-join', peer: publicPeer(peer) }, id);
      return;
    }

    // Require join before any other message
    if (!peer || !room) {
      return send(ws, { t: 'error', code: 'not_joined', message: 'Must send "join" message first' });
    }

    // Handle State Update
    if (msg.t === 'set') {
      if (typeof msg.key !== 'string' || !msg.key || msg.key.length > LIMITS.key) {
        return send(ws, { t: 'error', code: 'bad_key', message: `Key must be 1-${LIMITS.key} characters` });
      }
      if (!allowRateLimit(peer, 'set', LIMITS.setPerSec)) {
        return send(ws, { t: 'error', code: 'rate_limited', message: 'Too many updates (rate limit exceeded)' });
      }

      if (msg.value === undefined) {
        room.state.delete(msg.key);
      } else {
        const serialized = JSON.stringify(msg.value);
        if (serialized.length > LIMITS.valueChars) {
          return send(ws, { t: 'error', code: 'too_big', message: `Value size exceeds ${LIMITS.valueChars} characters` });
        }
        if (!room.state.has(msg.key) && room.state.size >= LIMITS.keysPerRoom) {
          return send(ws, { t: 'error', code: 'too_many_keys', message: `Room key limit reached (${LIMITS.keysPerRoom})` });
        }
        room.state.set(msg.key, msg.value);
      }

      room.version++;
      // Broadcast state update to everyone else in the room
      broadcast(room, {
        t: 'state',
        key: msg.key,
        value: msg.value,
        by: peer.id,
        v: room.version
      }, peer.id);
    }
    // Handle Live Cursor
    else if (msg.t === 'cursor') {
      if (!allowRateLimit(peer, 'cursor', LIMITS.cursorPerSec)) return;
      if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
      broadcast(room, {
        t: 'cursor',
        id: peer.id,
        x: msg.x,
        y: msg.y
      }, peer.id);
    }
    // Handle Keep-alive Ping
    else if (msg.t === 'ping') {
      send(ws, { t: 'pong' });
    }
    else {
      send(ws, { t: 'error', code: 'unknown_type', message: `Unknown message type "${msg.t}"` });
    }
  });

  ws.on('close', () => {
    if (!peer || !room) return;
    if (room.peers.get(peer.id) === peer) {
      room.peers.delete(peer.id);
      broadcast(room, { t: 'peer-leave', id: peer.id });
      if (room.peers.size === 0) {
        room.emptySince = Date.now();
      }
    }
  });

  ws.on('error', () => {});
});

// Periodic heartbeat: drop dead sockets and garbage collect abandoned rooms
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }

  const now = Date.now();
  for (const [roomId, r] of rooms) {
    if (r.emptySince && now - r.emptySince > EMPTY_ROOM_TTL_MS) {
      rooms.delete(roomId);
    }
  }
}, 30000);
heartbeatInterval.unref();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`🚀 SyncSpace server running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket ready on ws://localhost:${PORT}`);
  });
}

module.exports = { server, wss, rooms };
