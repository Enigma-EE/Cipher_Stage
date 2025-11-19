import os
import platform
import subprocess
from typing import Any, Dict, List, Optional


def get_cpu_info() -> Dict[str, Any]:
    info: Dict[str, Any] = {
        "machine": platform.machine(),
        "processor": platform.processor(),
        "system": platform.system(),
        "python": platform.python_version(),
        "cores": os.cpu_count() or 0,
    }
    # 可选频率信息（尽力而为）
    try:
        import psutil  # type: ignore
        freq = getattr(psutil, "cpu_freq", None)
        if freq:
            f = freq()
            if f:
                info["cpu_freq_mhz"] = getattr(f, "current", None)
    except Exception:
        pass
    return info


def get_gpu_info() -> List[Dict[str, Any]]:
    gpus: List[Dict[str, Any]] = []
    # 优先使用 GPUtil（在requirements里）
    try:
        import GPUtil  # type: ignore
        for gpu in GPUtil.getGPUs():
            gpus.append({
                "id": gpu.id,
                "name": gpu.name,
                "memory_total_mb": gpu.memoryTotal,
                "memory_used_mb": gpu.memoryUsed,
                "memory_free_mb": gpu.memoryFree
            })
    except Exception:
        # 回退：Windows下尝试调用系统命令
        try:
            if platform.system().lower() == 'windows':
                out = subprocess.check_output(['wmic', 'path', 'win32_videocontroller', 'get', 'name'], stderr=subprocess.DEVNULL)
                names = [n.strip() for n in out.decode(errors='ignore').splitlines() if n.strip() and n.strip().lower() != 'name']
                for i, n in enumerate(names):
                    gpus.append({"id": i, "name": n})
        except Exception:
            pass
    return gpus


def get_memory_info() -> Dict[str, Any]:
    info: Dict[str, Any] = {}
    try:
        import psutil  # type: ignore
        vm = psutil.virtual_memory()
        info = {
            "total_mb": int(vm.total / (1024 * 1024)),
            "available_mb": int(vm.available / (1024 * 1024)),
            "used_mb": int(vm.used / (1024 * 1024)),
        }
    except Exception:
        pass
    return info