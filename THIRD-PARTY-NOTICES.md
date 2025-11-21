# 第三方许可与素材来源概览

此清单用于汇总本仓库所包含或依赖的第三方组件、库与素材的许可信息，帮助在分发应用（含直播使用、二进制打包、源码发布）时合规附带授权与归属说明。该清单不改变各组件原有许可条款。

## Web/前端库

- three.js（含 `three.module.js`/`three.min.js`/`three.core.js`）
  - 许可：MIT
  - 路径示例：`static/libs/three.module.js`、`static/libs/three.min.js`、`static/libs/three.core.js`
  - 官网/许可：https://threejs.org/（仓库 LICENSE 为 MIT）

- three-vrm / VRM 插件与动画扩展（含 `three-vrm.min.js`、`three-vrm.module.min.js`、`three-vrm-animation.module.min.js`）
  - 许可：MIT
  - 路径示例：`static/libs/three-vrm.min.js`、`static/libs/three-vrm.module.min.js`、`static/libs/three-vrm-animation.module.min.js`

- GLTFLoader（three.js 官方加载器）
  - 许可：MIT
  - 路径示例：`static/libs/GLTFLoader.js`、`static/libs/jsm/loaders/GLTFLoader.js`

- PixiJS（`pixi.min.js`）
  - 许可：MIT
  - 路径示例：`static/libs/pixi.min.js`

- pixi-live2d-display（`index.min.js`）
  - 许可：MIT（常见分发为 MIT）
  - 路径示例：`static/libs/index.min.js`

- Live2D Cubism Core/SDK（`live2dcubismcore.min.js`、`live2d.min.js`）
  - 许可：Live2D 专有许可（非 MIT），需遵守 Live2D 官方条款
  - 路径示例：`static/libs/live2dcubismcore.min.js`、`static/libs/live2d.min.js`
  - 许可参考：
    - https://www.live2d.com/eula/
    - https://docs.live2d.com/cubism-sdk-manual/cubism-sdk-tutorials/

## 资产/素材（示例路径与注意事项）

- VRM 模型
  - 示例：`static/EE.vrm`
  - 来源与版权：由项目作者使用 VRoid Studio 自行创作；版权归作者所有；分发/商用由作者授权决定（请遵守 VRoid Studio 相关条款）。
  - 工具链接：https://vroid.com/studio

- 动画文件（VRMA/GLB 等）
  - 示例：`static/animations/*.vrma`
  - 来源与许可：来自 Adobe Mixamo（https://www.mixamo.com）动画库，按 Mixamo 使用条款可在商业/非商业项目中免费使用，通常无需署名；但不得将动画以“独立素材库”形式再分发或转售，需随项目/角色一并分发。
  - 参考说明：请遵守 Adobe Mixamo 的相关服务条款与许可政策。

- Live2D 模型
  - 示例：`static/mao_pro/` 下的 `.model3.json`、`.moc3`、`motions/`、`expressions/` 等
  - 说明：模型版权与许可取决于来源与作者；请按素材协议使用与分发。

- HDR 环境贴图
  - 示例：`static/hdr/qwantani_night_puresky_2k.hdr`
  - 说明：请确认来源与协议（例如来自 Poly Haven 的素材通常为 CC0）。分发时应按实际来源附带协议或致谢。

## 后端/可选依赖（常见许可）

- FastAPI：MIT（Python Web 框架）
- Uvicorn：BSD-3-Clause（ASGI 服务器）
- httpx：BSD-3-Clause（HTTP 客户端）
- Google Cloud Translate SDK（如使用）：Apache-2.0

以上后端依赖以 `requirements.txt` 管理，安装与使用须遵守各自许可；若将其打包或再分发，请在发行包中保留相应许可文本。

## 分发与合规建议

- 保留并附带本仓库根目录 `LICENSE`（MIT）文本，同时保留上游作者的版权声明。
- 对所有随包分发的第三方库与素材，在发行物中提供本清单或等效的第三方许可说明。
- 对 Live2D Cubism Core/SDK，严格遵守其专有许可条款；不要修改其核心库；分发时需按条款附带许可信息。
- 对自有或赞助素材（模型、音频、贴图等），请确保拥有分发/商用的明确授权，并在合适位置标注作者与协议。

如需补充或更新此清单（新增库或更换素材），请在提交中同步更新本文件。