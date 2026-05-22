import { getWechatRuntimeConfig } from '../config/env.js'
import { loadConversationMessages, searchWechatVectors } from '../platforms/wechat/messageStore.js'

const DEFAULT_SECTION_MAX_CHARS = 1000

function compactWhitespace(text = '') {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function clipText(text = '', maxChars = 180) {
  const normalized = compactWhitespace(text)
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`
}

function summarizeRecords(records = [], maxChars, label) {
  if (!records.length) return `${label}：无。`

  const lines = []
  let total = 0

  for (const record of records) {
    const speaker = record.role === 'assistant' ? '我' : record.speakerName || record.conversationName || '对方'
    const text = record.text ? clipText(record.text, 120) : `[${record.typeName || '消息'}]`
    const line = `- ${speaker}: ${text}`
    if (total + line.length + 1 > maxChars) break
    lines.push(line)
    total += line.length + 1
  }

  if (!lines.length) {
    const fallback = records[records.length - 1]
    return `${label}：${fallback ? `${fallback.speakerName || '对方'}说“${clipText(fallback.text, 80)}”` : '无。'}`
  }

  return `${label}：\n${lines.join('\n')}`
}

function renderHistory(records = [], maxChars = DEFAULT_SECTION_MAX_CHARS) {
  if (!records.length) return '最近对话：无。'

  const lines = records.map((record) => {
    const speaker = record.role === 'assistant' ? '我' : record.speakerName || record.conversationName || '对方'
    const text = record.text ? compactWhitespace(record.text) : `[${record.typeName || '消息'}]`
    return `- ${speaker}: ${text}`
  })

  const full = `最近对话：\n${lines.join('\n')}`
  if (full.length <= maxChars) return full
  return summarizeRecords(records, maxChars, '最近对话摘要')
}

function renderRag(records = [], maxChars = DEFAULT_SECTION_MAX_CHARS) {
  if (!records.length) return 'RAG检索：无明确相关历史。'

  const lines = records.map((record, index) => {
    const source = record.conversationName || record.speakerName || '历史消息'
    const text = record.text ? compactWhitespace(record.text) : `[${record.typeName || '消息'}]`
    return `- ${index + 1}. ${source} | ${record.timestamp}: ${text}`
  })

  const full = `RAG检索：\n${lines.join('\n')}`
  if (full.length <= maxChars) return full
  return summarizeRecords(records, maxChars, 'RAG检索摘要')
}

function dedupeRecords(records = []) {
  const seen = new Set()
  return records.filter((record) => {
    if (!record?.id || seen.has(record.id)) return false
    seen.add(record.id)
    return true
  })
}

export function buildWechatReplyPrompt({
  question,
  historyRecords = [],
  ragRecords = [],
  contactName = '',
  conversationName = '',
  persona = '',
  sectionMaxChars = DEFAULT_SECTION_MAX_CHARS,
}) {
  const historyText = renderHistory(historyRecords, sectionMaxChars)
  const ragText = renderRag(ragRecords, sectionMaxChars)
  const userQuestion = compactWhitespace(question)

  return [
    '你现在是在微信里和朋友聊天。',
    `固定人设：${persona}`,
    '回复要求：自然、像真人、别机器腔；优先直接回答，再结合上下文补充；可以轻松一点，但别油腻；除非对方明确要求，否则不要分很多条。',
    `当前聊天对象：${contactName || '微信好友'}`,
    `当前会话：${conversationName || contactName || '私聊'}`,
    historyText,
    ragText,
    `用户这次的问题：${userQuestion}`,
    '请基于最近对话和检索到的相关历史来回答；如果历史里没有足够信息，就正常回答，不要编造“你之前说过”。',
  ].join('\n\n')
}

export async function buildWechatContext(options = {}) {
  const config = getWechatRuntimeConfig()
  const historyLimit = options.historyLimit || config.historyLimit
  const ragLimit = options.ragLimit || config.ragLimit
  const searchLimit = options.searchLimit || config.vectorSearchLimit
  const sectionMaxChars = options.sectionMaxChars || config.contextCompressLimit || DEFAULT_SECTION_MAX_CHARS
  const currentMessageId = options.currentMessageId || ''

  const historyRecords = loadConversationMessages({
    dataDir: options.dataDir || config.dataDir,
    conversationKey: options.conversationKey,
    excludeIds: currentMessageId ? [currentMessageId] : [],
    limit: Math.max(historyLimit * 6, 60),
  }).slice(-historyLimit)

  const ragRecords = dedupeRecords(
    await searchWechatVectors(options.question, {
      dataDir: options.dataDir || config.dataDir,
      conversationKey: options.conversationKey,
      excludeIds: [currentMessageId, ...historyRecords.map((record) => record.id)],
      limit: ragLimit,
      searchLimit,
    }),
  )

  return {
    historyRecords,
    ragRecords,
    prompt: buildWechatReplyPrompt({
      question: options.question,
      historyRecords,
      ragRecords,
      contactName: options.contactName,
      conversationName: options.conversationName,
      persona: options.persona || config.fixedPersona,
      sectionMaxChars,
    }),
  }
}
