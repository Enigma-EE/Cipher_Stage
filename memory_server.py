# -*- coding: utf-8 -*-
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from memory import CompressedRecentHistoryManager, SemanticMemory, ImportantSettingsManager, TimeIndexedMemory
from fastapi import FastAPI, BackgroundTasks
import json
import uvicorn
from langchain_core.messages import convert_to_messages, messages_to_dict, HumanMessage, AIMessage, SystemMessage
from uuid import uuid4
from config import get_character_data, MEMORY_SERVER_PORT
from pydantic import BaseModel
import re
import asyncio
import logging
import argparse
from datetime import datetime
import glob
import gzip

# Setup logger
logger = logging.getLogger(__name__)

class HistoryRequest(BaseModel):
    input_history: str

class CompactConfig(BaseModel):
    archive_compact_enabled: bool | None = None
    archive_compact_lines_threshold: int | None = None
    archive_compact_size_mb_threshold: int | None = None
    archive_compact_interval_sec: int | None = None
    archive_compact_delete_shards: bool | None = None
    archive_compact_window_start_hour: int | None = None
    archive_compact_window_end_hour: int | None = None

app = FastAPI()

# 初始化组件
recent_history_manager = CompressedRecentHistoryManager()
semantic_manager = SemanticMemory(recent_history_manager)
settings_manager = ImportantSettingsManager()
time_manager = TimeIndexedMemory(recent_history_manager)

# 全局变量用于控制服务器关闭
shutdown_event = asyncio.Event()
# 全局变量控制是否响应退出请求
enable_shutdown = False
batch_queue: asyncio.Queue | None = None
consumer_task: asyncio.Task | None = None
BATCH_MAX = 8
BATCH_TIMEOUT_SEC = 0.5
compact_task: asyncio.Task | None = None
COMPACT_ENABLED = True
COMPACT_LINES = 2000
COMPACT_SIZE_MB = 64
COMPACT_INTERVAL_SEC = 180
COMPACT_DELETE_SHARDS = True
COMPACT_WINDOW_START_HOUR = 2
COMPACT_WINDOW_END_HOUR = 5

def _ensure_dir(p):
    os.makedirs(p, exist_ok=True)

def _append_ndjson_gz(file_path: str, obj):
    _ensure_dir(os.path.dirname(file_path))
    with gzip.open(file_path, 'at', encoding='utf-8') as gf:
        gf.write(json.dumps(obj, ensure_ascii=False))
        gf.write("\n")

def _daily_append_path(ee_name: str, date: str):
    base_dir = os.path.join(os.path.dirname(__file__), 'memory', 'store', 'archive', ee_name, 'day')
    _ensure_dir(base_dir)
    return os.path.join(base_dir, f"append_{ee_name}_{date}.ndjson.gz")

@app.post("/shutdown")
async def shutdown_memory_server():
    """接收来自main_server的关闭信号"""
    global enable_shutdown
    if not enable_shutdown:
        logger.warning("收到关闭信号，但当前模式不允许响应退出请求")
        return {"status": "shutdown_disabled", "message": "当前模式不允许响应退出请求"}
    
    try:
        logger.info("收到来自main_server的关闭信号")
        shutdown_event.set()
        return {"status": "shutdown_signal_received"}
    except Exception as e:
        logger.error(f"处理关闭信号时出错: {e}")
        return {"status": "error", "message": str(e)}

@app.on_event("shutdown")
async def shutdown_event_handler():
    """应用关闭时执行清理工作"""
    logger.info("Memory server正在关闭...")
    # 这里可以添加任何需要的清理工作
    logger.info("Memory server已关闭")


@app.post("/process/{ee_name}")
def process_conversation(request: HistoryRequest, ee_name: str, background_tasks: BackgroundTasks):
    try:
        uid = str(uuid4())
        def _safe_convert(raw_list):
            try:
                return convert_to_messages(raw_list)
            except Exception:
                messages = []
                for item in raw_list:
                    role = item.get('role') or item.get('type')
                    content = item.get('content')
                    if isinstance(content, list):
                        try:
                            texts = [c.get('text', '') for c in content if isinstance(c, dict)]
                            text = "\n".join([t for t in texts if t])
                        except Exception:
                            text = str(content)
                    elif isinstance(content, str):
                        text = content
                    else:
                        text = ''
                    if role in ['user', 'human']:
                        messages.append(HumanMessage(content=text))
                    elif role in ['assistant', 'ai']:
                        messages.append(AIMessage(content=text))
                    elif role in ['system']:
                        messages.append(SystemMessage(content=text))
                    else:
                        messages.append(SystemMessage(content=text))
                return messages
        input_raw = json.loads(request.input_history)
        input_history = _safe_convert(input_raw)
        if batch_queue is not None:
            batch_queue.put_nowait({"type": "process", "uid": uid, "ee_name": ee_name, "messages": input_history})
        return {"status": "accepted"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/archive/merge_by_day/{ee_name}")
def merge_archive_by_day(ee_name: str, date: str, compress: bool = True):
    """
    合并某角色在指定日期(YYYYMMDD)的所有会话归档文件为单个文件。
    - 输入：ee_name 角色名，date 形如 '20251115'，compress 是否生成 .gz 压缩文件
    - 输出文件：memory/store/archive/<ee_name>/day/merged_<ee_name>_<date>.json(.gz)
    """
    try:
        base_dir = os.path.join(os.path.dirname(__file__), 'memory', 'store', 'archive', ee_name)
        day_dir = os.path.join(base_dir, 'day')
        os.makedirs(day_dir, exist_ok=True)
        pattern_json = os.path.join(base_dir, f"session_{date}_*.json")
        pattern_gz = os.path.join(base_dir, f"session_{date}_*.json.gz")
        files = sorted(glob.glob(pattern_json) + glob.glob(pattern_gz))
        if not files:
            return {"success": False, "error": f"未找到指定日期 {date} 的会话归档"}

        merged_messages = []
        merged_count = 0
        for fp in files:
            try:
                if fp.endswith('.gz'):
                    with gzip.open(fp, 'rt', encoding='utf-8') as f:
                        msgs = json.load(f)
                else:
                    with open(fp, 'r', encoding='utf-8') as f:
                        msgs = json.load(f)
                # 会话分隔标记（系统消息），便于后续检索
                merged_messages.append({
                    "type": "system",
                    "data": {
                        "content": f"会话分割: {os.path.basename(fp)}",
                        "additional_kwargs": {},
                        "response_metadata": {},
                        "type": "system",
                        "name": None,
                        "id": None,
                        "example": False
                    }
                })
                # 拼接当前会话的消息列表
                if isinstance(msgs, list):
                    merged_messages.extend(msgs)
                merged_count += 1
            except Exception as e:
                logging.warning(f"合并文件失败 {fp}: {e}")

        try:
            append_fp = _daily_append_path(ee_name, date)
            if os.path.exists(append_fp):
                with gzip.open(append_fp, 'rt', encoding='utf-8') as gf:
                    for line in gf:
                        try:
                            rec = json.loads(line.strip())
                            merged_messages.append({
                                "type": "system",
                                "data": {
                                    "content": f"会话分割: append_line_{rec.get('uid','')}",
                                    "additional_kwargs": {},
                                    "response_metadata": {},
                                    "type": "system",
                                    "name": None,
                                    "id": None,
                                    "example": False
                                }
                            })
                            if isinstance(rec.get("messages"), list):
                                merged_messages.extend(rec["messages"])
                            merged_count += 1
                        except Exception:
                            pass
        except Exception:
            pass

        out_base = os.path.join(day_dir, f"merged_{ee_name}_{date}.json")
        if compress:
            out_path = out_base + ".gz"
            with gzip.open(out_path, 'wt', encoding='utf-8') as gf:
                json.dump(merged_messages, gf, ensure_ascii=False)
        else:
            out_path = out_base
            with open(out_path, 'w', encoding='utf-8') as f:
                json.dump(merged_messages, f, ensure_ascii=False, indent=2)

        logger.info(f"已生成合并归档: {out_path}，合并会话数: {merged_count}，消息总数: {len(merged_messages)}")
        return {"success": True, "output": out_path, "sessions": merged_count, "messages": len(merged_messages)}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@app.post("/renew/{ee_name}")
def process_conversation_for_renew(request: HistoryRequest, ee_name: str, background_tasks: BackgroundTasks):
    try:
        uid = str(uuid4())
        def _safe_convert(raw_list):
            try:
                return convert_to_messages(raw_list)
            except Exception:
                messages = []
                for item in raw_list:
                    role = item.get('role') or item.get('type')
                    content = item.get('content')
                    if isinstance(content, list):
                        try:
                            texts = [c.get('text', '') for c in content if isinstance(c, dict)]
                            text = "\n".join([t for t in texts if t])
                        except Exception:
                            text = str(content)
                    elif isinstance(content, str):
                        text = content
                    else:
                        text = ''
                    if role in ['user', 'human']:
                        messages.append(HumanMessage(content=text))
                    elif role in ['assistant', 'ai']:
                        messages.append(AIMessage(content=text))
                    elif role in ['system']:
                        messages.append(SystemMessage(content=text))
                    else:
                        messages.append(SystemMessage(content=text))
                return messages
        input_raw = json.loads(request.input_history)
        input_history = _safe_convert(input_raw)
        if batch_queue is not None:
            batch_queue.put_nowait({"type": "renew", "uid": uid, "ee_name": ee_name, "messages": input_history})
        return {"status": "accepted"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/get_recent_history/{ee_name}")
def get_recent_history(ee_name: str):
    history = recent_history_manager.get_recent_history(ee_name)
    _, _, _, _, name_mapping, _, _, _, _, _ = get_character_data()
    name_mapping['ai'] = ee_name
    result = f"开始聊天前，{ee_name}又在脑海内整理了近期发生的事情。\n"
    for i in history:
        if i.type == 'system':
            result += i.content + "\n"
        else:
            texts = [j['text'] for j in i.content if j['type']=='text']
            joined = "\n".join(texts)
            result += f"{name_mapping[i.type]} | {joined}\n"
    return result

@app.get("/search_for_memory/{ee_name}/{query}")
def get_memory(query: str, ee_name:str):
    try:
        return semantic_manager.query(query, ee_name)
    except Exception as e:
        return f"semantic_error: {e}"

@app.get("/get_settings/{ee_name}")
def get_settings(ee_name: str):
    result = f"{ee_name}记得{json.dumps(settings_manager.get_settings(ee_name), ensure_ascii=False)}"
    return result

@app.get("/new_dialog/{ee_name}")
def new_dialog(ee_name: str):
    # 去除形如 $$...$$ 的高亮/标记内容
    m1 = re.compile(r'\$\$.*?\$\$', flags=re.DOTALL)
    master_name, _, _, _, name_mapping, _, _, _, _, _ = get_character_data()
    name_mapping['ai'] = ee_name
    result = f"\n========{ee_name}的内心活动========\n{ee_name}的脑海里经常想着自己和{master_name}的事情，她记得{json.dumps(settings_manager.get_settings(ee_name), ensure_ascii=False)}\n\n"
    result += f"开始聊天前，{ee_name}又在脑海内整理了近期发生的事情。\n"
    for i in recent_history_manager.get_recent_history(ee_name):
        if isinstance(i.content, str):
            clean_text = m1.sub('', i.content)
            result += f"{name_mapping[i.type]} | {clean_text}\n"
        else:
            try:
                texts = [m1.sub('', j.get('text', '')) for j in i.content if isinstance(j, dict) and j.get('type') == 'text']
            except Exception:
                texts = []
            result += f"{name_mapping[i.type]} | " + "\n".join([t for t in texts if t]) + "\n"
    return result

@app.get('/compact_config')
def get_compact_config():
    return {
        'archive_compact_enabled': COMPACT_ENABLED,
        'archive_compact_lines_threshold': COMPACT_LINES,
        'archive_compact_size_mb_threshold': COMPACT_SIZE_MB,
        'archive_compact_interval_sec': COMPACT_INTERVAL_SEC,
        'archive_compact_delete_shards': COMPACT_DELETE_SHARDS,
        'archive_compact_window_start_hour': COMPACT_WINDOW_START_HOUR,
        'archive_compact_window_end_hour': COMPACT_WINDOW_END_HOUR,
    }

@app.post('/compact_config')
def set_compact_config(cfg: CompactConfig):
    global COMPACT_ENABLED, COMPACT_LINES, COMPACT_SIZE_MB, COMPACT_INTERVAL_SEC, COMPACT_DELETE_SHARDS, COMPACT_WINDOW_START_HOUR, COMPACT_WINDOW_END_HOUR
    try:
        if cfg.archive_compact_enabled is not None:
            COMPACT_ENABLED = bool(cfg.archive_compact_enabled)
        if cfg.archive_compact_lines_threshold is not None and cfg.archive_compact_lines_threshold > 0:
            COMPACT_LINES = int(cfg.archive_compact_lines_threshold)
        if cfg.archive_compact_size_mb_threshold is not None and cfg.archive_compact_size_mb_threshold > 0:
            COMPACT_SIZE_MB = int(cfg.archive_compact_size_mb_threshold)
        if cfg.archive_compact_interval_sec is not None and cfg.archive_compact_interval_sec > 1:
            COMPACT_INTERVAL_SEC = int(cfg.archive_compact_interval_sec)
        if cfg.archive_compact_delete_shards is not None:
            COMPACT_DELETE_SHARDS = bool(cfg.archive_compact_delete_shards)
        if cfg.archive_compact_window_start_hour is not None:
            COMPACT_WINDOW_START_HOUR = int(cfg.archive_compact_window_start_hour)
        if cfg.archive_compact_window_end_hour is not None:
            COMPACT_WINDOW_END_HOUR = int(cfg.archive_compact_window_end_hour)

        cfg_path = os.path.join(os.path.dirname(__file__), 'config', 'core_config.json')
        data = {}
        try:
            if os.path.exists(cfg_path):
                with open(cfg_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
        except Exception:
            data = {}
        data['archive_compact_enabled'] = COMPACT_ENABLED
        data['archive_compact_lines_threshold'] = COMPACT_LINES
        data['archive_compact_size_mb_threshold'] = COMPACT_SIZE_MB
        data['archive_compact_interval_sec'] = COMPACT_INTERVAL_SEC
        data['archive_compact_delete_shards'] = COMPACT_DELETE_SHARDS
        data['archive_compact_window_start_hour'] = COMPACT_WINDOW_START_HOUR
        data['archive_compact_window_end_hour'] = COMPACT_WINDOW_END_HOUR
        try:
            with open(cfg_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
        return {'success': True}
    except Exception as e:
        return {'success': False, 'error': str(e)}

# __main__ 块移动至文件末尾，确保事件处理器在服务启动前完成注册

@app.on_event("startup")
async def on_startup():
    global batch_queue, consumer_task, compact_task
    global COMPACT_ENABLED, COMPACT_LINES, COMPACT_SIZE_MB, COMPACT_INTERVAL_SEC, COMPACT_DELETE_SHARDS, COMPACT_WINDOW_START_HOUR, COMPACT_WINDOW_END_HOUR
    batch_queue = asyncio.Queue(maxsize=1000)
    try:
        cfg_path = os.path.join(os.path.dirname(__file__), 'config', 'core_config.json')
        if os.path.exists(cfg_path):
            with open(cfg_path, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
            COMPACT_ENABLED = bool(cfg.get('archive_compact_enabled', COMPACT_ENABLED))
            COMPACT_LINES = int(cfg.get('archive_compact_lines_threshold', COMPACT_LINES))
            COMPACT_SIZE_MB = int(cfg.get('archive_compact_size_mb_threshold', COMPACT_SIZE_MB))
            COMPACT_INTERVAL_SEC = int(cfg.get('archive_compact_interval_sec', COMPACT_INTERVAL_SEC))
            COMPACT_DELETE_SHARDS = bool(cfg.get('archive_compact_delete_shards', COMPACT_DELETE_SHARDS))
            COMPACT_WINDOW_START_HOUR = int(cfg.get('archive_compact_window_start_hour', COMPACT_WINDOW_START_HOUR))
            COMPACT_WINDOW_END_HOUR = int(cfg.get('archive_compact_window_end_hour', COMPACT_WINDOW_END_HOUR))
    except Exception:
        pass
    async def _consume():
        loop = asyncio.get_running_loop()
        while True:
            item = await batch_queue.get()
            batch = [item]
            deadline = loop.time() + BATCH_TIMEOUT_SEC
            while len(batch) < BATCH_MAX:
                timeout = max(0.0, deadline - loop.time())
                if timeout == 0.0:
                    break
                try:
                    nxt = await asyncio.wait_for(batch_queue.get(), timeout=timeout)
                    batch.append(nxt)
                except asyncio.TimeoutError:
                    break
            for b in batch:
                uid = b.get("uid")
                ee = b.get("ee_name")
                msgs = b.get("messages")
                t = b.get("type")
                if t == "renew":
                    recent_history_manager.update_history(msgs, ee, detailed=True)
                    semantic_manager.store_conversation(uid, msgs, ee)
                    time_manager.store_conversation(uid, msgs, ee)
                else:
                    recent_history_manager.update_history(msgs, ee)
                    semantic_manager.store_conversation(uid, msgs, ee)
                    time_manager.store_conversation(uid, msgs, ee)
                    try:
                        base_dir = os.path.join(os.path.dirname(__file__), 'memory', 'store', 'archive', ee)
                        os.makedirs(base_dir, exist_ok=True)
                        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
                        archive_file = os.path.join(base_dir, f"session_{ts}_{uid}.json.gz")
                        with gzip.open(archive_file, 'wt', encoding='utf-8') as gf:
                            json.dump(messages_to_dict(msgs), gf, ensure_ascii=False)
                        day = datetime.now().strftime('%Y%m%d')
                        append_path = _daily_append_path(ee, day)
                        _append_ndjson_gz(append_path, {
                            "uid": uid,
                            "timestamp": datetime.now().isoformat(),
                            "messages": messages_to_dict(msgs)
                        })
                    except Exception:
                        pass
    consumer_task = asyncio.create_task(_consume())
    async def _auto_compact():
        def _append_path(ee: str, d: str):
            base_dir = os.path.join(os.path.dirname(__file__), 'memory', 'store', 'archive', ee, 'day')
            os.makedirs(base_dir, exist_ok=True)
            return os.path.join(base_dir, f"append_{ee}_{d}.ndjson.gz")
        def _count_lines(fp: str) -> int:
            n = 0
            try:
                with gzip.open(fp, 'rt', encoding='utf-8') as gf:
                    for _ in gf:
                        n += 1
            except Exception:
                return 0
            return n
        def _size_mb(fp: str) -> float:
            try:
                return os.path.getsize(fp) / 1_000_000.0
            except Exception:
                return 0.0
        def _within_window() -> bool:
            h = datetime.now().hour
            if COMPACT_WINDOW_START_HOUR <= COMPACT_WINDOW_END_HOUR:
                return COMPACT_WINDOW_START_HOUR <= h < COMPACT_WINDOW_END_HOUR
            return h >= COMPACT_WINDOW_START_HOUR or h < COMPACT_WINDOW_END_HOUR
        while True:
            try:
                if COMPACT_ENABLED and _within_window():
                    archive_root = os.path.join(os.path.dirname(__file__), 'memory', 'store', 'archive')
                    try:
                        for ee in os.listdir(archive_root):
                            ee_dir = os.path.join(archive_root, ee)
                            if not os.path.isdir(ee_dir):
                                continue
                            for d in [datetime.now().strftime('%Y%m%d')]:
                                ap = _append_path(ee, d)
                                if not os.path.exists(ap):
                                    continue
                                ln = _count_lines(ap)
                                sz = _size_mb(ap)
                                if ln >= COMPACT_LINES or sz >= COMPACT_SIZE_MB:
                                    res = merge_archive_by_day(ee, d, compress=True)
                                    if isinstance(res, dict) and res.get('success') and COMPACT_DELETE_SHARDS:
                                        base_dir = os.path.join(archive_root, ee)
                                        for fp in glob.glob(os.path.join(base_dir, f"session_{d}_*.json")):
                                            try:
                                                os.remove(fp)
                                            except Exception:
                                                pass
                                        for fp in glob.glob(os.path.join(base_dir, f"session_{d}_*.json.gz")):
                                            try:
                                                os.remove(fp)
                                            except Exception:
                                                pass
                                        try:
                                            os.remove(ap)
                                        except Exception:
                                            pass
                    except Exception:
                        pass
                await asyncio.sleep(COMPACT_INTERVAL_SEC)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Archive compact error: {e}")
                await asyncio.sleep(COMPACT_INTERVAL_SEC)
    compact_task = asyncio.create_task(_auto_compact())

@app.on_event("shutdown")
async def on_shutdown():
    global consumer_task, compact_task
    try:
        if consumer_task and not consumer_task.done():
            consumer_task.cancel()
    except Exception:
        pass
    try:
        if compact_task and not compact_task.done():
            compact_task.cancel()
    except Exception:
        pass

if __name__ == "__main__":
    import threading
    import time
    import signal
    
    parser = argparse.ArgumentParser(description='Memory Server')
    parser.add_argument('--enable-shutdown', action='store_true', 
                       help='启用响应退出请求功能（仅在终端用户环境使用）')
    args = parser.parse_args()
    
    enable_shutdown = args.enable_shutdown
    
    def monitor_shutdown():
        while not shutdown_event.is_set():
            time.sleep(0.1)
        logger.info("检测到关闭信号，正在关闭memory_server...")
        os.kill(os.getpid(), signal.SIGTERM)
    
    if enable_shutdown:
        shutdown_monitor = threading.Thread(target=monitor_shutdown, daemon=True)
        shutdown_monitor.start()
    
    uvicorn.run(app, host="0.0.0.0", port=MEMORY_SERVER_PORT)
