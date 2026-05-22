# 变更记录

## 2026-05 离线 RAG + 双写存储补充

这轮补充把微信消息链路从“仅 JSONL 落盘”扩展成了“JSONL + SQLite + 本地向量库”三层存储，并把上下文构建和历史回灌命令补齐。

### 已完成能力

- 微信消息双写：收到/发送的消息同时写入 `messages.jsonl`、`message-vectors.jsonl` 和 `wechat-storage.db`。
- 离线 RAG：启用 `WECHAT_OFFLINE_RAG_PROVIDER='qdrant'` 后，调用本地 Ollama embedding 和本地 Qdrant 检索。
- 上下文增强：回复时自动拼接最近 `10` 条同会话历史 + `10` 条 RAG 结果，超长内容按阈值压缩。
- 固定人设：默认人格是“开朗活泼、带一点小调皮的老朋友”，优先走 `deepseek`。
- 降级策略：Qdrant / Ollama 不可用时，自动退回本地关键词 + 权重相似度排序。
- 历史回灌：新增 `wb wechat:reindex`，支持 `--reset` 与 `--resume`。
- 历史兼容：读取旧 JSONL 时若缺少 `id`，会自动补稳定 ID，避免分析、检索、回灌因旧数据失效。

### 关键文件

- `src/platforms/wechat/localDb.js`：SQLite 表结构与消息/向量记录读写。
- `src/platforms/wechat/messageStore.js`：统一持久化入口、离线检索、历史回灌。
- `src/platforms/wechat/qdrantStore.js`：Qdrant collection 管理、upsert、search、scroll 断点续传。
- `src/wechaty/contextBuilder.js`：最近历史 + RAG 结果组装与压缩。
- `src/wechaty/sendMessage.js`：自动回复主链路接入上下文与回复回写。
- `src/deepseek/index.js`：默认系统人设。
- `src/index.js`：`wechat:reindex` 命令注册与输出。

### 回灌命令示例

```sh
wb wechat:reindex
wb wechat:reindex --resume
wb wechat:reindex --reset
wb wechat:reindex --room "研发群" --resume
```

### 测试记录

- 新增 `npm run test:wechat-rag`。
- 覆盖本地消息/向量读取、旧 JSONL 缺失 `id` 的兼容处理、本地检索与 Qdrant 检索切换。
- 覆盖 `reindex` 正常重建、`--resume` 断点续传、`--reset` 清空重建，以及 CLI 进度/结果输出。
- 保留原有 `npm run test:analysis` 作为本地分析回归测试，并补充了 prompt 组装和空结果分支校验。

### 注意事项

- `--resume` 在 collection 不存在时会自动按“空集合”处理，不再直接报错。
- Qdrant 点位 ID 已固定转换为 UUID 兼容格式，payload 中保留原始 `recordId`。
- 流程测试里 CLI 帮助校验改成了显式 `process.exit(0)` / 异步子进程方式，避免 `commander.parseAsync()` 在测试环境里挂住。
- 如果你切换了 embedding 模型或发现索引脏数据，优先执行一次 `wb wechat:reindex --reset`。

## 参考链接

- [OpenAI ChatGPT](https://openai.com/blog/chatting/)
- [Wechaty](https://wechaty.js.org/)
- [Wechaty Chatbot](https://wechaty.js.org/docs/examples/chatbot/)
- [Wechaty Chatbot Tutorial](https://wechaty.js.org/docs/tutorials/chatbot-tutorial/)
