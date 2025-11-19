"""
离线 ASR 插件接口骨架（参考实现 + 自研方案）

说明：
- 本文件不包含上游 `ai_virtual_mate_web` 的任何源代码，仅参考其模块划分与功能目标，采用自研接口设计以避免 GPL 传染。
- 后续如需接入 FunASR ONNX，可在本插件中实现模型加载与推理，保持与主项目松耦合。
"""

from typing import List, Dict, Any, Optional
import logging
import os
import tempfile


class LocalASR:
    """本地 ASR 插件骨架。后续可接入 FunASR ONNX 或其它离线识别模型。"""

    def __init__(
        self,
        model_dir: Optional[str] = None,
        lang: str = "en",
        backend: str = "auto",  # auto|faster-whisper|funasr (占位)
        whisper_model: str = "small.en",  # 优先英文低延迟模型；亦可传本地路径
        use_gpu: Optional[bool] = None
    ):
        self.model_dir = model_dir
        self.lang = lang
        self.backend = backend
        self.whisper_model = whisper_model
        self.use_gpu = use_gpu
        self.ready = False
        self._impl = None  # 具体实现对象（例如 faster-whisper 的 WhisperModel）

    def load(self) -> bool:
        """加载模型资源（尝试 faster-whisper；保留 FunASR 占位）。"""
        if self.backend in ("auto", "faster-whisper"):
            try:
                from faster_whisper import WhisperModel  # type: ignore
                # 如果用户显式要求 GPU，但实际不支持，则回退到 CPU，避免抛错进入占位
                cuda_available = self._detect_cuda()
                if self.use_gpu is True and not cuda_available:
                    device = "cpu"
                elif self.use_gpu is True and cuda_available:
                    device = "cuda"
                elif self.use_gpu is False:
                    device = "cpu"
                else:
                    device = "cuda" if cuda_available else "cpu"

                compute_type = "float16" if device == "cuda" else "int8"
                logging.getLogger(__name__).info(f"初始化 faster-whisper：model={self.whisper_model} device={device} compute={compute_type}")
                self._impl = WhisperModel(self.whisper_model, device=device, compute_type=compute_type)
                self.ready = True
                self.backend = "faster-whisper"
                return True
            except Exception as e:
                # 回退到占位，并记录详细错误以便排查
                logging.getLogger(__name__).error(f"faster-whisper 初始化失败: {e}")
                self._impl = None
                self.ready = False

        # 保留 FunASR 的占位逻辑；如需接入在此实现
        # if self.backend == "funasr":
        #     from funasr import AutoModel
        #     self._impl = AutoModel(model_dir=self.model_dir, ...)  # 示例占位
        #     self.ready = True

        # 若都不可用，仍返回占位可用状态
        self.ready = True
        return True

    def transcribe_from_wav_bytes(self, wav_bytes: bytes, sample_rate: int = 16000) -> Dict[str, Any]:
        """从 WAV 字节进行识别：优先使用 faster-whisper；否则返回占位结果。"""
        if not self.ready:
            self.load()

        # 优先使用 faster-whisper
        if self.backend == "faster-whisper" and self._impl is not None:
            # 轻量嗅探字节头，自动匹配常见格式以提高兼容性（mp3/wav/flac/ogg）
            def _sniff_suffix(b: bytes) -> str:
                try:
                    head = b[:16]
                    if head.startswith(b"ID3"):
                        return ".mp3"
                    # MPEG Audio frame sync (approx)
                    if head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
                        return ".mp3"
                    # WAV RIFF header
                    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WAVE":
                        return ".wav"
                    # FLAC
                    if head.startswith(b"fLaC"):
                        return ".flac"
                    # OGG
                    if head.startswith(b"OggS"):
                        return ".ogg"
                    # MP4/M4A (ftyp)
                    if head[4:8] == b"ftyp" and (head[8:12] in (b"M4A ", b"isom", b"mp42")):
                        return ".m4a"
                except Exception:
                    pass
                return ".wav"

            suffix = _sniff_suffix(wav_bytes)
            logging.getLogger(__name__).info(f"ASR 输入格式嗅探：选择后缀 {suffix}")
            tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
            try:
                tmp.write(wav_bytes)
                tmp.flush(); tmp.close()
                # 低延迟配置：英文锁定、单束搜索、去时间戳
                try:
                    segments, info = self._impl.transcribe(
                        tmp.name,
                        language=self.lang or "en",
                        task="transcribe",
                        beam_size=1,
                        best_of=1,
                        temperature=0.0,
                        without_timestamps=True,
                        vad_filter=False,
                        condition_on_previous_text=False,
                    )
                except Exception as e:
                    logging.getLogger(__name__).error(f"ASR 识别失败（{suffix}）：{e}")
                    return {
                        "text": "",
                        "segments": [],
                        "sample_rate": sample_rate,
                        "lang": self.lang,
                        "backend": "faster-whisper",
                        "error": str(e),
                    }
                out_segments: List[Dict[str, Any]] = []
                full_text_parts: List[str] = []
                for s in segments:
                    out_segments.append({
                        "start": float(getattr(s, "start", 0.0) or 0.0),
                        "end": float(getattr(s, "end", 0.0) or 0.0),
                        "text": getattr(s, "text", "") or ""
                    })
                    if getattr(s, "text", None):
                        full_text_parts.append(s.text)
                return {
                    "text": "".join(full_text_parts) if full_text_parts else "",
                    "segments": out_segments,
                    "sample_rate": sample_rate,
                    "lang": self.lang,
                    "backend": "faster-whisper",
                    "duration": float(getattr(info, "duration", 0.0) or 0.0)
                }
            finally:
                try:
                    os.unlink(tmp.name)
                except Exception:
                    pass

        # 占位返回（后续可接入 FunASR）
        return {
            "text": "(stub) 离线ASR占位识别结果",
            "segments": [
                {"start": 0.00, "end": 0.80, "text": "占位"},
                {"start": 0.80, "end": 1.60, "text": "结果"}
            ],
            "sample_rate": sample_rate,
            "lang": self.lang,
            "backend": "stub"
        }

    @staticmethod
    def _detect_cuda() -> bool:
        try:
            import torch  # type: ignore
            return bool(getattr(torch, "cuda", None) and torch.cuda.is_available())
        except Exception:
            return False