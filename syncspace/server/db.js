// =============================================================================
// Synapse Database Layer v2.0
// PostgreSQL with resilient in-memory fallback
// Tables: rooms, notepad_versions, counter_actions, chat_messages, file_board, users
// =============================================================================
'use strict';

let pool = null;
let isConnected = false;

// ---------------------------------------------------------------------------
// In-memory store — used when DATABASE_URL is absent or unreachable
// ---------------------------------------------------------------------------
const mem = {
  rooms:           new Map(), // roomCode -> { pad_text, counter_value, tasks, kanban, settings }
  padVersions:     new Map(), // roomCode -> [{...}]
  counterActions:  new Map(), // roomCode -> [{...}]
  chatMessages:    new Map(), // roomCode -> [{...}]
  fileBoard:       new Map(), // roomCode -> [{...}]
  users:           new Map(), // clientId -> { clientId, displayName, color, roomCode, joinedAt, lastSeen, actionsCount, charCount }
};

let seqId = 1;
const nextId = () => seqId++;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function initDb() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log('ℹ️  [DB] DATABASE_URL not set — running with in-memory storage.');
    return false;
  }

  try {
    const { Pool } = require('pg');
    const isProd = process.env.NODE_ENV === 'production' ||
                   dbUrl.includes('render.com') ||
                   dbUrl.includes('sslmode=require');

    pool = new Pool({
      connectionString: dbUrl,
      ssl: isProd ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      console.error('⚠️  [DB] Pool error:', err.message);
    });

    const client = await pool.connect();
    try {
      await runMigrations(client);
      isConnected = true;
      console.log('✅ [DB] PostgreSQL connected & migrations verified.');
      return true;
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn(`⚠️  [DB] Cannot connect to PostgreSQL (${err.message}) — falling back to memory.`);
    isConnected = false;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Schema migrations (idempotent)
// ---------------------------------------------------------------------------
async function runMigrations(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS synapse_rooms (
      room_code       VARCHAR(32)  PRIMARY KEY,
      pad_text        TEXT         DEFAULT '',
      counter_value   INTEGER      DEFAULT 0,
      tasks           JSONB        DEFAULT '[]'::jsonb,
      kanban          JSONB        DEFAULT '{"todo":[],"doing":[],"done":[]}'::jsonb,
      settings        JSONB        DEFAULT '{}'::jsonb,
      created_at      TIMESTAMPTZ  DEFAULT NOW(),
      updated_at      TIMESTAMPTZ  DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS synapse_notepad_versions (
      id              SERIAL       PRIMARY KEY,
      room_code       VARCHAR(32)  NOT NULL REFERENCES synapse_rooms(room_code) ON DELETE CASCADE,
      saved_text      TEXT         NOT NULL,
      char_count      INTEGER      NOT NULL DEFAULT 0,
      display_name    VARCHAR(64)  NOT NULL,
      client_id       VARCHAR(64)  NOT NULL,
      cursor_position INTEGER,
      created_at      TIMESTAMPTZ  DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS synapse_counter_actions (
      id              SERIAL       PRIMARY KEY,
      room_code       VARCHAR(32)  NOT NULL REFERENCES synapse_rooms(room_code) ON DELETE CASCADE,
      action_type     VARCHAR(16)  NOT NULL,
      amount          INTEGER      NOT NULL DEFAULT 1,
      resulting_value INTEGER      NOT NULL DEFAULT 0,
      display_name    VARCHAR(64)  NOT NULL,
      client_id       VARCHAR(64)  NOT NULL,
      created_at      TIMESTAMPTZ  DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS synapse_chat_messages (
      id              SERIAL       PRIMARY KEY,
      room_code       VARCHAR(32)  NOT NULL REFERENCES synapse_rooms(room_code) ON DELETE CASCADE,
      client_id       VARCHAR(64)  NOT NULL,
      display_name    VARCHAR(64)  NOT NULL,
      color           VARCHAR(16)  NOT NULL DEFAULT '#4f46e5',
      message         TEXT         NOT NULL,
      reply_to_id     INTEGER,
      reactions       JSONB        DEFAULT '{}'::jsonb,
      created_at      TIMESTAMPTZ  DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS synapse_file_board (
      id              SERIAL       PRIMARY KEY,
      room_code       VARCHAR(32)  NOT NULL REFERENCES synapse_rooms(room_code) ON DELETE CASCADE,
      client_id       VARCHAR(64)  NOT NULL,
      display_name    VARCHAR(64)  NOT NULL,
      file_name       VARCHAR(256) NOT NULL,
      file_type       VARCHAR(64)  NOT NULL,
      file_size       INTEGER      NOT NULL DEFAULT 0,
      data_url        TEXT         NOT NULL,
      caption         TEXT         DEFAULT '',
      created_at      TIMESTAMPTZ  DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS synapse_users (
      client_id       VARCHAR(64)  PRIMARY KEY,
      display_name    VARCHAR(64)  NOT NULL,
      color           VARCHAR(16)  NOT NULL DEFAULT '#4f46e5',
      room_code       VARCHAR(32),
      actions_count   INTEGER      NOT NULL DEFAULT 0,
      char_count      INTEGER      NOT NULL DEFAULT 0,
      joined_at       TIMESTAMPTZ  DEFAULT NOW(),
      last_seen       TIMESTAMPTZ  DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_pad_versions_room     ON synapse_notepad_versions(room_code, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_counter_actions_room  ON synapse_counter_actions(room_code, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_room    ON synapse_chat_messages(room_code, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_file_board_room       ON synapse_file_board(room_code, created_at DESC);
  `);
}

function isDbConnected() { return isConnected; }

// ---------------------------------------------------------------------------
// Room helpers
// ---------------------------------------------------------------------------
const DEFAULT_ROOM = () => ({
  pad_text: '',
  counter_value: 0,
  tasks: [],
  kanban: { todo: [], doing: [], done: [] },
  settings: {},
});

async function ensureRoom(roomCode) {
  if (!mem.rooms.has(roomCode)) mem.rooms.set(roomCode, DEFAULT_ROOM());
  if (!mem.padVersions.has(roomCode))    mem.padVersions.set(roomCode, []);
  if (!mem.counterActions.has(roomCode)) mem.counterActions.set(roomCode, []);
  if (!mem.chatMessages.has(roomCode))   mem.chatMessages.set(roomCode, []);
  if (!mem.fileBoard.has(roomCode))      mem.fileBoard.set(roomCode, []);

  if (isConnected && pool) {
    try {
      await pool.query(
        `INSERT INTO synapse_rooms (room_code) VALUES ($1) ON CONFLICT DO NOTHING`,
        [roomCode]
      );
    } catch (err) {
      console.error('[DB] ensureRoom error:', err.message);
    }
  }
}

async function getRoom(roomCode) {
  await ensureRoom(roomCode);
  if (isConnected && pool) {
    try {
      const res = await pool.query(
        `SELECT pad_text, counter_value, tasks, kanban, settings FROM synapse_rooms WHERE room_code = $1`,
        [roomCode]
      );
      if (res.rows.length > 0) {
        const r = res.rows[0];
        const parsed = {
          pad_text:      r.pad_text || '',
          counter_value: Number(r.counter_value) || 0,
          tasks:         Array.isArray(r.tasks) ? r.tasks : [],
          kanban:        r.kanban || { todo: [], doing: [], done: [] },
          settings:      r.settings || {},
        };
        mem.rooms.set(roomCode, parsed);
        return parsed;
      }
    } catch (err) {
      console.error('[DB] getRoom error:', err.message);
    }
  }
  return mem.rooms.get(roomCode) || DEFAULT_ROOM();
}

async function saveRoomField(roomCode, field, value) {
  await ensureRoom(roomCode);
  const memRoom = mem.rooms.get(roomCode);
  if (memRoom) memRoom[field] = value;

  if (isConnected && pool) {
    const allowed = ['pad_text', 'counter_value', 'tasks', 'kanban', 'settings'];
    if (!allowed.includes(field)) return;
    const jsonFields = ['tasks', 'kanban', 'settings'];
    const pgVal = jsonFields.includes(field) ? JSON.stringify(value) : value;
    const cast  = jsonFields.includes(field) ? '::jsonb' : '';
    try {
      await pool.query(
        `UPDATE synapse_rooms SET ${field} = $1${cast}, updated_at = NOW() WHERE room_code = $2`,
        [pgVal, roomCode]
      );
    } catch (err) {
      console.error(`[DB] saveRoomField(${field}) error:`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Notepad version history
// ---------------------------------------------------------------------------
async function savePadVersion(roomCode, { savedText, displayName, clientId, cursorPosition }) {
  await ensureRoom(roomCode);
  const text     = String(savedText  || '');
  const name     = String(displayName || 'Guest').slice(0, 64);
  const cid      = String(clientId    || '').slice(0, 64);
  const pos      = typeof cursorPosition === 'number' ? cursorPosition : null;
  const charCount = text.length;

  const memVersion = {
    id: nextId(), room_code: roomCode,
    saved_text: text, char_count: charCount,
    display_name: name, client_id: cid,
    cursor_position: pos,
    created_at: new Date().toISOString(),
  };

  const list = mem.padVersions.get(roomCode) || [];
  list.unshift(memVersion);
  if (list.length > 100) list.pop();
  mem.padVersions.set(roomCode, list);

  const memRoom = mem.rooms.get(roomCode);
  if (memRoom) memRoom.pad_text = text;

  if (isConnected && pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE synapse_rooms SET pad_text = $1, updated_at = NOW() WHERE room_code = $2`,
        [text, roomCode]
      );
      const ins = await client.query(
        `INSERT INTO synapse_notepad_versions
           (room_code, saved_text, char_count, display_name, client_id, cursor_position)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [roomCode, text, charCount, name, cid, pos]
      );
      await client.query('COMMIT');
      return ins.rows[0];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[DB] savePadVersion error:', err.message);
    } finally { client.release(); }
  }

  return memVersion;
}

async function getPadVersions(roomCode, limit = 50) {
  await ensureRoom(roomCode);
  if (isConnected && pool) {
    try {
      const res = await pool.query(
        `SELECT * FROM synapse_notepad_versions WHERE room_code=$1 ORDER BY created_at DESC LIMIT $2`,
        [roomCode, limit]
      );
      return res.rows;
    } catch (err) { console.error('[DB] getPadVersions error:', err.message); }
  }
  return (mem.padVersions.get(roomCode) || []).slice(0, limit);
}

async function getPadVersionById(roomCode, versionId) {
  if (isConnected && pool) {
    try {
      const res = await pool.query(
        `SELECT * FROM synapse_notepad_versions WHERE room_code=$1 AND id=$2`,
        [roomCode, versionId]
      );
      if (res.rows.length > 0) return res.rows[0];
    } catch (err) { console.error('[DB] getPadVersionById error:', err.message); }
  }
  return (mem.padVersions.get(roomCode) || []).find(v => String(v.id) === String(versionId)) || null;
}

// ---------------------------------------------------------------------------
// Counter with atomic row-lock
// ---------------------------------------------------------------------------
async function applyCounterAction(roomCode, { actionType, amount, displayName, clientId }) {
  await ensureRoom(roomCode);
  const name  = String(displayName || 'Guest').slice(0, 64);
  const cid   = String(clientId    || '').slice(0, 64);
  const act   = String(actionType  || 'inc');
  const delta = Number(amount) || 1;

  if (isConnected && pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lockRes = await client.query(
        `SELECT counter_value FROM synapse_rooms WHERE room_code=$1 FOR UPDATE`,
        [roomCode]
      );
      let cur = lockRes.rows.length > 0 ? Number(lockRes.rows[0].counter_value) : 0;
      let val = computeCounter(cur, act, delta);

      await client.query(
        `UPDATE synapse_rooms SET counter_value=$1, updated_at=NOW() WHERE room_code=$2`,
        [val, roomCode]
      );
      const ins = await client.query(
        `INSERT INTO synapse_counter_actions
           (room_code, action_type, amount, resulting_value, display_name, client_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [roomCode, act, delta, val, name, cid]
      );
      await client.query('COMMIT');

      const actionRecord = ins.rows[0];
      const memRoom = mem.rooms.get(roomCode);
      if (memRoom) memRoom.counter_value = val;
      prependMem(mem.counterActions, roomCode, actionRecord);
      return { resultingValue: val, actionRecord };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[DB] applyCounterAction error:', err.message);
    } finally { client.release(); }
  }

  // memory fallback
  const memRoom = mem.rooms.get(roomCode) || DEFAULT_ROOM();
  const val = computeCounter(Number(memRoom.counter_value) || 0, act, delta);
  memRoom.counter_value = val;
  mem.rooms.set(roomCode, memRoom);

  const actionRecord = {
    id: nextId(), room_code: roomCode,
    action_type: act, amount: delta, resulting_value: val,
    display_name: name, client_id: cid,
    created_at: new Date().toISOString(),
  };
  prependMem(mem.counterActions, roomCode, actionRecord);
  return { resultingValue: val, actionRecord };
}

function computeCounter(cur, act, delta) {
  if (act === 'inc')   return cur + delta;
  if (act === 'dec')   return cur - delta;
  if (act === 'reset') return 0;
  if (act === 'set')   return delta;
  return cur;
}

async function getCounterActions(roomCode, limit = 50) {
  await ensureRoom(roomCode);
  if (isConnected && pool) {
    try {
      const res = await pool.query(
        `SELECT * FROM synapse_counter_actions WHERE room_code=$1 ORDER BY created_at DESC LIMIT $2`,
        [roomCode, limit]
      );
      return res.rows;
    } catch (err) { console.error('[DB] getCounterActions error:', err.message); }
  }
  return (mem.counterActions.get(roomCode) || []).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------
async function saveChatMessage(roomCode, { clientId, displayName, color, message, replyToId }) {
  await ensureRoom(roomCode);
  const cid   = String(clientId    || '').slice(0, 64);
  const name  = String(displayName || 'Guest').slice(0, 64);
  const col   = String(color       || '#4f46e5').slice(0, 16);
  const msg   = String(message     || '').slice(0, 2000);
  const repId = replyToId ? Number(replyToId) : null;

  if (isConnected && pool) {
    try {
      const res = await pool.query(
        `INSERT INTO synapse_chat_messages
           (room_code, client_id, display_name, color, message, reply_to_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [roomCode, cid, name, col, msg, repId]
      );
      const row = res.rows[0];
      prependMem(mem.chatMessages, roomCode, row, 200);
      return row;
    } catch (err) { console.error('[DB] saveChatMessage error:', err.message); }
  }

  const record = {
    id: nextId(), room_code: roomCode,
    client_id: cid, display_name: name, color: col,
    message: msg, reply_to_id: repId,
    reactions: {},
    created_at: new Date().toISOString(),
  };
  prependMem(mem.chatMessages, roomCode, record, 200);
  return record;
}

async function getChatMessages(roomCode, limit = 80) {
  await ensureRoom(roomCode);
  if (isConnected && pool) {
    try {
      const res = await pool.query(
        `SELECT * FROM synapse_chat_messages WHERE room_code=$1 ORDER BY created_at ASC LIMIT $2`,
        [roomCode, limit]
      );
      return res.rows;
    } catch (err) { console.error('[DB] getChatMessages error:', err.message); }
  }
  return (mem.chatMessages.get(roomCode) || []).slice(-limit).reverse().reverse();
}

async function addChatReaction(roomCode, messageId, emoji, clientId) {
  if (isConnected && pool) {
    try {
      // Atomic jsonb update: toggle user in emoji set
      await pool.query(
        `UPDATE synapse_chat_messages
         SET reactions = CASE
           WHEN reactions->$1 ? $2
           THEN reactions - $1 || jsonb_build_object($1, (reactions->$1) - $2)
           ELSE reactions || jsonb_build_object($1, COALESCE(reactions->$1, '[]'::jsonb) || $2::jsonb)
         END
         WHERE room_code=$3 AND id=$4`,
        [emoji, clientId, roomCode, messageId]
      );
    } catch (err) { console.error('[DB] addChatReaction error:', err.message); }
  }
  // Memory update
  const list = mem.chatMessages.get(roomCode) || [];
  const found = list.find(m => String(m.id) === String(messageId));
  if (found) {
    if (!found.reactions) found.reactions = {};
    const arr = found.reactions[emoji] || [];
    const idx = arr.indexOf(clientId);
    if (idx >= 0) arr.splice(idx, 1); else arr.push(clientId);
    found.reactions[emoji] = arr;
  }
}

// ---------------------------------------------------------------------------
// File board
// ---------------------------------------------------------------------------
async function saveFileUpload(roomCode, { clientId, displayName, fileName, fileType, fileSize, dataUrl, caption }) {
  await ensureRoom(roomCode);
  const record = {
    room_code: roomCode,
    client_id:    String(clientId    || '').slice(0, 64),
    display_name: String(displayName || 'Guest').slice(0, 64),
    file_name:    String(fileName    || 'file').slice(0, 256),
    file_type:    String(fileType    || 'application/octet-stream').slice(0, 64),
    file_size:    Number(fileSize)   || 0,
    data_url:     String(dataUrl     || ''),
    caption:      String(caption     || '').slice(0, 500),
    created_at:   new Date().toISOString(),
  };

  if (isConnected && pool) {
    try {
      const res = await pool.query(
        `INSERT INTO synapse_file_board
           (room_code, client_id, display_name, file_name, file_type, file_size, data_url, caption)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [record.room_code, record.client_id, record.display_name,
         record.file_name, record.file_type, record.file_size,
         record.data_url, record.caption]
      );
      const row = { ...res.rows[0] };
      prependMem(mem.fileBoard, roomCode, row, 50);
      return row;
    } catch (err) { console.error('[DB] saveFileUpload error:', err.message); }
  }

  record.id = nextId();
  prependMem(mem.fileBoard, roomCode, record, 50);
  return record;
}

async function getFileBoard(roomCode, limit = 30) {
  await ensureRoom(roomCode);
  if (isConnected && pool) {
    try {
      const res = await pool.query(
        `SELECT id, room_code, client_id, display_name, file_name, file_type, file_size, caption, created_at
         FROM synapse_file_board WHERE room_code=$1 ORDER BY created_at DESC LIMIT $2`,
        [roomCode, limit]
      );
      return res.rows;
    } catch (err) { console.error('[DB] getFileBoard error:', err.message); }
  }
  return (mem.fileBoard.get(roomCode) || []).slice(0, limit).map(f => {
    const { data_url, ...meta } = f; // strip data_url from list view
    return meta;
  });
}

async function getFileById(roomCode, fileId) {
  if (isConnected && pool) {
    try {
      const res = await pool.query(
        `SELECT * FROM synapse_file_board WHERE room_code=$1 AND id=$2`,
        [roomCode, fileId]
      );
      if (res.rows.length > 0) return res.rows[0];
    } catch (err) { console.error('[DB] getFileById error:', err.message); }
  }
  return (mem.fileBoard.get(roomCode) || []).find(f => String(f.id) === String(fileId)) || null;
}

// ---------------------------------------------------------------------------
// Users / session tracking
// ---------------------------------------------------------------------------
async function upsertUser({ clientId, displayName, color, roomCode }) {
  const cid  = String(clientId    || '').slice(0, 64);
  const name = String(displayName || 'Guest').slice(0, 64);
  const col  = String(color       || '#4f46e5').slice(0, 16);

  if (!mem.users.has(cid)) {
    mem.users.set(cid, { clientId: cid, displayName: name, color: col, roomCode, actionsCount: 0, charCount: 0, joinedAt: new Date().toISOString(), lastSeen: new Date().toISOString() });
  } else {
    const u = mem.users.get(cid);
    u.displayName = name; u.color = col; u.roomCode = roomCode; u.lastSeen = new Date().toISOString();
  }

  if (isConnected && pool) {
    try {
      await pool.query(
        `INSERT INTO synapse_users (client_id, display_name, color, room_code)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (client_id) DO UPDATE
           SET display_name=$2, color=$3, room_code=$4, last_seen=NOW()`,
        [cid, name, col, roomCode]
      );
    } catch (err) { console.error('[DB] upsertUser error:', err.message); }
  }
}

async function incrementUserStat(clientId, field, by = 1) {
  const u = mem.users.get(clientId);
  if (u) u[field] = (u[field] || 0) + by;

  if (isConnected && pool) {
    const allowed = { actionsCount: 'actions_count', charCount: 'char_count' };
    const col = allowed[field];
    if (!col) return;
    try {
      await pool.query(
        `UPDATE synapse_users SET ${col} = ${col} + $1 WHERE client_id = $2`,
        [by, clientId]
      );
    } catch (err) { console.error('[DB] incrementUserStat error:', err.message); }
  }
}

async function getRoomStats(roomCode) {
  if (isConnected && pool) {
    try {
      const [usersRes, chatRes, padRes, counterRes, filesRes] = await Promise.all([
        pool.query(`SELECT client_id, display_name, color, actions_count, char_count, joined_at, last_seen
                    FROM synapse_users WHERE room_code=$1 ORDER BY joined_at ASC`, [roomCode]),
        pool.query(`SELECT COUNT(*) AS total FROM synapse_chat_messages WHERE room_code=$1`, [roomCode]),
        pool.query(`SELECT COUNT(*) AS versions FROM synapse_notepad_versions WHERE room_code=$1`, [roomCode]),
        pool.query(`SELECT COUNT(*) AS actions FROM synapse_counter_actions WHERE room_code=$1`, [roomCode]),
        pool.query(`SELECT COUNT(*) AS files FROM synapse_file_board WHERE room_code=$1`, [roomCode]),
      ]);
      return {
        users:          usersRes.rows,
        chatTotal:      Number(chatRes.rows[0].total),
        padVersions:    Number(padRes.rows[0].versions),
        counterActions: Number(counterRes.rows[0].actions),
        files:          Number(filesRes.rows[0].files),
      };
    } catch (err) { console.error('[DB] getRoomStats error:', err.message); }
  }

  // Memory fallback
  const users = [...mem.users.values()].filter(u => u.roomCode === roomCode);
  return {
    users,
    chatTotal:      (mem.chatMessages.get(roomCode)   || []).length,
    padVersions:    (mem.padVersions.get(roomCode)    || []).length,
    counterActions: (mem.counterActions.get(roomCode) || []).length,
    files:          (mem.fileBoard.get(roomCode)      || []).length,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function prependMem(mapStore, key, record, maxLen = 100) {
  const list = mapStore.get(key) || [];
  list.unshift(record);
  if (list.length > maxLen) list.pop();
  mapStore.set(key, list);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  initDb,
  isDbConnected,
  // Room
  ensureRoom,
  getRoom,
  saveRoomField,
  // Notepad
  savePadVersion,
  getPadVersions,
  getPadVersionById,
  // Counter
  applyCounterAction,
  getCounterActions,
  // Chat
  saveChatMessage,
  getChatMessages,
  addChatReaction,
  // Files
  saveFileUpload,
  getFileBoard,
  getFileById,
  // Users / stats
  upsertUser,
  incrementUserStat,
  getRoomStats,
};
