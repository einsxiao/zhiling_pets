#!/usr/bin/env node
/**
 * seq_asset_tool/server.mjs — 2D 序列帧资产工作台本地服务
 * ============================================================================
 * 职责：
 *  - 扫描 `assets/pet_seq` 规范资产库（manifest + 各形象/动作帧）；
 *  - 提供预览帧的静态读取；
 *  - 提供帧编辑 API：指定位置插入、替换、删除（移到 .trash）、重排、动作元数据；
 *  - 提供绿幕视频流水线 API：上传视频、异步生成动作、查询/取消任务；
 *  - 所有写操作只针对资产库；资产库中的旧帧一律移到 .trash，不物理删除。
 *
 * 依赖：Node.js 18+（只用内置模块，无 npm 依赖）。
 *      绿幕流水线还需要 Python 3.10+ 及 opencv-python / numpy / Pillow；
 *      工作台会自动探测（SEQ_PYTHON → pipeline.env.json → .venv → ZHILING 内置 → 系统 python），
 *      也可在「导入绿幕视频」弹窗里一键把依赖装进本目录 .venv。
 *
 * 启动：
 *   start.bat                       # Windows 推荐入口：启动服务、打开页面，关窗/Ctrl+C 即停服
 *   node server.mjs                 # 默认 127.0.0.1:4321，自动打开浏览器
 *   node server.mjs --no-open       # 不打开浏览器
 *   node server.mjs --port 4400     # 指定端口
 *   node server.mjs --watch-parent  # 启动它的父进程（cmd/终端）退出时自动停服
 *   node server.mjs --force-new     # 端口上已有工作台时仍强制新开一个实例
 *
 * 重复启动：默认复用端口上已有的工作台实例（只打开浏览器，不再占下一个端口）。
 *
 * 停止：Ctrl+C / SIGTERM（Windows 另有 SIGBREAK，POSIX 另有 SIGHUP）走优雅关闭：先断开连接再退出。
 *
 * 测试/隔离：
 *   SEQ_LIBRARY_ROOT=<fixture> SEQ_NO_OPEN=1 node server.mjs
 */

import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
// 仓库布局：<repo>/tools/seq_asset_tool → 资产库位于 <repo>/assets/pet_seq
const DEFAULT_LIBRARY_ROOT = path.resolve(TOOL_DIR, '..', '..', 'assets', 'pet_seq');
const LIBRARY_ROOT = path.resolve(process.env.SEQ_LIBRARY_ROOT || DEFAULT_LIBRARY_ROOT);

const MANIFEST_PATH = path.join(LIBRARY_ROOT, 'manifest.json');
const TRASH_ROOT = path.join(LIBRARY_ROOT, '.trash');
const STAGING_ROOT = path.join(LIBRARY_ROOT, '.staging');

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const FRAME_RE = /^frame_(\d{1,4})\.webp$/i;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** 绿幕视频流水线（seq_pipeline）的临时上传与任务状态 */
const UPLOAD_ROOT = path.join(STAGING_ROOT, 'uploads');
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']);
const PIPELINE_TIMEOUT_MS = 15 * 60 * 1000;
const PIPELINE_LOG_LIMIT = 600;
const PIPELINE_JOB_LIMIT = 12;
const PIPELINE_LAUNCHER = path.join(TOOL_DIR, 'run_pipeline.py');

/** Python 运行环境：依赖检查脚本、requirements、可选的本地 .venv 与用户指定的解释器 */
const ENV_CHECK_SCRIPT = path.join(TOOL_DIR, 'check_env.py');
const REQUIREMENTS_PATH = path.resolve(process.env.SEQ_REQUIREMENTS || path.join(TOOL_DIR, 'requirements.txt'));
const VENV_DIR = path.resolve(process.env.SEQ_VENV_DIR || path.join(TOOL_DIR, '.venv'));
const VENV_PYTHON = process.platform === 'win32'
    ? path.join(VENV_DIR, 'Scripts', 'python.exe')
    : path.join(VENV_DIR, 'bin', 'python');
const PYTHON_CONFIG_PATH = path.resolve(process.env.SEQ_PYTHON_CONFIG || path.join(TOOL_DIR, 'pipeline.env.json'));
const PYTHON_ORIGIN_LABELS = {
    env: 'SEQ_PYTHON 指定',
    config: '工作台指定',
    venv: '本地 .venv',
    embedded: 'ZHILING 内置',
    system: '系统',
};
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const SETUP_JOB_LIMIT = 5;


/** 动作目录内的配置：逐帧时长 + 动作元数据（label/description/fps/loop/note） */
const ACTION_CONFIG_FILE = 'config.json';
const LEGACY_TIMING_FILE = 'timing.json';
const ACTION_CONFIG_SCHEMA_VERSION = 1;
const TIMING_BASE_FPS = 12;
const TIMING_MIN_MULTIPLIER = 0.1;
const TIMING_MAX_MULTIPLIER = 20;
const ACTION_META_KEYS = ['label', 'description', 'fps', 'loop', 'note'];

/** 知令运行时已接入的序列帧动作（其余为储备资产，仅入库与打包） */
const RUNTIME_ACTIONS = ['idle', 'wave'];

let runtime = {
    host: process.env.SEQ_HOST || '127.0.0.1',
    port: Number(process.env.SEQ_PORT || 4321),
    openBrowser: !process.env.SEQ_NO_OPEN,
    frameWidth: 768,
    frameHeight: 1024,
};

/** 供 /api/health 辨识实例（重复启动时复用已有实例） */
const APP_STARTED_AT = new Date().toISOString();

// ────────────────────────────── 基础工具 ──────────────────────────────

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function fail(message, status = 400) {
    throw new HttpError(status, message);
}

async function pathExists(target) {
    try {
        await fs.access(target);
        return true;
    } catch (_error) {
        return false;
    }
}

function timestampLabel() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        '-',
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds()),
        '-',
        String(now.getMilliseconds()).padStart(3, '0'),
    ].join('');
}

function assertId(value, label) {
    if (typeof value !== 'string' || !ID_RE.test(value)) {
        fail(`${label} 非法：${String(value)}`);
    }
    return value;
}

/** 动作内容描述：单行、去首尾空白、≤200 码点（与资产包规范同口径） */
function normalizeDescription(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function frameNumber(name) {
    const match = FRAME_RE.exec(name);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function sortFrameNames(names) {
    return names
        .filter((name) => FRAME_RE.test(name))
        .sort((a, b) => frameNumber(a) - frameNumber(b));
}

async function readJsonFile(filePath, fallback) {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
        throw error;
    }
}

async function writeJsonAtomic(filePath, data) {
    const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, filePath);
}

function isoNow() {
    return new Date().toISOString();
}

async function movePath(source, target) {
    try {
        await fs.rename(source, target);
    } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        await fs.cp(source, target, { recursive: true });
        await fs.rm(source, { recursive: true, force: true });
    }
}

async function copyDirectory(source, target) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(source, target, { recursive: true, force: true });
}

// ────────────────────────────── 动作配置 ──────────────────────────────
// 每个动作目录下的 config.json：
//   {
//     "schemaVersion": 1,
//     "id": "idle",
//     "label": "待机",
//     "description": "动作内容描述……",
//     "fps": 12,
//     "loop": true,
//     "note": "制作备注",
//     "baseFps": 12,
//     "frameMultipliers": { "frame_004.webp": 1.5 }
//   }
// 动作元数据（label/description/fps/loop/note）与逐帧时长同文件维护；
// manifest.json 仍是库级索引，写入时会同步动作元数据。
// 旧版 timing.json 仍可读取（config.json 不存在时回退），新写入一律用 config.json。

function normalizeMultiplier(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 1;
    const clamped = Math.min(TIMING_MAX_MULTIPLIER, Math.max(TIMING_MIN_MULTIPLIER, number));
    return Math.round(clamped * 1000) / 1000;
}

function buildTiming(frameNames, source) {
    const names = Array.isArray(frameNames) ? frameNames : [];
    const raw = source && typeof source === 'object' ? source : {};
    let values = [];
    if (Array.isArray(raw.frameMultipliers)) {
        values = raw.frameMultipliers;
    } else if (raw.frameMultipliers && typeof raw.frameMultipliers === 'object') {
        values = names.map((name) => raw.frameMultipliers[name]);
    }
    const frameMultipliers = names.map((_name, index) => normalizeMultiplier(values[index]));
    const overrides = {};
    names.forEach((name, index) => {
        if (Math.abs(frameMultipliers[index] - 1) > 1e-9) overrides[name] = frameMultipliers[index];
    });
    return {
        schemaVersion: ACTION_CONFIG_SCHEMA_VERSION,
        baseFps: TIMING_BASE_FPS,
        frameMultipliers,
        overrides,
    };
}

/** 从 config.json / timing.json 中提取动作元数据（只返回实际存在的字段） */
function extractActionMeta(source) {
    const raw = source && typeof source === 'object' ? source : {};
    const meta = {};
    if (typeof raw.id === 'string' && raw.id.trim()) meta.id = raw.id.trim();
    if (typeof raw.label === 'string') meta.label = raw.label.trim().slice(0, 40);
    if (raw.description !== undefined) meta.description = normalizeDescription(raw.description);
    if (raw.fps !== undefined) {
        let fps = Number(raw.fps);
        if (!Number.isFinite(fps)) fps = 12;
        meta.fps = Math.max(1, Math.min(60, Math.round(fps)));
    }
    if (typeof raw.loop === 'boolean') meta.loop = raw.loop;
    if (raw.note !== undefined) meta.note = String(raw.note ?? '').trim().slice(0, 240);
    return meta;
}

/** 读取动作目录配置：config.json 优先，缺失时回退旧版 timing.json */
async function readActionConfigFile(actionDir) {
    const configPath = path.join(actionDir, ACTION_CONFIG_FILE);
    const config = await readJsonFile(configPath, null);
    if (config && typeof config === 'object') {
        return { raw: config, file: ACTION_CONFIG_FILE, meta: extractActionMeta(config) };
    }
    const legacyPath = path.join(actionDir, LEGACY_TIMING_FILE);
    const legacy = await readJsonFile(legacyPath, null);
    if (legacy && typeof legacy === 'object') {
        return { raw: legacy, file: LEGACY_TIMING_FILE, meta: extractActionMeta(legacy) };
    }
    return { raw: null, file: null, meta: {} };
}

async function loadTiming(actionDir, frameNames) {
    const config = await readActionConfigFile(actionDir);
    const timing = buildTiming(frameNames, config.raw);
    return {
        ...timing,
        ...config.meta,
        exists: config.raw !== null,
        file: config.file || null,
    };
}

/**
 * 写入动作 config.json。
 * - `frameMultipliers` 归一后只保留非 1 覆盖项；
 * - `meta` 缺省时保留目录内已有 config.json 的元数据；
 * - 返回结构与 loadTiming 对齐，便于调用方直接回传前端。
 */
async function writeActionConfig(directory, frameNames, { frameMultipliers, meta } = {}) {
    const existing = await readActionConfigFile(directory);
    const mergedMeta = { ...(existing.meta || {}) };
    if (meta && typeof meta === 'object') {
        for (const key of ACTION_META_KEYS) {
            if (meta[key] !== undefined && meta[key] !== null) mergedMeta[key] = meta[key];
        }
        if (typeof meta.id === 'string' && meta.id.trim()) mergedMeta.id = meta.id.trim();
    }
    const normalized = buildTiming(frameNames, { frameMultipliers });
    const payload = {
        schemaVersion: ACTION_CONFIG_SCHEMA_VERSION,
    };
    if (mergedMeta.id) payload.id = mergedMeta.id;
    if (mergedMeta.label !== undefined) payload.label = String(mergedMeta.label).trim().slice(0, 40);
    if (mergedMeta.description !== undefined) payload.description = normalizeDescription(mergedMeta.description);
    if (mergedMeta.fps !== undefined) {
        let fps = Number(mergedMeta.fps);
        if (!Number.isFinite(fps)) fps = 12;
        payload.fps = Math.max(1, Math.min(60, Math.round(fps)));
    }
    if (mergedMeta.loop !== undefined) payload.loop = mergedMeta.loop === true;
    if (mergedMeta.note !== undefined) payload.note = String(mergedMeta.note).trim().slice(0, 240);
    payload.baseFps = TIMING_BASE_FPS;
    payload.frameMultipliers = normalized.overrides;
    payload.updatedAt = isoNow();
    await writeJsonAtomic(path.join(directory, ACTION_CONFIG_FILE), payload);
    return {
        ...normalized,
        ...extractActionMeta(payload),
        exists: true,
        file: ACTION_CONFIG_FILE,
    };
}

// ────────────────────────────── 配置与清单 ──────────────────────────────

let manifestQueue = Promise.resolve();

function withManifestLock(task) {
    const run = manifestQueue.then(task, task);
    manifestQueue = run.catch(() => {});
    return run;
}

async function loadManifest() {
    const manifest = await readJsonFile(MANIFEST_PATH);
    if (!manifest || !Array.isArray(manifest.avatars)) {
        fail('资产清单格式错误：缺少 avatars 数组', 500);
    }
    return manifest;
}

async function saveManifest(manifest) {
    manifest.updatedAt = isoNow();
    await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
    const backupDir = path.join(TRASH_ROOT, 'manifest');
    await fs.mkdir(backupDir, { recursive: true });
    if (await pathExists(MANIFEST_PATH)) {
        await fs.copyFile(MANIFEST_PATH, path.join(backupDir, `manifest-${timestampLabel()}.json`));
    }
    await writeJsonAtomic(MANIFEST_PATH, manifest);
}

function findAvatar(manifest, avatarId) {
    const avatar = (manifest.avatars || []).find((item) => item.id === avatarId);
    if (!avatar) fail(`形象不存在：${avatarId}`, 404);
    return avatar;
}

function findAction(avatar, actionId) {
    const action = (avatar.actions || []).find((item) => item.id === actionId);
    if (!action) fail(`动作不存在：${actionId}`, 404);
    return action;
}

function isRuntimeAction(actionId) {
    return RUNTIME_ACTIONS.includes(actionId);
}

// ────────────────────────────── 资产扫描 ──────────────────────────────

const hashCache = new Map();

async function fileHash(filePath, stat) {
    const cached = hashCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.hash;
    }
    const buffer = await fs.readFile(filePath);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    hashCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
    return hash;
}

async function listFrameDetails(directory) {
    let entries;
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    const names = sortFrameNames(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    const details = [];
    for (const name of names) {
        const filePath = path.join(directory, name);
        const stat = await fs.stat(filePath);
        details.push({
            name,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            hash: await fileHash(filePath, stat),
        });
    }
    return details;
}

async function listFrameNames(directory) {
    return (await listFrameDetails(directory)).map((frame) => frame.name);
}

async function scanLibrary() {
    const manifest = await loadManifest();
    const avatars = [];

    for (const avatarMeta of manifest.avatars || []) {
        const avatarId = avatarMeta.id;
        const avatarDir = path.join(LIBRARY_ROOT, avatarId);
        const actions = [];

        for (const actionMeta of avatarMeta.actions || []) {
            const actionDir = path.join(avatarDir, actionMeta.id);
            const frames = await listFrameDetails(actionDir);
            const frameNames = frames.map((frame) => frame.name);
            const timing = await loadTiming(actionDir, frameNames);
            const configMeta = {};
            for (const key of ACTION_META_KEYS) {
                if (timing[key] !== undefined) configMeta[key] = timing[key];
            }
            const totalBytes = frames.reduce((sum, frame) => sum + frame.size, 0);
            const multiplierTotal = timing.frameMultipliers.reduce((sum, value) => sum + value, 0);

            actions.push({
                ...actionMeta,
                ...configMeta,
                runtime: isRuntimeAction(actionMeta.id),
                frameCount: frames.length,
                totalBytes,
                avgBytes: frames.length ? Math.round(totalBytes / frames.length) : 0,
                durationMs: Math.round((multiplierTotal * 1000) / timing.baseFps),
                timing,
                configFile: timing.file,
                frames,
            });
        }

        avatars.push({
            ...avatarMeta,
            actions,
            thumbnailUrl: actionMetaThumbnail(avatarMeta),
        });
    }

    return {
        manifest: {
            schemaVersion: manifest.schemaVersion,
            updatedAt: manifest.updatedAt,
            library: manifest.library,
        },
        libraryRoot: LIBRARY_ROOT,
        trashRoot: TRASH_ROOT,
        runtimeActions: RUNTIME_ACTIONS.slice(),
        frame: {
            width: runtime.frameWidth,
            height: runtime.frameHeight,
            format: 'webp',
            naming: 'frame_%03d.webp',
        },
        avatars,
    };
}

function actionMetaThumbnail(avatarMeta) {
    const thumbnail = avatarMeta.thumbnail || '';
    if (!thumbnail) {
        const firstAction = (avatarMeta.actions || [])[0];
        return firstAction ? `${avatarMeta.id}/${firstAction.id}/frame_000.webp` : '';
    }
    return `${avatarMeta.id}/${thumbnail}`;
}

// ────────────────────────────── 帧写入 ──────────────────────────────

function decodeWebpDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') fail('缺少帧数据');
    const match = /^data:image\/webp;base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
    if (!match) fail('仅支持 image/webp data URL（请由工作台转换后上传）');
    const buffer = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
    if (buffer.length < 16 || buffer.length > MAX_FRAME_BYTES) {
        fail(`单帧大小超出范围：${buffer.length} 字节`);
    }
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
        fail('帧数据不是合法 WebP');
    }
    return buffer;
}

async function createStagingDir(label) {
    const dir = path.join(STAGING_ROOT, `${timestampLabel()}-${label}-${crypto.randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

async function swapDirectory(targetDir, stagingDir, backupRoot, label) {
    const backupDir = path.join(backupRoot, timestampLabel(), `${label}-${crypto.randomUUID().slice(0, 8)}`);
    await fs.mkdir(path.dirname(backupDir), { recursive: true });
    let movedOld = false;
    try {
        if (await pathExists(targetDir)) {
            await movePath(targetDir, backupDir);
            movedOld = true;
        }
    } catch (error) {
        await fs.rm(stagingDir, { recursive: true, force: true });
        throw error;
    }
    try {
        await fs.mkdir(path.dirname(targetDir), { recursive: true });
        await movePath(stagingDir, targetDir);
    } catch (error) {
        if (movedOld) {
            try {
                await fs.rm(targetDir, { recursive: true, force: true });
                await movePath(backupDir, targetDir);
            } catch (_restoreError) {
                /* 保留备份，交给人工恢复 */
            }
        }
        throw error;
    }
    return backupDir;
}

async function writeFramesToStaging(buffers, stagingDir, startIndex = 0) {
    await fs.mkdir(stagingDir, { recursive: true });
    for (let index = 0; index < buffers.length; index += 1) {
        const target = path.join(stagingDir, `frame_${String(startIndex + index).padStart(3, '0')}.webp`);
        await fs.writeFile(target, buffers[index]);
    }
}

async function touchManifest() {
    await withManifestLock(async () => {
        const manifest = await loadManifest();
        await saveManifest(manifest);
    });
}

// ────────────────────────────── 绿幕视频流水线 ──────────────────────────────

const pipelineJobs = new Map();
let activePipelineJobId = null;
let pythonRuntimePromise = null;

const PIPELINE_STAGE_RULES = [
    { match: '读取素材', label: '读取视频', progress: 6 },
    { match: '解码得到', label: '解码与色键分析', progress: 18 },
    { match: '选窗:', label: '选择动作窗口', progress: 32 },
    { match: '渲染 ', label: '统一画布渲染', progress: 52 },
    { match: '循环接缝', label: '检查循环接缝', progress: 66 },
    { match: '写库:', label: '写入资产库', progress: 80 },
    { match: 'manifest 已更新', label: '更新资产清单', progress: 88 },
];

function appendPipelineLog(job, line) {
    const text = String(line || '').replace(/\s+$/, '');
    if (!text) return;
    job.log.push(text);
    if (job.log.length > PIPELINE_LOG_LIMIT) {
        job.log.splice(0, job.log.length - PIPELINE_LOG_LIMIT);
    }
    if (text.startsWith('SEQ_PIPELINE_RESULT=')) {
        try {
            job.result = JSON.parse(text.slice('SEQ_PIPELINE_RESULT='.length));
        } catch (_error) {
            /* JSON 解析失败时保留原始日志，退出码兜底 */
        }
    }
    const rule = PIPELINE_STAGE_RULES.find((item) => text.includes(item.match));
    if (rule && job.status === 'running') {
        job.stage = rule.label;
        job.progress = Math.max(job.progress, rule.progress);
    }
}

/** 把子进程的 stdout/stderr 分块数据切成行，避免半行被当成完整日志 */
function createStreamLineReader(onLine) {
    let buffer = '';
    return {
        push(chunk) {
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) onLine(line);
        },
        flush() {
            if (buffer) onLine(buffer);
            buffer = '';
        },
    };
}

function createLineReader(job) {
    return createStreamLineReader((line) => appendPipelineLog(job, line));
}

/** 读取工作台保存的解释器配置（pipeline.env.json） */
async function readPythonConfig() {
    try {
        const raw = await fs.readFile(PYTHON_CONFIG_PATH, 'utf8');
        const data = JSON.parse(raw);
        return { pythonPath: typeof data?.pythonPath === 'string' ? data.pythonPath : '' };
    } catch (_error) {
        return { pythonPath: '' };
    }
}

async function writePythonConfig(patch) {
    const current = await readPythonConfig();
    const next = { ...current, ...patch };
    await fs.writeFile(PYTHON_CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
}

function comparePythonDirName(a, b) {
    const parse = (name) => (name.match(/\d+/g) || []).map(Number);
    const left = parse(a);
    const right = parse(b);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const diff = (right[index] || 0) - (left[index] || 0);
        if (diff) return diff;
    }
    return 0;
}

/** ZHILING 桌面端自带的嵌入式 Python（通常已带 cv2 / numpy / Pillow），作为兜底候选 */
async function findEmbeddedPython() {
    const root = path.join(os.homedir(), '.zhiling');
    let entries = [];
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch (_error) {
        return '';
    }
    const dirs = entries
        .filter((entry) => entry.isDirectory() && /^python-\d+\.\d+\.\d+-embed/i.test(entry.name))
        .map((entry) => entry.name)
        .sort(comparePythonDirName);
    for (const name of dirs) {
        const candidate = process.platform === 'win32'
            ? path.join(root, name, 'python.exe')
            : path.join(root, name, 'bin', 'python3');
        if (await pathExists(candidate)) return candidate;
    }
    return '';
}

/**
 * 候选解释器，按优先级：
 * SEQ_PYTHON → 工作台指定 → 本地 .venv → ZHILING 内置 → 系统 python / py -3
 * （不依赖启动时的 PATH，避免从资源管理器双击启动时找不到带依赖的 Python）
 */
async function pythonCandidates() {
    const list = [];
    const seen = new Set();
    const push = (command, args, origin) => {
        if (!command) return;
        const key = `${command}\u0000${args.join(' ')}`.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        list.push({ command, args, origin });
    };
    if (process.env.SEQ_PYTHON) push(process.env.SEQ_PYTHON, [], 'env');
    const config = await readPythonConfig();
    if (config.pythonPath) push(config.pythonPath, [], 'config');
    if (await pathExists(VENV_PYTHON)) push(VENV_PYTHON, [], 'venv');
    const embedded = await findEmbeddedPython();
    if (embedded) push(embedded, [], 'embedded');
    if (process.platform === 'win32') {
        push('python', [], 'system');
        push('py', ['-3'], 'system');
    } else {
        push('python3', [], 'system');
        push('python', [], 'system');
    }
    return list;
}

function candidateLabel(candidate) {
    return [candidate.command, ...candidate.args].join(' ');
}

/** 解析 check_env.py 输出的单行 JSON（容忍前置日志行） */
function parseProbeOutput(text) {
    const lines = String(text || '').trim().split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line.startsWith('{')) continue;
        try {
            return JSON.parse(line);
        } catch (_error) {
            /* 继续尝试上一行 */
        }
    }
    return null;
}

function describeMissing(missing) {
    const list = Array.isArray(missing) ? missing.filter((item) => item?.module !== 'python') : [];
    if (!list.length) return '';
    return `缺少 ${list.map((item) => item.package || item.module).join('、')}`;
}

/** 探测一个 Python 解释器是否具备流水线依赖（opencv / numpy / Pillow） */
function probePython(candidate, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(result);
        };
        const failed = (error) => finish({
            ok: false,
            executable: '',
            version: '',
            missing: [],
            error: error || '不可用',
        });
        let child;
        try {
            child = spawn(candidate.command, [...candidate.args, ENV_CHECK_SCRIPT], {
                cwd: TOOL_DIR,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
            });
        } catch (error) {
            failed(error.message);
            return;
        }
        let stdout = '';
        let stderr = '';
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => {
            if (stdout.length < 8000) stdout += chunk;
        });
        child.stderr?.on('data', (chunk) => {
            if (stderr.length < 8000) stderr += chunk;
        });
        child.on('error', (error) => failed(error.message));
        child.on('close', (code) => {
            const parsed = parseProbeOutput(stdout);
            if (parsed) {
                const missing = Array.isArray(parsed.missing) ? parsed.missing : [];
                finish({
                    ok: parsed.ok === true,
                    executable: parsed.executable || '',
                    version: parsed.version || '',
                    missing,
                    error: parsed.ok === true ? '' : (describeMissing(missing) || '依赖不完整'),
                });
                return;
            }
            failed(stderr.trim() || stdout.trim() || `退出码 ${code}`);
        });
        timer = setTimeout(() => {
            try {
                child.kill();
            } catch (_error) {
                /* ignore */
            }
            failed('检测超时');
        }, timeoutMs);
        timer.unref?.();
    });
}

async function resolvePythonRuntime() {
    if (!pythonRuntimePromise) {
        pythonRuntimePromise = (async () => {
            const attempts = [];
            for (const candidate of await pythonCandidates()) {
                if (path.isAbsolute(candidate.command) && !(await pathExists(candidate.command))) {
                    continue;
                }
                const label = candidateLabel(candidate);
                const result = await probePython(candidate);
                attempts.push({
                    label,
                    origin: candidate.origin,
                    ok: result.ok === true,
                    executable: result.executable || '',
                    version: result.version || '',
                    missing: result.missing || [],
                    error: result.error || '',
                });
                if (result.ok) {
                    return {
                        ...candidate,
                        label,
                        executable: result.executable || '',
                        version: result.version || '',
                        missing: [],
                        attempts,
                    };
                }
            }
            const detail = attempts.length
                ? attempts.map((item) => {
                    const reason = item.ok
                        ? 'ok'
                        : (describeMissing(item.missing) || item.error || '不可用');
                    const where = item.executable ? `（${item.executable}）` : '';
                    return `- ${item.label}${where}：${reason}`;
                }).join('\n')
                : '- 无候选命令';
            return {
                command: null,
                args: [],
                label: '',
                executable: '',
                version: '',
                origin: '',
                missing: [],
                error: `未找到可用的 Python（需要 Python 3.10+ 以及 opencv-python / numpy / Pillow）。已尝试：\n${detail}`,
                attempts,
            };
        })();
    }
    return await pythonRuntimePromise;
}

function resetPythonRuntime() {
    pythonRuntimePromise = null;
}

function publicPythonInfo(python) {
    return {
        available: Boolean(python?.command),
        command: python?.label || '',
        executable: python?.executable || '',
        version: python?.version || '',
        origin: python?.origin || '',
        originLabel: PYTHON_ORIGIN_LABELS[python?.origin] || '',
        error: python?.error || '',
        missing: python?.missing || [],
        candidates: (python?.attempts || []).map((item) => ({
            label: item.label,
            origin: item.origin,
            originLabel: PYTHON_ORIGIN_LABELS[item.origin] || '',
            ok: item.ok,
            executable: item.executable || '',
            version: item.version || '',
            missing: item.missing || [],
            error: item.error || '',
        })),
    };
}

// ────────────────────── Python 依赖安装（本工具目录 .venv） ──────────────────────

const setupJobs = new Map();
let activeSetupJobId = null;

const SETUP_STAGE_RULES = [
    { match: '创建虚拟环境', label: '创建虚拟环境', progress: 10 },
    { match: '虚拟环境已就绪', label: '安装依赖', progress: 30 },
    { match: 'Collecting ', label: '下载依赖', progress: 45 },
    { match: 'Installing collected packages', label: '安装依赖', progress: 80 },
    { match: 'Successfully installed', label: '安装完成', progress: 92 },
    { match: '验证依赖', label: '验证依赖', progress: 96 },
];

/** 子进程统一环境：避免 Windows 控制台编码问题 */
function childEnv() {
    return {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        PYTHONUTF8: '1',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
    };
}

function appendSetupLog(job, line) {
    const text = String(line || '').replace(/\s+$/, '');
    if (!text) return;
    job.log.push(text);
    if (job.log.length > PIPELINE_LOG_LIMIT) {
        job.log.splice(0, job.log.length - PIPELINE_LOG_LIMIT);
    }
    const rule = SETUP_STAGE_RULES.find((item) => text.includes(item.match));
    if (rule && job.status === 'running') {
        job.stage = rule.label;
        job.progress = Math.max(job.progress, rule.progress);
    }
}

function finishSetupJob(job, status, patch = {}) {
    if (job.status !== 'running') return;
    job.status = status;
    Object.assign(job, patch);
    job.finishedAt = isoNow();
    job.finishedAtMs = Date.now();
    if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
    }
    if (activeSetupJobId === job.id) activeSetupJobId = null;
    job.child = null;
    resetPythonRuntime();
}

function publicSetupJob(job) {
    if (!job) return null;
    return {
        id: job.id,
        status: job.status,
        stage: job.stage,
        progress: Math.round(job.progress),
        log: job.log.slice(-160),
        result: job.result,
        error: job.error,
        basePython: job.basePython || '',
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
    };
}

function trimSetupJobs() {
    if (setupJobs.size <= SETUP_JOB_LIMIT) return;
    const finished = [...setupJobs.values()]
        .filter((job) => job.status !== 'running')
        .sort((a, b) => a.createdAtMs - b.createdAtMs);
    while (setupJobs.size > SETUP_JOB_LIMIT && finished.length) {
        setupJobs.delete(finished.shift().id);
    }
}

/** 检查某解释器能否创建 venv（嵌入式 Python 通常没有 venv 模块） */
function probeVenvCapable(candidate) {
    return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const finish = (ok, error) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve({ ok, error: error || '' });
        };
        let child;
        try {
            child = spawn(candidate.command, [...candidate.args, '-c', 'import venv, ensurepip'], {
                cwd: TOOL_DIR,
                windowsHide: true,
                stdio: ['ignore', 'ignore', 'pipe'],
            });
        } catch (error) {
            finish(false, error.message);
            return;
        }
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk) => {
            if (stderr.length < 2000) stderr += chunk;
        });
        child.on('error', (error) => finish(false, error.message));
        child.on('close', (code) => finish(code === 0, stderr.trim() || `退出码 ${code}`));
        timer = setTimeout(() => {
            try {
                child.kill();
            } catch (_error) {
                /* ignore */
            }
            finish(false, '检测超时');
        }, 10000);
        timer.unref?.();
    });
}

async function pickVenvBase(preferred) {
    const list = [];
    const seen = new Set();
    const push = (command, args) => {
        if (!command) return;
        const key = `${command}\u0000${args.join(' ')}`.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        list.push({ command, args });
    };
    push(preferred, []);
    const config = await readPythonConfig();
    push(config.pythonPath, []);
    push(process.env.SEQ_PYTHON, []);
    if (process.platform === 'win32') {
        push('python', []);
        push('py', ['-3']);
    } else {
        push('python3', []);
        push('python', []);
    }
    const attempts = [];
    for (const candidate of list) {
        if (path.isAbsolute(candidate.command) && !(await pathExists(candidate.command))) continue;
        const result = await probeVenvCapable(candidate);
        attempts.push({ label: candidateLabel(candidate), error: result.error });
        if (result.ok) return { ...candidate, attempts };
    }
    return { command: null, args: [], attempts };
}

function runPipStep(job) {
    job.stage = '安装依赖';
    job.progress = 30;
    job.result = { ...(job.result || {}), venv: VENV_PYTHON };
    let child;
    try {
        child = spawn(VENV_PYTHON, ['-m', 'pip', 'install', '--no-input', '-r', REQUIREMENTS_PATH], {
            cwd: TOOL_DIR,
            windowsHide: true,
            env: childEnv(),
        });
    } catch (error) {
        finishSetupJob(job, 'error', { error: `无法运行 pip：${error.message}`, stage: '安装依赖失败' });
        return;
    }

    job.child = child;
    const stdoutReader = createStreamLineReader((line) => appendSetupLog(job, line));
    const stderrReader = createStreamLineReader((line) => appendSetupLog(job, line));
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => stdoutReader.push(chunk));
    child.stderr?.on('data', (chunk) => stderrReader.push(chunk));
    child.on('error', (error) => {
        finishSetupJob(job, 'error', { error: `无法运行 pip：${error.message}`, stage: '安装依赖失败' });
    });
    child.on('close', (code) => {
        stdoutReader.flush();
        stderrReader.flush();
        if (job.status !== 'running') return;
        if (code !== 0) {
            const message = job.log.slice(-6).join('\n');
            finishSetupJob(job, 'error', {
                error: `依赖安装失败（退出码 ${code}）${message ? `：\n${message}` : ''}`,
                stage: '安装依赖失败',
            });
            return;
        }
        void (async () => {
            appendSetupLog(job, '[工作台] 验证依赖…');
            job.stage = '验证依赖';
            job.progress = 96;
            const probe = await probePython({ command: VENV_PYTHON, args: [] });
            if (!probe.ok) {
                finishSetupJob(job, 'error', {
                    error: `依赖安装完成但验证失败：${describeMissing(probe.missing) || probe.error}`,
                    stage: '验证失败',
                });
                return;
            }
            job.result = {
                ...(job.result || {}),
                executable: probe.executable || VENV_PYTHON,
                version: probe.version || '',
            };
            appendSetupLog(job, `[工作台] Python ${probe.version} 依赖就绪：${probe.executable || VENV_PYTHON}`);
            finishSetupJob(job, 'done', { stage: '完成', progress: 100 });
        })();
    });
}

function runVenvStep(job, base) {
    job.stage = '创建虚拟环境';
    job.progress = 8;
    appendSetupLog(job, '[工作台] 创建虚拟环境…');
    let child;
    try {
        child = spawn(base.command, [...base.args, '-m', 'venv', '--clear', VENV_DIR], {
            cwd: TOOL_DIR,
            windowsHide: true,
            env: childEnv(),
        });
    } catch (error) {
        finishSetupJob(job, 'error', { error: `无法创建虚拟环境：${error.message}`, stage: '创建虚拟环境失败' });
        return;
    }

    job.child = child;
    const stdoutReader = createStreamLineReader((line) => appendSetupLog(job, line));
    const stderrReader = createStreamLineReader((line) => appendSetupLog(job, line));
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => stdoutReader.push(chunk));
    child.stderr?.on('data', (chunk) => stderrReader.push(chunk));
    child.on('error', (error) => {
        finishSetupJob(job, 'error', { error: `无法创建虚拟环境：${error.message}`, stage: '创建虚拟环境失败' });
    });
    child.on('close', (code) => {
        stdoutReader.flush();
        stderrReader.flush();
        if (job.status !== 'running') return;
        if (code !== 0) {
            finishSetupJob(job, 'error', {
                error: `创建虚拟环境失败（退出码 ${code}）`,
                stage: '创建虚拟环境失败',
            });
            return;
        }
        void (async () => {
            if (!(await pathExists(VENV_PYTHON))) {
                finishSetupJob(job, 'error', {
                    error: `虚拟环境创建完成，但找不到解释器：${VENV_PYTHON}`,
                    stage: '创建虚拟环境失败',
                });
                return;
            }
            appendSetupLog(job, '[工作台] 虚拟环境已就绪，开始安装依赖');
            runPipStep(job);
        })();
    });
}

function startSetupJob({ pythonPath } = {}) {
    if (activeSetupJobId) {
        fail('已有依赖安装任务正在运行，请等待完成或先停止', 409);
    }
    const job = {
        id: crypto.randomUUID(),
        status: 'running',
        stage: '准备安装依赖…',
        progress: 2,
        log: [],
        result: null,
        error: '',
        basePython: '',
        child: null,
        timer: null,
        createdAt: isoNow(),
        createdAtMs: Date.now(),
        finishedAt: '',
        finishedAtMs: 0,
    };
    setupJobs.set(job.id, job);
    activeSetupJobId = job.id;
    trimSetupJobs();

    job.timer = setTimeout(() => {
        appendSetupLog(job, '[工作台] 安装超时（10 分钟），正在终止…');
        try {
            job.child?.kill();
        } catch (_error) {
            /* ignore */
        }
        finishSetupJob(job, 'error', { error: '依赖安装超时（10 分钟）', stage: '安装超时' });
    }, SETUP_TIMEOUT_MS);
    job.timer.unref?.();

    void (async () => {
        const base = await pickVenvBase(pythonPath);
        if (job.status !== 'running') return;
        if (!base.command) {
            const detail = base.attempts.length
                ? base.attempts.map((item) => `- ${item.label}：${item.error || '不可用'}`).join('\n')
                : '- 无候选命令';
            appendSetupLog(job, '[工作台] 找不到可创建虚拟环境的 Python');
            finishSetupJob(job, 'error', {
                error: `找不到可创建 .venv 的 Python。已尝试：\n${detail}`,
                stage: '创建虚拟环境失败',
            });
            return;
        }
        job.basePython = candidateLabel(base);
        job.result = { ...(job.result || {}), basePython: job.basePython };
        appendSetupLog(job, `[工作台] 基础解释器：${job.basePython}`);
        appendSetupLog(job, `[工作台] 虚拟环境目录：${VENV_DIR}`);
        runVenvStep(job, base);
    })();

    return { ok: true, job: publicSetupJob(job) };
}

async function handleSetupJob(query) {
    const id = String(query.id || '');
    let job = id ? setupJobs.get(id) : null;
    if (!job && !id) {
        job = activeSetupJobId ? setupJobs.get(activeSetupJobId) : null;
        if (!job) {
            job = [...setupJobs.values()].sort((a, b) => b.createdAtMs - a.createdAtMs)[0] || null;
        }
    }
    if (!job) fail('安装任务不存在或已过期', 404);
    return { ok: true, job: publicSetupJob(job) };
}

function handleSetupCancel(body) {
    const id = String(body.id || activeSetupJobId || '');
    const job = setupJobs.get(id);
    if (!job) fail('安装任务不存在', 404);
    if (job.status !== 'running') return { ok: true, job: publicSetupJob(job) };

    job.status = 'cancelled';
    job.stage = '已取消';
    job.error = '已由用户取消';
    job.finishedAt = isoNow();
    job.finishedAtMs = Date.now();
    if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
    }
    try {
        job.child?.kill();
    } catch (_error) {
        /* ignore */
    }
    job.child = null;
    if (activeSetupJobId === job.id) activeSetupJobId = null;
    appendSetupLog(job, '[工作台] 已取消依赖安装');
    resetPythonRuntime();
    return { ok: true, job: publicSetupJob(job) };
}

async function handleSetPython(body) {
    const raw = String(body.path || '').trim().replace(/^"(.*)"$/, '$1');
    if (raw) {
        if (!path.isAbsolute(raw)) fail('请填写解释器的绝对路径');
        if (!(await pathExists(raw))) fail(`解释器不存在：${raw}`, 404);
        const stat = await fs.stat(raw);
        if (!stat.isFile()) fail(`不是可执行文件：${raw}`);
    }
    await writePythonConfig({ pythonPath: raw });
    resetPythonRuntime();
    const python = await resolvePythonRuntime();
    return { ok: true, python: publicPythonInfo(python) };
}

async function handleResetPythonEnv() {
    await writePythonConfig({ pythonPath: '' });
    resetPythonRuntime();
    return { ok: true, ...(await handlePipelineStatus()) };
}

function publicPipelineJob(job) {
    if (!job) return null;
    const endMs = job.finishedAtMs || Date.now();
    return {
        id: job.id,
        status: job.status,
        stage: job.stage,
        progress: Math.round(job.progress),
        log: job.log.slice(-160),
        result: job.result,
        error: job.error,
        avatarId: job.avatarId,
        actionId: job.actionId,
        label: job.label,
        mode: job.mode,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        durationMs: job.startedAtMs ? Math.max(0, endMs - job.startedAtMs) : 0,
    };
}

function finishPipelineJob(job, status, patch = {}) {
    if (job.status !== 'running') return;
    job.status = status;
    Object.assign(job, patch);
    job.finishedAt = isoNow();
    job.finishedAtMs = Date.now();
    if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
    }
    if (activePipelineJobId === job.id) activePipelineJobId = null;
    job.child = null;
}

function trimPipelineJobs() {
    if (pipelineJobs.size <= PIPELINE_JOB_LIMIT) return;
    const finished = [...pipelineJobs.values()]
        .filter((job) => job.status !== 'running')
        .sort((a, b) => a.createdAtMs - b.createdAtMs);
    while (pipelineJobs.size > PIPELINE_JOB_LIMIT && finished.length) {
        pipelineJobs.delete(finished.shift().id);
    }
}

function sanitizeUploadName(raw) {
    const base = path.basename(String(raw || 'video.mp4'))
        .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
        .trim();
    return (base || 'video.mp4').slice(-120);
}

function normalizeInt(value, fallback, min, max, label) {
    if (value === undefined || value === null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) fail(`${label}必须是数字`);
    return Math.round(Math.min(max, Math.max(min, number)));
}

function normalizeFloat(value, fallback, min, max, label) {
    if (value === undefined || value === null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) fail(`${label}必须是数字`);
    return Math.min(max, Math.max(min, number));
}

/** 接收原始视频字节，落到 .staging/uploads；不使用 multipart，避免额外依赖 */
async function handlePipelineUpload(req, rawName) {
    const name = sanitizeUploadName(rawName);
    const extension = path.extname(name).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(extension)) {
        fail('仅支持 mp4 / mov / webm / mkv / avi / m4v 视频');
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
        fail(`视频超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`, 413);
    }

    await fs.mkdir(UPLOAD_ROOT, { recursive: true });
    const id = `${timestampLabel()}-${crypto.randomUUID().slice(0, 8)}${extension}`;
    const target = path.join(UPLOAD_ROOT, id);
    const stream = createWriteStream(target);
    let size = 0;

    try {
        await new Promise((resolve, reject) => {
            let settled = false;
            const done = (error) => {
                if (settled) return;
                settled = true;
                if (error) reject(error);
                else resolve();
            };
            req.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_UPLOAD_BYTES) {
                    stream.destroy();
                    req.destroy();
                    done(new HttpError(413, `视频超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`));
                    return;
                }
                if (!stream.write(chunk)) {
                    req.pause();
                    stream.once('drain', () => req.resume());
                }
            });
            req.on('end', () => stream.end());
            req.on('error', (error) => done(error));
            stream.on('error', (error) => done(error));
            stream.on('finish', () => done());
        });
    } catch (error) {
        stream.destroy();
        await fs.rm(target, { force: true }).catch(() => {});
        throw error;
    }

    if (!size) {
        await fs.rm(target, { force: true }).catch(() => {});
        fail('上传的视频为空');
    }
    return { ok: true, upload: { id, name, size } };
}

async function handlePipelineStatus() {
    const python = await resolvePythonRuntime();
    return {
        ok: true,
        python: publicPythonInfo(python),
        venv: {
            dir: VENV_DIR,
            python: VENV_PYTHON,
            exists: await pathExists(VENV_PYTHON),
        },
        requirements: {
            path: REQUIREMENTS_PATH,
            exists: await pathExists(REQUIREMENTS_PATH),
        },
        envConfigPath: PYTHON_CONFIG_PATH,
        setupJobId: activeSetupJobId,
        activeJobId: activePipelineJobId,
        defaults: {
            canvas: [runtime.frameWidth, runtime.frameHeight],
            fps: TIMING_BASE_FPS,
            frames: 36,
            quality: 82,
            method: 4,
            maxFrames: 240,
        },
        maxUploadBytes: MAX_UPLOAD_BYTES,
        uploadRoot: path.relative(LIBRARY_ROOT, UPLOAD_ROOT).replaceAll('\\', '/'),
    };
}

async function handlePipelineRun(body) {
    const avatarId = assertId(body.avatar, '形象 id');
    const actionId = assertId(body.action, '动作 id');
    if (activePipelineJobId) {
        fail('已有生成任务正在运行，请等待完成或先停止', 409);
    }

    const mode = body.mode === 'replace' ? 'replace' : (body.mode === 'new' || !body.mode ? 'new' : null);
    if (!mode) fail('处理方式只能是 new 或 replace');

    const manifest = await loadManifest();
    const avatar = findAvatar(manifest, avatarId);
    const existing = (avatar.actions || []).find((item) => item.id === actionId) || null;
    const existingFrames = await listFrameNames(path.join(LIBRARY_ROOT, avatarId, actionId));

    if (mode === 'new') {
        if (existing) {
            fail(`动作 ${actionId} 已存在；请换一个动作 ID，或选择「替换当前动作」`, 409);
        }
        if (existingFrames.length) {
            fail(`动作目录 ${avatarId}/${actionId} 已有帧但未登记清单；请换一个动作 ID`, 409);
        }
    } else if (!existing) {
        fail(`动作 ${actionId} 不在资产清单中，无法替换`, 404);
    }

    const runtimeAction = isRuntimeAction(actionId);
    const loop = runtimeAction ? actionId === 'idle' : body.loop === true;
    const fps = runtimeAction
        ? TIMING_BASE_FPS
        : normalizeFloat(body.fps, 12, 1, 60, '帧率');
    const frames = normalizeInt(body.frames, 36, 2, 240, '帧数');
    const maxFrames = normalizeInt(body.maxFrames, Math.max(240, frames), 2, 600, '最多解码帧数');
    if (maxFrames < frames) fail('最多解码帧数不能小于目标帧数');
    const canvasWidth = normalizeInt(body.canvasWidth, runtime.frameWidth, 64, 4096, '画布宽度');
    const canvasHeight = normalizeInt(body.canvasHeight, runtime.frameHeight, 64, 4096, '画布高度');
    const footLine = normalizeInt(body.footLine, 980, 0, canvasHeight * 2, '脚底基准 y');
    const targetHeight = normalizeInt(body.targetHeight, 800, 32, canvasHeight * 2, '角色目标高度');
    const margin = normalizeInt(body.margin, 24, 0, Math.floor(canvasWidth / 2), '左右安全边距');
    const quality = normalizeInt(body.quality, 82, 0, 100, 'WebP 质量');
    const method = normalizeInt(body.method, 4, 0, 6, 'WebP method');
    const windowStart = body.windowStart === undefined || body.windowStart === null || body.windowStart === ''
        ? null
        : normalizeInt(body.windowStart, 0, 0, 10000, '窗口起始帧');
    const start = normalizeFloat(body.start, null, 0, 3600, '起始秒');
    const end = normalizeFloat(body.end, null, 0, 3600, '结束秒');
    if (start !== null && end !== null && end <= start) {
        fail('结束秒必须大于起始秒');
    }

    const uploadId = String(body.uploadId || '');
    if (!uploadId || uploadId.includes('..') || path.basename(uploadId) !== uploadId) {
        fail('上传标识非法');
    }
    const videoPath = path.join(UPLOAD_ROOT, uploadId);
    const relative = path.relative(UPLOAD_ROOT, videoPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) fail('上传路径越界', 403);
    if (!(await pathExists(videoPath))) {
        fail('上传的视频已不存在，请重新选择文件', 404);
    }

    const python = await resolvePythonRuntime();
    if (!python.command) fail(python.error, 503);

    const videoName = sanitizeUploadName(body.videoName || uploadId);
    const label = String(body.label || actionId).trim().slice(0, 40) || actionId;
    const description = normalizeDescription(body.description);
    const hasDescription = body.description !== undefined;
    const note = `由绿幕视频生成：${videoName}；${frames} 帧 @ ${fps}fps。`;

    const args = [
        PIPELINE_LAUNCHER,
        '--video', videoPath,
        '--avatar', avatarId,
        '--action', actionId,
        '--label', label,
        '--note', note,
        '--fps', String(fps),
        '--frames', String(frames),
        '--max-frames', String(maxFrames),
        '--canvas', `${canvasWidth}x${canvasHeight}`,
        '--foot-line', String(footLine),
        '--target-height', String(targetHeight),
        '--margin', String(margin),
        '--quality', String(quality),
        '--method', String(method),
        '--library-root', LIBRARY_ROOT,
        '--json',
        loop ? '--loop' : '--no-loop',
    ];
    if (hasDescription) args.push('--description', description);
    if (windowStart !== null) args.push('--window-start', String(windowStart));
    if (start !== null) args.push('--start', String(start));
    if (end !== null) args.push('--end', String(end));

    let child;
    try {
        child = spawn(python.command, [...python.args, ...args], {
            cwd: TOOL_DIR,
            windowsHide: true,
            env: {
                ...process.env,
                PYTHONIOENCODING: 'utf-8',
                PYTHONUNBUFFERED: '1',
                PYTHONUTF8: '1',
            },
        });
    } catch (error) {
        fail(`无法启动 Python：${error.message}`, 500);
    }

    const job = {
        id: crypto.randomUUID(),
        status: 'running',
        stage: '启动 Python 流水线…',
        progress: 2,
        log: [],
        result: null,
        error: '',
        avatarId,
        actionId,
        label,
        mode,
        createdAt: isoNow(),
        createdAtMs: Date.now(),
        startedAt: isoNow(),
        startedAtMs: Date.now(),
        finishedAt: '',
        finishedAtMs: 0,
        child,
        timer: null,
    };

    pipelineJobs.set(job.id, job);
    activePipelineJobId = job.id;
    trimPipelineJobs();

    const stdoutReader = createLineReader(job);
    const stderrReader = createLineReader(job);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => stdoutReader.push(chunk));
    child.stderr?.on('data', (chunk) => stderrReader.push(chunk));
    child.on('error', (error) => {
        finishPipelineJob(job, 'error', {
            error: `无法启动 Python：${error.message}`,
            stage: '启动失败',
        });
    });
    child.on('close', (code) => {
        stdoutReader.flush();
        stderrReader.flush();
        if (job.status !== 'running') return;
        if (code === 0 && job.result && job.result.ok) {
            job.stage = '完成';
            job.progress = 100;
            finishPipelineJob(job, 'done');
            return;
        }
        const message = job.result && job.result.error
            ? job.result.error
            : `Python 退出码 ${code}，请查看生成日志`;
        finishPipelineJob(job, 'error', { error: message, stage: '生成失败' });
    });

    job.timer = setTimeout(() => {
        appendPipelineLog(job, '[工作台] 生成超时（15 分钟），正在终止 Python…');
        try {
            job.child?.kill();
        } catch (_error) {
            /* ignore */
        }
        finishPipelineJob(job, 'error', { error: '生成超时（15 分钟）', stage: '生成超时' });
    }, PIPELINE_TIMEOUT_MS);
    job.timer.unref?.();

    return { ok: true, job: publicPipelineJob(job) };
}

async function handlePipelineJob(query) {
    const id = String(query.id || '');
    let job = id ? pipelineJobs.get(id) : null;
    if (!job && !id) {
        job = activePipelineJobId ? pipelineJobs.get(activePipelineJobId) : null;
        if (!job) {
            job = [...pipelineJobs.values()].sort((a, b) => b.createdAtMs - a.createdAtMs)[0] || null;
        }
    }
    if (!job) fail('任务不存在或已过期', 404);
    return { ok: true, job: publicPipelineJob(job) };
}

async function handlePipelineCancel(body) {
    const id = String(body.id || activePipelineJobId || '');
    const job = pipelineJobs.get(id);
    if (!job) fail('任务不存在', 404);
    if (job.status !== 'running') return { ok: true, job: publicPipelineJob(job) };

    job.status = 'cancelled';
    job.stage = '已取消';
    job.error = '已由用户取消';
    job.finishedAt = isoNow();
    job.finishedAtMs = Date.now();
    if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
    }
    try {
        job.child?.kill();
    } catch (_error) {
        /* ignore */
    }
    job.child = null;
    if (activePipelineJobId === job.id) activePipelineJobId = null;
    appendPipelineLog(job, '[工作台] 已取消生成任务');
    return { ok: true, job: publicPipelineJob(job) };
}

/** 清理超过 48h 的临时上传，避免 .staging/uploads 越积越多 */
async function cleanupUploads() {
    await fs.mkdir(UPLOAD_ROOT, { recursive: true });
    try {
        const entries = await fs.readdir(UPLOAD_ROOT);
        const now = Date.now();
        for (const name of entries) {
            const filePath = path.join(UPLOAD_ROOT, name);
            try {
                const stat = await fs.stat(filePath);
                if (stat.isFile() && now - stat.mtimeMs > 48 * 3600 * 1000) {
                    await fs.rm(filePath, { force: true });
                }
            } catch (_error) {
                /* 单个文件失败不影响启动 */
            }
        }
    } catch (_error) {
        /* 上传目录不可读时忽略 */
    }
}

// ────────────────────────────── API 处理 ──────────────────────────────

async function handleLibrary() {
    return await scanLibrary();
}

async function handleActionMeta(body) {
    const avatarId = assertId(body.avatar, '形象 id');
    const actionId = assertId(body.action, '动作 id');
    return await withManifestLock(async () => {
        const manifest = await loadManifest();
        const avatar = findAvatar(manifest, avatarId);
        const action = findAction(avatar, actionId);
        const label = String(body.label ?? action.label ?? actionId).trim().slice(0, 40);
        const note = String(body.note ?? action.note ?? '').trim().slice(0, 240);
        const description = normalizeDescription(body.description ?? action.description ?? '');
        let fps = Number(body.fps ?? action.fps ?? 12);
        if (!Number.isFinite(fps)) fps = 12;
        fps = Math.max(1, Math.min(60, Math.round(fps)));
        let loop = body.loop === undefined ? action.loop === true : body.loop === true;

        if (isRuntimeAction(actionId)) {
            fps = 12;
            loop = actionId === 'idle';
        }

        action.label = label || actionId;
        action.description = description;
        action.note = note;
        action.fps = fps;
        action.loop = loop;

        // 动作目录存在时，把元数据同步写入目录内 config.json（动作级真源）。
        const actionDir = path.join(LIBRARY_ROOT, avatarId, actionId);
        if (await pathExists(actionDir)) {
            const frames = await listFrameNames(actionDir);
            const timing = await loadTiming(actionDir, frames);
            await writeActionConfig(actionDir, frames, {
                frameMultipliers: timing.frameMultipliers,
                meta: action,
            });
        }

        await saveManifest(manifest);
        return { ok: true, action: { ...action } };
    });
}

async function handleActionTiming(body) {
    const avatarId = assertId(body.avatar, '形象 id');
    const actionId = assertId(body.action, '动作 id');
    const manifest = await loadManifest();
    const avatar = findAvatar(manifest, avatarId);
    const action = findAction(avatar, actionId);

    const actionDir = path.join(LIBRARY_ROOT, avatarId, actionId);
    const frames = await listFrameNames(actionDir);
    const raw = body.frameMultipliers;
    let values;
    if (Array.isArray(raw)) {
        if (raw.length !== frames.length) {
            fail(`帧时长数量（${raw.length}）与帧数（${frames.length}）不一致`);
        }
        values = raw;
    } else if (raw && typeof raw === 'object') {
        values = frames.map((name) => raw[name]);
    } else {
        fail('缺少 frameMultipliers');
    }
    const timing = await writeActionConfig(actionDir, frames, {
        frameMultipliers: values,
        meta: action,
    });
    return { ok: true, timing: { ...timing, exists: true, file: ACTION_CONFIG_FILE } };
}

async function handleActionCreate(body) {
    const avatarId = assertId(body.avatar, '形象 id');
    const actionId = assertId(body.action, '动作 id');
    return await withManifestLock(async () => {
        const manifest = await loadManifest();
        const avatar = findAvatar(manifest, avatarId);
        if ((avatar.actions || []).some((item) => item.id === actionId)) {
            fail(`动作已存在：${actionId}`, 409);
        }
        const actionDir = path.join(LIBRARY_ROOT, avatarId, actionId);
        await fs.mkdir(actionDir, { recursive: true });
        const runtimeAction = isRuntimeAction(actionId);
        const action = {
            id: actionId,
            label: String(body.label || actionId).trim().slice(0, 40) || actionId,
            description: normalizeDescription(body.description),
            loop: runtimeAction ? actionId === 'idle' : body.loop === true,
            fps: runtimeAction ? 12 : Math.max(1, Math.min(60, Math.round(Number(body.fps) || 12))),
            runtime: runtimeAction,
            note: String(body.note || '').trim().slice(0, 240),
        };
        await writeActionConfig(actionDir, [], { frameMultipliers: [], meta: action });
        avatar.actions = avatar.actions || [];
        avatar.actions.push(action);
        await saveManifest(manifest);
        return { ok: true, action };
    });
}

async function handleFramesInsert(body) {
    const avatarId = assertId(body.avatar, '形象 id');
    const actionId = assertId(body.action, '动作 id');
    const frames = Array.isArray(body.frames) ? body.frames : [];
    if (!frames.length) fail('没有待插入的帧');
    if (frames.length > 200) fail('单次最多插入 200 帧');
    const index = Number.isFinite(Number(body.index)) ? Math.max(0, Math.round(Number(body.index))) : 0;

    const manifest = await loadManifest();
    const avatar = findAvatar(manifest, avatarId);
    const action = findAction(avatar, actionId);

    const actionDir = path.join(LIBRARY_ROOT, avatarId, actionId);
    const current = await listFrameNames(actionDir);
    const currentTiming = await loadTiming(actionDir, current);
    const insertAt = Math.min(index, current.length);
    const buffers = frames.map((frame) => decodeWebpDataUrl(frame?.dataUrl));
    const rawMultipliers = Array.isArray(body.multipliers) ? body.multipliers : [];
    if (rawMultipliers.length && rawMultipliers.length !== buffers.length) {
        fail('插入帧的时长倍数数量与帧数不一致');
    }
    const insertedMultipliers = buffers.map((_buffer, offset) => normalizeMultiplier(rawMultipliers[offset]));
    const nextMultipliers = [
        ...currentTiming.frameMultipliers.slice(0, insertAt),
        ...insertedMultipliers,
        ...currentTiming.frameMultipliers.slice(insertAt),
    ];

    const staging = await createStagingDir(`insert-${avatarId}-${actionId}`);
    let cursor = 0;
    for (let position = 0; position <= current.length; position += 1) {
        if (position === insertAt) {
            await writeFramesToStaging(buffers, staging, cursor);
            cursor += buffers.length;
        }
        if (position < current.length) {
            await fs.copyFile(
                path.join(actionDir, current[position]),
                path.join(staging, `frame_${String(cursor).padStart(3, '0')}.webp`),
            );
            cursor += 1;
        }
    }
    const nextFrameNames = Array.from(
        { length: current.length + buffers.length },
        (_item, frameIndex) => `frame_${String(frameIndex).padStart(3, '0')}.webp`,
    );
    await writeActionConfig(staging, nextFrameNames, {
        frameMultipliers: nextMultipliers,
        meta: action,
    });

    const backupDir = await swapDirectory(actionDir, staging, TRASH_ROOT, `${avatarId}/${actionId}`);
    await touchManifest();
    return {
        ok: true,
        inserted: buffers.length,
        insertAt,
        frameCount: current.length + buffers.length,
        backup: path.relative(LIBRARY_ROOT, backupDir).replaceAll('\\', '/'),
    };
}

async function handleFramesDelete(body) {
    const avatarId = assertId(body.avatar, '形象 id');
    const actionId = assertId(body.action, '动作 id');
    const indices = Array.isArray(body.indices) ? body.indices.map(Number) : [];
    if (!indices.length) fail('没有待删除的帧');
    const manifest = await loadManifest();
    const avatar = findAvatar(manifest, avatarId);
    const action = findAction(avatar, actionId);

    const actionDir = path.join(LIBRARY_ROOT, avatarId, actionId);
    const current = await listFrameNames(actionDir);
    const currentTiming = await loadTiming(actionDir, current);
    const removeSet = new Set(indices.filter((index) => Number.isInteger(index) && index >= 0 && index < current.length));
    if (!removeSet.size) fail('删除索引全部越界');
    const remaining = current.filter((_name, index) => !removeSet.has(index));
    const nextMultipliers = currentTiming.frameMultipliers.filter((_value, index) => !removeSet.has(index));

    const staging = await createStagingDir(`delete-${avatarId}-${actionId}`);
    for (let index = 0; index < remaining.length; index += 1) {
        await fs.copyFile(
            path.join(actionDir, remaining[index]),
            path.join(staging, `frame_${String(index).padStart(3, '0')}.webp`),
        );
    }
    await fs.mkdir(staging, { recursive: true });
    const nextFrameNames = remaining.map((_name, index) => `frame_${String(index).padStart(3, '0')}.webp`);
    await writeActionConfig(staging, nextFrameNames, {
        frameMultipliers: nextMultipliers,
        meta: action,
    });

    const backupDir = await swapDirectory(actionDir, staging, TRASH_ROOT, `${avatarId}/${actionId}`);
    await touchManifest();
    return {
        ok: true,
        removed: removeSet.size,
        frameCount: remaining.length,
        backup: path.relative(LIBRARY_ROOT, backupDir).replaceAll('\\', '/'),
    };
}

async function handleFramesReorder(body) {
    const avatarId = assertId(body.avatar, '形象 id');
    const actionId = assertId(body.action, '动作 id');
    const order = Array.isArray(body.order) ? body.order.map(Number) : [];
    const manifest = await loadManifest();
    const avatar = findAvatar(manifest, avatarId);
    const action = findAction(avatar, actionId);

    const actionDir = path.join(LIBRARY_ROOT, avatarId, actionId);
    const current = await listFrameNames(actionDir);
    const currentTiming = await loadTiming(actionDir, current);
    if (order.length !== current.length) fail('重排索引数量与帧数不一致');
    const seen = new Set();
    for (const index of order) {
        if (!Number.isInteger(index) || index < 0 || index >= current.length || seen.has(index)) {
            fail('重排索引非法');
        }
        seen.add(index);
    }
    const nextMultipliers = order.map((sourceIndex) => currentTiming.frameMultipliers[sourceIndex]);

    const staging = await createStagingDir(`reorder-${avatarId}-${actionId}`);
    for (let index = 0; index < order.length; index += 1) {
        await fs.copyFile(
            path.join(actionDir, current[order[index]]),
            path.join(staging, `frame_${String(index).padStart(3, '0')}.webp`),
        );
    }
    const nextFrameNames = order.map((_item, index) => `frame_${String(index).padStart(3, '0')}.webp`);
    await writeActionConfig(staging, nextFrameNames, {
        frameMultipliers: nextMultipliers,
        meta: action,
    });
    const backupDir = await swapDirectory(actionDir, staging, TRASH_ROOT, `${avatarId}/${actionId}`);
    await touchManifest();
    return {
        ok: true,
        frameCount: order.length,
        backup: path.relative(LIBRARY_ROOT, backupDir).replaceAll('\\', '/'),
    };
}

async function handleFramesReplace(body) {
    const avatarId = assertId(body.avatar, '形象 id');
    const actionId = assertId(body.action, '动作 id');
    const index = Number(body.index);
    const buffer = decodeWebpDataUrl(body.dataUrl);
    const manifest = await loadManifest();
    const avatar = findAvatar(manifest, avatarId);
    const action = findAction(avatar, actionId);

    const actionDir = path.join(LIBRARY_ROOT, avatarId, actionId);
    const current = await listFrameNames(actionDir);
    const currentTiming = await loadTiming(actionDir, current);
    if (!Number.isInteger(index) || index < 0 || index >= current.length) fail('替换索引越界');

    const staging = await createStagingDir(`replace-${avatarId}-${actionId}`);
    for (let cursor = 0; cursor < current.length; cursor += 1) {
        const target = path.join(staging, `frame_${String(cursor).padStart(3, '0')}.webp`);
        if (cursor === index) {
            await fs.writeFile(target, buffer);
        } else {
            await fs.copyFile(path.join(actionDir, current[cursor]), target);
        }
    }
    await writeActionConfig(staging, current, {
        frameMultipliers: currentTiming.frameMultipliers,
        meta: action,
    });
    const backupDir = await swapDirectory(actionDir, staging, TRASH_ROOT, `${avatarId}/${actionId}`);
    await touchManifest();
    return {
        ok: true,
        frameCount: current.length,
        backup: path.relative(LIBRARY_ROOT, backupDir).replaceAll('\\', '/'),
    };
}

async function handleOpen(body) {
    const target = String(body.target || 'library');
    let dir;
    if (target === 'library') dir = LIBRARY_ROOT;
    else if (target === 'trash') dir = TRASH_ROOT;
    else fail('未知的打开目标');
    await fs.mkdir(dir, { recursive: true });
    const command = process.platform === 'win32'
        ? ['explorer.exe', [dir]]
        : (process.platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]]);
    try {
        const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
        child.unref();
    } catch (error) {
        fail(`无法打开目录：${error.message}`, 500);
    }
    return { ok: true, dir };
}

// ────────────────────────────── HTTP 层 ──────────────────────────────

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new HttpError(413, '请求体过大'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!chunks.length) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (_error) {
                reject(new HttpError(400, 'JSON 解析失败'));
            }
        });
        req.on('error', reject);
    });
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webp': 'image/webp',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
};

async function serveFile(res, filePath, cacheControl = 'no-cache') {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
        sendJson(res, 404, { ok: false, error: 'Not found' });
        return;
    }
    res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': cacheControl,
    });
    createReadStream(filePath).pipe(res);
}

async function handleFrameRequest(res, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length !== 4 || parts[0] !== 'files') fail('帧路径非法', 404);
    const [, avatarId, actionId, frameName] = parts;
    if (!ID_RE.test(avatarId) || !ID_RE.test(actionId) || !FRAME_RE.test(frameName)) {
        fail('帧路径非法', 404);
    }
    const filePath = path.join(LIBRARY_ROOT, avatarId, actionId, frameName);
    const relative = path.relative(LIBRARY_ROOT, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) fail('帧路径越界', 403);
    await serveFile(res, filePath, 'no-cache');
}

async function handleStatic(res, pathname) {
    const fileMap = {
        '/': 'index.html',
        '/index.html': 'index.html',
        '/app.js': 'app.js',
        '/styles.css': 'styles.css',
    };
    const fileName = fileMap[pathname];
    if (!fileName) {
        sendJson(res, 404, { ok: false, error: 'Not found' });
        return;
    }
    await serveFile(res, path.join(TOOL_DIR, fileName), 'no-store');
}

async function route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'GET' && pathname.startsWith('/files/')) {
        await handleFrameRequest(res, pathname);
        return;
    }
    if (req.method === 'GET' && (pathname === '/' || pathname.endsWith('.js') || pathname.endsWith('.css') || pathname === '/index.html')) {
        await handleStatic(res, pathname);
        return;
    }
    if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, {
            ok: true,
            app: 'seq-asset-tool',
            toolDir: TOOL_DIR,
            pid: process.pid,
            startedAt: APP_STARTED_AT,
            libraryRoot: LIBRARY_ROOT,
        });
        return;
    }
    if (req.method === 'GET' && pathname === '/api/library') {
        sendJson(res, 200, { ok: true, ...(await handleLibrary()) });
        return;
    }
    if (req.method === 'GET' && pathname === '/api/pipeline/status') {
        sendJson(res, 200, await handlePipelineStatus());
        return;
    }
    if (req.method === 'GET' && pathname === '/api/pipeline/job') {
        sendJson(res, 200, await handlePipelineJob({ id: url.searchParams.get('id') }));
        return;
    }
    if (req.method === 'GET' && pathname === '/api/pipeline/env/setup') {
        sendJson(res, 200, await handleSetupJob({ id: url.searchParams.get('id') }));
        return;
    }
    if (req.method === 'POST' && pathname === '/api/pipeline/upload') {
        sendJson(res, 200, await handlePipelineUpload(req, url.searchParams.get('name')));
        return;
    }
    if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        return;
    }

    const body = await readBody(req);
    switch (pathname) {
        case '/api/action/meta':
            sendJson(res, 200, await handleActionMeta(body));
            break;
        case '/api/action/timing':
            sendJson(res, 200, await handleActionTiming(body));
            break;
        case '/api/action/create':
            sendJson(res, 200, await handleActionCreate(body));
            break;
        case '/api/frames/insert':
            sendJson(res, 200, await handleFramesInsert(body));
            break;
        case '/api/frames/delete':
            sendJson(res, 200, await handleFramesDelete(body));
            break;
        case '/api/frames/reorder':
            sendJson(res, 200, await handleFramesReorder(body));
            break;
        case '/api/frames/replace':
            sendJson(res, 200, await handleFramesReplace(body));
            break;
        case '/api/pipeline/run':
            sendJson(res, 200, await handlePipelineRun(body));
            break;
        case '/api/pipeline/cancel':
            sendJson(res, 200, await handlePipelineCancel(body));
            break;
        case '/api/pipeline/env/setup':
            sendJson(res, 200, startSetupJob(body));
            break;
        case '/api/pipeline/env/setup/cancel':
            sendJson(res, 200, handleSetupCancel(body));
            break;
        case '/api/pipeline/env/python':
            sendJson(res, 200, await handleSetPython(body));
            break;
        case '/api/pipeline/env/reset':
            sendJson(res, 200, await handleResetPythonEnv());
            break;
        case '/api/open':
            sendJson(res, 200, await handleOpen(body));
            break;
        default:
            sendJson(res, 404, { ok: false, error: 'Not found' });
    }
}

const server = http.createServer((req, res) => {
    Promise.resolve()
        .then(() => route(req, res))
        .catch((error) => {
            const status = error instanceof HttpError ? error.status : 500;
            if (status >= 500) console.error('[seq-asset-tool]', error);
            if (!res.headersSent) {
                sendJson(res, status, { ok: false, error: error.message || '服务器内部错误' });
            } else {
                res.end();
            }
        });
});

// ─────────────────────────── 停止与父进程看护 ───────────────────────────

let shuttingDown = false;

async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[seq-asset-tool] 收到 ${reason}，正在停止服务…`);
    try {
        // 浏览器可能保持 keep-alive 连接，先断开再关闭，避免 Ctrl+C 后卡住。
        server.closeAllConnections?.();
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, 2000);
            timer.unref();
            server.close(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    } catch (error) {
        console.error('[seq-asset-tool] 停止服务时出错', error);
    }
    console.log('[seq-asset-tool] 服务已停止');
    process.exit(0);
}

// Windows 有 SIGBREAK（Ctrl+Break / 关闭控制台）；POSIX 用 SIGHUP 覆盖终端关闭。
const stopSignals = process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM', 'SIGBREAK']
    : ['SIGINT', 'SIGTERM', 'SIGHUP'];

for (const signal of stopSignals) {
    process.on(signal, () => {
        shutdown(signal);
    });
}

/**
 * --watch-parent：定时确认启动本服务的父进程（通常是运行 start.bat 的 cmd）仍在。
 * 窗口被关闭、启动器被强杀而 node 意外存活时，由此兜底退出，避免留下孤儿服务。
 */
function watchParentProcess() {
    const parentPid = Number(process.ppid);
    if (!Number.isInteger(parentPid) || parentPid <= 0) return;
    const timer = setInterval(() => {
        try {
            process.kill(parentPid, 0);
        } catch (error) {
            // ESRCH 表示父进程已不存在；EPERM 表示仍在（只是无权限），继续运行。
            if (error.code === 'ESRCH') shutdown('父进程退出');
        }
    }, 1000);
    timer.unref();
}

function openBrowser(url) {
    const command = process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : (process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]);
    try {
        const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
        child.unref();
    } catch (_error) {
        /* 浏览器打不开时保留控制台地址 */
    }
}

async function listenWithFallback(startPort, host) {
    let port = startPort;
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            await new Promise((resolve, reject) => {
                const onError = (error) => {
                    server.off('listening', onListening);
                    reject(error);
                };
                const onListening = () => {
                    server.off('error', onError);
                    resolve();
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(port, host);
            });
            return port;
        } catch (error) {
            if (error.code !== 'EADDRINUSE') throw error;
            port += 1;
        }
    }
    throw new Error('端口被占用，且找不到可用端口');
}

/** 探测指定端口上是否已有同一个工作台在运行（避免重复启动导致端口漂移到 4322/4323） */
async function findRunningInstance(host, port) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        const response = await fetch(`http://${host}:${port}/api/health`, { signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) return null;
        const data = await response.json();
        if (data?.ok === true && data?.app === 'seq-asset-tool') return data;
        return null;
    } catch (_error) {
        return null;
    }
}

async function main() {
    await fs.mkdir(TRASH_ROOT, { recursive: true });
    await fs.mkdir(STAGING_ROOT, { recursive: true });
    await cleanupUploads();

    const args = process.argv.slice(2);
    const portArgIndex = args.indexOf('--port');
    if (portArgIndex >= 0 && args[portArgIndex + 1]) {
        runtime.port = Number(args[portArgIndex + 1]);
    }
    if (args.includes('--no-open')) runtime.openBrowser = false;

    // 已有实例：直接复用，避免同一个工作台开在多个端口上（旧实例可能是旧代码）
    if (!args.includes('--force-new')) {
        const existing = await findRunningInstance(runtime.host, runtime.port);
        if (existing) {
            const url = `http://${runtime.host}:${runtime.port}`;
            console.log(`[seq-asset-tool] 已有工作台实例在运行：${url}（pid ${existing.pid}）`);
            console.log(`[seq-asset-tool] library: ${existing.libraryRoot}`);
            console.log('[seq-asset-tool] 已直接打开该实例；如需加载最新代码，请先关闭已有实例，或使用 --force-new 强制新开');
            if (runtime.openBrowser) openBrowser(url);
            return;
        }
    }

    const port = await listenWithFallback(runtime.port, runtime.host);
    const url = `http://${runtime.host}:${port}`;
    console.log(`[seq-asset-tool] ${url}`);
    console.log(`[seq-asset-tool] library: ${LIBRARY_ROOT}`);
    if (args.includes('--watch-parent')) watchParentProcess();
    if (runtime.openBrowser) openBrowser(url);
    console.log('[seq-asset-tool] Ctrl+C 或关闭启动窗口可停止服务');
}

main().catch((error) => {
    console.error('[seq-asset-tool] 启动失败', error);
    process.exitCode = 1;
});
