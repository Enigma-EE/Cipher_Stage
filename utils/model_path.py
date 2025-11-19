import os

def normalize_vrm_path(vrm_model: str) -> str:
    """
    规范化 VRM 模型路径：
    - 若已以 "/static/" 开头，直接返回
    - 否则，拼接为 "/static/{filename}"
    """
    if not isinstance(vrm_model, str) or not vrm_model:
        return "/static/EE.vrm"
    return vrm_model if vrm_model.startswith('/static/') else f"/static/{vrm_model}"


def validate_character_config(characters_data: dict, static_dir: str = 'static'):
    """
    对 characters.json 的角色配置做基础校验：
    - 每个角色至少应该有 vrm_model 或 live2d 其中之一
    - 如提供 vrm_model，检查对应文件是否存在于 static 目录
    - 如提供 live2d，检查对应目录是否存在于 static 下
    返回告警列表，供调用方打印日志。
    """
    warnings = []
    if not isinstance(characters_data, dict):
        return ["[characters] 配置格式不是 dict，跳过校验"]

    # 兼容键名：优先 Vtuber，否则 猫娘
    roles = characters_data.get('Vtuber') if isinstance(characters_data.get('Vtuber'), dict) else characters_data.get('猫娘', {})
    if not isinstance(roles, dict) or not roles:
        warnings.append('[characters] 未找到 Vtuber/猫娘 配置，使用默认角色')
        return warnings

    for name, cfg in roles.items():
        if not isinstance(cfg, dict):
            warnings.append(f"[characters] 角色 {name} 的配置不是 dict")
            continue

        vrm_model = cfg.get('vrm_model', '')
        live2d = cfg.get('live2d', '')

        if not vrm_model and not live2d:
            warnings.append(f"[characters] 角色 {name} 未设置 vrm_model 或 live2d（至少需要一个）")
            continue

        # 检查 VRM 文件是否存在（如果设置了）
        if vrm_model:
            vrm_file = vrm_model if os.path.isabs(vrm_model) else os.path.join(static_dir, vrm_model)
            if not os.path.exists(vrm_file):
                warnings.append(f"[characters] 角色 {name} 的 VRM 文件不存在: {vrm_file}")

        # 检查 Live2D 目录是否存在（如果设置了）
        if live2d:
            l2d_dir = os.path.join(static_dir, live2d)
            if not os.path.isdir(l2d_dir):
                warnings.append(f"[characters] 角色 {name} 的 Live2D 目录不存在: {l2d_dir}")

    return warnings