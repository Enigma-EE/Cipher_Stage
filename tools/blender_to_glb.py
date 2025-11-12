"""
使用 Blender 批量将 FBX/DAE 转换为 GLB。

用法（命令行）：
  "C:\\Program Files\\Blender Foundation\\Blender 4.1\\blender.exe" -b -P tools/blender_to_glb.py -- <输入目录> <输出目录> [--recursive]

注意：
  - 需要安装 Blender（3.x 或 4.x）。
  - 该脚本会导入 FBX/DAE 并导出 GLB，保留动画并进行动画烘焙。
  - Unreal 的 .uasset 不受支持，需在 UE 编辑器中先导出为 FBX。
"""

import os
import sys
import glob

import bpy  # Blender 的 Python 模块，仅在 Blender 内可用


def clear_scene():
    # 重置到空场景，避免多次导入叠加
    bpy.ops.wm.read_homefile(use_empty=True)


def convert_one(input_path: str, output_path: str) -> bool:
    clear_scene()
    ext = os.path.splitext(input_path)[1].lower()
    try:
        if ext == ".fbx":
            bpy.ops.import_scene.fbx(
                filepath=input_path,
                automatic_bone_orientation=True,
            )
        elif ext == ".dae":
            bpy.ops.wm.collada_import(filepath=input_path)
        else:
            print(f"跳过不支持的格式: {input_path}")
            return False
    except Exception as e:
        print(f"导入失败: {input_path} -> {e}")
        return False

    try:
        bpy.ops.export_scene.gltf(
            filepath=output_path,
            export_format='GLB',
            export_animations=True,
            export_animation_bake=True,
            export_morph=True,
            export_apply=True,
        )
    except Exception as e:
        print(f"导出失败: {output_path} -> {e}")
        return False
    return True


def main(input_dir: str, output_dir: str, recursive: bool):
    os.makedirs(output_dir, exist_ok=True)
    pattern = "**/*" if recursive else "*"
    files = []
    files.extend(glob.glob(os.path.join(input_dir, pattern + ".fbx"), recursive=recursive))
    files.extend(glob.glob(os.path.join(input_dir, pattern + ".dae"), recursive=recursive))

    if not files:
        print("未找到可转换的文件（FBX/DAE）")
        return

    for f in files:
        out = os.path.join(output_dir, os.path.splitext(os.path.basename(f))[0] + ".glb")
        ok = convert_one(f, out)
        print(("OK" if ok else "FAIL") + f" -> {out}")


if __name__ == "__main__":
    argv = sys.argv
    if "--" in argv:
        args = argv[argv.index("--") + 1:]
    else:
        args = []

    if len(args) < 2:
        print("用法: blender -b -P tools/blender_to_glb.py -- <输入目录> <输出目录> [--recursive]")
        sys.exit(1)

    input_dir, output_dir = args[0], args[1]
    recursive = "--recursive" in args
    main(input_dir, output_dir, recursive)