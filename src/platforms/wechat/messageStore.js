import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { env } from '../../config/env.js'
import { getOllamaEmbedding } from '../../ollama/embedding.js'
import { loadWechatMessagesFromDb, loadWechatVectorsFromDb, upsertWechatMessage, upsertWechatVector } from './localDb.js'
import { buildQdrantPoint, getIndexedRecordIdsFromQdrant, resetQdrantCollection, searchQdrant, upsertQdrantPoints } from './qdrantStore.js'

const MESSAGE_FILE = 'messages.jsonl'
const VECTOR_FILE = 'message-vectors.jsonl'
const MAX_VECTOR_TERMS = 80
const MAX_VECTOR_TEXT_LENGTH = 2000

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function appendJsonLine(targetFile, payload) {
  ensureDir(path.dirname(targetFile))
  fs.appendFileSync(targetFile, `${JSON.stringify(payload)}\n`, 'utf8')
}

function normalizeText(text = '') {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeTimestamp(timestamp) {
  const date = timestamp ? new Date(timestamp) : new Date()
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

function createSyntheticId(record) {
  return crypto
    .createHash('sha1')
    .update(
      JSON.stringify([
        record.timestamp,
        record.conversationKey || record.conversationName || record.roomName || '',
        record.role,
        record.speakerName || record.talkerAlias || record.talkerName || record.receiverName || '',
        record.text,
        record.typeName,
      ]),
    )
    .digest('hex')
}

function ensureRecordId(record = {}) {
  if (record.id) return record
  return {
    ...record,
    id: createSyntheticId(record),
  }
}

function shouldUseOfflineQdrant() {
  return env.WECHAT_OFFLINE_RAG_PROVIDER === 'qdrant'
}

export function tokenizeText(text = '') {
  const normalized = normalizeText(text).toLowerCase()
  if (!normalized) return []

  const tokens = []
  const asciiTokens = normalized.match(/[a-z0-9_]+/g) || []
  tokens.push(...asciiTokens)

  const chineseChunks = normalized.match(/[\u4e00-\u9fff]+/g) || []
  for (const chunk of chineseChunks) {
    if (!chunk) continue
    tokens.push(chunk)
    if (chunk.length === 1) continue
    for (let index = 0; index < chunk.length - 1; index += 1) {
      tokens.push(chunk.slice(index, index + 2))
    }
    if (chunk.length > 3) {
      for (let index = 0; index < chunk.length - 2; index += 1) {
        tokens.push(chunk.slice(index, index + 3))
      }
    }
  }

  return tokens.filter((token) => token && token.length <= 24)
}

function buildNormalizedWeights(tokens = []) {
  if (!tokens.length) return {}

  const counts = new Map()
  for (const token of tokens) {
    counts.set(token, (counts.get(token) || 0) + 1)
  }

  const entries = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, MAX_VECTOR_TERMS)

  const total = entries.reduce((sum, [, count]) => sum + count, 0) || 1
  const weights = {}
  let sumSquares = 0

  for (const [token, count] of entries) {
    const weight = count / total
    weights[token] = weight
    sumSquares += weight * weight
  }

  const norm = Math.sqrt(sumSquares) || 1
  for (const token of Object.keys(weights)) {
    weights[token] = Number((weights[token] / norm).toFixed(6))
  }

  return weights
}

function cosineSimilarity(left = {}, right = {}) {
  const leftEntries = Object.entries(left)
  const rightEntries = Object.entries(right)
  if (!leftEntries.length || !rightEntries.length) return 0

  const [smaller, larger] = leftEntries.length <= rightEntries.length ? [leftEntries, right] : [rightEntries, left]
  let score = 0

  for (const [token, weight] of smaller) {
    score += weight * (larger[token] || 0)
  }

  return score
}

function computeKeywordScore(query, record) {
  const normalizedQuery = normalizeText(query).toLowerCase()
  if (!normalizedQuery) return 0

  const recordText = normalizeText(record.text).toLowerCase()
  if (!recordText) return 0

  const queryTokens = [...new Set(tokenizeText(normalizedQuery).filter((token) => token.length > 1))]
  if (!queryTokens.length) return recordText.includes(normalizedQuery) ? 1 : 0

  let hits = 0
  for (const token of queryTokens) {
    if (record.weights?.[token] || recordText.includes(token)) {
      hits += 1
    }
  }

  const phraseBonus = recordText.includes(normalizedQuery) ? 0.25 : 0
  return Math.min(1, hits / queryTokens.length + phraseBonus)
}

function computeRecencyScore(timestamp) {
  const time = new Date(timestamp).getTime()
  if (Number.isNaN(time)) return 0

  const hours = Math.max(0, (Date.now() - time) / (1000 * 60 * 60))
  return Number((1 / (1 + Math.log10(hours + 1))).toFixed(6))
}

function buildConversationKey({ isRoom, roomId, roomName, talkerId, receiverId, self }) {
  if (isRoom) {
    return `room:${roomId || roomName || 'unknown'}`
  }

  const counterpartyId = self ? receiverId : talkerId
  return `private:${counterpartyId || talkerId || receiverId || 'unknown'}`
}

function buildConversationName({ isRoom, roomName, talkerAlias, talkerName, receiverName, self }) {
  if (isRoom) return roomName || '群聊'
  return self ? receiverName || talkerAlias || talkerName || '好友' : talkerAlias || talkerName || receiverName || '好友'
}

function buildSpeakerName({ self, talkerAlias, talkerName, receiverName }) {
  if (self) return 'assistant'
  return talkerAlias || talkerName || receiverName || 'unknown'
}

export function toVectorRecord(record) {
  const normalizedRecord = ensureRecordId(record)
  const text = normalizeText(normalizedRecord.text || `[${normalizedRecord.typeName || 'Message'}]`).slice(0, MAX_VECTOR_TEXT_LENGTH)
  const weights = buildNormalizedWeights(tokenizeText(text))

  return {
    id: normalizedRecord.id,
    conversationKey: normalizedRecord.conversationKey,
    conversationName: normalizedRecord.conversationName,
    timestamp: normalizedRecord.timestamp,
    role: normalizedRecord.role,
    speakerName: normalizedRecord.speakerName,
    typeName: normalizedRecord.typeName,
    text,
    weights,
  }
}

export function getMessageStorePath(dataDir = '.data/wechat') {
  return path.resolve(process.cwd(), dataDir, MESSAGE_FILE)
}

export function getVectorStorePath(dataDir = '.data/wechat') {
  return path.resolve(process.cwd(), dataDir, VECTOR_FILE)
}

export async function buildWechatMessageRecord(message, bot) {
  const talker = message.talker()
  const receiver = message.to()
  const room = message.room()
  const isText = message.type() === bot.Message.Type.Text
  const roomName = room ? await room.topic() : ''
  const talkerAlias = talker ? await talker.alias() : ''
  const talkerName = talker ? await talker.name() : ''
  const receiverName = receiver ? await receiver.name() : ''
  const roomId = room?.id || ''
  const talkerId = talker?.id || ''
  const receiverId = receiver?.id || ''
  const self = Boolean(talker?.self?.())
  const conversationKey = buildConversationKey({
    isRoom: Boolean(room),
    roomId,
    roomName,
    talkerId,
    receiverId,
    self,
  })

  const record = {
    id: message.id || '',
    timestamp: normalizeTimestamp(),
    type: message.type(),
    typeName: bot.Message.Type[message.type()] || String(message.type()),
    isText,
    isRoom: Boolean(room),
    roomId,
    roomName,
    talkerId,
    talkerName,
    talkerAlias,
    receiverId,
    receiverName,
    conversationKey,
    conversationName: buildConversationName({
      isRoom: Boolean(room),
      roomName,
      talkerAlias,
      talkerName,
      receiverName,
      self,
    }),
    speakerName: buildSpeakerName({ self, talkerAlias, talkerName, receiverName }),
    role: self ? 'assistant' : 'user',
    text: isText ? message.text() : '',
    self,
  }

  record.id = record.id || createSyntheticId(record)
  return record
}

async function syncOfflineVectorStore(record, vectorRecord) {
  if (!shouldUseOfflineQdrant()) return
  if (!vectorRecord.text) return

  try {
    const embedding = await getOllamaEmbedding(vectorRecord.text)
    if (!embedding.length) return
    await upsertQdrantPoints([buildQdrantPoint(record, embedding)])
  } catch (error) {
    console.error('syncOfflineVectorStore error:', error.message)
  }
}

function chunkRecords(records = [], batchSize = 8) {
  const size = Math.max(1, Number(batchSize) || 8)
  const chunks = []

  for (let index = 0; index < records.length; index += size) {
    chunks.push(records.slice(index, index + size))
  }

  return chunks
}

export async function reindexWechatMessagesToQdrant(options = {}) {
  if (!shouldUseOfflineQdrant()) {
    return {
      totalRecords: 0,
      candidates: 0,
      indexed: 0,
      skipped: 0,
      failed: 0,
      resumedSkipped: 0,
      disabled: true,
      failures: [],
    }
  }

  const dataDir = options.dataDir || '.data/wechat'
  const batchSize = Math.max(1, Number(options.batchSize || env.WECHAT_REINDEX_BATCH_SIZE || 8))
  const allRecords = filterWechatMessages(
    loadWechatMessages({
      dataDir,
      limit: Number(options.limit || 0),
    }),
    {
      room: options.room,
      friend: options.friend,
      query: options.query,
      start: options.start,
      end: options.end,
      conversationKey: options.conversationKey,
    },
  )
  const candidates = allRecords.filter((record) => normalizeText(record.text))
  const failures = []
  let indexed = 0
  let skipped = allRecords.length - candidates.length
  let resumedSkipped = 0
  let failed = 0
  let processed = 0

  if (options.reset) {
    const sampleRecord = candidates[0]
    const sampleEmbedding = sampleRecord
      ? await getOllamaEmbedding(sampleRecord.text, {
          model: options.embedModel || env.OLLAMA_EMBED_MODEL,
        })
      : []
    await resetQdrantCollection(sampleEmbedding)
  }

  let recordsToIndex = candidates
  if (options.resume) {
    const indexedIds = await getIndexedRecordIdsFromQdrant({
      limit: Math.max(1000, batchSize * 20),
    })
    recordsToIndex = candidates.filter((record) => !indexedIds.has(record.id))
    resumedSkipped = candidates.length - recordsToIndex.length
  }

  for (const batch of chunkRecords(recordsToIndex, batchSize)) {
    const settled = await Promise.allSettled(
      batch.map(async (record) => {
        const embedding = await getOllamaEmbedding(record.text, {
          model: options.embedModel || env.OLLAMA_EMBED_MODEL,
        })
        if (!embedding.length) {
          return {
            status: 'skipped',
            record,
          }
        }

        return {
          status: 'ok',
          record,
          point: buildQdrantPoint(record, embedding),
        }
      }),
    )

    const points = []
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        if (result.value.status === 'ok') {
          points.push(result.value.point)
          continue
        }
        skipped += 1
        continue
      }

      failed += 1
      if (failures.length < 20) {
        failures.push(result.reason?.message || 'unknown embedding error')
      }
    }

    if (points.length) {
      try {
        await upsertQdrantPoints(points)
        indexed += points.length
      } catch (error) {
        failed += points.length
        if (failures.length < 20) {
          failures.push(error.message)
        }
      }
    }

    processed += batch.length
    if (typeof options.onProgress === 'function') {
      options.onProgress({
        processed,
        total: recordsToIndex.length,
        indexed,
        skipped,
        resumedSkipped,
        failed,
      })
    }
  }

  return {
    totalRecords: allRecords.length,
    candidates: candidates.length,
    indexed,
    skipped,
    resumedSkipped,
    failed,
    disabled: false,
    failures,
  }
}

export async function persistWechatRecord(record, options = {}) {
  const dataDir = options.dataDir || '.data/wechat'
  const storeMessages = options.storeMessages !== false
  if (!storeMessages || !record) return null

  const normalizedRecord = {
    ...record,
    timestamp: normalizeTimestamp(record.timestamp),
    text: typeof record.text === 'string' ? record.text : '',
  }
  normalizedRecord.id = normalizedRecord.id || createSyntheticId(normalizedRecord)

  const vectorRecord = toVectorRecord(normalizedRecord)
  appendJsonLine(getMessageStorePath(dataDir), normalizedRecord)
  appendJsonLine(getVectorStorePath(dataDir), vectorRecord)
  upsertWechatMessage(normalizedRecord, { dataDir })
  upsertWechatVector(vectorRecord, { dataDir })
  await syncOfflineVectorStore(normalizedRecord, vectorRecord)

  return normalizedRecord
}

export async function captureWechatMessage(message, bot, options = {}) {
  const record = await buildWechatMessageRecord(message, bot)
  return persistWechatRecord(record, options)
}

function loadJsonlRecords(targetFile, options = {}) {
  if (!fs.existsSync(targetFile)) return []

  const lines = fs
    .readFileSync(targetFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const limit = Number(options.limit || 0)
  const selectedLines = limit > 0 ? lines.slice(-limit) : lines

  return selectedLines
    .map((line) => {
      try {
        return ensureRecordId(JSON.parse(line))
      } catch (error) {
        return null
      }
    })
    .filter(Boolean)
}

function mergeRecords(preferredRecords = [], fallbackRecords = []) {
  const result = []
  const seen = new Set()

  for (const record of [...preferredRecords, ...fallbackRecords]) {
    const normalizedRecord = ensureRecordId(record)
    if (!normalizedRecord?.id || seen.has(normalizedRecord.id)) continue
    seen.add(normalizedRecord.id)
    result.push(normalizedRecord)
  }

  return result
}

export function loadWechatMessages(options = {}) {
  const dbRecords = loadWechatMessagesFromDb({ dataDir: options.dataDir })
  const fileRecords = loadJsonlRecords(getMessageStorePath(options.dataDir), options)
  const records = mergeRecords(dbRecords, fileRecords).sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime())
  const limit = Number(options.limit || 0)
  return limit > 0 ? records.slice(-limit) : records
}

export function loadWechatVectors(options = {}) {
  const dbRecords = loadWechatVectorsFromDb({ dataDir: options.dataDir })
  const fileRecords = loadJsonlRecords(getVectorStorePath(options.dataDir), options)
  const records = mergeRecords(dbRecords, fileRecords).sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
  const limit = Number(options.limit || 0)
  return limit > 0 ? records.slice(0, limit) : records
}

export function loadConversationMessages(options = {}) {
  const excludeIds = new Set((options.excludeIds || []).filter(Boolean))

  return loadWechatMessages({
    dataDir: options.dataDir,
    limit: options.limit || 0,
  }).filter((record) => {
    if (excludeIds.has(record.id)) return false
    if (options.conversationKey && record.conversationKey !== options.conversationKey) return false
    if (options.roles?.length && !options.roles.includes(record.role)) return false
    return true
  })
}

function rankLocalVectors(query, options = {}) {
  const normalizedQuery = normalizeText(query)
  if (!normalizedQuery) return []

  const queryWeights = buildNormalizedWeights(tokenizeText(normalizedQuery))
  const excludeIds = new Set((options.excludeIds || []).filter(Boolean))
  const minScore = Number(options.minScore ?? 0.08)

  const ranked = loadWechatVectors({
    dataDir: options.dataDir,
    limit: options.searchLimit || 4000,
  })
    .filter((record) => {
      if (excludeIds.has(record.id)) return false
      if (options.conversationKey && record.conversationKey !== options.conversationKey) return false
      return true
    })
    .map((record) => {
      const vectorScore = cosineSimilarity(queryWeights, record.weights || {})
      const keywordScore = computeKeywordScore(normalizedQuery, record)
      const recencyScore = computeRecencyScore(record.timestamp)
      const score = Number((vectorScore * 0.72 + keywordScore * 0.23 + recencyScore * 0.05).toFixed(6))
      return {
        ...record,
        vectorScore,
        keywordScore,
        recencyScore,
        score,
        source: 'local',
      }
    })
    .filter((record) => record.score >= minScore || record.keywordScore >= 0.3)
    .sort((left, right) => right.score - left.score || new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())

  return ranked.slice(0, options.limit || 10)
}

export async function searchWechatVectors(query, options = {}) {
  if (shouldUseOfflineQdrant()) {
    try {
      const embedding = await getOllamaEmbedding(query)
      if (embedding.length) {
        const qdrantResults = await searchQdrant(embedding, options)
        if (qdrantResults.length) {
          return qdrantResults
        }
      }
    } catch (error) {
      console.error('searchWechatVectors qdrant fallback:', error.message)
    }
  }

  return rankLocalVectors(query, options)
}

export function filterWechatMessages(records, filters = {}) {
  const startTime = filters.start ? new Date(filters.start).getTime() : null
  const endTime = filters.end ? new Date(filters.end).getTime() : null
  const query = filters.query ? filters.query.toLowerCase() : ''

  return records.filter((record) => {
    if (filters.room && record.roomName !== filters.room) return false
    if (filters.friend) {
      const names = [record.talkerName, record.talkerAlias, record.receiverName, record.conversationName].filter(Boolean)
      if (!names.includes(filters.friend)) return false
    }
    if (filters.conversationKey && record.conversationKey !== filters.conversationKey) return false
    if (
      query &&
      !String(record.text || '')
        .toLowerCase()
        .includes(query)
    )
      return false
    if (startTime && new Date(record.timestamp).getTime() < startTime) return false
    if (endTime && new Date(record.timestamp).getTime() > endTime) return false
    return true
  })
}
