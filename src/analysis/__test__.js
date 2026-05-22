import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { analyzeWechatMessages, buildWechatAnalysisPrompt, buildWechatStats } from './wechatAnalyzer.js'

const records = [
  {
    id: 'room-msg-1',
    timestamp: '2026-05-12T08:00:00.000Z',
    roomName: '研发群',
    talkerName: 'Alice',
    talkerAlias: 'Alice',
    receiverName: '',
    conversationKey: 'room:rd-group',
    conversationName: '研发群',
    text: '今天排查登录问题',
    typeName: 'Text',
  },
  {
    id: 'room-msg-2',
    timestamp: '2026-05-12T09:00:00.000Z',
    roomName: '研发群',
    talkerName: 'Bob',
    talkerAlias: 'Bob',
    receiverName: '',
    conversationKey: 'room:rd-group',
    conversationName: '研发群',
    text: '我来补日志',
    typeName: 'Text',
  },
  {
    id: 'private-msg-1',
    timestamp: '2026-05-12T10:00:00.000Z',
    roomName: '',
    talkerName: 'Carol',
    talkerAlias: 'Carol',
    receiverName: 'me',
    conversationKey: 'private:carol',
    conversationName: 'Carol',
    text: '周会改到下午',
    typeName: 'Text',
  },
]

const stats = buildWechatStats(records)
assert.equal(stats.totalMessages, 3)
assert.equal(stats.textMessages, 3)
assert.equal(stats.topSpeakers[0].name, 'Alice')

const prompt = buildWechatAnalysisPrompt({
  records,
  stats,
  target: '测试会话',
})
assert.match(prompt, /关键统计/)
assert.match(prompt, /最近消息样本/)
assert.match(prompt, /Alice: 今天排查登录问题/)

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-bot-analysis-'))
fs.mkdirSync(tmpDir, { recursive: true })
fs.writeFileSync(path.join(tmpDir, 'messages.jsonl'), records.map((record) => JSON.stringify(record)).join('\n'), 'utf8')

const result = await analyzeWechatMessages({
  dataDir: tmpDir,
  room: '研发群',
  statsOnly: true,
})

assert.equal(result.target, '群聊「研发群」')
assert.equal(result.stats.totalMessages, 2)
assert.equal(result.analysis, '')

const emptyResult = await analyzeWechatMessages({
  dataDir: tmpDir,
  room: '不存在的群聊',
  statsOnly: true,
})
assert.equal(emptyResult.stats.totalMessages, 0)
assert.equal(emptyResult.analysis, '没有匹配到可分析的本地微信消息。')

console.log('analysis tests passed')
