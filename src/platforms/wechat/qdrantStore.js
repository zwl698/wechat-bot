import axios from 'axios'
import crypto from 'crypto'
import { env } from '../../config/env.js'

const DEFAULT_COLLECTION = 'wechat_messages'
const DEFAULT_DISTANCE = 'Cosine'
const DEFAULT_DIMENSION = 768
const UPSERT_BATCH_SIZE = 32

function trimTrailingSlash(url = '') {
  return String(url || '').replace(/\/+$/, '')
}

function buildBaseUrl() {
  return trimTrailingSlash(env.QDRANT_URL || 'http://127.0.0.1:6333')
}

function buildHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }

  if (env.QDRANT_API_KEY) {
    headers['api-key'] = env.QDRANT_API_KEY
  }

  return headers
}

function getCollectionName() {
  return env.QDRANT_COLLECTION || DEFAULT_COLLECTION
}

function getVectorDimension(vector = []) {
  return Number(env.QDRANT_VECTOR_SIZE || vector.length || DEFAULT_DIMENSION)
}

function getDistance() {
  return env.QDRANT_DISTANCE || DEFAULT_DISTANCE
}

function shouldEnableQdrant() {
  return env.WECHAT_OFFLINE_RAG_PROVIDER === 'qdrant'
}

function createPointId(recordId = '') {
  const normalized = String(recordId || '').trim()
  if (!normalized) return crypto.randomUUID()

  const hash = crypto.createHash('md5').update(normalized).digest('hex')
  const variant = ['8', '9', 'a', 'b'][parseInt(hash[16], 16) % 4]
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

function normalizeNumberArray(vector = []) {
  return vector.map((value) => Number(value)).filter((value) => Number.isFinite(value))
}

async function qdrantRequest(method, requestPath, data) {
  const response = await axios({
    method,
    url: `${buildBaseUrl()}${requestPath}`,
    headers: buildHeaders(),
    data,
    validateStatus: () => true,
  })

  if (response.status >= 200 && response.status < 300) {
    return response.data
  }

  throw new Error(`Qdrant request failed ${response.status}: ${JSON.stringify(response.data || {})}`)
}

export async function ensureQdrantCollection(vector = []) {
  if (!shouldEnableQdrant()) return

  const collectionName = getCollectionName()
  const vectorSize = getVectorDimension(vector)

  const existing = await axios({
    method: 'get',
    url: `${buildBaseUrl()}/collections/${collectionName}`,
    headers: buildHeaders(),
    validateStatus: () => true,
  })

  if (existing.status >= 200 && existing.status < 300) {
    return
  }

  if (existing.status !== 404) {
    throw new Error(`Qdrant collection check failed ${existing.status}: ${JSON.stringify(existing.data || {})}`)
  }

  await qdrantRequest('put', `/collections/${collectionName}`, {
    vectors: {
      size: vectorSize,
      distance: getDistance(),
    },
  })
}

export async function resetQdrantCollection(vector = []) {
  if (!shouldEnableQdrant()) return

  const collectionName = getCollectionName()
  const existing = await axios({
    method: 'get',
    url: `${buildBaseUrl()}/collections/${collectionName}`,
    headers: buildHeaders(),
    validateStatus: () => true,
  })

  if (existing.status >= 200 && existing.status < 300) {
    await qdrantRequest('delete', `/collections/${collectionName}`)
  } else if (existing.status !== 404) {
    throw new Error(`Qdrant collection reset check failed ${existing.status}: ${JSON.stringify(existing.data || {})}`)
  }

  await ensureQdrantCollection(vector)
}

export async function getIndexedRecordIdsFromQdrant(options = {}) {
  if (!shouldEnableQdrant()) return new Set()

  const collectionName = getCollectionName()
  const existing = await axios({
    method: 'get',
    url: `${buildBaseUrl()}/collections/${collectionName}`,
    headers: buildHeaders(),
    validateStatus: () => true,
  })

  if (existing.status === 404) {
    return new Set()
  }

  if (existing.status < 200 || existing.status >= 300) {
    throw new Error(`Qdrant collection ids check failed ${existing.status}: ${JSON.stringify(existing.data || {})}`)
  }

  const limit = Math.max(1, Number(options.limit || 1000))
  let offset = null
  const ids = new Set()

  while (true) {
    const response = await qdrantRequest('post', `/collections/${collectionName}/points/scroll`, {
      limit,
      offset,
      with_payload: ['recordId'],
      with_vector: false,
    })

    for (const point of response.result?.points || []) {
      const recordId = point.payload?.recordId
      if (recordId) ids.add(recordId)
    }

    offset = response.result?.next_page_offset || null
    if (!offset) break
  }

  return ids
}

export function buildQdrantPoint(record, vector = []) {
  const normalizedVector = normalizeNumberArray(vector)
  return {
    id: createPointId(record.id),
    vector: normalizedVector,
    payload: {
      recordId: record.id,
      conversationKey: record.conversationKey,
      conversationName: record.conversationName,
      timestamp: record.timestamp,
      role: record.role,
      speakerName: record.speakerName,
      typeName: record.typeName,
      text: record.text,
    },
  }
}

export async function upsertQdrantPoints(points = []) {
  if (!shouldEnableQdrant()) return
  if (!points.length) return

  const normalized = points.filter((point) => Array.isArray(point.vector) && point.vector.length > 0)
  if (!normalized.length) return

  await ensureQdrantCollection(normalized[0].vector)

  for (let index = 0; index < normalized.length; index += UPSERT_BATCH_SIZE) {
    const batch = normalized.slice(index, index + UPSERT_BATCH_SIZE)
    await qdrantRequest('put', `/collections/${getCollectionName()}/points?wait=true`, {
      points: batch,
    })
  }
}

export async function searchQdrant(queryVector = [], options = {}) {
  if (!shouldEnableQdrant()) return []

  const vector = normalizeNumberArray(queryVector)
  if (!vector.length) return []

  await ensureQdrantCollection(vector)

  const must = []
  const mustNot = []
  if (options.conversationKey) {
    must.push({
      key: 'conversationKey',
      match: { value: options.conversationKey },
    })
  }

  if (options.excludeIds?.length) {
    mustNot.push({
      key: 'recordId',
      match: { any: options.excludeIds.filter(Boolean) },
    })
  }

  const response = await qdrantRequest('post', `/collections/${getCollectionName()}/points/search`, {
    vector,
    limit: options.limit || 10,
    with_payload: true,
    score_threshold: Number(options.minScore ?? 0.35),
    filter: must.length || mustNot.length ? { must, must_not: mustNot } : undefined,
  })

  return (response.result || []).map((item) => ({
    id: item.payload?.recordId || String(item.id),
    conversationKey: item.payload?.conversationKey || '',
    conversationName: item.payload?.conversationName || '',
    timestamp: item.payload?.timestamp || '',
    role: item.payload?.role || '',
    speakerName: item.payload?.speakerName || '',
    typeName: item.payload?.typeName || '',
    text: item.payload?.text || '',
    score: Number(item.score || 0),
    source: 'qdrant',
  }))
}
