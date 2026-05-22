import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'

const DB_FILE = 'wechat-storage.db'
const dbCache = new Map()

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function normalizeBoolean(value) {
  return value ? 1 : 0
}

function mapMessageRow(row) {
  if (!row) return null
  return {
    id: row.id,
    timestamp: row.timestamp,
    type: row.type,
    typeName: row.type_name,
    isText: Boolean(row.is_text),
    isRoom: Boolean(row.is_room),
    roomId: row.room_id,
    roomName: row.room_name,
    talkerId: row.talker_id,
    talkerName: row.talker_name,
    talkerAlias: row.talker_alias,
    receiverId: row.receiver_id,
    receiverName: row.receiver_name,
    conversationKey: row.conversation_key,
    conversationName: row.conversation_name,
    speakerName: row.speaker_name,
    role: row.role,
    text: row.text,
    self: Boolean(row.self_flag),
  }
}

function mapVectorRow(row) {
  if (!row) return null
  return {
    id: row.id,
    conversationKey: row.conversation_key,
    conversationName: row.conversation_name,
    timestamp: row.timestamp,
    role: row.role,
    speakerName: row.speaker_name,
    typeName: row.type_name,
    text: row.text,
    weights: row.weights_json ? JSON.parse(row.weights_json) : {},
  }
}

export function getWechatDbPath(dataDir = '.data/wechat') {
  return path.resolve(process.cwd(), dataDir, DB_FILE)
}

export function getWechatDatabase(dataDir = '.data/wechat') {
  const dbPath = getWechatDbPath(dataDir)
  if (dbCache.has(dbPath)) return dbCache.get(dbPath)

  ensureDir(path.dirname(dbPath))
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      type INTEGER,
      type_name TEXT,
      is_text INTEGER NOT NULL DEFAULT 0,
      is_room INTEGER NOT NULL DEFAULT 0,
      room_id TEXT,
      room_name TEXT,
      talker_id TEXT,
      talker_name TEXT,
      talker_alias TEXT,
      receiver_id TEXT,
      receiver_name TEXT,
      conversation_key TEXT,
      conversation_name TEXT,
      speaker_name TEXT,
      role TEXT,
      text TEXT,
      self_flag INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_time
      ON messages (conversation_key, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_room_time
      ON messages (room_name, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_talker_time
      ON messages (talker_name, timestamp);

    CREATE TABLE IF NOT EXISTS message_vectors (
      id TEXT PRIMARY KEY,
      conversation_key TEXT,
      conversation_name TEXT,
      timestamp TEXT NOT NULL,
      role TEXT,
      speaker_name TEXT,
      type_name TEXT,
      text TEXT,
      weights_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_message_vectors_conversation_time
      ON message_vectors (conversation_key, timestamp);
  `)

  dbCache.set(dbPath, db)
  return db
}

export function upsertWechatMessage(record, options = {}) {
  const db = getWechatDatabase(options.dataDir)
  db.prepare(
    `
    INSERT OR REPLACE INTO messages (
      id,
      timestamp,
      type,
      type_name,
      is_text,
      is_room,
      room_id,
      room_name,
      talker_id,
      talker_name,
      talker_alias,
      receiver_id,
      receiver_name,
      conversation_key,
      conversation_name,
      speaker_name,
      role,
      text,
      self_flag
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    record.id,
    record.timestamp,
    record.type ?? null,
    record.typeName || '',
    normalizeBoolean(record.isText),
    normalizeBoolean(record.isRoom),
    record.roomId || '',
    record.roomName || '',
    record.talkerId || '',
    record.talkerName || '',
    record.talkerAlias || '',
    record.receiverId || '',
    record.receiverName || '',
    record.conversationKey || '',
    record.conversationName || '',
    record.speakerName || '',
    record.role || '',
    record.text || '',
    normalizeBoolean(record.self),
  )
}

export function upsertWechatVector(record, options = {}) {
  const db = getWechatDatabase(options.dataDir)
  db.prepare(
    `
    INSERT OR REPLACE INTO message_vectors (
      id,
      conversation_key,
      conversation_name,
      timestamp,
      role,
      speaker_name,
      type_name,
      text,
      weights_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    record.id,
    record.conversationKey || '',
    record.conversationName || '',
    record.timestamp,
    record.role || '',
    record.speakerName || '',
    record.typeName || '',
    record.text || '',
    JSON.stringify(record.weights || {}),
  )
}

export function loadWechatMessagesFromDb(options = {}) {
  const db = getWechatDatabase(options.dataDir)
  const rows = db
    .prepare(
      `
      SELECT *
      FROM messages
      ORDER BY timestamp ASC
    `,
    )
    .all()

  return rows.map(mapMessageRow).filter(Boolean)
}

export function loadWechatVectorsFromDb(options = {}) {
  const db = getWechatDatabase(options.dataDir)
  const rows = db
    .prepare(
      `
      SELECT *
      FROM message_vectors
      ORDER BY timestamp DESC
    `,
    )
    .all()

  return rows.map(mapVectorRow).filter(Boolean)
}
