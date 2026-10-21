/* seq_asset_tool/app.js — 2D 序列帧资产工作台前端（无框架、无外部依赖） */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const els = {
    boot: $('#boot'),
    app: $('#app'),
    pathLibrary: $('#path-library'),
    pathLibraryValue: $('#path-library-value'),
    btnRefresh: $('#btn-refresh'),
    btnTheme: $('#btn-theme'),
    avatarSelect: $('#avatar-select'),
    actionSearch: $('#action-search'),
    actionList: $('#action-list'),
    btnNewAction: $('#btn-new-action'),
    stageActionName: $('#stage-action-name'),
    stageRuntimeBadge: $('#stage-runtime-badge'),
    stageSub: $('#stage-sub'),
    stageBg: $('#stage-bg'),
    stageZoom: $('#stage-zoom'),
    stageGuidesToggle: $('#stage-guides-toggle'),
    stageViewport: $('#stage-viewport'),
    stageCanvas: $('#stage-canvas'),
    stageGuides: $('#stage-guides'),
    stageImg: $('#stage-img'),
    stageEmpty: $('#stage-empty'),
    stageFrameIndex: $('#stage-frame-index'),
    stageFrameSize: $('#stage-frame-size'),
    btnFirst: $('#btn-first'),
    btnPrev: $('#btn-prev'),
    btnPlay: $('#btn-play'),
    btnNext: $('#btn-next'),
    btnLast: $('#btn-last'),
    frameRange: $('#frame-range'),
    frameCounter: $('#frame-counter'),
    playbackFps: $('#playback-fps'),
    playbackLoop: $('#playback-loop'),
    filmstripSummary: $('#filmstrip-summary'),
    fitMode: $('#fit-mode'),
    webpQuality: $('#webp-quality'),
    btnInsert: $('#btn-insert'),
    filmstrip: $('#filmstrip'),
    sumFrames: $('#sum-frames'),
    sumSize: $('#sum-size'),
    sumAvg: $('#sum-avg'),
    sumCanvas: $('#sum-canvas'),
    sumDuration: $('#sum-duration'),
    metaLabel: $('#meta-label'),
    metaFps: $('#meta-fps'),
    metaLoop: $('#meta-loop'),
    metaDescription: $('#meta-description'),
    metaNote: $('#meta-note'),
    metaHint: $('#meta-hint'),
    btnSaveMeta: $('#btn-save-meta'),
    framePreviewImg: $('#frame-preview-img'),
    frameFile: $('#frame-file'),
    frameDim: $('#frame-dim'),
    frameBytes: $('#frame-bytes'),
    frameHash: $('#frame-hash'),
    frameDurationInput: $('#frame-duration-input'),
    frameDurationReadout: $('#frame-duration-readout'),
    btnDurationMinus: $('#btn-duration-minus'),
    btnDurationPlus: $('#btn-duration-plus'),
    btnDurationReset: $('#btn-duration-reset'),
    btnTimingResetAll: $('#btn-timing-reset-all'),
    timingHint: $('#timing-hint'),
    insertIndex: $('#insert-index'),
    btnInsertHere: $('#btn-insert-here'),
    insertHint: $('#insert-hint'),
    btnMoveLeft: $('#btn-move-left'),
    btnMoveRight: $('#btn-move-right'),
    btnDuplicate: $('#btn-duplicate'),
    btnReplace: $('#btn-replace'),
    btnDeleteFrame: $('#btn-delete-frame'),
    btnImportVideo: $('#btn-import-video'),
    btnImportVideoStrip: $('#btn-import-video-strip'),
    pipelineModal: $('#pipeline-modal'),
    pipelineTitle: $('#pipeline-title'),
    pipelineBody: $('#pipeline-body'),
    pipelineCancel: $('#pipeline-cancel'),
    pipelineConfirm: $('#pipeline-confirm'),
    statusMessage: $('#status-message'),
    busy: $('#busy'),
    busyText: $('#busy-text'),
    busySub: $('#busy-sub'),
    modal: $('#modal'),
    modalForm: $('#modal-form'),
    modalTitle: $('#modal-title'),
    modalBody: $('#modal-body'),
    modalCancel: $('#modal-cancel'),
    modalConfirm: $('#modal-confirm'),
    toastRoot: $('#toast-root'),
    fileInput: $('#file-input'),
    tabs: $$('.tab'),
    panels: $$('.tab-panel'),
};

const state = {
    library: null,
    avatarId: null,
    actionId: null,
    frameIndex: 0,
    insertIndex: 1,
    playing: false,
    playTimer: 0,
    dragFrom: null,
    fileTarget: null,
    modalSubmit: null,
    busy: false,
    theme: localStorage.getItem('seq-theme') || 'dark',
    search: '',
    tab: 'action',
    preloadToken: 0,
    preloadedImages: [],
    timingSaveTimer: 0,
    timingSaveToken: 0,
    timingPending: new Map(),
    pipeline: {
        running: false,
        setupRunning: false,
        jobId: null,
        pollTimer: 0,
        xhr: null,
        submit: null,
        cancel: null,
        openToken: 0,
    },
};

// ────────────────────────────── 基础工具 ──────────────────────────────

function h(tag, attrs = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') element.className = value;
        else if (key === 'text') element.textContent = String(value);
        else if (key === 'dataset') Object.assign(element.dataset, value);
        else if (key === 'on') {
            for (const [eventName, handler] of Object.entries(value)) {
                element.addEventListener(eventName, handler);
            }
        } else if (value === true) element.setAttribute(key, '');
        else element.setAttribute(key, String(value));
    }
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue;
        element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return element;
}

function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function setStatus(message) {
    els.statusMessage.textContent = message;
}

function toast(message, tone = 'info', timeout = 4200) {
    const node = h('div', { class: 'toast', dataset: { tone } }, message);
    els.toastRoot.append(node);
    setTimeout(() => {
        node.style.opacity = '0';
        node.style.transform = 'translateY(6px)';
        node.style.transition = 'opacity .18s, transform .18s';
        setTimeout(() => node.remove(), 200);
    }, timeout);
}

function setBusy(active, text = '处理中…', sub = '') {
    state.busy = active;
    els.busy.hidden = !active;
    els.busyText.textContent = text;
    els.busySub.textContent = sub;
}

function setBusySub(sub) {
    els.busySub.textContent = sub;
}

async function api(pathname, options = {}) {
    const response = await fetch(pathname, {
        method: options.method || 'GET',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let payload = null;
    try {
        payload = await response.json();
    } catch (_error) {
        payload = null;
    }
    if (!response.ok || !payload || payload.ok === false) {
        const message = payload && payload.error ? payload.error : `请求失败（HTTP ${response.status}）`;
        throw new Error(message);
    }
    return payload;
}

function currentAvatar() {
    return state.library?.avatars.find((avatar) => avatar.id === state.avatarId) || null;
}

function currentAction() {
    return currentAvatar()?.actions.find((action) => action.id === state.actionId) || null;
}

function currentFrames() {
    return currentAction()?.frames || [];
}

function currentFrame() {
    return currentFrames()[state.frameIndex] || null;
}

function frameUrl(avatarId, actionId, frame) {
    if (!frame) return '';
    return `/files/${encodeURIComponent(avatarId)}/${encodeURIComponent(actionId)}/${encodeURIComponent(frame.name)}?v=${Math.round(frame.mtimeMs || 0)}`;
}

function currentFrameUrl(frame = currentFrame()) {
    return frameUrl(state.avatarId, state.actionId, frame);
}

function isRuntime(action) {
    return action?.runtime === true;
}

/** 当前形象的画布尺寸（缺省回退库级规格） */
function frameCanvas() {
    const canvas = currentAvatar()?.canvas;
    if (Array.isArray(canvas) && canvas.length === 2 && Number(canvas[0]) > 0 && Number(canvas[1]) > 0) {
        return { width: Number(canvas[0]), height: Number(canvas[1]) };
    }
    return state.library?.frame || { width: 768, height: 1024 };
}

// ────────────────────────────── 逐帧时长 ──────────────────────────────

const TIMING_BASE_FPS = 12;
const TIMING_MIN_MULTIPLIER = 0.1;
const TIMING_MAX_MULTIPLIER = 20;

function normalizeMultiplier(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 1;
    return Math.round(clamp(number, TIMING_MIN_MULTIPLIER, TIMING_MAX_MULTIPLIER) * 1000) / 1000;
}

/** 当前动作的逐帧倍数（始终与帧数对齐；缺失项 = 1） */
function actionMultipliers(action = currentAction()) {
    const frames = action?.frames || [];
    const list = action?.timing?.frameMultipliers;
    return frames.map((_frame, index) => normalizeMultiplier(list?.[index]));
}

function frameMultiplierAt(index) {
    return actionMultipliers()[index] ?? 1;
}

function timingBaseMs(action = currentAction()) {
    const baseFps = Number(action?.timing?.baseFps) || TIMING_BASE_FPS;
    return 1000 / baseFps;
}

function actionDurationMs(action = currentAction()) {
    return actionMultipliers(action).reduce((sum, value) => sum + value, 0) * timingBaseMs(action);
}

function formatMultiplier(value) {
    const text = normalizeMultiplier(value).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return text || '1';
}

function formatDurationMs(ms) {
    const value = Number(ms) || 0;
    if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
    return `${value.toFixed(1)} ms`;
}

/** 视频文件名 → 合法动作 id（只保留 a-z0-9_-） */
function slugifyActionName(fileName) {
    const base = String(fileName || '').toLowerCase().replace(/\.[^.]+$/, '');
    return base
        .normalize('NFKD')
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^[_-]+|[_-]+$/g, '')
        .slice(0, 48);
}

/** 为视频生成一个不与现有动作冲突的新动作 id */
function suggestActionId(avatar, fileName) {
    let base = slugifyActionName(fileName);
    if (!base) base = 'action';
    if (!/^[a-z0-9]/.test(base)) base = `a_${base}`;
    base = base.slice(0, 48);
    const used = new Set((avatar?.actions || []).map((action) => action.id));
    if (!used.has(base)) return base;
    for (let index = 2; index <= 99; index += 1) {
        const candidate = `${base}_${index}`;
        if (!used.has(candidate)) return candidate;
    }
    return `${base}_${Date.now().toString(36)}`;
}

function actionStateMeta(action) {
    if (!action || !action.frameCount) return { text: '缺帧', tone: 'danger' };
    return { text: '已入库', tone: 'ok' };
}

function actionTone(action) {
    return actionStateMeta(action).tone;
}

// ────────────────────────────── 主题与路由 ──────────────────────────────

function applyTheme(theme) {
    state.theme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = state.theme;
    els.btnTheme.textContent = state.theme === 'dark' ? '☀' : '☾';
    localStorage.setItem('seq-theme', state.theme);
}

function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [avatarId, actionId, frameText] = raw.split('/');
    return {
        avatarId: avatarId || null,
        actionId: actionId || null,
        frameIndex: Number.isFinite(Number(frameText)) ? Math.max(0, Number(frameText) - 1) : 0,
    };
}

function updateHash() {
    if (!state.avatarId || !state.actionId) return;
    const next = `#${state.avatarId}/${state.actionId}/${state.frameIndex + 1}`;
    if (location.hash !== next) history.replaceState(null, '', next);
}

// ────────────────────────────── 加载与渲染 ──────────────────────────────

async function loadLibrary({ preserve = true, status = '正在扫描资产库…' } = {}) {
    if (state.playing) stopPlayback();
    setStatus(status);
    const data = await api('/api/library');
    state.library = data;

    const hash = parseHash();
    const avatars = data.avatars || [];
    let avatar = preserve ? avatars.find((item) => item.id === state.avatarId) : null;
    if (!avatar) avatar = avatars.find((item) => item.id === hash.avatarId) || avatars[0] || null;
    state.avatarId = avatar ? avatar.id : null;

    let action = null;
    if (avatar) {
        const actions = avatar.actions || [];
        action = preserve ? actions.find((item) => item.id === state.actionId) : null;
        if (!action) action = actions.find((item) => item.id === hash.actionId) || null;
        if (!action) action = actions.find((item) => item.frameCount > 0) || actions[0] || null;
    }
    state.actionId = action ? action.id : null;
    state.frameIndex = clamp(
        preserve ? state.frameIndex : hash.frameIndex,
        0,
        Math.max(0, (action?.frameCount || 1) - 1),
    );
    state.insertIndex = state.frameIndex + 1;

    renderAll();
    updateHash();
    setStatus(`已加载 ${avatars.length} 个形象 · ${avatars.reduce((sum, item) => sum + (item.actions || []).length, 0)} 个动作`);
    if (state.actionId) preloadCurrentAction();
}

function renderAll() {
    renderPaths();
    renderAvatarSelect();
    renderActionList();
    renderStage();
    renderFilmstrip();
    renderPlayback();
    renderInspectorAction();
    renderInspectorFrame();
    renderTabs();
}

function renderPaths() {
    if (!state.library) return;
    els.pathLibraryValue.textContent = state.library.libraryRoot;
    els.pathLibrary.dataset.tip = `打开资产库：${state.library.libraryRoot}`;
}

function renderAvatarSelect() {
    const avatars = state.library?.avatars || [];
    els.avatarSelect.replaceChildren(
        ...avatars.map((avatar) => h('option', { value: avatar.id, text: `${avatar.name} · ${avatar.id}` })),
    );
    if (state.avatarId) els.avatarSelect.value = state.avatarId;
}

function renderActionList() {
    const avatar = currentAvatar();
    const actions = avatar?.actions || [];
    const keyword = state.search.trim().toLowerCase();
    const filtered = actions.filter((action) => {
        if (!keyword) return true;
        const status = actionStateMeta(action).text;
        return `${action.id} ${action.label} ${status}`.toLowerCase().includes(keyword);
    });

    els.actionList.replaceChildren();
    if (!filtered.length) {
        els.actionList.append(h('div', { class: 'action-empty', text: keyword ? '没有匹配的动作' : '该形象还没有动作' }));
        return;
    }

    for (const action of filtered) {
        const status = actionStateMeta(action);
        const item = h(
            'button',
            {
                class: 'action-item',
                type: 'button',
                dataset: { active: String(action.id === state.actionId) },
                on: {
                    click: () => selectAction(action.id),
                },
            },
            h('span', { class: `action-dot tone-${actionTone(action)}` }),
            h(
                'span',
                { class: 'action-main' },
                h('span', { class: 'action-label', text: action.label || action.id }),
                h('span', { class: 'action-id', text: `${action.id} · ${status.text}` }),
            ),
            h(
                'span',
                { class: 'action-meta' },
                h('span', { text: `${action.frameCount} f · ${action.fps} fps` }),
                action.runtime ? h('span', { class: 'runtime-tag', text: '运行时' }) : null,
            ),
        );
        els.actionList.append(item);
    }
}

function selectAction(actionId, { frameIndex = 0 } = {}) {
    if (!actionId) return;
    stopPlayback();
    state.actionId = actionId;
    const action = currentAction();
    state.frameIndex = clamp(frameIndex, 0, Math.max(0, (action?.frameCount || 1) - 1));
    state.insertIndex = state.frameIndex + 1;
    preloadCurrentAction();
    renderAll();
    updateHash();
    setStatus(`已选择 ${action?.label || actionId} · ${action?.frameCount || 0} 帧`);
}

function preloadCurrentAction() {
    const action = currentAction();
    state.preloadToken += 1;
    const token = state.preloadToken;
    state.preloadedImages = [];
    if (!action || !action.frames?.length) return;
    for (const frame of action.frames) {
        const image = new Image();
        image.decoding = 'async';
        image.src = currentFrameUrl(frame);
        state.preloadedImages.push(image);
    }
    // 只保留当前动作的预加载引用；切动作后旧引用由 GC 回收。
    if (token !== state.preloadToken) state.preloadedImages = [];
}

// ────────────────────────────── 舞台与播放 ──────────────────────────────

function renderStage() {
    const avatar = currentAvatar();
    const action = currentAction();
    const frame = currentFrame();
    const frames = currentFrames();

    els.stageActionName.textContent = action ? `${action.label || action.id}` : '—';
    els.stageRuntimeBadge.textContent = action ? (isRuntime(action) ? '运行时已接入' : '储备动作') : '—';
    els.stageRuntimeBadge.className = `badge ${action ? (isRuntime(action) ? 'badge-runtime' : 'badge-stock') : ''}`;
    els.stageSub.textContent = action
        ? `${avatar?.name || ''} / ${action.id} / ${frames.length} 帧`
        : '—';

    els.stageCanvas.dataset.bg = els.stageBg.value;
    els.stageCanvas.dataset.zoom = els.stageZoom.value;
    els.stageViewport.dataset.zoom = els.stageZoom.value;
    els.stageGuides.hidden = !els.stageGuidesToggle.checked;

    if (frame) {
        const url = currentFrameUrl(frame);
        if (els.stageImg.getAttribute('src') !== url) els.stageImg.src = url;
        els.stageImg.alt = `${action.label || action.id} 第 ${state.frameIndex + 1} 帧`;
        els.stageImg.hidden = false;
        els.stageEmpty.hidden = true;
    } else {
        els.stageImg.hidden = true;
        els.stageImg.removeAttribute('src');
        els.stageEmpty.hidden = false;
    }

    const canvas = frameCanvas();
    els.stageFrameIndex.textContent = frames.length
        ? `#${String(state.frameIndex + 1).padStart(3, '0')} / ${frames.length}`
        : '暂无帧';
    els.stageFrameSize.textContent = frame
        ? `${frame.name} · ${canvas.width}×${canvas.height} · ${formatBytes(frame.size)}`
        : '—';
}

function renderPlayback() {
    const action = currentAction();
    const frames = currentFrames();
    const count = frames.length;
    els.frameRange.max = String(Math.max(0, count - 1));
    els.frameRange.value = String(count ? state.frameIndex : 0);
    els.frameRange.disabled = count <= 1;
    els.frameCounter.textContent = `${count ? state.frameIndex + 1 : 0} / ${count}`;
    els.playbackFps.textContent = `${action?.fps || 12} fps`;
    els.playbackLoop.textContent = action?.loop ? '循环' : '单次';
    els.btnPlay.textContent = state.playing ? '❚❚' : '▶';
    els.btnPlay.setAttribute('aria-label', state.playing ? '暂停' : '播放');
    // 上一帧/下一帧支持首尾循环：只要多于 1 帧就始终可用。
    els.btnPrev.disabled = count <= 1;
    els.btnNext.disabled = count <= 1;
    els.btnFirst.disabled = !count || state.frameIndex <= 0;
    els.btnLast.disabled = !count || state.frameIndex >= count - 1;
}

/** 逐帧步进（首尾循环）：末帧继续到首帧，首帧继续到末帧 */
function stepFrame(delta) {
    const frames = currentFrames();
    if (!frames.length) return;
    if (frames.length === 1) {
        goToFrame(0);
        return;
    }
    const next = (state.frameIndex + delta + frames.length) % frames.length;
    goToFrame(next);
}

function togglePlayback() {
    if (state.playing) stopPlayback();
    else startPlayback();
}

function startPlayback() {
    const action = currentAction();
    const frames = currentFrames();
    if (!action || !frames.length) return;
    if (!action.loop && state.frameIndex >= frames.length - 1) {
        state.frameIndex = 0;
        renderStage();
        renderFilmstripSelection();
        renderInspectorFrame();
    }
    state.playing = true;
    renderPlayback();
    scheduleNextFrame();
}

function scheduleNextFrame() {
    clearTimeout(state.playTimer);
    if (!state.playing) return;
    const action = currentAction();
    const delay = timingBaseMs(action) * frameMultiplierAt(state.frameIndex);
    state.playTimer = setTimeout(() => {
        if (!state.playing) return;
        const current = currentAction();
        const frames = currentFrames();
        if (!current || !frames.length) {
            stopPlayback();
            return;
        }
        let next = state.frameIndex + 1;
        if (next >= frames.length) {
            if (current.loop) next = 0;
            else {
                stopPlayback();
                return;
            }
        }
        state.frameIndex = next;
        renderStage();
        renderFilmstripSelection();
        renderPlayback();
        updateHash();
        scheduleNextFrame();
    }, delay);
}

function stopPlayback() {
    state.playing = false;
    clearTimeout(state.playTimer);
    state.playTimer = 0;
    renderPlayback();
}

function goToFrame(index, { pause = true } = {}) {
    const frames = currentFrames();
    if (!frames.length) return;
    if (pause) stopPlayback();
    state.frameIndex = clamp(index, 0, frames.length - 1);
    state.insertIndex = state.frameIndex + 1;
    renderStage();
    renderFilmstripSelection();
    renderInspectorFrame();
    renderPlayback();
    updateHash();
}

// ────────────────────────────── 帧条 ──────────────────────────────

function renderFilmstrip() {
    const action = currentAction();
    const frames = currentFrames();
    const totalBytes = frames.reduce((sum, frame) => sum + (frame.size || 0), 0);
    els.filmstripSummary.textContent = action
        ? `${frames.length} 帧 · ${formatBytes(totalBytes)} · ${action.fps} fps · ${formatDurationMs(actionDurationMs(action))} · ${action.loop ? '循环' : '单次'}`
        : '—';

    els.filmstrip.replaceChildren();
    if (!action) {
        renderTimingUI();
        return;
    }
    if (!frames.length) {
        els.filmstrip.append(
            h(
                'div',
                { class: 'filmstrip-empty' },
                h('span', { text: '这个动作还没有帧。' }),
                h('button', {
                    class: 'btn btn-primary btn-sm',
                    type: 'button',
                    text: '插入第一批帧…',
                    on: { click: () => openFilePicker({ type: 'insert', index: 0 }) },
                }),
            ),
        );
        renderTimingUI();
        return;
    }

    for (let index = 0; index <= frames.length; index += 1) {
        els.filmstrip.append(buildInsertSlot(index));
        if (index === frames.length) break;
        els.filmstrip.append(buildFrameItem(frames[index], index));
    }
    renderTimingUI();
    scrollFilmstripToSelected();
}

function buildInsertSlot(index) {
    const slot = h('button', {
        class: 'insert-slot',
        type: 'button',
        text: '+',
        'aria-label': `在第 ${index + 1} 帧前插入`,
        dataset: { insertIndex: String(index) },
        on: {
            click: () => openFilePicker({ type: 'insert', index }),
        },
    });
    slot.addEventListener('dragover', (event) => {
        if (event.dataTransfer?.types?.includes('Files') || state.dragFrom !== null) {
            event.preventDefault();
            slot.dataset.dragOver = 'true';
        }
    });
    slot.addEventListener('dragleave', () => {
        delete slot.dataset.dragOver;
    });
    slot.addEventListener('drop', (event) => {
        event.preventDefault();
        delete slot.dataset.dragOver;
        if (state.dragFrom !== null) {
            const from = state.dragFrom;
            state.dragFrom = null;
            reorderFrames(from, index > from ? index - 1 : index);
        } else if (event.dataTransfer?.files?.length) {
            insertFilesAt(index, event.dataTransfer.files);
        }
    });
    return slot;
}

function buildFrameItem(frame, index) {
    const item = h(
        'button',
        {
            class: 'frame-item',
            type: 'button',
            draggable: 'true',
            dataset: { index: String(index), selected: String(index === state.frameIndex) },
            on: {
                click: () => goToFrame(index),
                dblclick: () => openFilePicker({ type: 'replace', index }),
                dragstart: (event) => {
                    state.dragFrom = index;
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', String(index));
                    item.dataset.dragging = 'true';
                },
                dragend: () => {
                    state.dragFrom = null;
                    delete item.dataset.dragging;
                },
                dragover: (event) => {
                    if (state.dragFrom !== null) {
                        event.preventDefault();
                        item.dataset.dragOver = 'true';
                    }
                },
                dragleave: () => {
                    delete item.dataset.dragOver;
                },
                drop: (event) => {
                    event.preventDefault();
                    delete item.dataset.dragOver;
                    if (state.dragFrom !== null) {
                        const from = state.dragFrom;
                        state.dragFrom = null;
                        reorderFrames(from, index);
                    } else if (event.dataTransfer?.files?.length) {
                        insertFilesAt(index, event.dataTransfer.files);
                    }
                },
            },
        },
        h(
            'span',
            { class: 'frame-thumb-wrap' },
            h('img', {
                class: 'frame-thumb',
                src: currentFrameUrl(frame),
                alt: `第 ${index + 1} 帧`,
                loading: 'lazy',
                decoding: 'async',
                draggable: 'false',
            }),
        ),
        h('span', { class: 'frame-index', text: String(index + 1).padStart(2, '0') }),
        h('span', { class: 'frame-duration-badge', hidden: true, text: '×1' }),
    );
    return item;
}

function renderFilmstripSelection() {
    $$('.frame-item', els.filmstrip).forEach((item) => {
        item.dataset.selected = String(Number(item.dataset.index) === state.frameIndex);
    });
    scrollFilmstripToSelected();
}

/** 只滚动帧条自身，避免 scrollIntoView 连带滚动整页（舞台/顶栏被顶出视口） */
function scrollFilmstripToSelected() {
    const selected = $('.frame-item[data-selected="true"]', els.filmstrip);
    if (!selected) return;
    const strip = els.filmstrip;
    const stripRect = strip.getBoundingClientRect();
    const selectedRect = selected.getBoundingClientRect();
    if (!stripRect.width || !selectedRect.width) return;
    const maxScroll = Math.max(0, strip.scrollWidth - strip.clientWidth);
    const currentLeft = strip.scrollLeft + (selectedRect.left - stripRect.left);
    const target = currentLeft - (strip.clientWidth - selectedRect.width) / 2;
    strip.scrollLeft = clamp(target, 0, maxScroll);
}

/** 同步帧条徽标、总时长与当前帧读数（不重建帧条） */
function renderTimingUI() {
    const action = currentAction();
    const frames = currentFrames();
    const multipliers = actionMultipliers(action);
    const baseMs = timingBaseMs(action);
    const totalMs = actionDurationMs(action);

    if (els.filmstripSummary && action) {
        const totalBytes = frames.reduce((sum, frame) => sum + (frame.size || 0), 0);
        els.filmstripSummary.textContent = `${frames.length} 帧 · ${formatBytes(totalBytes)} · ${action.fps} fps · ${formatDurationMs(totalMs)} · ${action.loop ? '循环' : '单次'}`;
    } else if (els.filmstripSummary) {
        els.filmstripSummary.textContent = '—';
    }
    els.sumDuration.textContent = action && frames.length ? formatDurationMs(totalMs) : '—';

    $$('.frame-item', els.filmstrip).forEach((item) => {
        const index = Number(item.dataset.index);
        if (!Number.isInteger(index)) return;
        const value = multipliers[index] ?? 1;
        const badge = $('.frame-duration-badge', item);
        if (badge) {
            badge.textContent = `×${formatMultiplier(value)}`;
            badge.hidden = Math.abs(value - 1) < 1e-9;
        }
        item.dataset.multiplier = String(value);
        item.setAttribute(
            'aria-label',
            `第 ${index + 1} 帧，时长 ×${formatMultiplier(value)}（${formatDurationMs(value * baseMs)}）`,
        );
    });

    const hasFrame = Boolean(currentFrame());
    const currentValue = hasFrame ? multipliers[state.frameIndex] ?? 1 : 1;
    if (document.activeElement !== els.frameDurationInput) {
        els.frameDurationInput.value = formatMultiplier(currentValue);
    }
    els.frameDurationInput.disabled = !hasFrame;
    els.btnDurationMinus.disabled = !hasFrame;
    els.btnDurationPlus.disabled = !hasFrame;
    els.btnDurationReset.disabled = !hasFrame;
    els.btnTimingResetAll.disabled = !action || !frames.length;
    els.frameDurationReadout.textContent = hasFrame
        ? `×${formatMultiplier(currentValue)} · ${formatDurationMs(currentValue * baseMs)}`
        : '—';
    els.timingHint.textContent = action && frames.length
        ? `基准 ${TIMING_BASE_FPS} fps（${formatDurationMs(baseMs)}/帧）；当前 ${frames.length} 帧，总时长 ${formatDurationMs(totalMs)}。修改后自动保存到动作目录的 config.json。`
        : '基准 12 fps（83.3 ms/帧）；倍数为 1 表示基准时长。修改后自动保存到动作目录的 config.json。';
}

/** 延迟保存当前动作的帧时长；按动作排队，切换动作不会丢掉未落盘的修改 */
function queueTimingSave() {
    const avatarId = state.avatarId;
    const action = currentAction();
    if (!action || !action.frames?.length) return;
    const key = `${avatarId}/${action.id}`;
    state.timingPending.set(key, {
        avatarId,
        actionId: action.id,
        multipliers: actionMultipliers(action),
    });
    clearTimeout(state.timingSaveTimer);
    state.timingSaveTimer = setTimeout(flushTimingSaves, 350);
}

function flushTimingSaves() {
    state.timingSaveTimer = 0;
    const entries = Array.from(state.timingPending.values());
    state.timingPending.clear();
    if (!entries.length) return;
    state.timingSaveToken += 1;
    const token = state.timingSaveToken;
    for (const entry of entries) {
        persistTiming(token, entry.avatarId, entry.actionId, entry.multipliers);
    }
}

async function persistTiming(token, avatarId, actionId, multipliers) {
    try {
        const result = await api('/api/action/timing', {
            method: 'POST',
            body: { avatar: avatarId, action: actionId, frameMultipliers: multipliers },
        });
        if (token !== state.timingSaveToken) return;
        const action = state.library?.avatars
            ?.find((avatar) => avatar.id === avatarId)
            ?.actions.find((item) => item.id === actionId);
        if (action) {
            action.timing = { ...(action.timing || {}), ...result.timing };
            action.durationMs = Math.round(actionDurationMs(action));
        }
        if (state.actionId === actionId && state.avatarId === avatarId) renderTimingUI();
        setStatus(`帧时长已保存 · ${actionId}`);
    } catch (error) {
        if (token !== state.timingSaveToken) return;
        toast(`帧时长保存失败：${error.message}`, 'danger', 7000);
        console.error(error);
    }
}

function setFrameMultiplier(index, value) {
    const action = currentAction();
    const frames = currentFrames();
    if (!action || !frames.length) return;
    const target = clamp(Math.round(Number(index)), 0, frames.length - 1);
    const multipliers = actionMultipliers(action);
    multipliers[target] = normalizeMultiplier(value);
    action.timing = {
        ...(action.timing || {}),
        schemaVersion: 1,
        baseFps: TIMING_BASE_FPS,
        frameMultipliers: multipliers,
    };
    action.durationMs = Math.round(actionDurationMs(action));
    renderTimingUI();
    // 正在预览时，让新的时长立即作用于当前帧的剩余停留（从头计时）。
    if (state.playing) scheduleNextFrame();
    queueTimingSave();
}

async function resetAllFrameTiming() {
    const action = currentAction();
    const frames = currentFrames();
    if (!action || !frames.length) return;
    const custom = actionMultipliers(action).filter((value) => Math.abs(value - 1) > 1e-9).length;
    if (!custom) {
        toast('当前动作全部帧都是基准时长', 'info');
        return;
    }
    const confirmed = await showConfirm({
        title: '把全部帧重置为 1 倍？',
        body: h(
            'div',
            null,
            h('p', { text: `动作「${action.label || action.id}」中有 ${custom} 帧使用了非 1 倍数。` }),
            h('p', { class: 'muted', text: '重置后每帧都恢复为 12fps 基准时长，并立即写入动作目录的 config.json。' }),
        ),
        confirmText: '全部重置',
        danger: true,
    });
    if (!confirmed) return;
    const multipliers = actionMultipliers(action).map(() => 1);
    action.timing.frameMultipliers = multipliers;
    action.durationMs = Math.round(actionDurationMs(action));
    renderTimingUI();
    queueTimingSave();
    toast('全部帧已重置为基准时长', 'ok');
}

// ────────────────────────────── 检查器：动作 ──────────────────────────────

function renderInspectorAction() {
    const action = currentAction();
    const frames = currentFrames();
    const canvas = frameCanvas();
    const totalBytes = frames.reduce((sum, frame) => sum + (frame.size || 0), 0);

    els.sumFrames.textContent = action ? String(action.frameCount) : '—';
    els.sumSize.textContent = formatBytes(totalBytes);
    els.sumAvg.textContent = frames.length ? formatBytes(Math.round(totalBytes / frames.length)) : '—';
    els.sumCanvas.textContent = `${canvas.width}×${canvas.height}`;
    els.sumDuration.textContent = action && frames.length ? formatDurationMs(actionDurationMs(action)) : '—';

    if (!action) {
        els.metaLabel.value = '';
        els.metaFps.value = '12';
        els.metaLoop.checked = false;
        els.metaDescription.value = '';
        els.metaNote.value = '';
        els.metaHint.textContent = '';
        return;
    }

    els.metaLabel.value = action.label || action.id;
    els.metaFps.value = String(action.fps || 12);
    els.metaLoop.checked = action.loop === true;
    els.metaDescription.value = action.description || '';
    els.metaNote.value = action.note || '';

    const runtime = isRuntime(action);
    els.metaFps.disabled = runtime;
    els.metaLoop.disabled = runtime;
    els.metaHint.textContent = runtime
        ? '运行时动作固定 12 fps：idle 循环、wave 单次。'
        : '储备动作可以自由设置帧率与循环；当前播放器未接入该动作。';
}

function renderTabs() {
    for (const tab of els.tabs) {
        const active = tab.dataset.tab === state.tab;
        tab.setAttribute('aria-selected', String(active));
    }
    for (const panel of els.panels) {
        panel.hidden = panel.dataset.panel !== state.tab;
    }
}

// ────────────────────────────── 检查器：帧 ──────────────────────────────

function renderInspectorFrame() {
    const frame = currentFrame();
    const frames = currentFrames();
    const action = currentAction();
    const canvas = frameCanvas();

    if (!frame) {
        els.framePreviewImg.removeAttribute('src');
        els.frameFile.textContent = '—';
        els.frameDim.textContent = '—';
        els.frameBytes.textContent = '—';
        els.frameHash.textContent = '—';
    } else {
        els.framePreviewImg.src = currentFrameUrl(frame);
        els.framePreviewImg.alt = `第 ${state.frameIndex + 1} 帧预览`;
        els.frameFile.textContent = frame.name;
        els.frameDim.textContent = `${canvas.width} × ${canvas.height}`;
        els.frameBytes.textContent = formatBytes(frame.size);
        els.frameHash.textContent = `sha256:${String(frame.hash || '').slice(0, 12)}…`;
    }

    els.insertIndex.max = String(Math.max(1, frames.length + 1));
    els.insertIndex.value = String(clamp(state.insertIndex, 1, Math.max(1, frames.length + 1)));
    els.insertHint.textContent = `1 = 最前面；${frames.length + 1} = 末尾；当前共 ${frames.length} 帧。插入位置：第 ${els.insertIndex.value} 帧前。`;

    const disabled = !frame || !action;
    els.btnMoveLeft.disabled = disabled || state.frameIndex <= 0;
    els.btnMoveRight.disabled = disabled || state.frameIndex >= frames.length - 1;
    els.btnDuplicate.disabled = disabled;
    els.btnReplace.disabled = disabled;
    els.btnDeleteFrame.disabled = disabled;
    els.btnInsertHere.disabled = !action;
    els.btnInsert.disabled = !action;
    renderTimingUI();
}

// ────────────────────────────── 图片处理 ──────────────────────────────

async function loadImageSource(file) {
    if (typeof createImageBitmap === 'function') {
        try {
            return await createImageBitmap(file, { imageOrientation: 'from-image' });
        } catch (_error) {
            /* 回退到 <img> */
        }
    }
    return await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error(`图片解码失败：${file.name}`));
        };
        image.src = url;
    });
}

function drawToCanvas(source, width, height, fitMode) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';

    const sourceWidth = source.width || source.naturalWidth || width;
    const sourceHeight = source.height || source.naturalHeight || height;
    let drawWidth = width;
    let drawHeight = height;
    let dx = 0;
    let dy = 0;

    if (fitMode === 'contain') {
        const scale = Math.min(width / sourceWidth, height / sourceHeight);
        drawWidth = sourceWidth * scale;
        drawHeight = sourceHeight * scale;
        dx = (width - drawWidth) / 2;
        dy = (height - drawHeight) / 2;
    } else if (fitMode === 'cover') {
        const scale = Math.max(width / sourceWidth, height / sourceHeight);
        drawWidth = sourceWidth * scale;
        drawHeight = sourceHeight * scale;
        dx = (width - drawWidth) / 2;
        dy = (height - drawHeight) / 2;
    } else if (fitMode === 'original') {
        drawWidth = sourceWidth;
        drawHeight = sourceHeight;
        dx = (width - drawWidth) / 2;
        dy = (height - drawHeight) / 2;
    }

    context.drawImage(source, dx, dy, drawWidth, drawHeight);
    return canvas;
}

function canvasToWebpBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => {
                if (!blob) {
                    reject(new Error('WebP 编码失败'));
                    return;
                }
                resolve(blob);
            },
            'image/webp',
            clamp(quality, 0.6, 1),
        );
    });
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('读取编码结果失败'));
        reader.readAsDataURL(blob);
    });
}

async function fileToWebpDataUrl(file) {
    const frame = frameCanvas();
    const quality = Number(els.webpQuality.value) || 0.92;
    const fitMode = els.fitMode.value;
    const source = await loadImageSource(file);
    const canvas = drawToCanvas(source, frame.width, frame.height, fitMode);
    const blob = await canvasToWebpBlob(canvas, quality);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const isWebp = bytes.length > 12
        && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    if (!isWebp) throw new Error('当前浏览器不支持 WebP 编码，请使用 Chrome / Edge 打开');
    if (blob.size > 4 * 1024 * 1024) throw new Error(`单帧编码后超过 4MB：${formatBytes(blob.size)}`);
    return await blobToDataUrl(blob);
}

// ────────────────────────────── 帧编辑 ──────────────────────────────

function openFilePicker(target) {
    state.fileTarget = target;
    els.fileInput.value = '';
    els.fileInput.click();
}

async function insertFilesAt(index, fileList) {
    const action = currentAction();
    if (!action) return;
    const files = Array.from(fileList || []).filter((file) => file.type.startsWith('image/'));
    if (!files.length) {
        toast('没有可用的图片文件', 'warn');
        return;
    }
    if (state.busy) return;

    const insertAt = clamp(Number(index) || 0, 0, action.frameCount);
    setBusy(true, `正在转换 ${files.length} 张图片`, `目标：第 ${insertAt + 1} 帧前`);
    try {
        const payload = [];
        for (let position = 0; position < files.length; position += 1) {
            const file = files[position];
            setBusySub(`${position + 1}/${files.length} · ${file.name}`);
            const dataUrl = await fileToWebpDataUrl(file);
            payload.push({ name: file.name, dataUrl });
        }
        setBusySub('写入资产库…');
        const result = await api('/api/frames/insert', {
            method: 'POST',
            body: { avatar: state.avatarId, action: state.actionId, index: insertAt, frames: payload },
        });
        await loadLibrary({ preserve: true, status: '已插入帧，正在刷新…' });
        selectAction(state.actionId, { frameIndex: insertAt });
        toast(`已插入 ${result.inserted} 帧到第 ${insertAt + 1} 帧前；旧帧已备份到 ${result.backup}`, 'ok', 6000);
    } catch (error) {
        toast(error.message, 'danger', 7000);
        console.error(error);
    } finally {
        setBusy(false);
    }
}

async function replaceFrame(index, file) {
    if (!file) return;
    if (state.busy) return;
    setBusy(true, '正在替换帧', file.name);
    try {
        setBusySub('编码为 WebP…');
        const dataUrl = await fileToWebpDataUrl(file);
        const result = await api('/api/frames/replace', {
            method: 'POST',
            body: { avatar: state.avatarId, action: state.actionId, index, dataUrl },
        });
        await loadLibrary({ preserve: true, status: '已替换帧，正在刷新…' });
        selectAction(state.actionId, { frameIndex: index });
        toast(`第 ${index + 1} 帧已替换；旧帧已备份到 ${result.backup}`, 'ok', 6000);
    } catch (error) {
        toast(error.message, 'danger', 7000);
        console.error(error);
    } finally {
        setBusy(false);
    }
}

async function deleteCurrentFrame() {
    const action = currentAction();
    const frames = currentFrames();
    if (!action || !frames.length) return;
    const index = state.frameIndex;
    const confirmed = await showConfirm({
        title: '删除当前帧？',
        body: h(
            'div',
            null,
            h('p', { text: `将从资产库的动作「${action.label || action.id}」中移除第 ${index + 1} 帧（${frames[index].name}）。` }),
            h('p', { class: 'muted', text: '删除不会物理销毁资产：整组旧帧会移入 assets/pet_seq/.trash。' }),
        ),
        confirmText: '删除',
        danger: true,
    });
    if (!confirmed) return;
    if (state.busy) return;
    setBusy(true, '正在删除帧', `第 ${index + 1} 帧`);
    try {
        const result = await api('/api/frames/delete', {
            method: 'POST',
            body: { avatar: state.avatarId, action: state.actionId, indices: [index] },
        });
        await loadLibrary({ preserve: true, status: '已删除帧，正在刷新…' });
        selectAction(state.actionId, { frameIndex: Math.min(index, Math.max(0, result.frameCount - 1)) });
        toast(`已删除 1 帧；旧帧已移入 ${result.backup}`, 'ok', 6000);
    } catch (error) {
        toast(error.message, 'danger', 7000);
        console.error(error);
    } finally {
        setBusy(false);
    }
}

async function reorderFrames(from, to) {
    const frames = currentFrames();
    if (!frames.length) return;
    const fromIndex = clamp(Number(from), 0, frames.length - 1);
    const toIndex = clamp(Number(to), 0, frames.length - 1);
    if (fromIndex === toIndex) return;
    const order = frames.map((_frame, index) => index);
    const [moved] = order.splice(fromIndex, 1);
    order.splice(toIndex, 0, moved);
    if (state.busy) return;
    setBusy(true, '正在重排帧', `${fromIndex + 1} → ${toIndex + 1}`);
    try {
        await api('/api/frames/reorder', {
            method: 'POST',
            body: { avatar: state.avatarId, action: state.actionId, order },
        });
        await loadLibrary({ preserve: true, status: '已重排帧，正在刷新…' });
        selectAction(state.actionId, { frameIndex: toIndex });
        toast(`已把第 ${fromIndex + 1} 帧移动到第 ${toIndex + 1} 帧`, 'ok');
    } catch (error) {
        toast(error.message, 'danger', 7000);
        console.error(error);
    } finally {
        setBusy(false);
    }
}

async function duplicateCurrentFrame() {
    const frame = currentFrame();
    if (!frame) return;
    if (state.busy) return;
    setBusy(true, '正在复制当前帧', frame.name);
    try {
        const response = await fetch(currentFrameUrl(frame));
        if (!response.ok) throw new Error(`读取帧失败：HTTP ${response.status}`);
        const blob = await response.blob();
        const dataUrl = await blobToDataUrl(blob);
        const index = state.frameIndex + 1;
        const multiplier = frameMultiplierAt(state.frameIndex);
        const result = await api('/api/frames/insert', {
            method: 'POST',
            body: {
                avatar: state.avatarId,
                action: state.actionId,
                index,
                frames: [{ name: frame.name, dataUrl }],
                multipliers: [multiplier],
            },
        });
        await loadLibrary({ preserve: true, status: '已复制帧，正在刷新…' });
        selectAction(state.actionId, { frameIndex: index });
        toast(`已复制第 ${index} 帧到第 ${index + 1} 帧；备份：${result.backup}`, 'ok', 6000);
    } catch (error) {
        toast(error.message, 'danger', 7000);
        console.error(error);
    } finally {
        setBusy(false);
    }
}

// ────────────────────────────── 动作元数据 ──────────────────────────────

async function saveActionMeta() {
    const action = currentAction();
    if (!action) return;
    if (state.busy) return;
    setBusy(true, '正在保存动作设置', action.id);
    try {
        const result = await api('/api/action/meta', {
            method: 'POST',
            body: {
                avatar: state.avatarId,
                action: state.actionId,
                label: els.metaLabel.value,
                fps: Number(els.metaFps.value),
                loop: els.metaLoop.checked,
                description: els.metaDescription.value,
                note: els.metaNote.value,
            },
        });
        await loadLibrary({ preserve: true, status: '动作设置已保存' });
        const forced = isRuntime(action) && (result.action.fps !== Number(els.metaFps.value) || result.action.loop !== els.metaLoop.checked);
        toast(forced ? '已保存；运行时动作会强制 12fps / 固定循环口径' : '动作设置已保存', 'ok');
    } catch (error) {
        toast(error.message, 'danger', 7000);
        console.error(error);
    } finally {
        setBusy(false);
    }
}

// ────────────────────────────── 新建动作 ──────────────────────────────

async function showNewActionDialog() {
    const avatar = currentAvatar();
    if (!avatar) return;
    const idInput = h('input', {
        class: 'input',
        type: 'text',
        placeholder: '例如 happy',
        maxlength: '64',
        autocomplete: 'off',
    });
    const labelInput = h('input', {
        class: 'input',
        type: 'text',
        placeholder: '例如 开心',
        maxlength: '40',
        autocomplete: 'off',
    });
    const fpsInput = h('input', { class: 'input', type: 'number', min: '1', max: '60', step: '1', value: '12' });
    const loopInput = h('input', { type: 'checkbox' });
    const descriptionInput = h('textarea', {
        class: 'input textarea',
        rows: '3',
        maxlength: '200',
        placeholder: '一句话说明动作整体内容、幅度/节奏与首尾姿态（供大模型调用）',
    });
    const body = h(
        'div',
        { class: 'modal-form-grid' },
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: '动作 ID（小写字母/数字/_/-）' }), idInput),
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: '显示名' }), labelInput),
        h(
            'div',
            { class: 'field-row' },
            h('label', { class: 'field' }, h('span', { class: 'field-label', text: '帧率' }), fpsInput),
            h('label', { class: 'switch-field switch-field-box' }, loopInput, h('span', { text: '循环播放' })),
        ),
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: '动作描述（可选，供大模型调用）' }), descriptionInput),
        h('p', { class: 'hint', text: '新动作会创建空目录。创建后用「插入帧…」或把图片拖到帧条上添加帧。' }),
    );

    state.modalSubmit = async () => {
        const actionId = idInput.value.trim();
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(actionId)) {
            toast('动作 ID 非法：只能使用字母、数字、下划线、连字符', 'danger');
            return;
        }
        const fps = clamp(Number(fpsInput.value) || 12, 1, 60);
        const runtimeAction = (state.library.runtimeActions || []).includes(actionId);
        setBusy(true, '正在创建动作', actionId);
        try {
            await api('/api/action/create', {
                method: 'POST',
                body: {
                    avatar: state.avatarId,
                    action: actionId,
                    label: labelInput.value.trim() || actionId,
                    fps,
                    loop: runtimeAction ? actionId === 'idle' : loopInput.checked,
                    description: descriptionInput.value,
                    note: '',
                },
            });
            els.modal.close('confirm');
            await loadLibrary({ preserve: true, status: '动作已创建' });
            selectAction(actionId);
            toast(`已创建动作 ${actionId}`, 'ok');
        } catch (error) {
            toast(error.message, 'danger', 7000);
            console.error(error);
        } finally {
            setBusy(false);
        }
    };

    els.modalTitle.textContent = '新建动作';
    els.modalBody.replaceChildren(body);
    els.modalConfirm.textContent = '创建';
    els.modalConfirm.className = 'btn btn-primary';
    els.modalCancel.textContent = '取消';
    els.modal.returnValue = 'cancel';
    if (els.modal.open) els.modal.close('cancel');
    els.modal.showModal();
    idInput.focus();
}

// ────────────────────────────── 绿幕视频 → 新动作 ──────────────────────────────

function openPipelineDialog() {
    const avatar = currentAvatar();
    if (!avatar) {
        toast('请先选择一个形象', 'warn');
        return;
    }
    if (state.pipeline.running) {
        toast('已有生成任务在运行，请先等待完成或停止', 'warn');
        return;
    }
    if (els.pipelineModal.open) return;
    state.pipeline.openToken += 1;
    const openToken = state.pipeline.openToken;

    const action = currentAction();
    const runtimeActions = state.library?.runtimeActions || [];
    const canvas = frameCanvas();
    const maxUploadBytes = 512 * 1024 * 1024;

    let selectedFile = null;
    let formLocked = false;
    let idDirty = false;
    let labelDirty = false;
    let descriptionDirty = false;
    let loopDirty = false;
    let framesDirty = false;
    let fpsDirty = false;
    let runtimeForced = false;

    // ── 视频选择 ──
    const fileInput = h('input', {
        type: 'file',
        accept: 'video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv,.m4v',
        hidden: true,
    });
    const fileInfo = h('span', { class: 'pipeline-file', text: '尚未选择视频' });
    const drop = h(
        'div',
        {
            class: 'pipeline-drop',
            role: 'button',
            tabindex: '0',
            on: {
                click: () => fileInput.click(),
                keydown: (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        fileInput.click();
                    }
                },
            },
        },
        h('span', { class: 'pipeline-drop-icon', text: '🎬' }),
        h('strong', { text: '选择或拖入绿幕视频' }),
        h('span', { class: 'muted', text: 'mp4 / mov / webm / mkv · 建议 4s、固定机位、纯 #00FF00 背景' }),
        fileInfo,
    );
    for (const eventName of ['dragenter', 'dragover']) {
        drop.addEventListener(eventName, (event) => {
            event.preventDefault();
            if (!formLocked) drop.dataset.dragover = 'true';
        });
    }
    drop.addEventListener('dragleave', () => {
        delete drop.dataset.dragover;
    });
    drop.addEventListener('drop', (event) => {
        event.preventDefault();
        delete drop.dataset.dragover;
        if (formLocked) return;
        const file = event.dataTransfer?.files?.[0];
        if (file) selectVideoFile(file);
    });
    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) selectVideoFile(file);
    });

    // ── 处理方式与参数 ──
    const modeNew = h('input', { type: 'radio', name: 'pipeline-mode', value: 'new' });
    const modeReplace = h('input', {
        type: 'radio',
        name: 'pipeline-mode',
        value: 'replace',
        disabled: !action,
    });
    modeNew.checked = true;
    const modeRow = h(
        'div',
        { class: 'pipeline-mode-row' },
        h('label', { class: 'radio-field' }, modeNew, h('span', { text: '新建动作' })),
        h(
            'label',
            { class: 'radio-field' },
            modeReplace,
            h('span', {
                text: action
                    ? `替换当前动作「${action.label || action.id}」`
                    : '替换当前动作（未选中）',
            }),
        ),
    );

    const actionIdInput = h('input', {
        class: 'input',
        type: 'text',
        maxlength: '64',
        placeholder: '例如 happy（选择视频后自动填写）',
        autocomplete: 'off',
    });
    const labelInput = h('input', {
        class: 'input',
        type: 'text',
        maxlength: '40',
        placeholder: '例如 开心',
        autocomplete: 'off',
    });
    const descriptionInput = h('textarea', {
        class: 'input textarea',
        rows: '3',
        maxlength: '200',
        placeholder: '一句话说明动作整体内容、幅度/节奏与首尾姿态（供大模型调用）',
    });
    const framesInput = h('input', {
        class: 'input',
        type: 'number',
        min: '2',
        max: '240',
        step: '1',
        value: '36',
    });
    const fpsInput = h('input', {
        class: 'input',
        type: 'number',
        min: '1',
        max: '60',
        step: '1',
        value: String(action?.fps || 12),
    });
    const loopInput = h('input', { type: 'checkbox' });
    loopInput.checked = action?.loop === true;

    const canvasWInput = h('input', {
        class: 'input input-sm',
        type: 'number',
        min: '64',
        max: '4096',
        step: '1',
        value: String(canvas.width),
    });
    const canvasHInput = h('input', {
        class: 'input input-sm',
        type: 'number',
        min: '64',
        max: '4096',
        step: '1',
        value: String(canvas.height),
    });
    const footLineInput = h('input', {
        class: 'input input-sm',
        type: 'number',
        min: '0',
        step: '1',
        value: '980',
    });
    const targetHeightInput = h('input', {
        class: 'input input-sm',
        type: 'number',
        min: '32',
        step: '1',
        value: '800',
    });
    const marginInput = h('input', {
        class: 'input input-sm',
        type: 'number',
        min: '0',
        step: '1',
        value: '24',
    });
    const maxFramesInput = h('input', {
        class: 'input input-sm',
        type: 'number',
        min: '2',
        max: '600',
        step: '1',
        value: '240',
    });
    const startInput = h('input', {
        class: 'input input-sm',
        type: 'number',
        min: '0',
        step: '0.1',
        placeholder: '自动',
    });
    const endInput = h('input', {
        class: 'input input-sm',
        type: 'number',
        min: '0',
        step: '0.1',
        placeholder: '自动',
    });
    const windowStartInput = h('input', {
        class: 'input input-sm',
        type: 'number',
        min: '0',
        step: '1',
        placeholder: '自动',
    });
    const qualityInput = h('input', {
        class: 'input input-sm',
        type: 'number',
        min: '0',
        max: '100',
        step: '1',
        value: '82',
    });
    const methodInput = h('input', {
        class: 'input input-sm',
        type: 'number',
        min: '0',
        max: '6',
        step: '1',
        value: '4',
    });
    const runtimeHint = h('p', { class: 'hint', hidden: true, text: '' });
    const advanced = h(
        'details',
        { class: 'pipeline-advanced' },
        h('summary', { text: '高级参数（画布 / 选窗 / 编码）' }),
        h(
            'div',
            { class: 'field-row' },
            h(
                'label',
                { class: 'field' },
                h('span', { class: 'field-label', text: '画布宽' }),
                canvasWInput,
            ),
            h(
                'label',
                { class: 'field' },
                h('span', { class: 'field-label', text: '画布高' }),
                canvasHInput,
            ),
        ),
        h(
            'div',
            { class: 'field-row' },
            h(
                'label',
                { class: 'field' },
                h('span', { class: 'field-label', text: '脚底基准 y' }),
                footLineInput,
            ),
            h(
                'label',
                { class: 'field' },
                h('span', { class: 'field-label', text: '角色目标高度' }),
                targetHeightInput,
            ),
        ),
        h(
            'div',
            { class: 'field-row' },
            h(
                'label',
                { class: 'field' },
                h('span', { class: 'field-label', text: '左右安全边距' }),
                marginInput,
            ),
            h(
                'label',
                { class: 'field' },
                h('span', { class: 'field-label', text: '最多解码帧数' }),
                maxFramesInput,
            ),
        ),
        h(
            'div',
            { class: 'field-row' },
            h(
                'label',
                { class: 'field' },
                h('span', { class: 'field-label', text: '视频起始秒' }),
                startInput,
            ),
            h(
                'label',
                { class: 'field' },
                h('span', { class: 'field-label', text: '视频结束秒' }),
                endInput,
            ),
        ),
        h(
            'div',
            { class: 'field-row' },
            h(
                'label',
                { class: 'field' },
                h('span', { class: 'field-label', text: '窗口起始帧（0-based）' }),
                windowStartInput,
            ),
            h(
                'label',
                { class: 'field' },
                h('span', { class: 'field-label', text: 'WebP 质量 0–100' }),
                qualityInput,
            ),
        ),
        h(
            'div',
            { class: 'field-row' },
            h(
                'label',
                { class: 'field' },
                h('span', { class: 'field-label', text: 'WebP method 0–6' }),
                methodInput,
            ),
            h('span'),
        ),
    );

    // ── Python 环境（流水线依赖） ──
    const envStatusText = h('span', { class: 'pipeline-env-status', text: '正在检测 Python 环境…' });
    const envDetail = h('ul', { class: 'pipeline-env-detail', hidden: true });
    const envPathInput = h('input', {
        class: 'input input-sm',
        type: 'text',
        placeholder: '解释器绝对路径，例如 C:\\Python312\\python.exe',
    });
    const envPathRow = h(
        'div',
        { class: 'pipeline-env-path', hidden: true },
        envPathInput,
        h('button', {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            text: '保存',
            on: { click: () => savePythonPath() },
        }),
        h('button', {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            text: '取消',
            on: { click: () => toggleEnvPathEditor(false) },
        }),
    );
    const envRecheckBtn = h('button', {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        text: '重新检测',
        on: { click: () => checkPythonEnv() },
    });
    const envInstallBtn = h('button', {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        text: '安装依赖（.venv）',
        on: { click: () => startEnvSetup() },
    });
    const envPickBtn = h('button', {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        text: '指定 Python…',
        on: { click: () => toggleEnvPathEditor(true) },
    });
    const envActions = h('div', { class: 'pipeline-env-actions' }, envRecheckBtn, envInstallBtn, envPickBtn);
    const envPanel = h(
        'div',
        { class: 'pipeline-env' },
        h('div', { class: 'pipeline-env-head' }, envStatusText),
        envActions,
        envPathRow,
        envDetail,
        h('p', {
            class: 'hint',
            text: '需要 Python 3.10+ 以及 opencv-python / numpy / Pillow；点「安装依赖」会在本工具目录创建 .venv 并安装，不修改系统 Python。',
        }),
    );

    const body = h(
        'div',
        { class: 'pipeline-form' },
        h('div', { class: 'field' }, h('span', { class: 'field-label', text: '绿幕视频' }), drop),
        h('div', { class: 'field' }, h('span', { class: 'field-label', text: '处理方式' }), modeRow),
        h(
            'div',
            { class: 'field-row' },
            h(
                'label',
                { class: 'field' },
                h('span', { class: 'field-label', text: '动作 ID（小写字母/数字/_/-）' }),
                actionIdInput,
            ),
            h(
                'label',
                { class: 'field' },
                h('span', { class: 'field-label', text: '显示名' }),
                labelInput,
            ),
        ),
        h(
            'label',
            { class: 'field' },
            h('span', { class: 'field-label', text: '动作描述（可选，供大模型调用）' }),
            descriptionInput,
        ),
        h(
            'div',
            { class: 'field-row' },
            h(
                'label',
                { class: 'field' },
                h('span', { class: 'field-label', text: '帧数（2–240）' }),
                framesInput,
            ),
            h(
                'label',
                { class: 'field' },
                h('span', { class: 'field-label', text: '帧率' }),
                fpsInput,
            ),
        ),
        h(
            'label',
            { class: 'switch-field switch-field-box pipeline-loop' },
            loopInput,
            h('span', { text: '循环播放' }),
        ),
        runtimeHint,
        advanced,
        envPanel,
        fileInput,
    );

    // ── 进度面板 ──
    const stageText = h('strong', { id: 'pipeline-stage', text: '准备中…' });
    const percentText = h('span', { id: 'pipeline-percent', text: '0%' });
    const barFill = h('span', { id: 'pipeline-bar-fill' });
    const logEl = h('pre', { class: 'pipeline-log', id: 'pipeline-log', text: '' });
    const progressBox = h(
        'div',
        { class: 'pipeline-progress', hidden: true },
        h('div', { class: 'pipeline-progress-head' }, stageText, percentText),
        h('div', { class: 'pipeline-bar' }, barFill),
        logEl,
    );
    body.append(progressBox);

    function setFormDisabled(disabled) {
        formLocked = disabled;
        for (const element of body.querySelectorAll('input, select, textarea')) {
            element.disabled = disabled;
        }
        if (!disabled) {
            actionIdInput.disabled = modeReplace.checked;
            refreshRuntimeState();
        }
    }

    function refreshRuntimeState() {
        if (formLocked) return;
        const currentId = actionIdInput.value.trim();
        const runtime = runtimeActions.includes(currentId);
        if (runtime) {
            runtimeForced = true;
            fpsInput.value = '12';
            fpsInput.disabled = true;
            loopInput.checked = currentId === 'idle';
            loopInput.disabled = true;
            runtimeHint.hidden = false;
            runtimeHint.textContent = `运行时动作：固定 12 fps、${currentId === 'idle' ? '循环' : '单次'}播放。`;
        } else {
            if (runtimeForced) {
                runtimeForced = false;
                const known = (avatar.actions || []).find((item) => item.id === currentId);
                if (!loopDirty) loopInput.checked = known?.loop === true;
                if (!fpsDirty) fpsInput.value = String(known?.fps || 12);
            }
            fpsInput.disabled = false;
            loopInput.disabled = false;
            runtimeHint.hidden = true;
        }
    }

    // ── Python 环境检测 / 安装 ──
    let envInfo = null;
    let envCheckToken = 0;
    const envSetup = { running: false, jobId: '', timer: 0, token: 0 };

    function setEnvButtonsDisabled(disabled) {
        for (const button of [envRecheckBtn, envInstallBtn, envPickBtn]) button.disabled = disabled;
        for (const button of envPathRow.querySelectorAll('button')) button.disabled = disabled;
    }

    function shortenPath(value, limit = 64) {
        const text = String(value || '');
        if (text.length <= limit) return text;
        const head = Math.ceil((limit - 3) / 2);
        const tail = Math.floor((limit - 3) / 2);
        return `${text.slice(0, head)}…${text.slice(-tail)}`;
    }

    function renderEnv(info) {
        envInfo = info || null;
        const available = info?.available === true;
        envDetail.replaceChildren();
        envDetail.hidden = true;
        envStatusText.classList.toggle('warn-text', !available);
        if (available) {
            const meta = [];
            if (info.version) meta.push(`Python ${info.version}`);
            if (info.originLabel) meta.push(info.originLabel);
            if (info.executable) meta.push(shortenPath(info.executable));
            envStatusText.textContent = `Python 可用：${meta.join(' · ')}`;
        } else {
            envStatusText.textContent = 'Python 环境不可用';
            const candidates = Array.isArray(info?.candidates) ? info.candidates : [];
            if (candidates.length) {
                envDetail.hidden = false;
                for (const item of candidates) {
                    const reason = item.ok
                        ? `可用${item.version ? `（Python ${item.version}）` : ''}`
                        : (item.missing?.length
                            ? `缺少 ${item.missing.map((entry) => entry.package || entry.module).join('、')}`
                            : (item.error || '不可用'));
                    envDetail.append(
                        h('li', {}, h('code', { text: item.label }), h('span', { text: ` → ${reason}` })),
                    );
                }
            } else if (info?.error) {
                envDetail.hidden = false;
                envDetail.append(h('li', { text: info.error }));
            }
        }
        els.pipelineConfirm.disabled = !available || formLocked || envSetup.running;
        envInstallBtn.disabled = envSetup.running;
    }

    async function checkPythonEnv() {
        const token = (envCheckToken += 1);
        envStatusText.classList.remove('warn-text');
        envStatusText.textContent = '正在检测 Python 环境…';
        envDetail.hidden = true;
        setEnvButtonsDisabled(true);
        try {
            const status = await api('/api/pipeline/status');
            if (openToken !== state.pipeline.openToken || token !== envCheckToken) return;
            renderEnv(status.python);
        } catch (error) {
            if (openToken !== state.pipeline.openToken || token !== envCheckToken) return;
            envStatusText.textContent = `检测 Python 环境失败：${error.message}`;
            envStatusText.classList.add('warn-text');
            els.pipelineConfirm.disabled = true;
        } finally {
            if (token === envCheckToken) setEnvButtonsDisabled(envSetup.running);
        }
    }

    function toggleEnvPathEditor(show) {
        envPathRow.hidden = !show;
        if (show) {
            envPathInput.value = envInfo?.executable || '';
            envPathInput.focus();
            envPathInput.select?.();
        }
    }

    async function savePythonPath() {
        const value = envPathInput.value.trim();
        if (!value) {
            toast('请填写 Python 解释器路径', 'warn');
            return;
        }
        setEnvButtonsDisabled(true);
        try {
            const data = await api('/api/pipeline/env/python', { method: 'POST', body: { path: value } });
            if (openToken !== state.pipeline.openToken) return;
            renderEnv(data.python);
            toggleEnvPathEditor(false);
            toast(
                data.python.available ? '已切换 Python 解释器' : '已保存，但该解释器缺少依赖',
                data.python.available ? 'ok' : 'warn',
                6000,
            );
        } catch (error) {
            toast(error.message, 'danger', 7000);
        } finally {
            setEnvButtonsDisabled(envSetup.running);
        }
    }

    async function startEnvSetup() {
        if (envSetup.running || state.pipeline.running) return;
        envSetup.running = true;
        envSetup.token += 1;
        state.pipeline.setupRunning = true;
        const token = envSetup.token;
        setEnvButtonsDisabled(true);
        setFormDisabled(true);
        els.pipelineConfirm.disabled = true;
        els.pipelineCancel.hidden = false;
        els.pipelineCancel.disabled = false;
        els.pipelineCancel.textContent = '停止安装';
        clearPipelineNotices();
        progressBox.hidden = false;
        logEl.hidden = false;
        logEl.textContent = '';
        stageText.textContent = '准备安装 Python 依赖…';
        percentText.textContent = '0%';
        barFill.style.width = '0%';
        barFill.classList.remove('is-error');
        try {
            const data = await api('/api/pipeline/env/setup', { method: 'POST', body: {} });
            if (token !== envSetup.token) return;
            envSetup.jobId = data.job.id;
            pollEnvSetup(token, data.job.id);
        } catch (error) {
            handleEnvSetupFailure(error.message, token);
        }
    }

    function pollEnvSetup(token, jobId) {
        const tick = async () => {
            if (token !== envSetup.token) return;
            try {
                const data = await api(`/api/pipeline/env/setup?id=${encodeURIComponent(jobId)}`);
                if (token !== envSetup.token) return;
                const job = data.job;
                setPipelineProgress(job);
                if (job.status === 'running') {
                    envSetup.timer = setTimeout(tick, 800);
                    return;
                }
                if (job.status === 'done') await handleEnvSetupDone(job, token);
                else handleEnvSetupFailure(job.error || '依赖安装失败', token, job);
            } catch (_error) {
                if (token !== envSetup.token) return;
                envSetup.timer = setTimeout(tick, 1500);
            }
        };
        tick();
    }

    async function handleEnvSetupDone(job, token) {
        if (token !== envSetup.token) return;
        envSetup.running = false;
        envSetup.jobId = '';
        state.pipeline.setupRunning = false;
        clearTimeout(envSetup.timer);
        envSetup.timer = 0;
        setFormDisabled(false);
        els.pipelineCancel.hidden = false;
        els.pipelineCancel.disabled = false;
        els.pipelineCancel.textContent = '取消';
        clearPipelineNotices();
        setPipelineProgress({ ...job, stage: '依赖安装完成', progress: 100 });
        stageText.textContent = '依赖安装完成';
        percentText.textContent = '100%';
        barFill.style.width = '100%';
        barFill.classList.remove('is-error');
        const result = job.result || {};
        progressBox.append(
            h(
                'div',
                { class: 'pipeline-summary' },
                h('strong', { text: 'Python 环境已就绪' }),
                h(
                    'ul',
                    {},
                    h('li', { text: `解释器：${result.executable || ''}` }),
                    h('li', { text: `虚拟环境：${result.venv || ''}` }),
                    h('li', { text: '之后的生成会自动使用该环境' }),
                ),
            ),
        );
        toast('Python 依赖安装完成', 'ok', 6000);
        await checkPythonEnv();
    }

    function handleEnvSetupFailure(message, token, job) {
        if (token !== envSetup.token) return;
        envSetup.running = false;
        envSetup.jobId = '';
        state.pipeline.setupRunning = false;
        clearTimeout(envSetup.timer);
        envSetup.timer = 0;
        setFormDisabled(false);
        els.pipelineCancel.hidden = false;
        els.pipelineCancel.disabled = false;
        els.pipelineCancel.textContent = '取消';
        clearPipelineNotices();
        if (job) setPipelineProgress(job);
        else progressBox.hidden = false;
        stageText.textContent = '依赖安装失败';
        percentText.textContent = '—';
        barFill.style.width = '100%';
        barFill.classList.add('is-error');
        progressBox.append(h('div', { class: 'pipeline-error', text: message }));
        logEl.hidden = false;
        setEnvButtonsDisabled(false);
        envStatusText.textContent = 'Python 环境不可用';
        envStatusText.classList.add('warn-text');
        els.pipelineConfirm.disabled = true;
    }

    async function cancelEnvSetup() {
        if (!envSetup.running) return;
        const jobId = envSetup.jobId;
        envSetup.token += 1;
        envSetup.running = false;
        envSetup.jobId = '';
        state.pipeline.setupRunning = false;
        clearTimeout(envSetup.timer);
        envSetup.timer = 0;
        els.pipelineCancel.disabled = true;
        try {
            if (jobId) await api('/api/pipeline/env/setup/cancel', { method: 'POST', body: { id: jobId } });
        } catch (_error) {
            /* 取消失败不阻塞界面 */
        }
        els.pipelineCancel.disabled = false;
        els.pipelineCancel.textContent = '取消';
        setFormDisabled(false);
        setEnvButtonsDisabled(false);
        stageText.textContent = '已取消安装';
        percentText.textContent = '—';
        barFill.classList.remove('is-error');
        toast('已取消依赖安装', 'warn');
        await checkPythonEnv();
    }

    function applyMode() {
        if (formLocked) return;
        const replace = modeReplace.checked;
        actionIdInput.disabled = replace;
        if (replace && action) {
            actionIdInput.value = action.id;
            if (!labelDirty) labelInput.value = action.label || action.id;
            if (!descriptionDirty) descriptionInput.value = action.description || '';
            if (!framesDirty) framesInput.value = String(action.frameCount || 36);
            if (!fpsDirty) fpsInput.value = String(action.fps || 12);
            if (!loopDirty) loopInput.checked = action.loop === true;
        } else if (selectedFile && !idDirty) {
            actionIdInput.value = suggestActionId(avatar, selectedFile.name);
            if (!labelDirty) labelInput.value = actionIdInput.value;
            const sourceSlug = slugifyActionName(selectedFile.name);
            const known = (avatar.actions || []).find((item) => item.id === sourceSlug);
            if (!descriptionDirty) descriptionInput.value = known?.description || '';
            if (!framesDirty) framesInput.value = String(known?.frameCount || 36);
            if (!fpsDirty) fpsInput.value = String(known?.fps || 12);
            if (!loopDirty) loopInput.checked = known ? known.loop === true : false;
        } else if (!selectedFile && actionIdInput.value === action?.id) {
            actionIdInput.value = '';
            if (!descriptionDirty) descriptionInput.value = '';
            if (!framesDirty) framesInput.value = '36';
            if (!fpsDirty) fpsInput.value = '12';
            if (!loopDirty) loopInput.checked = false;
        }
        refreshRuntimeState();
    }

    function selectVideoFile(file) {
        if (!/\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(file.name)) {
            toast('请选择 mp4 / mov / webm / mkv / avi / m4v 视频', 'warn');
            return;
        }
        if (file.size > maxUploadBytes) {
            toast(`视频超过 ${Math.round(maxUploadBytes / 1024 / 1024)}MB，请先压缩或裁短`, 'warn');
            return;
        }
        selectedFile = file;
        fileInfo.textContent = `${file.name} · ${formatBytes(file.size)}`;
        delete drop.dataset.dragover;
        drop.dataset.hasFile = 'true';

        if (!idDirty) actionIdInput.value = suggestActionId(avatar, file.name);
        if (!labelDirty) labelInput.value = actionIdInput.value;

        const sourceSlug = slugifyActionName(file.name);
        const known = (avatar.actions || []).find((item) => item.id === sourceSlug);
        if (modeReplace.checked && action) {
            if (!descriptionDirty) descriptionInput.value = action.description || '';
            if (!framesDirty) framesInput.value = String(action.frameCount || 36);
            if (!fpsDirty) fpsInput.value = String(action.fps || 12);
            if (!loopDirty) loopInput.checked = action.loop === true;
        } else if (known) {
            if (!descriptionDirty) descriptionInput.value = known.description || '';
            if (!framesDirty) framesInput.value = String(known.frameCount || 36);
            if (!fpsDirty) fpsInput.value = String(known.fps || 12);
            if (!loopDirty) loopInput.checked = known.loop === true;
        }
        refreshRuntimeState();
    }

    function clearPipelineNotices() {
        for (const node of progressBox.querySelectorAll('.pipeline-summary, .pipeline-error')) {
            node.remove();
        }
        barFill.classList.remove('is-error');
    }

    function setPipelineProgress(job) {
        progressBox.hidden = false;
        const progress = clamp(Number(job.progress) || 0, 0, 100);
        stageText.textContent = job.stage || '处理中…';
        percentText.textContent = `${Math.round(progress)}%`;
        barFill.style.width = `${progress}%`;
        const lines = Array.isArray(job.log) ? job.log : [];
        if (lines.length) {
            const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
            logEl.textContent = lines.slice(-80).join('\n');
            if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
        }
    }

    function handlePipelineFailure(message, job) {
        state.pipeline.running = false;
        clearPipelineNotices();
        if (job) setPipelineProgress(job);
        else progressBox.hidden = false;
        stageText.textContent = '生成失败';
        percentText.textContent = '—';
        barFill.style.width = '100%';
        barFill.classList.add('is-error');
        progressBox.append(h('div', { class: 'pipeline-error', text: message }));
        els.pipelineCancel.hidden = false;
        els.pipelineCancel.disabled = false;
        els.pipelineCancel.textContent = '关闭';
        els.pipelineConfirm.disabled = false;
        els.pipelineConfirm.textContent = '重新生成';
        setFormDisabled(false);
        state.pipeline.submit = () => submitPipeline();
    }

    async function handlePipelineDone(job) {
        state.pipeline.running = false;
        clearPipelineNotices();
        setPipelineProgress({ ...job, stage: '完成', progress: 100 });
        stageText.textContent = '生成完成';
        percentText.textContent = '100%';
        barFill.style.width = '100%';
        els.pipelineCancel.hidden = true;
        els.pipelineConfirm.disabled = false;
        els.pipelineConfirm.textContent = '完成';
        state.pipeline.submit = () => closePipelineDialog();
        logEl.hidden = false;

        let generated = null;
        try {
            await loadLibrary({ preserve: true, status: '已生成动作，正在刷新…' });
            selectAction(job.actionId, { frameIndex: 0 });
            generated = currentAction();
        } catch (error) {
            toast(`生成完成，但刷新资产库失败：${error.message}`, 'danger', 7000);
        }

        const result = job.result || {};
        const seam = result.render?.seam?.seamRatio;
        const rows = [`帧数：${generated?.frameCount ?? result.frames ?? 0}`];
        if (generated) {
            rows.push(`体积：${formatBytes(generated.totalBytes || 0)} · 总时长：${formatDurationMs(generated.durationMs || 0)}`);
        }
        if (seam !== undefined && seam !== null) {
            const value = Number(seam);
            const warning = value > 1.8 || value < 0.5 ? '（可能可见，建议调整帧数或窗口）' : '';
            rows.push(`循环接缝 seamRatio：${value.toFixed(3)}${warning}`);
        }
        if (result.write?.backup) rows.push(`旧帧备份：${result.write.backup}`);
        else rows.push('新动作：无旧帧备份');

        progressBox.append(
            h(
                'div',
                { class: 'pipeline-summary' },
                h('strong', { text: `动作「${job.actionId}」已生成` }),
                h('ul', {}, rows.map((text) => h('li', { text }))),
            ),
        );
        toast(`已生成动作 ${job.actionId} · ${generated?.frameCount ?? result.frames ?? 0} 帧`, 'ok', 7000);
        setStatus(`已生成动作 ${job.actionId}`);
    }

    function startPipelinePolling(jobId) {
        state.pipeline.jobId = jobId;
        let failures = 0;
        const tick = async () => {
            if (!state.pipeline.running || state.pipeline.jobId !== jobId) return;
            try {
                const data = await api(`/api/pipeline/job?id=${encodeURIComponent(jobId)}`);
                failures = 0;
                const job = data.job;
                setPipelineProgress(job);
                if (job.status === 'running') {
                    state.pipeline.pollTimer = setTimeout(tick, 800);
                    return;
                }
                state.pipeline.running = false;
                state.pipeline.pollTimer = 0;
                if (job.status === 'done') await handlePipelineDone(job);
                else handlePipelineFailure(job.error || '生成失败', job);
            } catch (error) {
                failures += 1;
                if (failures >= 8) {
                    state.pipeline.running = false;
                    handlePipelineFailure(`获取任务状态失败：${error.message}`, null);
                    return;
                }
                state.pipeline.pollTimer = setTimeout(tick, 1500);
            }
        };
        tick();
    }

    function uploadPipelineVideo(file, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            state.pipeline.xhr = xhr;
            xhr.open('POST', `/api/pipeline/upload?name=${encodeURIComponent(file.name)}`);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            xhr.upload.addEventListener('progress', (event) => {
                if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
            });
            xhr.addEventListener('load', () => {
                state.pipeline.xhr = null;
                let payload = null;
                try {
                    payload = JSON.parse(xhr.responseText);
                } catch (_error) {
                    payload = null;
                }
                if (xhr.status >= 200 && xhr.status < 300 && payload && payload.ok && payload.upload) {
                    resolve(payload.upload);
                } else {
                    reject(new Error(payload?.error || `上传失败（HTTP ${xhr.status}）`));
                }
            });
            xhr.addEventListener('error', () => {
                state.pipeline.xhr = null;
                reject(new Error('上传失败：网络错误'));
            });
            xhr.addEventListener('abort', () => {
                state.pipeline.xhr = null;
                reject(new Error('上传已取消'));
            });
            xhr.send(file);
        });
    }

    async function submitPipeline() {
        if (state.pipeline.running || envSetup.running) return;
        if (envInfo && envInfo.available !== true) {
            toast('Python 环境不可用：请先安装依赖或指定解释器', 'warn', 6000);
            return;
        }
        const file = selectedFile || fileInput.files?.[0] || null;
        if (!file) {
            toast('请选择绿幕视频文件', 'warn');
            return;
        }
        const actionId = actionIdInput.value.trim();
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(actionId)) {
            toast('动作 ID 非法：只能使用字母、数字、下划线、连字符', 'danger');
            actionIdInput.focus();
            return;
        }
        const mode = modeReplace.checked ? 'replace' : 'new';
        if (mode === 'new' && (avatar.actions || []).some((item) => item.id === actionId)) {
            toast(`动作 ${actionId} 已存在；请换一个 ID 或选择「替换当前动作」`, 'danger', 6000);
            actionIdInput.focus();
            return;
        }

        const readNumber = (input, fallback) => {
            const value = Number(input.value);
            return Number.isFinite(value) ? value : fallback;
        };
        const readOptional = (input) => (input.value.trim() === '' ? null : Number(input.value));
        const payload = {
            avatar: state.avatarId,
            action: actionId,
            mode,
            label: labelInput.value.trim() || actionId,
            description: descriptionInput.value.trim(),
            loop: loopInput.checked,
            fps: readNumber(fpsInput, 12),
            frames: readNumber(framesInput, 36),
            maxFrames: readNumber(maxFramesInput, 240),
            canvasWidth: readNumber(canvasWInput, canvas.width),
            canvasHeight: readNumber(canvasHInput, canvas.height),
            footLine: readNumber(footLineInput, 980),
            targetHeight: readNumber(targetHeightInput, 800),
            margin: readNumber(marginInput, 24),
            quality: readNumber(qualityInput, 82),
            method: readNumber(methodInput, 4),
            windowStart: readOptional(windowStartInput),
            start: readOptional(startInput),
            end: readOptional(endInput),
        };
        if (payload.start !== null && payload.end !== null && payload.end <= payload.start) {
            toast('结束秒必须大于起始秒', 'danger');
            startInput.focus();
            return;
        }

        state.pipeline.running = true;
        state.pipeline.jobId = null;
        state.pipeline.submit = () => {};
        setFormDisabled(true);
        clearPipelineNotices();
        progressBox.hidden = false;
        logEl.hidden = false;
        logEl.textContent = '';
        stageText.textContent = '准备上传…';
        percentText.textContent = '0%';
        barFill.style.width = '0%';
        els.pipelineCancel.hidden = false;
        els.pipelineCancel.disabled = false;
        els.pipelineCancel.textContent = '停止生成';
        els.pipelineConfirm.disabled = true;
        els.pipelineConfirm.textContent = '生成中…';

        try {
            const upload = await uploadPipelineVideo(file, (ratio) => {
                const percent = Math.round(clamp(ratio, 0, 1) * 100);
                stageText.textContent = `上传视频 ${percent}%`;
                percentText.textContent = `${percent}%`;
                barFill.style.width = `${percent}%`;
            });
            if (!state.pipeline.running) return;
            stageText.textContent = '启动流水线…';
            percentText.textContent = '2%';
            barFill.style.width = '2%';
            const data = await api('/api/pipeline/run', {
                method: 'POST',
                body: { ...payload, uploadId: upload.id, videoName: file.name },
            });
            if (!state.pipeline.running) return;
            startPipelinePolling(data.job.id);
        } catch (error) {
            if (!state.pipeline.running) return;
            handlePipelineFailure(error.message, null);
        }
    }

    function cancelPipeline() {
        if (envSetup.running) {
            void cancelEnvSetup();
            return;
        }
        if (!state.pipeline.running) {
            closePipelineDialog();
            return;
        }
        const jobId = state.pipeline.jobId;
        state.pipeline.running = false;
        clearTimeout(state.pipeline.pollTimer);
        state.pipeline.pollTimer = 0;
        if (state.pipeline.xhr) {
            try {
                state.pipeline.xhr.abort();
            } catch (_error) {
                /* ignore */
            }
            state.pipeline.xhr = null;
        }
        els.pipelineCancel.disabled = true;
        Promise.resolve()
            .then(() => (jobId ? api('/api/pipeline/cancel', { method: 'POST', body: { id: jobId } }) : null))
            .catch(() => null)
            .finally(() => {
                els.pipelineCancel.disabled = false;
                handlePipelineFailure('已取消生成', null);
                stageText.textContent = '已取消';
                percentText.textContent = '—';
                barFill.style.width = '0%';
                barFill.classList.remove('is-error');
            });
    }

    function closePipelineDialog() {
        if (state.pipeline.running || envSetup.running) return;
        clearTimeout(envSetup.timer);
        envSetup.timer = 0;
        envSetup.token += 1;
        clearTimeout(state.pipeline.pollTimer);
        state.pipeline.pollTimer = 0;
        state.pipeline.submit = null;
        state.pipeline.cancel = null;
        if (els.pipelineModal.open) els.pipelineModal.close();
    }

    actionIdInput.addEventListener('input', () => {
        idDirty = true;
        refreshRuntimeState();
    });
    labelInput.addEventListener('input', () => {
        labelDirty = true;
    });
    descriptionInput.addEventListener('input', () => {
        descriptionDirty = true;
    });
    loopInput.addEventListener('change', () => {
        loopDirty = true;
    });
    framesInput.addEventListener('input', () => {
        framesDirty = true;
    });
    fpsInput.addEventListener('input', () => {
        fpsDirty = true;
    });
    modeNew.addEventListener('change', applyMode);
    modeReplace.addEventListener('change', applyMode);

    state.pipeline.submit = () => submitPipeline();
    state.pipeline.cancel = () => cancelPipeline();

    els.pipelineTitle.textContent = `导入绿幕视频 · ${avatar.name || avatar.id}`;
    els.pipelineBody.replaceChildren(body);
    els.pipelineCancel.hidden = false;
    els.pipelineCancel.disabled = false;
    els.pipelineCancel.textContent = '取消';
    els.pipelineConfirm.hidden = false;
    els.pipelineConfirm.disabled = false;
    els.pipelineConfirm.textContent = '开始生成';
    if (els.pipelineModal.open) els.pipelineModal.close();
    els.pipelineModal.showModal();

    refreshRuntimeState();
    checkPythonEnv();
}

// ────────────────────────────── 弹窗 ──────────────────────────────

function showConfirm({ title, body, confirmText = '确定', cancelText = '取消', danger = false }) {
    return new Promise((resolve) => {
        state.modalSubmit = null;
        els.modalTitle.textContent = title;
        els.modalBody.replaceChildren(body);
        els.modalConfirm.textContent = confirmText;
        els.modalConfirm.className = danger ? 'btn btn-danger-ghost' : 'btn btn-primary';
        els.modalCancel.textContent = cancelText;
        els.modal.returnValue = 'cancel';
        const onClose = () => {
            els.modal.removeEventListener('close', onClose);
            state.modalSubmit = null;
            resolve(els.modal.returnValue === 'confirm');
        };
        els.modal.addEventListener('close', onClose);
        if (els.modal.open) els.modal.close('cancel');
        els.modal.showModal();
    });
}

// ────────────────────────────── 事件绑定 ──────────────────────────────

function bindEvents() {
    els.btnTheme.addEventListener('click', () => {
        applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    });

    els.btnRefresh.addEventListener('click', () => {
        runSafely(() => loadLibrary({ preserve: true, status: '正在重新扫描…' }), '刷新失败');
    });

    els.avatarSelect.addEventListener('change', () => {
        state.avatarId = els.avatarSelect.value;
        const avatar = currentAvatar();
        const action = avatar?.actions.find((item) => item.frameCount > 0) || avatar?.actions[0];
        state.actionId = action ? action.id : null;
        state.frameIndex = 0;
        state.insertIndex = 1;
        stopPlayback();
        renderAll();
        updateHash();
        if (state.actionId) preloadCurrentAction();
    });

    els.actionSearch.addEventListener('input', () => {
        state.search = els.actionSearch.value;
        renderActionList();
    });

    els.btnNewAction.addEventListener('click', showNewActionDialog);
    els.btnImportVideo.addEventListener('click', openPipelineDialog);
    els.btnImportVideoStrip.addEventListener('click', openPipelineDialog);

    els.pipelineConfirm.addEventListener('click', () => {
        if (state.pipeline.submit) state.pipeline.submit();
    });
    els.pipelineCancel.addEventListener('click', () => {
        if (state.pipeline.cancel) state.pipeline.cancel();
    });
    els.pipelineModal.addEventListener('cancel', (event) => {
        if (state.pipeline.running) {
            event.preventDefault();
            toast('生成中，请先点击「停止生成」', 'warn');
            return;
        }
        if (state.pipeline.setupRunning) {
            event.preventDefault();
            toast('正在安装 Python 依赖，请先点击「停止安装」', 'warn');
        }
    });

    els.stageBg.addEventListener('change', renderStage);
    els.stageZoom.addEventListener('change', renderStage);
    els.stageGuidesToggle.addEventListener('change', renderStage);

    els.btnFirst.addEventListener('click', () => goToFrame(0));
    els.btnPrev.addEventListener('click', () => stepFrame(-1));
    els.btnPlay.addEventListener('click', togglePlayback);
    els.btnNext.addEventListener('click', () => stepFrame(1));
    els.btnLast.addEventListener('click', () => goToFrame(currentFrames().length - 1));
    els.frameRange.addEventListener('input', () => goToFrame(Number(els.frameRange.value)));

    els.btnInsert.addEventListener('click', () => openFilePicker({ type: 'insert', index: state.frameIndex }));
    els.btnInsertHere.addEventListener('click', () => {
        const frames = currentFrames();
        const index = clamp((Number(els.insertIndex.value) || 1) - 1, 0, frames.length);
        openFilePicker({ type: 'insert', index });
    });
    els.insertIndex.addEventListener('input', () => {
        const frames = currentFrames();
        state.insertIndex = clamp(Number(els.insertIndex.value) || 1, 1, Math.max(1, frames.length + 1));
        els.insertHint.textContent = `1 = 最前面；${frames.length + 1} = 末尾；当前共 ${frames.length} 帧。插入位置：第 ${state.insertIndex} 帧前。`;
    });

    els.btnMoveLeft.addEventListener('click', () => reorderFrames(state.frameIndex, state.frameIndex - 1));
    els.btnMoveRight.addEventListener('click', () => reorderFrames(state.frameIndex, state.frameIndex + 1));
    els.btnDuplicate.addEventListener('click', duplicateCurrentFrame);
    els.btnReplace.addEventListener('click', () => openFilePicker({ type: 'replace', index: state.frameIndex }));
    els.btnDeleteFrame.addEventListener('click', deleteCurrentFrame);

    els.frameDurationInput.addEventListener('input', () => {
        const value = Number(els.frameDurationInput.value);
        if (Number.isFinite(value) && value > 0) setFrameMultiplier(state.frameIndex, value);
    });
    els.frameDurationInput.addEventListener('change', () => {
        const value = Number(els.frameDurationInput.value);
        setFrameMultiplier(state.frameIndex, Number.isFinite(value) && value > 0 ? value : 1);
    });
    els.btnDurationMinus.addEventListener('click', () => {
        setFrameMultiplier(state.frameIndex, frameMultiplierAt(state.frameIndex) - 0.05);
    });
    els.btnDurationPlus.addEventListener('click', () => {
        setFrameMultiplier(state.frameIndex, frameMultiplierAt(state.frameIndex) + 0.05);
    });
    els.btnDurationReset.addEventListener('click', () => setFrameMultiplier(state.frameIndex, 1));
    els.btnTimingResetAll.addEventListener('click', resetAllFrameTiming);

    els.btnSaveMeta.addEventListener('click', saveActionMeta);

    els.pathLibrary.addEventListener('click', () => openDirectory('library'));

    for (const tab of els.tabs) {
        tab.addEventListener('click', () => {
            state.tab = tab.dataset.tab;
            renderTabs();
        });
    }

    els.modalForm.addEventListener('submit', (event) => {
        if (event.submitter === els.modalCancel) {
            state.modalSubmit = null;
            return;
        }
        if (state.modalSubmit) {
            event.preventDefault();
            state.modalSubmit();
        }
    });

    els.fileInput.addEventListener('change', () => {
        const files = Array.from(els.fileInput.files || []);
        const target = state.fileTarget;
        state.fileTarget = null;
        if (!files.length || !target) return;
        if (target.type === 'replace') replaceFrame(target.index, files[0]);
        else insertFilesAt(target.index, files);
    });

    // 拖到舞台：插入到当前帧之前
    let dragDepth = 0;
    els.stageCanvas.addEventListener('dragenter', (event) => {
        if (!event.dataTransfer?.types?.includes('Files')) return;
        event.preventDefault();
        dragDepth += 1;
        els.stageCanvas.dataset.dropping = 'true';
    });
    els.stageCanvas.addEventListener('dragover', (event) => {
        if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
    });
    els.stageCanvas.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) delete els.stageCanvas.dataset.dropping;
    });
    els.stageCanvas.addEventListener('drop', (event) => {
        if (!event.dataTransfer?.files?.length) return;
        event.preventDefault();
        dragDepth = 0;
        delete els.stageCanvas.dataset.dropping;
        if (state.dragFrom !== null) return;
        insertFilesAt(state.frameIndex, event.dataTransfer.files);
    });

    document.addEventListener('keydown', (event) => {
        // 任何弹窗打开时都不要触发工作台快捷键（空格播放、Delete 删帧等）
        if (document.querySelector('dialog[open]')) return;
        const tag = String(event.target?.tagName || '').toLowerCase();
        const editing = ['input', 'textarea', 'select'].includes(tag) || event.target?.isContentEditable;
        if (editing) return;
        if (event.ctrlKey || event.metaKey) {
            if (event.key.toLowerCase() === 's') {
                event.preventDefault();
                saveActionMeta();
            } else if (event.key.toLowerCase() === 'r') {
                event.preventDefault();
                runSafely(() => loadLibrary({ preserve: true, status: '正在重新扫描…' }), '刷新失败');
            }
            return;
        }
        switch (event.key) {
            case ' ':
                event.preventDefault();
                togglePlayback();
                break;
            case 'ArrowLeft':
                event.preventDefault();
                stepFrame(-1);
                break;
            case 'ArrowRight':
                event.preventDefault();
                stepFrame(1);
                break;
            case 'Home':
                event.preventDefault();
                goToFrame(0);
                break;
            case 'End':
                event.preventDefault();
                goToFrame(currentFrames().length - 1);
                break;
            case 'i':
            case 'I':
                event.preventDefault();
                openFilePicker({ type: 'insert', index: state.frameIndex });
                break;
            case 'r':
            case 'R':
                event.preventDefault();
                openFilePicker({ type: 'replace', index: state.frameIndex });
                break;
            case 'Delete':
            case 'Backspace':
                event.preventDefault();
                deleteCurrentFrame();
                break;
            default:
                break;
        }
    });

    window.addEventListener('hashchange', () => {
        const hash = parseHash();
        if (hash.avatarId && hash.avatarId !== state.avatarId) {
            state.avatarId = hash.avatarId;
            renderAvatarSelect();
        }
        if (hash.actionId && hash.actionId !== state.actionId) {
            selectAction(hash.actionId, { frameIndex: hash.frameIndex });
        } else if (hash.actionId === state.actionId && hash.frameIndex !== state.frameIndex) {
            goToFrame(hash.frameIndex);
        }
    });

    window.addEventListener('beforeunload', () => {
        clearTimeout(state.playTimer);
    });
}

async function openDirectory(target) {
    try {
        await api('/api/open', { method: 'POST', body: { target } });
    } catch (error) {
        toast(error.message, 'danger');
    }
}

async function runSafely(task, fallbackMessage) {
    try {
        await task();
    } catch (error) {
        toast(`${fallbackMessage}：${error.message}`, 'danger', 7000);
        console.error(error);
    }
}

// ────────────────────────────── 启动 ──────────────────────────────

function showBootError(error) {
    const card = h(
        'div',
        { class: 'boot-card boot-error' },
        h('h1', { text: '无法连接资产库服务' }),
        h('p', { text: '请先在 tools/seq_asset_tool 运行 start.bat（或 node server.mjs），然后刷新本页。' }),
        h('pre', { text: String(error?.message || error || '未知错误') }),
        h('p', { class: 'hint', text: location.protocol === 'file:' ? '当前是 file:// 直接打开，浏览器不允许访问本地 API；请使用启动脚本提供的 http://127.0.0.1 地址。' : '' }),
        h('button', {
            class: 'btn btn-primary',
            type: 'button',
            text: '重试',
            on: { click: () => location.reload() },
        }),
    );
    els.boot.replaceChildren(card);
    els.boot.hidden = false;
    els.app.hidden = true;
}

async function init() {
    applyTheme(state.theme);
    bindEvents();
    try {
        await loadLibrary({ preserve: false });
        els.boot.hidden = true;
        els.app.hidden = false;
        if (state.actionId) preloadCurrentAction();
    } catch (error) {
        console.error(error);
        showBootError(error);
    }
}

init();
