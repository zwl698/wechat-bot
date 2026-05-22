import assert from 'assert'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { env } from '../../config/env.js'
import {
  loadConversationMessages,
  loadWechatMessages,
  loadWechatVectors,
  persistWechatRecord,
  reindexWechatMessagesToQdrant,
  searchWechatVectors,
} from './messageStore.js'

function createEmbedding(text = '') {
  const values = [0, 0, 0, 0]
  for (const [index, char] of Array.from(String(text || '').toLowerCase()).entries()) {
    values[index % values.length] += (char.codePointAt(0) || 0) % 97
  }

  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1
  return values.map((value) => Number((value / norm).toFixed(6)))
}

function cosineSimilarity(left = [], right = []) {
  const size = Math.min(left.length, right.length)
  let score = 0
  for (let index = 0; index < size; index += 1) {
    score += Number(left[index] || 0) * Number(right[index] || 0)
  }
  return Number(score.toFixed(6))
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      if (!body) {
        resolve({})
        return
      }

      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
  })
  res.end(JSON.stringify(payload))
}

function startServer(handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      writeJson(res, 500, { error: error.message })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
      })
    })
  })
}

async function startFakeServices() {
  const qdrantState = {
    collections: new Map(),
  }

  const qdrant = await startServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1')
    const parts = requestUrl.pathname.split('/').filter(Boolean)

    if (parts[0] !== 'collections' || !parts[1]) {
      writeJson(res, 404, { error: 'not found' })
      return
    }

    const collectionName = decodeURIComponent(parts[1])
    const collection = qdrantState.collections.get(collectionName)

    if (req.method === 'GET' && parts.length === 2) {
      if (!collection) {
        writeJson(res, 404, { status: 'missing' })
        return
      }
      writeJson(res, 200, { result: { status: 'green' } })
      return
    }

    if (req.method === 'PUT' && parts.length === 2) {
      const body = await readJsonBody(req)
      qdrantState.collections.set(collectionName, {
        config: body.vectors || {},
        points: new Map(),
      })
      writeJson(res, 200, { result: true })
      return
    }

    if (req.method === 'DELETE' && parts.length === 2) {
      qdrantState.collections.delete(collectionName)
      writeJson(res, 200, { result: true })
      return
    }

    if (!collection) {
      writeJson(res, 404, { error: 'collection missing' })
      return
    }

    if (req.method === 'PUT' && parts[2] === 'points') {
      const body = await readJsonBody(req)
      for (const point of body.points || []) {
        collection.points.set(String(point.id), point)
      }
      writeJson(res, 200, { result: { status: 'acknowledged' } })
      return
    }

    if (req.method === 'POST' && parts[2] === 'points' && parts[3] === 'scroll') {
      const body = await readJsonBody(req)
      const points = [...collection.points.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)))
      const offset = body.offset == null ? null : String(body.offset)
      const startIndex = offset ? points.findIndex((point) => String(point.id) === offset) + 1 : 0
      const selected = points.slice(Math.max(0, startIndex), Math.max(0, startIndex) + Number(body.limit || 10))
      const nextPoint = points[Math.max(0, startIndex) + selected.length]
      writeJson(res, 200, {
        result: {
          points: selected,
          next_page_offset: nextPoint ? String(selected[selected.length - 1].id) : null,
        },
      })
      return
    }

    if (req.method === 'POST' && parts[2] === 'points' && parts[3] === 'search') {
      const body = await readJsonBody(req)
      const must = body.filter?.must || []
      const mustNot = body.filter?.must_not || []
      const results = [...collection.points.values()]
        .filter((point) => {
          return must.every((item) => {
            if (!item?.key) return true
            if (item.match?.value !== undefined) {
              return point.payload?.[item.key] === item.match.value
            }
            return true
          })
        })
        .filter((point) => {
          return mustNot.every((item) => {
            if (!item?.key) return true
            if (Array.isArray(item.match?.any)) {
              return !item.match.any.includes(point.payload?.[item.key])
            }
            return true
          })
        })
        .map((point) => ({
          ...point,
          score: cosineSimilarity(body.vector || [], point.vector || []),
        }))
        .filter((point) => point.score >= Number(body.score_threshold ?? 0))
        .sort((left, right) => right.score - left.score)
        .slice(0, Number(body.limit || 10))

      writeJson(res, 200, { result: results })
      return
    }

    writeJson(res, 404, { error: 'unsupported qdrant route' })
  })

  const ollama = await startServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1')
    if (req.method !== 'POST' || !['/api/embed', '/api/embeddings'].includes(requestUrl.pathname)) {
      writeJson(res, 404, { error: 'not found' })
      return
    }

    const body = await readJsonBody(req)
    const input = body.input || body.prompt || ''
    if (String(input).includes('FORCE_EMBED_ERROR')) {
      writeJson(res, 500, { error: 'forced embedding error' })
      return
    }

    const embedding = createEmbedding(input)
    if (requestUrl.pathname === '/api/embed') {
      writeJson(res, 200, { embeddings: [embedding] })
      return
    }

    writeJson(res, 200, { embedding })
  })

  return {
    qdrant,
    ollama,
    state: qdrantState,
  }
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function snapshotEnv(keys = []) {
  return Object.fromEntries(keys.map((key) => [key, env[key]]))
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
}

function buildRecord(overrides = {}) {
  return {
    id: overrides.id,
    timestamp: overrides.timestamp,
    type: 7,
    typeName: overrides.typeName || 'Text',
    isText: overrides.isText ?? true,
    isRoom: true,
    roomId: 'room-1',
    roomName: '研发群',
    talkerId: overrides.talkerId || 'user-1',
    talkerName: overrides.talkerName || 'Alice',
    talkerAlias: overrides.talkerAlias || overrides.talkerName || 'Alice',
    receiverId: 'assistant-1',
    receiverName: 'bot',
    conversationKey: overrides.conversationKey || 'room:room-1',
    conversationName: overrides.conversationName || '研发群',
    speakerName: overrides.speakerName || overrides.talkerName || 'Alice',
    role: overrides.role || 'user',
    text: overrides.text ?? '',
    self: overrides.self ?? false,
  }
}

function getCollection(state, name) {
  const collection = state.collections.get(name)
  assert.ok(collection, `missing qdrant collection: ${name}`)
  return collection
}

function runChildProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (status) => {
      resolve({
        status,
        stdout,
        stderr,
      })
    })
  })
}

async function main() {
  const projectRoot = process.cwd()
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-bot-rag-'))
  const services = await startFakeServices()
  const envKeys = [
    'WECHAT_DATA_DIR',
    'WECHAT_OFFLINE_RAG_PROVIDER',
    'QDRANT_URL',
    'QDRANT_COLLECTION',
    'QDRANT_VECTOR_SIZE',
    'QDRANT_DISTANCE',
    'OLLAMA_BASE_URL',
    'OLLAMA_EMBED_MODEL',
    'WECHAT_REINDEX_BATCH_SIZE',
  ]
  const envSnapshot = snapshotEnv(envKeys)

  try {
    env.WECHAT_DATA_DIR = tempDir
    env.WECHAT_OFFLINE_RAG_PROVIDER = 'local'
    env.QDRANT_URL = services.qdrant.url
    env.QDRANT_COLLECTION = 'wechat_test_messages'
    env.QDRANT_VECTOR_SIZE = '4'
    env.QDRANT_DISTANCE = 'Cosine'
    env.OLLAMA_BASE_URL = services.ollama.url
    env.OLLAMA_EMBED_MODEL = 'test-embed'
    env.WECHAT_REINDEX_BATCH_SIZE = '2'

    const records = [
      buildRecord({
        id: 'msg-1',
        timestamp: '2026-05-20T08:00:00.000Z',
        talkerId: 'user-a',
        talkerName: 'Alice',
        text: '今天登录故障已经恢复，下午一起复盘。',
      }),
      buildRecord({
        id: 'msg-2',
        timestamp: '2026-05-20T09:00:00.000Z',
        talkerId: 'user-b',
        talkerName: 'Bob',
        text: '明天继续排查支付链路，顺手补一下监控。',
      }),
      buildRecord({
        id: 'msg-3',
        timestamp: '2026-05-20T10:00:00.000Z',
        talkerId: 'user-c',
        talkerName: 'Carol',
        typeName: 'Image',
        isText: false,
        text: '',
      }),
    ]

    for (const record of records) {
      await persistWechatRecord(record, {
        dataDir: tempDir,
        storeMessages: true,
      })
    }

    env.WECHAT_OFFLINE_RAG_PROVIDER = 'qdrant'

    const progressEvents = []
    const historyRecords = loadWechatMessages({ dataDir: tempDir })
    assert.equal(historyRecords.length, 3)
    assert.ok(historyRecords.every((record) => record.id))

    const roomConversation = loadConversationMessages({
      dataDir: tempDir,
      conversationKey: 'room:room-1',
    })
    assert.equal(roomConversation.length, 3)

    const storedVectors = loadWechatVectors({ dataDir: tempDir })
    assert.equal(storedVectors.length, 3)
    assert.ok(storedVectors.every((record) => record.id))

    const localSearchResults = await searchWechatVectors('登录故障恢复', {
      dataDir: tempDir,
      limit: 2,
    })
    assert.ok(localSearchResults.length >= 1)
    assert.equal(localSearchResults[0].id, 'msg-1')
    assert.equal(localSearchResults[0].source, 'local')

    const firstResult = await reindexWechatMessagesToQdrant({
      dataDir: tempDir,
      batchSize: 2,
      resume: true,
      onProgress(progress) {
        progressEvents.push(progress)
      },
    })

    assert.equal(firstResult.disabled, false)
    assert.equal(firstResult.totalRecords, 3)
    assert.equal(firstResult.candidates, 2)
    assert.equal(firstResult.indexed, 2)
    assert.equal(firstResult.skipped, 1)
    assert.equal(firstResult.resumedSkipped, 0)
    assert.equal(firstResult.failed, 0)
    assert.deepEqual(firstResult.failures, [])
    assert.equal(progressEvents.length, 1)
    assert.equal(progressEvents[0].processed, 2)
    assert.equal(progressEvents[0].total, 2)
    assert.equal(getCollection(services.state, env.QDRANT_COLLECTION).points.size, 2)

    const qdrantSearchResults = await searchWechatVectors('登录故障恢复', {
      dataDir: tempDir,
      limit: 2,
    })
    assert.ok(qdrantSearchResults.length >= 1)
    assert.equal(qdrantSearchResults[0].id, 'msg-1')
    assert.equal(qdrantSearchResults[0].source, 'qdrant')

    const resumeResult = await reindexWechatMessagesToQdrant({
      dataDir: tempDir,
      batchSize: 2,
      resume: true,
    })

    assert.equal(resumeResult.indexed, 0)
    assert.equal(resumeResult.skipped, 1)
    assert.equal(resumeResult.resumedSkipped, 2)
    assert.equal(resumeResult.failed, 0)

    const collection = getCollection(services.state, env.QDRANT_COLLECTION)
    collection.points.set('legacy-point', {
      id: 'legacy-point',
      vector: createEmbedding('legacy history'),
      payload: {
        recordId: 'legacy-record',
        conversationKey: 'room:legacy',
        conversationName: '旧会话',
        timestamp: '2026-05-01T00:00:00.000Z',
        role: 'user',
        speakerName: 'legacy',
        typeName: 'Text',
        text: 'legacy history',
      },
    })

    const resetResult = await reindexWechatMessagesToQdrant({
      dataDir: tempDir,
      batchSize: 2,
      reset: true,
    })

    assert.equal(resetResult.indexed, 2)
    assert.equal(resetResult.skipped, 1)
    assert.equal(resetResult.failed, 0)
    assert.equal(getCollection(services.state, env.QDRANT_COLLECTION).points.size, 2)
    assert.ok([...getCollection(services.state, env.QDRANT_COLLECTION).points.values()].every((point) => point.payload?.recordId !== 'legacy-record'))

    const childEnv = {
      ...process.env,
      WECHAT_DATA_DIR: tempDir,
      WECHAT_OFFLINE_RAG_PROVIDER: 'qdrant',
      QDRANT_URL: services.qdrant.url,
      QDRANT_COLLECTION: 'wechat_cli_messages',
      QDRANT_VECTOR_SIZE: '4',
      QDRANT_DISTANCE: 'Cosine',
      OLLAMA_BASE_URL: services.ollama.url,
      OLLAMA_EMBED_MODEL: 'test-embed',
      WECHAT_REINDEX_BATCH_SIZE: '2',
    }

    const cliFirst = await runChildProcess(process.execPath, ['./cli.js', 'wechat:reindex', '--resume', '--batch-size', '2'], {
      cwd: projectRoot,
      env: childEnv,
    })

    assert.equal(cliFirst.status, 0, cliFirst.stderr)
    assert.match(cliFirst.stdout, /Qdrant 重建索引完成/)
    assert.match(cliFirst.stdout, /"indexed": 2/)
    assert.match(cliFirst.stdout, /"resumedSkipped": 0/)
    assert.match(cliFirst.stdout, /\[reindex\] 2\/2 indexed=2 skipped=1 resumeSkipped=0 failed=0/)

    const cliResume = await runChildProcess(process.execPath, ['./cli.js', 'wechat:reindex', '--resume', '--batch-size', '2'], {
      cwd: projectRoot,
      env: childEnv,
    })

    assert.equal(cliResume.status, 0, cliResume.stderr)
    assert.match(cliResume.stdout, /Qdrant 重建索引完成/)
    assert.match(cliResume.stdout, /"indexed": 0/)
    assert.match(cliResume.stdout, /"resumedSkipped": 2/)

    console.log('wechat rag tests passed')
  } finally {
    restoreEnv(envSnapshot)
    await closeServer(services.qdrant.server)
    await closeServer(services.ollama.server)
  }
}

await main()
