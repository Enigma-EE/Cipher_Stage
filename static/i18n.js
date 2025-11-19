// Simple front-end i18n helper for zh-CN and en
(function () {
  const STORAGE_KEY = 'ee_lang';

  const dictionaries = {
    'zh-CN': {
      // panel titles
      live2d_title: 'Live2D 控制',
      vrm_title: 'VRM 控制',
      show_hide: '显示/隐藏',
      hide_model: '隐藏',
      show_model: '显示',
      size_adjust: '大小调整',
      autohide: '自动隐藏',
      close: '关闭',
      emotion: '情绪',
      action_label: '动作',
      action_test: '动作测试',
      emotion_test: '表情测试',
      blink_label: '眨眼',
      blink: '眨眼',
      blink_once: '眨一下',
      mouth_label: '口型 (张口/元音)',
      // actions
      wave: '挥手',
      nod: '点头',
      shake: '摇头',
      bow: '鞠躬',
      // emotions
      neutral: '中性',
      happy: '开心',
      sad: '悲伤',
      angry: '生气',
      surprised: '惊讶',
      relaxed: '放松',
      // import / render
      import_vrm: '导入VRM模型',
      choose_and_load: '选择并加载',
      load_vrm_from_url: '从URL加载VRM',
      url_modal_title: '从URL加载VRM模型',
      url_placeholder: '输入远程VRM URL或相对路径',
      cancel: '取消',
      load: '加载',
      import_vrma: '导入动作 (VRMA)',
      choose_and_import: '选择并导入',
      vrma_path_placeholder: '输入 VRMA 路径或 URL，例如 /static/animations/excited.vrma',
      play_from_path: '从路径/URL播放',
      render_label: '渲染控制',
      hdr_placeholder: 'HDR URL，例如 /static/hdr/studio.hdr',
      apply_hdr: '应用HDR',
      apply_from_file: '从文件应用',
      clear_env: '清空环境',
      position_label: '位置控制',
      lock_model: '锁定模型',
      unlock_model: '解锁模型',
      show_character: '显示人物',
      hide_character: '隐藏人物',
      // common_ui.js
      restore: '还原',
      minimize: '最小化',
      // app.js model switch
      switch_to_vrm: '切换到VRM模型',
      switch_to_live2d: '切换到Live2D模型',
      // sidebar buttons (index.html)
      mic_start: '🎤 开始聊天',
      mic_pause: '⏸️ 休息一下',
      screen_share_desktop: '🖥️ 屏幕共享',
      screen_share_mobile: '📷 摄像头分享',
      stop_share: '🛑 停止共享',
      reset_session: '👋 请她离开',
      // labels
      language_label: '语言'
    },
    'en': {
      // panel titles
      live2d_title: 'Live2D Controls',
      vrm_title: 'VRM Controls',
      show_hide: 'Show/Hide',
      hide_model: 'Hide',
      show_model: 'Show',
      size_adjust: 'Size',
      autohide: 'Auto Hide',
      close: 'Off',
      emotion: 'Emotion',
      action_label: 'Actions',
      action_test: 'Action Test',
      emotion_test: 'Emotion Test',
      blink_label: 'Blink',
      blink: 'Blink',
      blink_once: 'Blink Once',
      mouth_label: 'Mouth (Open/Vowels)',
      // actions
      wave: 'Wave',
      nod: 'Nod',
      shake: 'Shake',
      bow: 'Bow',
      // emotions
      neutral: 'Neutral',
      happy: 'Happy',
      sad: 'Sad',
      angry: 'Angry',
      surprised: 'Surprised',
      relaxed: 'Relaxed',
      // import / render
      import_vrm: 'Import VRM',
      choose_and_load: 'Choose & Load',
      load_vrm_from_url: 'Load VRM from URL',
      url_modal_title: 'Load VRM from URL',
      url_placeholder: 'Enter remote VRM URL or relative path',
      cancel: 'Cancel',
      load: 'Load',
      import_vrma: 'Import Motion (VRMA)',
      choose_and_import: 'Choose & Import',
      vrma_path_placeholder: 'Enter VRMA path or URL, e.g. /static/animations/excited.vrma',
      play_from_path: 'Play from Path/URL',
      render_label: 'Rendering',
      hdr_placeholder: 'HDR URL, e.g. /static/hdr/studio.hdr',
      apply_hdr: 'Apply HDR',
      apply_from_file: 'Apply from File',
      clear_env: 'Clear Environment',
      position_label: 'Position',
      lock_model: 'Lock Model',
      unlock_model: 'Unlock Model',
      show_character: 'Show Character',
      hide_character: 'Hide Character',
      // common_ui.js
      restore: 'Restore',
      minimize: 'Minimize',
      // app.js model switch
      switch_to_vrm: 'Switch to VRM',
      switch_to_live2d: 'Switch to Live2D',
      // sidebar buttons (index.html)
      mic_start: '🎤 Start Chat',
      mic_pause: '⏸️ Take a Break',
      screen_share_desktop: '🖥️ Screen Share',
      screen_share_mobile: '📷 Camera Share',
      stop_share: '🛑 Stop Sharing',
      reset_session: '👋 Ask Her to Leave',
      // labels
      language_label: 'Language'
    }
  };

  function normalize(lang) {
    if (!lang) return 'zh-CN';
    const l = lang.toLowerCase();
    if (l.startsWith('zh')) return 'zh-CN';
    return 'en';
  }

  // migrate legacy key if exists
  const legacy = localStorage.getItem('lanlan_lang');
  const saved = localStorage.getItem(STORAGE_KEY) || legacy;
  if (legacy && !localStorage.getItem(STORAGE_KEY)) {
    try { localStorage.setItem(STORAGE_KEY, legacy); } catch (_) {}
  }
  // Default to English when no preference is saved
  const initialLang = normalize(saved || navigator.language || 'en');

  const I18N = {
    lang: initialLang,
    setLanguage(lang) {
      this.lang = normalize(lang);
      try { localStorage.setItem(STORAGE_KEY, this.lang); } catch (_) {}
      this.applyStaticLabels();
      // dispatch event so dynamic components can react
      window.dispatchEvent(new CustomEvent('ee:language-changed', { detail: { lang: this.lang } }));
      // also update <html lang>
      try { document.documentElement.setAttribute('lang', this.lang); } catch (_) {}
    },
    t(key) {
      const dict = dictionaries[this.lang] || dictionaries['zh-CN'];
      return dict[key] || key;
    },
    applyStaticLabels() {
      // Update sidebar buttons if present
      const micBtn = document.getElementById('micButton');
      const muteBtn = document.getElementById('muteButton');
      const screenBtn = document.getElementById('screenButton');
      const stopBtn = document.getElementById('stopButton');
      const resetBtn = document.getElementById('resetSessionButton');

      if (micBtn) micBtn.textContent = this.t('mic_start');
      if (muteBtn) muteBtn.textContent = this.t('mic_pause');

      if (screenBtn) {
        // screen button may have desktop/mobile spans
        const desktopSpan = screenBtn.querySelector('.desktop-text');
        const mobileSpan = screenBtn.querySelector('.mobile-text');
        if (desktopSpan) desktopSpan.textContent = this.t('screen_share_desktop');
        if (mobileSpan) mobileSpan.textContent = this.t('screen_share_mobile');
        if (!desktopSpan && !mobileSpan) screenBtn.textContent = this.t('screen_share_desktop');
      }
      if (stopBtn) stopBtn.textContent = this.t('stop_share');
      if (resetBtn) resetBtn.textContent = this.t('reset_session');

      // Update language label if present
      const langLabel = document.getElementById('lang-label');
      if (langLabel) langLabel.textContent = this.t('language_label');
    }
  };

  // Expose globally
  window.I18N = I18N;

  // Apply on DOMContentLoaded
  document.addEventListener('DOMContentLoaded', function () {
    I18N.setLanguage(I18N.lang);
  });
})();