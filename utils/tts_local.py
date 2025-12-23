import os
import io
import json
import tempfile
import pathlib
from typing import Optional, Tuple

import requests
import numpy as np
import wave


class TTSLocalError(Exception):
    pass


def synthesize(
    text: str,
    provider: str = "pyttsx3",
    voice: Optional[str] = None,
    language: str = "en",
    sample_rate: int = 24000,
    fmt: str = "wav",
    model_dir: Optional[str] = None,
    service_url: Optional[str] = None,
) -> Tuple[bytes, str]:
    """
    本地TTS合成入口。

    返回: (audio_bytes, mime_type)
    """
    if not text or not text.strip():
        raise TTSLocalError("文本不能为空")

    provider = (provider or "pyttsx3").lower()
    fmt = (fmt or "wav").lower()
    if fmt not in ("wav", "mp3"):
        raise TTSLocalError("仅支持 wav 或 mp3 输出格式")

    if provider == "pyttsx3":
        try:
            import pyttsx3
        except Exception as e:
            raise TTSLocalError(f"pyttsx3 未安装或不可用: {e}")

        engine = pyttsx3.init()
        if voice:
            try:
                engine.setProperty('voice', voice)
            except Exception:
                # 兼容不同平台的voice id，不抛错
                pass
        # 速度与音量可根据需要调整
        try:
            engine.setProperty('rate', 180)
            engine.setProperty('volume', 0.9)
        except Exception:
            pass

        # pyttsx3 只能保存到文件，Windows 下默认输出为 WAV
        suffix = ".wav" if fmt == "wav" else ".mp3"
        with tempfile.TemporaryDirectory() as tmpdir:
            out_path = os.path.join(tmpdir, f"tts_output{suffix}")
            engine.save_to_file(text, out_path)
            engine.runAndWait()
            if not os.path.exists(out_path):
                raise TTSLocalError("pyttsx3 合成失败，未生成文件")
            with open(out_path, 'rb') as f:
                data = f.read()
        mime = "audio/wav" if fmt == "wav" else "audio/mpeg"
        return data, mime

    elif provider == "edge":
        # 使用 edge-tts (async)，这里需要用到 asyncio.run 或者 loop
        # 注意：edge-tts 是异步库，如果 synthesize 是同步调用，需要 wrap 一下
        voice = voice or "en-US-AnaNeural" # 默认音色
        
        # 简单封装一个异步调用
        async def _edge_gen():
            import edge_tts
            communicate = edge_tts.Communicate(text, voice)
            # 累积所有音频数据（Edge-TTS 返回的是 mp3 格式流）
            data = b""
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    data += chunk["data"]
            return data

        try:
            import edge_tts
            import asyncio
        except ImportError:
            raise TTSLocalError("edge-tts 未安装，请执行 pip install edge-tts")

        try:
            # 如果当前已经在 async loop 中，不能直接 run，需要 nest_asyncio 或者其他处理
            # 简单起见，这里假设 synthesize 是在一个线程池或同步环境中被调用
            # 如果报错 "This event loop is already running"，则需要调整架构
            try:
                loop = asyncio.get_event_loop()
            except RuntimeError:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
            
            if loop.is_running():
                # 这种情况下比较麻烦，通常 synthesize 不应该在 async def 中直接被同步调用
                # 这里做一个折衷：抛出异常提示
                 raise TTSLocalError("无法在运行中的事件循环里同步调用 edge-tts，请检查调用方式")
            else:
                data = loop.run_until_complete(_edge_gen())
                
            mime = "audio/mpeg"
            return data, mime
        except Exception as e:
            raise TTSLocalError(f"edge-tts 合成失败: {e}")

    elif provider in ("http", "cosyvoice", "chattts"):
        # 通过本地或远程HTTP服务合成，统一POST接口
        if not service_url:
            raise TTSLocalError("未提供本地TTS服务URL")
        payload = {
            "text": text,
            "voice": voice,
            "language": language,
            "format": fmt,
            "sample_rate": sample_rate,
        }
        try:
            resp = requests.post(service_url, json=payload, timeout=60)
        except Exception as e:
            raise TTSLocalError(f"HTTP TTS 服务请求失败: {e}")

        if resp.status_code != 200:
            raise TTSLocalError(f"HTTP TTS 服务返回错误码: {resp.status_code}")

        ctype = resp.headers.get('Content-Type', '')
        if ctype.startswith('audio/'):
            return resp.content, ctype

        # 尝试解析为JSON，支持返回base64或bytes字段
        try:
            js = resp.json()
        except Exception:
            # 兜底：当服务未设置Content-Type时直接当音频处理
            return resp.content, ("audio/wav" if fmt == "wav" else "audio/mpeg")

        if 'audio_base64' in js:
            import base64
            try:
                data = base64.b64decode(js['audio_base64'])
            except Exception as e:
                raise TTSLocalError(f"解析audio_base64失败: {e}")
            mime = js.get('mime', "audio/wav" if fmt == "wav" else "audio/mpeg")
            return data, mime
        elif 'audio_bytes' in js:
            # 某些服务可能返回JSON中的二进制数组（不推荐），这里做兼容
            data = bytes(js['audio_bytes'])
            mime = js.get('mime', "audio/wav" if fmt == "wav" else "audio/mpeg")
            return data, mime
        else:
            raise TTSLocalError("HTTP TTS 服务响应不包含音频数据")

    elif provider == "xtts":
        # 直接使用 Coqui TTS 的 XTTS v2 离线推理，无需额外服务端口
        # 注意：目前仅输出 WAV；如需 MP3 需要外部编码器支持
        if fmt != "wav":
            raise TTSLocalError("xtts 本地合成暂仅支持 wav 输出格式")
        try:
            from TTS.api import TTS as CoquiTTS
        except Exception as e:
            raise TTSLocalError(f"未安装 Coqui TTS 库(TTS): {e}")

        # 语音克隆需要提供说话人样本文件路径（建议 wav）。
        speaker_wav = None
        if voice:
            speaker_path = pathlib.Path(voice)
            if not speaker_path.exists():
                raise TTSLocalError(f"voice 指定的文件不存在: {voice}")
            if speaker_path.suffix.lower() != ".wav":
                # 目前不内置 mp3 -> wav 转换，提示先转换
                raise TTSLocalError("XTTS 语音克隆需要 WAV 样本，请先将 MP3 转为 WAV")
            speaker_wav = str(speaker_path)

        try:
            tts = CoquiTTS(model_name="tts_models/multilingual/multi-dataset/xtts_v2")
        except Exception as e:
            raise TTSLocalError(f"加载 XTTS v2 模型失败: {e}")

        try:
            audio = tts.tts(text=text, speaker_wav=speaker_wav, language=language)
        except Exception as e:
            raise TTSLocalError(f"XTTS 合成失败: {e}")

        # audio 为 float32 numpy 数组，范围约 [-1, 1]
        if not isinstance(audio, np.ndarray):
            try:
                audio = np.array(audio, dtype=np.float32)
            except Exception:
                raise TTSLocalError("XTTS 输出音频格式异常")
        # 转为 int16 PCM
        pcm = (audio.clip(-1.0, 1.0) * 32767.0).astype(np.int16).tobytes()

        # 写入 WAV 容器
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate or 24000)
            wf.writeframes(pcm)
        data = buffer.getvalue()
        return data, "audio/wav"

    else:
        raise TTSLocalError(f"未知的本地TTS provider: {provider}")