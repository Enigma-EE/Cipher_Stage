



The quality of AI-generated content is terrible and it’s everywhere. There isn’t an AI virtual streamer on the market that matches what I want, so I’m going to build one.

I want a VTuber that can put on a show, provide more meaningful interactions and entertainment.

So this is an open, end‑to‑end AI VTuber project. It runs VRM models with VRMA motion, HDR lighting and real‑time 3D rendering.

It understands conversation with speech recognition, speaks with text‑to‑speech, and remembers context—so emotions and actions adapt as you talk. From your browser, you can trigger gestures, play animations, and control camera moves. 

“AI psychosis” is a colloquial label for how prolonged, immersive use of chatbots can reinforce fixation or misread ambiguous outputs as intent. The ELIZA effect names our tendency to attribute understanding and agency to simple programs. Today’s AI applications often implicitly steer users toward these dynamics; in part, this project is intended to counter them.


# Cipher Stage

[English](#english) | [简体中文](#简体中文)

## English

Based on `wehos/N.E.K.O` (MIT) Link: https://github.com/wehos/N.E.K.O , adapted and expanded for independent VTuber live scenarios.

- Project scope: dual-stack Live2D/3D live interaction system (lip-sync, TTS, memory & semantic retrieval)
- License: MIT (upstream copyrights and attribution preserved)

### Features
- 3D VRM rendering & animations
- Local viseme timeline: derive phoneme durations from TTS (FastPitch/FS2, etc.) to drive VRM/Live2D mouth shapes
- TTS pipeline: supports cloud and local TTS (can integrate HiFi-GAN vocoder)
- Memory & semantic retrieval: recent dialogue, time indexing, embeddings, and reranking
- Frontend: dual-stack Three-VRM/Live2D, WebSocket streaming (audio chunks + viseme timeline)
- Offline ASR (skeleton): local ASR plugin endpoint `/api/asr/local` ready for FunASR ONNX integration (no upstream code copied)

### Architecture Overview
- Backend (Python/FastAPI): `main_server.py` provides WebSocket/HTTP APIs; `memory_server.py` provides memory services
- Frontend (Web): `static/` and `templates/` host VRM/Live2D scenes and debug pages (with 3D rendering & animation pipeline)
- Config center: `config/` manages core/assist APIs, models, and keys (initialized via sample file)
- Assets & tools: `assets/` (icons), `tools/` (conversion scripts)

Ports:
- Main service: `48922` (visit `http://127.0.0.1:48922/index`)
- Memory service: `48912`

### Key Differences from Upstream (Live2D → 3D VRM)

- Use-case shift: from “multi-platform assistant/catgirl” to “independent Vtuber live” 

Upstream remains Live2D-first for structure and demos. This repo expands 3D capabilities while allowing both pipelines to coexist and switch.

### Quick Start (Windows)

1) Clone and install dependencies
- Install Python 3.10+ and latest `pip`
- In project root:
  - `python -m venv .venv && .venv\Scripts\activate`
  - `pip install -r requirements.txt`

2) Initialize config
- Copy sample: `config/core_config.example.json` → `config/core_config.json`
- Fill keys and API choices in `config/core_config.json`

3) Start services
- Option A: double-click batch files (recommended)

- Option B: command line
  - `python main_server.py` (main service)
  - optional: `python memory_server.py` (memory service)

### VRM Usage Guide
- Replace default model: put VRM in `static` 
- Play VRM animations: place `.vrma` files in `static/animations/` 
- Lip driver: backend sends `viseme_timeline` via WebSocket; VRM lips follow the timeline
- Debug pages: use `templates/viewer.html` / `templates/index.html` to validate loading and playback (`http://127.0.0.1:48922/index` after local start)
- Live2D fallback: if VRM assets are unavailable or performance-bound, the system falls back to the Live2D pipeline and still accepts `viseme_timeline`

### Config & Key Management
- Sample file: `config/core_config.example.json`
- Runtime file: `config/core_config.json`
- Override logic: at startup, read `core_config.json` and override in-memory `CORE_API_KEY` and related model/API settings
- Environment variables: some components accept keys from environment (e.g., `OPENROUTER_API_KEY`), useful for CI/CD or servers

### Roadmap
- M1: FastPitch/FS2 + HiFi-GAN for English, generate `viseme_timeline` and audio locally, drive VRM mouth playback on the frontend
- M2: Multilingual support (g2p and phoneme→viseme mapping), evaluate FastPitch/FS2 pretrained weights, optimize VRM viseme mapping
- M3: Live optimization (sentence-level pregen + streaming, lip smoothness, energy fallback; dual-stack switching between VRM and Live2D)
- M4: Compatibility & fallback (keep cloud TTS path, auto-switch on failure; fallback to Live2D for 3D performance constraints)

### Directory Structure (brief)
```
├── assets/                  # icons and assets
├── brain/                   # planning/processing/analyzers (LLM pipelines)
├── config/                  # configs & keys (sample: core_config.example.json)
├── memory/                  # memory & semantic retrieval (recent/semantic/timeindex)
├── static/                  # frontend static resources (VRM/Live2D scenes)
│   ├── EE.vrm               # default 3D model (replaceable)
│   ├── animations/          # VRM animations (.vrma)
│   ├── libs/
│   │   ├── three-vrm.min.js # VRM support library
│   │   └── three.real.min.js# three.js extension/variant
├── templates/               # frontend templates (index.html etc.)
├── main_server.py           # main service (WebSocket/HTTP)
├── memory_server.py         # memory service
└── tools/                   # asset/model conversion tools
```

### Origins & Attribution / Upstream & Credits

- Built upon upstream project: `wehos/N.E.K.O` (MIT)
- Link: https://github.com/wehos/N.E.K.O
- Code reuse & adaptations: portions are adapted under the MIT license with attribution preserved; sources are noted in file headers or in `NOTICE.md`.
- Differences from upstream: stronger focus on VTuber live scenarios and real-time interaction (viseme timeline, expression mapping, live pipeline), expanded 3D rendering and animation path, and adjusted directory/config layout.
- Credits: three-vrm, Live2D, LangChain, NVIDIA NeMo TTS and the open-source community.
- 3D-related assets and scripts: sourced from official/community projects and used under their respective licenses/terms.
- See `NOTICE.md` for detailed attributions and license references.

 

### License
MIT license. You may use, modify, and distribute the code and binaries, preserving copyright and license notices. If you include third-party code/models, ensure license compatibility and add notices in `NOTICE.md` or the “Credits & Sources” section.

### Security & Compliance
- Do not commit real keys or private data; initialize configs using sample files
- If accidental commits happen, revoke/rotate keys immediately and remove from repository history (refer to Git docs)
- Streaming assets (VRM/Live2D) are owned by their authors; confirm distribution rights before sharing

### FAQ
- Access URL?
  - After starting locally, visit `http://127.0.0.1:48922/index`
- GPU required?
  - Cloud TTS/LLM is optional; for local TTS (FastPitch/FS2 + HiFi-GAN), NVIDIA GPU is recommended for better latency and quality
- Can I swap models or providers?
  - Yes, via `config/core_config.json` or the settings page; add necessary keys when switching

---

## 简体中文

本仓库基于 `wehos/N.E.K.O` （MIT）https://github.com/wehos/N.E.K.O 改写与扩展。

面向独立 Vtuber 场景, 在保持低延迟与稳定直播管线的同时，强化 3D 模型渲染、动画播放与口型时间轴驱动。

- 项目定位：3D/Live2D 双栈的直播互动系统（口型同步、语音合成、记忆与语义检索）
- 许可协议：MIT（保留上游版权与署名）

## 功能特性
- 3D VRM 渲染与动画
- 本地口型时间轴, 从 TTS（FastPitch/FS2 等）推理的音素时长生成时间轴，驱动 VRM/Live2D 嘴型
- 语音合成管线：支持云端与本地 TTS, 可接入 HiFi-GAN 等声码器
- 记忆与语义检索：近期对话、时间索引、语义嵌入与重排
- 直播前端：Three-VRM/Live2D 双栈，WebSocket 流式消息（音频分块与嘴型时间轴）
- 离线 ASR（骨架）：提供本地 ASR 插件接口 `/api/asr/local`，后续可接入 FunASR ONNX（不复制上游代码）

## 架构总览
- 后端（Python/FastAPI）：`main_server.py` 提供 WebSocket/HTTP 接口；`memory_server.py` 提供记忆服务
- 前端（Web）：`static/` 与 `templates/` 提供 VRM/Live2D 场景与调试页面,新增 3D 渲染与动画链路
- 配置中心：`config/` 统一管理核心与辅助 API、模型与密钥
- 资源与工具：`assets/`（图标）、`tools/`（模型/素材转换脚本）

端口约定：
- 主服务：`48922`（访问 `http://127.0.0.1:48922/index`）
- 记忆服务：`48912`

## 与上游的关键差异
- 新增 3D 管线
- 统一嘴型驱动
- 资源布局差异
- 使用场景转向：从“多端个人助手/猫娘”转向“独立 Vtuber 直播”

上游仍保留 Live2D 优先的结构与演示。本仓库在此基础上扩展 3D 能力，并确保两条管线可共存与切换。

## 快速开始（Windows）

1) 克隆代码并安装依赖

- 安装 Python 3.10+ 与最新的 `pip`
- 在项目根目录执行：
  - `python -m venv .venv && .venv\\Scripts\\activate`
  - `pip install -r requirements.txt`

1) 初始化配置

- 复制示例配置：`config/core_config.example.json` → `config/core_config.json`
- 在 `config/core_config.json` 填入密钥与接口选择


1) 启动服务

- 方式 A：双击批处理脚本（推荐）
  - `启动网页版.bat` → 打开浏览器访问 `http://127.0.0.1:48922/index`
  - `启动设置页.bat` → 打开设置界面，填写/更新密钥与接口
- 方式 B：手动启动（命令行）
  - `python main_server.py`（主服务）
  - 可选：`python memory_server.py`（记忆服务）

## 3D 模型使用指南（VRM）

- 替换默认模型：将VRM 文件放置到 `static`
- 播放 VRM 动画：将 `.vrma` 文件放在 `static/animations/`
- 嘴型驱动：后端产生的 `viseme_timeline` 通过 WebSocket 发送到前端，由 VRM 嘴型随时间轴变化
- 调试页面：优先使用 `templates/viewer.html`/`templates/index.html` 进行加载与播放验证（本地启动后访问 `http://127.0.0.1:48922/index`）
- Live2D 回退：若 VRM 资源不可用或性能受限，系统可回退到Live2D链路，仍可接受 `viseme_timeline`

## 配置与密钥管理

- 示例文件：`config/core_config.example.json`
- 运行文件：`config/core_config.json`
- 覆盖逻辑：启动时读取 `core_config.json`，自动覆盖内存中的 `CORE_API_KEY` 与相关模型/接口设定
- 环境变量：部分组件支持从环境变量注入密钥（如 `OPENROUTER_API_KEY`），可在 CI/CD 或服务器上使用


## 路线图（Roadmap）

- M1：打通英文 FastPitch/FS2 + HiFi-GAN，本地生成 `viseme_timeline` 与音频，前端驱动 VRM 嘴型播放验证
- M2：多语言支持（g2p 与音素→viseme 映射），评估 FastPitch/FS2 预训练权重，VRM 嘴型映射优化
- M3：直播优化（句级预生成+流式播放、嘴型平滑过渡、能量驱动兜底；VRM 与 Live2D 双栈切换）
- M4：兼容与回退（保留现有云端 TTS 链路，失败自动切换；3D 性能回退到 Live2D）

## 目录结构（简要）

```
├── assets/                  # 图标与资源
├── brain/                   # 计划/处理/分析模块（LLM 调用与管线）
├── config/                  # 配置与密钥（示例：core_config.example.json）
├── memory/                  # 记忆与语义检索（recent/semantic/timeindex）
├── static/                  # 前端静态资源（VRM/Live2D 场景）
│   ├── EE.vrm               # 默认 3D 模型（可替换）
│   ├── animations/          # VRM 动画（.vrma）
│   ├── libs/
│   │   ├── three-vrm.min.js # VRM 支持库
│   │   └── three.real.min.js# three.js 扩展/变体
├── templates/               # 前端页面模板（index.html 等）
├── main_server.py           # 主服务（WebSocket/HTTP）
├── memory_server.py         # 记忆服务
└── tools/                   # 素材/模型转换工具
```

## 来源与致谢 / 上游与署名

- 上游仓库：`wehos/N.E.K.O`（MIT）
- 链接：https://github.com/wehos/N.E.K.O

- 代码来源与改写：在 MIT 许可下重用并改写了上游部分模块与脚本，保留原版权与署名；相关来源在文件头或 `NOTICE.md` 中注明。
- 与上游的差异点：更强调 VTuber 场景与实时互动体验（嘴型时间轴、表情映射、直播链路优化），新增 3D 渲染与动画链路，目录结构与配置有所调整。
- 致谢：three-vrm、Live2D、LangChain、NVIDIA NeMo TTS 等开源项目与社区。
- 3D 相关资源与脚本：来自官方/社区项目，遵循各自许可证与授权范围。

- 详见 `NOTICE.md` 获取来源与许可证参考。

## 许可协议（License）

本项目采用 MIT 许可证。你可以自由使用、修改与分发本项目的代码与二进制，但需保留版权与许可声明。若引入第三方代码/模型，请确认其许可证兼容性。

## 安全与合规

- 请勿在仓库中提交任何真实密钥或私有数据；使用示例文件初始化配置
- 如误提交，请立即吊销/轮换密钥；并从仓库历史中移除（如需，参照 Git 文档）
- 直播素材（VRM/Live2D）版权归各自作者所有；如需分发请确认授权范围

## FAQ

- 访问地址是什么？
  - 本地启动后访问 `http://127.0.0.1:48922/index`
- 是否必须使用 GPU？
  - 云端 TTS/LLM 不强制；本地 TTS（FastPitch/FS2 + HiFi-GAN）建议使用 NVIDIA GPU 以获得更好的时延与效果
- 可以换模型或服务商吗？
  - 可以，通过 `config/core_config.json` 或设置页面切换；必要时填入相应密钥


