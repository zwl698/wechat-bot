import axios from 'axios'
import { env } from '../config/env.js'

function trimTrailingSlash(url = '') {
  return String(url || '').replace(/\/+$/, '')
}

function deriveOllamaBaseUrl() {
  if (env.OLLAMA_BASE_URL) return trimTrailingSlash(env.OLLAMA_BASE_URL)
  if (env.OLLAMA_URL) {
    return trimTrailingSlash(String(env.OLLAMA_URL).replace(/\/api\/.+$/, ''))
  }
  return 'http://127.0.0.1:11434'
}

function getPrimaryEmbedUrl() {
  return env.OLLAMA_EMBED_URL || `${deriveOllamaBaseUrl()}/api/embed`
}

function getFallbackEmbedUrl() {
  return `${deriveOllamaBaseUrl()}/api/embeddings`
}

export async function getOllamaEmbedding(input, options = {}) {
  const text = String(input || '').trim()
  if (!text) return []

  const model = options.model || env.OLLAMA_EMBED_MODEL || 'nomic-embed-text'

  const primaryResponse = await axios({
    method: 'post',
    url: getPrimaryEmbedUrl(),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    data: {
      model,
      input: text,
    },
    validateStatus: () => true,
  })

  if (primaryResponse.status >= 200 && primaryResponse.status < 300) {
    const vector = primaryResponse.data?.embeddings?.[0] || primaryResponse.data?.embedding || []
    return Array.isArray(vector) ? vector : []
  }

  const fallbackResponse = await axios({
    method: 'post',
    url: getFallbackEmbedUrl(),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    data: {
      model,
      prompt: text,
    },
    validateStatus: () => true,
  })

  if (fallbackResponse.status >= 200 && fallbackResponse.status < 300) {
    const vector = fallbackResponse.data?.embedding || fallbackResponse.data?.embeddings?.[0] || []
    return Array.isArray(vector) ? vector : []
  }

  throw new Error(
    `Ollama embedding request failed: ${primaryResponse.status}/${fallbackResponse.status} ${
      fallbackResponse.data?.error || primaryResponse.data?.error || ''
    }`.trim(),
  )
}
