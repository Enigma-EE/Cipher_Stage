import sys
import struct

def read_glb_json(path):
    with open(path, 'rb') as f:
        data = f.read()
    # GLB header: 12 bytes
    if len(data) < 12:
        raise ValueError('File too small for GLB header')
    magic, version, length = struct.unpack_from('<III', data, 0)
    if magic != 0x46546C67:  # 'glTF'
        raise ValueError('Not a GLB file (magic mismatch)')
    offset = 12
    json_chunk = None
    # Iterate chunks
    while offset + 8 <= len(data):
        chunk_len, chunk_type = struct.unpack_from('<II', data, offset)
        offset += 8
        chunk_data = data[offset:offset + chunk_len]
        offset += chunk_len
        if chunk_type == 0x4E4F534A:  # 'JSON'
            json_chunk = chunk_data
            break
    if json_chunk is None:
        raise ValueError('JSON chunk not found in GLB')
    # Decode JSON (should be UTF-8)
    try:
        json_text = json_chunk.decode('utf-8')
    except UnicodeDecodeError:
        # Some writers may include BOM or other encodings, try strict fallback
        json_text = json_chunk.decode('utf-8', errors='replace')
    return json_text

def main():
    if len(sys.argv) < 2:
        print('Usage: python tools/inspect_glb.py <path_to_glb_or_vrm>')
        sys.exit(1)
    path = sys.argv[1]
    try:
        json_text = read_glb_json(path)
    except Exception as e:
        print(f'[ERROR] Failed to read GLB JSON: {e}')
        sys.exit(2)
    import json
    try:
        gltf = json.loads(json_text)
    except Exception as e:
        print(f'[ERROR] Failed to parse GLTF JSON: {e}')
        sys.exit(3)

    ex = gltf.get('extensions', {}) or {}
    has_vrm1 = 'VRMC_vrm' in ex
    has_vrm0 = 'VRM' in ex
    has_spring = 'VRMC_springBone' in ex
    print('Extensions keys:', list(ex.keys()))
    print('Has VRMC_vrm:', has_vrm1)
    print('Has VRM (0.x):', has_vrm0)
    print('Has VRMC_springBone:', has_spring)

    # Optional: print basic node/mesh counts for quick sanity
    nodes = gltf.get('nodes', []) or []
    meshes = gltf.get('meshes', []) or []
    print('Nodes:', len(nodes), 'Meshes:', len(meshes))

    # Print some spring info if present
    spring = ex.get('VRMC_springBone')
    if spring:
        # The structure differs across versions; print available top-level keys
        print('VRMC_springBone keys:', list(spring.keys()))

if __name__ == '__main__':
    main()