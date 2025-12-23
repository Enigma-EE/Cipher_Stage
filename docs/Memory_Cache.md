# Memory & Cache Architecture Overview



This document describes the memory and cache implementation of the project, covering short-term and long-term memory, data flow, storage layout, management APIs, and the hot‑swap cache used by the live session manager.

---

# English Version — Memory & Cache Architecture (AIVtuber)


## Architecture Overview
- Core components:
  - Memory Server: `memory_server.py` — receives session history, maintains memory, archives
  - Main Server: `main_server.py` — UI and admin APIs; auto‑starts/manages the Memory Server
  - Session Manager: `LLMSessionManager` in `main_helper/core.py` — live session and hot‑swap cache
- Memory types:
  - Short‑Term: compressed memo of recent messages (JSON persistence)
  - Long‑Term: original + compressed entries in SQLite tables (time indexed)
  - Semantic: vector store design for topic/similarity search (disabled by default)
  - Settings: extract “important settings” from dialogs (disabled by default)
- UI: `templates/memory_browser.html` for browsing/editing recent memory files

## Key Modules & Responsibilities

### Memory Server
- File: `memory_server.py`
- Responsibilities:
  - Accept session history; store/review via memory managers
  - Provide endpoints for recent memory, daily archive merge, and initialization text
- Endpoints:
  - process: `/process/{ee_name}` (`memory_server.py:63`)
  - renew: `/renew/{ee_name}` (`memory_server.py:186`)
  - new_dialog: `/new_dialog/{ee_name}` (`memory_server.py:255`)
  - merge_by_day: `/archive/merge_by_day/{ee_name}` (`memory_server.py:127`)

### Short‑Term Memory (Compressed Recent)
- File: `memory/recent.py`
- Class: `CompressedRecentHistoryManager`
- Features:
  - Compress overflowing recent messages into a system memo
  - Persist memo to `memory/store/recent_{name}.json`
  - Optional auto review to fix contradictions/repetition
- Key APIs:
  - update/compress: `memory/recent.py:50`, `memory/recent.py:76`
  - review: `memory/recent.py:170`
  - get_recent_history: `memory/recent.py:164`
- Usage in initialization:
  - Main start prompt: `main_helper/core.py:357-369`
  - Pending session warmup: `main_helper/core.py:445-454`

### Long‑Term Memory (Time‑Indexed)
- File: `memory/timeindex.py`
- Class: `TimeIndexedMemory`
- Storage (SQLite tables):
  - original: `time_indexed_original` (`config/__init__.py:81`)
  - compressed: `time_indexed_compressed` (`config/__init__.py:82`)
- Key APIs:
  - store_conversation: `memory/timeindex.py:52`
  - retrieve summary/original by timeframe: `memory/timeindex.py:82`, `memory/timeindex.py:90`
- Callers:
  - renew during turn: `main_helper/cross_server.py:246-252`
  - process on session end: `main_helper/cross_server.py:286-294`

### Semantic Memory (Vector Store Design)
- File: `memory/semantic.py`
- Classes: `SemanticMemory*`
- Design: embed original + summary; hybrid search with LLM rerank (`rerank_results`)
- Status: `vectorstore` placeholder; Chroma removed by default; server writes commented (`memory_server.py:104-107`)
- Enable plan: instantiate a lightweight or cloud vector store and un‑comment writes/search

### Important Settings
- File: `memory/settings.py`
- Class: `ImportantSettingsManager`
- Feature: extract/merge settings, persist to `settings_{name}.json`
- Status: disabled by default (calls commented in server)

### Memory Review
- Entry: `review_history` (`memory/recent.py:170`)
- Config: `recent_memory_auto_review` via `/api/memory/review_config` (`main_server.py:1376-1417`)
- Purpose: clean contradictions/duplication/redundancy in recent memo

### Hot‑Swap Cache
- File: `main_helper/core.py`
- Field: `LLMSessionManager.message_cache_for_new_session`
- Flow: prepare pending session → warm up → perform final swap, injecting incremental cache
- Key points: preparation (`main_helper/core.py:166-175`), warmup (`main_helper/core.py:425-456`), final swap (`main_helper/core.py:501-584`)

## Data Flow & Lifecycle
1. Frontend/live session produces messages; collected by `LLMSessionManager`
2. Sync connector aggregates recent messages as `chat_history`
3. Turn end / session end:
   - `renew`: update recent memory and optional review (`/renew/{ee}`)
   - `process`: store full `chat_history` into time‑index DB and archive (`/process/{ee}`)
4. Next start / warmup:
   - Pull `new_dialog` and append recent memo into the system prompt

## Storage & Cache Layout
- `memory/store/`
  - `recent_{name}.json`
  - `settings_{name}.json`
  - `time_indexed_{name}` (SQLite)
  - `semantic_memory_{name}` (placeholder)
  - `archive/{name}/session_YYYYMMDD_HHMMSS_{uuid}.json`; daily merge in `archive/{name}/day/`

## Operations & Admin APIs
- Auto‑start/stop: `main_server.py:488-559`, `main_server.py:597-608` (handled in `memory_server.py:39-61`)
- Toggles: `/api/admin/memory/disable`, `/api/admin/memory/enable` (`main_server.py:611-625`)
- Cache flush: `/api/admin/cache/flush` (`main_server.py:644-677`)
- Recent memory browser: list/read/save/page (`main_server.py:1364-1374`, `1421-1432`, `1738-1774`, `1855-1857`)

## Short‑Term vs Long‑Term
- Short‑Term: compressed memo appended to initial prompt; optional review
- Long‑Term: original + compressed entries with timestamps; time‑range retrieval
- Semantic (optional): topic/similarity search when vector store is enabled

## Models & Config
- Compression/review: `SUMMARY_MODEL`, `CORRECTION_MODEL` via `assistApi` (`core_config.json`)
- Embeddings/rerank: `SEMANTIC_MODEL`, `RERANKER_MODEL`
- Config sources: `config/__init__.py`, `config/api.py`, `config/core_config.json`

## Security & Privacy
- Do not commit real keys/private data; archives contain full dialogs; use daily merge and `.gz` for distribution (`memory_server.py:169-180`, `170-177`)

## FAQ
- Memory server not ready: auto‑launch/port polling; check deps/ports (`main_server.py:520-547`)
- Recent memory not updating: ensure sync connector and renew/process calls (`main_helper/cross_server.py:239-252`, `284-294`)
- Review disabled: toggle via `/api/memory/review_config`

---

## Problems & Weaknesses
- Small short‑term capacity (`max_history_length=10`) limits coverage (`memory/recent.py:12`).
- Semantic memory disabled (`vectorstore` placeholder) — no topic/similarity search (`memory/semantic.py:79-85`, `131-137`).
- Synchronous updates: blocking `requests.post` increases tail latency on poor networks (`main_helper/cross_server.py:245-248`, `286-289`).
- IO/archives: frequent JSON writes add IO latency on HDD/network drives (`memory_server.py:110-121`).
- Review depends on remote API; skipped on failures; quality varies (`memory/recent.py:218-220`).
- Startup polling up to 10s impacts cold‑start (`main_server.py:530-547`).

## Local Model Options
- Local summarization/review: use `ollama`/`llama.cpp` or local GLM/Qwen; point models to local HTTP endpoints (`memory/recent.py:28-35`).
- Local embeddings/vector: `sentence-transformers` + `faiss-cpu` or `chromadb`; instantiate `vectorstore` and un‑comment writes/search (`memory_server.py:104-107`).
- Local TTS: integrate `Coqui TTS` or `VITS` (`config/__init__.py:144-149`).
- Local ASR: enable GPU for `faster-whisper` (`main_helper/asr_funasr_plugin.py:34-70`).

## Cache Cap & Latency Improvements
- Raise `max_history_length` to 32/64; layered compression (rolling + session summaries).
- Incremental summarization of new fragments; maintain segment indices to reduce re‑work.
- Async updates: switch to `httpx.AsyncClient` with timeouts/retries; fire‑and‑forget and batch flush.
- File IO: append‑then‑compact; default `.gz` for archives; keep `memory/store` on SSD.
- Enable vector search: rely on vector retrieval for history; inject “topic + recent fragments” for hot‑swap.
- Service: keep memory server resident with connection pool; parallelize `new_dialog` fetching.

## Incremental Upgrade Path
- Phase 1 (config): raise `max_history_length`; enable `.gz` and SSD path; keep review on.
- Phase 2 (client async): async connector with batch renew/process; parallel `new_dialog`.
- Phase 3 (local models): local endpoints for summarization/review; local embeddings + `faiss`; restore semantic writes/search.
- Phase 4 (hot‑swap): layered summaries (fragments/session/topic); inject only “incremental + topic”.

## 架构总览 | Architecture Overview
- 核心组成 | Core Components：
  - 记忆服务器 | Memory Server：`memory_server.py`，接收会话历史、生成/维护记忆与归档
  - 主服务 | Main Server：`main_server.py`，页面与控制面 API，并自启动/管理记忆服务器
  - 会话管理器 | Session Manager：`main_helper/core.py` 的 `LLMSessionManager`，实现实时会话与“热切换”缓存
- 记忆类型 | Memory Types：
  - 短期记忆 | Short‑Term: 将最近对话压缩为备忘录，持久化到 JSON 文件
  - 长期记忆 | Long‑Term: 原始消息与压缩摘要写入 SQLite 表，按时间检索
  - 语义记忆 | Semantic: 计划写入向量库进行语义检索（当前默认关闭）
  - 设定记忆 | Settings: 从对话中提取重要设定并持久化（当前默认关闭）
- UI 管理 | UI: `templates/memory_browser.html` 提供近期记忆文件的浏览与编辑页面

## 关键模块与职责 | Key Modules

### 记忆服务器 | Memory Server
- 文件 | File：`memory_server.py`
- 职责 | Responsibilities：
  - 接收会话历史，调用记忆管理器存储与审阅 | Accept session history; store/review via managers
  - 提供近期记忆与归档接口 | Provide recent memory & archive endpoints
- 入口与处理 | Endpoints：
  - 会话完成处理 | process: `/process/{ee_name}`（`memory_server.py:63`）
  - 更新近期记忆（用于热切换）| renew: `/renew/{ee_name}`（`memory_server.py:186`）
  - 获取近期记忆文本 | new_dialog: `/new_dialog/{ee_name}`（`memory_server.py:255`）
  - 归档合并（按天）| merge_by_day: `/archive/merge_by_day/{ee_name}`（`memory_server.py:127`）

### 短期记忆 | Compressed Recent History
- 文件 | File：`memory/recent.py`
- 主要类 | Main Class：`CompressedRecentHistoryManager`
- 功能 | Features：
  - 超阈值自动压缩为系统备忘录 | Compress old messages to system memo
  - 持久化到 `recent_{name}.json` | Persist to JSON file
  - 可选自动审阅 | Optional auto review
- 重要实现 | Key APIs：
  - 更新与压缩 | update/compress：`memory/recent.py:50`、`memory/recent.py:76`
  - 审阅 | review：`memory/recent.py:170`
  - 读取 | get_recent_history：`memory/recent.py:164`
- 在初始系统提示中的使用 | Used in initial prompt：
  - 主会话启动拼接 | main start：`main_helper/core.py:357-369`
  - 待机会话预热拼接 | pending warmup：`main_helper/core.py:445-454`

### 长期记忆 | Time‑Indexed Memory
- 文件 | File：`memory/timeindex.py`
- 主要类 | Main Class：`TimeIndexedMemory`
- 存储 | Storage：SQLite 两张表 | two tables
  - 原始 | original：`time_indexed_original`（`config/__init__.py:81`）
  - 摘要 | compressed：`time_indexed_compressed`（`config/__init__.py:82`）
- 功能 | Features：
  - 分配 `session_id` 并写入原始与摘要 | store both with session id
  - 自动 `timestamp` 用于时间检索 | auto timestamp
- 重要实现 | Key APIs：
  - 存储 | store_conversation：`memory/timeindex.py:52`
  - 检索 | retrieve_*_by_timeframe：`memory/timeindex.py:82`、`memory/timeindex.py:90`
- 调用链 | Callers：
  - 更新周期 | renew：`main_helper/cross_server.py:246-252`
  - 会话结束 | process：`main_helper/cross_server.py:286-294`

### 语义记忆 | Semantic Memory (Vector Store Design)
- 文件 | File：`memory/semantic.py`
- 类 | Classes：`SemanticMemory*`
- 设计 | Design：原始与摘要分别嵌入到向量库；混合检索 + 重排序
- 状态 | Status：为减依赖已移除默认 Chroma；当前 `vectorstore` 为占位；服务端写入已注释
- 启用 | Enable later：接入轻量/云向量库并解除注释

### 设定记忆 | Important Settings
- 文件 | File：`memory/settings.py`
- 类 | Class：`ImportantSettingsManager`
- 功能 | Features：对话中提取与合并设定，写入 `settings_{name}.json`
- 状态 | Status：默认关闭（服务器端调用已注释）

### 记忆审阅 | Memory Review
- 入口 | Entry：`review_history`（`memory/recent.py:170`）
- 配置 | Config：`recent_memory_auto_review`（`/api/memory/review_config`）
- 作用 | Purpose：清理矛盾/冗余/复读，保持短期记忆质量

### 会话热切换与缓存 | Hot‑Swap Cache
- 文件 | File：`main_helper/core.py`
- 核心对象 | Core Field：`message_cache_for_new_session`
- 设计 | Design：定时准备 pending 会话，缓存增量上下文并注入，保证连续性
- 关键实现 | Key APIs：触发准备、后台预热、最终切换（见行号）

## 数据流与生命周期 | Data Flow & Lifecycle
1. 前端与实时会话（WebSocket）产生对话消息，由 `LLMSessionManager` 收集
2. 同步连接器 `main_helper/cross_server.py` 聚合最近的用户与助手文本，维护 `chat_history`
3. 在“turn end”或“session end”时：
   - `renew`：发送到 `memory_server` 进行近期记忆更新与（可选）审阅（`/renew/{ee}`）
   - `process`：在会话结束时，将完整 `chat_history` 发送到 `memory_server`，写入时间索引库与归档（`/process/{ee}`）
4. 下次会话启动或热切换预热：
   - `LLMSessionManager` 拉取 `new_dialog` 文本，将近期记忆拼接到系统提示中，恢复角色的“短期记忆”

## 存储与缓存布局 | Storage & Cache Layout
- 目录：`memory/store/`
  - 近期记忆：`recent_{name}.json`
  - 设定记忆：`settings_{name}.json`
  - 时间索引数据库：`time_indexed_{name}`（SQLite 文件）
  - 语义记忆：`semantic_memory_{name}`（当前为占位）
  - 归档：`archive/{name}/session_YYYYMMDD_HHMMSS_{uuid}.json`；每日合并位于 `archive/{name}/day/`

## 管理与运维接口 | Operations & Admin APIs
- 记忆服务器自启动与关闭：
  - 主服务启动时检测/拉起：`main_server.py:488-559`
  - 主服务关闭时发送退出信号：`main_server.py:597-608`（记忆端响应 `memory_server.py:39-61`）
- 管理开关：
  - 禁用/启用记忆服务器：`/api/admin/memory/disable`、`/api/admin/memory/enable`（`main_server.py:611-625`）
  - 清理缓存文件：`/api/admin/cache/flush`（`main_server.py:644-677`）
- 近期记忆浏览器：
  - 列出文件：`/api/memory/recent_files`（`main_server.py:1364-1374`）
  - 读取文件：`/api/memory/recent_file?filename=recent_xxx.json`（`main_server.py:1421-1432`）
  - 保存编辑：`/api/memory/recent_file/save`（`main_server.py:1738-1774`）
  - 页面：`/memory_browser`（`main_server.py:1855-1857`）

## 短期记忆 vs 长期记忆 | Short‑Term vs Long‑Term
- 短期记忆：
  - 目标：让角色在“下一轮会话”或“热切换后”仍能记住最近发生的事情
  - 手段：在消息达到阈值时压缩历史为系统备忘录，持久化到 `recent_{name}.json`，并在会话初始化拼接
  - 审阅：可选的自动审阅进一步提升短期记忆质量
- 长期记忆：
  - 目标：按照对话发生时间进行检索、回顾与审计
  - 手段：将原始消息与压缩摘要分别写入两张 SQLite 表，并维护 `timestamp`
  - 检索：支持在指定时间范围内检索原始记录或摘要（供未来检索/报告/复盘）
- 语义记忆（可选）：
  - 面向语义检索的向量库，便于在海量历史中按“主题”或“语义相似度”找回内容
  - 当前默认关闭；如需启用，需实例化向量库并解除写入注释

## 模型与配置 | Models & Config
- 近期记忆压缩与审阅：依赖 `SUMMARY_MODEL` 与 `CORRECTION_MODEL`（通过 `core_config.json` 的 `assistApi` 选择不同提供商）
- 语义嵌入与重排序：`SEMANTIC_MODEL` 与 `RERANKER_MODEL`（当前默认停用向量库）
- 配置来源：`config/__init__.py` 与 `config/api.py`，以及 `config/core_config.json`

## 安全与隐私注意 | Security & Privacy
- 不在仓库提交真实密钥与私有数据（参考 `README.MD` 的“安全与合规”）
- 归档文件包含完整对话，请谨慎分发；如需压缩存储可使用合并与 `.gz` 输出（`memory_server.py:170-177`，`memory_server.py:169-180`）

## 常见问题 | FAQ
- 记忆服务器未就绪：主服务会尝试自启动并轮询端口；如仍失败请检查依赖与端口占用（`main_server.py:520-547`）
- 近期记忆不更新：确认同步连接器正在运行，以及 `renew/process` 调用正常（`main_helper/cross_server.py:239-252`，`main_helper/cross_server.py:284-294`）
- 审阅关闭：通过 `/api/memory/review_config` 开关；默认开启

---

## 问题与弱点 | Problems & Weaknesses
- 近期记忆容量偏小：`CompressedRecentHistoryManager(max_history_length=10)` 限制了上下文覆盖面（`memory/recent.py:12`）。
- 语义记忆未启用：`vectorstore` 为占位，导致主题/相似检索能力缺席（`memory/semantic.py:79-85`、`memory/semantic.py:131-137`）。
- 记忆更新的调用同步：同步连接器中使用 `requests.post` 阻塞调用，可能在网络不佳时拉长尾延迟（`main_helper/cross_server.py:245-248`、`main_helper/cross_server.py:286-289`）。
- 归档与文件 IO：频繁 JSON 读写与归档在 HDD/网络盘上会增加 IO 延迟（`memory_server.py:110-121`）。
- 审阅依赖远程模型：近期记忆审阅依赖外部 API，失败时直接跳过，质量不稳定（`memory/recent.py:218-220`）。
- 启动依赖：记忆服务器未就绪时主服务轮询 10 秒，冷启动体验受影响（`main_server.py:530-547`）。

## 本地模型引入 | Local Model Options
- 本地摘要/审阅模型：
  - 方案：接入 `ollama`/`llama.cpp` 或本地 `GLM/Qwen` 推理服务，配置 `SUMMARY_MODEL`、`CORRECTION_MODEL` 指向本地端点。
  - 接入点：`memory/recent.py` 中 `ChatOpenAI(base_url=OPENROUTER_URL, api_key=...)` 可改为本地 HTTP 兼容端点（`memory/recent.py:28-35`）。
- 本地嵌入/向量库：
  - 方案：`sentence-transformers` + `faiss-cpu` 或 `chromadb`（轻依赖）。
  - 接入点：在 `memory/semantic.py` 实例化 `vectorstore`，解除 `add_texts/similarity_search` 的占位；将写入解注释于 `memory_server.py:104-107`。
- 本地 TTS：
  - 方案：现已支持占位本地引擎；可接入 `Coqui TTS` 或 `VITS`，降低云端依赖（`config/__init__.py:144-149`）。
- 本地 ASR：
  - 方案：已集成 `faster-whisper`；可开启 GPU 以进一步降延迟（`main_helper/asr_funasr_plugin.py:34-70`）。

## 缓存上限与延迟优化 | Cache Cap & Latency Improvements
- 提升近期缓存上限：
  - 将 `max_history_length` 从 10 提升到 32/64，并改用“分层压缩”：滚动窗口摘要 + 会话级摘要，避免单一巨型备忘录（变更点：`memory/recent.py:12`）。
  - 增量摘要：仅对新增片段进行摘要，并在备忘录中维护段索引，减少重复压缩成本（变更点：`memory/recent.py:58-65`）。
- 异步化记忆更新：
  - 将同步连接器中的 `requests.post` 切换为 `httpx.AsyncClient` 并增加短超时与重试，避免阻塞（参考：`main_helper/core.py:445-454` 的异步拉取用法）。
  - 对 `renew/process` 使用 fire‑and‑forget 模式，并引入后台批处理（聚合多次“turn end”后统一写入）。
- 文件 IO 优化：
  - 将近期记忆 JSON 改为行式追加与定期整合（减少重写）；归档使用 `.gz` 默认压缩（`memory_server.py:170-177` 已支持）。
  - 在 Windows 上避免网络盘路径；确保 `memory/store` 在本地 SSD。
- 向量检索启用（可选）：
  - 开启本地向量库后，短期记忆可只存摘要，历史检索走向量库，降低近期缓存压力。
  - 对热切换缓存，注入“主题摘要 + 最近片段”，缩短初始提示构建时间。
- 服务层优化：
  - 记忆服务器常驻：随主服务一并启动并保持连接池，减少冷启动；主服务启动阶段将轮询窗口由 10 秒缩短并提示后台完成。
  - 将 `new_dialog` 拉取放入并行任务，抢先构建初始提示。

## 渐进式改造路径 | Incremental Upgrade Path
- 第 1 阶段（配置级）：提高 `max_history_length`；打开 `.gz` 合并与 SSD 路径；前端审阅开关保持开启。
- 第 2 阶段（客户端异步）：把同步连接器改为异步 `httpx`，`renew/process` 后台批处理；`new_dialog` 并行拉取。
- 第 3 阶段（本地模型）：为摘要/审阅配置本地端点；启用本地嵌入 + `faiss`；恢复语义记忆写入与检索。
- 第 4 阶段（热切换强化）：采用分层摘要（对话片段 + 会话摘要 + 主题摘要），热切换仅注入“增量 + 主题”，进一步降初始延迟。

未本地化模块

- 记忆压缩与审阅（短期记忆）： memory/recent.py:23-31 使用 ChatOpenAI 通过 OPENROUTER_URL 调用外部模型进行摘要与审阅
- 语义记忆（嵌入与重排）： memory/semantic.py:23 、 memory/semantic.py:78 、 memory/semantic.py:131 使用 ChatOpenAI 与 OpenAIEmbeddings （当前向量库写入注释，启用后依赖外部嵌入/LLM）
- 设定记忆提取： memory/settings.py:15-18 使用 ChatOpenAI 提取与验证重要设定（默认关闭）
- 记忆路由与检索重排： memory/router.py:25 使用 ChatOpenAI 进行路由判断（如启用）
- 规划/分析/去重/处理（脑模块）： brain/planner.py:26 、 brain/analyzer.py:12 、 brain/deduper.py:14-17 、 brain/processor.py:14 统一通过 ChatOpenAI 实现推理能力
- 情感分析接口： main_server.py:1798-1819 使用 AsyncOpenAI 调用外部模型生成情感标签
- 实时语音/多模态（Omni Realtime）： main_helper/omni_realtime_client.py:100-109 、 main_helper/omni_realtime_client.py:116-153 通过 WebSocket 连接外部实时模型（OpenAI/Qwen/GLM）
- 流式 TTS 合成： main_helper/core.py:864-944 通过 dashscope.audio.tts_v2.SpeechSynthesizer 使用阿里云 CosyVoice v2 进行实时语音合成
- 声音注册（语音克隆）： main_server.py:1247-1255 使用 VoiceEnrollmentService （DashScope）注册音色，上传音频到 tmpfiles.org 并传直链
依赖 API 的部分

- 统一外部模型入口与路由： config/__init__.py:113-142 根据 assistApi 切换 OPENROUTER_URL 到 dashscope.aliyuncs.com （Qwen）、 api.openai.com （OpenAI）、 open.bigmodel.cn （GLM），并设置 SUMMARY_MODEL 、 CORRECTION_MODEL
- 外部密钥使用： config/api.py:19 、 config/__init__.py:157-158 使用 OPENROUTER_API_KEY （缺省回退 CORE_API_KEY ）， AUDIO_API_KEY 用于 DashScope TTS
- 嵌入与重排模型： config/api.py:28-30 定义 SEMANTIC_MODEL 、 RERANKER_MODEL （启用向量检索时依赖外部嵌入与重排）