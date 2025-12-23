// 获取聊天容器元素
const chatContainer = document.getElementById('chat-container');
const chatContentWrapper = document.getElementById('chat-content-wrapper');
const toggleBtn = document.getElementById('toggle-chat-btn');
// 拖动状态标记：用于避免拖动后误触发按钮点击
let justDragged = false;

// 定义一个滚动到底部的函数
function scrollToBottom() {
    if (chatContentWrapper && !chatContainer.classList.contains('minimized')) {
        chatContentWrapper.scrollTop = chatContentWrapper.scrollHeight;
    }
}

// --- 添加新消息函数 (修正) ---
function addNewMessage(messageHTML) {
    if (!chatContentWrapper) return; // 安全检查

    const newMessageElement = document.createElement('div');
    newMessageElement.innerHTML = messageHTML;
    chatContentWrapper.appendChild(newMessageElement);

    // 确保在添加消息后立即滚动到底部
    setTimeout(scrollToBottom, 10); // 短暂延迟确保DOM更新
}

// --- 切换聊天框最小化/展开状态 ---
if (toggleBtn) {
    toggleBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        // 避免拖动结束瞬间误触发点击
        if (justDragged) {
            justDragged = false;
            return;
        }

        const isMinimized = chatContainer.classList.toggle('minimized');

        if (isMinimized) {
            // 刚刚最小化
            toggleBtn.textContent = '+';
            toggleBtn.title = (window.I18N ? I18N.t('restore') : 'Restore');
        } else {
        // 刚刚还原展开
        toggleBtn.textContent = '-';
        toggleBtn.title = (window.I18N ? I18N.t('minimize') : 'Minimize');
        // 还原后滚动到底部
        setTimeout(scrollToBottom, 300); // 给CSS过渡留出时间
    }
    });
}

// 让最小化后的小方块本身也能点击还原
if (chatContainer) {
    chatContainer.addEventListener('click', (event) => {
        if (chatContainer.classList.contains('minimized') && event.target === chatContainer) {
            if (toggleBtn) toggleBtn.click();
        }
    });
}

// --- Sidebar 折叠/展开功能 ---
const sidebar = document.getElementById('sidebar');
const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');

if (toggleSidebarBtn) {
    toggleSidebarBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (sidebar) {
            const isMinimized = sidebar.classList.toggle('minimized');
            if (isMinimized) {
                toggleSidebarBtn.textContent = '+';
                toggleSidebarBtn.title = '展开侧边栏';
                sidebar.style.width = sidebar.style.height = '48px';
            } else {
                toggleSidebarBtn.textContent = '-';
                toggleSidebarBtn.title = '折叠侧边栏';
                sidebar.style.width = maxsidebarboxWidth + 'px';
                sidebar.style.height = maxsidebarboxHeight + 'px';
            }
        }
    });
}

// 允许点击整个 sidebar 区域还原
if (sidebar) {
    sidebar.addEventListener('click', (event) => {
        if (sidebar.classList.contains('minimized') && event.target === sidebar) {
            if (toggleSidebarBtn) toggleSidebarBtn.click();
        }
    });
}

// --- 初始化 ---
document.addEventListener('DOMContentLoaded', () => {
    // 设置初始按钮状态 - 聊天框
        if (chatContainer && toggleBtn) {
        if (chatContainer.classList.contains('minimized')) {
            toggleBtn.textContent = '+';
            toggleBtn.title = (window.I18N ? I18N.t('restore') : 'Restore');
        } else {
            toggleBtn.textContent = '-';
            toggleBtn.title = (window.I18N ? I18N.t('minimize') : 'Minimize');
            scrollToBottom(); // 初始加载时滚动一次
        }
    }

    // 设置初始按钮状态 - 侧边栏
    if (sidebar && toggleSidebarBtn) {
        if (sidebar.classList.contains('minimized')) {
            toggleSidebarBtn.textContent = '+';
            toggleSidebarBtn.title = '展开侧边栏';
        } else {
            toggleSidebarBtn.textContent = '-';
            toggleSidebarBtn.title = '折叠侧边栏';
        }
    }

    // 确保自动滚动在页面加载后生效
    scrollToBottom();
});

// 监听 DOM 变化，确保新内容添加后自动滚动
const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            scrollToBottom();
        }
    });
});

// 开始观察聊天内容区域的变化
if (chatContentWrapper) {
    observer.observe(chatContentWrapper, {childList: true, subtree: true});
}

// --- 聊天框拖动与触摸移动（兼容PC与移动端） ---
(() => {
    if (!chatContainer) return;
    const chatHeader = document.getElementById('chat-header');
    const textInputArea = document.getElementById('text-input-area');

    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let startLeft = 0;
    let startTop = 0;

    const clamp = (val, min, max) => Math.min(Math.max(val, min), max);

    const onDragStart = (clientX, clientY) => {
        if (chatContainer.classList.contains('minimized')) return;
        isDragging = true;
        justDragged = true;
        dragStartX = clientX;
        dragStartY = clientY;
        const rect = chatContainer.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        // 采用 top/left 定位，清理 bottom 以避免冲突
        chatContainer.style.bottom = 'auto';
        document.body.style.userSelect = 'none';
    };

    const onDragMove = (clientX, clientY) => {
        if (!isDragging) return;
        const dx = clientX - dragStartX;
        const dy = clientY - dragStartY;
        const newLeft = clamp(startLeft + dx, 0, window.innerWidth - chatContainer.offsetWidth);
        const newTop = clamp(startTop + dy, 0, window.innerHeight - chatContainer.offsetHeight);
        chatContainer.style.left = `${newLeft}px`;
        chatContainer.style.top = `${newTop}px`;
    };

    const onDragEnd = () => {
        if (!isDragging) return;
        isDragging = false;
        document.body.style.userSelect = '';
        setTimeout(() => { justDragged = false; }, 100);
    };

    // Mouse 事件
    (chatHeader || chatContainer).addEventListener('mousedown', (e) => {
        onDragStart(e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', (e) => onDragMove(e.clientX, e.clientY));
    window.addEventListener('mouseup', onDragEnd);

    // Touch 事件
    (chatHeader || chatContainer).addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        onDragStart(t.clientX, t.clientY);
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
        const t = e.touches[0];
        onDragMove(t.clientX, t.clientY);
    }, { passive: true });
    window.addEventListener('touchend', onDragEnd);

    // 防误触：拖动时屏蔽输入区域点击
    if (textInputArea) {
        textInputArea.addEventListener('click', (e) => {
            if (isDragging) e.stopPropagation();
        });
    }
})();


// #########################################################
// Below is the auto-folding logic for sidebarbox
// #########################################################
// 通用：使任意浮窗支持拖拽与右下角缩放，并持久化位置/尺寸/折叠
window.makeDraggableResizablePanel = function(panelId, headerId, resizerId, storeKey) {
    try {
        const panel = document.getElementById(panelId);
        const header = document.getElementById(headerId) || panel;
        const resizer = document.getElementById(resizerId);
        if (!panel) return;

        const clamp = (x, y) => {
            const w = window.innerWidth, h = window.innerHeight;
            const pw = panel.offsetWidth || 300;
            const ph = panel.offsetHeight || 200;
            const nx = Math.max(4, Math.min(w - pw - 4, x));
            const ny = Math.max(4, Math.min(h - ph - 4, y));
            return [nx, ny];
        };

        try {
            const s = localStorage.getItem(storeKey + '_pos');
            const z = localStorage.getItem(storeKey + '_size');
            const m = localStorage.getItem(storeKey + '_min');
            if (z) { const w = Math.max(240, Math.min(560, parseInt(z))); panel.style.width = w + 'px'; }
            if (s) {
                const o = JSON.parse(s);
                if (typeof o.left === 'number') { panel.style.left = o.left + 'px'; panel.style.right = 'auto'; }
                if (typeof o.top === 'number') { panel.style.top = o.top + 'px'; panel.style.bottom = 'auto'; }
            }
            if (m === '1') {
                panel.classList.add('minimized');
                panel.style.width = '48px';
                panel.style.height = '48px';
                panel.style.padding = '0';
            }
        } catch (_) {}

        let dragging = false, resizing = false, sx = 0, sy = 0, px = 0, py = 0, pw = 0;
        const onDragStart = (clientX, clientY) => {
            // 归档面板在最小化时不触发拖拽，避免影响点击还原
            if (panel.classList.contains('minimized') && storeKey === 'cc_panel') return;
            dragging = true; sx = clientX; sy = clientY;
            const rect = panel.getBoundingClientRect(); px = rect.left; py = rect.top;
            panel.style.bottom = 'auto'; panel.style.right = 'auto';
            document.body.style.userSelect = 'none';
        };
        const onDragMove = (clientX, clientY) => {
            if (!dragging && !resizing) return;
            if (dragging) {
                const dx = clientX - sx, dy = clientY - sy; const [nx, ny] = clamp(px + dx, py + dy);
                panel.style.left = nx + 'px'; panel.style.top = ny + 'px';
            } else if (resizing) {
                const dx = clientX - sx; const w = Math.max(240, Math.min(560, pw + dx)); panel.style.width = w + 'px';
            }
        };
        const onDragEnd = () => {
            if (!dragging && !resizing) return;
            document.body.style.userSelect = '';
            if (dragging) {
                dragging = false;
                try { const rect = panel.getBoundingClientRect(); localStorage.setItem(storeKey + '_pos', JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) })); } catch (_) {}
            }
            if (resizing) {
                resizing = false;
                try { localStorage.setItem(storeKey + '_size', String(panel.offsetWidth)); } catch (_) {}
            }
        };

        (header || panel).addEventListener('mousedown', (e) => onDragStart(e.clientX, e.clientY));
        panel.addEventListener('mousedown', (e) => {
            if (e.target && (e.target.closest('input,button,select,textarea'))) return;
            if (header && header.contains(e.target)) return;
            // 归档面板在最小化状态下，点击面板本体用于还原，不触发拖拽
            if (panel.classList.contains('minimized') && storeKey === 'cc_panel' && e.target === panel) return;
            onDragStart(e.clientX, e.clientY);
        });
        window.addEventListener('mousemove', (e) => onDragMove(e.clientX, e.clientY));
        window.addEventListener('mouseup', onDragEnd);
        if (resizer) {
            resizer.addEventListener('mousedown', (e) => { resizing = true; sx = e.clientX; pw = panel.offsetWidth; panel.style.bottom = 'auto'; panel.style.right = 'auto'; document.body.style.userSelect = 'none'; });
        }
    } catch (_) {}
};
// 获取组件最大宽度
const sidebarbox = document.getElementById('sidebarbox');
// const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');
//组件被重复声明

let sidebarboxWidth = sidebarbox.offsetWidth || 652;
let sidebarboxHeight = sidebarbox.offsetHeight || 308;
let maxsidebarboxWidth = sidebarboxWidth; // 组件最大宽度用于css平滑缩放（默认值）
let maxsidebarboxHeight = sidebarboxHeight; // 组件最大高度用于css平滑缩放（默认值）

const updateSidebarDimensions = () => {
    if (window.innerWidth < 768) { // 检测屏幕尺寸，不建议修改
        sidebar.style.height = 'unset';
        // maxsidebarboxWidth = "90vw"; // 把90vw转换为px
        maxsidebarboxWidth = window.innerWidth * 0.9 || 652; // 计算90vw的px值
    } else {
        sidebar.style.width = sidebar.style.height = 'unset';
        maxsidebarboxWidth = sidebarbox.offsetWidth || 652;
    }
    sidebar.style.width = maxsidebarboxWidth + 'px';
    maxsidebarboxHeight = sidebarbox.offsetHeight || 308;
    sidebar.style.height = maxsidebarboxHeight + 'px';
    console.log("Updated sidebar size → height=" + sidebar.style.height + ", width=" + sidebar.style.width);
}
window.addEventListener('resize', updateSidebarDimensions);
updateSidebarDimensions();

//设置sidebar大小以应用于css平滑缩放

sidebar.style.width = maxsidebarboxWidth + 'px';
sidebar.style.height = maxsidebarboxHeight + 'px';


// 只有自动收缩（定时器或失去焦点）导致最小化后，悬停才会触发展开（仅PC端处理）
function isMobileDevice() { // 检测方法2选1
    // return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if(window.innerWidth < 768) {
        return true; // 如果屏幕宽度小于768px，认为是移动设备
    } else {
        return false; // 否则认为是PC端
    }
}

let autoMinimized = false;

if (!isMobileDevice()) {
    sidebar.addEventListener('mouseenter', () => {
        // 仅自动收缩导致最小化时才允许悬停展开
        if (sidebar.classList.contains('minimized') && autoMinimized) {
            toggleSidebarBtn.click();
            autoMinimized = false;
        }
    });
}
// 页面打开时延迟3秒自动收缩 sidebar
// window.addEventListener('DOMContentLoaded', () => {
//     if (!sidebar.classList.contains('minimized')) {
//         setTimeout(() => {
//             toggleSidebarBtn.click();
//             autoMinimized = true;
//         }, 3000);
//     }
// });

// PC端：鼠标离开 sidebar 时延迟5秒收缩
sidebar.addEventListener('mouseleave', () => {
    if (!sidebar.classList.contains('minimized') && !isMobileDevice()) {
        setTimeout(() => {
            if (!sidebar.classList.contains('minimized')) {
                toggleSidebarBtn.click();
                autoMinimized = true;
            }
        }, 5000);
    }
});

// 移动端：点击页面其它区域时自动收缩 sidebar
if (isMobileDevice()) {
    document.addEventListener('touchstart', (e) => {
        if (!sidebar.classList.contains('minimized')) {
            if (!sidebar.contains(e.target)) {
                toggleSidebarBtn.click();
                autoMinimized = true;
            }
        }
    }, {passive: true});
    // 使 sidebar 可聚焦（可保留）
    sidebar.setAttribute('tabindex', '0');
}
