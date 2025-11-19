# ai_virtual_mate_web 整合说明（合规与构建）

本文件说明将 `swordswind/ai_virtual_mate_web`（GPL-3.0）相关模块/代码/实现思路整合进当前项目的范围与合规操作。

## 整合策略
- 优先“接口集成/独立服务”方式：
  - 在 `upstream/ai_virtual_mate_web` 放置上游仓库副本或子模块，仅通过 API/消息总线交互；保留本仓库 MIT 许可。
- 如需要“代码合并/修改”：
  - 接受 GPL-3.0 传染要求，分发时将本仓库整体视为 GPL-3.0（或拆分为可独立构建的 MIT 与 GPL 部分）。
  - 保留原始版权声明，在根目录包含上游 `LICENSE`，并在 `NOTICE.md` / `CHANGES.md` 标注改动。

## 目录与文件
- `upstream/ai_virtual_mate_web/`：上游源码位置（不含其资产或模型文件，按需下载/本地引用）。
- `NOTICE.md`：集中列出上游来源与许可证信息。
- `CHANGES.md`：记录合并/修改的文件及变更说明。
- `LICENSE`：保留本仓库 MIT 许可；如发生代码合并，另行添加上游 LICENSE 文件。

## 构建与分发（合规）
- 若仅“接口集成/独立服务”方式：
  - 分发本仓库（MIT）时无需附带上游完整源代码；但需在 `NOTICE.md` 中致谢与列出链接。
- 若包含“上游代码合并”：
  - 在分发的二进制或打包版本中，必须提供完整对应源代码（含本仓库与上游整合后的全部源码）。
  - 在根目录包含 `ai_virtual_mate_web` 的 GPL-3.0 LICENSE 文件，保留原始版权声明。
  - 在 `CHANGES.md` 标注修改文件与改动范围。

## 拟接入模块（建议）
- ASR（FunASR ONNX）：作为可选离线 ASR 服务，通过后端路由接入；不与现有 TTS/LLM强耦合。
- MMD 展示：新增独立页面与路由，前端引入 three/MMD 解析链路；资产按各自许可放置于本地，不随仓库分发。
- 语音表情：参考上游映射策略，融入现有前端 `live2d.js`/`app.js` 表情驱动。
- 长期记忆：与 `memory/` 模块互通，或在后端提供适配层。

## 开发步骤（建议流程）
1) 在 `upstream/ai_virtual_mate_web` 准备上游源码（或子模块）。
2) 更新 `NOTICE.md` 与新增 `CHANGES.md`（本次已完成初始版本）。
3) 选择“接口集成”或“代码合并”路径并执行：
   - 接口集成：新增后端路由/客户端，最小改动接入；保留 MIT。
   - 代码合并：按 GPL-3.0 要求更新 LICENSE、分发源代码、标注改动。
4) 验证功能：分别测试 ASR/MMD/表情映射等模块；不涉及 UI 的改动可走常规测试。

## 注意事项
- 资产（Live2D/MMD/VRM）通常有独立许可与分发限制，请勿直接将第三方模型与音乐纳入仓库分发。
- 如需发布包含上游代码的构建版本，务必随附完整源代码包与构建说明。

## 已完成（本次）
- 新增离线 ASR 接口骨架：`POST /api/asr/local`
  - 文件：`main_helper/asr_funasr_plugin.py`（自研接口，后续可接入 FunASR ONNX）
  - 路由：`main_server.py` 中的 `/api/asr/local`，接收 `UploadFile` 或 `audio_base64`，返回占位识别结果
  - 目的：采用“参考实现+自研”方式融入，不复制上游源代码，避免 GPL 传染；后续按需完善模型推理