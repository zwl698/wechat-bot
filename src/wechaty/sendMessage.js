import crypto from 'crypto'
import { getServe } from './serve.js'
import { getWechatRuntimeConfig } from '../config/env.js'
import { handleWechatCommand } from '../platforms/wechat/commandRouter.js'
import { persistWechatRecord } from '../platforms/wechat/messageStore.js'
import { buildWechatContext } from './contextBuilder.js'

function sanitizeQuestion(content = '', botName = '', autoReplyPrefix = '') {
  return String(content || '')
    .replace(botName, '')
    .replace(autoReplyPrefix, '')
    .trim()
}

function buildAssistantRecord(baseRecord, response) {
  const timestamp = new Date().toISOString()
  const text = String(response || '').trim()

  return {
    id: crypto
      .createHash('sha1')
      .update(JSON.stringify([baseRecord.conversationKey, 'assistant', timestamp, text]))
      .digest('hex'),
    timestamp,
    type: 7,
    typeName: 'Text',
    isText: true,
    isRoom: baseRecord.isRoom,
    roomId: baseRecord.roomId || '',
    roomName: baseRecord.roomName || '',
    talkerId: baseRecord.receiverId || 'assistant',
    talkerName: baseRecord.receiverName || 'assistant',
    talkerAlias: '',
    receiverId: baseRecord.talkerId || '',
    receiverName: baseRecord.talkerName || baseRecord.talkerAlias || baseRecord.conversationName || '',
    conversationKey: baseRecord.conversationKey,
    conversationName: baseRecord.conversationName,
    speakerName: 'assistant',
    role: 'assistant',
    text,
    self: true,
  }
}

async function generateReply(question, meta = {}, serviceType) {
  const config = getWechatRuntimeConfig()
  const getReply = getServe(serviceType)
  const context = await buildWechatContext({
    question,
    dataDir: meta.dataDir || config.dataDir,
    conversationKey: meta.capturedRecord?.conversationKey,
    conversationName: meta.capturedRecord?.conversationName || meta.roomName || meta.alias || meta.name,
    contactName: meta.alias || meta.name || meta.roomName,
    currentMessageId: meta.capturedRecord?.id,
    persona: config.fixedPersona,
    historyLimit: config.historyLimit,
    ragLimit: config.ragLimit,
    searchLimit: config.vectorSearchLimit,
  })

  const response = await getReply(context.prompt)
  return String(response || '').trim()
}

async function replyAndStore(target, response, meta = {}, runtimeConfig = {}) {
  if (!response) return
  await target.say(response)

  if (meta.capturedRecord) {
    await persistWechatRecord(buildAssistantRecord(meta.capturedRecord, response), {
      dataDir: meta.dataDir || runtimeConfig.dataDir,
      storeMessages: runtimeConfig.storeMessages,
    })
  }
}

/**
 * 默认消息发送
 * @param msg
 * @param bot
 * @param ServiceType 服务类型 'GPT' | 'Kimi'
 * @returns {Promise<void>}
 */
export async function defaultMessage(msg, bot, ServiceType = 'deepseek', meta = {}) {
  const runtimeConfig = getWechatRuntimeConfig()
  const { botName, autoReplyPrefix, aliasWhiteList, roomWhiteList, commandPrefix } = runtimeConfig
  const contact = msg.talker() // 发消息人
  const content = msg.text() // 消息内容
  const room = msg.room() // 是否是群消息
  const roomName = (await room?.topic()) || null // 群名称
  const alias = (await contact.alias()) || (await contact.name()) // 发消息人昵称
  const remarkName = await contact.alias() // 备注名称
  const name = await contact.name() // 微信名称
  const isText = msg.type() === bot.Message.Type.Text // 消息类型是否为文本
  const isRoom = roomWhiteList.includes(roomName) && content.includes(`${botName}`) // 是否在群聊白名单内并且艾特了机器人
  const isAlias = aliasWhiteList.includes(remarkName) || aliasWhiteList.includes(name) // 发消息的人是否在联系人白名单内
  const isBotSelf = botName === `@${remarkName}` || botName === `@${name}` // 是否是机器人自己
  const isBotSelfDebug = content.trimStart().startsWith('你是谁') // 是否是机器人自己的调试消息
  const isAuthorizedCommand = (room && isRoom) || (!room && isAlias)
  if ((isBotSelf && !isBotSelfDebug) || !isText) return

  const messageMeta = {
    ...meta,
    roomName,
    alias,
    name,
    dataDir: meta.dataDir || runtimeConfig.dataDir,
  }

  try {
    const normalizedForCommand = sanitizeQuestion(content, botName, '')
    if (normalizedForCommand.trimStart().startsWith(commandPrefix)) {
      if (!isAuthorizedCommand) return
      const commandResult = await handleWechatCommand(content, {
        serviceType: ServiceType,
        roomName,
        alias,
        name,
      })
      if (commandResult.handled) {
        if (commandResult.reply) {
          await replyAndStore(room || contact, commandResult.reply, messageMeta, runtimeConfig)
        }
        return
      }
    }

    if (isRoom && room && sanitizeQuestion(content, botName, '').trimStart().startsWith(`${autoReplyPrefix}`)) {
      const mentionText = (await msg.mentionText()) || sanitizeQuestion(content, botName, '')
      const question = sanitizeQuestion(mentionText, '', autoReplyPrefix)
      if (!question) return
      console.log('🌸🌸🌸 / question: ', question)
      const response = await generateReply(question, messageMeta, ServiceType)
      await replyAndStore(room, response, messageMeta, runtimeConfig)
    }

    if (isAlias && !room && content.trimStart().startsWith(`${autoReplyPrefix}`)) {
      const question = sanitizeQuestion(content, '', autoReplyPrefix)
      if (!question) return
      console.log('🌸🌸🌸 / content: ', question)
      const response = await generateReply(question, messageMeta, ServiceType)
      await replyAndStore(contact, response, messageMeta, runtimeConfig)
    }
  } catch (e) {
    console.error(e)
  }
}

/**
 * 分片消息发送
 * @param message
 * @param bot
 * @returns {Promise<void>}
 */
export async function shardingMessage(message, bot) {
  const talker = message.talker()
  const isText = message.type() === bot.Message.Type.Text // 消息类型是否为文本
  if (talker.self() || message.type() > 10 || (talker.name() === '微信团队' && isText)) {
    return
  }
  const text = message.text()
  const room = message.room()
  if (!room) {
    console.log(`Chat GPT Enabled User: ${talker.name()}`)
    const response = await getChatGPTReply(text)
    await trySay(talker, response)
    return
  }
  let realText = splitMessage(text)
  // 如果是群聊但不是指定艾特人那么就不进行发送消息
  if (text.indexOf(`${botName}`) === -1) {
    return
  }
  realText = text.replace(`${botName}`, '')
  await room.topic()
  const response = await getChatGPTReply(realText)
  const result = `${realText}\n ---------------- \n ${response}`
  await trySay(room, result)
}

// 分片长度
const SINGLE_MESSAGE_MAX_SIZE = 500

/**
 * 发送
 * @param talker 发送哪个  room为群聊类 text为单人
 * @param msg
 * @returns {Promise<void>}
 */
async function trySay(talker, msg) {
  const messages = []
  let message = msg
  while (message.length > SINGLE_MESSAGE_MAX_SIZE) {
    messages.push(message.slice(0, SINGLE_MESSAGE_MAX_SIZE))
    message = message.slice(SINGLE_MESSAGE_MAX_SIZE)
  }
  messages.push(message)
  for (const msg of messages) {
    await talker.say(msg)
  }
}

/**
 * 分组消息
 * @param text
 * @returns {Promise<*>}
 */
async function splitMessage(text) {
  let realText = text
  const item = text.split('- - - - - - - - - - - - - - -')
  if (item.length > 1) {
    realText = item[item.length - 1]
  }
  return realText
}
