# -*- coding: utf-8 -*-
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from memory import CompressedRecentHistoryManager, SemanticMemory, ImportantSettingsManager, TimeIndexedMemory
from fastapi import FastAPI
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
def process_conversation(request: HistoryRequest, ee_name: str):
    try:
        uid = str(uuid4())
        # 兼容 cross_server 发送的简单结构或 langchain 标准结构
        def _safe_convert(raw_list):
            try:
                return convert_to_messages(raw_list)
            except Exception:
                # 回退：将简单的 role/content 结构转换为 LangChain 消息
                messages = []
                for item in raw_list:
                    role = item.get('role') or item.get('type')
                    content = item.get('content')
                    # content 可能是 [{'type': 'text', 'text': '...'}]
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
                        # 未知角色，降级为系统消息
                        messages.append(SystemMessage(content=text))
                return messages

        input_raw = json.loads(request.input_history)
        input_history = _safe_convert(input_raw)
        recent_history_manager.update_history(input_history, ee_name)
        """
        下面屏蔽了两个模块，因为这两个模块需要消耗token，但当前版本实用性近乎于0。尤其是，Qwen与GPT等旗舰模型相比性能差距过大。
        """
        # settings_manager.extract_and_update_settings(input_history, ee_name)
        # semantic_manager.store_conversation(uid, input_history, ee_name)
        time_manager.store_conversation(uid, input_history, ee_name)
        recent_history_manager.review_history(ee_name)
        # 归档完整会话到文件：memory/store/archive/<ee_name>/session_<timestamp>_<uuid>.json
        try:
            base_dir = os.path.join(os.path.dirname(__file__), 'memory', 'store', 'archive', ee_name)
            os.makedirs(base_dir, exist_ok=True)
            ts = datetime.now().strftime('%Y%m%d_%H%M%S')
            archive_file = os.path.join(base_dir, f"session_{ts}_{uid}.json")
            with open(archive_file, 'w', encoding='utf-8') as f:
                json.dump(messages_to_dict(input_history), f, ensure_ascii=False, indent=2)
            logger.info(f"已归档会话到: {archive_file}")
        except Exception as e:
            logger.warning(f"归档会话写入失败: {e}")
        return {"status": "processed"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"status": "error", "message": str(e)}

@app.post("/archive/merge_by_day/{ee_name}")
def merge_archive_by_day(ee_name: str, date: str, compress: bool = False):
    """
    合并某角色在指定日期(YYYYMMDD)的所有会话归档文件为单个文件。
    - 输入：ee_name 角色名，date 形如 '20251115'，compress 是否生成 .gz 压缩文件
    - 输出文件：memory/store/archive/<ee_name>/day/merged_<ee_name>_<date>.json(.gz)
    """
    try:
        base_dir = os.path.join(os.path.dirname(__file__), 'memory', 'store', 'archive', ee_name)
        day_dir = os.path.join(base_dir, 'day')
        os.makedirs(day_dir, exist_ok=True)
        pattern = os.path.join(base_dir, f"session_{date}_*.json")
        files = sorted(glob.glob(pattern))
        if not files:
            return {"success": False, "error": f"未找到指定日期 {date} 的会话归档"}

        merged_messages = []
        merged_count = 0
        for fp in files:
            try:
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
def process_conversation_for_renew(request: HistoryRequest, ee_name: str):
    try:
        uid = str(uuid4())
        # 兼容 cross_server 发送的简单结构或 langchain 标准结构
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
        recent_history_manager.update_history(input_history, ee_name, detailed=True)
        # settings_manager.extract_and_update_settings(input_history, ee_name)
        # semantic_manager.store_conversation(uid, input_history, ee_name)
        time_manager.store_conversation(uid, input_history, ee_name)
        # recent_history_manager.review_history(ee_name)
        return {"status": "processed"}
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
    return semantic_manager.query(query, ee_name)

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

if __name__ == "__main__":
    import threading
    import time
    import signal
    
    # 解析命令行参数
    parser = argparse.ArgumentParser(description='Memory Server')
    parser.add_argument('--enable-shutdown', action='store_true', 
                       help='启用响应退出请求功能（仅在终端用户环境使用）')
    args = parser.parse_args()
    
    # 设置全局变量
    enable_shutdown = args.enable_shutdown
    
    # 创建一个后台线程来监控关闭信号
    def monitor_shutdown():
        while not shutdown_event.is_set():
            time.sleep(0.1)
        logger.info("检测到关闭信号，正在关闭memory_server...")
        # 发送SIGTERM信号给当前进程
        os.kill(os.getpid(), signal.SIGTERM)
    
    # 只有在启用关闭功能时才启动监控线程
    if enable_shutdown:
        shutdown_monitor = threading.Thread(target=monitor_shutdown, daemon=True)
        shutdown_monitor.start()
    
    # 启动服务器
    uvicorn.run(app, host="0.0.0.0", port=MEMORY_SERVER_PORT)