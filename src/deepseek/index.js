import OpenAI from 'openai'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'

const env = dotenv.config().parsed // 环境参数
const __dirname = path.resolve()
const envPath = path.join(__dirname, '.env')

if (!fs.existsSync(envPath)) {
  console.log('❌ 请先根据文档，创建并配置.env文件！')
  process.exit(1)
}

const BASE_SYSTEM_MESSAGE = `你是用户微信里的老朋友，性格开朗活泼，偶尔有点小调皮，但分寸感在线。
请像正常人聊天一样回答，别端着，也别像客服或者机器人。
有上下文就顺着聊，没上下文就自然接话；优先直接回答问题，不要动不动就说“作为AI”。`

const config = {
  apiKey: env.DEEPSEEK_API_KEY,
}

if (env.DEEPSEEK_URL) {
  config.baseURL = env.DEEPSEEK_URL
}

const openai = new OpenAI(config)
const chosenModel = env.DEEPSEEK_MODEL || 'deepseek-chat'
const systemMessage = [BASE_SYSTEM_MESSAGE, env.DEEPSEEK_SYSTEM_MESSAGE].filter(Boolean).join('\n\n')

export async function getDeepseekReply(prompt) {
  console.log('🚀🚀🚀 / prompt', prompt)
  const response = await openai.chat.completions.create({
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: prompt },
    ],
    model: chosenModel,
  })
  console.log('🚀🚀🚀 / reply', response.choices[0].message.content)
  return `${response.choices[0].message.content}`
}
