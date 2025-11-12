// Offline RGBELoader adapted for this project.
// Uses global THREE from existing build to avoid multiple-instance warnings.
// Source based on three.js examples/jsm/loaders/RGBELoader.js (simplified).

const THREE = window.THREE;

class HDRParser {
    static parse(buffer) {
        const byteArray = new Uint8Array(buffer);
        let header = '';
        let pos = 0;
        while (true) {
            const ch = byteArray[pos++];
            header += String.fromCharCode(ch);
            if (header.endsWith('\n\n') || header.endsWith('\r\n\r\n')) break;
            if (pos >= byteArray.length) break;
        }

        const lines = header.split(/\r?\n/);
        let width = 0, height = 0;
        let format = '32-bit_rle_rgbe';
        for (const line of lines) {
            if (line.startsWith('FORMAT=')) format = line.substring(7).trim();
            if (line.match(/^-Y\s+\d+\s\+X\s+\d+/)) {
                const m = line.match(/^-Y\s+(\d+)\s\+X\s+(\d+)/);
                height = parseInt(m[1]);
                width = parseInt(m[2]);
            }
        }
        if (format !== '32-bit_rle_rgbe') {
            throw new Error('Unsupported HDR format: ' + format);
        }

        const data = new Uint8Array(width * height * 4);
        let offset = pos;
        const scanline = new Uint8Array(width * 4);

        function readScanline() {
            let i = 0;
            // Read RLE-encoded scanline per component
            for (let c = 0; c < 4; c++) {
                let ptr = c;
                while (i < width) {
                    const rleCount = byteArray[offset++];
                    const rleValue = byteArray[offset++];
                    if (rleCount > 128) {
                        const count = rleCount - 128;
                        for (let k = 0; k < count; k++) {
                            scanline[(i + k) * 4 + ptr] = rleValue;
                        }
                        i += count;
                    } else {
                        scanline[i * 4 + ptr] = rleValue;
                        for (let k = 1; k < rleCount; k++) {
                            scanline[(i + k) * 4 + ptr] = byteArray[offset++];
                        }
                        i += rleCount;
                    }
                }
                i = 0;
            }
            return scanline;
        }

        for (let y = 0; y < height; y++) {
            // Read RLE header for scanline
            const a = byteArray[offset++];
            const b = byteArray[offset++];
            const c = byteArray[offset++];
            const d = byteArray[offset++];
            if (a !== 2 || b !== 2 || ((c << 8) | d) !== width) {
                throw new Error('Bad HDR scanline width');
            }
            const lineData = readScanline();
            data.set(lineData, y * width * 4);
        }

        // Convert RGBE to float RGB and alpha=1 using exposure
        const out = new Float32Array(width * height * 4);
        for (let i = 0; i < width * height; i++) {
            const r = data[i * 4 + 0];
            const g = data[i * 4 + 1];
            const b = data[i * 4 + 2];
            const e = data[i * 4 + 3];
            if (e > 0) {
                const f = Math.pow(2, e - 128 - 8); // 2^(e-128) / 256
                out[i * 4 + 0] = r * f;
                out[i * 4 + 1] = g * f;
                out[i * 4 + 2] = b * f;
                out[i * 4 + 3] = 1.0;
            } else {
                out[i * 4 + 0] = 0;
                out[i * 4 + 1] = 0;
                out[i * 4 + 2] = 0;
                out[i * 4 + 3] = 1.0;
            }
        }

        return { width, height, data: out };
    }
}

export class RGBELoader extends THREE.DataTextureLoader {
    constructor(manager) { super(manager); this.type = THREE.FloatType; }
    setDataType(type) { this.type = type; return this; }
    parse(buffer) {
        const hdr = HDRParser.parse(buffer);
        const texture = this._createTexture(hdr);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;
        return texture;
    }
    _createTexture(hdr) {
        const { width, height, data } = hdr;
        const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, this.type);
        return texture;
    }
}

export default RGBELoader;