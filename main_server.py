# -*- coding: utf-8 -*-
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mimetypes
mimetypes.add_type("application/javascript", ".js")
import asyncio
import json
import traceback
import uuid
import logging
from datetime import datetime
import webbrowser

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, File, UploadFile, Form, Body
from fastapi.staticfiles import StaticFiles
from main_helper import core as core, cross_server as cross_server
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.responses import Response
from main_helper.asr_funasr_plugin import LocalASR
from utils.tts_local import synthesize as local_tts_synthesize, TTSLocalError
from utils.preferences import load_user_preferences, update_model_preferences, validate_model_preferences, move_model_to_top, update_preferences_generic
from utils.frontend_utils import find_models
from utils.hardware import get_cpu_info, get_gpu_info, get_memory_info
from multiprocessing import Process, Queue, Event
import atexit
# Make dashscope optional at import time
try:
    import dashscope
    from dashscope.audio.tts_v2 import VoiceEnrollmentService
    DASHSCOPE_AVAILABLE = True
except Exception:
    dashscope = None
    VoiceEnrollmentService = None
    DASHSCOPE_AVAILABLE = False
import requests
import subprocess
import httpx
import pathlib, wave
from openai import AsyncOpenAI
from config import get_character_data, MAIN_SERVER_PORT, CORE_API_KEY, AUDIO_API_KEY, EMOTION_MODEL, OPENROUTER_API_KEY, OPENROUTER_URL, load_characters, save_characters, TOOL_SERVER_PORT, MONITOR_SERVER_PORT
from utils.model_path import normalize_vrm_path, validate_character_config
from config.prompts_sys import emotion_analysis_prompt
import glob

templates = Jinja2Templates(directory="./")

# Configure logging
def setup_logging():
    """Setup logging configuration"""
    log_format = '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    logging.basicConfig(
        level=logging.INFO,
        format=log_format,
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(f'ee_server_{datetime.now().strftime("%Y%m%d")}.log', encoding='utf-8')
        ]
    )
    return logging.getLogger(__name__)

logger = setup_logging()

def cleanup():
    logger.info("Starting cleanup process")
    for k in sync_message_queue:
        while sync_message_queue[k] and not sync_message_queue[k].empty():
            sync_message_queue[k].get_nowait()
        sync_message_queue[k].close()
        sync_message_queue[k].join_thread()
    logger.info("Cleanup completed")
atexit.register(cleanup)
sync_message_queue = {}
sync_shutdown_event = {}
session_manager = {}
session_id = {}
sync_process = {}
# Unpack character data once for initialization
master_name, her_name, master_basic_config, lanlan_basic_config, name_mapping, lanlan_prompt, semantic_store, time_store, setting_store, recent_log = get_character_data()
catgirl_names = list(lanlan_prompt.keys())
# 角色配置校验（仅日志提示，不阻塞启动）
try:
    _characters = load_characters()
    _warnings = validate_character_config(_characters, static_dir='static')
    for _w in _warnings:
        logger.warning(_w)
except Exception as _e:
    logger.warning(f"角色配置校验失败: {_e}")
for k in catgirl_names:
    sync_message_queue[k] = Queue()
    sync_shutdown_event[k] = Event()
    # 使用角色“昵称”替换 {LANLAN_NAME}，若未配置则回退为角色名
    nickname = lanlan_basic_config.get(k, {}).get('昵称', k)
    session_manager[k] = core.LLMSessionManager(
        sync_message_queue[k],
        k,
        lanlan_prompt[k].replace('{LANLAN_NAME}', nickname).replace('{MASTER_NAME}', master_name)
    )
    session_id[k] = None
    sync_process[k] = None
lock = asyncio.Lock()

# --- FastAPI App Setup ---
app = FastAPI()

# 离线ASR插件（参考实现+自研接口骨架）
local_asr = LocalASR(
    model_dir=os.path.join('upstream', 'ai_virtual_mate_web', 'data', 'model'),
    backend="auto",
    whisper_model=os.environ.get('EE_ASR_WHISPER_MODEL', 'small'),
    use_gpu=None
)


class CustomStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        # Normalize content-type for certain static assets to avoid misclassification
        if path.endswith('.js'):
            response.headers['Content-Type'] = 'application/javascript'
        elif path.endswith('.glb') or path.endswith('.vrm'):
            # Binary glTF / VRM assets
            response.headers['Content-Type'] = 'model/gltf-binary'
        elif path.endswith('.gltf'):
            # JSON glTF descriptor
            response.headers['Content-Type'] = 'model/gltf+json'
        elif path.endswith('.bin'):
            # Associated binary buffers for glTF
            response.headers['Content-Type'] = 'application/octet-stream'
        return response
app.mount("/static", CustomStaticFiles(directory="static"), name="static")

# 使用 FastAPI 的 app.state 来管理启动配置
def get_start_config():
    """从 app.state 获取启动配置"""
    if hasattr(app.state, 'start_config'):
        return app.state.start_config
    return {
        "browser_mode_enabled": False,
        "browser_page": "chara_manager",
        'server': None,
        # 默认禁用通过页面关闭触发的服务器关机
        'allow_beacon_shutdown': False,
        # 新增：禁用记忆服务器与同步连接器的开关（便于排障）
        'disable_memory_server': False,
        'disable_sync_connectors': False,
    }

def set_start_config(config):
    """设置启动配置到 app.state"""
    app.state.start_config = config

@app.get('/unity_test', response_class=HTMLResponse)
async def unity_test(request: Request, ee_name: str = ""):
    """简单的 Unity/观众端测试页：发送动画/表情/口型命令并实时查看监控服务广播。"""
    return templates.TemplateResponse("templates/unity_test.html", {
        "request": request,
        "ee_name": ee_name or her_name,
        "monitor_port": MONITOR_SERVER_PORT
    })

# 已移除：实验 VRMA 播放页面及其路由

def find_model_config_file(model_name: str) -> str:
    """
    在模型目录中查找.model3.json配置文件
    返回相对于static目录的路径
    """
    model_dir = os.path.join('static', model_name)
    if not os.path.exists(model_dir):
        return f"/static/{model_name}/{model_name}.model3.json"  # 默认路径
    
    # 查找.model3.json文件
    for file in os.listdir(model_dir):
        if file.endswith('.model3.json'):
            return f"/static/{model_name}/{file}"
    
    # 如果没找到，返回默认路径
    return f"/static/{model_name}/{model_name}.model3.json"

@app.get("/", response_class=HTMLResponse)
async def get_default_index(request: Request):
    # 每次动态获取角色数据
    _, her_name, _, lanlan_basic_config, _, _, _, _, _, _ = get_character_data()
    # 获取live2d/vrm字段
    live2d = lanlan_basic_config.get(her_name, {}).get('live2d', 'mao_pro')
    vrm_model = lanlan_basic_config.get(her_name, {}).get('vrm_model', 'EE.vrm')
    # 查找所有模型
    models = find_models()
    # 根据live2d字段查找对应的model path
    model_path = next((m["path"] for m in models if m["name"] == live2d), find_model_config_file(live2d))
    # 规范化 VRM 路径（允许直接配置文件名或 /static 前缀）
    vrm_model_path = normalize_vrm_path(vrm_model)
    return templates.TemplateResponse("templates/index.html", {
        "request": request,
        "ee_name": her_name,
        "model_path": model_path,
        "vrm_model_path": vrm_model_path,
        "focus_mode": False
    })

# 显式的 /index 路由，避免被通配的 /{ee_name} 误认为角色名
@app.get("/index", response_class=HTMLResponse)
async def get_default_index_alias(request: Request):
    return await get_default_index(request)

@app.get("/focus", response_class=HTMLResponse)
async def get_default_focus_index(request: Request):
    # 每次动态获取角色数据
    _, her_name, _, lanlan_basic_config, _, _, _, _, _, _ = get_character_data()
    # 获取live2d/vrm字段
    live2d = lanlan_basic_config.get(her_name, {}).get('live2d', 'mao_pro')
    vrm_model = lanlan_basic_config.get(her_name, {}).get('vrm_model', 'EE.vrm')
    # 查找所有模型
    models = find_models()
    # 根据live2d字段查找对应的model path
    model_path = next((m["path"] for m in models if m["name"] == live2d), find_model_config_file(live2d))
    # 规范化 VRM 路径（允许直接配置文件名或 /static 前缀）
    vrm_model_path = normalize_vrm_path(vrm_model)
    return templates.TemplateResponse("templates/index.html", {
        "request": request,
        "ee_name": her_name,
        "model_path": model_path,
        "vrm_model_path": vrm_model_path,
        "focus_mode": True
    })

@app.get('/api/system/hardware')
async def api_system_hardware():
    """返回当前主机的硬件信息（CPU/GPU/内存）。"""
    try:
        return {
            "success": True,
            "cpu": get_cpu_info(),
            "gpu": get_gpu_info(),
            "memory": get_memory_info(),
        }
    except Exception as e:
        logger.error(f"硬件信息获取失败: {e}")
        return {"success": False, "error": str(e)}

@app.get('/asr_test', response_class=HTMLResponse)
async def asr_test_page(request: Request):
    """简易本地ASR上传测试页。"""
    return templates.TemplateResponse("templates/asr_test.html", {"request": request})

@app.post('/api/asr/local')
async def asr_local_endpoint(
    file: UploadFile = File(None),
    audio_base64: str = Form(None),
    sample_rate: int = Form(16000),
    backend: str = Form('auto'),
    whisper_model: str = Form('small.en'),
    use_gpu: str = Form('auto'),  # 'auto'|'true'|'false'
    language: str = Form('en'),
    size: str = Form(None)
):
    """离线ASR接口骨架：接受WAV文件或base64编码音频，返回占位识别结果。

    - 不依赖上游源代码，仅参考其模块功能目标，采用自研接口避免GPL传染。
    - 后续可在 main_helper/asr_funasr_plugin.py 内实现 FunASR ONNX 推理。
    """
    try:
        wav_bytes = None
        if file is not None:
            wav_bytes = await file.read()
        elif audio_base64:
            import base64
            try:
                wav_bytes = base64.b64decode(audio_base64)
            except Exception:
                return JSONResponse({"success": False, "error": "audio_base64 解码失败"})
        else:
            return JSONResponse({"success": False, "error": "未提供音频"})

        # 根据请求参数调整后端
        local_asr.backend = backend or 'auto'
        # 兼容参数：如果提供了 size，则优先使用 size；否则使用 whisper_model
        local_asr.whisper_model = (size or whisper_model or local_asr.whisper_model)
        if use_gpu in ('true', 'false'):
            local_asr.use_gpu = (use_gpu == 'true')
        else:
            local_asr.use_gpu = None
        # 语言锁定，避免自动语言检测带来的波动
        local_asr.lang = language or local_asr.lang

        # 执行识别
        result = local_asr.transcribe_from_wav_bytes(wav_bytes, sample_rate=sample_rate)
        return {"success": True, "result": result}
    except Exception as e:
        logger.error(f"ASR识别失败: {e}")
        return JSONResponse({"success": False, "error": str(e)})

@app.post('/api/tts/local')
async def tts_local_endpoint(
    text: str = Form(...),
    provider: str = Form('pyttsx3'),
    voice: str = Form(None),
    language: str = Form('en'),
    sample_rate: int = Form(24000),
    fmt: str = Form('wav'),
    service_url: str = Form(None),
    return_base64: str = Form('false'),  # 'true'|'false'
):
    """离线TTS接口：接受文本，返回音频。支持pyttsx3与HTTP代理服务。

    - provider='pyttsx3' 无需模型即可离线合成（系统TTS）。
    - provider='http'|'cosyvoice'|'xtts'|'chattts' 通过 `service_url` 调本地服务。
    - return_base64='true' 时返回JSON的base64，否则返回音频字节（audio/wav|audio/mpeg）。
    """
    try:
        # 统一模型目录，和ASR放在同一个父目录下（data/）
        tts_model_dir = os.path.join('upstream', 'ai_virtual_mate_web', 'data', 'tts_model')
        try:
            os.makedirs(tts_model_dir, exist_ok=True)
        except Exception:
            pass

        audio_bytes, mime = local_tts_synthesize(
            text=text,
            provider=provider,
            voice=voice,
            language=language,
            sample_rate=sample_rate,
            fmt=fmt,
            model_dir=tts_model_dir,
            service_url=service_url,
        )
        if return_base64.lower() == 'true':
            import base64
            b64 = base64.b64encode(audio_bytes).decode('utf-8')
            return {"success": True, "audio_base64": b64, "mime": mime, "sample_rate": sample_rate}
        else:
            return Response(content=audio_bytes, media_type=mime)
    except TTSLocalError as e:
        logger.error(f"TTS合成失败: {e}")
        return JSONResponse({"success": False, "error": str(e)}, status_code=400)
    except Exception as e:
        logger.error(f"TTS接口异常: {e}")
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)

@app.get("/api/preferences")
async def get_preferences():
    """获取用户偏好设置"""
    preferences = load_user_preferences()
    return preferences

@app.post("/api/preferences")
async def save_preferences(request: Request):
    """保存用户偏好设置"""
    try:
        data = await request.json()
        if not data:
            return {"success": False, "error": "无效的数据"}
        
        # 验证偏好数据
        if not validate_model_preferences(data):
            return {"success": False, "error": "偏好数据格式无效"}
        
        # 更新偏好（新版支持扩展字段，旧版仍兼容）
        if update_preferences_generic(data):
            return {"success": True, "message": "偏好设置已保存"}
        else:
            return {"success": False, "error": "保存失败"}
            
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.get("/api/live2d/models")
async def get_live2d_models(simple: bool = False):
    """
    获取Live2D模型列表
    Args:
        simple: 如果为True，只返回模型名称列表；如果为False，返回完整的模型信息
    """
    try:
        models = find_models()
        
        if simple:
            # 只返回模型名称列表
            model_names = [model["name"] for model in models]
            return {"success": True, "models": model_names}
        else:
            # 返回完整的模型信息（保持向后兼容）
            return models
    except Exception as e:
        logger.error(f"获取Live2D模型列表失败: {e}")
        if simple:
            return {"success": False, "error": str(e)}
        else:
            return []

@app.get("/api/models")
async def get_models_legacy():
    """
    向后兼容的API端点，重定向到新的 /api/live2d/models
    """
    return await get_live2d_models(simple=False)

@app.post("/api/preferences/set-preferred")
async def set_preferred_model(request: Request):
    """设置首选模型"""
    try:
        data = await request.json()
        if not data or 'model_path' not in data:
            return {"success": False, "error": "无效的数据"}
        
        if move_model_to_top(data['model_path']):
            return {"success": True, "message": "首选模型已更新"}
        else:
            return {"success": False, "error": "模型不存在或更新失败"}
            
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.get("/api/config/core_api")
async def get_core_config():
    """获取核心配置（API Key）"""
    try:
        # 尝试从core_config.json读取
        try:
            with open('./config/core_config.json', 'r', encoding='utf-8') as f:
                core_cfg = json.load(f)
                api_key = core_cfg.get('coreApiKey', '')
        except FileNotFoundError:
            # 如果文件不存在，返回当前内存中的CORE_API_KEY
            api_key = CORE_API_KEY
        
        return {
            "api_key": api_key,
            "coreApi": core_cfg.get('coreApi', 'qwen'),
            "assistApi": core_cfg.get('assistApi', 'qwen'),
            "assistApiKeyQwen": core_cfg.get('assistApiKeyQwen', ''),
            "assistApiKeyOpenai": core_cfg.get('assistApiKeyOpenai', ''),
            "assistApiKeyGlm": core_cfg.get('assistApiKeyGlm', ''),
            "success": True
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }


@app.post("/api/config/core_api")
async def update_core_config(request: Request):
    """更新核心配置（API Key）"""
    try:
        data = await request.json()
        if not data:
            return {"success": False, "error": "无效的数据"}
        
        if 'coreApiKey' not in data:
            return {"success": False, "error": "缺少coreApiKey字段"}
        
        api_key = data['coreApiKey']
        if api_key is None:
            return {"success": False, "error": "API Key不能为null"}
        
        if not isinstance(api_key, str):
            return {"success": False, "error": "API Key必须是字符串类型"}
        
        api_key = api_key.strip()
        if not api_key:
            return {"success": False, "error": "API Key不能为空"}
        
        # 保存到core_config.json
        core_cfg = {"coreApiKey": api_key}
        if 'coreApi' in data:
            core_cfg['coreApi'] = data['coreApi']
        if 'assistApi' in data:
            core_cfg['assistApi'] = data['assistApi']
        if 'assistApiKeyQwen' in data:
            core_cfg['assistApiKeyQwen'] = data['assistApiKeyQwen']
        if 'assistApiKeyOpenai' in data:
            core_cfg['assistApiKeyOpenai'] = data['assistApiKeyOpenai']
        if 'assistApiKeyGlm' in data:
            core_cfg['assistApiKeyGlm'] = data['assistApiKeyGlm']
        with open('./config/core_config.json', 'w', encoding='utf-8') as f:
            json.dump(core_cfg, f, indent=2, ensure_ascii=False)
        
        return {"success": True, "message": "API Key已保存"}
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.on_event("startup")
async def startup_event():
    global sync_process
    logger.info("Starting sync connector processes")
    # 启动同步连接器进程
    start_cfg = get_start_config()
    if not start_cfg.get('disable_sync_connectors', False):
        for k in sync_process:
            if sync_process[k] is None:
                sync_process[k] = Process(
                    target=cross_server.sync_connector_process,
                    args=(sync_message_queue[k], sync_shutdown_event[k], k, f"ws://localhost:{MONITOR_SERVER_PORT}", {'bullet': False, 'monitor': True})
                )
                sync_process[k].start()
                logger.info(f"同步连接器进程已启动 (PID: {sync_process[k].pid})")
    else:
        logger.info("已禁用同步连接器，跳过启动。")

    # 自启动 memory_server：若未就绪则尝试拉起并等待就绪（可禁用）
    try:
        from config import MEMORY_SERVER_PORT
        import httpx

        async def ensure_memory_server_ready() -> bool:
            try:
                # 禁用环境代理，避免本地 127.0.0.1 请求被系统/公司代理劫持导致 502
                async with httpx.AsyncClient(timeout=1.0, trust_env=False) as client:
                    r = await client.get(f"http://127.0.0.1:{MEMORY_SERVER_PORT}/new_dialog/{her_name}")
                    if r.is_success:
                        logger.info("memory_server 已就绪")
                        return True
            except Exception as e:
                logger.warning(f"memory_server 未响应，将尝试自启动: {e}")

            try:
                ms_path = os.path.join(os.path.dirname(__file__), "memory_server.py")
                # 不吞日志：继承父进程的 stdout/stderr，便于在控制台直接查看原因
                launch_cmd = [sys.executable, ms_path, "--enable-shutdown"]
                logger.info(f"即将启动 memory_server：{' '.join(launch_cmd)} (端口: {MEMORY_SERVER_PORT})")
                proc = subprocess.Popen(launch_cmd, stdout=None, stderr=None)
                logger.info(f"已拉起 memory_server (PID: {proc.pid})，等待就绪...")

                # 轮询等待端口就绪（最长约10秒），并在每次失败时记录一次简要原因
                for i in range(50):  # 50 * 0.2s = 10秒
                    await asyncio.sleep(0.2)
                    try:
                        # 禁用环境代理，确保直连本地端口
                        async with httpx.AsyncClient(timeout=0.8, trust_env=False) as client:
                            r = await client.get(f"http://127.0.0.1:{MEMORY_SERVER_PORT}/new_dialog/{her_name}")
                            if r.is_success:
                                logger.info("memory_server 就绪")
                                return True
                            else:
                                logger.warning(f"memory_server 响应非成功状态: {r.status_code}")
                    except Exception as e:
                        if i % 5 == 0:
                            logger.warning(f"memory_server 仍未就绪 (尝试 {i+1}/50)：{e}")

                logger.error("memory_server 自启动后仍未就绪：请检查依赖安装、API Key 配置或端口占用。")
            except Exception as e:
                logger.error(f"自启动 memory_server 失败: {e}")
            return False

        if not start_cfg.get('disable_memory_server', False):
            ready = await ensure_memory_server_ready()
            if not ready:
                logger.warning("memory_server 未就绪，部分会话初始化可能失败")
        else:
            logger.info("已禁用记忆服务器，跳过就绪检查与自启动。")
    except Exception as e:
        logger.warning(f"检测/拉起 memory_server 过程出错: {e}")

    # 如果启用了浏览器模式，在服务器启动完成后打开浏览器
    current_config = get_start_config()
    print(f"启动配置: {current_config}")
    if current_config['browser_mode_enabled']:
        import threading
        
        def launch_browser_delayed():
            # 等待一小段时间确保服务器完全启动
            import time
            time.sleep(1)
            # 从 app.state 获取配置
            config = get_start_config()
            url = f"http://127.0.0.1:{MAIN_SERVER_PORT}/{config['browser_page']}"
            try:
                webbrowser.open(url)
                logger.info(f"服务器启动完成，已打开浏览器访问: {url}")
            except Exception as e:
                logger.error(f"打开浏览器失败: {e}")
        
        # 在独立线程中启动浏览器
        t = threading.Thread(target=launch_browser_delayed, daemon=True)
        t.start()


@app.on_event("shutdown")
async def shutdown_event():
    """应用关闭时执行"""
    logger.info("Shutting down sync connector processes")
    # 关闭同步服务器连接
    for k in sync_process:
        if sync_process[k] is not None:
            sync_shutdown_event[k].set()
            sync_process[k].join(timeout=3)  # 等待进程正常结束
            if sync_process[k].is_alive():
                sync_process[k].terminate()  # 如果超时，强制终止
    logger.info("同步连接器进程已停止")
    
    # 向memory_server发送关闭信号
    try:
        import requests
        from config import MEMORY_SERVER_PORT
        shutdown_url = f"http://localhost:{MEMORY_SERVER_PORT}/shutdown"
        response = requests.post(shutdown_url, timeout=2)
        if response.status_code == 200:
            logger.info("已向memory_server发送关闭信号")
        else:
            logger.warning(f"向memory_server发送关闭信号失败，状态码: {response.status_code}")
    except Exception as e:
        logger.warning(f"向memory_server发送关闭信号时出错: {e}")


# 管理接口：禁用/启用记忆服务器、清理缓存、软重启
@app.post('/api/admin/memory/disable')
async def api_admin_disable_memory():
    cfg = get_start_config()
    cfg['disable_memory_server'] = True
    set_start_config(cfg)
    return {"success": True, "disable_memory_server": True}


@app.post('/api/admin/memory/enable')
async def api_admin_enable_memory():
    cfg = get_start_config()
    cfg['disable_memory_server'] = False
    set_start_config(cfg)
    return {"success": True, "disable_memory_server": False}


@app.post('/api/admin/sync/disable')
async def api_admin_disable_sync():
    cfg = get_start_config()
    cfg['disable_sync_connectors'] = True
    set_start_config(cfg)
    return {"success": True, "disable_sync_connectors": True}


@app.post('/api/admin/sync/enable')
async def api_admin_enable_sync():
    cfg = get_start_config()
    cfg['disable_sync_connectors'] = False
    set_start_config(cfg)
    return {"success": True, "disable_sync_connectors": False}


@app.post('/api/admin/cache/flush')
async def api_admin_flush_cache():
    """清理 memory/store 下的缓存文件（recent/setting/semantic/time-index）。"""
    import glob, os
    try:
        store_dir = os.path.join(os.path.dirname(__file__), 'memory', 'store')
        os.makedirs(store_dir, exist_ok=True)
        patterns = [
            os.path.join(store_dir, 'recent_*.json'),
            os.path.join(store_dir, 'settings_*.json'),
            os.path.join(store_dir, 'semantic_memory_*'),
            os.path.join(store_dir, 'time_indexed_*'),
        ]
        removed = []
        for p in patterns:
            for f in glob.glob(p):
                try:
                    if os.path.isdir(f):
                        # 目录：尝试删除目录内文件
                        for root, dirs, files in os.walk(f, topdown=False):
                            for name in files:
                                os.remove(os.path.join(root, name))
                            for name in dirs:
                                os.rmdir(os.path.join(root, name))
                        os.rmdir(f)
                    else:
                        os.remove(f)
                    removed.append(os.path.basename(f))
                except Exception as e:
                    logger.warning(f"删除 {f} 失败: {e}")
        return {"success": True, "removed": removed}
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


@app.post('/api/admin/restart')
async def api_admin_restart():
    """触发软重启：优雅关闭同步进程与记忆服务器，并请求主服务退出。"""
    try:
        # 关闭同步进程
        for k in sync_process:
            if sync_process[k] is not None:
                sync_shutdown_event[k].set()
                sync_process[k].join(timeout=3)
                if sync_process[k].is_alive():
                    sync_process[k].terminate()
        # 关闭记忆服务器
        try:
            import requests
            from config import MEMORY_SERVER_PORT
            shutdown_url = f"http://localhost:{MEMORY_SERVER_PORT}/shutdown"
            requests.post(shutdown_url, timeout=1)
        except Exception:
            pass
        # 请求主服务退出
        cfg = get_start_config()
        if cfg.get('server') is not None:
            cfg['server'].should_exit = True
        return {"success": True, "message": "服务已请求退出，请重新启动。"}
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


@app.websocket("/ws/{ee_name}")
async def websocket_endpoint(websocket: WebSocket, ee_name: str):
    await websocket.accept()
    # 对非法/保留名进行回退，确保 session_manager 存在对应键
    resolved_name = ee_name if ee_name in session_manager else her_name
    this_session_id = uuid.uuid4()
    async with lock:
        global session_id
        session_id[resolved_name] = this_session_id
    logger.info(
        f"⭐websocketWebSocket accepted: {websocket.client}, new session id: {session_id[resolved_name]}, ee_name: {ee_name}, resolved: {resolved_name}"
    )

    try:
        ws_closed = False
        while True:
            # 更稳健的收包：同时兼容文本与二进制帧，避免非文本导致异常断开
            event = await websocket.receive()
            # 单连接占用策略：若会话被新的终端抢占，通知并关闭当前连接
            if session_id[resolved_name] != this_session_id:
                await session_manager[resolved_name].send_status(f"切换至另一个终端...")
                if not ws_closed:
                    try:
                        await websocket.close()
                    except Exception as e:
                        logger.debug(f"websocket.close 失败或已关闭: {e}")
                    ws_closed = True
                break

            # 仅处理文本消息；忽略客户端的二进制帧（如误发的ping或其他数据）
            if event.get("type") == "websocket.disconnect":
                ws_closed = True
                break
            if event.get("text") is not None:
                data = event["text"]
            elif event.get("bytes") is not None:
                # 忽略来自客户端的二进制帧，服务端不会在此路由接收二进制
                continue
            else:
                # 未知事件类型，继续等待下一条
                continue

            message = json.loads(data)
            action = message.get("action")
            # logger.debug(f"WebSocket received action: {action}") # Optional debug log

            if action == "start_session":
                session_manager[resolved_name].active_session_is_idle = False
                input_type = message.get("input_type")
                # 调试日志：确认会话名与内存服务端口
                try:
                    logger.info(
                        f"准备启动会话: resolved={resolved_name}, manager.lanlan_name={getattr(session_manager[resolved_name], 'lanlan_name', None)}, memory_port={getattr(session_manager[resolved_name], 'memory_server_port', None)}"
                    )
                except Exception:
                    pass
                if input_type in ['audio', 'screen', 'camera']:
                    asyncio.create_task(session_manager[resolved_name].start_session(websocket, message.get("new_session", False)))
                else:
                    await session_manager[resolved_name].send_status(f"Invalid input type: {input_type}")

            elif action == "stream_data":
                asyncio.create_task(session_manager[resolved_name].stream_data(message))

            elif action == "end_session":
                session_manager[resolved_name].active_session_is_idle = False
                asyncio.create_task(session_manager[resolved_name].end_session())

            elif action == "pause_session":
                session_manager[resolved_name].active_session_is_idle = True

            else:
                logger.warning(f"Unknown action received: {action}")
                await session_manager[resolved_name].send_status(f"Unknown action: {action}")

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected: {websocket.client}")
    except Exception as e:
        error_message = f"WebSocket handler error: {e}"
        logger.error(f"💥 {error_message}")
        logger.error(traceback.format_exc())
        try:
            await session_manager[resolved_name].send_status(f"Server error: {e}")
        except:
            pass
    finally:
        logger.info(f"Cleaning up WebSocket resources: {websocket.client}")
        await session_manager[resolved_name].cleanup()

# 默认 WebSocket 回退路由：当未提供 ee_name 时，使用当前默认角色名
@app.websocket("/ws")
async def websocket_endpoint_default(websocket: WebSocket):
    # 复用主处理函数逻辑，避免重复代码
    await websocket_endpoint(websocket, ee_name=her_name)

@app.get('/api/debug/state')
async def debug_state():
    """调试端点：查看当前默认角色、可用角色以及会话管理器的实际名称映射。"""
    try:
        keys = list(session_manager.keys())
        names = {k: getattr(session_manager[k], 'lanlan_name', None) for k in keys}
        return {
            "her_name": her_name,
            "catgirl_names": catgirl_names,
            "session_manager_keys": keys,
            "session_manager_names": names
        }
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)

@app.post('/api/unity/send')
async def unity_send(request: Request):
    """将后端指令转发到观众端（Unity等），通过同步队列广播给 /sync/{lanlan_name}。

    请求体示例：
    {
      "lanlan_name": "EE",
      "commands": [
        {"type":"anim.play","state":"X Bot@Having A Meeting, Female","layer":0,"fade":0.25,"speed":1.0},
        {"type":"face.expression","name":"happy","weight":0.8},
        {"type":"face.mouth","aa":0.6,"ee":0.2,"ih":0,"oh":0.1,"ou":0}
      ]
    }
    """
    try:
        data = await request.json()
        # 支持新命名 ee_name，兼容旧字段
        lanlan = (data.get('ee_name') or data.get('lanlan_name') or her_name)
        if lanlan not in sync_message_queue:
            return JSONResponse({"success": False, "error": "EE not found"}, status_code=404)

        # 支持 commands 列表或单个 command
        commands = data.get('commands')
        if commands is None:
            single = data.get('command') or {}
            commands = [single] if isinstance(single, dict) and single else []
        if not isinstance(commands, list):
            return JSONResponse({"success": False, "error": "commands must be a list"}, status_code=400)

        sent = 0
        for cmd in commands:
            if isinstance(cmd, dict) and 'type' in cmd:
                # 直接广播原始JSON，Unity侧按 type 分发处理
                sync_message_queue[lanlan].put({'type': 'json', 'data': cmd})
                sent += 1

        return {"success": True, "count": sent}
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)

@app.post('/api/notify_task_result')
async def notify_task_result(request: Request):
    """供工具/任务服务回调：在下一次正常回复之后，插入一条任务完成提示。"""
    try:
        data = await request.json()
        # 如果未显式提供，则使用当前默认角色，支持 ee_name
        lanlan = (data.get('ee_name') or data.get('lanlan_name') or her_name)
        text = (data.get('text') or '').strip()
        if not text:
            return JSONResponse({"success": False, "error": "text required"}, status_code=400)
        mgr = session_manager.get(lanlan)
        if not mgr:
            return JSONResponse({"success": False, "error": "EE not found"}, status_code=404)
        # 将提示加入待插入队列
        mgr.pending_extra_replies.append(text)
        return {"success": True}
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)

@app.get("/l2d", response_class=HTMLResponse)
async def get_l2d_manager(request: Request, ee_name: str = ""):
    """渲染Live2D模型管理器页面"""
    return templates.TemplateResponse("templates/l2d_manager.html", {
        "request": request,
        "ee_name": ee_name
    })

@app.get('/api/characters/current_live2d_model')
async def get_current_live2d_model(catgirl_name: str = ""):
    """获取指定角色或当前角色的Live2D模型信息"""
    try:
        characters = load_characters()
        
        # 如果没有指定角色名称，使用当前角色（兼容旧字段）
        if not catgirl_name:
            catgirl_name = characters.get('当前角色', '') or characters.get('当前猫娘', '')
        
        # 查找指定角色的Live2D模型
        live2d_model_name = None
        model_info = None
        
        # 在角色列表中查找（优先 Vtuber，其次 猫娘）
        roles = characters.get('Vtuber') or characters.get('猫娘') or {}
        if catgirl_name in roles:
            catgirl_data = roles[catgirl_name]
            live2d_model_name = catgirl_data.get('live2d')
        
        # 如果找到了模型名称，获取模型信息
        if live2d_model_name:
            try:
                # 检查模型是否存在
                model_dir = os.path.join(os.path.dirname(__file__), 'static', live2d_model_name)
                if os.path.exists(model_dir):
                    # 查找模型配置文件
                    model_files = [f for f in os.listdir(model_dir) if f.endswith('.model3.json')]
                    if model_files:
                        model_file = model_files[0]
                        model_path = f'/static/{live2d_model_name}/{model_file}'
                        model_info = {
                            'name': live2d_model_name,
                            'path': model_path
                        }
            except Exception as e:
                logger.warning(f"获取模型信息失败: {e}")
        
        return JSONResponse(content={
            'success': True,
            'catgirl_name': catgirl_name,
            'model_name': live2d_model_name,
            'model_info': model_info
        })
        
    except Exception as e:
        logger.error(f"获取角色Live2D模型失败: {e}")
        return JSONResponse(content={
            'success': False,
            'error': str(e)
        })

@app.get('/chara_manager', response_class=HTMLResponse)
async def chara_manager(request: Request):
    """渲染主控制页面"""
    return templates.TemplateResponse('templates/chara_manager.html', {"request": request})

@app.get('/voice_clone', response_class=HTMLResponse)
async def voice_clone_page(request: Request, ee_name: str = ""):
    return templates.TemplateResponse("templates/voice_clone.html", {"request": request, "ee_name": ee_name})

@app.get("/api_key", response_class=HTMLResponse)
async def api_key_settings(request: Request):
    """API Key 设置页面"""
    return templates.TemplateResponse("templates/api_key_settings.html", {
        "request": request
    })

@app.get('/api/characters')
async def get_characters():
    return JSONResponse(content=load_characters())

@app.get('/api/characters/current_catgirl')
async def get_current_catgirl():
    """获取当前使用的角色名称（兼容旧字段）"""
    characters = load_characters()
    current_role = characters.get('当前角色', '') or characters.get('当前猫娘', '')
    # 兼容返回旧键，前端逐步迁移到 current_role
    return JSONResponse(content={'current_role': current_role, 'current_catgirl': current_role})

@app.post('/api/characters/current_catgirl')
async def set_current_catgirl(request: Request):
    """设置当前使用的角色（兼容接收 catgirl_name/role_name）"""
    data = await request.json()
    catgirl_name = (data.get('role_name') or data.get('catgirl_name') or '') if data else ''
    
    if not catgirl_name:
        return JSONResponse({'success': False, 'error': '角色名称不能为空'}, status_code=400)
    
    characters = load_characters()
    roles = characters.get('Vtuber') or characters.get('猫娘') or {}
    if catgirl_name not in roles:
        return JSONResponse({'success': False, 'error': '指定的角色不存在'}, status_code=404)
    
    # 写入新字段，清理旧字段
    characters['当前角色'] = catgirl_name
    if '当前猫娘' in characters:
        characters.pop('当前猫娘')
    save_characters(characters)
    return {"success": True}

@app.post('/api/characters/master')
async def update_master(request: Request):
    data = await request.json()
    if not data or not data.get('档案名'):
        return JSONResponse({'success': False, 'error': '档案名为必填项'}, status_code=400)
    characters = load_characters()
    characters['主人'] = {k: v for k, v in data.items() if v}
    save_characters(characters)
    return {"success": True}

@app.post('/api/characters/catgirl')
async def add_catgirl(request: Request):
    data = await request.json()
    if not data or not data.get('档案名'):
        return JSONResponse({'success': False, 'error': '档案名为必填项'}, status_code=400)
    
    characters = load_characters()
    key = data['档案名']
    roles_key = 'Vtuber' if 'Vtuber' in characters else '猫娘'
    if key in characters.get(roles_key, {}):
        return JSONResponse({'success': False, 'error': '该角色已存在'}, status_code=400)
    
    if roles_key not in characters:
        characters[roles_key] = {}
    
    # 创建角色数据，只保存非空字段
    catgirl_data = {}
    for k, v in data.items():
        if k != '档案名' and v:  # 只保存非空字段
            catgirl_data[k] = v
    
    characters[roles_key][key] = catgirl_data
    save_characters(characters)
    return {"success": True}

@app.put('/api/characters/catgirl/{name}')
async def update_catgirl(name: str, request: Request):
    data = await request.json()
    if not data:
        return JSONResponse({'success': False, 'error': '无数据'}, status_code=400)
    characters = load_characters()
    roles_key = 'Vtuber' if 'Vtuber' in characters else '猫娘'
    if name not in characters.get(roles_key, {}):
        return JSONResponse({'success': False, 'error': '角色不存在'}, status_code=404)
    # 只更新前端传来的字段，未传字段保留原值，且不允许通过此接口修改 system_prompt
    removed_fields = []
    for k, v in characters[roles_key][name].items():
        if k not in data and k not in ('档案名', 'system_prompt', 'voice_id', 'live2d'):
            removed_fields.append(k)
    for k in removed_fields:
        characters[roles_key][name].pop(k)
    for k, v in data.items():
        if k not in ('档案名') and v:
            characters[roles_key][name][k] = v
    save_characters(characters)
    return {"success": True}

@app.put('/api/characters/catgirl/l2d/{name}')
async def update_catgirl_l2d(name: str, request: Request):
    """更新指定角色的Live2D模型设置"""
    try:
        data = await request.json()
        live2d_model = data.get('live2d')
        
        if not live2d_model:
            return JSONResponse(content={
                'success': False,
                'error': '未提供Live2D模型名称'
            })
        
        # 加载当前角色配置
        characters = load_characters()
        
        roles_key = 'Vtuber' if 'Vtuber' in characters else '猫娘'
        # 确保角色配置存在
        if roles_key not in characters:
            characters[roles_key] = {}
        
        # 确保指定角色的配置存在
        if name not in characters[roles_key]:
            characters[roles_key][name] = {}
        
        # 更新Live2D模型设置
        characters[roles_key][name]['live2d'] = live2d_model
        
        # 保存配置
        save_characters(characters)
        
        return JSONResponse(content={
            'success': True,
            'message': f'已更新角色 {name} 的Live2D模型为 {live2d_model}'
        })
        
    except Exception as e:
        logger.error(f"更新角色Live2D模型失败: {e}")
        return JSONResponse(content={
            'success': False,
            'error': str(e)
        })

@app.put('/api/characters/catgirl/voice_id/{name}')
async def update_catgirl_voice_id(name: str, request: Request):
    data = await request.json()
    if not data:
        return JSONResponse({'success': False, 'error': '无数据'}, status_code=400)
    characters = load_characters()
    roles_key = 'Vtuber' if 'Vtuber' in characters else '猫娘'
    if name not in characters.get(roles_key, {}):
        return JSONResponse({'success': False, 'error': '角色不存在'}, status_code=404)
    if 'voice_id' in data:
        characters[roles_key][name]['voice_id'] = data['voice_id']
    save_characters(characters)
    return {"success": True}

@app.post('/api/characters/clear_voice_ids')
async def clear_voice_ids():
    """清除所有角色的本地Voice ID记录"""
    try:
        characters = load_characters()
        cleared_count = 0
        
        roles_key = 'Vtuber' if 'Vtuber' in characters else '猫娘'
        if roles_key in characters:
            for name in characters[roles_key]:
                if 'voice_id' in characters[roles_key][name] and characters[roles_key][name]['voice_id']:
                    characters[roles_key][name]['voice_id'] = ''
                    cleared_count += 1
        
        save_characters(characters)
        
        return JSONResponse({
            'success': True, 
            'message': f'已清除 {cleared_count} 个角色的Voice ID记录',
            'cleared_count': cleared_count
        })
    except Exception as e:
        return JSONResponse({
            'success': False, 
            'error': f'清除Voice ID记录时出错: {str(e)}'
        }, status_code=500)

@app.post('/api/voice_clone')
async def voice_clone(file: UploadFile = File(...), prefix: str = Form(...)):
    import os
    temp_path = f'tmp_{file.filename}'
    with open(temp_path, 'wb') as f:
        f.write(await file.read())
    tmp_url = None

    def validate_audio_file(file_path: str) -> tuple[str, str]:
        """
        验证音频文件类型和格式
        返回: (mime_type, error_message)
        """
        file_path_obj = pathlib.Path(file_path)
        file_extension = file_path_obj.suffix.lower()
        
        # 检查文件扩展名
        if file_extension not in ['.wav', '.mp3', '.m4a']:
            return "", f"不支持的文件格式: {file_extension}。仅支持 WAV、MP3 和 M4A 格式。"
        
        # 根据扩展名确定MIME类型
        if file_extension == '.wav':
            mime_type = "audio/wav"
            # 检查WAV文件是否为16bit
            try:
                with wave.open(file_path, 'rb') as wav_file:
                    # 检查采样宽度（bit depth）
                    if wav_file.getsampwidth() != 2:  # 2 bytes = 16 bits
                        return "", f"WAV文件必须是16bit格式，当前文件是{wav_file.getsampwidth() * 8}bit。"
                    
                    # 检查声道数（建议单声道）
                    channels = wav_file.getnchannels()
                    if channels > 1:
                        return "", f"建议使用单声道WAV文件，当前文件有{channels}个声道。"
                    
                    # 检查采样率
                    sample_rate = wav_file.getframerate()
                    if sample_rate not in [8000, 16000, 22050, 44100, 48000]:
                        return "", f"建议使用标准采样率(8000, 16000, 22050, 44100, 48000)，当前文件采样率: {sample_rate}Hz。"
                    
            except Exception as e:
                return "", f"WAV文件格式错误: {str(e)}。请确认您的文件是合法的WAV文件。"
                
        elif file_extension == '.mp3':
            mime_type = "audio/mpeg"
            try:
                with open(file_path, 'rb') as f:
                    # 读取更多字节以支持不同的MP3格式
                    header = f.read(32)

                    # 检查文件大小是否合理
                    file_size = os.path.getsize(file_path)
                    if file_size < 1024:  # 至少1KB
                        return "", "MP3文件太小，可能不是有效的音频文件。"
                    if file_size > 1024 * 1024 * 10:  # 10MB
                        return "", "MP3文件太大，可能不是有效的音频文件。"
                    
                    # 更宽松的MP3文件头检查
                    # MP3文件通常以ID3标签或帧同步字开头
                    # 检查是否以ID3标签开头 (ID3v2)
                    has_id3_header = header.startswith(b'ID3')
                    # 检查是否有帧同步字 (FF FA, FF FB, FF F2, FF F3, FF E3等)
                    has_frame_sync = False
                    for i in range(len(header) - 1):
                        if header[i] == 0xFF and (header[i+1] & 0xE0) == 0xE0:
                            has_frame_sync = True
                            break
                    
                    # 如果既没有ID3标签也没有帧同步字，则认为文件可能无效
                    # 但这只是一个警告，不应该严格拒绝
                    if not has_id3_header and not has_frame_sync:
                        return mime_type, "警告: MP3文件可能格式不标准，文件头: {header[:4].hex()}"
                        
            except Exception as e:
                return "", f"MP3文件读取错误: {str(e)}。请确认您的文件是合法的MP3文件。"
                
        elif file_extension == '.m4a':
            mime_type = "audio/mp4"
            try:
                with open(file_path, 'rb') as f:
                    # 读取文件头来验证M4A格式
                    header = f.read(32)
                    
                    # M4A文件应该以'ftyp'盒子开始，通常在偏移4字节处
                    # 检查是否包含'ftyp'标识
                    if b'ftyp' not in header:
                        return "", "M4A文件格式无效或已损坏。请确认您的文件是合法的M4A文件。"
                    
                    # 进一步验证：检查是否包含常见的M4A类型标识
                    # M4A通常包含'mp4a', 'M4A ', 'M4V '等类型
                    valid_types = [b'mp4a', b'M4A ', b'M4V ', b'isom', b'iso2', b'avc1']
                    has_valid_type = any(t in header for t in valid_types)
                    
                    if not has_valid_type:
                        return mime_type,  "警告: M4A文件格式无效或已损坏。请确认您的文件是合法的M4A文件。"
                        
            except Exception as e:
                return "", f"M4A文件读取错误: {str(e)}。请确认您的文件是合法的M4A文件。"
        
        return mime_type, ""

    try:
        # 1. 上传到 tmpfiles.org
        mime_type, error_msg = validate_audio_file(temp_path)
        if not mime_type:
            return JSONResponse({'error': error_msg}, status_code=400)
        with open(temp_path, 'rb') as f2:
            files = {'file': (file.filename, f2)}
            resp = requests.post('https://tmpfiles.org/api/v1/upload', files=files, timeout=30)
            data = resp.json()
            if not data or 'data' not in data or 'url' not in data['data']:
                return JSONResponse({'error': '上传到 tmpfiles.org 失败'}, status_code=500)
            page_url = data['data']['url']
            # 替换域名部分为直链
            if page_url.startswith('http://tmpfiles.org/'):
                tmp_url = page_url.replace('http://tmpfiles.org/', 'http://tmpfiles.org/dl/', 1)
            elif page_url.startswith('https://tmpfiles.org/'):
                tmp_url = page_url.replace('https://tmpfiles.org/', 'https://tmpfiles.org/dl/', 1)
            else:
                tmp_url = page_url  # 兜底
        # 2. 用直链注册音色
        if not DASHSCOPE_AVAILABLE:
            return JSONResponse({'error': 'dashscope 未安装或不可用，无法进行声音注册', 'file_url': tmp_url}, status_code=500)
        dashscope.api_key = AUDIO_API_KEY
        service = VoiceEnrollmentService()
        target_model = "cosyvoice-v2"
        voice_id = service.create_voice(target_model=target_model, prefix=prefix, url=tmp_url)
        return JSONResponse({
            'voice_id': voice_id,
            'request_id': service.get_last_request_id(),
            'file_url': tmp_url
        })
    except Exception as e:
        return JSONResponse({'error': str(e), 'file_url': tmp_url}, status_code=500)
    finally:
        try:
            os.remove(temp_path)
        except Exception:
            pass

@app.delete('/api/characters/catgirl/{name}')
async def delete_catgirl(name: str):
    characters = load_characters()
    roles_key = 'Vtuber' if 'Vtuber' in characters else '猫娘'
    if name not in characters.get(roles_key, {}):
        return JSONResponse({'success': False, 'error': '角色不存在'}, status_code=404)
    del characters[roles_key][name]
    save_characters(characters)
    return {"success": True}

@app.post('/api/beacon/shutdown')
async def beacon_shutdown():
    """Beacon API for graceful server shutdown"""
    try:
        # 从 app.state 获取配置
        current_config = get_start_config()
        # 仅在明确允许时才响应页面关闭 Beacon
        if current_config['browser_mode_enabled'] and current_config.get('allow_beacon_shutdown', False):
            logger.info("收到beacon信号，准备关闭服务器...")
            # Schedule server shutdown
            asyncio.create_task(shutdown_server_async())
            return {"success": True, "message": "服务器关闭信号已接收"}
        else:
            logger.info("忽略浏览器关闭信号（自动关机已禁用）")
            return {"success": True, "message": "自动关机已禁用"}
    except Exception as e:
        logger.error(f"Beacon处理错误: {e}")
        return {"success": False, "error": str(e)}

async def shutdown_server_async():
    """异步关闭服务器"""
    try:
        # Give a small delay to allow the beacon response to be sent
        await asyncio.sleep(0.5)
        logger.info("正在关闭服务器...")
        
        # 向memory_server发送关闭信号
        try:
            import requests
            from config import MEMORY_SERVER_PORT
            shutdown_url = f"http://localhost:{MEMORY_SERVER_PORT}/shutdown"
            response = requests.post(shutdown_url, timeout=1)
            if response.status_code == 200:
                logger.info("已向memory_server发送关闭信号")
            else:
                logger.warning(f"向memory_server发送关闭信号失败，状态码: {response.status_code}")
        except Exception as e:
            logger.warning(f"向memory_server发送关闭信号时出错: {e}")
        
        # Signal the server to stop
        current_config = get_start_config()
        if current_config['server'] is not None:
            current_config['server'].should_exit = True
    except Exception as e:
        logger.error(f"关闭服务器时出错: {e}")

@app.post('/api/characters/catgirl/{old_name}/rename')
async def rename_catgirl(old_name: str, request: Request):
    data = await request.json()
    new_name = data.get('new_name') if data else None
    if not new_name:
        return JSONResponse({'success': False, 'error': '新档案名不能为空'}, status_code=400)
    characters = load_characters()
    roles_key = 'Vtuber' if 'Vtuber' in characters else '猫娘'
    if old_name not in characters.get(roles_key, {}):
        return JSONResponse({'success': False, 'error': '原角色不存在'}, status_code=404)
    if new_name in characters[roles_key]:
        return JSONResponse({'success': False, 'error': '新档案名已存在'}, status_code=400)
    # 重命名
    characters[roles_key][new_name] = characters[roles_key].pop(old_name)
    save_characters(characters)
    return {"success": True}

@app.post('/api/characters/catgirl/{name}/unregister_voice')
async def unregister_voice(name: str):
    """解除角色的声音注册"""
    try:
        characters = load_characters()
        roles_key = 'Vtuber' if 'Vtuber' in characters else '猫娘'
        if name not in characters.get(roles_key, {}):
            return JSONResponse({'success': False, 'error': '角色不存在'}, status_code=404)
        
        # 检查是否已有voice_id
        if not characters[roles_key][name].get('voice_id'):
            return JSONResponse({'success': False, 'error': '该角色未注册声音'}, status_code=400)
        
        # 删除voice_id字段
        if 'voice_id' in characters[roles_key][name]:
            characters[roles_key][name].pop('voice_id')
        save_characters(characters)
        
        logger.info(f"已解除角色 '{name}' 的声音注册")
        return {"success": True, "message": "声音注册已解除"}
        
    except Exception as e:
        logger.error(f"解除声音注册时出错: {e}")
        return JSONResponse({'success': False, 'error': f'解除注册失败: {str(e)}'}, status_code=500)

@app.get('/api/memory/recent_files')
async def get_recent_files():
    """获取 memory/store 下所有 recent*.json 文件名列表（绝对路径）"""
    base_store_dir = os.path.join(os.path.dirname(__file__), 'memory', 'store')
    try:
        os.makedirs(base_store_dir, exist_ok=True)
    except Exception:
        pass
    files = glob.glob(os.path.join(base_store_dir, 'recent*.json'))
    file_names = [os.path.basename(f) for f in files]
    return {"files": file_names}

@app.get('/api/memory/review_config')
async def get_review_config():
    """获取记忆审阅配置"""
    try:
        config_path = './config/core_config.json'
        if os.path.exists(config_path):
            with open(config_path, 'r', encoding='utf-8') as f:
                config_data = json.load(f)
                # 如果配置中没有这个键，默认返回True（开启）
                return {"enabled": config_data.get('recent_memory_auto_review', True)}
        else:
            # 如果配置文件不存在，默认返回True（开启）
            return {"enabled": True}
    except Exception as e:
        logger.error(f"读取记忆审阅配置失败: {e}")
        return {"enabled": True}

@app.post('/api/memory/review_config')
async def update_review_config(request: Request):
    """更新记忆审阅配置"""
    try:
        data = await request.json()
        enabled = data.get('enabled', True)
        
        config_path = './config/core_config.json'
        config_data = {}
        
        # 读取现有配置
        if os.path.exists(config_path):
            with open(config_path, 'r', encoding='utf-8') as f:
                config_data = json.load(f)
        
        # 更新配置
        config_data['recent_memory_auto_review'] = enabled
        
        # 保存配置
        with open(config_path, 'w', encoding='utf-8') as f:
            json.dump(config_data, f, ensure_ascii=False, indent=2)
        
        logger.info(f"记忆审阅配置已更新: enabled={enabled}")
        return {"success": True, "enabled": enabled}
    except Exception as e:
        logger.error(f"更新记忆审阅配置失败: {e}")
        return {"success": False, "error": str(e)}

@app.get('/api/memory/recent_file')
async def get_recent_file(filename: str):
    """获取指定 recent*.json 文件内容（绝对路径）"""
    base_store_dir = os.path.join(os.path.dirname(__file__), 'memory', 'store')
    file_path = os.path.join(base_store_dir, filename)
    if not (filename.startswith('recent') and filename.endswith('.json')):
        return JSONResponse({"success": False, "error": "文件名不合法"}, status_code=400)
    if not os.path.exists(file_path):
        return JSONResponse({"success": False, "error": "文件不存在"}, status_code=404)
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    return {"content": content}

@app.get('/api/memory/compact_config')
async def api_get_compact_config():
    try:
        async with httpx.AsyncClient(timeout=2.0, trust_env=False) as client:
            r = await client.get(f"http://127.0.0.1:{MEMORY_SERVER_PORT}/compact_config")
            return r.json()
    except Exception as e:
        try:
            ms_path = os.path.join(os.path.dirname(__file__), "memory_server.py")
            subprocess.Popen([sys.executable, ms_path, "--enable-shutdown"], stdout=None, stderr=None)
            await asyncio.sleep(0.8)
            async with httpx.AsyncClient(timeout=2.0, trust_env=False) as client:
                r = await client.get(f"http://127.0.0.1:{MEMORY_SERVER_PORT}/compact_config")
                return r.json()
        except Exception as e2:
            return {"success": False, "error": str(e2)}

@app.post('/api/memory/compact_config')
async def api_set_compact_config(payload: dict):
    try:
        async with httpx.AsyncClient(timeout=3.0, trust_env=False) as client:
            r = await client.post(f"http://127.0.0.1:{MEMORY_SERVER_PORT}/compact_config", json=payload)
            return r.json()
    except Exception as e:
        try:
            ms_path = os.path.join(os.path.dirname(__file__), "memory_server.py")
            subprocess.Popen([sys.executable, ms_path, "--enable-shutdown"], stdout=None, stderr=None)
            await asyncio.sleep(0.8)
            async with httpx.AsyncClient(timeout=3.0, trust_env=False) as client:
                r = await client.post(f"http://127.0.0.1:{MEMORY_SERVER_PORT}/compact_config", json=payload)
                return r.json()
        except Exception as e2:
            return {"success": False, "error": str(e2)}

@app.get("/api/live2d/model_config/{model_name}")
async def get_model_config(model_name: str):
    """获取指定Live2D模型的model3.json配置"""
    try:
        # 在模型目录中查找.model3.json文件
        model_dir = os.path.join('static', model_name)
        if not os.path.exists(model_dir):
            return JSONResponse(status_code=404, content={"success": False, "error": "模型目录不存在"})
        
        # 查找.model3.json文件
        model_json_path = None
        for file in os.listdir(model_dir):
            if file.endswith('.model3.json'):
                model_json_path = os.path.join(model_dir, file)
                break
        
        if not model_json_path or not os.path.exists(model_json_path):
            return JSONResponse(status_code=404, content={"success": False, "error": "模型配置文件不存在"})
        
        with open(model_json_path, 'r', encoding='utf-8') as f:
            config_data = json.load(f)
        
        # 检查并自动添加缺失的配置
        config_updated = False
        
        # 确保FileReferences存在
        if 'FileReferences' not in config_data:
            config_data['FileReferences'] = {}
            config_updated = True
        
        # 确保Motions存在
        if 'Motions' not in config_data['FileReferences']:
            config_data['FileReferences']['Motions'] = {}
            config_updated = True
        
        # 确保Expressions存在
        if 'Expressions' not in config_data['FileReferences']:
            config_data['FileReferences']['Expressions'] = []
            config_updated = True
        
        # 如果配置有更新，保存到文件
        if config_updated:
            with open(model_json_path, 'w', encoding='utf-8') as f:
                json.dump(config_data, f, ensure_ascii=False, indent=4)
            logger.info(f"已为模型 {model_name} 自动添加缺失的配置项")
            
        return {"success": True, "config": config_data}
    except Exception as e:
        logger.error(f"获取模型配置失败: {e}")
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})

@app.post("/api/live2d/model_config/{model_name}")
async def update_model_config(model_name: str, request: Request):
    """更新指定Live2D模型的model3.json配置"""
    try:
        data = await request.json()
        
        # 在模型目录中查找.model3.json文件
        model_dir = os.path.join('static', model_name)
        if not os.path.exists(model_dir):
            return JSONResponse(status_code=404, content={"success": False, "error": "模型目录不存在"})
        
        # 查找.model3.json文件
        model_json_path = None
        for file in os.listdir(model_dir):
            if file.endswith('.model3.json'):
                model_json_path = os.path.join(model_dir, file)
                break
        
        if not model_json_path or not os.path.exists(model_json_path):
            return JSONResponse(status_code=404, content={"success": False, "error": "模型配置文件不存在"})
        
        # 为了安全，只允许修改 Motions 和 Expressions
        with open(model_json_path, 'r', encoding='utf-8') as f:
            current_config = json.load(f)
            
        if 'FileReferences' in data and 'Motions' in data['FileReferences']:
            current_config['FileReferences']['Motions'] = data['FileReferences']['Motions']
            
        if 'FileReferences' in data and 'Expressions' in data['FileReferences']:
            current_config['FileReferences']['Expressions'] = data['FileReferences']['Expressions']

        with open(model_json_path, 'w', encoding='utf-8') as f:
            json.dump(current_config, f, ensure_ascii=False, indent=4) # 使用 indent=4 保持格式
            
        return {"success": True, "message": "模型配置已更新"}
    except Exception as e:
        logger.error(f"更新模型配置失败: {e}")
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})

@app.get('/api/live2d/model_files/{model_name}')
async def get_model_files(model_name: str):
    """获取指定Live2D模型的动作和表情文件列表"""
    try:
        # 构建模型目录路径
        model_dir = os.path.join(os.path.dirname(__file__), 'static', model_name)
        
        if not os.path.exists(model_dir):
            return {"success": False, "error": f"模型 {model_name} 不存在"}
        
        motion_files = []
        expression_files = []
        
        # 递归搜索所有子文件夹
        def search_files_recursive(directory, target_ext, result_list):
            """递归搜索指定扩展名的文件"""
            try:
                for item in os.listdir(directory):
                    item_path = os.path.join(directory, item)
                    if os.path.isfile(item_path):
                        if item.endswith(target_ext):
                            # 计算相对于模型根目录的路径
                            relative_path = os.path.relpath(item_path, model_dir)
                            # 转换为正斜杠格式（跨平台兼容）
                            relative_path = relative_path.replace('\\', '/')
                            result_list.append(relative_path)
                    elif os.path.isdir(item_path):
                        # 递归搜索子目录
                        search_files_recursive(item_path, target_ext, result_list)
            except Exception as e:
                logger.warning(f"搜索目录 {directory} 时出错: {e}")
        
        # 搜索动作文件
        search_files_recursive(model_dir, '.motion3.json', motion_files)
        
        # 搜索表情文件
        search_files_recursive(model_dir, '.exp3.json', expression_files)
        
        logger.info(f"模型 {model_name} 文件统计: {len(motion_files)} 个动作文件, {len(expression_files)} 个表情文件")
        return {
            "success": True, 
            "motion_files": motion_files,
            "expression_files": expression_files
        }
    except Exception as e:
        logger.error(f"获取模型文件列表失败: {e}")
        return {"success": False, "error": str(e)}

@app.get('/live2d_emotion_manager', response_class=HTMLResponse)
async def live2d_emotion_manager(request: Request):
    """Live2D情感映射管理器页面"""
    try:
        with open('templates/live2d_emotion_manager.html', 'r', encoding='utf-8') as f:
            content = f.read()
        return HTMLResponse(content=content)
    except Exception as e:
        logger.error(f"加载Live2D情感映射管理器页面失败: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.get('/api/live2d/emotion_mapping/{model_name}')
async def get_emotion_mapping(model_name: str):
    """获取情绪映射配置"""
    try:
        # 在模型目录中查找.model3.json文件
        model_dir = os.path.join('static', model_name)
        if not os.path.exists(model_dir):
            return JSONResponse(status_code=404, content={"success": False, "error": "模型目录不存在"})
        
        # 查找.model3.json文件
        model_json_path = None
        for file in os.listdir(model_dir):
            if file.endswith('.model3.json'):
                model_json_path = os.path.join(model_dir, file)
                break
        
        if not model_json_path or not os.path.exists(model_json_path):
            return JSONResponse(status_code=404, content={"success": False, "error": "模型配置文件不存在"})
        
        with open(model_json_path, 'r', encoding='utf-8') as f:
            config_data = json.load(f)

        # 优先使用 EmotionMapping；若不存在则从 FileReferences 推导
        emotion_mapping = config_data.get('EmotionMapping')
        if not emotion_mapping:
            derived_mapping = {"motions": {}, "expressions": {}}
            file_refs = config_data.get('FileReferences', {}) or {}

            # 从标准 Motions 结构推导
            motions = file_refs.get('Motions', {}) or {}
            for group_name, items in motions.items():
                files = []
                for item in items or []:
                    try:
                        file_path = item.get('File') if isinstance(item, dict) else None
                        if file_path:
                            files.append(file_path.replace('\\', '/'))
                    except Exception:
                        continue
                derived_mapping["motions"][group_name] = files

            # 从标准 Expressions 结构推导（按 Name 的前缀进行分组，如 happy_xxx）
            expressions = file_refs.get('Expressions', []) or []
            for item in expressions:
                if not isinstance(item, dict):
                    continue
                name = item.get('Name') or ''
                file_path = item.get('File') or ''
                if not file_path:
                    continue
                file_path = file_path.replace('\\', '/')
                # 根据第一个下划线拆分分组
                if '_' in name:
                    group = name.split('_', 1)[0]
                else:
                    # 无前缀的归入 neutral 组，避免丢失
                    group = 'neutral'
                derived_mapping["expressions"].setdefault(group, []).append(file_path)

            emotion_mapping = derived_mapping
        
        return {"success": True, "config": emotion_mapping}
    except Exception as e:
        logger.error(f"获取情绪映射配置失败: {e}")
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})

@app.post('/api/live2d/emotion_mapping/{model_name}')
async def update_emotion_mapping(model_name: str, request: Request):
    """更新情绪映射配置"""
    try:
        data = await request.json()
        
        if not data:
            return JSONResponse(status_code=400, content={"success": False, "error": "无效的数据"})

        # 在模型目录中查找.model3.json文件
        model_dir = os.path.join('static', model_name)
        if not os.path.exists(model_dir):
            return JSONResponse(status_code=404, content={"success": False, "error": "模型目录不存在"})
        
        # 查找.model3.json文件
        model_json_path = None
        for file in os.listdir(model_dir):
            if file.endswith('.model3.json'):
                model_json_path = os.path.join(model_dir, file)
                break
        
        if not model_json_path or not os.path.exists(model_json_path):
            return JSONResponse(status_code=404, content={"success": False, "error": "模型配置文件不存在"})

        with open(model_json_path, 'r', encoding='utf-8') as f:
            config_data = json.load(f)

        # 统一写入到标准 Cubism 结构（FileReferences.Motions / FileReferences.Expressions）
        file_refs = config_data.setdefault('FileReferences', {})

        # 处理 motions: data 结构为 { motions: { emotion: ["motions/xxx.motion3.json", ...] }, expressions: {...} }
        motions_input = (data.get('motions') if isinstance(data, dict) else None) or {}
        motions_output = {}
        for group_name, files in motions_input.items():
            # 禁止在“常驻”组配置任何motion
            if group_name == '常驻':
                logger.info("忽略常驻组中的motion配置（只允许expression）")
                continue
            items = []
            for file_path in files or []:
                if not isinstance(file_path, str):
                    continue
                normalized = file_path.replace('\\', '/').lstrip('./')
                items.append({"File": normalized})
            motions_output[group_name] = items
        file_refs['Motions'] = motions_output

        # 处理 expressions: 将按 emotion 前缀生成扁平列表，Name 采用 "{emotion}_{basename}" 的约定
        expressions_input = (data.get('expressions') if isinstance(data, dict) else None) or {}

        # 先保留不属于我们情感前缀的原始表达（避免覆盖用户自定义）
        existing_expressions = file_refs.get('Expressions', []) or []
        emotion_prefixes = set(expressions_input.keys())
        preserved_expressions = []
        for item in existing_expressions:
            try:
                name = (item.get('Name') or '') if isinstance(item, dict) else ''
                prefix = name.split('_', 1)[0] if '_' in name else None
                if not prefix or prefix not in emotion_prefixes:
                    preserved_expressions.append(item)
            except Exception:
                preserved_expressions.append(item)

        new_expressions = []
        for emotion, files in expressions_input.items():
            for file_path in files or []:
                if not isinstance(file_path, str):
                    continue
                normalized = file_path.replace('\\', '/').lstrip('./')
                base = os.path.basename(normalized)
                base_no_ext = base.replace('.exp3.json', '')
                name = f"{emotion}_{base_no_ext}"
                new_expressions.append({"Name": name, "File": normalized})

        file_refs['Expressions'] = preserved_expressions + new_expressions

        # 同时保留一份 EmotionMapping（供管理器读取与向后兼容）
        config_data['EmotionMapping'] = data

        # 保存配置到文件
        with open(model_json_path, 'w', encoding='utf-8') as f:
            json.dump(config_data, f, ensure_ascii=False, indent=2)
        
        logger.info(f"模型 {model_name} 的情绪映射配置已更新（已同步到 FileReferences）")
        return {"success": True, "message": "情绪映射配置已保存"}
    except Exception as e:
        logger.error(f"更新情绪映射配置失败: {e}")
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})

@app.post('/api/memory/recent_file/save')
async def save_recent_file(request: Request):
    import os, json
    data = await request.json()
    filename = data.get('filename')
    chat = data.get('chat')
    base_store_dir = os.path.join(os.path.dirname(__file__), 'memory', 'store')
    try:
        os.makedirs(base_store_dir, exist_ok=True)
    except Exception:
        pass
    file_path = os.path.join(base_store_dir, filename)
    if not (filename and filename.startswith('recent') and filename.endswith('.json')):
        return JSONResponse({"success": False, "error": "文件名不合法"}, status_code=400)
    arr = []
    for msg in chat:
        t = msg.get('role')
        text = msg.get('text', '')
        arr.append({
            "type": t,
            "data": {
                "content": text,
                "additional_kwargs": {},
                "response_metadata": {},
                "type": t,
                "name": None,
                "id": None,
                "example": False,
                **({"tool_calls": [], "invalid_tool_calls": [], "usage_metadata": None} if t == "ai" else {})
            }
        })
    try:
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(arr, f, ensure_ascii=False, indent=2)
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.post('/api/emotion/analysis')
async def emotion_analysis(request: Request):
    try:
        data = await request.json()
        if not data or 'text' not in data:
            return {"error": "请求体中必须包含text字段"}
        
        text = data['text']
        api_key = data.get('api_key')
        model = data.get('model')
        
        # 使用参数或默认配置
        api_key = api_key or OPENROUTER_API_KEY
        model = model or EMOTION_MODEL
        
        if not api_key:
            return {"error": "API密钥未提供且配置中未设置默认密钥"}
        
        if not model:
            return {"error": "模型名称未提供且配置中未设置默认模型"}
        
        # 创建异步客户端
        client = AsyncOpenAI(api_key=api_key, base_url=OPENROUTER_URL)
        
        # 构建请求消息
        messages = [
            {
                "role": "system", 
                "content": emotion_analysis_prompt
            },
            {
                "role": "user", 
                "content": text
            }
        ]
        
        # 异步调用模型
        response = await client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=0.3,
            max_tokens=100,
            extra_body={"enable_thinking": False}
        )
        
        # 解析响应
        result_text = response.choices[0].message.content.strip()
        
        # 尝试解析JSON响应
        try:
            import json
            result = json.loads(result_text)
            # 获取emotion和confidence
            emotion = result.get("emotion", "neutral")
            confidence = result.get("confidence", 0.5)
            
            # 当confidence小于0.3时，自动将emotion设置为neutral
            if confidence < 0.3:
                emotion = "neutral"
            
            return {
                "emotion": emotion,
                "confidence": confidence
            }
        except json.JSONDecodeError:
            # 如果JSON解析失败，返回简单的情感判断
            return {
                "emotion": "neutral",
                "confidence": 0.5
            }
            
    except Exception as e:
        logger.error(f"情感分析失败: {e}")
        return {
            "error": f"情感分析失败: {str(e)}",
            "emotion": "neutral",
            "confidence": 0.0
        }

@app.get('/memory_browser', response_class=HTMLResponse)
async def memory_browser(request: Request):
    return templates.TemplateResponse('templates/memory_browser.html', {"request": request})

@app.get("/focus/{ee_name}", response_class=HTMLResponse)
async def get_focus_index(request: Request, ee_name: str):
    # 对非法角色名进行回退，确保页面不会误用未配置的名称
    resolved = ee_name if ee_name in session_manager else her_name
    # 每次动态获取角色数据
    _, _, _, lanlan_basic_config, _, _, _, _, _, _ = get_character_data()
    # 获取live2d/vrm字段
    live2d = lanlan_basic_config.get(resolved, {}).get('live2d', 'mao_pro')
    vrm_model = lanlan_basic_config.get(resolved, {}).get('vrm_model', 'EE.vrm')
    # 查找所有模型
    models = find_models()
    # 根据live2d字段查找对应的model path
    model_path = next((m["path"] for m in models if m["name"] == live2d), find_model_config_file(live2d))
    # 规范化 VRM 路径
    vrm_model_path = normalize_vrm_path(vrm_model)
    return templates.TemplateResponse("templates/index.html", {
        "request": request,
        "ee_name": resolved,
        "model_path": model_path,
        "vrm_model_path": vrm_model_path,
        "focus_mode": True
    })

@app.get("/{ee_name}", response_class=HTMLResponse)
async def get_index(request: Request, ee_name: str):
    # 对非法角色名进行回退，确保页面不会误用未配置的名称
    resolved = ee_name if ee_name in session_manager else her_name
    # 每次动态获取角色数据
    _, _, _, lanlan_basic_config, _, _, _, _, _, _ = get_character_data()
    # 获取live2d/vrm字段
    live2d = lanlan_basic_config.get(resolved, {}).get('live2d', 'mao_pro')
    vrm_model = lanlan_basic_config.get(resolved, {}).get('vrm_model', 'EE.vrm')
    # 查找所有模型
    models = find_models()
    # 根据live2d字段查找对应的model path
    model_path = next((m["path"] for m in models if m["name"] == live2d), find_model_config_file(live2d))
    # 规范化 VRM 路径
    vrm_model_path = normalize_vrm_path(vrm_model)
    return templates.TemplateResponse("templates/index.html", {
        "request": request,
        "ee_name": resolved,
        "model_path": model_path,
        "vrm_model_path": vrm_model_path,
        "focus_mode": False
    })

@app.post('/api/agent/flags')
async def update_agent_flags(request: Request):
    """来自前端的Agent开关更新，级联到各自的session manager。"""
    try:
        data = await request.json()
        # 支持 ee_name 新命名，兼容旧字段
        lanlan = (data.get('ee_name') or data.get('lanlan_name') or her_name)
        flags = data.get('flags') or {}
        mgr = session_manager.get(lanlan)
        if not mgr:
            return JSONResponse({"success": False, "error": "EE not found"}, status_code=404)
        # Update core flags first
        mgr.update_agent_flags(flags)
        # Forward to tool server for MCP/Computer-Use flags
        try:
            forward_payload = {}
            if 'mcp_enabled' in flags:
                forward_payload['mcp_enabled'] = bool(flags['mcp_enabled'])
            if 'computer_use_enabled' in flags:
                forward_payload['computer_use_enabled'] = bool(flags['computer_use_enabled'])
            if forward_payload:
                async with httpx.AsyncClient(timeout=0.7) as client:
                    r = await client.post(f"http://localhost:{TOOL_SERVER_PORT}/agent/flags", json=forward_payload)
                    if not r.is_success:
                        raise Exception(f"tool_server responded {r.status_code}")
        except Exception as e:
            # On failure, reset flags in core to safe state
            mgr.update_agent_flags({'agent_enabled': False, 'computer_use_enabled': False, 'mcp_enabled': False})
            return JSONResponse({"success": False, "error": f"tool_server forward failed: {e}"}, status_code=502)
        return {"success": True}
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


@app.get('/api/agent/health')
async def agent_health():
    """Check tool_server health via main_server proxy."""
    try:
        async with httpx.AsyncClient(timeout=0.7) as client:
            r = await client.get(f"http://localhost:{TOOL_SERVER_PORT}/health")
            if not r.is_success:
                return JSONResponse({"status": "down"}, status_code=502)
            data = {}
            try:
                data = r.json()
            except Exception:
                pass
            return {"status": "ok", **({"tool": data} if isinstance(data, dict) else {})}
    except Exception:
        return JSONResponse({"status": "down"}, status_code=502)


@app.get('/api/agent/computer_use/availability')
async def proxy_cu_availability():
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            r = await client.get(f"http://localhost:{TOOL_SERVER_PORT}/computer_use/availability")
            if not r.is_success:
                return JSONResponse({"ready": False, "reasons": [f"tool_server responded {r.status_code}"]}, status_code=502)
            return r.json()
    except Exception as e:
        return JSONResponse({"ready": False, "reasons": [f"proxy error: {e}"]}, status_code=502)


@app.get('/api/agent/mcp/availability')
async def proxy_mcp_availability():
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            r = await client.get(f"http://localhost:{TOOL_SERVER_PORT}/mcp/availability")
            if not r.is_success:
                return JSONResponse({"ready": False, "reasons": [f"tool_server responded {r.status_code}"]}, status_code=502)
            return r.json()
    except Exception as e:
        return JSONResponse({"ready": False, "reasons": [f"proxy error: {e}"]}, status_code=502)


@app.get('/api/agent/tasks')
async def proxy_tasks():
    """Get all tasks from tool server via main_server proxy."""
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            r = await client.get(f"http://localhost:{TOOL_SERVER_PORT}/tasks")
            if not r.is_success:
                return JSONResponse({"tasks": [], "error": f"tool_server responded {r.status_code}"}, status_code=502)
            return r.json()
    except Exception as e:
        return JSONResponse({"tasks": [], "error": f"proxy error: {e}"}, status_code=502)


@app.get('/api/agent/tasks/{task_id}')
async def proxy_task_detail(task_id: str):
    """Get specific task details from tool server via main_server proxy."""
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            r = await client.get(f"http://localhost:{TOOL_SERVER_PORT}/tasks/{task_id}")
            if not r.is_success:
                return JSONResponse({"error": f"tool_server responded {r.status_code}"}, status_code=502)
            return r.json()
    except Exception as e:
        return JSONResponse({"error": f"proxy error: {e}"}, status_code=502)


# Task status polling endpoint for frontend
@app.get('/api/agent/task_status')
async def get_task_status():
    """Get current task status for frontend polling - returns all tasks with their current status."""
    try:
        # Get tasks from tool server using async client
        async with httpx.AsyncClient(timeout=1.5) as client:
            r = await client.get(f"http://localhost:{TOOL_SERVER_PORT}/tasks")
            if not r.is_success:
                return JSONResponse({"tasks": [], "error": f"tool_server responded {r.status_code}"}, status_code=502)
            
            tasks_data = r.json()
            tasks = tasks_data.get("tasks", [])
            debug_info = tasks_data.get("debug", {})
            
            # Log debug information
            logger.info(f"Agent server debug info: {debug_info}")
            logger.info(f"Raw tasks from agent server: {len(tasks)} tasks")
            
            # Enhance task data with additional information if needed
            enhanced_tasks = []
            for task in tasks:
                enhanced_task = {
                    "id": task.get("id"),
                    "status": task.get("status", "unknown"),
                    "type": task.get("type", "unknown"),
                    "ee_name": task.get("ee_name") or task.get("lanlan_name"),
                    "lanlan_name": task.get("lanlan_name"),
                    "start_time": task.get("start_time"),
                    "end_time": task.get("end_time"),
                    "params": task.get("params", {}),
                    "result": task.get("result"),
                    "error": task.get("error"),
                    "source": task.get("source", "unknown")  # 添加来源信息
                }
                enhanced_tasks.append(enhanced_task)
            
            return {
                "success": True,
                "tasks": enhanced_tasks,
                "total_count": len(enhanced_tasks),
                "running_count": len([t for t in enhanced_tasks if t.get("status") == "running"]),
                "queued_count": len([t for t in enhanced_tasks if t.get("status") == "queued"]),
                "completed_count": len([t for t in enhanced_tasks if t.get("status") == "completed"]),
                "failed_count": len([t for t in enhanced_tasks if t.get("status") == "failed"]),
                "timestamp": datetime.now().isoformat(),
                "debug": debug_info  # 传递调试信息到前端
            }
        
    except Exception as e:
        return JSONResponse({
            "success": False,
            "tasks": [],
            "error": f"Failed to fetch task status: {str(e)}",
            "timestamp": datetime.now().isoformat()
        }, status_code=500)


@app.post('/api/agent/admin/control')
async def proxy_admin_control(payload):
    """Proxy admin control commands to tool server."""
    try:
        import httpx
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(f"http://localhost:{TOOL_SERVER_PORT}/admin/control", json=payload)
            if not r.is_success:
                return JSONResponse({"success": False, "error": f"tool_server responded {r.status_code}"}, status_code=502)
            
            result = r.json()
            logger.info(f"Admin control result: {result}")
            return result
        
    except Exception as e:
        return JSONResponse({
            "success": False,
            "error": f"Failed to execute admin control: {str(e)}"
        }, status_code=500)


# --- Run the Server ---
if __name__ == "__main__":
    import uvicorn
    import argparse
    import os
    import signal
    
    parser = argparse.ArgumentParser()
    parser.add_argument("--open-browser",   action="store_true",
                        help="启动后是否打开浏览器并监控它")
    parser.add_argument("--page",           type=str, default="",
                        choices=["index", "chara_manager", "api_key", ""],
                        help="要打开的页面路由（不含域名和端口）")
    args = parser.parse_args()

    logger.info("--- Starting FastAPI Server ---")
    # Use os.path.abspath to show full path clearly
    logger.info(f"Serving static files from: {os.path.abspath('static')}")
    logger.info(f"Serving index.html from: {os.path.abspath('templates/index.html')}")
    logger.info(f"Access UI at: http://127.0.0.1:{MAIN_SERVER_PORT} (or your network IP:{MAIN_SERVER_PORT})")
    logger.info("-----------------------------")

    # 1) 配置 UVicorn
    config = uvicorn.Config(
        app=app,
        host="0.0.0.0",
        port=MAIN_SERVER_PORT,
        log_level="info",
        loop="asyncio",
        reload=False,
    )
    server = uvicorn.Server(config)
    
    # Set browser mode flag if --open-browser is used
    if args.open_browser:
        # 使用 FastAPI 的 app.state 来管理配置
        start_config = {
            "browser_mode_enabled": True,
            "browser_page": args.page if args.page!='index' else '',
            'server': server,
            # 默认不允许通过 Beacon 触发自动关机，避免页面关闭导致服务退出
            'allow_beacon_shutdown': False,
        }
        set_start_config(start_config)
    else:
        # 设置默认配置
        start_config = {
            "browser_mode_enabled": False,
            "browser_page": "",
            'server': server,
            'allow_beacon_shutdown': False,
        }
        set_start_config(start_config)

    print(f"启动配置: {get_start_config()}")

    # 2) 定义服务器关闭回调
    def shutdown_server():
        logger.info("收到浏览器关闭信号，正在关闭服务器...")
        os.kill(os.getpid(), signal.SIGTERM)

    # 4) 启动服务器（阻塞，直到 server.should_exit=True）
    logger.info("--- Starting FastAPI Server ---")
    logger.info(f"Access UI at: http://127.0.0.1:{MAIN_SERVER_PORT}/{args.page}")
    
    try:
        server.run()
    finally:
        logger.info("服务器已关闭")
