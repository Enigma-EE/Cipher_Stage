from config.api import *
from config.prompts_chara import *
import json
import os
import logging

# Setup logger for this module
logger = logging.getLogger(__name__)

# 读取角色配置
CHARACTER_JSON_PATH = os.path.join(os.path.dirname(__file__), 'characters.json')
# 默认值
_default_master = {"档案名": "NA", "性别": "NA", "昵称": "NA"}
_default_vtuber = {
    "EE": {
        "性别": "NA",
        "年龄": 333,
        "昵称": "EE",
        # 3D 默认字段，供新版本使用
        "vrm_model": "avatar.vrm",
        # 保留 live2d 作为兼容字段（旧版本可能读取）
        "live2d": "mao_pro",
        "voice_id": "",
        # 使用中性别名的默认角色系统提示
        "system_prompt": default_character_prompt,
    }
}


def load_characters(character_json_path=CHARACTER_JSON_PATH):
    try:
        with open(CHARACTER_JSON_PATH, 'r', encoding='utf-8') as f:
            character_data = json.load(f)
    except FileNotFoundError:
        logger.info(f"未找到角色配置文件: {CHARACTER_JSON_PATH}，请检查文件是否存在。使用默认人设。")
        character_data = {"主人": _default_master, "Vtuber": _default_vtuber}
    except Exception as e:
        logger.error(f"💥 读取角色配置文件出错: {e}，使用默认人设。")
        character_data = {"主人": _default_master, "Vtuber": _default_vtuber}
    return character_data

def save_characters(data, character_json_path=CHARACTER_JSON_PATH):
    with open(character_json_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def get_character_data():
    character_data = load_characters()
    # MASTER_NAME 必须始终存在，取档案名
    MASTER_NAME = character_data.get('主人', {}).get('档案名', _default_master['档案名'])

    # 支持使用 “Vtuber”  作为角色集合键
    char_key = 'Vtuber' if ('Vtuber' in character_data and isinstance(character_data['Vtuber'], dict)) else '猫娘'
    roles = character_data.get(char_key) or {}
    catgirl_names = list(roles.keys()) if roles and len(roles) > 0 else list(_default_vtuber.keys())

    # 支持 “当前角色” 作为当前角色字段
    current_field = '当前角色' if ('当前角色' in character_data) else '当前猫娘'
    current_catgirl = character_data.get(current_field, '')
    if current_catgirl and current_catgirl in catgirl_names:
        her_name = current_catgirl
    else:
        her_name = catgirl_names[0] if catgirl_names else ''
        # 如果没有设置当前角色，自动设置第一个为当前角色
        if her_name and not current_catgirl:
            character_data[current_field] = her_name
            save_characters(character_data)

    master_basic_config = character_data.get('主人', _default_master)
    lanlan_basic_config = roles if catgirl_names else _default_vtuber

    NAME_MAPPING = {'human': MASTER_NAME, 'system': "SYSTEM_MESSAGE"}
    # 生成以角色名为key的各类store
    LANLAN_PROMPT = {name: roles.get(name, {}).get('system_prompt', default_character_prompt) for name in catgirl_names}
    SEMANTIC_STORE = {name: f'memory/store/semantic_memory_{name}' for name in catgirl_names}
    TIME_STORE = {name: f'memory/store/time_indexed_{name}' for name in catgirl_names}
    SETTING_STORE = {name: f'memory/store/settings_{name}.json' for name in catgirl_names}
    RECENT_LOG = {name: f'memory/store/recent_{name}.json' for name in catgirl_names}

    return MASTER_NAME, her_name, master_basic_config, lanlan_basic_config, NAME_MAPPING, LANLAN_PROMPT, SEMANTIC_STORE, TIME_STORE, SETTING_STORE, RECENT_LOG

TIME_ORIGINAL_TABLE_NAME = "time_indexed_original"
TIME_COMPRESSED_TABLE_NAME = "time_indexed_compressed"

try:
    with open('./config/core_config.json', 'r', encoding='utf-8') as f:
        core_cfg = json.load(f)
    if 'coreApiKey' in core_cfg and core_cfg['coreApiKey'] and core_cfg['coreApiKey'] != CORE_API_KEY:
        logger.warning("coreApiKey in core_config.json is updated. Overwriting CORE_API_KEY.")
        CORE_API_KEY = core_cfg['coreApiKey']
    if 'coreApi' in core_cfg and core_cfg['coreApi']:
        logger.warning("coreApi: " + core_cfg['coreApi'])
        if core_cfg['coreApi'] == 'qwen':
            CORE_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
            CORE_MODEL = "qwen-omni-turbo-realtime-2025-05-08"
        elif core_cfg['coreApi'] == 'glm':
            CORE_URL = "wss://open.bigmodel.cn/api/paas/v4/realtime"
            CORE_MODEL = "glm-realtime-air" 
        elif core_cfg['coreApi'] == 'openai':
            CORE_URL = "wss://api.openai.com/v1/realtime"
            CORE_MODEL = "gpt-4o-realtime-preview"
        else:
            logger.error("💥 Unknown coreApi: " + core_cfg['coreApi'])
    else:
        CORE_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
        CORE_MODEL = "qwen-omni-turbo-realtime-2025-05-08"
    ASSIST_API_KEY_QWEN = core_cfg['assistApiKeyQwen'] if 'assistApiKeyQwen' in core_cfg and core_cfg['assistApiKeyQwen'] != '' else CORE_API_KEY
    ASSIST_API_KEY_OPENAI = core_cfg['assistApiKeyOpenai'] if 'assistApiKeyOpenai' in core_cfg and core_cfg['assistApiKeyOpenai'] != '' else CORE_API_KEY
    ASSIST_API_KEY_GLM = core_cfg['assistApiKeyGlm'] if 'assistApiKeyGlm' in core_cfg and core_cfg['assistApiKeyGlm'] != '' else CORE_API_KEY
    COMPUTER_USE_MODEL = 'glm-4.5v'
    COMPUTER_USE_GROUND_MODEL = 'glm-4.5v'
    COMPUTER_USE_MODEL_URL = COMPUTER_USE_GROUND_URL = 'https://open.bigmodel.cn/api/paas/v4'  # reuse
    COMPUTER_USE_MODEL_API_KEY = COMPUTER_USE_GROUND_API_KEY = ASSIST_API_KEY_GLM
    if 'assistApi' in core_cfg and core_cfg['assistApi']:
        logger.warning("assistApi: " + core_cfg['assistApi'])
        if core_cfg['assistApi'] == 'qwen':
            logger.warning("assistApi: " + core_cfg['assistApi'])
            OPENROUTER_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
            SUMMARY_MODEL = "qwen-plus-2025-07-14"
            CORRECTION_MODEL = "qwen3-235b-a22b-instruct-2507"
            EMOTION_MODEL = "qwen-turbo-2025-07-15"
            AUDIO_API_KEY = OPENROUTER_API_KEY = ASSIST_API_KEY_QWEN
        elif core_cfg['assistApi'] == 'openai':
            logger.warning("assistApi: " + core_cfg['assistApi'])
            OPENROUTER_URL = "https://api.openai.com/v1"
            SUMMARY_MODEL= "gpt-4.1"
            CORRECTION_MODEL = "o4-mini"
            EMOTION_MODEL = "gpt-4.1-nano"
            AUDIO_API_KEY = OPENROUTER_API_KEY = ASSIST_API_KEY_OPENAI
        elif core_cfg['assistApi'] == 'glm':
            OPENROUTER_URL = "https://open.bigmodel.cn/api/paas/v4"
            SUMMARY_MODEL = "glm-4.5-flash" # <-永久免费模型
            CORRECTION_MODEL = "glm-z1-air"  # glm-z1-flash <-永久免费模型
            EMOTION_MODEL = "glm-4.5-flash"
            AUDIO_API_KEY = OPENROUTER_API_KEY = ASSIST_API_KEY_GLM
        else:
            logger.error("💥 Unknown assistApi: " + core_cfg['assistApi']) 
    else:
        OPENROUTER_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
        SUMMARY_MODEL = "qwen-plus-2025-07-14"
        CORRECTION_MODEL = "qwen3-235b-a22b-instruct-2507"
        EMOTION_MODEL = "qwen-turbo-2025-07-15"
        AUDIO_API_KEY = OPENROUTER_API_KEY = ASSIST_API_KEY_QWEN

    # 音频合成相关配置（本地/云端）
    AUDIO_ENGINE = core_cfg.get('audioEngine', 'cloud')  # 'cloud' | 'local'
    AUDIO_LOCAL_PROVIDER = core_cfg.get('audioLocalProvider', 'pyttsx3')
    AUDIO_LOCAL_URL = core_cfg.get('audioLocalUrl', '')
    AUDIO_VOICE = core_cfg.get('audioVoice', '')

except FileNotFoundError:
    pass
except Exception as e:
    logger.error(f"Error parsing Core API Key: {e}")

if  AUDIO_API_KEY == '':
    AUDIO_API_KEY = CORE_API_KEY
if  OPENROUTER_API_KEY == '':
    OPENROUTER_API_KEY = CORE_API_KEY

if not CORE_API_KEY.startswith('sk'):
    logger.warning("⚠️ 请检查Core API Key是否正确，通常以'sk-'开头（智谱例外）。请在设置页面中重新设置。")
