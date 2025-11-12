// 全局模型管理器
class ModelManager {
    constructor() {
        this.currentModelType = null; // 不设置默认值，让getModelType决定
        this.isInitialized = false;
        this.live2dInitialized = false;
        this.vrmInitialized = false;
    }
    
    // 设置模型类型
    setModelType(type) {
        console.log(`设置模型类型: ${type}`);
        this.currentModelType = type;
        window.modelType = type;
        localStorage.setItem('modelType', type);
    }
    
    // 获取模型类型
    getModelType() {
        if (!this.currentModelType) {
            // 优先使用window.modelType，然后从localStorage或URL参数获取
            this.currentModelType = window.modelType || 
                                  localStorage.getItem('modelType') || 
                                  new URLSearchParams(window.location.search).get('model') || 
                                  'live2d';
        }
        return this.currentModelType;
    }
    
    // 初始化当前模型
    async initCurrentModel() {
        if (this.isInitialized) return;
        
        const modelType = this.getModelType();
        console.log(`初始化模型: ${modelType}`);
        
        try {
            if (modelType === 'vrm') {
                await this.initVRMModel();
            } else {
                await this.initLive2DModel();
            }
        } catch (error) {
            console.error(`模型初始化失败: ${error}`);
        }
        
        // 无论模型初始化是否成功，都创建控制面板
        createControlPanels();
        
        this.isInitialized = true;
    }
    
    // 初始化Live2D模型
    async initLive2DModel() {
        if (this.live2dInitialized) return;
        
        console.log('初始化Live2D模型');
        this.showLive2DContainer();
        this.hideVRMContainer();

        try {
            // 若全局管理器存在但未初始化，则进行兜底初始化，避免容器尺寸为0导致渲染器初始化失败
            if (window.live2dManager) {
                const app = window.live2dManager.getPIXIApp && window.live2dManager.getPIXIApp();
                const container = document.getElementById('live2d-container');
                const canvas = document.getElementById('live2d-canvas');

                if (!app && typeof window.live2dManager.initPIXI === 'function') {
                    await window.live2dManager.initPIXI('live2d-canvas', 'live2d-container');
                }

                // 如果模型未加载且模板提供了路径，则尝试加载
                if (typeof window.live2dManager.getCurrentModel === 'function') {
                    const current = window.live2dManager.getCurrentModel();
                    if (!current && typeof cubism4Model !== 'undefined' && cubism4Model && typeof window.live2dManager.loadModel === 'function') {
                        await window.live2dManager.loadModel(cubism4Model, { isMobile: /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) });
                    }
                }

                // 修复初始化时容器尺寸为0的情况，强制触发一次renderer resize
                const w = container && container.clientWidth ? container.clientWidth : (canvas && canvas.clientWidth ? canvas.clientWidth : 320);
                const h = container && container.clientHeight ? container.clientHeight : (canvas && canvas.clientHeight ? canvas.clientHeight : 240);
                const pixiApp = window.live2dManager.getPIXIApp && window.live2dManager.getPIXIApp();
                if (pixiApp && pixiApp.renderer && w && h) {
                    try { pixiApp.renderer.resize(w, h); } catch (_) {}
                }
            }
        } catch (e) {
            console.warn('Live2D兜底初始化失败:', e);
        }

        // Live2D会自动初始化，我们只需要确保容器可见
        this.live2dInitialized = true;
    }
    
    // 初始化VRM模型
    async initVRMModel() {
        if (this.vrmInitialized) return;
        
        console.log('初始化VRM模型');
        this.showVRMContainer();
        this.hideLive2DContainer();
        
        try {
            // 等待GLTF/VRM加载器就绪，避免因CDN阻拦导致的竞态
            const ensureVRMLoadersReady = async () => {
                // 能力检测：避免把占位版 three.min.js 误判为真实库
                const hasThree = () => !!window.THREE;
                const isStubThree = () => {
                    try {
                        if (!window.THREE) return true;
                        const hasRenderer = !!window.THREE.WebGLRenderer;
                        const mixerProto = window.THREE.AnimationMixer && window.THREE.AnimationMixer.prototype;
                        const hasClipAction = !!(mixerProto && typeof mixerProto.clipAction === 'function');
                        return !(hasRenderer && hasClipAction);
                    } catch (_) { return true; }
                };
                const hasGLTF = () => {
                    const Ctor = window.GLTFLoaderModule || window.GLTFLoader || (window.THREE && window.THREE.GLTFLoader);
                    return !!Ctor && typeof Ctor === 'function';
                };
                const hasVRMPlugin = () => (window.VRMLoaderPluginModule) || (window.VRMLoaderPlugin) || (window.THREE && (window.THREE.VRMLoaderPlugin || (window.THREE.VRM && window.THREE.VRM.VRMLoaderPlugin)));
                const injectScript = (src) => new Promise((resolve) => {
                    const s = document.createElement('script');
                    s.src = src;
                    s.onload = () => resolve(true);
                    s.onerror = () => resolve(false);
                    document.head.appendChild(s);
                });
                const injectLocalThreeStack = async () => {
                    // 已统一到 ESM，默认不再注入本地 UMD/real 库，防止实例覆盖
                    console.warn('跳过注入本地 three.real/UMD 栈，使用 ESM 模块');
                    return false;
                };

                // 额外的就绪等待：轮询 THREE 和 GLTFLoader，最长等待 6s
                const waitForThreeReady = async (maxMs = 6000) => {
                    const start = Date.now();
                    while (Date.now() - start < maxMs) {
                        const ready = !!(window.THREE && window.THREE.WebGLRenderer && (window.GLTFLoaderModule || window.GLTFLoader || (window.THREE && window.THREE.GLTFLoader)));
                        if (ready) return true;
                        await new Promise(r => setTimeout(r, 100));
                    }
                    return !!window.THREE;
                };

                // 最多等待1500ms，每50ms检查一次
                const start = Date.now();
                if (!hasThree() || isStubThree() || !hasGLTF() || !hasVRMPlugin()) {
                    // 等待 ESM 模块脚本完成初始化（index.html 顶部模块会暴露到 window）
                    await injectLocalThreeStack();
                }
                // 放宽等待时间并包含 THREE 未定义的情况
                while ((!hasThree() || isStubThree() || !hasGLTF()) && Date.now() - start < 5000) {
                    await new Promise(r => setTimeout(r, 100));
                }
                // 最后一次保险等待
                await waitForThreeReady(2000);
                // 将命名空间映射到全局（保险）
                if (!window.GLTFLoader && window.THREE && window.THREE.GLTFLoader) {
                    window.GLTFLoader = window.THREE.GLTFLoader;
                }
                if (!window.VRMLoaderPlugin && window.THREE) {
                    if (window.THREE.VRMLoaderPlugin) window.VRMLoaderPlugin = window.THREE.VRMLoaderPlugin;
                    else if (window.THREE.VRM && window.THREE.VRM.VRMLoaderPlugin) window.VRMLoaderPlugin = window.THREE.VRM.VRMLoaderPlugin;
                }
                if (!hasGLTF()) {
                    console.warn('GLTFLoader仍未就绪，将使用回退逻辑');
                } else {
                    console.log('Three/GLTF就绪，VRM插件:', hasVRMPlugin() ? '可用' : '缺失(将回退)');
                }
            };

            // 等待VRM管理器加载
            if (!window.vrmManager) {
                console.error('VRM管理器未找到');
                return;
            }
            
            // 初始化VRM管理器
            await ensureVRMLoadersReady();
            // 若 THREE 仍未定义，则继续等待，避免 initThree 抛错
            if (!window.THREE || !window.THREE.WebGLRenderer) {
                console.warn('THREE 未就绪，延迟初始化 VRM 渲染器');
                const startWait = Date.now();
                while ((!window.THREE || !window.THREE.WebGLRenderer) && Date.now() - startWait < 6000) {
                    await new Promise(r => setTimeout(r, 100));
                }
            }
            await window.vrmManager.initThree('vrm-canvas', 'vrm-container');
            // 在模型加载完成后填充专业动画库按钮
            window.vrmManager.onModelLoaded = () => {
                try { populateVRMClipButtons(); } catch (e) { console.warn('填充AnimationClip按钮失败:', e); }
            };
            
            // 加载EE.vrm模型
            const modelPath = '/static/EE.vrm';
            await window.vrmManager.loadModel(modelPath);

            // 默认应用环境贴图以提升质感（若存在本地HDR）
            try {
                const hdrUrl = '/static/hdr/qwantani_night_puresky_2k.hdr';
                const head = await fetch(hdrUrl, { method: 'HEAD' });
                if (head && head.ok) {
                    console.log('应用默认HDR环境:', hdrUrl);
                    await window.vrmManager.setEnvironmentHDR(hdrUrl);
                    // 可按需微调曝光；保持UI按钮仍可覆盖
                    try { window.vrmManager.renderer.toneMappingExposure = 1.0; } catch (_) {}
                }
            } catch (e) {
                console.warn('默认HDR环境应用失败(跳过):', e);
            }

            // 加载动画库清单（包含已转换的GLB），若未配置则静默跳过
            try {
                const manifestUrl = '/static/animations/animations.json';
                let ok = false;
                try {
                    const head = await fetch(manifestUrl, { method: 'HEAD' });
                    ok = !!head && head.ok;
                } catch (_) { ok = false; }
                if (ok) {
                    console.log('加载动画库清单:', manifestUrl);
                    await window.vrmManager.loadAnimationLibrary(manifestUrl);
                    try { populateVRMClipButtons(); } catch (e) { console.warn('填充AnimationClip按钮失败:', e); }
                } else {
                    console.warn('未检测到动画库清单，跳过加载');
                }
            } catch (e) {
                console.warn('加载动画库失败(已跳过):', e);
            }
            
            this.vrmInitialized = true;
            console.log('VRM模型初始化完成');
        } catch (error) {
            console.error('VRM模型初始化失败:', error);
        }
    }
    
    // 切换模型类型
    async switchModel() {
        const newType = this.currentModelType === 'live2d' ? 'vrm' : 'live2d';
        console.log(`切换模型: ${this.currentModelType} -> ${newType}`);
        
        // 清理当前模型状态
        this.cleanupCurrentModel();
        
        // 设置新的模型类型
        this.setModelType(newType);
        
        // 重置初始化状态与模型标记，确保能够重新初始化目标模型
        this.isInitialized = false;
        // 关键修复：切换后强制重置两个模型的初始化标记
        // 原因：之前在initVRMModel/initLive2DModel中使用了"已初始化则直接返回"的短路逻辑，
        // 导致从Live2D切换回VRM时不会再次初始化，从而看起来“切不回VRM”。
        this.vrmInitialized = false;
        this.live2dInitialized = false;
        
        // 初始化新模型
        await this.initCurrentModel();
        
        // 更新控制面板
        this.updateControlPanels();
        
        console.log(`模型切换完成: ${newType}`);
    }
    
    // 清理当前模型状态
    cleanupCurrentModel() {
        console.log(`清理模型状态: ${this.currentModelType}`);
        
        if (this.currentModelType === 'vrm') {
            // 清理VRM模型
            if (window.vrmManager && window.vrmManager.currentModel) {
                window.vrmManager.clearCurrentModel();
            }
        }
        // Live2D模型不需要特殊清理
    }
    
    // 显示Live2D容器
    showLive2DContainer() {
        const live2dContainer = document.getElementById('live2d-container');
        if (live2dContainer) {
            live2dContainer.style.display = 'block';
            live2dContainer.classList.remove('minimized');
            // 若PIXI已创建，确保渲染器尺寸与容器匹配
            try {
                const pixiApp = window.live2dManager && window.live2dManager.getPIXIApp ? window.live2dManager.getPIXIApp() : null;
                if (pixiApp && pixiApp.renderer) {
                    const w = live2dContainer.clientWidth || 320;
                    const h = live2dContainer.clientHeight || 240;
                    pixiApp.renderer.resize(w, h);
                }
            } catch (_) {}
        }
    }
    
    // 隐藏Live2D容器
    hideLive2DContainer() {
        const live2dContainer = document.getElementById('live2d-container');
        if (live2dContainer) {
            live2dContainer.style.display = 'none';
            live2dContainer.classList.add('minimized');
        }
    }
    
    // 显示VRM容器
    showVRMContainer() {
        const vrmContainer = document.getElementById('vrm-container');
        if (vrmContainer) {
            vrmContainer.style.display = 'block';
            // 防止容器尺寸为0导致渲染器初始化失败
            if (!vrmContainer.clientWidth || !vrmContainer.clientHeight) {
                if (!vrmContainer.style.minWidth) vrmContainer.style.minWidth = '320px';
                if (!vrmContainer.style.minHeight) vrmContainer.style.minHeight = '240px';
            }
        }
    }
    
    // 隐藏VRM容器
    hideVRMContainer() {
        const vrmContainer = document.getElementById('vrm-container');
        if (vrmContainer) {
            vrmContainer.style.display = 'none';
        }
    }

    // 更新控制面板
    updateControlPanels() {
        // 显示/隐藏对应的控制面板
        const live2dPanel = document.getElementById('live2d-control-panel');
        const vrmPanel = document.getElementById('vrm-control-panel');
        
        if (this.currentModelType === 'live2d') {
            if (live2dPanel) live2dPanel.style.display = 'flex';
            if (vrmPanel) vrmPanel.style.display = 'none';
            
            // 添加Live2D模型切换按钮
            addModelSwitchButton();
        } else {
            if (live2dPanel) live2dPanel.style.display = 'none';
            if (vrmPanel) vrmPanel.style.display = 'flex';
            
            // 添加VRM模型切换按钮
            addModelSwitchButtonToVRM();
            // 面板显示后尝试填充专业动作库按钮
            try { populateVRMClipButtons(); } catch (e) { console.warn('更新面板时填充AnimationClip按钮失败:', e); }
        }
        
        // 更新模型切换按钮文本
        const switchBtn = document.getElementById('model-switch-btn');
        const vrmSwitchBtn = document.getElementById('vrm-model-switch-btn');
        
        if (switchBtn) {
        switchBtn.innerHTML = this.currentModelType === 'live2d' ? (window.I18N ? I18N.t('switch_to_vrm') : '切换到VRM模型') : (window.I18N ? I18N.t('switch_to_live2d') : '切换到Live2D模型');
        }
        
        if (vrmSwitchBtn) {
        vrmSwitchBtn.innerHTML = this.currentModelType === 'vrm' ? (window.I18N ? I18N.t('switch_to_live2d') : '切换到Live2D模型') : (window.I18N ? I18N.t('switch_to_vrm') : '切换到VRM模型');
        }
    }
}

// 简易翻译助手与语言变更响应
const t = (key, fallback) => (window.I18N ? I18N.t(key) : fallback);
function applyI18NToControlPanels() {
    // 静态标签与占位符
    document.querySelectorAll('[data-i18n-key]').forEach(el => {
        const key = el.getAttribute('data-i18n-key');
        const fallback = el.getAttribute('data-i18n-fallback') || el.textContent;
        const text = t(key, fallback);
        if (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'search')) {
            el.placeholder = text;
        } else {
            el.textContent = text;
        }
    });
    // 动态按钮
    const liveToggle = document.getElementById('live2d-toggle-btn');
    if (liveToggle) {
        const isHidden = liveToggle.getAttribute('data-status') === 'hidden';
        liveToggle.textContent = isHidden ? t('show_character', '显示人物') : t('hide_character', '隐藏人物');
    }
    const vrmToggle = document.getElementById('vrm-toggle-btn');
    if (vrmToggle) {
        const isHidden = vrmToggle.getAttribute('data-status') === 'hidden';
        vrmToggle.textContent = isHidden ? t('show_model', '显示') : t('hide_model', '隐藏');
    }
    const lockBtn = document.getElementById('vrm-lock-toggle');
    if (lockBtn && window.vrmManager) {
        lockBtn.textContent = window.vrmManager.isLocked ? t('unlock_model', '解锁模型') : t('lock_model', '锁定模型');
    }
}
  window.addEventListener('ee:language-changed', applyI18NToControlPanels);

    // 全局：添加VRM模型切换按钮（供控制面板调用）
    function addModelSwitchButtonToVRM() {
        // 检查是否已存在模型切换按钮
        if (document.getElementById('vrm-model-switch-btn')) return;
        let controlPanel = document.getElementById('vrm-control-panel');
        // 不再进行兜底创建，统一由 createControlPanels 负责一次性创建
        if (!controlPanel) {
            console.warn('VRM控制面板未找到，无法添加模型切换按钮');
            return;
        }
        const switchBtn = document.createElement('button');
        switchBtn.id = 'vrm-model-switch-btn';
        switchBtn.innerHTML = (window.I18N ? I18N.t('switch_to_live2d') : '切换到Live2D模型');
        switchBtn.style.padding = '8px 12px';
        switchBtn.style.borderRadius = '4px';
        switchBtn.style.border = 'none';
        switchBtn.style.backgroundColor = '#9C27B0';
        switchBtn.style.color = 'white';
        switchBtn.style.cursor = 'pointer';
        switchBtn.onclick = async () => {
            if (window.modelManager && typeof window.modelManager.switchModel === 'function') {
                await window.modelManager.switchModel();
            }
        };
        console.log('添加VRM模型切换按钮');
        controlPanel.appendChild(switchBtn);
    }

    // 全局：添加Live2D模型切换按钮（供控制面板调用）
    function addModelSwitchButton() {
        // 检查是否已存在模型切换按钮
        if (document.getElementById('model-switch-btn')) return;
        const controlPanel = document.getElementById('live2d-control-panel');
        if (!controlPanel) {
            console.warn('Live2D控制面板未找到，无法添加模型切换按钮');
            return;
        }
        const switchBtn = document.createElement('button');
        switchBtn.id = 'model-switch-btn';
        switchBtn.innerHTML = (window.I18N ? I18N.t('switch_to_vrm') : '切换到VRM模型');
        switchBtn.style.padding = '8px 12px';
        switchBtn.style.borderRadius = '4px';
        switchBtn.style.border = 'none';
        switchBtn.style.backgroundColor = '#9C27B0';
        switchBtn.style.color = 'white';
        switchBtn.style.cursor = 'pointer';
        switchBtn.onclick = async () => {
            if (window.modelManager && typeof window.modelManager.switchModel === 'function') {
                await window.modelManager.switchModel();
            }
        };
        console.log('添加Live2D模型切换按钮');
        controlPanel.appendChild(switchBtn);
    }

    // 创建控制面板
    function createControlPanels() {
        console.log('创建控制面板');
        
        // 创建Live2D控制面板
        if (!document.getElementById('live2d-control-panel')) {
            createLive2dControls();
        }
        
        // 创建VRM控制面板
        if (!document.getElementById('vrm-control-panel')) {
            createVRMControls();
        }
        
        // 更新控制面板显示状态
        if (window.modelManager) {
            window.modelManager.updateControlPanels();
        }
    }
    
    // 创建Live2D控制面板
    function createLive2dControls() {
        // 检查是否已存在控制面板
        if (document.getElementById('live2d-control-panel')) return;
        
        const controlPanel = document.createElement('div');
        controlPanel.id = 'live2d-control-panel';
        controlPanel.className = 'control-panel';
        controlPanel.style.display = window.modelManager && window.modelManager.getModelType() === 'live2d' ? 'flex' : 'none';
        
        // 添加标题
        const title = document.createElement('h3');
        title.setAttribute('data-i18n-key', 'live2d_title');
        title.setAttribute('data-i18n-fallback', 'Live2D 控制');
        title.textContent = t('live2d_title', 'Live2D 控制');
        controlPanel.appendChild(title);
        
        // 显示/隐藏按钮
        const toggleGroup = document.createElement('div');
        toggleGroup.className = 'control-group';
        
        const toggleRow = document.createElement('div');
        toggleRow.className = 'control-row';
        
        const toggleLabel = document.createElement('span');
        toggleLabel.className = 'control-label';
        toggleLabel.setAttribute('data-i18n-key', 'show_hide');
        toggleLabel.setAttribute('data-i18n-fallback', '显示/隐藏');
        toggleLabel.textContent = t('show_hide', '显示/隐藏');
        
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'control-button';
        toggleBtn.id = 'live2d-toggle-btn';
        toggleBtn.setAttribute('data-status', 'visible');
        toggleBtn.textContent = t('hide_character', '隐藏人物');
        toggleBtn.onclick = toggleLive2d;
        
        toggleRow.appendChild(toggleLabel);
        toggleRow.appendChild(toggleBtn);
        toggleGroup.appendChild(toggleRow);
        controlPanel.appendChild(toggleGroup);
        
        // 大小调整控制
        const sizeGroup = document.createElement('div');
        sizeGroup.className = 'control-group';
        
        const sizeLabel = document.createElement('div');
        sizeLabel.className = 'control-label';
        sizeLabel.setAttribute('data-i18n-key', 'size_adjust');
        sizeLabel.setAttribute('data-i18n-fallback', '大小调整');
        sizeLabel.textContent = t('size_adjust', '大小调整');
        sizeGroup.appendChild(sizeLabel);
        
        const sizeControls = document.createElement('div');
        sizeControls.className = 'control-row';
        
        const decreaseBtn = document.createElement('button');
        decreaseBtn.className = 'control-button';
        decreaseBtn.innerHTML = '-';
        decreaseBtn.onclick = () => resizeLive2d(-0.1);
        
        const scaleInfo = document.createElement('span');
        scaleInfo.id = 'live2d-scale-info';
        scaleInfo.textContent = '90%';
        scaleInfo.style.backgroundColor = 'rgba(255, 255, 255, 0.7)';
        scaleInfo.style.padding = '5px';
        scaleInfo.style.borderRadius = '4px';
        scaleInfo.style.fontSize = '0.8rem';
        scaleInfo.style.minWidth = '40px';
        scaleInfo.style.textAlign = 'center';
        
        const increaseBtn = document.createElement('button');
        increaseBtn.className = 'control-button';
        increaseBtn.innerHTML = '+';
        increaseBtn.onclick = () => resizeLive2d(0.1);
        
        sizeControls.appendChild(decreaseBtn);
        sizeControls.appendChild(scaleInfo);
        sizeControls.appendChild(increaseBtn);
        sizeGroup.appendChild(sizeControls);
        controlPanel.appendChild(sizeGroup);
        
        // 自动隐藏开关
        const autoHideGroup = document.createElement('div');
        autoHideGroup.className = 'control-group';
        
        const autoHideRow = document.createElement('div');
        autoHideRow.className = 'control-row';
        
        const autoHideLabel = document.createElement('span');
        autoHideLabel.className = 'control-label';
        autoHideLabel.setAttribute('data-i18n-key', 'autohide');
        autoHideLabel.setAttribute('data-i18n-fallback', '自动隐藏');
        autoHideLabel.textContent = t('autohide', '自动隐藏');
        
        const autoHideBtn = document.createElement('button');
        autoHideBtn.id = 'live2d-autohide-btn';
        autoHideBtn.className = 'control-button secondary';
        autoHideBtn.textContent = t('close', '关闭');
        autoHideBtn.onclick = toggleAutoHide;
        
        autoHideRow.appendChild(autoHideLabel);
        autoHideRow.appendChild(autoHideBtn);
        autoHideGroup.appendChild(autoHideRow);
        controlPanel.appendChild(autoHideGroup);
        
        // 情绪切换
        const emotionGroup = document.createElement('div');
        emotionGroup.className = 'control-group';
        const emotionLabel = document.createElement('span');
        emotionLabel.className = 'control-label';
        emotionLabel.setAttribute('data-i18n-key', 'emotion');
        emotionLabel.setAttribute('data-i18n-fallback', '情绪');
        emotionLabel.textContent = t('emotion', '情绪');
        const emotionRow = document.createElement('div');
        emotionRow.className = 'control-row';
        const emotions = [
            { key: 'happy', label: 'joy' },
            { key: 'sad', label: 'sorrow' },
            { key: 'angry', label: 'angry' },
            { key: 'surprised', label: 'surprised' },
            { key: 'relaxed', label: 'relaxed' },
        ];
        emotions.forEach(e => {
            const b = document.createElement('button');
            b.className = 'control-button';
            b.setAttribute('data-i18n-key', e.key);
            b.setAttribute('data-i18n-fallback', e.label);
            b.textContent = t(e.key, e.label);
            b.onclick = () => {
                try {
                    if (window.live2dManager && typeof window.live2dManager.setEmotion === 'function') {
                        window.live2dManager.setEmotion(e.key);
                    } else if (window.LanLan1 && typeof window.LanLan1.setEmotion === 'function') {
                        window.LanLan1.setEmotion(e.key);
                    }
                } catch (err) { console.warn('切换情绪失败', err); }
            };
            emotionRow.appendChild(b);
        });
        emotionGroup.appendChild(emotionLabel);
        emotionGroup.appendChild(emotionRow);
        controlPanel.appendChild(emotionGroup);

        // 眨眼按钮
        const blinkGroup = document.createElement('div');
        blinkGroup.className = 'control-group';
        const blinkRow = document.createElement('div');
        blinkRow.className = 'control-row';
        const blinkLabel = document.createElement('span');
        blinkLabel.className = 'control-label';
        blinkLabel.setAttribute('data-i18n-key', 'blink_label');
        blinkLabel.setAttribute('data-i18n-fallback', '眨眼');
        blinkLabel.textContent = t('blink_label', '眨眼');
        const blinkBtn = document.createElement('button');
        blinkBtn.className = 'control-button secondary';
        blinkBtn.setAttribute('data-i18n-key', 'blink');
        blinkBtn.setAttribute('data-i18n-fallback', 'blink');
        blinkBtn.textContent = t('blink', 'blink');
        blinkBtn.onclick = () => {
            try {
                const mgr = window.live2dManager;
                const model = mgr && typeof mgr.getCurrentModel === 'function' ? mgr.getCurrentModel() : null;
                if (model && model.internalModel && model.internalModel.coreModel) {
                    const core = model.internalModel.coreModel;
                    core.setParameterValueById('ParamEyeLOpen', 0.0);
                    core.setParameterValueById('ParamEyeROpen', 0.0);
                    setTimeout(() => {
                        core.setParameterValueById('ParamEyeLOpen', 1.0);
                        core.setParameterValueById('ParamEyeROpen', 1.0);
                    }, 150);
                }
            } catch (err) { console.warn('眨眼失败', err); }
        };
        blinkRow.appendChild(blinkLabel);
        blinkRow.appendChild(blinkBtn);
        blinkGroup.appendChild(blinkRow);
        controlPanel.appendChild(blinkGroup);

        // 简易动作
        const actionGroup = document.createElement('div');
        actionGroup.className = 'control-group';
        const actionLabel = document.createElement('span');
        actionLabel.className = 'control-label';
        actionLabel.setAttribute('data-i18n-key', 'action_label');
        actionLabel.setAttribute('data-i18n-fallback', '动作');
        actionLabel.textContent = t('action_label', '动作');
        const actionRow = document.createElement('div');
        actionRow.className = 'control-row';
        const actions = [
            { key: 'wave', label: 'wave' },
            { key: 'nod', label: 'nod' },
            { key: 'shake', label: 'shake' },
            { key: 'bow', label: 'bow' },
        ];
        actions.forEach(a => {
            const b = document.createElement('button');
            b.className = 'control-button';
            b.setAttribute('data-i18n-key', a.key);
            b.setAttribute('data-i18n-fallback', a.label);
            b.textContent = t(a.key, a.label);
            b.onclick = () => live2dPlaySimpleMotion(a.key);
            actionRow.appendChild(b);
        });
        actionGroup.appendChild(actionLabel);
        actionGroup.appendChild(actionRow);
        controlPanel.appendChild(actionGroup);
        
        document.body.appendChild(controlPanel);
        applyI18NToControlPanels();
    }
    
    // 创建VRM控制面板
    function initVRMControls() {
        console.log('初始化VRM控制面板');
        
        // 绑定VRM切换按钮事件（若已通过onclick绑定则不重复绑定）
        const toggleBtn = document.getElementById('vrm-toggle-btn');
        if (toggleBtn && !toggleBtn.onclick) {
            toggleBtn.addEventListener('click', toggleVRM);
        }
        
        // 绑定VRM大小调整按钮事件（若已通过onclick绑定则不重复绑定）
        const enlargeBtn = document.getElementById('vrm-enlarge-btn');
        const shrinkBtn = document.getElementById('vrm-shrink-btn');
        
        if (enlargeBtn && !enlargeBtn.onclick) {
            enlargeBtn.addEventListener('click', () => resizeVRM(0.1));
        }
        
        if (shrinkBtn && !shrinkBtn.onclick) {
            shrinkBtn.addEventListener('click', () => resizeVRM(-0.1));
        }
    }

    // 在页面加载完成后初始化VRM控制面板
    document.addEventListener('DOMContentLoaded', function() {
        initVRMControls();
    });
    
    function createVRMControls() {
        // 强一致的一次性守卫：任何来源的重复调用都直接返回
        if (window.__vrmControlsCreated) {
            return;
        }
        const existingPanel = document.getElementById('vrm-control-panel');
        if (existingPanel) {
            window.__vrmControlsCreated = true;
            return;
        }
        // 检查是否已存在VRM控制面板
        if (document.getElementById('vrm-control-panel')) return;
        
        const controlPanel = document.createElement('div');
        controlPanel.id = 'vrm-control-panel';
        controlPanel.className = 'control-panel';
        controlPanel.style.display = window.modelManager && window.modelManager.getModelType() === 'vrm' ? 'flex' : 'none';
        
        // 添加标题
        const title = document.createElement('h3');
        title.setAttribute('data-i18n-key', 'vrm_title');
        title.setAttribute('data-i18n-fallback', 'VRM 控制');
        title.textContent = t('vrm_title', 'VRM 控制');
        controlPanel.appendChild(title);
        
        // 显示/隐藏按钮
        const toggleGroup = document.createElement('div');
        toggleGroup.className = 'control-group';
        
        const toggleRow = document.createElement('div');
        toggleRow.className = 'control-row';
        
        const toggleLabel = document.createElement('span');
        toggleLabel.className = 'control-label';
        toggleLabel.setAttribute('data-i18n-key', 'show_hide');
        toggleLabel.setAttribute('data-i18n-fallback', '显示/隐藏');
        toggleLabel.textContent = t('show_hide', '显示/隐藏');
        
        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'vrm-toggle-btn';
        toggleBtn.className = 'control-button';
        toggleBtn.textContent = t('hide_model', '隐藏');
        toggleBtn.setAttribute('data-status', 'visible');
        toggleBtn.onclick = toggleVRM;
        
        toggleRow.appendChild(toggleLabel);
        toggleRow.appendChild(toggleBtn);
        toggleGroup.appendChild(toggleRow);
        controlPanel.appendChild(toggleGroup);
        
        // VRM大小调整控制
        const sizeGroup = document.createElement('div');
        sizeGroup.className = 'control-group';
        
        const sizeLabel = document.createElement('div');
        sizeLabel.className = 'control-label';
        sizeLabel.setAttribute('data-i18n-key', 'size_adjust');
        sizeLabel.setAttribute('data-i18n-fallback', '大小调整');
        sizeLabel.textContent = t('size_adjust', '大小调整');
        sizeGroup.appendChild(sizeLabel);
        
        const sizeControls = document.createElement('div');
        sizeControls.className = 'control-row';
        
        const decreaseBtn = document.createElement('button');
        decreaseBtn.className = 'control-button';
        decreaseBtn.id = 'vrm-shrink-btn';
        decreaseBtn.innerHTML = '-';
        decreaseBtn.onclick = () => resizeVRM(-0.1);
        
        const scaleInfo = document.createElement('span');
        scaleInfo.id = 'vrm-scale-info';
        scaleInfo.textContent = '90%';
        scaleInfo.style.backgroundColor = 'rgba(255, 255, 255, 0.7)';
        scaleInfo.style.padding = '5px';
        scaleInfo.style.borderRadius = '4px';
        scaleInfo.style.fontSize = '0.8rem';
        scaleInfo.style.minWidth = '40px';
        scaleInfo.style.textAlign = 'center';
        
        const increaseBtn = document.createElement('button');
        increaseBtn.className = 'control-button';
        increaseBtn.id = 'vrm-enlarge-btn';
        increaseBtn.innerHTML = '+';
        increaseBtn.onclick = () => resizeVRM(0.1);
        
        sizeControls.appendChild(decreaseBtn);
        sizeControls.appendChild(scaleInfo);
        sizeControls.appendChild(increaseBtn);
        sizeGroup.appendChild(sizeControls);
        controlPanel.appendChild(sizeGroup);
        
        // 自动隐藏开关
        const autoHideGroup = document.createElement('div');
        autoHideGroup.className = 'control-group';
        
        const autoHideRow = document.createElement('div');
        autoHideRow.className = 'control-row';
        
        const autoHideLabel = document.createElement('span');
        autoHideLabel.className = 'control-label';
        autoHideLabel.setAttribute('data-i18n-key', 'autohide');
        autoHideLabel.setAttribute('data-i18n-fallback', '自动隐藏');
        autoHideLabel.textContent = t('autohide', '自动隐藏');
        
        const autoHideBtn = document.createElement('button');
        autoHideBtn.id = 'vrm-autohide-btn';
        autoHideBtn.className = 'control-button secondary';
        autoHideBtn.textContent = t('close', '关闭');
        autoHideBtn.onclick = toggleAutoHide;
        
        autoHideRow.appendChild(autoHideLabel);
        autoHideRow.appendChild(autoHideBtn);
        autoHideGroup.appendChild(autoHideRow);
        controlPanel.appendChild(autoHideGroup);
        
        // 动作测试（基础动作）
        const actionGroup = document.createElement('div');
        actionGroup.className = 'control-group';
        const actionLabel = document.createElement('div');
        actionLabel.className = 'control-label';
        actionLabel.setAttribute('data-i18n-key', 'action_test');
        actionLabel.setAttribute('data-i18n-fallback', '动作测试');
        actionLabel.textContent = t('action_test', '动作测试');
        actionGroup.appendChild(actionLabel);
        const actionRow = document.createElement('div');
        actionRow.className = 'control-row';
        const actions = [
            { key: 'wave', text: '挥手' },
            { key: 'nod', text: '点头' },
            { key: 'shake', text: '摇头' },
            { key: 'bow', text: '鞠躬' }
        ];
        actions.forEach(a => {
            const btn = document.createElement('button');
            btn.className = 'control-button';
            btn.setAttribute('data-i18n-key', a.key);
            btn.setAttribute('data-i18n-fallback', a.text);
            btn.textContent = t(a.key, a.text);
            btn.onclick = () => playVRMAnimation(a.key);
            actionRow.appendChild(btn);
        });
        actionGroup.appendChild(actionRow);
        controlPanel.appendChild(actionGroup);

        // 表情测试
        const emotionGroup = document.createElement('div');
        emotionGroup.className = 'control-group';
        const emotionLabel = document.createElement('div');
        emotionLabel.className = 'control-label';
        emotionLabel.setAttribute('data-i18n-key', 'emotion_test');
        emotionLabel.setAttribute('data-i18n-fallback', '表情测试');
        emotionLabel.textContent = t('emotion_test', '表情测试');
        emotionGroup.appendChild(emotionLabel);
        const emotionRow = document.createElement('div');
        emotionRow.className = 'control-row';
        const emotions = [
            { key: 'neutral', text: '中性' },
            { key: 'happy', text: '开心' },
            { key: 'sad', text: '悲伤' },
            { key: 'angry', text: '生气' },
            { key: 'surprised', text: '惊讶' },
            { key: 'relaxed', text: '放松' }
        ];
        emotions.forEach(e => {
            const btn = document.createElement('button');
            btn.className = 'control-button secondary';
            btn.setAttribute('data-i18n-key', e.key);
            btn.setAttribute('data-i18n-fallback', e.text);
            btn.textContent = t(e.key, e.text);
            btn.onclick = () => setVRMEmotion(e.key);
            emotionRow.appendChild(btn);
        });
        emotionGroup.appendChild(emotionRow);
        controlPanel.appendChild(emotionGroup);

        // 眨眼控制
        const blinkGroup = document.createElement('div');
        blinkGroup.className = 'control-group';
        const blinkLabel = document.createElement('div');
        blinkLabel.className = 'control-label';
        blinkLabel.setAttribute('data-i18n-key', 'blink_label');
        blinkLabel.setAttribute('data-i18n-fallback', '眨眼');
        blinkLabel.textContent = t('blink_label', '眨眼');
        blinkGroup.appendChild(blinkLabel);
        const blinkRow = document.createElement('div');
        blinkRow.className = 'control-row';
        const blinkOnceBtn = document.createElement('button');
        blinkOnceBtn.className = 'control-button';
        blinkOnceBtn.setAttribute('data-i18n-key', 'blink_once');
        blinkOnceBtn.setAttribute('data-i18n-fallback', '眨一下');
        blinkOnceBtn.textContent = t('blink_once', '眨一下');
        blinkOnceBtn.onclick = blinkOnce;
        const blinkSlider = document.createElement('input');
        blinkSlider.type = 'range';
        blinkSlider.min = '0';
        blinkSlider.max = '100';
        blinkSlider.value = '0';
        blinkSlider.style.width = '120px';
        blinkSlider.oninput = (e) => setVRMBlink(parseInt(e.target.value, 10) / 100);
        blinkRow.appendChild(blinkOnceBtn);
        blinkRow.appendChild(blinkSlider);
        blinkGroup.appendChild(blinkRow);
        controlPanel.appendChild(blinkGroup);

        // 口型控制
        const mouthGroup = document.createElement('div');
        mouthGroup.className = 'control-group';
        const mouthLabel = document.createElement('div');
        mouthLabel.className = 'control-label';
        mouthLabel.setAttribute('data-i18n-key', 'mouth_label');
        mouthLabel.setAttribute('data-i18n-fallback', '口型 (张口/元音)');
        mouthLabel.textContent = t('mouth_label', '口型 (张口/元音)');
        mouthGroup.appendChild(mouthLabel);
        const mouthRow = document.createElement('div');
        mouthRow.className = 'control-row';
        const mouthSlider = document.createElement('input');
        mouthSlider.type = 'range';
        mouthSlider.min = '0';
        mouthSlider.max = '100';
        mouthSlider.value = '0';
        mouthSlider.style.width = '120px';
        mouthSlider.oninput = (e) => setVRMMouth(parseInt(e.target.value, 10) / 100);
        mouthRow.appendChild(mouthSlider);
        const vowels = [
            { key: 'a', text: 'A' },
            { key: 'e', text: 'E' },
            { key: 'i', text: 'I' },
            { key: 'o', text: 'O' },
            { key: 'u', text: 'U' }
        ];
        vowels.forEach(v => {
            const btn = document.createElement('button');
            btn.className = 'control-button secondary';
            btn.textContent = v.text;
            btn.onclick = () => setVRMVowel(v.key);
            mouthRow.appendChild(btn);
        });
        mouthGroup.appendChild(mouthRow);
        controlPanel.appendChild(mouthGroup);

        // 导入VRM模型
        const importGroup = document.createElement('div');
        importGroup.className = 'control-group';
        const importLabel = document.createElement('div');
        importLabel.className = 'control-label';
        importLabel.setAttribute('data-i18n-key', 'import_vrm');
        importLabel.setAttribute('data-i18n-fallback', '导入VRM模型');
        importLabel.textContent = t('import_vrm', '导入VRM模型');
        importGroup.appendChild(importLabel);
        const importRow = document.createElement('div');
        importRow.className = 'control-row';
        importRow.style.flexWrap = 'wrap';
        const importFile = document.createElement('input');
        importFile.type = 'file';
        importFile.accept = '.vrm';
        importFile.id = 'vrm-model-import-file';
        importFile.style.cursor = 'pointer';
        const importFileBtn = document.createElement('button');
        importFileBtn.className = 'control-button';
        importFileBtn.setAttribute('data-i18n-key', 'choose_and_load');
        importFileBtn.setAttribute('data-i18n-fallback', '选择并加载');
        importFileBtn.textContent = t('choose_and_load', '选择并加载');
        importFileBtn.style.backgroundColor = '#00796B';
        importFileBtn.style.color = 'white';
        importFileBtn.onclick = async () => {
            try {
                const fileInput = document.getElementById('vrm-model-import-file');
                const file = fileInput && fileInput.files && fileInput.files[0];
                if (!file) { console.warn('请先选择VRM文件'); return; }
                const url = URL.createObjectURL(file);
                if (!window.vrmManager || typeof window.vrmManager.loadModel !== 'function') {
                    console.error('VRM管理器未就绪或不支持loadModel');
                    return;
                }
                await window.vrmManager.loadModel(url);
                window.vrmManager.modelUrl = url;
                console.log('已加载VRM模型(文件):', file.name);
            } catch (e) {
                console.warn('从文件加载VRM失败:', e);
            }
        };
        const importUrlBtn = document.createElement('button');
        importUrlBtn.className = 'control-button secondary';
        importUrlBtn.setAttribute('data-i18n-key', 'load_vrm_from_url');
        importUrlBtn.setAttribute('data-i18n-fallback', '从URL加载VRM');
        importUrlBtn.textContent = t('load_vrm_from_url', '从URL加载VRM');
        importUrlBtn.style.backgroundColor = '#0069c0';
        importUrlBtn.style.color = 'white';
        importUrlBtn.onclick = () => {
            let modal = document.getElementById('vrm-model-url-modal');
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'vrm-model-url-modal';
                Object.assign(modal.style, {
                    position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                    background: 'rgba(255,255,255,0.95)', padding: '14px', borderRadius: '10px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 1000, width: '90%', maxWidth: '420px'
                });
                const title = document.createElement('div');
                title.setAttribute('data-i18n-key', 'url_modal_title');
                title.setAttribute('data-i18n-fallback', '从URL加载VRM模型');
                title.textContent = t('url_modal_title', '从URL加载VRM模型');
                title.style.marginBottom = '8px';
                title.style.fontSize = '14px';
                const urlInput = document.createElement('input');
                urlInput.type = 'text';
                urlInput.setAttribute('data-i18n-key', 'url_placeholder');
                urlInput.setAttribute('data-i18n-fallback', '输入远程VRM URL或相对路径');
                urlInput.placeholder = t('url_placeholder', '输入远程VRM URL或相对路径');
                urlInput.style.width = '100%';
                urlInput.style.margin = '8px 0';
                urlInput.style.padding = '6px 8px';
                urlInput.style.borderRadius = '4px';
                urlInput.style.border = '1px solid #ccc';
                const btnRow = document.createElement('div');
                btnRow.style.display = 'flex';
                btnRow.style.justifyContent = 'flex-end';
                btnRow.style.gap = '8px';
                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'control-button secondary';
                cancelBtn.setAttribute('data-i18n-key', 'cancel');
                cancelBtn.setAttribute('data-i18n-fallback', '取消');
                cancelBtn.textContent = t('cancel', '取消');
                cancelBtn.onclick = () => { modal.remove(); };
                const confirmBtn = document.createElement('button');
                confirmBtn.className = 'control-button';
                confirmBtn.setAttribute('data-i18n-key', 'load');
                confirmBtn.setAttribute('data-i18n-fallback', '加载');
                confirmBtn.textContent = t('load', '加载');
                confirmBtn.onclick = async () => {
                    try {
                        const url = urlInput.value && urlInput.value.trim();
                        if (!url) { console.warn('未填写URL'); return; }
                        if (!window.vrmManager || typeof window.vrmManager.loadModel !== 'function') {
                            console.error('VRM管理器未就绪或不支持loadModel');
                            return;
                        }
                        await window.vrmManager.loadModel(url);
                        window.vrmManager.modelUrl = url;
                        console.log('已加载VRM模型(URL):', url);
                        modal.remove();
                    } catch (e) {
                        console.warn('从URL加载VRM失败:', e);
                    }
                };
                btnRow.appendChild(cancelBtn);
                btnRow.appendChild(confirmBtn);
                modal.appendChild(title);
                modal.appendChild(urlInput);
                modal.appendChild(btnRow);
                document.body.appendChild(modal);
            }
        };
        importRow.appendChild(importFile);
        importRow.appendChild(importFileBtn);
        importRow.appendChild(importUrlBtn);
        importGroup.appendChild(importRow);
        controlPanel.appendChild(importGroup);

        // 导入动作 (VRMA)
        const vrmaImportGroup = document.createElement('div');
        vrmaImportGroup.className = 'control-group';
        const vrmaImportLabel = document.createElement('div');
        vrmaImportLabel.className = 'control-label';
        vrmaImportLabel.setAttribute('data-i18n-key', 'import_vrma');
        vrmaImportLabel.setAttribute('data-i18n-fallback', '导入动作 (VRMA)');
        vrmaImportLabel.textContent = t('import_vrma', '导入动作 (VRMA)');
        vrmaImportGroup.appendChild(vrmaImportLabel);
        const vrmaImportRow1 = document.createElement('div');
        vrmaImportRow1.className = 'control-row';
        vrmaImportRow1.style.flexWrap = 'wrap';
        const vrmaFileInput = document.createElement('input');
        vrmaFileInput.type = 'file';
        vrmaFileInput.accept = '.vrma';
        vrmaFileInput.id = 'vrma-file-input';
        const vrmaFileBtn = document.createElement('button');
        vrmaFileBtn.className = 'control-button';
        vrmaFileBtn.setAttribute('data-i18n-key', 'choose_and_import');
        vrmaFileBtn.setAttribute('data-i18n-fallback', '选择并导入');
        vrmaFileBtn.textContent = t('choose_and_import', '选择并导入');
        vrmaFileBtn.style.backgroundColor = '#3949AB';
        vrmaFileBtn.style.color = 'white';
        vrmaFileBtn.onclick = async () => {
            try {
                const file = document.getElementById('vrma-file-input')?.files?.[0];
                if (!file) { console.warn('请先选择 .vrma 文件'); return; }
                if (!window.vrmManager || typeof window.vrmManager.playVRMAFile !== 'function') {
                    console.error('VRM管理器未就绪或不支持 VRMA 播放');
                    return;
                }
                const ok = await window.vrmManager.playVRMAFile(file);
                console.log('本地VRMA播放结果:', ok);
            } catch (e) { console.warn('播放本地VRMA失败:', e); }
        };
        vrmaImportRow1.appendChild(vrmaFileInput);
        vrmaImportRow1.appendChild(vrmaFileBtn);
        vrmaImportGroup.appendChild(vrmaImportRow1);

        const vrmaImportRow2 = document.createElement('div');
        vrmaImportRow2.className = 'control-row';
        vrmaImportRow2.style.flexWrap = 'wrap';
        const vrmaPathInput = document.createElement('input');
        vrmaPathInput.type = 'text';
        vrmaPathInput.setAttribute('data-i18n-key', 'vrma_path_placeholder');
        vrmaPathInput.setAttribute('data-i18n-fallback', '输入 VRMA 路径或 URL，例如 /static/animations/excited.vrma');
        vrmaPathInput.placeholder = t('vrma_path_placeholder', '输入 VRMA 路径或 URL，例如 /static/animations/excited.vrma');
        vrmaPathInput.id = 'vrma-path-input';
        vrmaPathInput.style.flex = '1';
        vrmaPathInput.style.padding = '6px 8px';
        vrmaPathInput.style.borderRadius = '4px';
        vrmaPathInput.style.border = '1px solid #ccc';
        const vrmaPathBtn = document.createElement('button');
        vrmaPathBtn.className = 'control-button secondary';
        vrmaPathBtn.setAttribute('data-i18n-key', 'play_from_path');
        vrmaPathBtn.setAttribute('data-i18n-fallback', '从路径/URL播放');
        vrmaPathBtn.textContent = t('play_from_path', '从路径/URL播放');
        vrmaPathBtn.onclick = async () => {
            try {
                let p = (document.getElementById('vrma-path-input')?.value || '').trim();
                if (!p) { console.warn('未填写VRMA路径'); return; }
                // 兼容 Windows 路径写法
                p = p.replace(/\\/g, '/');
                if (p.startsWith('static/')) p = '/' + p; // 补前导斜杠
                if (!window.vrmManager || typeof window.vrmManager.playVRMAUrl !== 'function') {
                    console.error('VRM管理器未就绪或不支持 VRMA 播放');
                    return;
                }
                const ok = await window.vrmManager.playVRMAUrl(p);
                console.log('路径/URL VRMA播放结果:', ok);
            } catch (e) { console.warn('播放VRMA失败:', e); }
        };
        // 预填常用测试路径
        vrmaPathInput.value = '/static/animations/excited.vrma';
        vrmaImportRow2.appendChild(vrmaPathInput);
        vrmaImportRow2.appendChild(vrmaPathBtn);
        vrmaImportGroup.appendChild(vrmaImportRow2);

        controlPanel.appendChild(vrmaImportGroup);

        // 移除“动作控制”基础按钮（挥手/点头/摇头）

        // 应用户要求：移除“专业动作库 (AnimationClip)”区块
        // 前端不再显示该模块，避免无效或误导的按钮。

        // 渲染控制（色调映射/曝光/HDR环境）
        const renderGroup = document.createElement('div');
        renderGroup.className = 'control-group';
        const renderLabel = document.createElement('div');
        renderLabel.className = 'control-label';
        renderLabel.setAttribute('data-i18n-key', 'render_label');
        renderLabel.setAttribute('data-i18n-fallback', '渲染控制');
        renderLabel.textContent = t('render_label', '渲染控制');
        renderGroup.appendChild(renderLabel);
        const renderRow1 = document.createElement('div');
        renderRow1.className = 'control-row';
        const toneSelect = document.createElement('select');
        toneSelect.id = 'vrm-tone-select';
        [
            { k: 'none', t: 'None' },
            { k: 'linear', t: 'Linear' },
            { k: 'reinhard', t: 'Reinhard' },
            { k: 'cineon', t: 'Cineon' },
            { k: 'aces', t: 'ACES' }
        ].forEach(opt => {
            const o = document.createElement('option');
            o.value = opt.k; o.text = opt.t;
            if (opt.k === 'aces') o.selected = true;
            toneSelect.appendChild(o);
        });
        toneSelect.onchange = (e) => applyVRMToneMapping(e.target.value);
        const exposureSlider = document.createElement('input');
        exposureSlider.type = 'range'; exposureSlider.min = '0'; exposureSlider.max = '200'; exposureSlider.value = '100';
        exposureSlider.style.width = '120px';
        exposureSlider.oninput = (e) => applyVRMExposure(parseInt(e.target.value, 10) / 100);
        renderRow1.appendChild(toneSelect);
        renderRow1.appendChild(exposureSlider);
        renderGroup.appendChild(renderRow1);

        const renderRow2 = document.createElement('div');
        renderRow2.className = 'control-row';
        const hdrInput = document.createElement('input');
        hdrInput.type = 'text';
        hdrInput.setAttribute('data-i18n-key', 'hdr_placeholder');
        hdrInput.setAttribute('data-i18n-fallback', 'HDR URL，例如 /static/hdr/studio.hdr');
        hdrInput.placeholder = t('hdr_placeholder', 'HDR URL，例如 /static/hdr/studio.hdr');
        hdrInput.style.flex = '1'; hdrInput.id = 'vrm-hdr-input';
        const hdrApplyBtn = document.createElement('button');
        hdrApplyBtn.className = 'control-button';
        hdrApplyBtn.setAttribute('data-i18n-key', 'apply_hdr');
        hdrApplyBtn.setAttribute('data-i18n-fallback', '应用HDR');
        hdrApplyBtn.textContent = t('apply_hdr', '应用HDR');
        hdrApplyBtn.onclick = () => {
            const url = document.getElementById('vrm-hdr-input').value;
            applyVRMHDR(url);
        };
        const hdrFileInput = document.createElement('input');
        hdrFileInput.type = 'file'; hdrFileInput.accept = '.hdr,.jpg,.jpeg,.png';
        hdrFileInput.style.maxWidth = '200px'; hdrFileInput.id = 'vrm-hdr-file-input';
        const hdrFileBtn = document.createElement('button');
        hdrFileBtn.className = 'control-button';
        hdrFileBtn.setAttribute('data-i18n-key', 'apply_from_file');
        hdrFileBtn.setAttribute('data-i18n-fallback', '从文件应用');
        hdrFileBtn.textContent = t('apply_from_file', '从文件应用');
        hdrFileBtn.onclick = () => {
            const f = hdrFileInput.files && hdrFileInput.files[0];
            if (!f) { console.warn('请先选择文件'); return; }
            applyVRMEnvironmentFile(f);
        };
        const hdrClearBtn = document.createElement('button');
        hdrClearBtn.className = 'control-button secondary';
        hdrClearBtn.setAttribute('data-i18n-key', 'clear_env');
        hdrClearBtn.setAttribute('data-i18n-fallback', '清空环境');
        hdrClearBtn.textContent = t('clear_env', '清空环境');
        hdrClearBtn.onclick = clearVRMEnvironment;
        renderRow2.appendChild(hdrInput);
        renderRow2.appendChild(hdrApplyBtn);
        renderRow2.appendChild(hdrFileInput);
        renderRow2.appendChild(hdrFileBtn);
        renderRow2.appendChild(hdrClearBtn);
        renderGroup.appendChild(renderRow2);
        controlPanel.appendChild(renderGroup);

        // 位置控制（仅锁定/解锁）
        const moveGroup = document.createElement('div');
        moveGroup.className = 'control-group';
        const moveLabel = document.createElement('div');
        moveLabel.className = 'control-label';
        moveLabel.setAttribute('data-i18n-key', 'position_label');
        moveLabel.setAttribute('data-i18n-fallback', '位置控制');
        moveLabel.textContent = t('position_label', '位置控制');
        moveGroup.appendChild(moveLabel);
        const moveRow = document.createElement('div');
        moveRow.className = 'control-row';
        // 默认启用拖拽，仅通过“锁定”开关禁止移动，逻辑与 Live2D 一致
        try { window.vrmManager && window.vrmManager.enableDrag && window.vrmManager.enableDrag(true); } catch (_) {}

        const lockBtn = document.createElement('button');
        lockBtn.className = 'control-button';
        lockBtn.id = 'vrm-lock-toggle';
        const locked = !!(window.vrmManager && window.vrmManager.isLocked);
        lockBtn.textContent = locked ? t('unlock_model', '解锁模型') : t('lock_model', '锁定模型');
        lockBtn.onclick = () => {
            try {
                if (!window.vrmManager) return;
                window.vrmManager.isLocked = !window.vrmManager.isLocked;
                lockBtn.textContent = window.vrmManager.isLocked ? t('unlock_model', '解锁模型') : t('lock_model', '锁定模型');
            } catch (e) { console.warn('切换锁定失败:', e); }
        };
        moveRow.appendChild(lockBtn);
        moveGroup.appendChild(moveRow);
        controlPanel.appendChild(moveGroup);

        // 已移除：实验功能 VRMA 播放器入口与描述

        // 在创建面板时确保添加切换到Live2D按钮
        try { addModelSwitchButtonToVRM(); } catch (e) { console.warn('添加VRM切换按钮失败:', e); }

        // 若动画库已加载，立即尝试填充按钮
        try { populateVRMClipButtons(); } catch (e) { console.warn('创建面板时填充AnimationClip按钮失败:', e); }
        
        document.body.appendChild(controlPanel);
        applyI18NToControlPanels();
        // 标记已创建，避免后续任何路径重复创建
        window.__vrmControlsCreated = true;
    }


// 创建全局模型管理器实例

// 全局变量定义（统一使用window.currentVRMScale，避免局部变量造成状态不一致）

// 全局函数定义 - 移到全局作用域以便控制面板可以访问
function toggleLive2d() {
    const container = document.getElementById('live2d-container');
    if (container.classList.contains('minimized')) {
        showLive2d();
    } else {
        hideLive2d();
    }
}

function showLive2d() {
    const container = document.getElementById('live2d-container');
    container.classList.remove('minimized');
    
    // 更新控制按钮状态
    const toggleBtn = document.getElementById('live2d-toggle-btn');
    if (toggleBtn) {
        toggleBtn.textContent = t('hide_character', '隐藏人物');
        toggleBtn.setAttribute('data-status', 'visible');
    }
    
    // 如果启用了自动隐藏，设置定时器
    resetAutoHideTimer();
}

function hideLive2d() {
    const container = document.getElementById('live2d-container');
    container.classList.add('minimized');
    
    // 更新控制按钮状态
    const toggleBtn = document.getElementById('live2d-toggle-btn');
    if (toggleBtn) {
        toggleBtn.textContent = t('show_character', '显示人物');
        toggleBtn.setAttribute('data-status', 'hidden');
    }
    
    // 清除自动隐藏计时器
    clearTimeout(window.autoHideTimer);
}

function resizeLive2d(scaleChange) {
    const container = document.getElementById('live2d-container');
    const canvas = document.getElementById('live2d-canvas');
    
    window.currentScale = (window.currentScale || 1) + scaleChange;
    // 限制缩放范围
    if (window.currentScale < 0.5) window.currentScale = 0.5;
    if (window.currentScale > 1.5) window.currentScale = 1.5;
    
    canvas.style.transform = `scale(${window.currentScale})`;
    canvas.style.transformOrigin = 'bottom right';
    
    // 更新大小显示
    const scaleInfo = document.getElementById('live2d-scale-info');
    if (scaleInfo) {
        scaleInfo.textContent = `${Math.round(window.currentScale * 100)}%`;
    }
    
    // 重置自动隐藏计时器
    resetAutoHideTimer();
}

function toggleAutoHide() {
    window.isAutoHideEnabled = !window.isAutoHideEnabled;
    
    const autoHideBtn = document.getElementById('live2d-autohide-btn');
    if (autoHideBtn) {
        autoHideBtn.innerHTML = window.isAutoHideEnabled ? '关闭自动隐藏' : '开启自动隐藏';
    }
    
    if (window.isAutoHideEnabled) {
        resetAutoHideTimer();
    } else {
        clearTimeout(window.autoHideTimer);
    }
}

function resetAutoHideTimer() {
    if (!window.isAutoHideEnabled) return;
    
    clearTimeout(window.autoHideTimer);
    window.autoHideTimer = setTimeout(() => {
        hideLive2d();
    }, 30000); // 30秒后自动隐藏
}

// 触发简单 Live2D 动作（通过角度/点头/摇头/鞠躬）
function live2dPlaySimpleMotion(type) {
    try {
        if (window.live2dManager && typeof window.live2dManager.playSimpleMotion === 'function') {
            window.live2dManager.playSimpleMotion(type);
            return;
        }
        const model = window.live2dManager && window.live2dManager.getCurrentModel ? window.live2dManager.getCurrentModel() : null;
        if (!model || !model.internalModel || !model.internalModel.coreModel) return;
        const core = model.internalModel.coreModel;
        const set = (id, v) => { try { core.setParameterValueById(id, v); } catch (_) {} };
        const clear = () => {
            set('ParamAngleX', 0);
            set('ParamAngleY', 0);
            set('ParamAngleZ', 0);
        };
        clear();
        if (type === 'nod') {
            set('ParamAngleX', 10);
            set('ParamAngleY', 10);
            setTimeout(() => clear(), 400);
        } else if (type === 'shake') {
            set('ParamAngleZ', 15);
            setTimeout(() => { set('ParamAngleZ', -15); }, 200);
            setTimeout(() => clear(), 600);
        } else if (type === 'bow') {
            set('ParamAngleX', 25);
            setTimeout(() => clear(), 500);
        } else if (type === 'wave') {
            set('ParamAngleY', 20);
            setTimeout(() => { set('ParamAngleY', -20); }, 200);
            setTimeout(() => clear(), 600);
        }
    } catch (err) { console.warn('播放简单动作失败', err); }
}

function playVRMAnimation(action) {
    console.log(`播放VRM动画: ${action}`);
    console.log('vrmManager状态:', window.vrmManager);
    console.log('当前模型:', window.vrmManager ? window.vrmManager.currentModel : 'vrmManager不存在');
    
    // 检查当前模型类型是否为VRM
    if (window.modelManager.getModelType() !== 'vrm') {
        console.warn('当前模型不是VRM，无法播放动画');
        return;
    }
    
    // 检查VRM管理器是否存在
    if (!window.vrmManager) {
        console.error('VRM管理器未初始化');
        return;
    }
    
    // 检查当前模型是否存在
    if (!window.vrmManager.currentModel) {
        console.error('VRM模型未加载');
        return;
    }
    
    try {
        // 调用VRM管理器的动画播放方法
        if (typeof window.vrmManager.playAnimation === 'function') {
            window.vrmManager.playAnimation(action);
        } else {
            console.error('VRM管理器没有playAnimation方法');
        }
    } catch (error) {
        console.error('播放VRM动画时出错:', error);
    }
}

function toggleVRM() {
    const container = document.getElementById('vrm-container');
    const toggleBtn = document.getElementById('vrm-toggle-btn');
    
    if (!container || !toggleBtn) {
        console.error('VRM容器或切换按钮未找到');
        return;
    }
    
    // 检查当前模型类型是否为VRM
    if (window.modelManager.getModelType() !== 'vrm') {
        console.warn('当前模型不是VRM，无法切换显示状态');
        return;
    }
    
    const currentStatus = toggleBtn.getAttribute('data-status');
    
    if (currentStatus === 'hidden') {
        // 显示VRM
        container.style.display = 'block';
        if (window.vrmManager && typeof window.vrmManager.showModel === 'function') {
            window.vrmManager.showModel();
        }
        toggleBtn.textContent = t('hide_model', '隐藏');
        toggleBtn.setAttribute('data-status', 'visible');
    } else {
        // 隐藏VRM
        if (window.vrmManager && typeof window.vrmManager.hideModel === 'function') {
            window.vrmManager.hideModel();
        }
        container.style.display = 'none';
        toggleBtn.textContent = t('show_model', '显示');
        toggleBtn.setAttribute('data-status', 'hidden');
    }
}

// VRM大小调整函数
function resizeVRM(delta) {
    if (!window.vrmManager) {
        console.warn('VRM管理器未初始化，无法调整大小');
        return;
    }

    // 使用全局比例并委托给VRM管理器
    if (typeof window.currentVRMScale !== 'number') {
        window.currentVRMScale = 0.9;
    }
    const newScale = Math.max(0.5, Math.min(1.5, window.currentVRMScale + delta));
    window.currentVRMScale = newScale;

    if (typeof window.vrmManager.resizeModel === 'function') {
        window.vrmManager.resizeModel(newScale);
    } else if (window.vrmManager.currentModel && window.vrmManager.currentModel.scene && window.vrmManager.currentModel.scene.scale && typeof window.vrmManager.currentModel.scene.scale.set === 'function') {
        // 回退：直接设置场景缩放
        window.vrmManager.currentModel.scene.scale.set(newScale, newScale, newScale);
    }

    // 更新显示的缩放信息
    const scaleInfo = document.getElementById('vrm-scale-info');
    if (scaleInfo) {
        scaleInfo.textContent = Math.round(newScale * 100) + '%';
    }
    
    console.log(`VRM模型缩放调整为: ${Math.round(newScale * 100)}%`);
}

// VRM 表情控制
function setVRMEmotion(emotion) {
    if (!window.vrmManager) return;
    try {
        if (typeof window.vrmManager.playExpression === 'function') {
            window.vrmManager.playExpression(emotion);
        }
    } catch (e) {
        console.warn('设置VRM表情失败:', e);
    }
}

// VRM 眨眼
function blinkOnce() {
    setVRMBlink(1);
    setTimeout(() => setVRMBlink(0), 150);
}
function setVRMBlink(v) {
    if (!window.vrmManager) return;
    try { window.vrmManager.setBlinkValue(Math.max(0, Math.min(1, v))); } catch (e) {}
}

// VRM 口型
function setVRMMouth(v) {
    if (!window.vrmManager) return;
    try { window.vrmManager.setMouthValue(Math.max(0, Math.min(1, v))); } catch (e) {}
}
function setVRMVowel(k) {
    if (!window.vrmManager) return;
    // 简单策略：选中的元音权重置为mouthValue，其它清零
    const mv = (typeof window.vrmManager.mouthValue === 'number') ? window.vrmManager.mouthValue : 0.8;
    const w = { a: 0, e: 0, i: 0, o: 0, u: 0 };
    if (w.hasOwnProperty(k)) w[k] = mv;
    window.vrmManager.vowelWeights = w;
}

// VRM 渲染控制
function applyVRMToneMapping(kind) {
    if (!window.vrmManager || !window.vrmManager.renderer || !window.THREE) return;
    const tm = {
        none: window.THREE.NoToneMapping,
        linear: window.THREE.LinearToneMapping,
        reinhard: window.THREE.ReinhardToneMapping,
        cineon: window.THREE.CineonToneMapping,
        aces: window.THREE.ACESFilmicToneMapping
    };
    window.vrmManager.renderer.toneMapping = tm[kind] || window.THREE.ACESFilmicToneMapping;
}
function applyVRMExposure(v) {
    if (!window.vrmManager || !window.vrmManager.renderer) return;
    window.vrmManager.renderer.toneMappingExposure = Math.max(0, v);
}
async function applyVRMHDR(url) {
    if (!window.vrmManager || !url) return;
    try {
        const ok = await window.vrmManager.setEnvironmentHDR(url);
        if (!ok) {
            console.warn('HDR环境应用失败或不支持，保持现状');
        }
    } catch (e) {
        console.warn('应用HDR出错:', e);
    }
}
function clearVRMEnvironment() {
    if (!window.vrmManager || !window.vrmManager.scene) return;
    try {
        // 清除环境光照与反射
        window.vrmManager.scene.environment = null;
        // 同步清除背景图像
        window.vrmManager.scene.background = null;
        // 如果管理器持有HDR背景纹理引用，尝试释放
        if (window.vrmManager._hdrBackgroundTexture) {
            try { window.vrmManager._hdrBackgroundTexture.dispose?.(); } catch (e) {}
            window.vrmManager._hdrBackgroundTexture = null;
        }
    } catch (e) {}
}

// 填充AnimationClip专业动作库按钮
function populateVRMClipButtons() {
    // 专业动作库已移除，函数保持为空以兼容旧调用位置
    return;
    /*
    const clipControls = document.getElementById('vrm-clip-controls');
    if (!clipControls) {
        console.warn('未找到vrm-clip-controls容器');
        return;
    }
    if (!window.vrmManager || !window.vrmManager.animationLibrary) {
        console.warn('VRM管理器或动画库未就绪');
        return;
    }
    let names = Object.keys(window.vrmManager.animationLibrary);
    if (names.length === 0) {
        // 保留载入提示
        return;
    }
    // 清空旧内容
    clipControls.innerHTML = '';

    // 如果存在VRMA但未解析为clips，给出一次性提示
    const hasUnparsedVRMA = names.some((n) => {
        const item = window.vrmManager.animationLibrary[n];
        const meta = item && item.meta ? item.meta : {};
        const isVRMA = (meta.type && String(meta.type).toLowerCase() === 'vrma') || (meta.file && String(meta.file).toLowerCase().endsWith('.vrma'));
        return isVRMA && (!item.clips || item.clips.length === 0);
    });
    if (hasUnparsedVRMA) {
        const tip = document.createElement('div');
        tip.style.color = '#E64A19';
        tip.style.fontSize = '12px';
        tip.style.margin = '4px 0 8px 0';
        tip.textContent = '检测到 VRMAnimation(.vrma) 但当前未解析，点击将回退到程序化动作。可引入VRMA支持库或提供已重定向的GLB以启用专业动作。';
        clipControls.appendChild(tip);
    }

    // 过滤掉与程序化动作重叠的僵硬占位（wave/nod/shake/bow等），保留有clips的或明确的EE
    names = names.filter((name) => {
        const lower = String(name).toLowerCase();
        if (lower.includes('wave') || lower.includes('nod') || lower.includes('shake') || lower.includes('bow')) {
            return false;
        }
        const item = window.vrmManager.animationLibrary[name];
        const hasClips = item && item.clips && item.clips.length > 0;
        return hasClips;
    });

    names.forEach((name) => {
        const btn = document.createElement('button');
        btn.className = 'control-button';
        const libraryItem = window.vrmManager.animationLibrary[name] || {};
        const meta = libraryItem.meta || {};
        const isVRMA = (meta.type && String(meta.type).toLowerCase() === 'vrma') || (meta.file && String(meta.file).toLowerCase().endsWith('.vrma'));
        const hasClips = libraryItem.clips && libraryItem.clips.length > 0;
        btn.textContent = isVRMA ? `${name} (VRMA)` : name;
        btn.style.backgroundColor = '#3949AB';
        btn.style.color = 'white';
        btn.style.border = 'none';
        btn.style.borderRadius = '6px';
        btn.style.padding = '8px 12px';
        btn.style.cursor = 'pointer';
        btn.onclick = () => {
            try {
                const ok = window.vrmManager.playClip(name, { fadeIn: 0.25, fadeOut: 0.2, loop: false, weight: 1.0, speed: 1.0, retargetToVRM: true });
                if (!ok) {
                    console.warn('播放clip失败，尝试回退到程序化动作');
                    if (isVRMA && !hasClips) {
                        console.warn('当前未集成VRMA解析器，已回退到程序化动作；可引入VRMA支持库启用专业动作');
                    }
                    // 回退：根据动作映射反推程序化动作
                    const actionMap = window.vrmManager.actionClipMap || {};
                    let action = null;
                    for (const k in actionMap) {
                        if (actionMap[k] === name) { action = k; break; }
                    }
                    // 如果没有明确映射，依据名称猜测
                    if (!action) {
                        const lower = name.toLowerCase();
                        if (lower.includes('wave')) action = 'wave';
                        else if (lower.includes('nod')) action = 'nod';
                        else if (lower.includes('shake')) action = 'shake';
                        else if (lower.includes('bow')) action = 'bow';
                        // 移除无效的 EE 动作占位
                    }
                    if (action && typeof window.vrmManager.playAnimation === 'function') {
                        window.vrmManager.playAnimation(action);
                    } else {
                        console.warn('无可用的程序化动作可回退');
                    }
                }
            } catch (e) {
                console.error('播放AnimationClip出错:', e);
            }
        };
        clipControls.appendChild(btn);
    });
    */
}

window.modelManager = new ModelManager();

function init_app(){
    const micButton = document.getElementById('micButton');
    const muteButton = document.getElementById('muteButton');
    const screenButton = document.getElementById('screenButton');
    const stopButton = document.getElementById('stopButton');
    const resetSessionButton = document.getElementById('resetSessionButton');
    const statusElement = document.getElementById('status');
    const chatContentWrapper = document.getElementById('chat-content-wrapper');
    const chatContainer = document.getElementById('chatContainer');
    const userInput = document.getElementById('userInput');
    const sendButton = document.getElementById('sendButton');

    let audioContext;
    let workletNode;
    let stream;
    let isRecording = false;
    let socket;
    let isConnecting = false;
    let preventReconnectUntil = 0; // 当收到服务端切换提示时，短暂禁止重连，避免与另一端反复争抢
    let currentGeminiMessage = null;
    let audioPlayerContext = null;
    let videoTrack, videoSenderInterval;
    let audioBufferQueue = [];
    let isPlaying = false;
    let audioStartTime = 0;
    let scheduledSources = [];
    let animationFrameId;
    let seqCounter = 0;
    let globalAnalyser = null;
    let lipSyncActive = false;
    let screenCaptureStream = null; // 暂存屏幕共享stream，不再需要每次都弹窗选择共享区域，方便自动重连
    
    // 模型管理器
    const modelManager = window.modelManager;
    
    // 已移除：init_app 内部重复的 addModelSwitchButtonToVRM，统一使用全局定义
    
    // 添加模型切换按钮
    function addModelSwitchButton() {
        // 检查是否已存在模型切换按钮
        if (document.getElementById('model-switch-btn')) return;
        
        const controlPanel = document.getElementById('live2d-control-panel');
        if (!controlPanel) {
            console.warn('Live2D控制面板未找到，无法添加模型切换按钮');
            return;
        }
        
        const switchBtn = document.createElement('button');
        switchBtn.id = 'model-switch-btn';
        switchBtn.innerHTML = (window.I18N ? I18N.t('switch_to_vrm') : '切换到VRM模型');
        switchBtn.style.padding = '8px 12px';
        switchBtn.style.borderRadius = '4px';
        switchBtn.style.border = 'none';
        switchBtn.style.backgroundColor = '#9C27B0';
        switchBtn.style.color = 'white';
        switchBtn.style.cursor = 'pointer';
        switchBtn.onclick = async () => {
            await modelManager.switchModel();
        };
        
        console.log('添加Live2D模型切换按钮');
        controlPanel.appendChild(switchBtn);
    }
    
    // 切换模型类型（保留兼容性）
    async function switchModelType() {
        await modelManager.switchModel();
    }

    function isMobile() {
      return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
        navigator.userAgent
      );
    }

    // 统一获取角色名（优先 EE，兼容 lanlan）
    const getEEName = (window.getEEName)
      ? window.getEEName
      : (() => {
          return (window.ee_config && window.ee_config.ee_name)
              || (window.lanlan_config && window.lanlan_config.lanlan_name)
              || '';
        });

    // 建立WebSocket连接
    function connectWebSocket() {
        // 若已在连接或连接已建立，则不重复建立
        if (isConnecting) return;
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
        isConnecting = true;
        // 使用更健壮的 URL 构造，并在角色名缺失时回退到 /ws
        const base = window.location.origin.replace(/^http/, 'ws');
        const ee = (typeof getEEName === 'function') ? getEEName() : '';
        const nameSegment = ee ? encodeURIComponent(ee.trim()) : '';
        const wsUrl = nameSegment ? `${base}/ws/${nameSegment}` : `${base}/ws`;
        socket = new WebSocket(wsUrl);

        socket.onopen = () => {
            console.log('WebSocket连接已建立');
            isConnecting = false;
        };

        socket.onmessage = (event) => {
            if (event.data instanceof Blob) {
                // 处理二进制音频数据
                console.log("收到新的音频块")
                handleAudioBlob(event.data);
                return;
            }

            try {
                const response = JSON.parse(event.data);
                console.log('WebSocket收到消息:', response);

                if (response.type === 'gemini_response') {
                    // 检查是否是新消息的开始
                    const isNewMessage = response.isNewMessage || false;
                    appendMessage(response.text, 'gemini', isNewMessage);

                    // 如果是新消息，停止并清空当前音频队列
                    if (isNewMessage) {
                        clearAudioQueue();
                    }
                } else if (response.type === 'user_activity') {
                    clearAudioQueue();
                } if (response.type === 'cozy_audio') {
                    // 处理音频响应
                    console.log("收到新的音频头")
                    const isNewMessage = response.isNewMessage || false;

                    if (isNewMessage) {
                        // 如果是新消息，清空当前音频队列
                        clearAudioQueue();
                    }

                    // 根据数据格式选择处理方法
                    if (response.format === 'base64') {
                        handleBase64Audio(response.audioData, isNewMessage);
                    }
                } else if (response.type === 'status') {
                    statusElement.textContent = response.message;
                    // 如果服务端提示切换至另一个终端，暂缓自动重连，避免两端互相挤掉导致闪断
                    if (response.message && response.message.includes('切换至另一个终端')) {
                        preventReconnectUntil = Date.now() + 8000; // 8秒缓冲时间
                    }
                    if (response.message === `${getEEName()}失联了，即将重启！`){
                        if (isRecording === false){
                            statusElement.textContent = `${getEEName()}正在打盹...`;
                        } else {
                            stopRecording();
                            if (socket && socket.readyState === WebSocket.OPEN) {
                                socket.send(JSON.stringify({
                                    action: 'end_session'
                                }));
                            }
                            hideLive2d();
                            micButton.disabled = true;
                            muteButton.disabled = true;
                            screenButton.disabled = true;
                            stopButton.disabled = true;
                            resetSessionButton.disabled = true;

                            setTimeout(async () => {
                                try {
                                    // 发送start session事件
                                    if (socket && socket.readyState === WebSocket.OPEN) {
                                        socket.send(JSON.stringify({
                                            action: 'start_session',
                                            input_type: 'audio'
                                        }));
                                    }
                                    
                                    // 等待2.5秒后执行后续操作
                                    await new Promise(resolve => setTimeout(resolve, 2500));
                                    
                                    showLive2d();
                                    await startMicCapture();
                                    if (screenCaptureStream != null){
                                        await startScreenSharing();
                                    }
                                    statusElement.textContent = `重启完成，${getEEName()}回来了！`;
                                } catch (error) {
                                    console.error("重启时出错:", error);
                                    statusElement.textContent = "重启失败，请手动刷新。";
                                }
                            }, 7500); // 7.5秒后执行
                        }
                    }
                } else if (response.type === 'expression') {
                    window.LanLan1.registered_expressions[response.message]();
                } else if (response.type === 'action' && response.action) {
                    try {
                        if (window.vrmManager && typeof window.vrmManager.playAnimation === 'function') {
                            window.vrmManager.playAnimation(response.action);
                        } else {
                            console.warn('VRM管理器未就绪或不支持 playAnimation');
                        }
                    } catch (e) {
                        console.error('触发动作失败:', e);
                    }
                } else if (response.type === 'vrm_action' && response.url) {
                    try {
                        if (window.vrmManager && typeof window.vrmManager.playVRMAUrl === 'function') {
                            const name = response.name || response.action || 'vrma_import';
                            window.vrmManager.playVRMAUrl(response.url, { name });
                        } else {
                            console.warn('VRM管理器未就绪或不支持 playVRMAUrl');
                        }
                    } catch (e) {
                        console.error('播放VRMA失败:', e);
                    }
                } else if (response.type === 'system' && response.data === 'turn end') {
                    console.log('收到turn end事件，开始情感分析');
                    console.log('当前currentGeminiMessage:', currentGeminiMessage);
                    // 消息完成时进行情感分析
                    if (currentGeminiMessage) {
                        const fullText = currentGeminiMessage.textContent.replace(/^\[\d{2}:\d{2}:\d{2}\] 🎀 /, '');
                        setTimeout(async () => {
                            const emotionResult = await analyzeEmotion(fullText);
                            if (emotionResult && emotionResult.emotion) {
                                console.log('消息完成，情感分析结果:', emotionResult);
                                applyEmotion(emotionResult.emotion);
                            }
                        }, 100);
                    }
                }
            } catch (error) {
                console.error('处理消息失败:', error);
            }
        };

        socket.onclose = (evt) => {
            console.log('WebSocket连接已关闭', evt && { code: evt.code, reason: evt.reason });
            isConnecting = false;
            // 如果刚收到“切换至另一个终端”提示，则在缓冲期内不重连，防止来回抢占
            if (Date.now() < preventReconnectUntil) {
                return;
            }
            // 尝试延迟重连，避免短时间内多次建立连接
            setTimeout(() => {
                connectWebSocket();
            }, 3000);
        };

        socket.onerror = (error) => {
            console.error('WebSocket错误:', error);
            isConnecting = false;
            // 首次错误尝试使用 localhost 进行回退连接
            try {
                if (!socket || socket.readyState !== WebSocket.OPEN) {
                    const url = new URL(wsUrl);
                    if (url.hostname !== 'localhost') {
                        const fallback = `${url.protocol}//localhost${url.port ? ':'+url.port : ''}${url.pathname}${url.search}`;
                        console.warn('尝试使用回退地址连接: ', fallback);
                        socket = new WebSocket(fallback);
                    }
                }
            } catch (e) {
                console.warn('回退连接构造失败:', e);
            }
        };
    }

    // 初始化连接：等待角色名就绪（优先 EE，兼容 lanlan）
    if (getEEName()) {
        connectWebSocket();
    } else {
        console.warn('角色名未就绪，延迟建立 WebSocket 连接');
        const tryConnect = () => {
            if (getEEName()) {
                connectWebSocket();
            } else {
                setTimeout(tryConnect, 200);
            }
        };
        tryConnect();
    }

    // 添加消息到聊天界面
    function appendMessage(text, sender, isNewMessage = true) {
        function getCurrentTimeString() {
            return new Date().toLocaleTimeString('en-US', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        }

        if (sender === 'gemini' && !isNewMessage && currentGeminiMessage) {
            // 追加到现有的Gemini消息
            // currentGeminiMessage.textContent += text;
            currentGeminiMessage.insertAdjacentHTML('beforeend', text.replaceAll('\n', '<br>'));
        } else {
            // 创建新消息
            const messageDiv = document.createElement('div');
            messageDiv.classList.add('message', sender);
            messageDiv.textContent = "[" + getCurrentTimeString() + "] 🎀 " + text;
            chatContainer.appendChild(messageDiv);

            // 如果是Gemini消息，更新当前消息引用
            if (sender === 'gemini') {
                currentGeminiMessage = messageDiv;
            }
        }
        if (chatContentWrapper) {
            chatContentWrapper.scrollTop = chatContentWrapper.scrollHeight;
        }
    }

    // 文本发送逻辑
    function sendTextMessage() {
        if (!userInput) return;
        const text = (userInput.value || '').trim();
        if (!text) return;
        // 先在前端追加用户消息
        appendMessage(text, 'user', true);
        // 通过 WebSocket 发送到后端
        try {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    action: 'stream_data',
                    input_type: 'text',
                    data: text
                }));
            }
        } catch (e) {
            console.error('发送文本消息失败:', e);
        }
        // 清空输入框
        userInput.value = '';
    }

    if (sendButton) {
        sendButton.addEventListener('click', sendTextMessage);
    }
    if (userInput) {
        userInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendTextMessage();
            }
        });
    }


    async function startMicCapture() {  // 开麦，按钮on click
        try {
            if (!audioPlayerContext) {
                audioPlayerContext = new (window.AudioContext || window.webkitAudioContext)();
            }

            if (audioPlayerContext.state === 'suspended') {
                await audioPlayerContext.resume();
            }

            // 获取麦克风流
            stream = await navigator.mediaDevices.getUserMedia({audio: true});

            // 检查音频轨道状态
            const audioTracks = stream.getAudioTracks();
            console.log("音频轨道数量:", audioTracks.length);
            console.log("音频轨道状态:", audioTracks.map(track => ({
                label: track.label,
                enabled: track.enabled,
                muted: track.muted,
                readyState: track.readyState
            })));

            if (audioTracks.length === 0) {
                console.error("没有可用的音频轨道");
                statusElement.textContent = '无法访问麦克风';
                return;
            }

            await startAudioWorklet(stream);

            micButton.disabled = true;
            muteButton.disabled = false;
            screenButton.disabled = false;
            stopButton.disabled = true;
            resetSessionButton.disabled = false;
            statusElement.textContent = '正在语音...';
        } catch (err) {
            console.error('获取麦克风权限失败:', err);
            
            // 检测麦克风占用情况并提供友好提示
            if (err.name === 'NotReadableError' || err.name === 'AbortError') {
                // NotReadableError 通常表示麦克风被其他应用占用
                // AbortError 可能是因为硬件不可用或被其他应用锁定
                showNotification('麦克风可能正被其他应用（如Zoom、Teams等）占用，请关闭其他使用麦克风的应用后重试。');
                statusElement.textContent = '麦克风被占用';
            } else if (err.name === 'NotAllowedError') {
                showNotification('麦克风访问被拒绝，请在浏览器设置中允许访问麦克风。');
                statusElement.textContent = '麦克风访问被拒绝';
            } else if (err.name === 'NotFoundError') {
                showNotification('未检测到麦克风设备，请确认麦克风已正确连接。');
                statusElement.textContent = '未找到麦克风设备';
            } else {
                showNotification('无法访问麦克风: ' + (err.message || '未知错误'));
                statusElement.textContent = '无法访问麦克风';
            }
        }
    }
    
    // 显示友好的通知提示
    function showNotification(message) {
        // 检查是否已有通知元素
        let notificationElement = document.getElementById('mic-notification');
        if (!notificationElement) {
            // 创建通知元素
            notificationElement = document.createElement('div');
            notificationElement.id = 'mic-notification';
            notificationElement.style.position = 'fixed';
            notificationElement.style.top = '20px';
            notificationElement.style.left = '50%';
            notificationElement.style.transform = 'translateX(-50%)';
            notificationElement.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
            notificationElement.style.color = 'white';
            notificationElement.style.padding = '10px 20px';
            notificationElement.style.borderRadius = '5px';
            notificationElement.style.zIndex = '1000';
            notificationElement.style.maxWidth = '80%';
            document.body.appendChild(notificationElement);
        }
        
        // 设置消息内容
        notificationElement.textContent = message;
        
        // 显示通知
        notificationElement.style.display = 'block';
        
        // 5秒后自动隐藏
        setTimeout(() => {
            notificationElement.style.display = 'none';
        }, 5000);
    }

    async function stopMicCapture(){ // 闭麦，按钮on click
        stopRecording();
        micButton.disabled = false;
        muteButton.disabled = true;
        screenButton.disabled = true;
        stopButton.disabled = true;
        resetSessionButton.disabled = true;
        statusElement.textContent = `${getEEName()}待机中...`;
    }

    async function getMobileCameraStream() {
      const makeConstraints = (facing) => ({
        video: {
          facingMode: facing,
          frameRate: { ideal: 1, max: 1 },
        },
        audio: false,
      });

      const attempts = [
        { label: 'rear', constraints: makeConstraints({ ideal: 'environment' }) },
        { label: 'front', constraints: makeConstraints('user') },
        { label: 'any', constraints: { video: { frameRate: { ideal: 1, max: 1 } }, audio: false } },
      ];

      let lastError;

      for (const attempt of attempts) {
        try {
          console.log(`Trying ${attempt.label} camera @ ${1}fps…`);
          return await navigator.mediaDevices.getUserMedia(attempt.constraints);
        } catch (err) {
          console.warn(`${attempt.label} failed →`, err);
          statusElement.textContent = err;
          return err;
        }
      }
    }

    async function startScreenSharing(){ // 分享屏幕，按钮on click
        // 检查是否在录音状态
        if (!isRecording) {
            statusElement.textContent = '请先开启麦克风录音！';
            return;
        }
        
        try {
            // 初始化音频播放上下文
            showLive2d();
            if (!audioPlayerContext) {
                audioPlayerContext = new (window.AudioContext || window.webkitAudioContext)();
            }

            // 如果上下文被暂停，则恢复它
            if (audioPlayerContext.state === 'suspended') {
                await audioPlayerContext.resume();
            }
            let captureStream;

            if (screenCaptureStream == null){
                if (isMobile()) {
                // On mobile we capture the *camera* instead of the screen.
                // `environment` is the rear camera (iOS + many Androids). If that's not
                // available the UA will fall back to any camera it has.
                screenCaptureStream = await getMobileCameraStream();

                } else {
                // Desktop/laptop: capture the user's chosen screen / window / tab.
                screenCaptureStream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                    cursor: 'always',
                    frameRate: 1,
                    },
                    audio: false,
                });
                }
            }
            startScreenVideoStreaming(screenCaptureStream, isMobile() ? 'camera' : 'screen');

            micButton.disabled = true;
            muteButton.disabled = false;
            screenButton.disabled = true;
            stopButton.disabled = false;
            resetSessionButton.disabled = false;

            // 当用户停止共享屏幕时
            screenCaptureStream.getVideoTracks()[0].onended = stopScreening;

            // 获取麦克风流
            if (!isRecording) statusElement.textContent = '没开麦啊feed！';
          } catch (err) {
            console.error(isMobile() ? '摄像头访问失败:' : '屏幕共享失败:', err);
            console.error('启动失败 →', err);
            let hint = '';
            switch (err.name) {
              case 'NotAllowedError':
                hint = '请检查 iOS 设置 → Safari → 摄像头 权限是否为"允许"';
                break;
              case 'NotFoundError':
                hint = '未检测到摄像头设备';
                break;
              case 'NotReadableError':
              case 'AbortError':
                hint = '摄像头被其它应用占用？关闭扫码/拍照应用后重试';
                break;
            }
            statusElement.textContent = `${err.name}: ${err.message}${hint ? `\n${hint}` : ''}`;
          }
    }

    async function stopScreenSharing(){ // 停止共享，按钮on click
        stopScreening();
        micButton.disabled = true;
        muteButton.disabled = false;
        screenButton.disabled = false;
        stopButton.disabled = true;
        resetSessionButton.disabled = false;
        screenCaptureStream = null;
        statusElement.textContent = '正在语音...';
    }

    window.switchMicCapture = async () => {
        if (muteButton.disabled) {
            await startMicCapture();
        } else {
            await stopMicCapture();
        }
    }
    window.switchScreenSharing = async () => {
        if (stopButton.disabled) {
            // 检查是否在录音状态
            if (!isRecording) {
                statusElement.textContent = '请先开启麦克风！';
                return;
            }
            await startScreenSharing();
        } else {
            await stopScreenSharing();
        }
    }

    // 开始麦克风录音
    if (micButton) {
        micButton.addEventListener('click', async () => {
            // 立即禁用所有按钮
        micButton.disabled = true;
        if (muteButton) muteButton.disabled = true;
        if (screenButton) screenButton.disabled = true;
        if (stopButton) stopButton.disabled = true;
        if (resetSessionButton) resetSessionButton.disabled = true;
        
        // 确保已建立WebSocket连接
        try {
            if (!socket || (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING)) {
                connectWebSocket();
            }
        } catch (_) {}
        
        // 发送start session事件
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                action: 'start_session',
                input_type: 'audio'
            }));
        }
        
        statusElement.textContent = '正在初始化麦克风...';
        
        // 3秒后执行正常的麦克风启动逻辑
        setTimeout(async () => {
            try {
                // 显示Live2D
                showLive2d();
                await startMicCapture();
            } catch (error) {
                console.error('启动麦克风失败:', error);
                // 如果失败，恢复按钮状态
                micButton.disabled = false;
                muteButton.disabled = true;
                screenButton.disabled = true;
                stopButton.disabled = true;
                resetSessionButton.disabled = false;
                statusElement.textContent = '麦克风启动失败';
            }
        }, 2500);
    });
    }

    // 开始屏幕共享
    if (screenButton) {
        screenButton.addEventListener('click', startScreenSharing);
    }

    // 停止屏幕共享
    if (stopButton) {
        stopButton.addEventListener('click', stopScreenSharing);
    }

    // 停止对话
    if (muteButton) {
        muteButton.addEventListener('click', stopMicCapture);
    }

    if (resetSessionButton) {
        resetSessionButton.addEventListener('click', () => {
        hideLive2d()
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                action: 'end_session'
            }));
        }
        stopRecording();
        clearAudioQueue();
        micButton.disabled = false;
        muteButton.disabled = true;
        screenButton.disabled = true;
        stopButton.disabled = true;
        resetSessionButton.disabled = true;
    });
    }

    // 情感分析功能
    async function analyzeEmotion(text) {
        console.log('analyzeEmotion被调用，文本:', text);
        try {
            const response = await fetch('/api/emotion/analysis', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    text: text
                })
            });

            if (!response.ok) {
                console.warn('情感分析请求失败:', response.status);
                return null;
            }

            const result = await response.json();
            console.log('情感分析API返回结果:', result);
            
            if (result.error) {
                console.warn('情感分析错误:', result.error);
                return null;
            }

            return result;
        } catch (error) {
            console.error('情感分析请求异常:', error);
            return null;
        }
    }

    // 应用情感到Live2D模型
    function applyEmotion(emotion) {
        if (window.LanLan1 && window.LanLan1.setEmotion) {
            console.log('调用window.LanLan1.setEmotion:', emotion);
            window.LanLan1.setEmotion(emotion);
        } else {
            console.warn('情感功能未初始化');
        }
    }

    // 使用AudioWorklet开始音频处理
    async function startAudioWorklet(stream) {
        isRecording = true;

        // 创建音频上下文
        audioContext = new AudioContext();
        console.log("音频上下文采样率:", audioContext.sampleRate);

        // 创建媒体流源
        const source = audioContext.createMediaStreamSource(stream);

        try {
            // 加载AudioWorklet处理器
            await audioContext.audioWorklet.addModule('/static/audio-processor.js');

            // 创建AudioWorkletNode
            workletNode = new AudioWorkletNode(audioContext, 'audio-processor', {
                processorOptions: {
                    originalSampleRate: audioContext.sampleRate,
                    targetSampleRate: 16000
                }
            });

            // 监听处理器发送的消息
            workletNode.port.onmessage = (event) => {
                const audioData = event.data;

                // 新增逻辑：focus_mode为true且正在播放语音时，不回传麦克风音频
                if (typeof window.focus_mode !== 'undefined' && window.focus_mode === true && isPlaying === true) {
                    // 处于focus_mode且语音播放中，跳过回传
                    return;
                }

                if (isRecording && socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({
                        action: 'stream_data',
                        data: Array.from(audioData),
                        input_type: 'audio'
                    }));
                }
            };

            // 连接节点
            source.connect(workletNode);
            // 不需要连接到destination，因为我们不需要听到声音
            // workletNode.connect(audioContext.destination);

            // 可选：麦克风驱动唇形，仅当显式设置为 'mic' 时启用
            if (typeof window.lipSyncSource === 'undefined') window.lipSyncSource = 'ai';
            if (window.lipSyncSource === 'mic') {
                const micAnalyser = audioContext.createAnalyser();
                micAnalyser.fftSize = 2048;
                source.connect(micAnalyser);
                const hasVRMForMic = !!(window.vrmManager && window.vrmManager.currentModel);
                const hasL2DForMic = !!(window.LanLan1 && window.LanLan1.live2dModel);
                if (!lipSyncActive && (hasVRMForMic || hasL2DForMic)) {
                    const modelForFallback = hasL2DForMic ? window.LanLan1.live2dModel : null;
                    startLipSync(modelForFallback, micAnalyser);
                    lipSyncActive = true;
                }
            }

        } catch (err) {
            console.error('加载AudioWorklet失败:', err);
            console.dir(err); // <--- 使用 console.dir()
            statusElement.textContent = 'AudioWorklet加载失败';
        }
    }


    // 停止录屏
    function stopScreening() {
        if (videoSenderInterval) clearInterval(videoSenderInterval);
    }

    // 停止录音
    function stopRecording() {

        stopScreening();
        if (!isRecording) return;

        isRecording = false;
        currentGeminiMessage = null;

        // 停止所有轨道
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }

        // 关闭AudioContext
        if (audioContext) {
            audioContext.close();
        }

        // 通知服务器暂停会话
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                action: 'pause_session'
            }));
        }
        // statusElement.textContent = '录制已停止';
    }

    // 清空音频队列并停止所有播放
    function clearAudioQueue() {
        // 停止所有计划的音频源
        scheduledSources.forEach(source => {
            try {
                source.stop();
            } catch (e) {
                // 忽略已经停止的源
            }
        });

        // 清空队列和计划源列表
        scheduledSources = [];
        audioBufferQueue = [];
        isPlaying = false;
        audioStartTime = 0;
        nextStartTime = 0; // 新增：重置预调度时间
    }


    function scheduleAudioChunks() {
        const scheduleAheadTime = 5;

        initializeGlobalAnalyser();

        // 确保唇形同步在音频开始时就启动（即使模型稍后加载也能持续驱动）
        if (!lipSyncActive && globalAnalyser) {
            const hasVRM = !!(window.vrmManager && window.vrmManager.currentModel);
            const hasL2D = !!(window.LanLan1 && window.LanLan1.live2dModel);
            const modelForFallback = hasL2D ? window.LanLan1.live2dModel : null;
            try {
                console.log('启动唇形同步', { hasVRM, hasL2D });
                startLipSync(modelForFallback, globalAnalyser);
                lipSyncActive = true;
            } catch (e) {
                console.warn('启动唇形同步失败:', e);
            }
        }

        // 关键：预调度所有在lookahead时间内的chunk
        while (nextChunkTime < audioPlayerContext.currentTime + scheduleAheadTime) {
            if (audioBufferQueue.length > 0) {
                const { buffer: nextBuffer } = audioBufferQueue.shift();
                console.log('ctx', audioPlayerContext.sampleRate,
                    'buf', nextBuffer.sampleRate);

                const source = audioPlayerContext.createBufferSource();
                source.buffer = nextBuffer;
                // source.connect(audioPlayerContext.destination);


                // 创建analyser节点用于lipSync
                // const analyser = audioPlayerContext.createAnalyser();
                // analyser.fftSize = 2048;
                // source.connect(analyser);
                // analyser.connect(audioPlayerContext.destination);
                // if (window.LanLan1 && window.LanLan1.live2dModel) {
                //     startLipSync(window.LanLan1.live2dModel, analyser);
                // }


                source.connect(globalAnalyser);

                // 当任一模型存在时启动lipSync（支持VRM与Live2D）
                const hasVRM = !!(window.vrmManager && window.vrmManager.currentModel);
                const hasL2D = !!(window.LanLan1 && window.LanLan1.live2dModel);
                if (!lipSyncActive && (hasVRM || hasL2D)) {
                    const modelForFallback = hasL2D ? window.LanLan1.live2dModel : null;
                    startLipSync(modelForFallback, globalAnalyser);
                    lipSyncActive = true;
                }

                // 精确时间调度
                source.start(nextChunkTime);
                // console.log(`调度chunk在时间: ${nextChunkTime.toFixed(3)}`);

                // 设置结束回调处理lipSync停止
                source.onended = () => {
                    // if (window.LanLan1 && window.LanLan1.live2dModel) {
                    //     stopLipSync(window.LanLan1.live2dModel);
                    // }
                    const index = scheduledSources.indexOf(source);
                    if (index !== -1) {
                        scheduledSources.splice(index, 1);
                    }

                    if (scheduledSources.length === 0 && audioBufferQueue.length === 0) {
                        const modelForFallback = (window.LanLan1 && window.LanLan1.live2dModel) ? window.LanLan1.live2dModel : null;
                        stopLipSync(modelForFallback);
                        lipSyncActive = false;
                        isPlaying = false; // 新增：所有音频播放完毕，重置isPlaying
                    }
                };

                // // 更新下一个chunk的时间
                nextChunkTime += nextBuffer.duration;

                scheduledSources.push(source);
            } else {
                break;
            }
        }

        // 继续调度循环
        setTimeout(scheduleAudioChunks, 25); // 25ms间隔检查
    }


    async function handleAudioBlob(blob) {
        // 你现有的PCM处理代码...
        const pcmBytes = await blob.arrayBuffer();
        if (!pcmBytes || pcmBytes.byteLength === 0) {
            console.warn('收到空的PCM数据，跳过处理');
            return;
        }

        if (!audioPlayerContext) {
            audioPlayerContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        if (audioPlayerContext.state === 'suspended') {
            await audioPlayerContext.resume();
        }

        const int16Array = new Int16Array(pcmBytes);
        const audioBuffer = audioPlayerContext.createBuffer(1, int16Array.length, 48000);
        const channelData = audioBuffer.getChannelData(0);
        for (let i = 0; i < int16Array.length; i++) {
            channelData[i] = int16Array[i] / 32768.0;
        }

        const bufferObj = { seq: seqCounter++, buffer: audioBuffer };
        audioBufferQueue.push(bufferObj);

        let i = audioBufferQueue.length - 1;
        while (i > 0 && audioBufferQueue[i].seq < audioBufferQueue[i - 1].seq) {
            [audioBufferQueue[i], audioBufferQueue[i - 1]] =
              [audioBufferQueue[i - 1], audioBufferQueue[i]];
            i--;
        }

        // 如果是第一次，初始化调度
        if (!isPlaying) {
            nextChunkTime = audioPlayerContext.currentTime + 0.1;
            isPlaying = true;
            scheduleAudioChunks(); // 开始调度循环
        }
    }

    function startScreenVideoStreaming(stream, input_type) {
        const video = document.createElement('video');
        // console.log('Ready for sharing 1')

        video.srcObject = stream;
        video.autoplay = true;
        video.muted = true;
        // console.log('Ready for sharing 2')

        videoTrack = stream.getVideoTracks()[0];
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // 定时抓取当前帧并编码为jpeg
        video.play().then(() => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            videoSenderInterval = setInterval(() => {
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.8); // base64 jpeg

                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({
                        action: 'stream_data',
                        data: dataUrl,
                        input_type: input_type,
                    }));
                }
            }, 1000); } // 每100ms一帧
        )
    }

    function initializeGlobalAnalyser() {
        if (!globalAnalyser && audioPlayerContext) {
            globalAnalyser = audioPlayerContext.createAnalyser();
            globalAnalyser.fftSize = 2048;
            globalAnalyser.connect(audioPlayerContext.destination);
        }
    }

    function startLipSync(model, analyser) {
        // 基于音频能量与频带的实时口型与元音权重（AEIOU）估计
        // 同时保留向后兼容：如果后续接入TTS的viseme时间轴，可通过 window.lipSyncApplyViseme(name, weight) 注入
        const timeData = new Uint8Array(analyser.fftSize);
        const freqData = new Uint8Array(analyser.frequencyBinCount);
        const sampleRate = analyser.context ? analyser.context.sampleRate : 44100;
        const fftSize = analyser.fftSize;
        const binHz = sampleRate / fftSize; // 每个频率bin对应的Hz

        // 频段边界（Hz）——粗略区分元音特征：
        const LOW_CUTOFF = 800;   // 低频：A/O/U
        const MID_CUTOFF = 2400;  // 中频：E
        const HIGH_CUTOFF = 6000; // 高频：I/E(尖锐)

        // 平滑参数
        let mouthSmooth = 0;            // 指数平滑的嘴巴开合值
        const mouthAlpha = 0.15;        // 越大跟随越快
        let prevWeights = { a: 0, e: 0, i: 0, o: 0, u: 0 };
        const vowelAlpha = 0.25;        // 元音权重的平滑系数

        // 可选：viseme即时注入（未来可由后端调用）
        // name: 'aa'|'ee'|'ih'|'oh'|'ou'
        window.lipSyncApplyViseme = function(name, weight = 1.0) {
            const w = { a: 0, e: 0, i: 0, o: 0, u: 0 };
            if (name === 'aa') w.a = weight;
            else if (name === 'ee') w.e = weight;
            else if (name === 'ih') w.i = weight;
            else if (name === 'oh') w.o = weight;
            else if (name === 'ou') w.u = weight;
            // 与当前平滑值融合，避免跳变
            prevWeights = {
                a: prevWeights.a * (1 - vowelAlpha) + w.a * vowelAlpha,
                e: prevWeights.e * (1 - vowelAlpha) + w.e * vowelAlpha,
                i: prevWeights.i * (1 - vowelAlpha) + w.i * vowelAlpha,
                o: prevWeights.o * (1 - vowelAlpha) + w.o * vowelAlpha,
                u: prevWeights.u * (1 - vowelAlpha) + w.u * vowelAlpha,
            };
        };

        function animate() {
            // 1) 能量口型：使用时间域RMS并指数平滑
            analyser.getByteTimeDomainData(timeData);
            let sum = 0;
            for (let i = 0; i < timeData.length; i++) {
                const v = (timeData[i] - 128) / 128; // -1~1
                sum += v * v;
            }
            const rms = Math.sqrt(sum / timeData.length);
            const targetMouth = Math.min(1, rms * 8);
            mouthSmooth = mouthSmooth * (1 - mouthAlpha) + targetMouth * mouthAlpha;

            // 2) 频带元音估计：使用频域能量分布粗略推断AEIOU
            analyser.getByteFrequencyData(freqData); // 0~255
            // 计算三个频段的平均能量
            const lowMaxBin = Math.min(freqData.length - 1, Math.floor(LOW_CUTOFF / binHz));
            const midMaxBin = Math.min(freqData.length - 1, Math.floor(MID_CUTOFF / binHz));
            const highMaxBin = Math.min(freqData.length - 1, Math.floor(HIGH_CUTOFF / binHz));

            let eLow = 0, eMid = 0, eHigh = 0;
            let cLow = 0, cMid = 0, cHigh = 0;
            for (let i = 0; i <= lowMaxBin; i++) { eLow += freqData[i]; cLow++; }
            for (let i = lowMaxBin + 1; i <= midMaxBin; i++) { eMid += freqData[i]; cMid++; }
            for (let i = midMaxBin + 1; i <= highMaxBin; i++) { eHigh += freqData[i]; cHigh++; }
            eLow /= Math.max(1, cLow);
            eMid /= Math.max(1, cMid);
            eHigh /= Math.max(1, cHigh);

            // 归一化到 0~1（255为最大），并进行轻微增益调整
            const nLow = Math.min(1, Math.max(0, eLow / 255));
            const nMid = Math.min(1, Math.max(0, eMid / 255));
            const nHigh = Math.min(1, Math.max(0, eHigh / 255));

            // 粗略映射策略：
            // - A(aa)：低频占优
            // - E(ee)：中高频占优
            // - I(ih)：高频占优且尖锐
            // - O(oh)：低频占优但有些中频
            // - U(ou)：低频极强且高频很弱
            const rawA = Math.max(0, nLow * 0.9 - nHigh * 0.1);
            const rawI = Math.max(0, nHigh * 0.9 - nLow * 0.2);
            const rawE = Math.max(0, (nMid * 0.7 + nHigh * 0.3) - nLow * 0.1);
            const rawO = Math.max(0, (nLow * 0.7 + nMid * 0.2) - nHigh * 0.15);
            const rawU = Math.max(0, nLow * 0.8 - (nHigh * 0.25 + nMid * 0.1));

            // 避免全零，做一次归一化并乘以嘴巴开合作为上限
            let sumV = rawA + rawE + rawI + rawO + rawU;
            if (sumV < 1e-6) sumV = 1;
            let wA = (rawA / sumV) * mouthSmooth;
            let wE = (rawE / sumV) * mouthSmooth;
            let wI = (rawI / sumV) * mouthSmooth;
            let wO = (rawO / sumV) * mouthSmooth;
            let wU = (rawU / sumV) * mouthSmooth;

            // 与上一帧进行指数平滑
            const weights = {
                a: prevWeights.a * (1 - vowelAlpha) + wA * vowelAlpha,
                e: prevWeights.e * (1 - vowelAlpha) + wE * vowelAlpha,
                i: prevWeights.i * (1 - vowelAlpha) + wI * vowelAlpha,
                o: prevWeights.o * (1 - vowelAlpha) + wO * vowelAlpha,
                u: prevWeights.u * (1 - vowelAlpha) + wU * vowelAlpha,
            };
            prevWeights = weights;

            // 3) 应用到模型
            if (window.LanLan1 && typeof window.LanLan1.setMouth === 'function') {
                window.LanLan1.setMouth(mouthSmooth);
            }
            if (window.vrmManager) {
                try { window.vrmManager.setMouthValue(mouthSmooth); } catch (_) {}
                try { window.vrmManager.vowelWeights = weights; } catch (_) {}
            }

            animationFrameId = requestAnimationFrame(animate);
        }

        animate();
    }

    function stopLipSync(model) {
        cancelAnimationFrame(animationFrameId);
        if (window.LanLan1 && typeof window.LanLan1.setMouth === 'function') {
            window.LanLan1.setMouth(0);
        } else if (model && model.internalModel && model.internalModel.coreModel) {
            // 兜底
            try { model.internalModel.coreModel.setParameterValueById("ParamMouthOpenY", 0); } catch (_) {}
        }
        // 同步关闭 VRM 嘴型
        if (window.vrmManager && typeof window.vrmManager.setMouthValue === 'function') {
            try { window.vrmManager.setMouthValue(0); } catch (_) {}
        }
    }

    // Live2D控制相关变量
    let autoHideTimer = null;
    let isAutoHideEnabled = true;
    let currentScale = 1.0;

    // 移除旧的控制面板创建事件监听器，改为在ModelManager中统一管理
    // window.addEventListener('load', createLive2dControls);
    // window.addEventListener('load', createVRMControls);
    
    window.startScreenSharing = startScreenSharing;
    window.stopScreenSharing  = stopScreenSharing;
    window.screen_share       = startScreenSharing; // 兼容老按钮
}

const ready = () => {
    if (ready._called) return;
    ready._called = true;
    
    console.log('=== 页面加载开始 ===');
    console.log('检查必要元素:');
    console.log('live2d-container:', document.getElementById('live2d-container') ? '存在' : '不存在');
    console.log('vrm-container:', document.getElementById('vrm-container') ? '存在' : '不存在');
    console.log('live2d-canvas:', document.getElementById('live2d-canvas') ? '存在' : '不存在');
    console.log('vrm-canvas:', document.getElementById('vrm-canvas') ? '存在' : '不存在');
    console.log('window.live2dManager:', window.live2dManager ? '存在' : '不存在');
    console.log('window.vrmManager:', window.vrmManager ? '存在' : '不存在');
    console.log('window.modelManager:', window.modelManager ? '存在' : '不存在');
    
    init_app();
    
    // 使用新的ModelManager进行模型初始化
    setTimeout(() => {
        try {
            console.log('=== 开始模型初始化 ===');
            console.log('当前模型类型:', window.modelManager.getModelType());
            console.log('modelManager.isInitialized:', window.modelManager.isInitialized);
            
            window.modelManager.initCurrentModel().then(() => {
                console.log('=== 模型初始化完成 ===');
                // 确保控制面板显示
                setTimeout(() => {
                    const live2dPanel = document.getElementById('live2d-control-panel');
                    const vrmPanel = document.getElementById('vrm-control-panel');
                    console.log('=== 检查控制面板状态 ===');
                    console.log('Live2D面板:', live2dPanel ? '存在' : '不存在');
                    console.log('VRM面板:', vrmPanel ? '存在' : '不存在');
                    if (live2dPanel) console.log('Live2D面板显示状态:', live2dPanel.style.display);
                    if (vrmPanel) console.log('VRM面板显示状态:', vrmPanel.style.display);
                }, 100);
            }).catch(err => {
                console.error('=== 模型初始化失败 ===', err);
            });
        } catch (error) {
            console.error('=== 模型初始化错误 ===', error);
        }
    }, 500); // 延迟500ms确保所有管理器已加载
};

document.addEventListener("DOMContentLoaded", ready);
window.addEventListener("load", ready);

