// ==UserScript==
// @name         Chat Navigator - Gemini & ChatGPT
// @author       小麦汁
// @namespace    http://tampermonkey.net/
// @version      2.8
// @description  快速定位 Gemini 和 ChatGPT 历史对话，点击跳转到对应位置
// @match        https://gemini.google.com/*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const isGemini  = location.hostname === 'gemini.google.com';
  const isChatGPT = location.hostname === 'chatgpt.com' || location.hostname === 'chat.openai.com';
  if (!isGemini && !isChatGPT) return;

  console.log('[ChatNav] script running on', location.hostname);

  // ── 工具 ──────────────────────────────────────────────────────────────────
  function css(el, obj) {
    for (const [k, v] of Object.entries(obj)) el.style.setProperty(k, v, 'important');
  }

  // ── 主题配色 ──────────────────────────────────────────────────────────────
  const THEMES = {
    dark: {
      panelBg: '#1e1e2e', headerBg: '#313244', searchBg: '#181825',
      inputBg: '#313244', inputBorder: '#45475a', inputFocusBorder: '#89b4fa',
      text: '#cdd6f4', textSec: '#a6adc8', textMuted: '#585b70',
      hoverBg: '#313244', activeBorder: '#89b4fa',
      userRole: '#89dceb', aiRole: '#a6e3a1',
      shadow: '0 8px 32px rgba(0,0,0,0.55)',
      toggleBg: '#1e1e2e', toggleBorder: '#45475a', toggleColor: '#89b4fa',
      btnColor: '#a6adc8', btnHoverColor: '#cdd6f4', btnHoverBg: '#45475a',
      scrollThumb: '#45475a', borderLine: '#313244',
    },
    light: {
      panelBg: '#ffffff', headerBg: '#f0f1f5', searchBg: '#f8f8fb',
      inputBg: '#ffffff', inputBorder: '#d0d1d8', inputFocusBorder: '#3b82f6',
      text: '#1a1a2e', textSec: '#555566', textMuted: '#999aab',
      hoverBg: '#f0f1f5', activeBorder: '#3b82f6',
      userRole: '#0891b2', aiRole: '#16a34a',
      shadow: '0 8px 32px rgba(0,0,0,0.12)',
      toggleBg: '#ffffff', toggleBorder: '#d0d1d8', toggleColor: '#3b82f6',
      btnColor: '#666677', btnHoverColor: '#333344', btnHoverBg: '#e0e1e8',
      scrollThumb: '#c0c1c8', borderLine: '#e0e1e8',
    },
  };

  let isDark = localStorage.getItem('__cnav_theme__') !== 'light';
  function T() { return isDark ? THEMES.dark : THEMES.light; }

  // ── 滚动条样式 ────────────────────────────────────────────────────────────
  const STYLE_ID = '__cnav_style__';
  function updateStyleTag() {
    let s = document.getElementById(STYLE_ID);
    if (!s) {
      s = document.createElement('style');
      s.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(s);
    }
    s.textContent = `
      #__cnav_list::-webkit-scrollbar { width: 4px !important; }
      #__cnav_list::-webkit-scrollbar-thumb { background: ${T().scrollThumb} !important; border-radius: 2px !important; }
    `;
  }

  // ── 状态 ──────────────────────────────────────────────────────────────────
  const POS_KEY = '__cnav_pos__';
  const SIZE_KEY = '__cnav_size__';
  const OPEN_KEY = '__cnav_open__';
  const MORE_KEY = '__cnav_more__';
  const CASE_KEY = '__cnav_case__';
  const MONITOR_KEY = '__cnav_monitor__';
  let storedOpenState = localStorage.getItem(OPEN_KEY);
  if (storedOpenState !== 'true' && storedOpenState !== 'false') {
    storedOpenState = 'true';
    localStorage.setItem(OPEN_KEY, storedOpenState);
  }
  let panelOpen = storedOpenState !== 'false';
  let storedMonitorState = localStorage.getItem(MONITOR_KEY);
  if (storedMonitorState !== 'on' && storedMonitorState !== 'off') {
    storedMonitorState = 'off';
    localStorage.setItem(MONITOR_KEY, storedMonitorState);
  }
  let monitoringEnabled = storedMonitorState === 'on';
  let caseSensitive = false;
  let allMessages = [], filterText = '', activeIndex = -1;
  let matchList = [], currentMatchIdx = -1;
  let lastMessageSignature = null;
  let shadowQueryCache = null, shadowQueryCacheTime = 0, lastUrl = location.href;
  let panel, toggle, list, searchInput, countSpan, matchCounter;
  let headerEl, secondaryBar, searchDivEl, btnMore, btnMonitor, btnCase, btnExport, btnTheme, btnRefresh, btnClose, btnPrev, btnNext;
  let dragging = false, offX = 0, offY = 0;
  let resizing = false;
  let resDir = {};
  let resStartX = 0, resStartY = 0;
  let resStartW = 0, resStartH = 0;
  let resStartLeft = 0;
  let observer = null, keepAliveObserver = null, keepAliveTimer = null, refreshTimer = null, tryRefreshTimer = null, searchDebounceTimer = null;

  // ── 创建按钮 ──────────────────────────────────────────────────────────────
  function makeBtn(text, title) {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = title;
    css(b, {
      background: 'none', border: 'none', color: T().btnColor,
      cursor: 'pointer', 'font-size': '16px', padding: '2px 6px',
      'line-height': '1', 'border-radius': '4px', 'font-family': 'inherit',
    });
    b.addEventListener('mouseenter', () => css(b, { color: T().btnHoverColor, background: T().btnHoverBg }));
    b.addEventListener('mouseleave', () => css(b, { color: T().btnColor, background: 'none' }));
    return b;
  }

  function getSavedPosition() {
    let pos = null;
    try {
      pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    } catch(e) {
      localStorage.removeItem(POS_KEY);
    }
    if (!pos || typeof pos.top !== 'number' || typeof pos.left !== 'number' ||
        !Number.isFinite(pos.top) || !Number.isFinite(pos.left) ||
        pos.top < 0 || pos.top > window.innerHeight - 40 ||
        pos.left < 0 || pos.left > window.innerWidth - 40) {
      if (pos) localStorage.removeItem(POS_KEY);
      return null;
    }
    return pos;
  }

  function applySavedPosition(absolute = false) {
    const pos = getSavedPosition();
    if (!pos) return false;
    const scrollX = absolute ? (window.scrollX || window.pageXOffset || 0) : 0;
    const scrollY = absolute ? (window.scrollY || window.pageYOffset || 0) : 0;
    css(panel, { top: (scrollY + pos.top) + 'px', left: (scrollX + pos.left) + 'px', right: 'auto' });
    css(toggle, { top: (scrollY + pos.top) + 'px' });
    return true;
  }

  function savePanelPosition() {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    localStorage.setItem(POS_KEY, JSON.stringify({ top: rect.top, left: rect.left }));
  }

  function getSavedSize() {
    let size = null;
    try {
      size = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
    } catch(e) {
      localStorage.removeItem(SIZE_KEY);
    }
    if (!size || typeof size.w !== 'number' || typeof size.h !== 'number' ||
        !Number.isFinite(size.w) || !Number.isFinite(size.h) ||
        size.w < 220 || size.h < 200) {
      if (size) localStorage.removeItem(SIZE_KEY);
      return null;
    }
    return size;
  }

  function applySavedSize() {
    const size = getSavedSize();
    if (!size) return;
    css(panel, { width: size.w + 'px', 'max-height': size.h + 'px' });
  }

  function savePanelSize() {
    if (!panel) return;
    localStorage.setItem(SIZE_KEY, JSON.stringify({ w: panel.offsetWidth, h: panel.offsetHeight }));
  }

  function wrapMarkdownBlock(text) {
    const matches = text.match(/`+/g) || [];
    const maxTicks = matches.reduce((max, ticks) => Math.max(max, ticks.length), 0);
    const fence = '`'.repeat(Math.max(3, maxTicks + 1));
    return [fence + 'markdown', text, fence].join('\n');
  }

  function exportMessages() {
    if (allMessages.length === 0) {
      btnExport.title = '暂无对话内容';
      setTimeout(() => { btnExport.title = '导出对话'; }, 1500);
      return;
    }
    const site = location.hostname;
    const date = new Date().toLocaleString('zh-CN');
    const markdown = [
      '# 对话导出',
      '',
      `- 来源：${site}`,
      `- 导出时间：${date}`,
      `- 消息数量：${allMessages.length}`,
      '',
      '---',
      '',
      ...allMessages.flatMap((m, i) => [
        `## ${i + 1}. ${m.role === 'user' ? 'You' : 'AI'}`,
        '',
        wrapMarkdownBlock(m.text),
        '',
        '---',
        '',
      ]),
    ].join('\n');
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chat-export-' + Date.now() + '.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function updateMonitorButton() {
    if (!btnMonitor) return;
    btnMonitor.textContent = monitoringEnabled ? '▶' : '⏸';
    btnMonitor.title = monitoringEnabled ? '暂停监控' : '启用监控';
  }

  function setMoreOpen(open) {
    if (secondaryBar) css(secondaryBar, { display: open ? 'flex' : 'none' });
    if (btnMore) {
      btnMore.textContent = '⚙';
      css(btnMore, { color: open ? T().activeBorder : T().btnColor });
    }
    localStorage.setItem(MORE_KEY, open ? 'true' : 'false');
  }

  // ── 应用主题到所有元素 ────────────────────────────────────────────────────
  function applyTheme() {
    const t = T();
    if (panel)     css(panel, { background: t.panelBg, color: t.text, 'box-shadow': t.shadow });
    if (headerEl)  css(headerEl, { background: t.headerBg, color: t.text });
    if (secondaryBar) css(secondaryBar, { background: t.headerBg, 'border-bottom': '1px solid ' + t.borderLine });
    if (countSpan) css(countSpan, { color: t.textMuted });
    if (matchCounter) css(matchCounter, { color: t.textMuted });
    if (searchDivEl) css(searchDivEl, { background: t.searchBg, 'border-bottom': '1px solid ' + t.borderLine });
    if (searchInput) css(searchInput, { background: t.inputBg, border: '1px solid ' + t.inputBorder, color: t.text });
    if (toggle)    css(toggle, { background: t.toggleBg, border: '1px solid ' + t.toggleBorder, color: t.toggleColor });
    // 按钮颜色
    [btnTheme, btnRefresh, btnClose, btnMore, btnExport, btnMonitor, btnPrev, btnNext].forEach(b => {
      if (b) css(b, { color: t.btnColor });
    });
    if (btnMore) css(btnMore, { color: localStorage.getItem(MORE_KEY) === 'true' ? t.activeBorder : t.btnColor });
    if (btnCase) css(btnCase, { color: caseSensitive ? t.activeBorder : t.btnColor });
    updateMonitorButton();
    if (btnTheme) btnTheme.textContent = isDark ? '☀' : '🌙';
    updateStyleTag();
    renderList(); // 重新渲染列表条目颜色
  }

  // ── 构建面板 DOM ──────────────────────────────────────────────────────────
  function buildPanel() {
    const t = T();

    // --- 主面板 ---
    panel = document.createElement('div');
    panel.id = '__cnav_panel';
    css(panel, {
      position: 'fixed', top: '80px', right: '16px', left: 'auto', bottom: 'auto',
      width: '260px', 'max-height': '340px',
      background: t.panelBg, color: t.text,
      'border-radius': '12px', 'box-shadow': t.shadow,
      'font-family': 'system-ui, -apple-system, sans-serif',
      'font-size': '13px', 'z-index': '2147483647',
      display: 'flex', 'flex-direction': 'column',
      overflow: 'hidden', 'user-select': 'none',
      'box-sizing': 'border-box',
      visibility: 'visible', opacity: '1',
      transform: 'none', filter: 'none',
      'pointer-events': 'auto',
    });

    // --- 头部 ---
    headerEl = document.createElement('div');
    css(headerEl, {
      display: 'flex', 'align-items': 'center', 'justify-content': 'space-between',
      padding: '10px 12px', background: t.headerBg, cursor: 'move',
      'border-radius': '12px 12px 0 0', 'flex-shrink': '0',
      'font-weight': '600', 'font-size': '13px', color: t.text,
    });

    const titleSpan = document.createElement('span');
    titleSpan.textContent = '对话导航';
    countSpan = document.createElement('span');
    css(countSpan, { color: t.textMuted, 'font-weight': '400', 'margin-left': '4px', 'font-size': '12px' });
    titleSpan.appendChild(countSpan);

    const btnsDiv = document.createElement('span');
    css(btnsDiv, { display: 'flex', gap: '4px' });
    btnMore    = makeBtn('⚙', '更多选项');
    btnRefresh = makeBtn('↻', '刷新');
    btnClose   = makeBtn('×', '收起');
    btnsDiv.appendChild(btnMore);
    btnsDiv.appendChild(btnRefresh);
    btnsDiv.appendChild(btnClose);

    headerEl.appendChild(titleSpan);
    headerEl.appendChild(btnsDiv);

    secondaryBar = document.createElement('div');
    secondaryBar.id = '__cnav_secondary__';
    css(secondaryBar, {
      display: 'none',
      'align-items': 'center',
      'justify-content': 'flex-end',
      gap: '4px',
      padding: '4px 10px',
      'border-bottom': '1px solid ' + t.borderLine,
      background: t.headerBg,
      'flex-shrink': '0',
    });
    const barLabel = document.createElement('span');
    barLabel.textContent = '更多选项';
    css(barLabel, { flex: '1', color: t.textMuted, 'font-size': '11px' });
    btnCase    = makeBtn('Aa', '大小写敏感');
    btnExport  = makeBtn('↓', '导出对话');
    btnTheme   = makeBtn(isDark ? '☀' : '🌙', '切换主题');
    btnMonitor = makeBtn(monitoringEnabled ? '▶' : '⏸', monitoringEnabled ? '暂停监控' : '启用监控');
    secondaryBar.appendChild(barLabel);
    secondaryBar.appendChild(btnCase);
    secondaryBar.appendChild(btnExport);
    secondaryBar.appendChild(btnTheme);
    secondaryBar.appendChild(btnMonitor);

    // --- 搜索栏 ---
    searchDivEl = document.createElement('div');
    css(searchDivEl, { display: 'flex', 'align-items': 'center', gap: '4px', padding: '8px 10px', background: t.searchBg, 'border-bottom': '1px solid ' + t.borderLine, 'flex-shrink': '0' });
    searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = '搜索对话内容…';
    css(searchInput, {
      width: 'calc(100% - 80px)', background: t.inputBg, border: '1px solid ' + t.inputBorder,
      'border-radius': '6px', color: t.text, padding: '5px 8px',
      'font-size': '12px', outline: 'none', 'box-sizing': 'border-box',
      'font-family': 'inherit',
    });
    const searchBtnsDiv = document.createElement('span');
    css(searchBtnsDiv, { display: 'flex', 'align-items': 'center', gap: '2px', 'flex-shrink': '0' });
    matchCounter = document.createElement('span');
    css(matchCounter, { width: '36px', color: t.textMuted, 'font-size': '11px', 'text-align': 'center' });
    btnPrev = makeBtn('▲', '上一个匹配');
    btnNext = makeBtn('▼', '下一个匹配');
    css(btnPrev, { 'font-size': '12px' });
    css(btnNext, { 'font-size': '12px' });
    searchBtnsDiv.appendChild(matchCounter);
    searchBtnsDiv.appendChild(btnPrev);
    searchBtnsDiv.appendChild(btnNext);
    searchDivEl.appendChild(searchInput);
    searchDivEl.appendChild(searchBtnsDiv);

    // --- 列表 ---
    list = document.createElement('div');
    list.id = '__cnav_list';
    css(list, { 'overflow-y': 'auto', flex: '1', padding: '6px 0' });

    panel.appendChild(headerEl);
    panel.appendChild(secondaryBar);
    panel.appendChild(searchDivEl);
    panel.appendChild(list);

    function makeResizeHandle(id, styles, dir) {
      const h = document.createElement('div');
      h.id = id;
      css(h, { position: 'absolute', 'z-index': '10', ...styles });
      h.addEventListener('mousedown', e => onResizeStart(e, dir));
      panel.appendChild(h);
    }
    makeResizeHandle('__cnav_resize_e__', { top: '12px', right: '0', width: '5px', bottom: '12px', cursor: 'e-resize' }, { e: true });
    makeResizeHandle('__cnav_resize_w__', { top: '12px', left: '0', width: '5px', bottom: '12px', cursor: 'w-resize' }, { w: true });
    makeResizeHandle('__cnav_resize_s__', { bottom: '0', left: '12px', right: '12px', height: '5px', cursor: 's-resize' }, { s: true });
    makeResizeHandle('__cnav_resize_se__', { bottom: '0', right: '0', width: '14px', height: '14px', cursor: 'se-resize' }, { e: true, s: true });
    makeResizeHandle('__cnav_resize_sw__', { bottom: '0', left: '0', width: '14px', height: '14px', cursor: 'sw-resize' }, { w: true, s: true });

    // --- 圆形切换按钮 ---
    toggle = document.createElement('div');
    toggle.id = '__cnav_toggle';
    toggle.textContent = '☰';
    toggle.title = '打开对话导航';
    css(toggle, {
      position: 'fixed', top: '80px', right: '16px', left: 'auto', bottom: 'auto',
      width: '38px', height: '38px',
      background: t.toggleBg, border: '1px solid ' + t.toggleBorder,
      'border-radius': '50%', color: t.toggleColor,
      'font-size': '18px', cursor: 'pointer',
      'z-index': '2147483647',
      display: 'none', 'align-items': 'center', 'justify-content': 'center',
      'box-shadow': '0 4px 12px rgba(0,0,0,0.15)',
      visibility: 'visible', opacity: '1',
      transform: 'none', filter: 'none',
      'pointer-events': 'auto',
      'text-align': 'center', 'line-height': '38px',
    });

    // --- 事件 ---
    btnMore.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = secondaryBar.style.getPropertyValue('display') !== 'flex';
      setMoreOpen(isOpen);
    });
    btnMore.addEventListener('mouseleave', () => {
      css(btnMore, { color: localStorage.getItem(MORE_KEY) === 'true' ? T().activeBorder : T().btnColor, background: 'none' });
    });
    btnTheme.addEventListener('click', e => {
      e.stopPropagation();
      isDark = !isDark;
      localStorage.setItem('__cnav_theme__', isDark ? 'dark' : 'light');
      applyTheme();
    });
    btnCase.addEventListener('click', e => {
      e.stopPropagation();
      caseSensitive = !caseSensitive;
      localStorage.setItem(CASE_KEY, caseSensitive ? 'true' : 'false');
      css(btnCase, { color: caseSensitive ? T().activeBorder : T().btnColor });
      renderList();
      buildMatchList();
      updateMatchCounter();
    });
    btnCase.addEventListener('mouseleave', () => {
      css(btnCase, { color: caseSensitive ? T().activeBorder : T().btnColor, background: 'none' });
    });
    btnMonitor.addEventListener('click', e => {
      e.stopPropagation();
      setMonitoringEnabled(!monitoringEnabled);
    });
    btnExport.addEventListener('click', e => {
      e.stopPropagation();
      exportMessages();
    });
    btnRefresh.addEventListener('click', e => { e.stopPropagation(); refresh(); });
    btnClose.addEventListener('click', e => {
      e.stopPropagation();
      css(panel, { display: 'none' });
      css(toggle, { display: 'flex' });
      panelOpen = false;
      localStorage.setItem(OPEN_KEY, 'false');
    });
    toggle.addEventListener('click', () => {
      css(panel, { display: 'flex' });
      css(toggle, { display: 'none' });
      panelOpen = true;
      localStorage.setItem(OPEN_KEY, 'true');
      refresh();
    });
    searchInput.addEventListener('input', () => {
      filterText = searchInput.value;
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        renderList();
        buildMatchList();
        updateMatchCounter();
      }, 300);
    });
    searchInput.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (matchList.length === 0 && filterText) buildMatchList();
      navigateToMatch(e.shiftKey ? currentMatchIdx - 1 : currentMatchIdx + 1);
    });
    btnPrev.addEventListener('click', e => {
      e.stopPropagation();
      if (matchList.length === 0 && filterText) buildMatchList();
      navigateToMatch(currentMatchIdx - 1);
    });
    btnNext.addEventListener('click', e => {
      e.stopPropagation();
      if (matchList.length === 0 && filterText) buildMatchList();
      navigateToMatch(currentMatchIdx + 1);
    });

    document.removeEventListener('keydown', onGlobalKeyDown);
    document.addEventListener('keydown', onGlobalKeyDown);

    // 拖拽
    headerEl.addEventListener('mousedown', e => {
      if (resizing) return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;
      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', onDragEnd);
    });
    window.removeEventListener('resize', clampPosition);
    window.addEventListener('resize', clampPosition);
  }

  function onDragMove(e) {
    if (!dragging) return;
    css(panel, { left: (e.clientX - offX) + 'px', top: (e.clientY - offY) + 'px', right: 'auto' });
  }

  function onDragEnd() {
    if (dragging) {
      dragging = false;
      savePanelPosition();
    }
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
  }

  function onResizeStart(e, dir) {
    e.stopPropagation();
    e.preventDefault();
    resizing = true;
    resDir = dir;
    resStartX = e.clientX;
    resStartY = e.clientY;
    resStartW = panel.offsetWidth;
    resStartH = panel.offsetHeight;
    resStartLeft = parseFloat(panel.style.getPropertyValue('left')) || panel.getBoundingClientRect().left;
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeEnd);
  }

  function onResizeMove(e) {
    if (!resizing) return;
    const dx = e.clientX - resStartX;
    const dy = e.clientY - resStartY;

    if (resDir.e) {
      const newW = Math.max(220, resStartW + dx);
      css(panel, { width: newW + 'px' });
    }
    if (resDir.w) {
      const newW = Math.max(220, resStartW - dx);
      const newLeft = resStartLeft + (resStartW - newW);
      css(panel, { width: newW + 'px', left: newLeft + 'px', right: 'auto' });
    }
    if (resDir.s) {
      const newH = Math.max(200, resStartH + dy);
      css(panel, { 'max-height': newH + 'px' });
    }
  }

  function onResizeEnd() {
    if (!resizing) return;
    resizing = false;
    resDir = {};
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeEnd);
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    localStorage.setItem(SIZE_KEY, JSON.stringify({ w, h }));
    const left = parseFloat(panel.style.getPropertyValue('left')) || panel.getBoundingClientRect().left;
    const top  = parseFloat(panel.style.getPropertyValue('top'))  || panel.getBoundingClientRect().top;
    localStorage.setItem(POS_KEY, JSON.stringify({ top, left }));
  }

  function onGlobalKeyDown(e) {
    if (e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      if (panel.style.getPropertyValue('display') === 'none') {
        css(panel, { display: 'flex' });
        css(toggle, { display: 'none' });
        panelOpen = true;
        localStorage.setItem(OPEN_KEY, 'true');
        refresh();
      }
      searchInput.focus();
      searchInput.select();
    }
    if (e.key === 'Escape' && panel.style.getPropertyValue('display') !== 'none') {
      e.preventDefault();
      css(panel, { display: 'none' });
      css(toggle, { display: 'flex' });
      panelOpen = false;
      localStorage.setItem(OPEN_KEY, 'false');
    }
  }

  // ── 注入到页面 ────────────────────────────────────────────────────────────
  function inject() {
    if (document.getElementById('__cnav_panel') && document.getElementById('__cnav_toggle')) return;
    ['__cnav_panel', '__cnav_toggle'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
    updateStyleTag();
    caseSensitive = localStorage.getItem(CASE_KEY) === 'true';
    buildPanel();
    document.body.appendChild(panel);
    document.body.appendChild(toggle);
    if (keepAliveTimer !== null) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    applySavedPosition();
    applySavedSize();
    setMoreOpen(localStorage.getItem(MORE_KEY) === 'true');
    if (btnCase) css(btnCase, { color: caseSensitive ? T().activeBorder : T().btnColor });
    panelOpen = localStorage.getItem(OPEN_KEY) !== 'false';
    if (!panelOpen) {
      css(panel, { display: 'none' });
      css(toggle, { display: 'flex' });
    }
    console.log('[ChatNav] panel injected');
    setTimeout(fixPositionFallback, 600);
  }

  // ── fixed 定位失效回退 ────────────────────────────────────────────────────
  let usingAbsolute = false;
  function fixPositionFallback() {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    console.log('[ChatNav] panel rect:', JSON.stringify({ top: rect.top, right: window.innerWidth - rect.right, w: rect.width, h: rect.height }));
    if (rect.width < 10 || rect.height < 10 ||
        rect.top < -300 || rect.top > window.innerHeight + 300 ||
        rect.right < -300) {
      console.log('[ChatNav] fixed positioning broken, switching to absolute');
      usingAbsolute = true;
      css(panel,  { position: 'absolute' });
      css(toggle, { position: 'absolute' });
      if (!applySavedPosition(true)) updateAbsolutePosition();
    }
  }

  function updateAbsolutePosition() {
    if (!usingAbsolute || !panel) return;
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const panelHidden = panel.style.getPropertyValue('display') === 'none';
    const pos = getSavedPosition();
    if (pos) {
      if (!panelHidden) {
        css(panel, { top: (scrollY + pos.top) + 'px', left: (scrollX + pos.left) + 'px', right: 'auto' });
      }
      css(toggle, { top: (scrollY + pos.top) + 'px', left: (scrollX + window.innerWidth - 38 - 16) + 'px', right: 'auto' });
      return;
    }
    if (!panelHidden) {
      css(panel, { top: (scrollY + 80) + 'px', left: (scrollX + window.innerWidth - 260 - 16) + 'px', right: 'auto' });
    }
    css(toggle, { top: (scrollY + 80) + 'px', left: (scrollX + window.innerWidth - 38 - 16) + 'px', right: 'auto' });
  }

  function clampPosition() {
    if (!panel) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const panelHidden = panel.style.getPropertyValue('display') === 'none';
    if (!panelHidden) {
      const pw = panel.offsetWidth;
      const ph = panel.offsetHeight;
      let top  = parseFloat(panel.style.getPropertyValue('top'))  || panel.getBoundingClientRect().top;
      let left = parseFloat(panel.style.getPropertyValue('left')) || panel.getBoundingClientRect().left;
      top  = Math.min(Math.max(top,  0), vh - 40);
      left = Math.min(Math.max(left, 0), vw - Math.min(pw, vw));
      css(panel, { top: top + 'px', left: left + 'px', right: 'auto' });
    }

    let tTop  = parseFloat(toggle.style.getPropertyValue('top'))  || toggle.getBoundingClientRect().top;
    let tLeft = parseFloat(toggle.style.getPropertyValue('left')) || toggle.getBoundingClientRect().left;
    tTop  = Math.min(Math.max(tTop,  0), vh - 40);
    tLeft = Math.min(Math.max(tLeft, 0), vw - 40);
    css(toggle, { top: tTop + 'px', left: tLeft + 'px', right: 'auto' });

    localStorage.setItem(POS_KEY, JSON.stringify({
      top:  parseFloat(panel.style.getPropertyValue('top')),
      left: parseFloat(panel.style.getPropertyValue('left')),
    }));
  }

  // ── 消息抓取：ChatGPT ─────────────────────────────────────────────────────
  function getChatGPTMessages() {
    const roleEls = document.querySelectorAll('[data-message-author-role]');
    if (roleEls.length > 0) {
      return Array.from(roleEls).map(el => ({
        el: el.closest('article') || el,
        role: el.getAttribute('data-message-author-role') === 'user' ? 'user' : 'ai',
        text: el.innerText.trim(),
      }));
    }
    return Array.from(
      document.querySelectorAll('article[data-testid^="conversation-turn-"]')
    ).map((el, i) => ({ el, role: i % 2 === 0 ? 'user' : 'ai', text: el.innerText.trim() }));
  }

  // ── 深度查询：穿透 Shadow DOM ─────────────────────────────────────────────
  function deepQueryAll(selector) {
    const results = [];
    function search(root) {
      try { root.querySelectorAll(selector).forEach(el => results.push(el)); } catch(e) {}
      let children;
      try { children = root.querySelectorAll('*'); } catch(e) { return; }
      for (const child of children) {
        if (child.shadowRoot) search(child.shadowRoot);
      }
    }
    search(document);
    return results;
  }

  // ── 消息抓取：Gemini ──────────────────────────────────────────────────────
  function getGeminiMessages() {
    const TAG_SELECTORS = [
      'user-query, model-response',
      'conversation-turn',
      'chat-message',
      'message-content',
    ];
    const CLASS_SELECTORS = [
      '[class*="query-text"]',
      '[class*="response-container"]',
      '[class*="user-query"]',
      '[class*="model-response"]',
      '[class*="conversation-turn"]',
      '[class*="message-wrapper"]',
      '[class*="turn-content"]',
      '[class*="chat-turn"]',
    ].join(',');
    const DATA_SELECTORS = '[data-turn-id],[data-content-id],[data-chunk-index],[data-message-id]';

    function detectRole(el, i) {
      const tag = el.tagName.toLowerCase();
      const cls = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
      if (tag === 'user-query' || tag.includes('user') || tag.includes('human')) return 'user';
      if (tag === 'model-response' || tag.includes('model') || tag.includes('bot')) return 'ai';
      if (cls.includes('user') || cls.includes('human') || cls.includes('query-text')) return 'user';
      if (cls.includes('model') || cls.includes('bot') || cls.includes('response')) return 'ai';
      if (el.hasAttribute('data-is-user') || el.getAttribute('data-author-type') === 'user') return 'user';
      return i % 2 === 0 ? 'user' : 'ai';
    }

    function trySelectors(queryFn) {
      for (const sel of TAG_SELECTORS) {
        const els = queryFn(sel);
        if (els.length > 0) {
          console.log('[ChatNav] Gemini: matched selector:', sel, 'count:', els.length);
          return els.map((el, i) => ({ el, role: detectRole(el, i), text: (el.innerText || el.textContent || '').trim() }));
        }
      }
      const byClass = queryFn(CLASS_SELECTORS);
      if (byClass.length > 0) {
        console.log('[ChatNav] Gemini: matched class selectors, count:', byClass.length);
        return byClass.map((el, i) => ({ el, role: detectRole(el, i), text: (el.innerText || el.textContent || '').trim() }));
      }
      const byData = queryFn(DATA_SELECTORS);
      if (byData.length > 0) {
        console.log('[ChatNav] Gemini: matched data selectors, count:', byData.length);
        return byData.map((el, i) => ({ el, role: detectRole(el, i), text: (el.innerText || el.textContent || '').trim() }));
      }
      return [];
    }

    let result = trySelectors(sel => Array.from(document.querySelectorAll(sel)));
    if (result.length > 0) return result;

    console.log('[ChatNav] Gemini: light DOM empty, trying shadow DOM traversal...');
    if (!shadowQueryCache || Date.now() - shadowQueryCacheTime >= 10000) {
      shadowQueryCache = deepQueryAll('*');
      shadowQueryCacheTime = Date.now();
    }
    result = trySelectors(sel => shadowQueryCache.filter(el => {
      try { return el.matches && el.matches(sel); } catch(e) { return false; }
    }));
    if (result.length > 0) return result;

    console.log('[ChatNav] Gemini: selectors all failed, trying generic scan...');
    const messages = [];
    const candidates = [];
    function scanShadow(root) {
      let containers;
      try { containers = root.querySelectorAll('div, section, main'); } catch(e) { containers = []; }
      for (const c of containers) {
        if (c.matches && c.matches('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="complementary"]')) continue;
        const kids = Array.from(c.children).filter(ch => {
          const t = (ch.innerText || ch.textContent || '').trim();
          return t.length >= 20 && t.length < 50000;
        });
        if (kids.length >= 6) {
          candidates.push({ container: c, kids });
        }
      }
      let els;
      try { els = root.querySelectorAll('*'); } catch(e) { return; }
      for (const el of els) {
        if (el.shadowRoot) scanShadow(el.shadowRoot);
      }
    }
    scanShadow(document);
    const best = candidates.sort((a, b) => b.kids.length - a.kids.length)[0];
    if (best) {
      console.log('[ChatNav] Gemini generic: found container with', best.kids.length, 'text children, tag:', best.container.tagName, 'class:', (best.container.className || '').slice(0, 60));
      best.kids.forEach((ch, i) => {
        messages.push({ el: ch, role: i % 2 === 0 ? 'user' : 'ai', text: (ch.innerText || ch.textContent || '').trim() });
      });
    }
    if (messages.length > 0) {
      console.log('[ChatNav] Gemini generic scan found', messages.length, 'messages');
      return messages;
    }

    console.log('[ChatNav] Gemini: no messages found. DOM debug info follows:');
    const customTags = new Set();
    document.querySelectorAll('*').forEach(el => {
      if (el.tagName.includes('-')) customTags.add(el.tagName.toLowerCase());
    });
    console.log('[ChatNav] Custom elements in light DOM:', [...customTags].sort().join(', '));
    return [];
  }

  // ── 渲染列表 ──────────────────────────────────────────────────────────────
  function renderList() {
    if (!list) return;
    list.replaceChildren();
    countSpan.textContent = ` (${allMessages.length})`;
    const t = T();
    if (!monitoringEnabled) {
      const paused = document.createElement('div');
      css(paused, { 'text-align': 'center', color: t.textMuted, padding: '20px 12px', 'font-size': '12px' });
      paused.textContent = '监控已暂停，点击启用';
      list.appendChild(paused);
      return;
    }
    const needle = caseSensitive ? filterText : filterText.toLowerCase();
    const shown = filterText
      ? allMessages.filter(m => {
        const haystack = caseSensitive ? m.text : m.text.toLowerCase();
        return haystack.includes(needle);
      })
      : allMessages;

    if (shown.length === 0) {
      const empty = document.createElement('div');
      css(empty, { 'text-align': 'center', color: t.textMuted, padding: '20px 12px', 'font-size': '12px' });
      empty.textContent = allMessages.length === 0 ? '未检测到对话内容，点击 ↻ 刷新' : '无匹配结果';
      list.appendChild(empty);
      return;
    }

    shown.forEach(({ role, text, el, index }) => {
      const preview = text.slice(0, 200).replace(/\s+/g, ' ').trim();
      const item = document.createElement('div');
      css(item, {
        display: 'flex', 'align-items': 'flex-start', gap: '8px',
        padding: '7px 12px', cursor: 'pointer',
        'border-left': index === activeIndex ? '3px solid ' + t.activeBorder : '3px solid transparent',
        'line-height': '1.4',
        background: index === activeIndex ? t.hoverBg : 'transparent',
      });
      item.addEventListener('mouseenter', () => css(item, { background: t.hoverBg }));
      item.addEventListener('mouseleave', () => {
        if (index !== activeIndex) css(item, { background: 'transparent' });
      });

      const idxSpan = document.createElement('span');
      idxSpan.textContent = index + 1;
      css(idxSpan, { color: t.textMuted, 'font-size': '10px', 'flex-shrink': '0', 'margin-top': '2px', 'min-width': '16px', 'text-align': 'right' });

      const roleSpan = document.createElement('span');
      roleSpan.textContent = role === 'user' ? 'You' : 'AI';
      css(roleSpan, {
        'font-size': '10px', 'font-weight': '700', 'text-transform': 'uppercase',
        'letter-spacing': '0.05em', 'flex-shrink': '0', 'margin-top': '1px',
        color: role === 'user' ? t.userRole : t.aiRole,
      });

      const txtSpan = document.createElement('span');
      if (filterText) {
        const displayText = preview || '（无文字内容）';
        const haystack = caseSensitive ? displayText : displayText.toLowerCase();
        let pos = 0, last = 0;
        while ((pos = haystack.indexOf(needle, pos)) !== -1) {
          if (pos > last) txtSpan.appendChild(document.createTextNode(displayText.slice(last, pos)));
          const mark = document.createElement('mark');
          mark.textContent = displayText.slice(pos, pos + filterText.length);
          css(mark, { background: t.activeBorder, color: t.panelBg, 'border-radius': '2px', padding: '0 2px', 'font-style': 'normal' });
          txtSpan.appendChild(mark);
          pos += filterText.length;
          last = pos;
        }
        if (last < displayText.length) txtSpan.appendChild(document.createTextNode(displayText.slice(last)));
      } else {
        txtSpan.textContent = preview || '（无文字内容）';
      }
      css(txtSpan, {
        color: t.textSec, 'font-size': '12px', overflow: 'hidden',
        display: '-webkit-box', '-webkit-line-clamp': '2', '-webkit-box-orient': 'vertical',
        'word-break': 'break-all',
      });

      item.appendChild(idxSpan);
      item.appendChild(roleSpan);
      item.appendChild(txtSpan);

      item.addEventListener('click', () => {
        activeIndex = index;
        if (filterText) {
          if (matchList.length === 0) buildMatchList();
          const firstIdx = matchList.findIndex(m => m.msgIndex === index);
          if (firstIdx !== -1) {
            navigateToMatch(firstIdx);
            return;
          }
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          el.style.outline = '2px solid ' + t.activeBorder;
          setTimeout(() => { el.style.outline = ''; }, 1200);
        } else {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          el.style.outline = '2px solid ' + t.activeBorder;
          setTimeout(() => { el.style.outline = ''; }, 1200);
        }
        renderList();
      });

      list.appendChild(item);
    });
  }

  function buildMatchList() {
    const oldAnchor = document.getElementById('__cnav_anchor__');
    if (oldAnchor) oldAnchor.remove();
    matchList = [];
    currentMatchIdx = -1;
    if (!filterText) return;
    const needle = caseSensitive ? filterText : filterText.toLowerCase();
    allMessages.forEach(({ el, index }) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode())) {
        const haystack = caseSensitive ? node.textContent : node.textContent.toLowerCase();
        let pos = 0;
        while ((pos = haystack.indexOf(needle, pos)) !== -1) {
          matchList.push({ el, textNode: node, start: pos, end: pos + filterText.length, msgIndex: index });
          pos += filterText.length;
        }
      }
    });
  }

  function updateMatchCounter() {
    if (!matchCounter) return;
    matchCounter.textContent = matchList.length === 0 ? '' : (currentMatchIdx + 1) + '/' + matchList.length;
  }

  function navigateToMatch(idx) {
    if (matchList.length === 0) return;
    idx = ((idx % matchList.length) + matchList.length) % matchList.length;
    const match = matchList[idx];
    if (match && !document.contains(match.textNode)) {
      buildMatchList();
      updateMatchCounter();
      if (matchList.length === 0) return;
      idx = ((idx % matchList.length) + matchList.length) % matchList.length;
    }
    const oldAnchor = document.getElementById('__cnav_anchor__');
    if (oldAnchor) oldAnchor.remove();
    currentMatchIdx = idx;
    const { el, textNode, start, end } = matchList[idx];
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    const span = document.createElement('span');
    span.id = '__cnav_anchor__';
    css(span, {
      background: T().activeBorder, color: T().panelBg,
      'border-radius': '2px', padding: '0 2px',
      'font-size': 'inherit', 'line-height': 'inherit',
      transition: 'opacity 0.8s',
    });
    range.insertNode(span);
    const spanParent = span.parentNode;
    span.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => { span.style.opacity = '0'; }, 800);
    setTimeout(() => {
      span.remove();
      if (spanParent && document.contains(spanParent)) {
        spanParent.normalize();
      }
    }, 1600);
    activeIndex = matchList[idx].msgIndex;
    renderList();
    updateMatchCounter();
  }

  function refresh() {
    if (location.href !== lastUrl) {
      shadowQueryCache = null;
      shadowQueryCacheTime = 0;
      lastUrl = location.href;
    }
    if (!monitoringEnabled) {
      allMessages = [];
      lastMessageSignature = null;
      matchList = [];
      currentMatchIdx = -1;
      renderList();
      updateMatchCounter();
      if (usingAbsolute) updateAbsolutePosition();
      return;
    }

    const raw = isChatGPT ? getChatGPTMessages() : getGeminiMessages();
    const signature = raw
      .map(m => {
        const t = m.text;
        return `${m.role}:${t.length}:${t.slice(0, 60)}:${t.slice(Math.floor(t.length / 2) - 30, Math.floor(t.length / 2) + 30)}:${t.slice(-60)}`;
      })
      .join('|');

    if (signature === lastMessageSignature && list && list.childElementCount > 0) {
      if (usingAbsolute) updateAbsolutePosition();
      return;
    }

    lastMessageSignature = signature;
    allMessages = raw.map((m, i) => ({ ...m, index: i }));
    renderList();
    if (filterText) {
      buildMatchList();
      updateMatchCounter();
    }
    if (usingAbsolute) updateAbsolutePosition();
    console.log('[ChatNav] refreshed, found', allMessages.length, 'messages');
  }

  // ── 保活 + 自动刷新 ──────────────────────────────────────────────────────
  let lastAutoRefreshAt = 0;

  function isOwnNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    return node.closest('#__cnav_panel, #__cnav_toggle, #__cnav_style__, #__cnav_anchor__, #__cnav_resize_e__, #__cnav_resize_w__, #__cnav_resize_s__, #__cnav_resize_se__, #__cnav_resize_sw__, #__cnav_secondary__');
  }

  function mutationIsOwnChange(mutation) {
    if (isOwnNode(mutation.target)) return true;
    const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
    return changedNodes.length > 0 && changedNodes.every(isOwnNode);
  }

  function scheduleRefresh(delay = 2000) {
    if (!monitoringEnabled) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (!monitoringEnabled) return;
      const run = () => {
        if (!monitoringEnabled) return;
        lastAutoRefreshAt = Date.now();
        refresh();
      };
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback(run, { timeout: 2500 });
      } else {
        setTimeout(run, 0);
      }
    }, delay);
  }

  function setupObserver() {
    if (observer) return;
    const target = document.body || document.documentElement;
    observer = new MutationObserver(mutations => {
      if (mutations.length > 0 && mutations.every(mutationIsOwnChange)) return;
      const elapsed = Date.now() - lastAutoRefreshAt;
      scheduleRefresh(elapsed < 4000 ? 4000 - elapsed : 2000);
    });
    observer.observe(target, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  function startKeepAlive() {
    if (keepAliveObserver) return;
    keepAliveObserver = new MutationObserver(() => {
      if (!document.getElementById('__cnav_panel') || !document.getElementById('__cnav_toggle')) {
        inject();
      }
      if (usingAbsolute) updateAbsolutePosition();
    });
    keepAliveObserver.observe(document.body, { childList: true, subtree: false });
  }

  function stopKeepAlive() {
    if (!keepAliveObserver) return;
    keepAliveObserver.disconnect();
    keepAliveObserver = null;
  }

  function stopPendingRefreshes() {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    clearTimeout(tryRefreshTimer);
    tryRefreshTimer = null;
  }

  function startTryRefreshLoop() {
    stopPendingRefreshes();
    let tries = 0;
    function tryRefresh() {
      tryRefreshTimer = null;
      if (!monitoringEnabled) return;
      refresh();
      if (allMessages.length === 0 && tries++ < 15) {
        tryRefreshTimer = setTimeout(tryRefresh, 1000);
      }
    }
    tryRefreshTimer = setTimeout(tryRefresh, 500);
  }

  function startMonitoring() {
    setupObserver();
    if (panelOpen) {
      refresh();
      startTryRefreshLoop();
    }
  }

  function stopMonitoring() {
    stopObserver();
    stopPendingRefreshes();
    allMessages = [];
    activeIndex = -1;
    lastMessageSignature = null;
    renderList();
  }

  function setMonitoringEnabled(enabled) {
    monitoringEnabled = enabled;
    localStorage.setItem(MONITOR_KEY, enabled ? 'on' : 'off');
    updateMonitorButton();
    if (enabled) {
      startMonitoring();
    } else {
      stopMonitoring();
    }
  }

  window.addEventListener('scroll', () => {
    if (usingAbsolute) updateAbsolutePosition();
  }, true);

  // ── 启动 ──────────────────────────────────────────────────────────────────
  function start() {
    if (!document.body) {
      setTimeout(start, 200);
      return;
    }
    inject();
    startKeepAlive();
    renderList();
    if (monitoringEnabled) startMonitoring();
  }
  start();

})();
