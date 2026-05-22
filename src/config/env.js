import dotenv from 'dotenv'

const dotenvResult = dotenv.config()

function readNumberEnv(key, fallback) {
  const raw = process.env[key] ?? dotenvResult.parsed?.[key]
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export const env = {
  ...(dotenvResult.parsed || {}),
  ...process.env,
}

export function readCsvEnv(key) {
  return (env[key] || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function getWechatRuntimeConfig() {
  return {
    botName: env.BOT_NAME || '',
    autoReplyPrefix: env.AUTO_REPLY_PREFIX || '',
    aliasWhiteList: readCsvEnv('ALIAS_WHITELIST'),
    roomWhiteList: readCsvEnv('ROOM_WHITELIST'),
    dataDir: env.WECHAT_DATA_DIR || '.data/wechat',
    storeMessages: env.WECHAT_STORE_MESSAGES !== 'false',
    commandPrefix: env.BOT_COMMAND_PREFIX || '/',
    enableRemoteOpenCli: env.ENABLE_REMOTE_OPENCLI === 'true',
    historyLimit: readNumberEnv('WECHAT_CONTEXT_HISTORY_LIMIT', 10),
    ragLimit: readNumberEnv('WECHAT_RAG_LIMIT', 10),
    contextCompressLimit: readNumberEnv('WECHAT_CONTEXT_COMPRESS_LIMIT', 1000),
    vectorSearchLimit: readNumberEnv('WECHAT_VECTOR_SEARCH_LIMIT', 4000),
    offlineRagProvider: env.WECHAT_OFFLINE_RAG_PROVIDER || 'local',
    qdrantUrl: env.QDRANT_URL || 'http://127.0.0.1:6333',
    qdrantCollection: env.QDRANT_COLLECTION || 'wechat_messages',
    ollamaBaseUrl: env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
    ollamaEmbedModel: env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
    reindexBatchSize: readNumberEnv('WECHAT_REINDEX_BATCH_SIZE', 8),
    fixedPersona:
      env.WECHAT_FIXED_PERSONA || '你是用户在微信里的老朋友，性格开朗活泼，偶尔有点小调皮，但分寸感在线。回复像真人聊天，别端着，也别用客服腔。',
  }
}

export function getLarkRuntimeConfig() {
  return {
    bin: env.LARK_CLI_BIN || 'lark-cli',
    defaultIdentity: env.LARK_DEFAULT_IDENTITY || 'user',
  }
}

export function getOpenCliRuntimeConfig() {
  return {
    bin: env.OPENCLI_BIN || '',
    npmPackage: env.OPENCLI_NPM_PACKAGE || '@jackwener/opencli',
  }
}

export function getPiRuntimeConfig() {
  return {
    bin: env.PI_BIN || '',
    npmPackage: env.PI_NPM_PACKAGE || '@earendil-works/pi-coding-agent',
    agentArgs: env.PI_AGENT_ARGS || '--print --no-session',
  }
}
