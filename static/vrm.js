// VRM模型管理器
class VRMManager {
    constructor() {
        this.currentModel = null;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.clock = null;
        this.mixer = null;
        this.isInitialized = false;
        this.modelUrl = null;
        this.modelName = null;
        this.modelRootPath = null;
        this.onModelLoaded = null;
        this.onStatusUpdate = null;
        this.animationActions = {};
        // 基于AnimationClip的动画库与动作缓存
        this.animationLibrary = {};
        this.clipActions = {};
        this.currentClipAction = null;
        this.currentEmotion = 'neutral';
        this.mouthValue = 0;
        this.blinkValue = 0;
        this.blinkTimer = null;
        // 五元音权重与缓存
        this.vowelWeights = { a: 0, e: 0, i: 0, o: 0, u: 0 };
        this.availableMouthNames = ['aa'];
        // 可用表情名（在初始化时收集）
        this.availableExpressions = [];
        this._prevAudio = { volume: 0, frequency: 0 };
        this.lastExpressionName = null;
        
        // 控制参数
        this.dragEnabled = false;
        this.isFocusing = false;
        this.isLocked = true;
        
        // 渲染循环句柄
        this._animationFrameId = null;

        // 动作重定向选项（可调整）
        this.retargetOptions = {
            includeLowerBody: true,      // 默认包含下半身骨骼
            allowHipsRotation: true,     // 默认允许髋骨旋转（夹角限制生效）
            clampHipsRotationDeg: 35     // 髋骨旋转夹角限制（度）
        };
    }
    
    // 初始化Three.js渲染环境
    async initThree(canvasId, containerId, options = {}) {
        if (this.isInitialized) {
            console.warn('VRM管理器已经初始化');
            return;
        }
        
        const container = document.getElementById(containerId);
        const canvas = document.getElementById(canvasId);
        if (!container || !canvas) {
            console.error('VRM容器或画布未找到:', { containerId, canvasId, container, canvas });
            return;
        }
        // 保存引用供交互使用
        this.containerEl = container;
        this.canvasEl = canvas;

        // 如果容器初始高度或宽度为0，尝试强制显示并设定一个临时尺寸，避免相机/渲染器计算为NaN
        let cw = container.clientWidth;
        let ch = container.clientHeight;
        if (!cw || !ch) {
            // 强制显示并设置min尺寸
            container.style.display = 'block';
            container.style.minWidth = container.style.minWidth || '320px';
            container.style.minHeight = container.style.minHeight || '240px';
            // 读取更新后的尺寸
            cw = container.clientWidth || 320;
            ch = container.clientHeight || 240;
            console.warn('VRM容器尺寸为0，已设置临时最小尺寸:', cw, 'x', ch);
        }
        
        // 创建场景
        this.scene = new THREE.Scene();
        this.scene.background = null; // 透明背景
        
        // 创建相机
        this.camera = new THREE.PerspectiveCamera(
            30, // 视野角度
            cw / ch, // 宽高比
            0.1, // 近裁剪面
            20 // 远裁剪面
        );
// 设置相机位置和朝向
        this.camera.position.set(0, 0, 2.5); // 相机位置
        this.camera.lookAt(0, -0.2, 0); // 相机朝向模型中心偏下
        
        // 创建渲染器
        this.renderer = new THREE.WebGLRenderer({
            canvas: canvas,
            alpha: true, // 启用透明度
            antialias: true, // 抗锯齿
            preserveDrawingBuffer: false,
            powerPreference: 'high-performance',
            depth: true,
            stencil: false,
            failIfMajorPerformanceCaveat: false
        });
        this.renderer.setSize(cw, ch);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setClearColor(0x000000, 0); // 设置透明背景
        // 色彩空间与物理光照（three r160+ 使用 outputColorSpace）
        if (this.renderer.outputColorSpace !== undefined) {
            this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        }
        this.renderer.physicallyCorrectLights = true;
        
        console.log('VRM渲染器初始化完成，容器大小:', cw, 'x', ch);

        // WebGL 上下文丢失/恢复处理，避免因驱动或资源峰值导致崩溃
        this._contextLost = false;
        const onContextLost = (evt) => {
            try { evt.preventDefault(); } catch (_) {}
            this._contextLost = true;
            try { cancelAnimationFrame(this._animationFrameId); } catch (_) {}
            console.warn('WebGL context lost: 已暂停渲染循环，等待恢复');
        };
        const onContextRestored = () => {
            this._contextLost = false;
            console.log('WebGL context restored: 重新启动渲染循环');
            try { this.startRenderLoop(); } catch (e) { console.warn('恢复渲染循环失败:', e); }
        };
        try {
            canvas.addEventListener('webglcontextlost', onContextLost, false);
            canvas.addEventListener('webglcontextrestored', onContextRestored, false);
        } catch (e) { console.warn('绑定 WebGL 上下文事件失败:', e); }
        
        // 添加更好的灯光配置
        // 主光源 - 模拟太阳光
        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
        directionalLight.position.set(1, 1, 1);
        directionalLight.castShadow = true;
        this.scene.add(directionalLight);
        
        // 环境光 - 提供基础照明
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);
        
        // 补光 - 从另一个角度照亮模型
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
        fillLight.position.set(-1, 0.5, -1);
        this.scene.add(fillLight);
        
        // 启用渲染器的阴影和色调映射
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;
        
        // 创建时钟用于动画
        this.clock = new THREE.Clock();
        
        // 处理窗口大小变化
        window.addEventListener('resize', () => {
            if (!this.camera || !this.renderer) return;
            const w = container.clientWidth || cw;
            const h = container.clientHeight || ch;
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(w, h);
        });
        
        this.isInitialized = true;
        
        // 开始渲染循环
        this.startRenderLoop();
    }

    // 启用/禁用拖拽移动（屏幕平面）
    enableDrag(enabled = true) {
        this.dragEnabled = !!enabled;
        if (!this.canvasEl || !this.camera) return;
        // 当启用拖拽时允许鼠标事件落到画布与容器
        try { this.canvasEl.style.pointerEvents = this.dragEnabled ? 'auto' : 'none'; } catch (_) {}
        try {
            if (this.containerEl) this.containerEl.style.pointerEvents = this.dragEnabled ? 'auto' : 'none';
        } catch (_) {}

        // 初始化一次事件绑定
        if (!this._dragListenersInitialized) {
            this._dragListenersInitialized = true;
            this._raycaster = new THREE.Raycaster();
            this._pointer = new THREE.Vector2();
            this._dragging = false;
            this._dragPlane = null;

            const updatePointer = (ev) => {
                const rect = this.canvasEl.getBoundingClientRect();
                this._pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
                this._pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
            };

            // 计算用于拖拽的“腰部”世界坐标（作为平面锚点），并在移动时保持这个点跟随指针
            this._getDragPivotWorldPos = () => {
                try {
                    // 优先使用 humanoid 的脊椎/胸部作为拖动中心，其次使用髋骨
                    const hum = this.currentModel?.humanoid;
                    const getter = hum && ((typeof hum.getNormalizedBoneNode === 'function') ? hum.getNormalizedBoneNode.bind(hum) : (typeof hum.getBoneNode === 'function') ? hum.getBoneNode.bind(hum) : null);
                    const candidateKeys = ['spine', 'chest', 'upperChest', 'hips'];
                    if (getter) {
                        for (const k of candidateKeys) {
                            const bone = getter(k);
                            if (bone && typeof bone.getWorldPosition === 'function') {
                                const wp = new THREE.Vector3();
                                bone.getWorldPosition(wp);
                                return wp;
                            }
                        }
                    }
                    // GLTF 回退或无 humanoid：使用根位置上方一个经验值偏移，近似腰部
                    const root = (this.currentModel && this.currentModel.scene) ? this.currentModel.scene.position.clone() : new THREE.Vector3();
                    return new THREE.Vector3(root.x, root.y + 0.8, root.z);
                } catch (_) {
                    // 出错时退回根位置
                    return (this.currentModel && this.currentModel.scene) ? this.currentModel.scene.position.clone() : new THREE.Vector3();
                }
            };

            this._onPointerDown = (ev) => {
                if (!this.dragEnabled || !this.currentModel) return;
                // 与 Live2D 一致：锁定时禁止拖拽
                if (this.isLocked) return;
                this._dragging = true;
                const normal = new THREE.Vector3();
                this.camera.getWorldDirection(normal);
                // 将拖拽平面锚定到“腰部”附近，而不是脚下（根节点）
                const pivotWorld = this._getDragPivotWorldPos();
                const origin = pivotWorld || (this.currentModel.scene?.position || new THREE.Vector3());
                const constant = -normal.dot(origin);
                this._dragPlane = new THREE.Plane(normal, constant);
                // 记录根节点与拖拽枢轴（腰部）之间的偏移，以在移动时保持枢轴对准指针
                try {
                    const root = this.currentModel.scene?.position.clone() || new THREE.Vector3();
                    this._dragPivotOffset = new THREE.Vector3(origin.x - root.x, origin.y - root.y, origin.z - root.z);
                } catch (_) {
                    this._dragPivotOffset = new THREE.Vector3(0, 0.8, 0);
                }
                updatePointer(ev);
                try { ev.preventDefault(); } catch (_) {}
            };

            this._onPointerUp = () => { this._dragging = false; };

            this._onPointerMove = (ev) => {
                if (!this._dragging || !this._dragPlane || !this.currentModel) return;
                updatePointer(ev);
                this._raycaster.setFromCamera(this._pointer, this.camera);
                const p = new THREE.Vector3();
                this._raycaster.ray.intersectPlane(this._dragPlane, p);
                if (p && isFinite(p.x) && isFinite(p.y) && isFinite(p.z)) {
                    // 保持“腰部”跟随指针：根位置 = 交点 - 腰部偏移
                    try {
                        const off = this._dragPivotOffset || new THREE.Vector3(0, 0.8, 0);
                        this.currentModel.scene.position.set(p.x - off.x, p.y - off.y, p.z - off.z);
                    } catch (_) {}
                }
            };

            try {
                this.canvasEl.addEventListener('pointerdown', this._onPointerDown);
                window.addEventListener('pointerup', this._onPointerUp);
                this.canvasEl.addEventListener('pointermove', this._onPointerMove);
            } catch (_) {}
        }
    }

    // 重置模型位置到原点
    resetModelPosition() {
        if (!this.currentModel) return;
        try { this.currentModel.scene.position.set(0, 0, 0); } catch (_) {}
    }

    // 轻微微调位置
    nudgeModel(dx = 0, dy = 0, dz = 0) {
        if (!this.currentModel) return;
        try {
            const p = this.currentModel.scene.position;
            this.currentModel.scene.position.set(p.x + dx, p.y + dy, p.z + dz);
        } catch (_) {}
    }
    
    // 渲染循环
    startRenderLoop() {
        const animate = () => {
            this._animationFrameId = requestAnimationFrame(animate);
            
            const delta = this.clock.getDelta();
            
            if (this.mixer) {
                this.mixer.update(delta);
            }
            
            if (this.currentModel) {
                // 更新VRM模型（包括SpringBone物理系统）
                this.currentModel.update(delta);
                this.updateFacialExpressions();
                
                // 安全检查：防止根节点被动画驱动到异常位置
                try {
                    const scene = this.currentModel.scene;
                    const pos = scene.position;
                    const scale = scene.scale;
                    
                    // 如果位置偏移过大（超过合理范围），重置到原始位置
                    if (this.originalRootPosition && 
                        (Math.abs(pos.x - this.originalRootPosition.x) > 5 || 
                         Math.abs(pos.y - this.originalRootPosition.y) > 5 || 
                         Math.abs(pos.z - this.originalRootPosition.z) > 5)) {
                        pos.copy(this.originalRootPosition);
                    }
                    
                    // 如果缩放异常（过小或过大），重置到原始缩放
                    if (this.originalRootScale && 
                        (scale.x < 0.1 || scale.x > 3 || 
                         scale.y < 0.1 || scale.y > 3 || 
                         scale.z < 0.1 || scale.z > 3)) {
                        scale.copy(this.originalRootScale);
                    }
                } catch (_) {}
            }
            // 手动动画驱动（当标准绑定失败时的回退）。放在 VRM 更新之后，避免被其内部约束覆盖。
            if (this._manualAnim) {
                try { this._updateManualAnimation(delta); } catch (_) {}
            }
            
            // 渲染场景
            try { if (this.currentModel && this.currentModel.scene && this.currentModel.scene.visible === false) this.currentModel.scene.visible = true; } catch (_) {}
            this.renderer.render(this.scene, this.camera);
            
            // 调试信息：每100帧输出一次场景状态
            if (Math.floor(Date.now() / 1000) % 10 === 0 && Math.floor(Date.now() / 100) % 10 === 0) {
                console.log('渲染状态 - 场景对象数:', this.scene.children.length, 
                           '当前模型:', this.currentModel ? '已加载' : '未加载',
                           '相机位置:', this.camera.position);
            }
        };
        animate();
    }
    
    // 停止渲染循环
    stopRenderLoop() {
        if (this._animationFrameId) {
            cancelAnimationFrame(this._animationFrameId);
            this._animationFrameId = null;
        }
    }

    // 设置HDR环境贴图（若存在RGBELoader）
    async setEnvironmentHDR(url) {
        if (!this.scene || !this.renderer) return false;
        try {
            const pmrem = new THREE.PMREMGenerator(this.renderer);
            pmrem.compileEquirectangularShader();
            const isHDR = typeof url === 'string' && url.toLowerCase().endsWith('.hdr');
            if (isHDR) {
                let RGBELoaderCtor = THREE.RGBELoader;
                // 动态导入本地RGBELoader（若未内置）
                if (!RGBELoaderCtor) {
                    try {
                        const modLocal = await import('/static/libs/jsm/loaders/RGBELoader.js');
                        RGBELoaderCtor = modLocal?.RGBELoader || RGBELoaderCtor;
                    } catch (e) {
                        // 本地不存在则尝试CDN（需要联网）
                        try {
                            const modCdn = await import('https://unpkg.com/three@0.157.0/examples/jsm/loaders/RGBELoader.js');
                            RGBELoaderCtor = modCdn?.RGBELoader || RGBELoaderCtor;
                        } catch (e2) {
                            console.warn('无法动态加载RGBELoader：', e2?.message || e2);
                        }
                    }
                }
                if (RGBELoaderCtor) {
                    const loader = new RGBELoaderCtor();
                    const tex = await loader.loadAsync(url);
                    tex.mapping = THREE.EquirectangularReflectionMapping;
                    // 背景显示
                    this.scene.background = tex;
                    // 环境反射/光照
                    const envMap = pmrem.fromEquirectangular(tex).texture;
                    this.scene.environment = envMap;
                    this._hdrBackgroundTexture = tex;
                    pmrem.dispose();
                    console.log('HDR环境贴图已应用:', url);
                    return true;
                } else {
                    console.warn('未发现或无法加载RGBELoader，HDR加载不可用。请放置RGBELoader.js到/static/libs/jsm/loaders/或使用JPG/PNG背景。');
                    pmrem.dispose();
                    return false;
                }
            } else {
                // 非HDR（JPG/PNG等）：使用TextureLoader作为背景，并生成环境贴图
                const tex = await new THREE.TextureLoader().loadAsync(url);
                tex.mapping = THREE.EquirectangularReflectionMapping;
                this.scene.background = tex;
                const envMap = pmrem.fromEquirectangular(tex).texture;
                this.scene.environment = envMap;
                this._hdrBackgroundTexture = tex;
                pmrem.dispose();
                console.log('LDR背景已应用并用于环境光照:', url);
                return true;
            }
        } catch (e) {
            console.warn('应用HDR环境贴图失败:', e?.message || e);
            return false;
        }
    }

    // 从本地文件设置环境（支持 .hdr、.jpg/.png）
    async setEnvironmentFile(file) {
        if (!this.scene || !this.renderer || !file) return false;
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        pmrem.compileEquirectangularShader();
        const name = (file.name || '').toLowerCase();
        const isHDR = name.endsWith('.hdr');
        try {
            if (isHDR) {
                let RGBELoaderCtor = THREE.RGBELoader;
                if (!RGBELoaderCtor) {
                    try {
                        const modLocal = await import('/static/libs/jsm/loaders/RGBELoader.js');
                        RGBELoaderCtor = modLocal?.RGBELoader || RGBELoaderCtor;
                    } catch (e) {
                        console.warn('无法加载本地RGBELoader模块:', e?.message || e);
                    }
                }
                if (!RGBELoaderCtor) {
                    console.warn('未发现RGBELoader，无法解析HDR文件');
                    pmrem.dispose();
                    return false;
                }
                const buffer = await new Promise((resolve, reject) => {
                    const fr = new FileReader();
                    fr.onload = () => resolve(fr.result);
                    fr.onerror = reject;
                    fr.readAsArrayBuffer(file);
                });
                const loader = new RGBELoaderCtor();
                const tex = loader.parse(buffer);
                tex.mapping = THREE.EquirectangularReflectionMapping;
                this.scene.background = tex;
                const envMap = pmrem.fromEquirectangular(tex).texture;
                this.scene.environment = envMap;
                this._hdrBackgroundTexture = tex;
                pmrem.dispose();
                console.log('HDR文件环境已应用:', name);
                return true;
            } else {
                const objectUrl = URL.createObjectURL(file);
                const tex = await new THREE.TextureLoader().loadAsync(objectUrl);
                URL.revokeObjectURL(objectUrl);
                tex.mapping = THREE.EquirectangularReflectionMapping;
                this.scene.background = tex;
                const envMap = pmrem.fromEquirectangular(tex).texture;
                this.scene.environment = envMap;
                this._hdrBackgroundTexture = tex;
                pmrem.dispose();
                console.log('LDR文件背景已应用并用于环境光照:', name);
                return true;
            }
        } catch (e) {
            console.warn('从文件应用环境失败:', e?.message || e);
            pmrem.dispose();
            return false;
        }
    }

    // 直接设置环境贴图（传入预加载的纹理）
    setEnvironmentTexture(texture) {
        if (!this.scene || !this.renderer || !texture) return false;
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        const envMap = pmrem.fromEquirectangular(texture).texture;
        this.scene.environment = envMap;
        pmrem.dispose();
        return true;
    }
    
    // 加载VRM模型
    async loadModel(modelPath) {
        if (!this.isInitialized) {
            console.error('VRM管理器未初始化');
            return null;
        }
        
        try {
            // 清理当前模型
            this.clearCurrentModel();
            
            // 记录模型路径信息
            this.modelUrl = modelPath;
            this.modelName = modelPath.split('/').pop().replace('.vrm', '');
            this.modelRootPath = modelPath.substring(0, modelPath.lastIndexOf('/') + 1);
            
            // 创建VRM/GLTF加载器（优先使用 ESM v3 模块）
            const GLTFLoaderCtor = (window.GLTFLoaderModule) || (window.GLTFLoader) || (window.THREE && window.THREE.GLTFLoader);
            const VRMLoaderPluginCtor = (window.VRMLoaderPluginModule) || (window.VRMLoaderPlugin) || (window.THREE && window.THREE.VRMLoaderPlugin) || (window.THREE && window.THREE.VRM && window.THREE.VRM.VRMLoaderPlugin);
            const hasGLTFLoader = !!GLTFLoaderCtor;
            const hasVRMPlugin = !!VRMLoaderPluginCtor;

            if (!hasGLTFLoader) {
                console.error('未找到GLTFLoader，无法加载模型');
                throw new Error('GLTF加载器缺失');
            }

            const loader = new GLTFLoaderCtor();
            console.log('GLTFLoader 选择来源:',
                window.GLTFLoaderModule ? 'ESM(importmap)' : (window.GLTFLoader ? 'UMD(window.GLTFLoader)' : 'THREE.GLTFLoader'));
            console.log('VRMLoaderPlugin 选择来源:',
                window.VRMLoaderPluginModule ? 'ESM(importmap)' : (window.VRMLoaderPlugin ? 'UMD(window.VRMLoaderPlugin)' : 'THREE.VRMLoaderPlugin/THREE.VRM.VRMLoaderPlugin'));

            // 尝试添加VRM插件；若缺失则以GLTF场景回退
            if (hasVRMPlugin && typeof loader.register === 'function') {
                loader.register((parser) => new VRMLoaderPluginCtor(parser));
            } else if (!hasVRMPlugin) {
                console.warn('未找到VRMLoaderPlugin，已回退为GLTF场景显示（部分VRM功能不可用）');
            } else {
                console.warn('GLTFLoader缺少register方法，跳过VRM插件注册（可能为简化或占位实现）');
            }
            
            // 加载模型
            const gltf = await new Promise((resolve, reject) => {
                loader.load(
                    modelPath,
                    (gltf) => resolve(gltf),
                    (progress) => {
                        if (this.onStatusUpdate) {
                            this.onStatusUpdate({
                                type: 'loading',
                                progress: (progress.loaded / progress.total) * 100
                            });
                        }
                    },
                    (error) => reject(error)
                );
            });
            
            // 获取VRM模型（可能不存在，需做GLTF回退）
            let vrm = gltf && gltf.userData ? gltf.userData.vrm : null;
            // 兼容回退：若插件未注入 userData.vrm，但存在 UMD THREE_VRM 且提供 VRM.from，则尝试手动构建
            if (!vrm && window.THREE_VRM && window.THREE_VRM.VRM && typeof window.THREE_VRM.VRM.from === 'function') {
                try {
                    const alt = await window.THREE_VRM.VRM.from(gltf);
                    if (alt) {
                        vrm = alt;
                        console.log('通过 UMD THREE_VRM.VRM.from 手动构建 VRM 实例');
                    }
                } catch (e) {
                    console.warn('UMD VRM.from 回退构建失败:', e);
                }
            }

            if (!vrm) {
                console.warn('VRM数据不存在，使用GLTF场景回退显示');
                // 使用GLTF场景作为占位显示
                const sceneNode = gltf.scene;
                if (!sceneNode) {
                    throw new Error('GLTF场景缺失');
                }

                this.currentModel = { scene: sceneNode, update: () => {}, humanoid: null };
                this.scene.add(sceneNode);
                // 默认更合适的展示大小与位置（更靠下并稍微缩小）
                sceneNode.position.set(0, -1.4, 0);
                sceneNode.scale.set(0.7, 0.7, 0.7);
                sceneNode.visible = true;

                console.log('GLTF场景已添加到场景（VRM回退），位置:', sceneNode.position, '缩放:', sceneNode.scale);
                console.log('场景中的对象数量:', this.scene.children.length);

                // GLTF动画支持（若存在动画片段）
                if (gltf.animations && gltf.animations.length) {
                    this.mixer = new THREE.AnimationMixer(sceneNode);
                    const action = this.mixer.clipAction(gltf.animations[0]);
                    action.play();
                }

                // 仅设置代理接口，跳过VRM特性
                this.setupAgentInterface();

                if (this.onModelLoaded) {
                    this.onModelLoaded(this.currentModel);
                }

                return this.currentModel;
            }

            console.log('VRM模型加载成功:', vrm);

            // 设置当前模型
            this.currentModel = vrm;

            // 添加到场景
            this.scene.add(vrm.scene);
            // LookAt目标设置，让角色看向摄像机
            if (vrm.lookAt && this.camera) {
                try { vrm.lookAt.target = this.camera; } catch (_) {}
            }

            // 设置模型位置和缩放（更合适的默认展示）
            vrm.scene.position.set(0, -1.4, 0);
            vrm.scene.scale.set(0.7, 0.7, 0.7);

            // 确保模型可见
            vrm.scene.visible = true;
            // 保存根节点的初始位置和缩放，用于动画期间的安全检查
            try {
                this.originalRootPosition = vrm.scene.position.clone();
                this.originalRootScale = vrm.scene.scale.clone();
                // 允许正常的矩阵更新（骨骼动画需要），但我们会在渲染循环中监控根节点位置
                vrm.scene.matrixAutoUpdate = true;
            } catch (_) {}
            // 防止动画期间的视锥裁剪导致模型被裁掉
            // 注意：不再强制修改材质透明度/不透明度，以免破坏眼睛、睫毛等半透明渲染
            try {
                vrm.scene.traverse(obj => {
                    if (obj && (obj.isMesh || obj.isSkinnedMesh)) {
                        obj.frustumCulled = false;
                        try { obj.updateMatrixWorld(true); } catch (_) {}
                    }
                });
            } catch (_) {}

            console.log('VRM模型已添加到场景，位置:', vrm.scene.position, '缩放:', vrm.scene.scale);
            console.log('场景中的对象数量:', this.scene.children.length);

            // 启用VRM物理系统（SpringBone）
            if (vrm.springBoneManager) {
                console.log('启用VRM物理系统');
                
                // 检查SpringBone管理器的API版本
                if (typeof vrm.springBoneManager.setGravity === 'function') {
                    // 新版本API
                    vrm.springBoneManager.setGravity(new THREE.Vector3(0, -9.8, 0));
                } else if (vrm.springBoneManager.gravity) {
                    // 旧版本API
                    vrm.springBoneManager.gravity.set(0, -9.8, 0);
                }
                
                // 遍历所有SpringBone节点，优化物理参数
                const joints = vrm.springBoneManager.joints || vrm.springBoneManager.springBoneGroupList || [];
                
                if (Array.isArray(joints)) {
                    joints.forEach(joint => {
                        if (joint.settings) {
                            // 增加阻尼以减少过度摆动
                            joint.settings.dragForce = Math.max(joint.settings.dragForce || 0.4, 0.4);
                            // 设置合适的刚性
                            joint.settings.stiffness = Math.min(joint.settings.stiffness || 1.0, 1.0);
                            // 设置重力影响
                            joint.settings.gravityPower = Math.max(joint.settings.gravityPower || 0.2, 0.2);
                        }
                    });
                }
                
                console.log('SpringBone物理参数已优化');
            } else {
                console.warn('VRM模型不包含SpringBone系统');
            }
            
            // 设置自然的待机姿态（修复T-pose）
            if (vrm) this.setNaturalPose(vrm);
            
            // 创建动画混合器
            this.mixer = new THREE.AnimationMixer(vrm.scene);

            // 添加默认动作（仅VRM可用）
            if (vrm) this.setupDefaultAnimations(vrm);

            // 关闭专业动作库（AnimationClip）自动加载
            // 应用户需求，前端不再从 manifest 载入动作库，避免无效按钮与误导。
            this.animationLibrary = {};
            this.actionClipMap = {};
            
            // 初始化表情系统（仅VRM可用）
            if (vrm) this.initExpressions();
            
            // 设置Agent控制接口
            this.setupAgentInterface();
            
            // 调用加载完成回调
            if (this.onModelLoaded) {
                this.onModelLoaded(vrm);
            }
            
            return vrm;
        } catch (error) {
            console.error('加载VRM模型失败:', error);
            
            if (this.onStatusUpdate) {
                this.onStatusUpdate({
                    type: 'error',
                    message: `加载模型失败: ${error.message}`
                });
            }
            
            return null;
        }
    }
    
    // 设置自然的待机姿态
    setNaturalPose(vrm) {
        if (!vrm.humanoid) return;
        
        const humanoid = vrm.humanoid;
        
        try {
            // 设置手臂自然下垂 - 大幅度调整以消除十字姿势
            const leftUpperArm = humanoid.getNormalizedBoneNode('leftUpperArm');
            const rightUpperArm = humanoid.getNormalizedBoneNode('rightUpperArm');
            const leftLowerArm = humanoid.getNormalizedBoneNode('leftLowerArm');
            const rightLowerArm = humanoid.getNormalizedBoneNode('rightLowerArm');
            
            if (leftUpperArm) {
                // 左臂大幅度向下旋转，消除水平伸展
                leftUpperArm.rotation.set(0, 0, -1.2); // 左臂向下约70度
                leftUpperArm.rotation.x = 0.1; // 稍微向前
            }
            if (rightUpperArm) {
                // 右臂大幅度向下旋转，消除水平伸展
                rightUpperArm.rotation.set(0, 0, 1.2); // 右臂向下约70度
                rightUpperArm.rotation.x = 0.1; // 稍微向前
            }
            if (leftLowerArm) {
                leftLowerArm.rotation.set(0, 0, -0.3); // 左前臂自然弯曲
            }
            if (rightLowerArm) {
                rightLowerArm.rotation.set(0, 0, 0.3); // 右前臂自然弯曲
            }
            
            // 设置手部自然姿态
            const leftHand = humanoid.getNormalizedBoneNode('leftHand');
            const rightHand = humanoid.getNormalizedBoneNode('rightHand');
            
            if (leftHand) {
                leftHand.rotation.set(0.1, 0, 0); // 手腕自然向下
            }
            if (rightHand) {
                rightHand.rotation.set(0.1, 0, 0); // 手腕自然向下
            }
            
            // 设置肩膀自然姿态
            const leftShoulder = humanoid.getNormalizedBoneNode('leftShoulder');
            const rightShoulder = humanoid.getNormalizedBoneNode('rightShoulder');
            
            if (leftShoulder) {
                leftShoulder.rotation.set(0, 0, -0.1); // 左肩稍微下沉
            }
            if (rightShoulder) {
                rightShoulder.rotation.set(0, 0, 0.1); // 右肩稍微下沉
            }
            
            // 设置脊椎自然姿态
            const spine = humanoid.getNormalizedBoneNode('spine');
            if (spine) {
                spine.rotation.set(0.05, 0, 0); // 脊椎轻微前倾
            }
            
            // 设置头部自然姿态
            const head = humanoid.getNormalizedBoneNode('head');
            if (head) {
                head.rotation.set(0.05, 0, 0); // 头部轻微向前
            }
            
            console.log('已设置自然待机姿态 - 手臂下垂');
        } catch (error) {
            console.warn('设置自然姿态时出错:', error);
        }
    }

    // 设置默认动画
    setupDefaultAnimations(vrm) {
        console.log('设置VRM默认动画系统');
        
        // 停止所有现有动画
        this.stopAllAnimations();
        
        // 添加基于VRM骨骼的自然呼吸动画
        this.addVRMBreathingAnimation();
        
        // 添加眨眼动画
        this.addBlinkAnimation();
        
        // 添加轻微的待机姿态调整
        this.addIdlePostureAnimation();
    }

    // 加载动画库清单，并预载AnimationClip
    async loadAnimationLibrary(manifestUrl) {
        console.log('加载动画库清单:', manifestUrl);
        try {
            const res = await fetch(manifestUrl, { cache: 'no-cache' });
            if (!res.ok) throw new Error(`获取动画清单失败: ${res.status}`);
            const manifest = await res.json();
            if (!manifest || !Array.isArray(manifest.animations)) {
                throw new Error('动画清单格式不正确');
            }

            // 保存动作映射
            this.actionClipMap = manifest.actionMap || {};

            // 使用GLTFLoader预载动画clips（优先 ESM，再回退到全局 THREE/window）
            const LoaderClass = window.GLTFLoaderModule || window.GLTFLoader || (window.THREE && window.THREE.GLTFLoader);
            if (!LoaderClass) throw new Error('GLTFLoader 未就绪');
            const loader = new LoaderClass();
            for (const item of manifest.animations) {
                const { name, file, defaultSpeed = 1.0 } = item;
                if (!name || !file) continue;

                // 先做存在性检查，避免产生 404 噪音；不在则尝试回退路径
                let candidateUrl = file;
                let exists = false;
                try {
                    const h = await fetch(candidateUrl, { method: 'HEAD' });
                    exists = !!h && h.ok;
                } catch (_) { exists = false; }
                if (!exists) {
                    // 尝试将 converted 路径回退到 newfbx 目录（使用相同文件名）
                    if (candidateUrl.includes('/static/animations/converted/')) {
                        const base = candidateUrl.split('/').pop();
                        const fallback = `/static/animations/newfbx/${base}`;
                        try {
                            const h2 = await fetch(fallback, { method: 'HEAD' });
                            if (h2 && h2.ok) {
                                candidateUrl = fallback;
                                exists = true;
                                console.log(`动画文件使用回退路径: ${name} -> ${candidateUrl}`);
                            }
                        } catch (_) {}
                    }
                }
                if (!exists) {
                    console.warn(`动画文件不存在，跳过预载: ${name} -> ${file}`);
                    // 回退：仍登记到动画库以便填充按钮并走程序化动画
                    if (!this.animationLibrary[name]) {
                        this.animationLibrary[name] = { clips: [], meta: item };
                    }
                    continue;
                }
                await new Promise((resolve) => {
                    try {
                        loader.load(
                            candidateUrl,
                            (gltf) => {
                                const clips = gltf && gltf.animations ? gltf.animations : [];
                                if (clips.length > 0) {
                                    let processedClips = clips;
                                    const isVRMA = (item.type && String(item.type).toLowerCase() === 'vrma') || String(candidateUrl).toLowerCase().endsWith('.vrma');
                                    if (isVRMA) {
                                        console.warn('检测到VRMA文件，当前库未内置解析器，需外部支持或离线重定向');
                                        // 保持原始clips以便后续回退；当引入VRMA支持库后可在此处进行转换
                                    }

                                    this.animationLibrary[name] = { clips: processedClips, meta: item };
                                    console.log(`动画clip加载成功: ${name}, 片段数:`, clips.length);
                                    // 不再在此预创建 Action；让 playClip 基于最新（可能已重定向）的 clip 创建 Action
                                } else {
                                    const isVRMA = String(candidateUrl).toLowerCase().endsWith('.vrma');
                                    if (isVRMA) {
                                        console.warn(`VRMA文件未解析为clips: ${candidateUrl}。请引入支持库或提供已重定向的GLB`);
                                    } else {
                                        console.warn(`动画文件不包含clips: ${candidateUrl}`);
                                    }
                                    // 回退：仍然登记到动画库以便填充按钮并走程序化动画
                                    if (!this.animationLibrary[name]) {
                                        this.animationLibrary[name] = { clips: [], meta: item };
                                    }
                                }
                                resolve(true);
                            },
                            undefined,
                            (err) => {
                                console.warn(`动画文件加载失败: ${candidateUrl}`, err);
                                // 回退：仍然登记到动画库以便填充按钮并走程序化动画
                                if (!this.animationLibrary[name]) {
                                    this.animationLibrary[name] = { clips: [], meta: item };
                                }
                                resolve(false);
                            }
                        );
                    } catch (e) {
                        console.warn('动画加载异常:', e);
                        // 回退：仍然登记到动画库以便填充按钮并走程序化动画
                        if (!this.animationLibrary[name]) {
                            this.animationLibrary[name] = { clips: [], meta: item };
                        }
                        resolve(false);
                    }
                });
            }

            console.log('动画库加载完成，已载入clips:', Object.keys(this.animationLibrary));
        } catch (error) {
            console.warn('加载动画库失败:', error);
            throw error;
        }
    }

    // 根据语义动作映射到动画clip名称
    mapActionToClip(action) {
        if (this.actionClipMap && this.actionClipMap[action]) return this.actionClipMap[action];
        // 默认映射（回退）
        const defaultMap = {
            wave: 'gesture_wave_soft',
            nod: 'nod_small',
            shake: 'shake_small',
            bow: 'bow_gentle'
        };
        return defaultMap[action];
    }

    // 播放指定动画clip
    playClip(name, options = {}) {
        if (!this.mixer || !this.currentModel) {
            console.warn('mixer或模型未就绪，无法播放clip');
            return false;
        }

        const { 
            fadeIn = 0.3, 
            fadeOut = 0.3, 
            loop = false, 
            weight = 1.0, 
            speed = 1.0, 
            duration = null, 
            retargetToVRM = false,
            includeLowerBody = true,
            allowHipsRotation = true,
            clampHipsRotationDeg = 35,
            pauseIdle = true,
            correction = null  // 'mixamo' 或其他校正预设
        } = options;
        const libraryItem = this.animationLibrary[name];
        let baseClip = libraryItem && libraryItem.clips ? libraryItem.clips[0] : null;
        if (!baseClip) {
            console.warn(`未找到clip: ${name}`);
            return false;
        }

        // 可选：将外部骨架的clip重定向到当前VRM骨骼命名（避免对已重定向clip重复重定向）
        const isVRMRetargeted = this._isClipVRMRetargeted(baseClip);
        if (retargetToVRM && !isVRMRetargeted) {
            try {
                // 传入重定向选项
                this.retargetOptions = { includeLowerBody, allowHipsRotation, clampHipsRotationDeg };
                const retargeted = this._retargetClipToVRMBones(baseClip);
                if (retargeted) {
                    baseClip = retargeted;
                    console.log(`Clip已重定向到VRM骨骼: ${name}`);
                } else {
                    console.warn('未生成重定向clip，继续使用原clip');
                }
            } catch (e) {
                console.warn('重定向clip失败，使用原clip', e);
            }
        }

        // 始终基于当前选择的 clip 派生 Action，避免复用旧的未重定向版本
        // 如果之前存在同名的缓存 Action，则先停止并用新的替换
        let action;
        try {
            const stale = this.clipActions[name];
            if (stale && stale !== this.currentClipAction) {
                try { stale.stop(); } catch (_) {}
            }
        } catch (_) {}
        action = this.mixer.clipAction(baseClip);
        action.clampWhenFinished = true;
        this.clipActions[name] = action;

        try {
            action.reset();
            action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 0);
            action.enabled = true;
            action.setEffectiveWeight(weight);
            action.setEffectiveTimeScale(speed);

            if (this.currentClipAction && this.currentClipAction !== action) {
                // 交叉淡入
                try { this.currentClipAction.crossFadeTo(action, fadeIn, false); } catch (_) {}
            }

            // 播放前暂停待机/呼吸以避免覆盖动画
            if (pauseIdle) {
                try { this.pauseDefaultIdleAnimations(); } catch (_) {}
            }
            // 调试：在播放前输出绑定统计，帮助定位不生效的原因
            try {
                const bindOk = this._debugClipBinding(baseClip);
                if (bindOk && bindOk.boundCount === 0) {
                    console.warn('警告：重定向后的clip没有成功绑定任何轨道到VRM骨骼。尝试启用手动动画回退。', bindOk);
                    // 使用手动动画驱动作为回退方案
                    const autoCorr = correction || this._detectClipCorrectionPreset(libraryItem && libraryItem.meta);
                    const manualOk = this._playClipManual(baseClip, { loop, speed, fadeIn, fadeOut, duration, weight, pauseIdle, correction: autoCorr });
                    return !!manualOk;
                } else if (bindOk) {
                    console.log('clip绑定统计:', bindOk);
                }
            } catch (_) {}

            action.play();
            this.currentClipAction = action;

            if (!loop) {
                const stopAfter = duration ? duration : baseClip.duration / speed + fadeOut;
                setTimeout(() => {
                    try {
                        action.fadeOut(fadeOut);
                        action.stop();
                    } catch (_) {}
                    if (this.currentClipAction === action) {
                        this.currentClipAction = null;
                    }
                    // 播放结束后恢复待机/呼吸
                    if (pauseIdle) {
                        try { this.resumeDefaultIdleAnimations(); } catch (_) {}
                    }
                }, Math.max(0, stopAfter * 1000));
            }
            return true;
        } catch (e) {
            console.warn('播放clip异常，回退到程序化动作:', e);
            return false;
        }
    }

    // 判断一个clip是否已经重定向到VRM骨骼（所有track的目标节点以J_Bip_开头）
    _isClipVRMRetargeted(clip) {
        if (!clip || !Array.isArray(clip.tracks)) return false;
        if (clip.tracks.length === 0) return false;
        try {
            return clip.tracks.every(t => (t && typeof t.name === 'string' && t.name.split('.')[0].startsWith('J_Bip_')));
        } catch (_) {
            return false;
        }
    }

    // 动态导入外部GLB动画到动作库
    async importAnimationClip(name, url, { defaultSpeed = 1.0 } = {}) {
        if (!name || !url) {
            console.warn('导入动画失败：需要名称与URL');
            return false;
        }
        try {
            const LoaderClass = window.GLTFLoader || (window.THREE && window.THREE.GLTFLoader);
            if (!LoaderClass) {
                console.error('GLTFLoader 未加载，无法导入GLB动画');
                return false;
            }
            const loader = new LoaderClass();
            const gltf = await new Promise((resolve, reject) => {
                loader.load(url, resolve, undefined, reject);
            });
            const clips = (gltf && gltf.animations) ? gltf.animations : [];
            if (!clips.length) {
                console.warn('GLB中未发现动画剪辑');
                return false;
            }
            let baseClip = clips[0];
            try {
                // 导入时默认包含下半身，并允许适度髋骨旋转
                this.retargetOptions = { includeLowerBody: true, allowHipsRotation: true, clampHipsRotationDeg: 35 };
                const retargeted = this._retargetClipToVRMBones(baseClip);
                if (retargeted) {
                    baseClip = retargeted;
                    console.log(`导入clip已重定向到VRM骨骼: ${name}`);
                }
            } catch (_) {}
            if (!this.animationLibrary) this.animationLibrary = {};
            this.animationLibrary[name] = { clips: [baseClip], meta: { file: url, defaultSpeed } };
            if (!this.mixer) {
                const root = this.currentModel?.scene || this.scene;
                this.mixer = new THREE.AnimationMixer(root);
            }
            const action = this.mixer.clipAction(baseClip);
            action.clampWhenFinished = true;
            action.setEffectiveTimeScale(defaultSpeed);
            action.setEffectiveWeight(0);
            this.clipActions[name] = action;
            console.log(`已导入动画: ${name} <- ${url}`);
            return true;
        } catch (err) {
            console.error('导入GLB动画失败:', err);
            return false;
        }
    }

    // 导入并注册 VRMA 动作，随后可用 playClip(name) 播放
    async importVRMA(name, url, { defaultSpeed = 1.0 } = {}) {
        if (!name || !url) {
            console.warn('导入VRMA失败：需要名称与URL/路径');
            return false;
        }
        if (!this.currentModel) {
            console.warn('VRM模型未加载，无法应用VRMA');
            return false;
        }
        try {
            // 优先使用 ESM 版本（与 VRMA 插件 v3 兼容），否则回退到全局
            const LoaderClass = window.GLTFLoaderModule || window.GLTFLoader || (window.THREE && window.THREE.GLTFLoader);
            const PluginClass = window.VRMAnimationLoaderPluginModule || window.VRMAnimationLoaderPlugin;
            if (!LoaderClass) {
                console.error('GLTFLoader 未加载，无法导入VRMA');
                return false;
            }
            if (!PluginClass) {
                console.warn('three-vrm-animation 插件未加载，尝试不注册插件直接解析 VRMA 扩展');
            }
            const loader = new LoaderClass();
            // 注册 VRMA 解析插件
            if (PluginClass && typeof loader.register === 'function') {
                loader.register((parser) => new PluginClass(parser));
            } else if (!PluginClass) {
                // 插件缺失时跳过注册，后续尝试从 glTF JSON 扩展解析
            } else {
                console.warn('GLTFLoader 缺少 register 方法，无法注册 VRMA 插件');
            }

            const gltf = await new Promise((resolve, reject) => {
                loader.load(url, resolve, undefined, reject);
            });

            // 调试：记录 glTF 扩展使用情况，判断是否存在 VRMC_vrm_animation
            try {
                const used = gltf?.parser?.json?.extensionsUsed || [];
                if (Array.isArray(used) && used.length) {
                    console.log('glTF extensionsUsed:', used);
                }
            } catch (_) {}

            // 优先从 userData.vrma 读取；若不存在，兼容一些导出器会放在 userData.vrmAnimations 数组中
            let vrma = (gltf && gltf.userData) ? gltf.userData.vrma : null;
            if (!vrma && Array.isArray(gltf?.userData?.vrmAnimations) && gltf.userData.vrmAnimations.length > 0) {
                vrma = gltf.userData.vrmAnimations[0];
                console.log('[VRMA] 使用 userData.vrmAnimations[0] 作为动作数据');
            }
            // 若插件未注入 userData.vrma，尝试从 glTF JSON 的顶层或每个 animation 的扩展中解析 VRMC_vrm_animation
            if (!vrma) {
                const json = gltf?.parser?.json || {};
                let vrmaExt = json?.extensions?.VRMC_vrm_animation;
                if (!vrmaExt && Array.isArray(json?.animations)) {
                    for (const anim of json.animations) {
                        const ext = anim?.extensions?.VRMC_vrm_animation;
                        if (ext) { vrmaExt = ext; break; }
                    }
                }
                if (vrmaExt && typeof window.createVRMAnimationClip === 'function') {
                    // 若当前模型缺少 humanoid（VRM 插件未加载或模型非 VRM），直接回退到 GLB 动画导入
                    if (!this.currentModel || !this.currentModel.humanoid) {
                        console.warn('当前模型缺少 humanoid，VRMA 无法解析，回退到 GLB 动画导入');
                        return await this.importAnimationClip(name, url, { defaultSpeed });
                    }
                    // Debug: 检查当前 VRM 的 humanoid 与常用骨骼节点可用性
                    try {
                        const hum = this.currentModel?.humanoid;
                        const hasHumanoid = !!hum;
                        console.log('[DEBUG] 当前VRM humanoid 是否存在:', hasHumanoid);
                        const sampleBones = ['hips','spine','chest','neck','head','leftUpperArm','rightUpperArm','leftLowerArm','rightLowerArm','leftHand','rightHand','leftUpperLeg','rightUpperLeg','leftLowerLeg','rightLowerLeg','leftFoot','rightFoot'];
                        const resolved = {};
                        const getter = (typeof hum.getNormalizedBoneNode === 'function') ? hum.getNormalizedBoneNode.bind(hum) : (typeof hum.getBoneNode === 'function') ? hum.getBoneNode.bind(hum) : null;
                        if (hasHumanoid && getter) {
                            for (const b of sampleBones) {
                                const n = getter(b);
                                resolved[b] = !!n && (n.rotation || n.quaternion) ? 'ok' : (n ? 'node_no_rotation' : 'missing');
                            }
                        }
                        console.log('[DEBUG] 骨骼节点解析状态(部分):', resolved);
                    } catch (e) {
                        console.warn('[DEBUG] 骨骼解析状态输出失败:', e);
                    }
                    try {
                        // 在调用 createVRMAnimationClip 前，尽可能过滤掉指向缺失骨骼的曲线，避免读取 undefined.rotation
                        const hum = this.currentModel?.humanoid;
                        const getter = hum && ((typeof hum.getNormalizedBoneNode === 'function') ? hum.getNormalizedBoneNode.bind(hum) : (typeof hum.getBoneNode === 'function') ? hum.getBoneNode.bind(hum) : null);
                        let sanitized = vrmaExt;
                        try {
                            const hasBone = (name) => {
                                if (!name || !getter) return false;
                                try { return !!getter(name); } catch (_) { return false; }
                            };
                            const deepClone = (obj) => {
                                try { return JSON.parse(JSON.stringify(obj)); } catch (_) { return obj; }
                            };
                            sanitized = deepClone(vrmaExt);
                            // 常见字段尝试清理（不同导出器命名可能不同，这里做容错处理）
                            const trackArrays = [];
                            if (Array.isArray(sanitized?.humanoid?.tracks)) trackArrays.push(['humanoid.tracks', sanitized.humanoid.tracks]);
                            if (Array.isArray(sanitized?.humanoidTracks)) trackArrays.push(['humanoidTracks', sanitized.humanoidTracks]);
                            if (Array.isArray(sanitized?.tracks)) trackArrays.push(['tracks', sanitized.tracks]);
                            if (sanitized?.humanoid && Array.isArray(sanitized.humanoid?.curves)) trackArrays.push(['humanoid.curves', sanitized.humanoid.curves]);
                            for (const [label, arr] of trackArrays) {
                                const before = arr.length;
                                const filtered = arr.filter((t) => {
                                    const candidates = [t?.bone, t?.humanoidBone, t?.humanoidBoneName, t?.name, t?.target?.bone];
                                    const boneName = candidates.find((x) => typeof x === 'string');
                                    return hasBone(boneName);
                                });
                                if (label === 'humanoid.tracks') sanitized.humanoid.tracks = filtered;
                                if (label === 'humanoid.curves') sanitized.humanoid.curves = filtered;
                                if (label === 'humanoidTracks') sanitized.humanoidTracks = filtered;
                                if (label === 'tracks') sanitized.tracks = filtered;
                                const after = filtered.length;
                                if (before !== after) {
                                    console.warn(`[VRMA] 过滤缺失骨骼曲线: ${label} ${before} -> ${after}`);
                                }
                            }
                        } catch (sanErr) {
                            console.warn('VRMA 扩展预清理失败（将直接尝试解析）:', sanErr);
                            sanitized = vrmaExt;
                        }
                        // 若扩展内不含有效 humanoidTracks 或 tracks，则直接回退，避免解析库内部引用 undefined
                        const hasTracks = (
                            Array.isArray(sanitized?.humanoidTracks) && sanitized.humanoidTracks.length > 0
                        ) || (
                            Array.isArray(sanitized?.tracks) && sanitized.tracks.length > 0
                        ) || (
                            sanitized?.humanoid && Array.isArray(sanitized.humanoid?.tracks) && sanitized.humanoid.tracks.length > 0
                        ) || (
                            sanitized?.humanoid && Array.isArray(sanitized.humanoid?.curves) && sanitized.humanoid.curves.length > 0
                        );
                        if (!hasTracks) {
                            console.warn('VRMA 扩展不含有效轨迹，回退到 GLB 动画导入');
                            return await this.importAnimationClip(name, url, { defaultSpeed });
                        }
                        // 使用清理后的扩展创建剪辑
                        let clipFromExt = window.createVRMAnimationClip(sanitized, this.currentModel);
                        if (!clipFromExt) throw new Error('从扩展创建剪辑失败');
                        // 统一为当前 THREE 实例的 AnimationClip
                        if (clipFromExt && typeof clipFromExt.toJSON === 'function' && THREE?.AnimationClip?.parse) {
                            const json = clipFromExt.toJSON();
                            clipFromExt = THREE.AnimationClip.parse(json);
                        }
                        if (!this.animationLibrary) this.animationLibrary = {};
                        this.animationLibrary[name] = { clips: [clipFromExt], meta: { file: url, type: 'vrma', defaultSpeed } };
                        if (!this.mixer) {
                            const root = this.currentModel?.scene || this.scene;
                            this.mixer = new THREE.AnimationMixer(root);
                        }
                        const action = this.mixer.clipAction(clipFromExt);
                        action.clampWhenFinished = true;
                        action.setEffectiveTimeScale(defaultSpeed);
                        action.setEffectiveWeight(0);
                        this.clipActions[name] = action;
                        console.log(`已基于 VRMC_vrm_animation 扩展导入VRMA动作: ${name} <- ${url}`);
                        return true;
                    } catch (e) {
                        console.warn('VRMA 扩展解析失败，回退到GLB动画导入：', e);
                        return await this.importAnimationClip(name, url, { defaultSpeed });
                    }
                }
                console.warn('GLTF未包含VRMA数据（可能是普通GLB/GTLF动画），尝试按GLB动画导入：', url);
                // 回退到普通 GLB/GTLF 动画导入流程
                return await this.importAnimationClip(name, url, { defaultSpeed });
            }

            // 基于当前 VRM 创建可播放的 AnimationClip
            let clip = null;
            if (typeof vrma?.createAnimationClip === 'function') {
                // 兼容旧版插件 API
                clip = vrma.createAnimationClip(this.currentModel);
            } else if (typeof window.createVRMAnimationClip === 'function') {
                // three-vrm-animation v3 API
                // Debug: 在 v3 API 调用前输出 humanoid / 骨骼节点状态
                try {
                    const hum = this.currentModel?.humanoid;
                    const hasHumanoid = !!hum;
                    console.log('[DEBUG] (v3) 当前VRM humanoid 是否存在:', hasHumanoid);
                    const sampleBones = ['hips','spine','chest','neck','head','leftUpperArm','rightUpperArm','leftLowerArm','rightLowerArm','leftHand','rightHand','leftUpperLeg','rightUpperLeg','leftLowerLeg','rightLowerLeg','leftFoot','rightFoot'];
                    const resolved = {};
                    const getter = (typeof hum.getNormalizedBoneNode === 'function') ? hum.getNormalizedBoneNode.bind(hum) : (typeof hum.getBoneNode === 'function') ? hum.getBoneNode.bind(hum) : null;
                    if (hasHumanoid && getter) {
                        for (const b of sampleBones) {
                            const n = getter(b);
                            resolved[b] = !!n && (n.rotation || n.quaternion) ? 'ok' : (n ? 'node_no_rotation' : 'missing');
                        }
                    }
                    console.log('[DEBUG] (v3) 骨骼节点解析状态(部分):', resolved);
                } catch (e) {
                    console.warn('[DEBUG] (v3) 骨骼解析状态输出失败:', e);
                }
                clip = window.createVRMAnimationClip(vrma, this.currentModel);
            }
            if (!clip) { console.warn('从VRMA创建AnimationClip失败'); return false; }
            // 统一为当前 THREE 实例的 AnimationClip，避免 ESM 与非模块实例不兼容
            let finalClip = clip;
            try {
                if (clip && typeof clip.toJSON === 'function' && THREE?.AnimationClip?.parse) {
                    const json = clip.toJSON();
                    finalClip = THREE.AnimationClip.parse(json);
                }
            } catch (_) {}
            // 若绑定统计为0，尝试将 Normalized_* 轨道重定向为 J_Bip_* 可绑定路径
            try {
                const bindStat = this._debugClipBinding(finalClip);
                if (bindStat && bindStat.boundCount === 0) {
                    const retargeted = this._retargetClipToVRMBones(finalClip);
                    if (retargeted) {
                        finalClip = retargeted;
                        console.warn('VRMA clip 绑定为0，已将 Normalized_* 轨道重定向为 J_Bip_*');
                    }
                }
            } catch (_) {}

            // 缓存至动画库以复用现有播放管线
            if (!this.animationLibrary) this.animationLibrary = {};
            this.animationLibrary[name] = { clips: [finalClip], meta: { file: url, type: 'vrma', defaultSpeed } };

            // 预创建 Action（权重为0，用于后续平滑播放）
            if (!this.mixer) {
                const root = this.currentModel?.scene || this.scene;
                this.mixer = new THREE.AnimationMixer(root);
            }
            const action = this.mixer.clipAction(finalClip);
            action.clampWhenFinished = true;
            action.setEffectiveTimeScale(defaultSpeed);
            action.setEffectiveWeight(0);
            this.clipActions[name] = action;
            console.log(`已导入VRMA动作: ${name} <- ${url}`);
            return true;
        } catch (err) {
            console.error('导入VRMA动作失败:', err);
            return false;
        }
    }

    // 直接从URL/路径导入并播放 VRMA（一次性）
    async playVRMAUrl(url, { name = 'vrma_import', options = {} } = {}) {
        const ok = await this.importVRMA(name, url, options);
        if (!ok) return false;
        // VRMA已针对VRM，不需要再重定向
        return this.playClip(name, { retargetToVRM: false });
    }

    // 从本地文件导入并播放 VRMA
    async playVRMAFile(file, { name = null, options = {} } = {}) {
        if (!file) { console.warn('未提供VRMA文件'); return false; }
        const url = URL.createObjectURL(file);
        const key = name || (file.name ? file.name.replace(/\.[^.]+$/, '') : 'vrma_file');
        try {
            const res = await this.playVRMAUrl(url, { name: key, options });
            return res;
        } finally {
            setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 5000);
        }
    }

    // 根据常见骨骼别名将动画轨道重定向到VRM骨骼命名（J_Bip_*），并在旋转轨道上做静态姿态补偿
    _retargetClipToVRMBones(srcClip) {
        if (!srcClip || !Array.isArray(srcClip.tracks) || srcClip.tracks.length === 0) return null;
        // 构建VRM骨骼名集合（优先从场景节点中搜集J_Bip_*）
        const vrmNodeNames = new Set();
        try {
            this.currentModel.scene.traverse(obj => {
                if (obj && obj.isBone && obj.name) {
                    vrmNodeNames.add(obj.name);
                }
            });
        } catch (_) {}
        // 记录可能的骨架根名称（例如 VRM 常见的 'Root' 或 'Armature'）
        let armatureRootName = null;
        try {
            const rootObj = this.currentModel.scene.getObjectByName('Root') || this.currentModel.scene.getObjectByName('Armature');
            if (rootObj) armatureRootName = rootObj.name;
        } catch (_) {}

        // 常见别名到VRM骨骼的映射（基于J_Bip_*约定）
        // 为常见别名提供候选列表，优先选择在当前VRM中存在的骨骼
        const map = {
            // 中轴
            'hips': ['J_Bip_C_Hips'],
            'pelvis': ['J_Bip_C_Hips'],
            'spine': ['J_Bip_C_Spine', 'J_Bip_C_Chest', 'J_Bip_C_UpperChest'],
            'spine1': ['J_Bip_C_Chest', 'J_Bip_C_UpperChest'],
            'upperchest': ['J_Bip_C_UpperChest', 'J_Bip_C_Chest'],
            'chest': ['J_Bip_C_Chest', 'J_Bip_C_UpperChest'],
            'neck': ['J_Bip_C_Neck'],
            'head': ['J_Bip_C_Head'],
            // 左臂
            'leftshoulder': ['J_Bip_L_Shoulder'],
            'lshoulder': ['J_Bip_L_Shoulder'],
            'leftarm': ['J_Bip_L_UpperArm'],
            'lupperarm': ['J_Bip_L_UpperArm'],
            'leftforearm': ['J_Bip_L_LowerArm'],
            'llowerarm': ['J_Bip_L_LowerArm'],
            'lefthand': ['J_Bip_L_Hand'],
            'lhand': ['J_Bip_L_Hand'],
            // 右臂
            'rightshoulder': ['J_Bip_R_Shoulder'],
            'rshoulder': ['J_Bip_R_Shoulder'],
            'rightarm': ['J_Bip_R_UpperArm'],
            'rupperarm': ['J_Bip_R_UpperArm'],
            'rightforearm': ['J_Bip_R_LowerArm'],
            'rlowerarm': ['J_Bip_R_LowerArm'],
            'righthand': ['J_Bip_R_Hand'],
            'rhand': ['J_Bip_R_Hand'],
            // 左腿
            'leftupleg': ['J_Bip_L_UpperLeg'],
            'lupperleg': ['J_Bip_L_UpperLeg'],
            'leftleg': ['J_Bip_L_LowerLeg'],
            'llowerleg': ['J_Bip_L_LowerLeg'],
            'leftfoot': ['J_Bip_L_Foot'],
            'lfoot': ['J_Bip_L_Foot'],
            'lefttoe': ['J_Bip_L_ToeBase'],
            'ltoe': ['J_Bip_L_ToeBase'],
            // 右腿
            'rightupleg': ['J_Bip_R_UpperLeg'],
            'rupperleg': ['J_Bip_R_UpperLeg'],
            'rightleg': ['J_Bip_R_LowerLeg'],
            'rlowerleg': ['J_Bip_R_LowerLeg'],
            'rightfoot': ['J_Bip_R_Foot'],
            'rfoot': ['J_Bip_R_Foot'],
            'righttoe': ['J_Bip_R_ToeBase'],
            'rtoe': ['J_Bip_R_ToeBase']
        };

        // 仅保留上半身相关的VRM骨骼作为重定向目标，避免下半身或根运动导致离屏
        const upperBodyWhitelist = new Set([
            'J_Bip_C_Spine', 'J_Bip_C_Chest', 'J_Bip_C_Neck', 'J_Bip_C_Head',
            'J_Bip_L_Shoulder', 'J_Bip_L_UpperArm', 'J_Bip_L_LowerArm', 'J_Bip_L_Hand',
            'J_Bip_R_Shoulder', 'J_Bip_R_UpperArm', 'J_Bip_R_LowerArm', 'J_Bip_R_Hand'
        ]);
        // 若开启包含下半身，扩展白名单
        if (this.retargetOptions?.includeLowerBody) {
            ['J_Bip_C_Hips', 'J_Bip_L_UpperLeg', 'J_Bip_L_LowerLeg', 'J_Bip_L_Foot', 'J_Bip_L_ToeBase',
             'J_Bip_R_UpperLeg', 'J_Bip_R_LowerLeg', 'J_Bip_R_Foot', 'J_Bip_R_ToeBase'].forEach(b => upperBodyWhitelist.add(b));
        }

        let matched = 0;
        const newTracks = srcClip.tracks.map(track => {
            const name = track.name || '';
            const parts = name.split('.'); // [nodePath, property]
            const nodePath = parts[0] || '';
            const property = parts.slice(1).join('.');
            // 去除可能的骨架根前缀（例如 'Root|' 或 'Armature|'）
            const nodePathNoRoot = nodePath.includes('|') ? nodePath.split('|').pop() : nodePath;
            const nodeLower = nodePathNoRoot.toLowerCase();

            let targetNode = null;
            // 直接处理 Normalized_* 前缀：提取基础 J_Bip_* 名称作为候选，无需依赖集合命中
            try {
                if (nodePathNoRoot.startsWith('Normalized_')) {
                    const candidate = nodePathNoRoot.substring('Normalized_'.length);
                    if (candidate) {
                        targetNode = candidate;
                    }
                }
            } catch (_) {}
            // 尝试匹配常见别名关键词
            for (const key in map) {
                if (nodeLower.includes(key)) {
                    const candidates = Array.isArray(map[key]) ? map[key] : [map[key]];
                    for (const cand of candidates) {
                        if (vrmNodeNames.has(cand)) { targetNode = cand; break; }
                    }
                    if (targetNode) break;
                }
            }

            if (targetNode) {
                // 优先选择场景中存在的 Normalized_* 节点；否则退回原始 J_Bip_*
                const rootObj = this.currentModel?.scene || this.scene;
                const normalizedCandidate = `Normalized_${targetNode}`;
                let chosenNode = targetNode;
                try {
                    const hasNormalized = !!(rootObj && typeof rootObj.getObjectByName === 'function' && rootObj.getObjectByName(normalizedCandidate));
                    const hasOriginal = !!(rootObj && typeof rootObj.getObjectByName === 'function' && rootObj.getObjectByName(targetNode));
                    if (hasNormalized) chosenNode = normalizedCandidate; else if (hasOriginal) chosenNode = targetNode; else return null;
                } catch (_) {}

                let ctor = track.constructor;
                const clonedTimes = track.times ? track.times.slice() : [];
                let clonedValues = track.values ? track.values.slice() : [];
                let newProperty = property;
                // 先构造两种可能的绑定路径：不带根 和 带根
                let pathNoRoot = `${chosenNode}.${newProperty}`;
                let pathWithRoot = armatureRootName ? `${armatureRootName}|${chosenNode}.${newProperty}` : pathNoRoot;
                let newName = pathNoRoot;

                // 安全：避免把位移/缩放轨道重定向到VRM骨骼，导致整模离屏或缩放异常
                const propLower = (property || '').toLowerCase();
                if (propLower.includes('position') || propLower.includes('scale')) {
                    return null; // 丢弃位移与缩放轨道
                }
                // 若为Euler旋转（rotation 或 rotation[x/y/z]），将其转换为四元数轨道
                if (propLower.includes('rotation') && !propLower.includes('quaternion')) {
                    try {
                        const euler = new (window.THREE ? window.THREE.Euler : THREE.Euler)();
                        const q = new (window.THREE ? window.THREE.Quaternion : THREE.Quaternion)();
                        const out = new Float32Array((clonedValues.length / 3) * 4);
                        for (let i = 0, j = 0; i + 2 < clonedValues.length; i += 3, j += 4) {
                            euler.set(clonedValues[i], clonedValues[i+1], clonedValues[i+2], 'XYZ');
                            q.setFromEuler(euler).normalize();
                            out[j] = q.x; out[j+1] = q.y; out[j+2] = q.z; out[j+3] = q.w;
                        }
                        clonedValues = Array.from(out);
                        newProperty = 'quaternion';
                        pathNoRoot = `${chosenNode}.quaternion`;
                        pathWithRoot = armatureRootName ? `${armatureRootName}|${chosenNode}.quaternion` : pathNoRoot;
                        newName = pathNoRoot;
                        ctor = window.THREE ? window.THREE.QuaternionKeyframeTrack : THREE.QuaternionKeyframeTrack;
                    } catch (_) {
                        return null; // 转换失败则忽略该轨道
                    }
                }

                // 进一步安全：默认丢弃骨盆(hips)的旋转；若允许则稍后做夹角限制
                const baseName = chosenNode.startsWith('Normalized_') ? chosenNode.substring('Normalized_'.length) : chosenNode;
                const isHipsRotation = (baseName === 'J_Bip_C_Hips' && propLower.includes('quaternion'));
                if (isHipsRotation && !this.retargetOptions?.allowHipsRotation) {
                    return null; // 丢弃骨盆旋转
                }

                // 只保留上半身白名单中的骨骼
                if (!upperBodyWhitelist.has(baseName)) {
                    return null;
                }

                // 对四元数旋转做静态姿态补偿，减少挥手时的扭曲
                try {
                    if (property.includes('quaternion') && this.currentModel?.humanoid) {
                        const humanoid = this.currentModel.humanoid;
                        const nodeObj = this.currentModel.scene.getObjectByName(targetNode);
                        if (nodeObj) {
                            const vrmRest = nodeObj.quaternion.clone();
                            // 源动画第一帧近似视作源静态姿态
                            const q = new (window.THREE ? window.THREE.Quaternion : THREE.Quaternion)();
                            const srcRest = q.clone();
                            if (clonedValues.length >= 4) {
                                srcRest.set(clonedValues[0], clonedValues[1], clonedValues[2], clonedValues[3]).normalize();
                            }
                            // 计算补偿: 将源静态姿态对齐到VRM静态姿态
                            const delta = vrmRest.clone().multiply(srcRest.clone().invert());
                            for (let i = 0; i + 3 < clonedValues.length; i += 4) {
                                const frameQ = new (window.THREE ? window.THREE.Quaternion : THREE.Quaternion)(clonedValues[i], clonedValues[i+1], clonedValues[i+2], clonedValues[i+3]).normalize();
                                let retargeted = delta.clone().multiply(frameQ).normalize();
                                // 如果是髋骨旋转且允许，则对角度进行夹角限制，避免大幅扭转
                                if (isHipsRotation && this.retargetOptions?.allowHipsRotation) {
                                    const maxDeg = this.retargetOptions.clampHipsRotationDeg || 25;
                                    const maxRad = (maxDeg / 180) * Math.PI;
                                    // 计算 retargeted 的轴角
                                    const w = Math.max(-1, Math.min(1, retargeted.w));
                                    let angle = 2 * Math.acos(w);
                                    if (angle > maxRad) {
                                        // 归一化轴
                                        const s = Math.sqrt(1 - w*w);
                                        let ax = retargeted.x, ay = retargeted.y, az = retargeted.z;
                                        if (s > 0.0001) { ax /= s; ay /= s; az /= s; } else {
                                            // 退化情况，选择一个默认轴
                                            ax = 0; ay = 1; az = 0;
                                        }
                                        // 重新构造受限四元数
                                        const half = angle > 0 ? (maxRad / 2) : 0;
                                        const sinHalf = Math.sin(half);
                                        const cosHalf = Math.cos(half);
                                        retargeted.set(ax * sinHalf, ay * sinHalf, az * sinHalf, cosHalf).normalize();
                                    }
                                }
                                // 数值健壮性：若出现NaN/Infinity，回退到原帧，避免破坏骨骼矩阵
                                const isFiniteQuat = Number.isFinite(retargeted.x) && Number.isFinite(retargeted.y) && Number.isFinite(retargeted.z) && Number.isFinite(retargeted.w);
                                if (!isFiniteQuat) {
                                    retargeted = frameQ;
                                }
                                clonedValues[i] = retargeted.x;
                                clonedValues[i+1] = retargeted.y;
                                clonedValues[i+2] = retargeted.z;
                                clonedValues[i+3] = retargeted.w;
                            }
                        }
                    }
                } catch (_) {}

                // 在创建轨道前定位目标对象；优先使用 uuid 形式绑定，提升命中率
                try {
                    const root = this.currentModel?.scene || this.scene;
                    let bindName = newName;
                    try {
                        const nodeOnly = chosenNode;
                        const nodeWithRoot = armatureRootName ? `${armatureRootName}|${chosenNode}` : null;
                        let resolved = THREE.PropertyBinding.findNode(root, nodeOnly);
                        if (!resolved && nodeWithRoot) resolved = THREE.PropertyBinding.findNode(root, nodeWithRoot);
                        if (resolved && resolved.uuid) {
                            bindName = `${resolved.uuid}.${newProperty}`; // 使用 uuid 绑定，避免命名前缀或重复命名问题
                        } else if (nodeWithRoot && THREE.PropertyBinding.findNode(root, nodeWithRoot)) {
                            bindName = pathWithRoot; // 回退：带根名称
                        } else {
                            bindName = pathNoRoot; // 回退：不带根名称
                        }
                    } catch (_) {}
                    const newTrack = new ctor(bindName, clonedTimes, clonedValues);
                    matched++;
                    return newTrack;
                } catch (_) {
                    // 构造失败则返回原轨道
                    return null;
                }
            }
            return null; // 未匹配到VRM骨骼则忽略该源轨道
        });

        const filteredTracks = newTracks.filter(t => !!t);
        if (matched === 0 || filteredTracks.length === 0) return null; // 有效轨道为空则认为重定向失败
        try {
            const retargeted = new THREE.AnimationClip(srcClip.name + '_retarget', srcClip.duration, filteredTracks);
            return retargeted;
        } catch (e) {
            console.warn('创建重定向clip失败', e);
            return null;
        }
    }

    // 调试：统计一个clip的轨道在当前VRM场景中可绑定的数量与详细情况
    _debugClipBinding(clip) {
        try {
            if (!clip || !Array.isArray(clip.tracks)) return null;
            const root = this.currentModel?.scene || this.scene;
            if (!root) return null;
            const res = [];
            let boundCount = 0;
            for (const t of clip.tracks) {
                const name = t?.name || '';
                let ok = false;
                try {
                    const parsed = THREE.PropertyBinding.parseTrackName(name);
                    const nodeName = parsed?.nodeName;
                    const node = THREE.PropertyBinding.findNode(root, nodeName);
                    ok = !!node;
                } catch (_) { ok = false; }
                if (ok) boundCount++;
                res.push({ name, bound: ok, type: t?.ValueTypeName || 'unknown' });
            }
            return { totalTracks: clip.tracks.length, boundCount, details: res.slice(0, 10) /* 限前10条避免刷屏 */ };
        } catch (_) { return null; }
    }

    // 当标准的 PropertyBinding 绑定失败时，使用手动方式驱动骨骼旋转动画
    _playClipManual(clip, { loop = true, speed = 1.0, fadeIn = 0.2, fadeOut = 0.2, duration = null, weight = 1.0, pauseIdle = false, correction = null } = {}) {
        if (!clip || !Array.isArray(clip.tracks) || clip.tracks.length === 0) {
            console.warn('手动动画回退失败：clip为空或无tracks');
            return false;
        }
        if (!this.currentModel || !this.currentModel.scene) {
            console.warn('手动动画回退失败：VRM模型未就绪');
            return false;
        }
        const root = this.currentModel.scene;
        const humanoid = this.currentModel.humanoid || this.currentModel?.vrm?.humanoid || null;

        // 将常见的 VRM/J_Bip_* 骨骼名映射到 humanoid 标准键，便于驱动归一化骨节点
        const mapBipToHumanoid = (name) => {
            if (!name) return null;
            const n = String(name).toLowerCase();
            // 直接匹配 VRM 常见 J_Bip_* 命名
            if (/^j_bip_c_hips$/.test(n)) return 'hips';
            if (/^j_bip_c_spine$/.test(n)) return 'spine';
            if (/^j_bip_c_chest$/.test(n)) return 'chest';
            if (/^j_bip_c_upperchest$/.test(n)) return 'upperChest';
            if (/^j_bip_c_neck$/.test(n)) return 'neck';
            if (/^j_bip_c_head$/.test(n)) return 'head';
            if (/^j_bip_l_shoulder$/.test(n)) return 'leftShoulder';
            if (/^j_bip_l_upperarm$/.test(n)) return 'leftUpperArm';
            if (/^j_bip_l_lowerarm$/.test(n)) return 'leftLowerArm';
            if (/^j_bip_l_hand$/.test(n)) return 'leftHand';
            if (/^j_bip_r_shoulder$/.test(n)) return 'rightShoulder';
            if (/^j_bip_r_upperarm$/.test(n)) return 'rightUpperArm';
            if (/^j_bip_r_lowerarm$/.test(n)) return 'rightLowerArm';
            if (/^j_bip_r_hand$/.test(n)) return 'rightHand';
            if (/^j_bip_l_upperleg$/.test(n)) return 'leftUpperLeg';
            if (/^j_bip_l_lowerleg$/.test(n)) return 'leftLowerLeg';
            if (/^j_bip_l_foot$/.test(n)) return 'leftFoot';
            if (/^j_bip_l_toebase$/.test(n)) return 'leftToes';
            if (/^j_bip_r_upperleg$/.test(n)) return 'rightUpperLeg';
            if (/^j_bip_r_lowerleg$/.test(n)) return 'rightLowerLeg';
            if (/^j_bip_r_foot$/.test(n)) return 'rightFoot';
            if (/^j_bip_r_toebase$/.test(n)) return 'rightToes';
            // 中轴
            if (n.includes('hips')) return 'hips';
            if (n.includes('spine2') || n.includes('upperchest')) return 'upperChest';
            if (n.includes('spine1') || n.includes('chest')) return 'chest';
            if (n.includes('spine')) return 'spine';
            if (n.includes('neck')) return 'neck';
            if (n.includes('head')) return 'head';
            // 左臂
            if (n.includes('leftshoulder')) return 'leftShoulder';
            if (n.includes('leftupperarm')) return 'leftUpperArm';
            if (n.includes('leftarm')) return 'leftUpperArm';
            if (n.includes('leftforearm') || n.includes('leftlowerarm')) return 'leftLowerArm';
            if (n.includes('lefthand')) return 'leftHand';
            // 右臂
            if (n.includes('rightshoulder')) return 'rightShoulder';
            if (n.includes('rightupperarm')) return 'rightUpperArm';
            if (n.includes('rightarm')) return 'rightUpperArm';
            if (n.includes('rightforearm') || n.includes('rightlowerarm')) return 'rightLowerArm';
            if (n.includes('righthand')) return 'rightHand';
            // 左腿
            if (n.includes('leftupleg') || n.includes('leftupperleg')) return 'leftUpperLeg';
            if (n.includes('leftleg') || n.includes('leftlowerleg')) return 'leftLowerLeg';
            if (n.includes('leftfoot')) return 'leftFoot';
            if (n.includes('lefttoes') || n.includes('lefttoebase')) return 'leftToes';
            // 右腿
            if (n.includes('rightupleg') || n.includes('rightupperleg')) return 'rightUpperLeg';
            if (n.includes('rightleg') || n.includes('rightlowerleg')) return 'rightLowerLeg';
            if (n.includes('rightfoot')) return 'rightFoot';
            if (n.includes('righttoes') || n.includes('righttoebase')) return 'rightToes';
            return null;
        };

        // 预解析所有四元数轨道，映射到具体骨骼与关键帧数据（优先驱动归一化骨节点）
        const manualRotTracks = [];
        const manualPosTracks = [];
        for (const tr of clip.tracks) {
            if (!tr || !tr.name) continue;
            const isQuat = (tr.ValueTypeName === 'quaternion') || (tr instanceof THREE.QuaternionKeyframeTrack);
            const isPos = (tr.ValueTypeName === 'vector') || (tr instanceof THREE.VectorKeyframeTrack);
            if (!isQuat && !isPos) continue;

            // 解析轨道名以获取节点：兼容 uuid 或带前缀的路径
            let parsed = null;
            try { parsed = THREE.PropertyBinding.parseTrackName(tr.name); } catch (_) { parsed = null; }
            const nodeName = parsed?.nodeName || null;
            let bone = null;
            if (nodeName) {
                try { bone = THREE.PropertyBinding.findNode(root, nodeName) || null; } catch (_) { bone = null; }
            }

            // 从解析到的对象获取真实名称，再映射到 humanoid 键
            const boneName = bone?.name || null;
            const key = mapBipToHumanoid(boneName);
            // 首选使用 humanoid 的归一化骨节点（VRM 推荐）
            if (humanoid && key && typeof humanoid.getNormalizedBoneNode === 'function') {
                try { bone = humanoid.getNormalizedBoneNode(key) || null; } catch (_) { bone = null; }
            }
            // 若未命中归一化骨，则回退到场景中的同名骨
            if (!bone) {
                bone = boneName ? root.getObjectByName(boneName) : null;
            }
            if (!bone) {
                const arm = root.getObjectByName('Armature');
                const rt = root.getObjectByName('Root');
                bone = boneName ? ((arm && arm.getObjectByName(boneName)) || (rt && rt.getObjectByName(boneName)) || null) : null;
            }
            if (!bone) continue;
            if (isQuat) {
                // 记录骨骼静止姿态与首帧旋转，后续按“相对首帧增量”应用以匹配坐标系差异
                const restQ = bone.quaternion.clone();
                const q0 = new THREE.Quaternion();
                try {
                    q0.set(tr.values[0] || 0, tr.values[1] || 0, tr.values[2] || 0, tr.values[3] || 1).normalize();
                } catch (_) { q0.copy(restQ); }
                const q0Inv = q0.clone().invert();
                manualRotTracks.push({ bone, times: tr.times, values: tr.values, rest: restQ, q0Inv });
            } else if (isPos && key === 'hips') {
                // 仅支持髋部Y位移，用于坐下效果；记录首帧与静止位置
                const restP = bone.position.clone();
                const p0 = new THREE.Vector3(
                    tr.values[0] || 0,
                    tr.values[1] || 0,
                    tr.values[2] || 0
                );
                manualPosTracks.push({ bone, times: tr.times, values: tr.values, restP, p0 });
            }
        }

        if (manualRotTracks.length === 0 && manualPosTracks.length === 0) {
            console.warn('手动动画回退失败：没有可解析的旋转轨');
            return false;
        }

        const clipDuration = duration ?? clip.duration ?? (manualRotTracks.concat(manualPosTracks).reduce((m, t) => Math.max(m, t.times[t.times.length - 1] || 0), 0) || 0);
        if (pauseIdle) this.pauseDefaultIdleAnimations();

        // 调试：统计归一化骨节点占比并输出示例骨骼
        try {
            const totalTracks = manualRotTracks.length + manualPosTracks.length;
            const normalizedCount = manualRotTracks.reduce((c, mt) => c + ((mt.bone && mt.bone.name && mt.bone.name.startsWith('Normalized_')) ? 1 : 0), 0);
            const sampleBones = manualRotTracks.slice(0, 10).map(mt => mt.bone?.name);
            console.log(`手动动画解析：${totalTracks} 轨，归一化骨节点 ${normalizedCount} 条`);
            console.log('手动动画示例骨骼(前10)：', sampleBones);
        } catch (_) {}

        this._manualAnim = {
            rotTracks: manualRotTracks,
            posTracks: manualPosTracks,
            time: 0,
            speed: speed,
            loop: loop,
            duration: clipDuration,
            weight: weight,
            fadeInRemaining: fadeIn || 0,
            fadeOutDur: fadeOut || 0,
            ending: false,
            hipsYScale: 2.0,  // 增强坐下效果
            hipsYClamp: 0.5,  // 允许更大的Y轴位移
            correction: correction  // 坐标系校正类型
        };

        console.log(`已启用手动动画回退：${manualRotTracks.length} 条旋转轨，时长 ${clipDuration.toFixed(2)}s`);
        return true;
    }

    _updateManualAnimation(delta) {
        const st = this._manualAnim;
        if (!st) return;

        st.time += delta * (st.speed || 1);
        if (st.loop) {
            const dur = st.duration > 0 ? st.duration : 0.0001;
            st.time = st.time % dur;
        } else if (st.time >= st.duration) {
            st.ending = true;
            if (st.fadeOutDur > 0) {
                st.fadeOutDur -= delta;
                if (st.fadeOutDur <= 0) {
                    this._manualAnim = null;
                    this.resumeDefaultIdleAnimations();
                    return;
                }
            } else {
                this._manualAnim = null;
                this.resumeDefaultIdleAnimations();
                return;
            }
        }

        const tmpQ1 = new THREE.Quaternion();
        const tmpQ2 = new THREE.Quaternion();
        const qOrig = new THREE.Quaternion();
        const qDelta = new THREE.Quaternion();
        const ident = new THREE.Quaternion();

        // 旋转轨处理
        for (const mt of (st.rotTracks || [])) {
            const times = mt.times;
            const values = mt.values;
            if (!times || !values || times.length === 0) continue;

            const t = st.time;
            let i = 0;
            while (i < times.length && times[i] <= t) i++;
            const idx1 = Math.max(0, i - 1);
            const idx2 = Math.min(times.length - 1, i);
            const t1 = times[idx1];
            const t2 = times[idx2];
            const alpha = (t2 > t1) ? (t - t1) / (t2 - t1) : 0;

            const base1 = idx1 * 4;
            const base2 = idx2 * 4;
            tmpQ1.set(values[base1 + 0], values[base1 + 1], values[base1 + 2], values[base1 + 3]).normalize();
            tmpQ2.set(values[base2 + 0], values[base2 + 1], values[base2 + 2], values[base2 + 3]).normalize();

            // 原始插值结果（源空间）
            qOrig.copy(tmpQ1).slerp(tmpQ2, alpha);

            // 先获取骨骼名，供校正与约束使用
            const boneName = mt.bone?.name || '';

            // 应用坐标系校正（如果指定）
            if (st.correction === 'mixamo') {
                this._applyMixamoCorrection(qOrig, boneName);
            }

            // 计算相对首帧的增量：qDelta = q0Inv * qOrig
            qDelta.copy(mt.q0Inv).multiply(qOrig).normalize();
            
            // 对特定骨骼应用约束以避免不自然的动作
            const boneLower = boneName.toLowerCase();
            let constrainedWeight = Math.min(1, Math.max(0, st.weight || 1));
            
            // 对脊椎和颈部应用更温和的旋转
            if (boneLower.includes('spine') || boneLower.includes('neck')) {
                constrainedWeight *= 0.7; // 减少脊椎和颈部的旋转幅度
            }
            
            // 对肩膀应用约束，避免过度旋转
            if (boneLower.includes('shoulder')) {
                constrainedWeight *= 0.8;
            }
            
            // 权重：在单位增量与增量之间插值
            const qDeltaW = ident.clone().slerp(qDelta, constrainedWeight);
            // 应用到骨骼静止姿态：final = rest * qDeltaW
            mt.bone.quaternion.copy(mt.rest).multiply(qDeltaW).normalize();
        }

        // 髋部位置Y处理（坐下效果）
        if (st.posTracks && st.posTracks.length) {
            const tmpV1 = new THREE.Vector3();
            const tmpV2 = new THREE.Vector3();
            for (const pt of st.posTracks) {
                const times = pt.times;
                const values = pt.values;
                if (!times || !values || times.length === 0) continue;

                const t = st.time;
                let i = 0;
                while (i < times.length && times[i] <= t) i++;
                const idx1 = Math.max(0, i - 1);
                const idx2 = Math.min(times.length - 1, i);
                const t1 = times[idx1];
                const t2 = times[idx2];
                const alpha = (t2 > t1) ? (t - t1) / (t2 - t1) : 0;

                const base1 = idx1 * 3;
                const base2 = idx2 * 3;
                tmpV1.set(values[base1 + 0], values[base1 + 1], values[base1 + 2]);
                tmpV2.set(values[base2 + 0], values[base2 + 1], values[base2 + 2]);
                const v = tmpV1.lerp(tmpV2, alpha);

                const yDelta = (v.y - pt.p0.y) * (st.weight || 1) * (st.hipsYScale || 1);
                const yClamped = Math.max(-st.hipsYClamp, Math.min(st.hipsYClamp, yDelta));
                const finalP = pt.restP.clone();
                finalP.y += yClamped;
                pt.bone.position.copy(finalP);
            }
        }
    }

    // 输出当前手动动画状态及示例骨骼信息
    debugManualAnimStatus() {
        try {
            const st = this._manualAnim;
            if (!st) {
                console.log('手动动画：未启用');
                return { active: false };
            }
            
            // 安全获取轨道数组
            const rotTracks = Array.isArray(st.rotTracks) ? st.rotTracks : [];
            const posTracks = Array.isArray(st.posTracks) ? st.posTracks : [];
            const allTracks = [...rotTracks, ...posTracks];
            
            const sample = allTracks.slice(0, 12).map(mt => {
                try {
                    return {
                        bone: (mt && mt.bone && mt.bone.name) ? mt.bone.name : 'unknown',
                        normalized: !!(mt && mt.bone && mt.bone.name && mt.bone.name.startsWith('Normalized_')),
                        times: (mt && mt.times && Array.isArray(mt.times)) ? mt.times.length : 0,
                        type: rotTracks.includes(mt) ? 'rotation' : 'position'
                    };
                } catch (e) {
                    return { bone: 'error', normalized: false, times: 0, type: 'unknown' };
                }
            });
            
            const info = {
                active: true,
                time: Number((st.time && st.time.toFixed) ? st.time.toFixed(3) : (st.time || 0)),
                duration: Number((st.duration && st.duration.toFixed) ? st.duration.toFixed(3) : (st.duration || 0)),
                speed: st.speed || 1,
                loop: st.loop || false,
                weight: st.weight || 1,
                rotTracks: rotTracks.length,
                posTracks: posTracks.length,
                sample
            };
            console.log('手动动画状态:', info);
            return info;
        } catch (error) {
            console.error('debugManualAnimStatus 错误:', error);
            return { active: false, error: error.message };
        }
    }

    // 打印 VRM humanoid 的归一化骨节点名称
    printHumanoidBoneNames() {
        const humanoid = this.currentModel?.humanoid || this.currentModel?.vrm?.humanoid;
        if (!humanoid || typeof humanoid.getNormalizedBoneNode !== 'function') {
            console.warn('humanoid 或归一化骨节点接口不可用');
            return null;
        }
        const keys = ['hips','spine','chest','upperChest','neck','head',
            'leftShoulder','leftUpperArm','leftLowerArm','leftHand',
            'rightShoulder','rightUpperArm','rightLowerArm','rightHand',
            'leftUpperLeg','leftLowerLeg','leftFoot','leftToes',
            'rightUpperLeg','rightLowerLeg','rightFoot','rightToes'];
        const names = {};
        for (const k of keys) {
            try { names[k] = humanoid.getNormalizedBoneNode(k)?.name || null; } catch (_) { names[k] = null; }
        }
        console.log('Humanoid归一化骨节点：', names);
        return names;
    }

    // 旋转测试：尝试在一段时间内推动指定 humanoid 归一化骨节点
    testRotateHumanoidBone(key = 'head', degrees = 25, seconds = 2.0) {
        const humanoid = this.currentModel?.humanoid || this.currentModel?.vrm?.humanoid;
        if (!humanoid || typeof humanoid.getNormalizedBoneNode !== 'function') {
            console.warn('humanoid 或归一化骨节点接口不可用');
            return false;
        }
        const bone = humanoid.getNormalizedBoneNode(key);
        if (!bone) {
            console.warn('未找到归一化骨节点：', key);
            return false;
        }
        const orig = bone.quaternion.clone();
        const axis = new THREE.Vector3(0, 1, 0);
        const rad = THREE.MathUtils.degToRad(degrees);
        const deltaQ = new THREE.Quaternion().setFromAxisAngle(axis, rad);
        bone.quaternion.multiply(deltaQ);
        setTimeout(() => { try { bone.quaternion.copy(orig); } catch (_) {} }, Math.max(0, seconds) * 1000);
        console.log(`已对归一化骨 '${key}' 施加测试旋转 ${degrees}°，持续 ${seconds}s`);
        return true;
    }
    
    // 停止所有动画
    stopAllAnimations() {
        if (this.animationActions) {
            Object.values(this.animationActions).forEach(action => {
                action.stop();
            });
            this.animationActions = {};
        }

        // 停止手动动画回退并恢复待机
        if (this._manualAnim) {
            this._manualAnim = null;
            try { this.resumeDefaultIdleAnimations(); } catch (_) {}
        }

        if (this.blinkTimer) {
            clearInterval(this.blinkTimer);
            this.blinkTimer = null;
        }
        
        if (this.breathingAnimationId) {
            cancelAnimationFrame(this.breathingAnimationId);
            this.breathingAnimationId = null;
        }
        
        if (this.idleAnimationId) {
            cancelAnimationFrame(this.idleAnimationId);
            this.idleAnimationId = null;
        }
    }

    // 暂停默认的待机/呼吸动画（保留眨眼）
    pauseDefaultIdleAnimations() {
        try {
            if (this.breathingAnimationId) {
                cancelAnimationFrame(this.breathingAnimationId);
                this.breathingAnimationId = null;
            }
            if (this.idleAnimationId) {
                cancelAnimationFrame(this.idleAnimationId);
                this.idleAnimationId = null;
            }
        } catch (_) {}
    }

    // 恢复默认的待机/呼吸动画
    resumeDefaultIdleAnimations() {
        try {
            this.addVRMBreathingAnimation();
            this.addIdlePostureAnimation();
        } catch (_) {}
    }
    
    // 基于VRM骨骼的呼吸动画
    addVRMBreathingAnimation() {
        if (!this.currentModel || !this.currentModel.humanoid) return;
        
        const humanoid = this.currentModel.humanoid;
        const chest = humanoid.getNormalizedBoneNode('chest') || humanoid.getNormalizedBoneNode('spine');
        
        if (!chest) return;
        
        const originalRotation = chest.rotation.clone();
        let breathingTime = 0;
        
        const animate = () => {
            if (!this.currentModel || !chest) return;
            
            breathingTime += 0.016; // 约60fps
            
            // 轻微的胸部前后摆动模拟呼吸（进一步降低幅度）
            const breathingIntensity = Math.sin(breathingTime * 0.8) * 0.01; // 更轻微的呼吸动作
            chest.rotation.x = originalRotation.x + breathingIntensity;
            
            this.breathingAnimationId = requestAnimationFrame(animate);
        };
        
        animate();
    }
    
    // 添加眨眼动画
    addBlinkAnimation() {
        if (!this.currentModel) return;
        
        // 创建随机眨眼
        this.blinkTimer = setInterval(() => {
            if (Math.random() < 0.3) { // 30%概率眨眼
                this.setBlinkValue(1);
                setTimeout(() => {
                    this.setBlinkValue(0);
                }, 150); // 眨眼持续150ms
            }
        }, 3000); // 每3秒检查一次，更自然
    }
    
    // 添加待机姿态动画（替代之前的摇摆动画）
    addIdlePostureAnimation() {
        if (!this.currentModel || !this.currentModel.humanoid) return;
        
        const humanoid = this.currentModel.humanoid;
        const head = humanoid.getNormalizedBoneNode('head');
        const neck = humanoid.getNormalizedBoneNode('neck');
        
        if (!head) return;
        
        const originalHeadRotation = head.rotation.clone();
        const originalNeckRotation = neck ? neck.rotation.clone() : null;
        let idleTime = 0;
        
        const animate = () => {
            if (!this.currentModel || !head) return;
            
            idleTime += 0.008;
            
            // 非常轻微的头部自然摆动
            head.rotation.x = originalHeadRotation.x + Math.sin(idleTime * 0.3) * 0.008;
            head.rotation.y = originalHeadRotation.y + Math.sin(idleTime * 0.2) * 0.005;
            
            // 如果有脖子骨骼，也添加轻微摆动
            if (neck && originalNeckRotation) {
                neck.rotation.x = originalNeckRotation.x + Math.sin(idleTime * 0.25) * 0.003;
            }
            
            this.idleAnimationId = requestAnimationFrame(animate);
        };
        
        animate();
    }

    // 清理当前模型
    clearCurrentModel() {
        // 停止所有动画
        this.stopAllAnimations();
        
        if (this.currentModel) {
            // 从场景中移除
            if (this.currentModel.scene) {
                this.scene.remove(this.currentModel.scene);
            }
            
            // 释放资源
            if (this.currentModel.dispose) {
                this.currentModel.dispose();
            }
            
            this.currentModel = null;
        }
        
        // 清理动画混合器
        if (this.mixer) {
            this.mixer = null;
        }
        
        // 清理动作列表
        this.animationActions = {};
    }
    
    // 初始化表情系统
    initExpressions() {
        if (!this.currentModel || !this.currentModel.expressionManager) {
            console.warn('模型没有表情管理器');
            return;
        }
        
        // 兼容不同three-vrm版本的表达式API
        this._getExpressionByName = (mgr, name) => {
            if (!mgr || !name) return null;
            try {
                if (typeof mgr.getExpressionByName === 'function') {
                    return mgr.getExpressionByName(name);
                }
                if (typeof mgr.getExpression === 'function') {
                    return mgr.getExpression(name);
                }
                if (mgr.namedExpressions && typeof mgr.namedExpressions === 'object') {
                    return mgr.namedExpressions[name] || null;
                }
                const list = mgr.expressions;
                if (Array.isArray(list)) {
                    for (const exp of list) {
                        if (exp && (exp.expressionName === name || exp.name === name)) return exp;
                    }
                }
            } catch (_) {}
            return null;
        };
        this._setExpressionValue = (mgr, exprOrName, value) => {
            if (!mgr) return false;
            try {
                if (typeof mgr.setValue === 'function') {
                    try {
                        mgr.setValue(exprOrName, value);
                        return true;
                    } catch (_) {
                        const exp = this._getExpressionByName(mgr, exprOrName);
                        if (exp) { mgr.setValue(exp, value); return true; }
                    }
                }
                if (typeof mgr.applyExpression === 'function') {
                    // 某些旧实现可能使用applyExpression
                    const exp = this._getExpressionByName(mgr, exprOrName) || exprOrName;
                    mgr.applyExpression(exp, value);
                    return true;
                }
            } catch (_) {}
            return false;
        };

        // 获取所有可用表情（用于调试输出与后续解析）
        const mgr = this.currentModel.expressionManager;
        const expressions = mgr.expressions;
        console.log('可用表情(原始输出，可能为数组或字典):', expressions);

        // 规范收集可用表情名
        try {
            let names = [];
            if (Array.isArray(expressions)) {
                for (const exp of expressions) {
                    const n = exp && (exp.expressionName || exp.name);
                    if (n) names.push(n);
                }
            } else if (expressions && typeof expressions === 'object') {
                names = Object.keys(expressions);
            }
            if (mgr.namedExpressions && typeof mgr.namedExpressions === 'object') {
                for (const n of Object.keys(mgr.namedExpressions)) {
                    if (!names.includes(n)) names.push(n);
                }
            }
            this.availableExpressions = names;
            console.log('规范化后的可用表情名:', this.availableExpressions);
        } catch (_) {
            // 忽略收集错误，使用空列表
            this.availableExpressions = [];
        }

        // 记录可用的口型表情：支持VRM标准五元音
        const candidates = ['aa','ee','ih','oh','ou'];
        const available = [];
        for (const n of candidates) {
            const exp = this._getExpressionByName(mgr, n);
            if (exp || typeof mgr.setValue === 'function') {
                // 允许直接通过字符串设置的实现
                available.push(n);
            }
        }
        this.availableMouthNames = available.length ? available : ['aa'];
        // 初始化五元音权重
        this.vowelWeights = { a: 0, e: 0, i: 0, o: 0, u: 0 };
    }
    
    // 播放表情
    async playExpression(emotion) {
        if (!this.currentModel || !this.currentModel.expressionManager) {
            console.warn('无法播放表情：模型或表情管理器未加载');
            return;
        }
        
        // 记录当前情感
        this.currentEmotion = emotion;
        
        // 映射情感到VRM表情
        let expressionName = null;
        
        // 根据情感类型选择表情（优先选择模型实际支持的名称，并兼容别名）
        const e = String(emotion || '').toLowerCase();
        const aliasMap = {
            happy: ['happy','joy','smile','cheer'],
            sad: ['sad','sorrow'],
            angry: ['angry','mad'],
            surprised: ['surprised','shock'],
            relaxed: ['relaxed','calm'],
            blink: ['blink','blinkLeft','blinkRight'],
            aa: ['aa','mouth','open'],
            neutral: ['neutral']
        };
        const hasExp = (name) => Array.isArray(this.availableExpressions) ? this.availableExpressions.includes(name) : true;
        const pickFirstAvailable = (names) => {
            for (const n of names) { if (hasExp(n)) return n; }
            return null;
        };
        if (aliasMap.happy.includes(e)) {
            expressionName = pickFirstAvailable(aliasMap.happy) || 'happy';
        } else if (aliasMap.sad.includes(e)) {
            expressionName = pickFirstAvailable(aliasMap.sad) || 'sad';
        } else if (aliasMap.angry.includes(e)) {
            expressionName = pickFirstAvailable(aliasMap.angry) || 'angry';
        } else if (aliasMap.surprised.includes(e)) {
            expressionName = pickFirstAvailable(aliasMap.surprised) || 'surprised';
        } else if (aliasMap.relaxed.includes(e)) {
            expressionName = pickFirstAvailable(aliasMap.relaxed) || 'relaxed';
        } else if (aliasMap.blink.includes(e)) {
            expressionName = pickFirstAvailable(aliasMap.blink) || 'blink';
        } else if (aliasMap.aa.includes(e)) {
            expressionName = pickFirstAvailable(['aa']) || 'aa';
        } else {
            expressionName = pickFirstAvailable(aliasMap.neutral) || 'neutral';
        }
        
        // 尝试播放表情
        try {
            const mgr = this.currentModel.expressionManager;
            // 清理上一个非口型的表情，避免累积
            try {
                if (this.lastExpressionName && !['aa','ee','ih','oh','ou','blink','blinkLeft','blinkRight'].includes(this.lastExpressionName)) {
                    this._setExpressionValue(mgr, this.lastExpressionName, 0.0);
                }
                // 再将所有非口型、非眨眼的表情设为0（兼容有些实现会残留）
                const exps = mgr.expressions;
                if (Array.isArray(exps)) {
                    for (const exp of exps) {
                        const n = exp && (exp.expressionName || exp.name);
                        if (n && !['aa','ee','ih','oh','ou','blink','blinkLeft','blinkRight'].includes(n)) {
                            this._setExpressionValue(mgr, n, 0.0);
                        }
                    }
                } else if (exps && typeof exps === 'object') {
                    for (const n in exps) {
                        if (!['aa','ee','ih','oh','ou','blink','blinkLeft','blinkRight'].includes(n)) {
                            this._setExpressionValue(mgr, n, 0.0);
                        }
                    }
                }
            } catch (_) {}

            const ok = this._setExpressionValue(mgr, expressionName, 1.0);
            if (ok) {
                console.log(`播放表情: ${expressionName}`);
                this.lastExpressionName = expressionName;
            } else {
                console.warn(`未找到或无法设置表情: ${expressionName}`);
            }
        } catch (error) {
            console.error('播放表情失败:', error);
        }
    }
    
    // 更新面部表情（口型和眨眼）
    updateFacialExpressions() {
        if (!this.currentModel || !this.currentModel.expressionManager) return;
        
        try {
            // 更新口型：根据五元音权重混合
            const mgr = this.currentModel.expressionManager;
            const setExp = (name, val) => {
                this._setExpressionValue(mgr, name, Math.max(0, Math.min(1, val)));
            };
            const base = this.mouthValue || 0;
            const w = this.vowelWeights || { a: base, e: 0, i: 0, o: 0, u: 0 };
            const map = { aa: w.a, ee: w.e, ih: w.i, oh: w.o, ou: w.u };
            for (const name of this.availableMouthNames || ['aa']) {
                setExp(name, map[name] ?? 0);
            }
            
            // 更新眨眼
            const bmgr = this.currentModel.expressionManager;
            // 先尝试整体blink
            if (!this._setExpressionValue(bmgr, 'blink', this.blinkValue)) {
                // 兼容VRM1的左右眼
                this._setExpressionValue(bmgr, 'blinkLeft', this.blinkValue);
                this._setExpressionValue(bmgr, 'blinkRight', this.blinkValue);
            }
        } catch (error) {
            // 忽略错误
        }
    }
    
    // 设置口型值（0-1）
    setMouthValue(value) {
        this.mouthValue = Math.max(0, Math.min(1, value));
    }
    
    // 设置眨眼值（0-1）
    setBlinkValue(value) {
        this.blinkValue = Math.max(0, Math.min(1, value));
    }
    
    // VRM动画控制系统
    playAnimation(action) {
        console.log(`播放VRM动画: ${action}`);
        
        if (!this.currentModel || !this.currentModel.humanoid) {
            console.warn('VRM模型或骨骼系统未加载');
            return;
        }
        
        // 停止当前正在播放的动作动画（但保留待机动画）
        this.stopActionAnimation();

        // 如果传入的action恰好是动画库中的clip名称，则直接播放该clip
        if (this.animationLibrary && this.animationLibrary[action]) {
            const ok = this.playClip(action, { fadeIn: 0.25, fadeOut: 0.2, loop: false, weight: 1.0, speed: 1.0, pauseIdle: true });
            if (ok) return;
        }

        // 优先尝试使用AnimationClip库
        const clipName = this.mapActionToClip(action);
        if (clipName && this.animationLibrary[clipName]) {
            const ok = this.playClip(clipName, { fadeIn: 0.25, fadeOut: 0.2, loop: false, weight: 1.0, speed: 1.0, retargetToVRM: true, includeLowerBody: true, pauseIdle: true });
            if (ok) return;
        }
        
        switch(action) {
            case 'wave':
                this.playVRMWaveAnimation();
                break;
            case 'nod':
                this.playVRMNodAnimation();
                break;
            case 'shake':
                this.playVRMShakeAnimation();
                break;
            case 'bow':
                this.playVRMBowAnimation();
                break;
            
            default:
                console.warn(`未知的动画类型: ${action}`);
        }
    }
    
    // 停止动作动画（保留待机动画）
    stopActionAnimation() {
        if (this.currentActionAnimationId) {
            cancelAnimationFrame(this.currentActionAnimationId);
            this.currentActionAnimationId = null;
        }
    }
    
    // 基于VRM骨骼的挥手动画（改进版）
    playVRMWaveAnimation() {
        const humanoid = this.currentModel.humanoid;
        const rightUpperArm = humanoid.getNormalizedBoneNode('rightUpperArm');
        const rightLowerArm = humanoid.getNormalizedBoneNode('rightLowerArm');
        const rightHand = humanoid.getNormalizedBoneNode('rightHand');
        const rightShoulder = humanoid.getNormalizedBoneNode('rightShoulder');
        
        if (!rightUpperArm || !rightLowerArm) {
            console.warn('找不到右臂骨骼节点');
            return;
        }
        
        const originalUpperArmRotation = rightUpperArm.rotation.clone();
        const originalLowerArmRotation = rightLowerArm.rotation.clone();
        const originalHandRotation = rightHand ? rightHand.rotation.clone() : null;
        const originalShoulderRotation = rightShoulder ? rightShoulder.rotation.clone() : null;
        
        const duration = 4000; // 延长到4秒，让动作更自然
        const startTime = Date.now();
        
        const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            if (progress < 1) {
                // 使用更自然的缓动函数
                const easeInOut = (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
                const smoothProgress = easeInOut(progress);
                
                // 分阶段的挥手动作
                let liftAngle, waveAngle, handAngle = 0, shoulderAngle = 0;
                
                if (progress < 0.2) {
                    // 第一阶段：抬起手臂 (0-20%)
                    const liftProgress = progress / 0.2;
                    liftAngle = easeInOut(liftProgress) * 0.8; // 进一步减少抬起角度
                    waveAngle = 0;
                } else if (progress < 0.8) {
                    // 第二阶段：挥手摆动 (20-80%)
                    liftAngle = 0.8;
                    const waveProgress = (progress - 0.2) / 0.6;
                    waveAngle = Math.sin(waveProgress * Math.PI * 4) * 0.4; // 进一步减少摆动幅度
                    
                    // 手腕配合摆动
                    if (rightHand) {
                        handAngle = Math.sin(waveProgress * Math.PI * 4) * 0.2;
                    }
                } else {
                    // 第三阶段：回到原位 (80-100%)
                    const returnProgress = (progress - 0.8) / 0.2;
                    liftAngle = 1.0 * (1 - easeInOut(returnProgress));
                    waveAngle = 0;
                }
                
                // 肩膀配合动作
                if (rightShoulder) {
                    shoulderAngle = liftAngle * 0.2; // 肩膀轻微抬起
                }
                
                // 应用旋转
                rightUpperArm.rotation.z = originalUpperArmRotation.z - liftAngle;
                rightUpperArm.rotation.x = originalUpperArmRotation.x + waveAngle * 0.15;
                rightUpperArm.rotation.y = originalUpperArmRotation.y + liftAngle * 0.3; // 添加Y轴旋转使动作更自然
                
                // 小臂配合弯曲
                rightLowerArm.rotation.z = originalLowerArmRotation.z - Math.max(0, liftAngle * 0.7 - Math.abs(waveAngle) * 0.25);
                
                // 手腕动作
                if (rightHand && originalHandRotation) {
                    rightHand.rotation.z = originalHandRotation.z + handAngle;
                    rightHand.rotation.x = originalHandRotation.x + liftAngle * 0.08; // 手腕稍微向上
                }
                
                // 肩膀动作
                if (rightShoulder && originalShoulderRotation) {
                    rightShoulder.rotation.z = originalShoulderRotation.z + shoulderAngle;
                }
                
                this.currentActionAnimationId = requestAnimationFrame(animate);
            } else {
                // 恢复原始位置
                rightUpperArm.rotation.copy(originalUpperArmRotation);
                rightLowerArm.rotation.copy(originalLowerArmRotation);
                if (rightHand && originalHandRotation) {
                    rightHand.rotation.copy(originalHandRotation);
                }
                if (rightShoulder && originalShoulderRotation) {
                    rightShoulder.rotation.copy(originalShoulderRotation);
                }
                this.currentActionAnimationId = null;
            }
        };
        
        animate();
    }
    
    // 基于VRM骨骼的点头动画
    playVRMNodAnimation() {
        const humanoid = this.currentModel.humanoid;
        const head = humanoid.getNormalizedBoneNode('head');
        const neck = humanoid.getNormalizedBoneNode('neck');
        
        if (!head) {
            console.warn('找不到头部骨骼节点');
            return;
        }
        
        const originalHeadRotation = head.rotation.clone();
        const originalNeckRotation = neck ? neck.rotation.clone() : null;
        
        const duration = 2500; // 2.5秒，稍慢更自然
        const startTime = Date.now();
        
        const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            if (progress < 1) {
                // 点头动作：头部前后摆动（加入轻缓幅度与缓动）
                const easeInOut = (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
                const eased = easeInOut(progress);
                const nodAngle = Math.sin(eased * Math.PI * 3) * 0.25;
                head.rotation.x = originalHeadRotation.x + nodAngle;
                
                // 如果有脖子，也参与动作
                if (neck && originalNeckRotation) {
                    neck.rotation.x = originalNeckRotation.x + nodAngle * 0.3;
                }
                
                this.currentActionAnimationId = requestAnimationFrame(animate);
            } else {
                // 恢复原始位置
                head.rotation.copy(originalHeadRotation);
                if (neck && originalNeckRotation) {
                    neck.rotation.copy(originalNeckRotation);
                }
                this.currentActionAnimationId = null;
            }
        };
        
        animate();
    }
    
    // 基于VRM骨骼的摇头动画
    playVRMShakeAnimation() {
        const humanoid = this.currentModel.humanoid;
        const head = humanoid.getNormalizedBoneNode('head');
        const neck = humanoid.getNormalizedBoneNode('neck');
        
        if (!head) {
            console.warn('找不到头部骨骼节点');
            return;
        }
        
        const originalHeadRotation = head.rotation.clone();
        const originalNeckRotation = neck ? neck.rotation.clone() : null;
        
        const duration = 2500; // 2.5秒，稍慢更自然
        const startTime = Date.now();
        
        const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            if (progress < 1) {
                // 摇头动作：头部左右摆动（加入轻缓幅度与缓动）
                const easeInOut = (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
                const eased = easeInOut(progress);
                const shakeAngle = Math.sin(eased * Math.PI * 4) * 0.3;
                head.rotation.y = originalHeadRotation.y + shakeAngle;
                
                // 如果有脖子，也参与动作
                if (neck && originalNeckRotation) {
                    neck.rotation.y = originalNeckRotation.y + shakeAngle * 0.3;
                }
                
                this.currentActionAnimationId = requestAnimationFrame(animate);
            } else {
                // 恢复原始位置
                head.rotation.copy(originalHeadRotation);
                if (neck && originalNeckRotation) {
                    neck.rotation.copy(originalNeckRotation);
                }
                this.currentActionAnimationId = null;
            }
        };
        
        animate();
    }
    
    // 基于VRM骨骼的鞠躬动画
    playVRMBowAnimation() {
        const humanoid = this.currentModel.humanoid;
        const spine = humanoid.getNormalizedBoneNode('spine');
        const chest = humanoid.getNormalizedBoneNode('chest');
        const head = humanoid.getNormalizedBoneNode('head');
        
        if (!spine && !chest) {
            console.warn('找不到脊椎或胸部骨骼节点');
            return;
        }
        
        const targetBone = chest || spine;
        const originalSpineRotation = targetBone.rotation.clone();
        const originalHeadRotation = head ? head.rotation.clone() : null;
        
        const duration = 3200; // 3.2秒，稍慢更自然
        const startTime = Date.now();
        
        const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            if (progress < 1) {
                let bowAngle;
                if (progress < 0.4) {
                    // 前40%：向前弯腰（降低最大幅度）
                    bowAngle = (progress / 0.4) * 0.45;
                } else if (progress < 0.7) {
                    // 中间30%：保持鞠躬姿势
                    bowAngle = 0.45;
                } else {
                    // 后30%：回到原位
                    bowAngle = 0.45 * (1 - (progress - 0.7) / 0.3);
                }
                
                targetBone.rotation.x = originalSpineRotation.x + bowAngle;
                
                // 头部也稍微配合动作
                if (head && originalHeadRotation) {
                    head.rotation.x = originalHeadRotation.x + bowAngle * 0.3;
                }
                
                this.currentActionAnimationId = requestAnimationFrame(animate);
            } else {
                // 恢复原始位置
                targetBone.rotation.copy(originalSpineRotation);
                if (head && originalHeadRotation) {
                    head.rotation.copy(originalHeadRotation);
                }
                this.currentActionAnimationId = null;
            }
        };
        
        animate();
    }
    
    // 添加Agent控制接口
    setupAgentInterface() {
        console.log('设置VRM Agent控制接口');
        
        // 创建Agent控制对象
        this.agentController = {
            // 基础动作控制
            performAction: (action, intensity = 1.0) => {
                return this.performAgentAction(action, intensity);
            },
            // 直接播放clip
            playClip: (name, options = {}) => {
                return this.playClip(name, options);
            },
            
            // 表情控制
            setEmotion: (emotion, duration = 2000) => {
                return this.setAgentEmotion(emotion, duration);
            },
            
            // 语音同步控制
            syncWithAudio: (audioData) => {
                return this.syncVRMWithAudio(audioData);
            },
            
            // 获取当前状态
            getStatus: () => {
                return {
                    isLoaded: !!this.currentModel,
                    isAnimating: !!this.currentActionAnimationId,
                    currentEmotion: this.currentEmotion || 'neutral'
                };
            },
            
            // 设置待机模式
            setIdleMode: (enabled) => {
                this.setIdleMode(enabled);
            }
        };
        
        // 将接口暴露到全局
        window.vrmAgent = this.agentController;
        console.log('VRM Agent接口已就绪');
    }
    
    // Agent动作执行
    performAgentAction(action, intensity = 1.0) {
        console.log(`Agent执行动作: ${action}, 强度: ${intensity}`);
        
        if (!this.currentModel) {
            console.warn('VRM模型未加载');
            return false;
        }
        
        // 根据强度调整动作幅度
        this.actionIntensity = Math.max(0.1, Math.min(2.0, intensity));
        
        // 执行动作
        this.playAnimation(action);
        return true;
    }
    
    // Agent表情控制
    setAgentEmotion(emotion, duration = 2000) {
        console.log(`Agent设置表情: ${emotion}, 持续时间: ${duration}ms`);
        
        this.currentEmotion = emotion;
        this.playExpression(emotion);
        
        // 设置表情恢复定时器
        if (this.emotionTimer) {
            clearTimeout(this.emotionTimer);
        }
        
        this.emotionTimer = setTimeout(() => {
            this.currentEmotion = 'neutral';
            try {
                // 回到中性：清除非口型/眨眼的表情
                const mgr = this.currentModel && this.currentModel.expressionManager;
                if (mgr) {
                    const exps = mgr.expressions;
                    if (Array.isArray(exps)) {
                        for (const exp of exps) {
                            const n = exp && (exp.expressionName || exp.name);
                            if (n && !['aa','ee','ih','oh','ou','blink','blinkLeft','blinkRight'].includes(n)) {
                                this._setExpressionValue(mgr, n, 0.0);
                            }
                        }
                    } else if (exps && typeof exps === 'object') {
                        for (const n in exps) {
                            if (!['aa','ee','ih','oh','ou','blink','blinkLeft','blinkRight'].includes(n)) {
                                this._setExpressionValue(mgr, n, 0.0);
                            }
                        }
                    }
                }
                this.lastExpressionName = null;
            } catch (_) {}
        }, duration);
        
        return true;
    }
    
    // 语音同步控制
    syncVRMWithAudio(audioData) {
        if (!this.currentModel || !audioData) return false;
        
        // Phase 1：RMS驱动 + 简易频段估计五元音
        let volume = audioData.volume || 0;
        let frequency = audioData.frequency || 0;
        // 简单平滑，降低抖动
        if (!this._prevAudio) this._prevAudio = { volume: 0, frequency: 0 };
        volume = this._prevAudio.volume * 0.6 + volume * 0.4;
        frequency = this._prevAudio.frequency * 0.5 + frequency * 0.5;
        this._prevAudio = { volume, frequency };
        
        // 整体张口幅度
        this.setMouthValue(Math.min(1, volume * 0.9));
        
        // 频率到元音的启发式映射
        const f = Math.max(0, Math.min(4000, frequency));
        const base = Math.min(1, volume);
        let a = 0, e = 0, i = 0, o = 0, u = 0;
        if (f < 250) {
            a = base; // 低频 -> a
        } else if (f < 600) {
            o = base * 0.8; a = base * 0.3; // 低中频 -> o，少量a
        } else if (f < 1200) {
            e = base * 0.7; u = base * 0.4; // 中频 -> e/u
        } else if (f < 2500) {
            i = base * 0.9; e = base * 0.3; // 中高频 -> i，辅以e
        } else {
            i = base; // 高频 -> i
        }
        const sum = a + e + i + o + u;
        if (sum > 1e-3) {
            const k = Math.min(1.0, base / sum);
            a *= k; e *= k; i *= k; o *= k; u *= k;
        }
        this.vowelWeights = { a, e, i, o, u };
        
        // 音频反应性头部动作
        if (volume > 0.3) {
            this.addAudioReactiveMovement(volume, frequency);
        }
        
        return true;
    }
    
    // 音频反应性动作
    addAudioReactiveMovement(volume, frequency) {
        if (!this.currentModel || !this.currentModel.humanoid) return;
        
        const head = this.currentModel.humanoid.getNormalizedBoneNode('head');
        if (!head) return;
        
        // 根据音频添加轻微的头部摆动
        const intensity = Math.min(volume * 0.05, 0.02);
        const frequencyFactor = (frequency / 1000) * 0.01;
        
        head.rotation.x += Math.sin(Date.now() * 0.01) * intensity;
        head.rotation.y += Math.cos(Date.now() * 0.008) * frequencyFactor;
    }
    
    // 设置待机模式
    setIdleMode(enabled) {
        console.log(`设置待机模式: ${enabled}`);
        
        if (enabled) {
            if (!this.idleAnimationId) {
                this.addIdlePostureAnimation();
            }
            if (!this.breathingAnimationId) {
                this.addVRMBreathingAnimation();
            }
            if (!this.blinkTimer) {
                this.addBlinkAnimation();
            }
        } else {
            // 停止待机动画但保留基本的呼吸和眨眼
            if (this.idleAnimationId) {
                cancelAnimationFrame(this.idleAnimationId);
                this.idleAnimationId = null;
            }
        }
    }
    
    // 调整模型大小
    resizeModel(scale) {
        if (!this.currentModel || !this.currentModel.scene) {
            console.log('VRM模型未加载，无法调整大小');
            return;
        }
        
        const modelScale = Math.max(0.5, Math.min(1.5, scale));
        this.currentModel.scene.scale.set(modelScale, modelScale, modelScale);
        console.log(`VRM模型大小已调整为: ${modelScale}`);
    }
    
    // 显示模型
    showModel() {
        if (!this.currentModel || !this.currentModel.scene) return;
        this.currentModel.scene.visible = true;
    }
    
    // 隐藏模型
    hideModel() {
        if (!this.currentModel || !this.currentModel.scene) return;
        this.currentModel.scene.visible = false;
    }
    
    // 加载用户偏好
    async loadUserPreferences() {
        try {
            const response = await fetch('/api/preferences');
            if (response.ok) {
                return await response.json();
            }
        } catch (error) {
            console.warn('加载用户偏好失败:', error);
        }
        return [];
    }
    
    // 保存用户偏好
    async saveUserPreferences(modelPath, position, scale) {
        try {
            const preferences = {
                model_path: modelPath,
                position: position,
                scale: scale
            };
            const response = await fetch('/api/preferences', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(preferences)
            });
            const result = await response.json();
            return result.success;
        } catch (error) {
            console.error("保存偏好失败:", error);
            return false;
        }
    }

    // 根据动画元信息推断是否需要 Mixamo 校正
    _detectClipCorrectionPreset(meta) {
        try {
            if (!meta) return null;
            const file = String(meta.file || '').toLowerCase();
            const name = String(meta.name || '').toLowerCase();
            const tags = Array.isArray(meta.tags) ? meta.tags.map(t => String(t).toLowerCase()) : [];
            if (tags.includes('mixamo')) return 'mixamo';
            if (file.includes('mixamo') || file.includes('xbot') || file.includes('converted')) return 'mixamo';
            if (name.includes('mixamo') || name.includes('xbot')) return 'mixamo';
            return null;
        } catch (_) {
            return null;
        }
    }

    // Mixamo 动画坐标系校正：调整不同骨骼的旋转习惯差异
    _applyMixamoCorrection(quaternion, boneName) {
        try {
            if (!quaternion || !boneName) return;
            const name = String(boneName).toLowerCase();

            // 通过欧拉角在 XYZ 顺序下做温和的修正
            const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');

            // 髋与脊柱在 Mixamo 中常出现前后倾反向或过大
            if (name.includes('hips')) {
                euler.x = -euler.x * 0.3; // 反转并减小前后倾
                euler.z *= 0.5;           // 降低左右侧倾
            } else if (name.includes('spine') || name.includes('chest') || name.includes('upperchest')) {
                euler.x = -euler.x * 0.8; // 反转前后倾，保留一定幅度
            } else if (name.includes('neck') || name.includes('head')) {
                euler.x = -euler.x * 0.7; // 反转并降低后仰/点头幅度
            } else if (name.includes('shoulder')) {
                euler.z *= 0.8;           // 肩部滚转稍微减弱
            } else if (name.includes('upperarm') || name.includes('lowerarm') || name.includes('hand')) {
                euler.x *= 0.9;           // 手臂前后摆稍微减弱
            } else if (name.includes('upperleg') || name.includes('lowerleg') || name.includes('foot')) {
                euler.x *= 0.9;           // 下肢前后摆稍微减弱，避免过度后仰感
            }

            quaternion.setFromEuler(euler);
        } catch (_) {
            // 安全兜底，不影响主流程
        }
    }
}

// 创建全局VRM管理器实例
window.vrmManager = new VRMManager();