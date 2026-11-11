/*
 * 织忆 · Memory Weave
 * SillyTavern 长期记忆扩展 · 移动端优先
 *
 * 两种记录方式：
 *   1. 自动编织 —— 攒够对话后由模型提炼成短句记忆
 *   2. 填表归档 —— 按模板填写结构化记录，适合角色档案、关系变化、设定条目
 * 两者共用一套时间线与上下文注入管线。
 */

'use strict';

/* =========================================================
 * 常量
 * ========================================================= */

const MODULE = 'memory-weave';
const PROMPT_KEY = 'mw_long_term_memory';

const CATEGORIES = ['事件', '关系', '承诺', '设定', '情绪', '其他'];

const FIELD_TYPES = [
    { v: 'text', label: '单行' },
    { v: 'textarea', label: '多行' },
    { v: 'select', label: '选项' },
    { v: 'tags', label: '标签' },
];

const DEFAULT_SETTINGS = {
    enabled: true,
    autoSummarize: true,
    autoFillSnapshots: true,
    useAI: true,
    batchSize: 10,
    injectCount: 6,
    maxKeep: 400,
    showFab: true,
    showMenuEntry: true,
    tone: 'archive',
    fab: null,
    templates: [],      // 用户自定义模板
    tplFlags: {},       // 内置模板的开关覆盖值 { [tplId]: { singleton, autofill } }
    chats: {},          // chatKey -> { cursor, memories[], snapshots{}, fillSig }
};

const TONE_HINT = {
    archive: '以冷静的档案口吻记录客观事实。',
    diary: '以第一人称日记口吻记录，可带一点情绪色彩。',
    relation: '侧重记录人物之间的关系变化与态度。',
};

/* =========================================================
 * 内置模板
 * 想改字段？复制 templates/ 下的 JSON 改完再导入
 * ========================================================= */

const GENERAL_TEMPLATE = {
    id: 'general',
    name: '通用记忆表',
    builtin: true,
    singleton: false,
    fields: [
        { id: 'title', label: '标题', type: 'text', group: 'main', required: true, placeholder: '一句话概括，如「初遇时的那场雨」' },
        { id: 'category', label: '分类', type: 'select', group: 'main', options: ['事件', '人物', '地点', '物品', '规则', '关系', '承诺', '其他'] },
        { id: 'subject', label: '涉及对象', type: 'text', group: 'main', placeholder: '这件事和谁有关' },
        { id: 'detail', label: '经过 / 内容', type: 'textarea', group: 'main', placeholder: '发生了什么，说清了什么' },
        { id: 'when', label: '时间', type: 'text', group: 'extra', placeholder: '故事内的第几天 / 季节' },
        { id: 'place', label: '地点', type: 'text', group: 'extra', placeholder: '在哪里发生的' },
        { id: 'quote', label: '关键台词', type: 'textarea', group: 'extra', placeholder: '值得原样记住的一句话' },
        { id: 'change', label: '影响 / 变化', type: 'textarea', group: 'extra', placeholder: '关系、立场、心境上的变化' },
        { id: 'tags', label: '标签', type: 'tags', group: 'extra', placeholder: '输入后按回车' },
    ],
};

/*
 * 快照型模板：singleton = 只保留最新一条，每次保存覆盖旧值
 * autofill = 每轮对话结束后由模型从「上一轮」提取，自动覆盖
 */
const STATE_TEMPLATE = {
    id: 'state',
    name: '当前状态',
    builtin: true,
    singleton: true,
    autofill: true,
    fields: [
        { id: 'scene', label: '场景', type: 'text', group: 'main', placeholder: '此刻在哪、什么氛围' },
        { id: 'present', label: '在场的人', type: 'text', group: 'main', placeholder: '谁在场' },
        { id: 'me', label: '我的处境', type: 'textarea', group: 'main', placeholder: '我正在做什么、什么状态' },
        { id: 'other', label: '对方的状态', type: 'textarea', group: 'extra', placeholder: '情绪、态度、小动作' },
        { id: 'thread', label: '进行中的事', type: 'textarea', group: 'extra', placeholder: '还没了结的线索' },
        { id: 'note', label: '备注', type: 'text', group: 'extra', placeholder: '其它值得留意的' },
    ],
};

/* =========================================================
 * 运行时状态
 * ========================================================= */

let ctx = null;
let S = null;
let ready = false;
let weaving = false;
let filling = false;
let ui = {};
let fabDrag = null;
let editingRecordId = null;
let editingTemplateId = null;
let editingSnapshotTpl = null;
let draftTemplate = null;

/* =========================================================
 * 上下文
 * ========================================================= */

async function ensureContext() {
    if (ctx) return ctx;
    if (globalThis.SillyTavern?.getContext) {
        ctx = globalThis.SillyTavern.getContext();
    } else {
        const mod = await import('../../../extensions.js');
        ctx = mod.getContext();
    }
    return ctx;
}

/* =========================================================
 * 设置
 * ========================================================= */

function loadSettings() {
    const bucket = ctx.extensionSettings;
    if (!bucket[MODULE]) bucket[MODULE] = structuredClone(DEFAULT_SETTINGS);

    const s = bucket[MODULE];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    if (!s.chats || typeof s.chats !== 'object') s.chats = {};
    if (!Array.isArray(s.templates)) s.templates = [];
    S = s;
    return s;
}

function persist() {
    try { ctx.saveSettingsDebounced?.(); } catch { /* 忽略 */ }
}

/* =========================================================
 * 模板
 * ========================================================= */

function getTemplates() {
    const base = [GENERAL_TEMPLATE, STATE_TEMPLATE, ...S.templates];
    const flags = S.tplFlags || {};
    return base.map(t => (flags[t.id] ? { ...t, ...flags[t.id] } : t));
}

function getTemplate(id) {
    return getTemplates().find(t => t.id === id) || GENERAL_TEMPLATE;
}

function snapshotTemplates() {
    return getTemplates().filter(t => t.singleton);
}

/* 这三个 id 有语义：标题用于卡片抬头，分类用于标签，标签用于 chip */
const RESERVED_FIELD_IDS = new Set(['title', 'category', 'tags']);

function newTemplateFrom(base, name) {
    return {
        id: 'tpl_' + Date.now().toString(36),
        name: name || '未命名模板',
        builtin: false,
        singleton: !!base.singleton,
        autofill: !!base.autofill,
        fields: base.fields.map(f => RESERVED_FIELD_IDS.has(f.id)
            ? { ...f }
            : { ...f, id: f.id + '_' + Math.random().toString(36).slice(2, 5) }),
    };
}

/* =========================================================
 * 存储
 * ========================================================= */

function chatKey() {
    try {
        const chid = ctx.characterId;
        const ch = ctx.characters?.[chid];
        const avatar = ch?.avatar || ch?.name || ctx.name2 || 'char';
        const cid = ctx.getCurrentChatId?.() || 'default';
        return `${avatar}::${cid}`;
    } catch {
        return 'default';
    }
}

function store() {
    const k = chatKey();
    if (!S.chats[k]) S.chats[k] = { cursor: 0, memories: [], snapshots: {}, fillSig: '' };
    const node = S.chats[k];
    if (!Array.isArray(node.memories)) node.memories = [];
    if (typeof node.cursor !== 'number') node.cursor = 0;
    if (!node.snapshots || typeof node.snapshots !== 'object') node.snapshots = {};
    if (typeof node.fillSig !== 'string') node.fillSig = '';
    return node;
}

/* ---------- 快照（模板只存最新一条，覆盖式） ---------- */

function getSnapshot(tplId) {
    const s = store().snapshots[tplId];
    return s && s.values ? s : null;
}

function saveSnapshot(tplId, values, opts = {}) {
    const node = store();
    const tpl = getTemplate(tplId);
    const prev = node.snapshots[tplId];
    const now = Date.now();

    let merged;
    if (opts.replace) {
        merged = { ...values };
    } else {
        // 自动填充时，模型没提到的字段保留旧值，避免一次漏读就把信息抹掉
        merged = { ...(prev?.values || {}) };
        for (const [k, v] of Object.entries(values)) {
            const empty = v === undefined || v === null
                || (typeof v === 'string' && !v.trim())
                || (Array.isArray(v) && !v.length);
            if (!empty) merged[k] = v;
        }
    }

    node.snapshots[tplId] = {
        kind: 'snapshot',
        id: prev?.id || 's' + now.toString(36),
        templateId: tplId,
        title: tpl.name,
        values: merged,
        ts: prev?.ts || now,
        updatedTs: now,
        source: opts.source || 'manual',
    };
    persist();
    return node.snapshots[tplId];
}

function dropSnapshot(tplId) {
    const node = store();
    if (!node.snapshots[tplId]) return;
    delete node.snapshots[tplId];
    persist();
}

function hasAnyValue(values) {
    return Object.values(values || {}).some(v =>
        (typeof v === 'string' && v.trim()) || (Array.isArray(v) && v.length));
}

function allMemories() {
    return store().memories.map(m => ({ kind: 'note', ...m }));
}

function mkNote(text, cat, importance) {
    return {
        kind: 'note',
        id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ts: Date.now(),
        text: String(text).replace(/\s+/g, ' ').trim().slice(0, 180),
        cat: CATEGORIES.includes(cat) ? cat : '其他',
        importance: clampImp(importance),
    };
}

function mkRecord(payload) {
    return {
        kind: 'record',
        id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ts: Date.now(),
        templateId: payload.templateId,
        title: String(payload.title || '未命名记录').slice(0, 60),
        values: payload.values || {},
        tags: Array.isArray(payload.tags) ? payload.tags.slice(0, 12) : [],
        importance: clampImp(payload.importance),
    };
}

function clampImp(n) {
    const v = Math.round(Number(n) || 3);
    return Math.min(5, Math.max(1, v));
}

function pushMemories(list) {
    const node = store();
    node.memories.push(...list);
    if (node.memories.length > S.maxKeep) {
        node.memories = node.memories.slice(-S.maxKeep);
    }
    persist();
}

/* 记录 → 注入上下文的一行紧凑文本 */
function recordLine(r) {
    const tpl = getTemplate(r.templateId);
    const parts = [];
    for (const f of tpl.fields) {
        if (f.id === 'title' || f.id === 'tags' || f.group !== 'main') continue;
        const v = r.values?.[f.id];
        if (typeof v === 'string' && v.trim()) parts.push(v.trim());
    }
    const body = parts.join('；').slice(0, 110);
    const tagStr = r.tags?.length ? `（${r.tags.join('·')}）` : '';
    return `${r.title}${body ? '：' + body : ''}${tagStr}`;
}

/* =========================================================
 * 摘要引擎
 * ========================================================= */

function cleanHistory() {
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const out = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        if (!m.mes || !String(m.mes).trim()) continue;
        out.push({ index: i, msg: m });
    }
    return out;
}

function pendingSlice() {
    const node = store();
    return cleanHistory().filter(x => x.index >= node.cursor);
}

function speakerOf(m) {
    if (m.is_user) return ctx.name1 || 'User';
    return m.name || ctx.name2 || 'Character';
}

function buildPrompt(transcript) {
    const tone = TONE_HINT[S.tone] || TONE_HINT.archive;
    return [
        '你是长期记忆整理员。下面是一段角色扮演对话的记录。',
        '请从中提取 3-5 条值得长期记住的信息，供以后回忆使用。',
        tone,
        '',
        '输出规则（严格遵守，不要输出任何解释、标题或代码块）：',
        '每条一行，格式为：[重要度1-5] 分类 | 内容',
        '分类只能是：事件、关系、承诺、设定、情绪、其他',
        '内容要具体，出现的人名必须保留，单条不超过 40 字。',
        '只记录对话中明确发生或明确说过的内容，不要推测。',
        '',
        '对话记录：',
        transcript,
    ].join('\n');
}

/** 通用模型调用：三条通道依次降级，任何一条通了就用 */
async function aiCall(prompt, responseLength = 500, quietName = 'memory') {
    if (typeof ctx.generateRaw === 'function') {
        try {
            const out = await ctx.generateRaw({ prompt, responseLength, trimNames: false });
            if (out && String(out).trim()) return String(out);
        } catch (e) {
            console.warn('[织忆] generateRaw 不可用，尝试下一通道', e);
        }
    }

    if (typeof ctx.generateQuietPrompt === 'function') {
        try {
            const out = await ctx.generateQuietPrompt({
                quietPrompt: prompt, responseLength, quietName,
            });
            if (out && String(out).trim()) return String(out);
        } catch (e) {
            console.warn('[织忆] generateQuietPrompt(对象) 不可用，尝试旧签名', e);
        }
        try {
            const out = await ctx.generateQuietPrompt(prompt, false, true, quietName, responseLength);
            if (out && String(out).trim()) return String(out);
        } catch (e) {
            console.warn('[织忆] generateQuietPrompt(位置参数) 不可用', e);
        }
    }

    return '';
}

async function aiSummarize(transcript) {
    return aiCall(buildPrompt(transcript), 500);
}

function parseMemories(raw) {
    const out = [];
    for (const line of String(raw).split(/\r?\n/)) {
        const t = line.trim().replace(/^[-*•·]\s*/, '').replace(/```.*/, '').trim();
        if (!t) continue;
        if (/^(记忆|对话记录|以下是|输出)/.test(t)) continue;

        const strict = t.match(/^\[?\s*([1-5])\s*\]?\s*[.、:：]?\s*([^|｜]{1,10})\s*[|｜]\s*(.+)$/);
        if (strict) {
            out.push(mkNote(strict[3], strict[2].replace(/[\[\]]/g, '').trim(), Number(strict[1])));
            continue;
        }
        const loose = t.replace(/^\[?\s*[1-5]\s*\]?\s*/, '').replace(/^[^|｜]{1,10}[|｜]/, '');
        if (loose.length >= 8 && loose.length <= 120) out.push(mkNote(loose, '其他', 3));
    }

    const seen = new Set();
    return out.filter(m => {
        const k = m.text.slice(0, 18);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    }).slice(0, 8);
}

function fallbackSummarize(items) {
    const joined = items.map(x => String(x.msg.mes).trim()).join(' ').replace(/\s+/g, ' ');
    if (!joined) return [];
    return [mkNote(joined.length > 80 ? joined.slice(0, 80) + '…' : joined, '事件', 3)];
}

async function weaveBatch(items) {
    const transcript = items
        .map(x => `${speakerOf(x.msg)}：${String(x.msg.mes).trim().slice(0, 600)}`)
        .join('\n');

    let mems = [];
    if (S.useAI) {
        const raw = await aiSummarize(transcript);
        if (raw) mems = parseMemories(raw);
    }
    if (!mems.length) mems = fallbackSummarize(items);

    if (mems.length) {
        pushMemories(mems);
        refreshInjection();
        refreshAll();
    }
    return mems.length;
}

/* =========================================================
 * 快照自动填充：只读上一轮对话，覆盖式更新
 * ========================================================= */

function lastRoundMessages() {
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const out = [];
    for (let i = chat.length - 1; i >= 0 && out.length < 4; i--) {
        const m = chat[i];
        if (!m || m.is_system || !m.mes || !String(m.mes).trim()) continue;
        out.unshift({ index: i, msg: m });
    }
    return out;
}

function buildFillPrompt(tpl, transcript) {
    const fields = tpl.fields.map(f => {
        const hint = f.type === 'select'
            ? `选项：${(f.options || []).join('/')}`
            : f.type === 'tags' ? '多个词，用顿号分隔'
                : f.type === 'textarea' ? '一到两句话' : '短语';
        return `- ${f.label}（${hint}）`;
    }).join('\n');

    return [
        '你是状态记录员。根据下面这段最新对话，按字段清单填写当前状态。',
        '',
        '字段清单：',
        fields,
        '',
        '输出规则（严格遵守，不要输出任何解释、标题或代码块）：',
        '每条一行，格式为：字段名：内容',
        '只填有明确依据的字段，拿不准的整行省略，不要写"未知""无"或"未提及"。',
        '不要编造对话里没出现的信息。',
        '每条内容控制在 40 字以内。',
        '',
        '最新对话：',
        transcript,
    ].join('\n');
}

function parseFilled(tpl, raw) {
    const values = {};
    const byLabel = new Map(tpl.fields.map(f => [f.label, f]));

    for (const line of String(raw).split(/\r?\n/)) {
        const t = line.trim().replace(/^[-*•·]\s*/, '').replace(/```.*/, '');
        if (!t) continue;

        const m = t.match(/^([^：:]{1,12})\s*[：:]\s*(.+)$/);
        if (!m) continue;

        const label = m[1].replace(/[【】\[\]]/g, '').trim();
        const f = byLabel.get(label);
        if (!f) continue;

        const v = m[2].trim().slice(0, 160);
        if (!v || /^(无|未知|未提及|空|n\/a|none|null|-|—)$/i.test(v)) continue;

        if (f.type === 'tags') {
            const arr = v.split(/[、,，\s]+/).filter(Boolean).slice(0, 8);
            if (arr.length) values[f.id] = arr;
        } else {
            values[f.id] = v;
        }
    }
    return values;
}

async function autoFillSnapshots() {
    if (!ready || filling || weaving || !S.enabled || !S.autoFillSnapshots) return;

    const tpls = snapshotTemplates().filter(t => t.autofill);
    if (!tpls.length) return;

    const round = lastRoundMessages();
    if (!round.length) return;

    // 同一轮不重复跑；对话继续推进才会再次触发
    const sig = round.map(r => r.index).join(',');
    const node = store();
    if (node.fillSig === sig) return;
    node.fillSig = sig;
    persist();

    filling = true;
    try {
        const transcript = round
            .map(r => `${speakerOf(r.msg)}：${String(r.msg.mes).trim().slice(0, 500)}`)
            .join('\n');

        let touched = 0;
        for (const tpl of tpls) {
            try {
                const raw = await aiCall(buildFillPrompt(tpl, transcript), 400, 'memory-state');
                if (!raw) continue;
                const values = parseFilled(tpl, raw);
                if (hasAnyValue(values)) {
                    saveSnapshot(tpl.id, values, { source: 'auto' });
                    touched++;
                }
            } catch (e) {
                console.warn('[织忆] 快照填充失败：' + tpl.name, e);
            }
        }

        if (touched) {
            refreshAll();
            refreshInjection();
        }
    } finally {
        filling = false;
    }
}

/* =========================================================
 * 自动记忆
 * ========================================================= */

function countPending() {
    return pendingSlice().length;
}

async function autoTick(reason = 'auto') {
    if (!ready || weaving || filling) return;
    if (!S.enabled) return;
    if (reason === 'auto' && !S.autoSummarize) return;

    const pending = pendingSlice();
    if (pending.length < S.batchSize) return;

    weaving = true;
    setBusyState(true);
    try {
        const batch = pending.slice(0, S.batchSize);
        const n = await weaveBatch(batch);
        const node = store();
        node.cursor = batch[batch.length - 1].index + 1;
        persist();
        if (n > 0) toast(`编织了 ${n} 条记忆`);
        updateStats();
    } catch (e) {
        console.error('[织忆] 自动记忆失败', e);
        toast('记忆生成失败，稍后再试');
    } finally {
        weaving = false;
        setBusyState(false);
    }
}

async function backfillAll() {
    if (weaving) return;
    weaving = true;
    setBusyState(true);
    let total = 0;
    try {
        for (let guard = 0; guard < 40; guard++) {
            const pending = pendingSlice();
            if (pending.length < 2) break;
            const batch = pending.slice(0, Math.max(S.batchSize, 4));
            total += await weaveBatch(batch);
            const node = store();
            node.cursor = batch[batch.length - 1].index + 1;
            persist();
            updateStats();
            toast(`已整理到第 ${node.cursor} 层…`);
        }
        toast(total > 0 ? `整理完成，新增 ${total} 条记忆` : '没有可整理的内容');
    } catch (e) {
        console.error('[织忆] 历史整理失败', e);
        toast('整理中断');
    } finally {
        weaving = false;
        setBusyState(false);
        refreshAll();
    }
}

async function manualWeave() {
    if (weaving) { toast('正在编织中…'); return; }
    const pending = pendingSlice();
    if (!pending.length) { toast('没有新的对话可整理'); return; }

    weaving = true;
    setBusyState(true);
    try {
        const batch = pending.slice(0, Math.max(S.batchSize, 6));
        const n = await weaveBatch(batch);
        const node = store();
        node.cursor = batch[batch.length - 1].index + 1;
        persist();
        refreshAll();
        toast(n > 0 ? `编织了 ${n} 条记忆` : '这一批没什么可记的');
    } catch (e) {
        console.error('[织忆] 手动编织失败', e);
        toast('出错了，看下控制台');
    } finally {
        weaving = false;
        setBusyState(false);
    }
}

/* =========================================================
 * 上下文注入
 * ========================================================= */

/* 快照拼成一段「当前状态」，优先级高于过往片段 */
function snapshotBlock() {
    const snaps = Object.values(store().snapshots || {})
        .filter(s => s && hasAnyValue(s.values))
        .sort((a, b) => b.updatedTs - a.updatedTs);

    if (!snaps.length) return '';

    const lines = snaps.map(s => {
        const tpl = getTemplate(s.templateId);
        const parts = tpl.fields
            .map(f => {
                const v = s.values?.[f.id];
                const str = Array.isArray(v) ? v.join('、') : v;
                return str ? `${f.label}：${String(str).slice(0, 60)}` : '';
            })
            .filter(Boolean);
        return parts.length ? `【${tpl.name}】${parts.join('；')}` : '';
    }).filter(Boolean);

    if (!lines.length) return '';
    return ['当前状态（截至最新一轮）：', ...lines].join('\n');
}

function refreshInjection() {
    if (typeof ctx.setExtensionPrompt !== 'function') return;

    const clear = () => ctx.setExtensionPrompt(PROMPT_KEY, '', 1, 4, 0);
    if (!S.enabled) return clear();

    const mems = allMemories()
        .slice()
        .sort((a, b) => b.importance - a.importance || a.ts - b.ts)
        .slice(0, S.injectCount);

    const snap = snapshotBlock();
    if (!mems.length && !snap) return clear();

    const body = mems
        .map(m => (m.kind === 'record' ? `- 【${recordCat(m)}】${recordLine(m)}` : `- ${m.text}`))
        .join('\n');

    const parts = ['<long_term_memory>'];
    if (snap) {
        parts.push(snap, '');
    }
    if (body) {
        parts.push(`以下是你与 ${ctx.name1 || '对方'} 之间值得记住的过往。回应当前话题时保持连贯与一致，`);
        parts.push('但不要直接复述，也不要说"根据我的记忆"。');
        parts.push(body);
    }
    parts.push('</long_term_memory>');

    // position 1 = IN_CHAT, depth 4, role 0 = SYSTEM
    ctx.setExtensionPrompt(PROMPT_KEY, parts.join('\n'), 1, 4, 0);
}

function recordCat(r) {
    return r.values?.category || '记录';
}

/* =========================================================
 * DOM 小工具
 * ========================================================= */

const el = (sel, root = document) => root.querySelector(sel);
const els = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

let toastTimer = null;
function toast(msg) {
    if (!ui.toast) return;
    const undo = el('.mw-undo', ui.toast);
    if (undo) undo.remove();
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2200);
}

function setBusyState(on) {
    if (ui.foot) ui.foot.classList.toggle('busy', on);
    els('[data-mw="weave"], [data-mw="backfill"]', ui.app || document).forEach(b => { b.disabled = on; });
    if (ui.fab) ui.fab.classList.toggle('working', on);
}

/* =========================================================
 * 图标
 * ========================================================= */

const ICON = {
    close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
    weave: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 8.5c4.2 0 4.2 7 8.5 7s4.3-7 8.5-7"/><path d="M3.5 15.5c4.2 0 4.2-7 8.5-7s4.3 7 8.5 7"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
    back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg>`,
};

/* =========================================================
 * 主面板骨架
 * ========================================================= */

function buildUI() {
    if (document.getElementById('mw-app')) return;

    const app = document.createElement('div');
    app.id = 'mw-app';
    app.className = 'mw-closed';
    app.innerHTML = `
      <div class="mw-scrim" data-mw="close"></div>
      <div class="mw-sheet" role="dialog" aria-label="织忆记忆面板">
        <div class="mw-glow" aria-hidden="true"></div>

        <header class="mw-head">
          <div class="mw-brand">
            <span class="mw-orb" aria-hidden="true"></span>
            <span class="mw-titles"><strong>织忆</strong><em>MEMORY WEAVE</em></span>
          </div>
          <button class="mw-iconbtn" data-mw="close" aria-label="关闭">${ICON.close}</button>
        </header>

        <div class="mw-stats">
          <div class="mw-stat"><b data-mw="stat-total">0</b><span>记忆</span></div>
          <div class="mw-stat"><b data-mw="stat-floor">0</b><span>已整理</span></div>
          <div class="mw-stat"><b data-mw="stat-pending">0</b><span>待整理</span></div>
        </div>

        <nav class="mw-tabs">
          <button class="active" data-tab="timeline">时间线</button>
          <button data-tab="records">记录</button>
          <button data-tab="templates">模板</button>
          <button data-tab="settings">设置</button>
        </nav>

        <div class="mw-body">
          <section class="mw-panel" data-panel="timeline">
            <div class="mw-timeline" data-mw="timeline"></div>
            <div class="mw-empty" data-mw="empty" hidden>
              <div class="mw-empty-orb"></div>
              <p>还没有编织出记忆</p>
              <span>多发几轮对话，或切到「记录」填一张表</span>
            </div>
          </section>

          <section class="mw-panel" data-panel="records" hidden>
            <div data-mw="recordlist"></div>
            <div class="mw-empty" data-mw="rec-empty">
              <div class="mw-empty-orb"></div>
              <p>还没有填过表</p>
              <span>用模板把重要信息固定下来</span>
            </div>
          </section>

          <section class="mw-panel" data-panel="templates" hidden>
            <div data-mw="tplpanel"></div>
          </section>

          <section class="mw-panel" data-panel="settings" hidden>
            <div class="mw-group">
              <div class="mw-row">
                <div class="mw-row-main"><b>启用记忆</b><small>关闭后不再生成，也不再注入上下文</small></div>
                <label class="mw-switch"><input type="checkbox" data-opt="enabled"><i></i></label>
              </div>
              <div class="mw-row">
                <div class="mw-row-main"><b>自动编织</b><small>攒够一批对话后自动提炼</small></div>
                <label class="mw-switch"><input type="checkbox" data-opt="autoSummarize"><i></i></label>
              </div>
              <div class="mw-row">
                <div class="mw-row-main"><b>自动更新快照</b><small>每轮结束按模板重填一次，覆盖旧值</small></div>
                <label class="mw-switch"><input type="checkbox" data-opt="autoFillSnapshots"><i></i></label>
              </div>
              <div class="mw-row">
                <div class="mw-row-main"><b>用模型提炼</b><small>关闭则退化为本地截取，质量较差</small></div>
                <label class="mw-switch"><input type="checkbox" data-opt="useAI"><i></i></label>
              </div>
              <div class="mw-row">
                <div class="mw-row-main"><b>悬浮球</b><small>随时唤出这面板</small></div>
                <label class="mw-switch"><input type="checkbox" data-opt="showFab"><i></i></label>
              </div>
            </div>

            <div class="mw-group">
              <div class="mw-row mw-row-col">
                <div class="mw-row-main"><b>每批对话数</b><small>累积多少条触发一次自动编织：<span data-mw="val-batch">10</span></small></div>
                <input type="range" min="4" max="30" step="1" data-opt="batchSize">
              </div>
              <div class="mw-row mw-row-col">
                <div class="mw-row-main"><b>注入条数</b><small>每轮带给模型多少条记忆：<span data-mw="val-inject">6</span></small></div>
                <input type="range" min="2" max="15" step="1" data-opt="injectCount">
              </div>
              <div class="mw-row">
                <div class="mw-row-main"><b>记忆风格</b><small>影响提炼时的语气</small></div>
                <select data-opt="tone">
                  <option value="archive">档案 · 冷静客观</option>
                  <option value="diary">日记 · 带情绪</option>
                  <option value="relation">关系簿 · 只看人</option>
                </select>
              </div>
            </div>

            <div class="mw-group mw-danger">
              <button class="mw-btn mw-btn-danger" data-mw="clear">清空本角色的全部记忆</button>
            </div>
          </section>
        </div>

        <footer class="mw-foot" data-mw="foot">
          <button class="mw-btn mw-btn-primary" data-mw="weave">编织一次</button>
          <button class="mw-btn" data-mw="backfill">整理历史</button>
        </footer>

        <div class="mw-toast" data-mw="toast"></div>
      </div>
    `;
    document.body.appendChild(app);

    ui = {
        app,
        sheet: el('.mw-sheet', app),
        timeline: el('[data-mw="timeline"]', app),
        empty: el('[data-mw="empty"]', app),
        recordlist: el('[data-mw="recordlist"]', app),
        recEmpty: el('[data-mw="rec-empty"]', app),
        tplpanel: el('[data-mw="tplpanel"]', app),
        toast: el('[data-mw="toast"]', app),
        foot: el('[data-mw="foot"]', app),
        fab: null,
    };

    bindPanelEvents(app);
    syncSettingsUI();
    refreshAll();
}

function bindPanelEvents(app) {
    app.addEventListener('click', ev => {
        if (ev.target.closest('[data-mw="close"]')) { closePanel(); return; }

        const tab = ev.target.closest('[data-tab]');
        if (tab) { switchTab(tab.dataset.tab); return; }

        if (ev.target.closest('[data-mw="weave"]')) { manualWeave(); return; }
        if (ev.target.closest('[data-mw="backfill"]')) { backfillAll(); return; }
        if (ev.target.closest('[data-mw="clear"]')) { clearMemories(); return; }

        if (ev.target.closest('[data-mw="new-record"]')) { openForm(); return; }
        if (ev.target.closest('[data-mw="new-tpl"]')) { createTemplate(); return; }
        if (ev.target.closest('[data-mw="import-tpl"]')) { importTemplate(); return; }

        const snapEdit = ev.target.closest('[data-snap-edit]');
        if (snapEdit) { openSnapshotForm(snapEdit.dataset.snapEdit); return; }

        const snapClear = ev.target.closest('[data-snap-clear]');
        if (snapClear) {
            dropSnapshot(snapClear.dataset.snapClear);
            refreshAll();
            refreshInjection();
            toast('快照已清空');
            return;
        }

        const tplToggle = ev.target.closest('[data-tpl-toggle]');
        if (tplToggle) {
            toggleTemplateFlag(tplToggle.dataset.tplToggle, tplToggle.dataset.flag);
            return;
        }

        const tplEdit = ev.target.closest('[data-tpl-edit]');
        if (tplEdit) { openTemplateEditor(tplEdit.dataset.tplEdit); return; }

        const act = ev.target.closest('[data-act]');
        if (act) { handleCardAction(act); return; }

        const card = ev.target.closest('.mw-card');
        if (card && !ev.target.closest('.mw-card-act')) card.classList.toggle('expanded');
    });

    app.addEventListener('change', ev => {
        const opt = ev.target.closest('[data-opt]');
        if (opt) applyOption(opt);
    });

    app.addEventListener('input', ev => {
        const opt = ev.target.closest('input[type="range"][data-opt]');
        if (opt) applyOption(opt, true);
    });

    app.addEventListener('blur', ev => {
        const ta = ev.target.closest('.mw-edit');
        if (ta) commitNoteEdit(ta);
    }, true);

    app.addEventListener('keydown', ev => {
        const ta = ev.target.closest('.mw-edit');
        if (!ta) return;
        if (ev.key === 'Escape') { ta.dataset.cancelled = '1'; ta.blur(); }
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) ta.blur();
    });
}

/* =========================================================
 * 面板开关 / 标签页
 * ========================================================= */

function openPanel() {
    buildUI();
    ui.app.classList.add('mw-open');
    ui.app.classList.remove('mw-closed');
    document.body.classList.add('mw-locked');
    refreshAll();
}

function closePanel() {
    closeDrawer();
    if (!ui.app) return;
    ui.app.classList.remove('mw-open');
    ui.app.classList.add('mw-closed');
    document.body.classList.remove('mw-locked');
}

function switchTab(name) {
    els('[data-tab]', ui.app).forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    els('[data-panel]', ui.app).forEach(p => { p.hidden = p.dataset.panel !== name; });

    const map = {
        timeline: `<button class="mw-btn mw-btn-primary" data-mw="weave">编织一次</button>
                   <button class="mw-btn" data-mw="backfill">整理历史</button>`,
        records: `<button class="mw-btn mw-btn-primary" data-mw="new-record">＋ 新建记录</button>`,
        templates: `<button class="mw-btn mw-btn-primary" data-mw="new-tpl">＋ 新建模板</button>
                    <button class="mw-btn" data-mw="import-tpl">导入 JSON</button>`,
        settings: '',
    };
    ui.foot.innerHTML = map[name] ?? '';
    ui.foot.hidden = !ui.foot.innerHTML.trim();

    if (name === 'records') renderRecords();
    if (name === 'templates') renderTemplatePanel();
}

/* =========================================================
 * 设置项
 * ========================================================= */

function syncSettingsUI() {
    if (!ui.app) return;
    els('[data-opt]', ui.app).forEach(input => {
        const key = input.dataset.opt;
        if (input.type === 'checkbox') input.checked = !!S[key];
        else input.value = S[key];
    });
    const vb = el('[data-mw="val-batch"]');
    const vi = el('[data-mw="val-inject"]');
    if (vb) vb.textContent = S.batchSize;
    if (vi) vi.textContent = S.injectCount;
}

function applyOption(input, isRange = false) {
    const key = input.dataset.opt;
    if (input.type === 'checkbox') S[key] = input.checked;
    else if (input.type === 'range') S[key] = Number(input.value);
    else S[key] = input.value;

    if (key === 'batchSize') el('[data-mw="val-batch"]').textContent = S.batchSize;
    if (key === 'injectCount') el('[data-mw="val-inject"]').textContent = S.injectCount;
    if (key === 'showFab') toggleFab(S.showFab);
    if (key === 'enabled') refreshInjection();

    persist();
    if (!isRange) updateStats();
}

/* =========================================================
 * 时间线
 * ========================================================= */

function dayLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    const same = (a, b) => a.getFullYear() === b.getFullYear()
        && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

    if (same(d, now)) return '今天';
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (same(d, y)) return '昨天';
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

function clockLabel(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dotsMarkup(n) {
    let s = '';
    for (let i = 1; i <= 5; i++) s += `<i class="${i <= n ? 'on' : ''}"></i>`;
    return `<span class="mw-dots" title="重要度 ${n}/5">${s}</span>`;
}

function catClass(cat) {
    const i = CATEGORIES.indexOf(cat);
    return i >= 0 ? `cat-${i}` : '';
}

/* 记录卡的主体：按模板字段拆分 主/次 */
function recordCardHTML(r) {
    const tpl = getTemplate(r.templateId);
    const cat = recordCat(r);
    const mainFields = tpl.fields.filter(f => f.group === 'main' && !['title', 'category', 'tags'].includes(f.id));
    const extraFields = tpl.fields.filter(f => f.group === 'extra');
    const tags = Array.isArray(r.tags) ? r.tags : [];

    const renderField = f => {
        const v = r.values?.[f.id];
        if (!v) return '';
        return `<div><dt>${esc(f.label)}</dt><dd>${esc(v)}</dd></div>`;
    };

    const mainHTML = mainFields.map(renderField).join('');
    const extraHTML = extraFields.map(renderField).join('');
    const hasExtra = !!extraHTML;

    return `
      <div class="mw-card-top">
        <span class="mw-cat ${catClass(cat)}">${esc(cat)}</span>
        ${dotsMarkup(r.importance)}
        <time>${clockLabel(r.ts)}</time>
      </div>
      <h3 class="mw-rec-title">${esc(r.title)}</h3>
      ${mainHTML ? `<dl class="mw-rec-fields">${mainHTML}</dl>` : ''}
      ${hasExtra ? `<dl class="mw-rec-fields mw-rec-more">${extraHTML}</dl>
        <span class="mw-expand-hint">展开更多 ›</span>` : ''}
      ${tags.length ? `<div class="mw-tags">${tags.map(t => `<span>#${esc(t)}</span>`).join('')}</div>` : ''}
    `;
}

function noteCardHTML(m) {
    return `
      <div class="mw-card-top">
        <span class="mw-cat ${catClass(m.cat)}">${esc(m.cat)}</span>
        ${dotsMarkup(m.importance)}
        <time>${clockLabel(m.ts)}</time>
      </div>
      <p class="mw-text">${esc(m.text)}</p>
    `;
}

function cardHTML(m) {
    const isRec = m.kind === 'record';
    return `
      <article class="mw-item ${isRec ? 'is-record' : ''}" style="--i:0" data-id="${m.id}" data-kind="${m.kind}">
        <span class="mw-node" data-imp="${m.importance}"></span>
        <div class="mw-card">
          ${isRec ? recordCardHTML(m) : noteCardHTML(m)}
          <div class="mw-card-act">
            <button data-act="edit" data-id="${m.id}">${isRec ? '编辑' : '编辑'}</button>
            <button data-act="del" data-id="${m.id}">删除</button>
          </div>
        </div>
      </article>`;
}

function renderTimeline() {
    if (!ui.timeline) return;
    const mems = allMemories().sort((a, b) => b.ts - a.ts);

    if (!mems.length) {
        ui.timeline.innerHTML = '';
        if (ui.empty) ui.empty.hidden = false;
        return;
    }
    if (ui.empty) ui.empty.hidden = true;

    const groups = new Map();
    for (const m of mems) {
        const label = dayLabel(m.ts);
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(m);
    }

    let html = '';
    let i = 0;
    for (const [label, list] of groups) {
        html += `<div class="mw-day"><span>${esc(label)}</span></div>`;
        for (const m of list) {
            html += cardHTML(m).replace('--i:0', `--i:${Math.min(i, 14)}`);
            i++;
        }
    }
    ui.timeline.innerHTML = html;
}

function renderRecords() {
    if (!ui.recordlist) return;
    const recs = allMemories().filter(m => m.kind === 'record').sort((a, b) => b.ts - a.ts);

    if (!recs.length) {
        ui.recordlist.innerHTML = '';
        if (ui.recEmpty) ui.recEmpty.hidden = false;
        return;
    }
    if (ui.recEmpty) ui.recEmpty.hidden = true;

    const byTpl = new Map();
    for (const r of recs) {
        const key = r.templateId;
        if (!byTpl.has(key)) byTpl.set(key, []);
        byTpl.get(key).push(r);
    }

    let html = '';
    let i = 0;
    for (const [tplId, list] of byTpl) {
        const tpl = getTemplate(tplId);
        html += `<div class="mw-timeline">
                   <div class="mw-day"><span>${esc(tpl.name)} · ${list.length}</span></div>`;
        for (const r of list) {
            html += cardHTML(r).replace('--i:0', `--i:${Math.min(i, 12)}`);
            i++;
        }
        html += `</div>`;
    }
    ui.recordlist.innerHTML = html;
}

function updateStats() {
    if (!ui.app) return;
    const node = store();
    const set = (k, v) => {
        const n = el(`[data-mw="stat-${k}"]`);
        if (n) n.textContent = v;
    };
    set('total', node.memories.length);
    set('floor', node.cursor);
    set('pending', countPending());
}

function refreshAll() {
    if (!ui.app) return;
    renderTimeline();
    renderRecords();
    renderTemplatePanel();
    updateStats();
}

/* =========================================================
 * 卡片操作
 * ========================================================= */

function findMemory(id) {
    return store().memories.find(m => m.id === id);
}

function handleCardAction(btn) {
    const id = btn.dataset.id;
    const mem = findMemory(id);
    if (!mem) return;

    if (btn.dataset.act === 'edit') {
        if (mem.kind === 'record') { openForm(id); return; }
        const card = btn.closest('.mw-card');
        const p = el('.mw-text', card);
        if (!p || el('.mw-edit', card)) return;
        const ta = document.createElement('textarea');
        ta.className = 'mw-edit';
        ta.dataset.id = id;
        ta.value = mem.text;
        ta.rows = 3;
        p.replaceWith(ta);
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        return;
    }

    if (btn.dataset.act === 'del') {
        const node = store();
        const before = node.memories.slice();
        node.memories = node.memories.filter(m => m.id !== id);
        persist();
        refreshAll();
        refreshInjection();
        showUndoToast('已删除', () => {
            node.memories = before;
            persist();
            refreshAll();
            refreshInjection();
        });
    }
}

function showUndoToast(msg, onUndo) {
    if (!ui.toast) return;
    ui.toast.innerHTML = `<span>${esc(msg)}</span>`;
    const undo = document.createElement('button');
    undo.className = 'mw-undo';
    undo.textContent = '撤销';
    undo.onclick = () => { onUndo(); ui.toast.classList.remove('show'); };
    ui.toast.appendChild(undo);
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 4200);
}

function commitNoteEdit(ta) {
    if (!ta.isConnected) return;
    const mem = findMemory(ta.dataset.id);
    if (ta.dataset.cancelled === '1' || !mem) { refreshAll(); return; }
    const val = ta.value.replace(/\s+/g, ' ').trim();
    if (val && val !== mem.text) {
        mem.text = val.slice(0, 180);
        persist();
        refreshInjection();
        toast('已更新');
    }
    refreshAll();
}

function clearMemories() {
    const node = store();
    if (!node.memories.length) { toast('本来就是空的'); return; }
    const btn = el('[data-mw="clear"]', ui.app);
    if (btn.dataset.armed !== '1') {
        btn.dataset.armed = '1';
        btn.textContent = `确认清空 ${node.memories.length} 条？再点一次`;
        setTimeout(() => {
            btn.dataset.armed = '0';
            btn.textContent = '清空本角色的全部记忆';
        }, 4000);
        return;
    }
    const before = { memories: node.memories.slice(), cursor: node.cursor };
    node.memories = [];
    node.cursor = 0;
    btn.dataset.armed = '0';
    btn.textContent = '清空本角色的全部记忆';
    persist();
    refreshAll();
    refreshInjection();
    showUndoToast('已清空', () => {
        Object.assign(node, before);
        persist();
        refreshAll();
        refreshInjection();
    });
}

/* =========================================================
 * 填表抽屉
 * ========================================================= */

function ensureDrawer() {
    if (document.getElementById('mw-drawer')) return el('#mw-drawer');
    const d = document.createElement('div');
    d.id = 'mw-drawer';
    d.className = 'mw-drawer';
    d.innerHTML = `
      <div class="mw-drawer-scrim" data-dr="close"></div>
      <div class="mw-form" role="dialog" aria-label="记忆表单">
        <div class="mw-form-handle"></div>
        <header class="mw-form-head">
          <div style="flex:1;min-width:0">
            <h2 data-dr="title">新建记录<small data-dr="sub">GENERAL</small></h2>
          </div>
          <button class="mw-iconbtn" data-dr="close" aria-label="关闭">${ICON.close}</button>
        </header>
        <div class="mw-tplbar" data-dr="tplbar"></div>
        <div class="mw-form-body" data-dr="body"></div>
        <footer class="mw-form-foot">
          <button class="mw-btn" data-dr="cancel">取消</button>
          <button class="mw-btn mw-btn-primary" data-dr="save">保存</button>
        </footer>
      </div>`;
    ui.app.appendChild(d);

    d.addEventListener('click', ev => {
        if (ev.target.closest('[data-dr="close"]') || ev.target.closest('[data-dr="cancel"]')) { closeDrawer(); return; }
        if (ev.target.closest('[data-dr="save"]')) { saveDrawer(); return; }

        const more = ev.target.closest('[data-dr="more"]');
        if (more) {
            const box = el('.mw-more-fields', d);
            const open = box.classList.toggle('show');
            more.classList.toggle('up', open);
            const lbl = el('.lbl', more);
            if (lbl) lbl.textContent = open ? '收起' : '展开更多字段';
            return;
        }

        const rate = ev.target.closest('.mw-rating button');
        if (rate) {
            const wrap = rate.parentElement;
            const v = Number(rate.dataset.v);
            wrap.dataset.value = v;
            els('button', wrap).forEach(b => b.classList.toggle('on', Number(b.dataset.v) <= v));
            return;
        }

        const chipDel = ev.target.closest('.mw-taginput .chip button');
        if (chipDel) {
            const chip = chipDel.closest('.chip');
            const wrap = chip.parentElement;
            const tags = JSON.parse(wrap.dataset.tags || '[]').filter(t => t !== chip.dataset.v);
            wrap.dataset.tags = JSON.stringify(tags);
            renderChips(wrap, tags);
            return;
        }

        const addField = ev.target.closest('[data-tpl="add-field"]');
        if (addField) { draftTemplate.fields.push({ id: 'f_' + Date.now().toString(36), label: '新字段', type: 'text', group: 'main' }); paintTemplateEditor(); return; }

        const delField = ev.target.closest('[data-tpl="del-field"]');
        if (delField) {
            const idx = Number(delField.dataset.idx);
            draftTemplate.fields.splice(idx, 1);
            paintTemplateEditor();
            return;
        }

        const mvField = ev.target.closest('[data-tpl="move-field"]');
        if (mvField) {
            const idx = Number(mvField.dataset.idx);
            const dir = Number(mvField.dataset.dir);
            const arr = draftTemplate.fields;
            const j = idx + dir;
            if (j >= 0 && j < arr.length) {
                [arr[idx], arr[j]] = [arr[j], arr[idx]];
                paintTemplateEditor();
            }
            return;
        }

        const togField = ev.target.closest('[data-tpl="toggle-group"]');
        if (togField) {
            const idx = Number(togField.dataset.idx);
            const f = draftTemplate.fields[idx];
            f.group = f.group === 'main' ? 'extra' : 'main';
            paintTemplateEditor();
            return;
        }
    });

    d.addEventListener('input', ev => {
        const tin = ev.target.closest('[data-tpl="label"]');
        if (tin) { draftTemplate.fields[Number(tin.dataset.idx)].label = tin.value; return; }

        const opt = ev.target.closest('[data-tpl="options"]');
        if (opt) {
            draftTemplate.fields[Number(opt.dataset.idx)].options = opt.value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
            return;
        }

        const tagIn = ev.target.closest('.mw-taginput input');
        if (tagIn && /[,，]/.test(tagIn.value)) {
            const wrap = tagIn.parentElement;
            const tags = JSON.parse(wrap.dataset.tags || '[]');
            for (const p of tagIn.value.split(/[,，]+/).map(s => s.trim()).filter(Boolean)) {
                if (!tags.includes(p) && tags.length < 12) tags.push(p.slice(0, 14));
            }
            wrap.dataset.tags = JSON.stringify(tags);
            tagIn.value = '';
            renderChips(wrap, tags);
        }
    });

    d.addEventListener('change', ev => {
        const tsel = ev.target.closest('[data-tpl="type"]');
        if (tsel) {
            draftTemplate.fields[Number(tsel.dataset.idx)].type = tsel.value;
            paintTemplateEditor();
            return;
        }
        const tname = ev.target.closest('[data-tpl="name"]');
        if (tname) { draftTemplate.name = tname.value.trim() || '未命名模板'; return; }

        const tflag = ev.target.closest('[data-tpl="singleton"], [data-tpl="autofill"]');
        if (tflag) {
            draftTemplate[tflag.dataset.tpl] = tflag.checked;
            if (tflag.dataset.tpl === 'singleton' && !tflag.checked) {
                draftTemplate.autofill = false;
                const af = el('[data-tpl="autofill"]', d);
                if (af) af.checked = false;
            }
            return;
        }
    });

    d.addEventListener('keydown', ev => {
        const tagIn = ev.target.closest('.mw-taginput input');
        if (!tagIn) return;
        if (ev.key === 'Enter' || ev.key === ',') {
            ev.preventDefault();
            const wrap = tagIn.parentElement;
            const tags = JSON.parse(wrap.dataset.tags || '[]');
            const v = tagIn.value.trim().slice(0, 14);
            if (v && !tags.includes(v) && tags.length < 12) tags.push(v);
            wrap.dataset.tags = JSON.stringify(tags);
            tagIn.value = '';
            renderChips(wrap, tags);
        }
        if (ev.key === 'Backspace' && !tagIn.value) {
            const wrap = tagIn.parentElement;
            const tags = JSON.parse(wrap.dataset.tags || '[]');
            tags.pop();
            wrap.dataset.tags = JSON.stringify(tags);
            renderChips(wrap, tags);
        }
    });

    return d;
}

function openDrawer() {
    const d = ensureDrawer();
    d.classList.add('mw-open');
}

function closeDrawer() {
    const d = document.getElementById('mw-drawer');
    if (d) d.classList.remove('mw-open');
    editingRecordId = null;
    editingTemplateId = null;
    editingSnapshotTpl = null;
    draftTemplate = null;
}

function saveDrawer() {
    if (draftTemplate) return saveTemplate();
    return saveRecord();
}

/* ---------- 填表 ---------- */

function fieldInputHTML(f, value) {
    const v = value ?? '';
    const req = f.required ? '<span class="req">*</span>' : '';

    switch (f.type) {
        case 'textarea':
            return `<div class="mw-field">
                      <label>${esc(f.label)}${req}</label>
                      <textarea data-fid="${f.id}" rows="3" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>
                    </div>`;
        case 'select': {
            const opts = (f.options || CATEGORIES).map(o =>
                `<option value="${esc(o)}"${String(v) === o ? ' selected' : ''}>${esc(o)}</option>`).join('');
            return `<div class="mw-field">
                      <label>${esc(f.label)}${req}</label>
                      <select data-fid="${f.id}">${opts}</select>
                    </div>`;
        }
        case 'tags': {
            const tags = Array.isArray(value) ? value : [];
            return `<div class="mw-field">
                      <label>${esc(f.label)}${req}</label>
                      <div class="mw-taginput" data-fid="${f.id}" data-tags="${esc(JSON.stringify(tags))}">
                        ${tags.map(t => `<span class="chip" data-v="${esc(t)}">${esc(t)}<button type="button">×</button></span>`).join('')}
                        <input type="text" placeholder="${esc(f.placeholder || '输入后回车')}">
                      </div>
                    </div>`;
        }
        default:
            return `<div class="mw-field">
                      <label>${esc(f.label)}${req}</label>
                      <input type="text" data-fid="${f.id}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}">
                    </div>`;
    }
}

function openForm(recordId = null) {
    if (!ui.app) buildUI();
    if (!ui.app.classList.contains('mw-open')) openPanel();
    ensureDrawer();

    const rec = recordId ? findMemory(recordId) : null;
    editingRecordId = rec?.id || null;
    editingSnapshotTpl = null;

    const tplId = rec?.templateId || GENERAL_TEMPLATE.id;
    renderFormShell(rec, tplId, false);
    openDrawer();
}

/** 打开快照表单：同一个模板永远只有一条，保存即覆盖 */
function openSnapshotForm(tplId) {
    if (!ui.app) buildUI();
    if (!ui.app.classList.contains('mw-open')) openPanel();
    ensureDrawer();

    editingRecordId = null;
    editingSnapshotTpl = tplId;
    renderFormShell(getSnapshot(tplId), tplId, true);
    openDrawer();
}

function renderFormShell(rec, tplId, isSnapshot = false) {
    const d = el('#mw-drawer');
    const tpl = getTemplate(tplId);

    const headTitle = isSnapshot
        ? (rec ? '修改快照' : '填写快照')
        : (rec ? '编辑记录' : '新建记录');

    el('[data-dr="title"]', d).innerHTML = `${headTitle}<small>${esc(tpl.name)}</small>`;

    el('[data-dr="tplbar"]', d).innerHTML = (rec || isSnapshot)
        ? `${isSnapshot ? `<span class="mw-snapbar">最后更新 ${rec ? minuteLabel(rec.updatedTs) : '—'}</span>` : ''}
           <button data-dr="tpledit">编辑模板</button>`
        : `
      <select data-dr="tplsel">
        ${getTemplates().filter(t => !t.singleton).map(t => `<option value="${t.id}"${t.id === tplId ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}
      </select>
      <button data-dr="tpledit">编辑模板</button>`;

    const tplSel = el('[data-dr="tplsel"]', d);
    if (tplSel) {
        tplSel.onchange = () => renderFormShell(null, tplSel.value, false);
    }
    const tplEditBtn = el('[data-dr="tpledit"]', d);
    if (tplEditBtn) {
        tplEditBtn.onclick = () => openTemplateEditor(tpl.id);
    }

    const values = rec ? { ...(rec.values || {}) } : {};
    if (rec?.tags?.length) values.tags = rec.tags.slice();

    const mainFields = tpl.fields.filter(f => f.group === 'main');
    const extraFields = tpl.fields.filter(f => f.group === 'extra');

    const imp = rec?.importance ?? 3;

    const body = el('[data-dr="body"]', d);
    body.innerHTML = `
      ${mainFields.map(f => fieldInputHTML(f, values[f.id])).join('')}
      ${extraFields.length ? `
        <button class="mw-more-toggle" data-dr="more"><span class="arrow">▾</span><span class="lbl">展开更多字段</span></button>
        <div class="mw-more-fields">${extraFields.map(f => fieldInputHTML(f, values[f.id])).join('')}</div>` : ''}
      ${isSnapshot ? '' : `
      <div class="mw-field">
        <label>重要度</label>
        <div class="mw-rating" data-dr="rating" data-value="${imp}">
          ${[1, 2, 3, 4, 5].map(i => `<button type="button" class="${i <= imp ? 'on' : ''}" data-v="${i}"><i></i></button>`).join('')}
        </div>
      </div>`}
    `;
    body.scrollTop = 0;

    // 有已填内容的额外字段自动展开
    if (extraFields.some(f => values[f.id])) {
        const box = el('.mw-more-fields', d);
        const more = el('[data-dr="more"]', d);
        if (box) box.classList.add('show');
        if (more) {
            more.classList.add('up');
            const lbl = el('.lbl', more);
            if (lbl) lbl.textContent = '收起';
        }
    }
}

function collectValues() {
    const d = el('#mw-drawer');
    const values = {};
    let tags = [];
    let tagFieldId = null;

    els('[data-fid]', d).forEach(node => {
        const fid = node.dataset.fid;
        if (node.classList.contains('mw-taginput')) {
            tags = JSON.parse(node.dataset.tags || '[]');
            tagFieldId = fid;
        } else {
            values[fid] = node.value.trim();
        }
    });

    const rating = el('[data-dr="rating"]', d);
    return { values, tags, tagFieldId, importance: Number(rating?.dataset.value || 3) };
}

function saveRecord() {
    const d = el('#mw-drawer');

    // 快照分支：同一模板只写一条，直接覆盖
    if (editingSnapshotTpl) {
        const { values, tags, tagFieldId } = collectValues();
        if (tagFieldId) values[tagFieldId] = tags;

        if (!hasAnyValue(values)) { toast('至少填一项再保存'); return; }

        saveSnapshot(editingSnapshotTpl, values, { source: 'manual', replace: true });
        refreshInjection();
        refreshAll();
        closeDrawer();
        toast('快照已更新');
        return;
    }

    const tplId = el('[data-dr="tplsel"]', d)?.value
        || (editingRecordId ? findMemory(editingRecordId)?.templateId : GENERAL_TEMPLATE.id)
        || GENERAL_TEMPLATE.id;
    const tpl = getTemplate(tplId);

    const { values, tags, importance } = collectValues();
    const titleField = tpl.fields.find(f => f.id === 'title') || tpl.fields[0];
    const title = (values[titleField?.id] || '').trim();

    if (!title) {
        toast('标题不能为空');
        const input = el(`[data-fid="${titleField?.id}"]`, d);
        input?.focus();
        return;
    }

    if (editingRecordId) {
        const mem = findMemory(editingRecordId);
        if (mem) {
            mem.title = title.slice(0, 60);
            mem.values = values;
            mem.tags = tags;
            mem.importance = importance;
            mem.ts = mem.ts;
        }
        persist();
        refreshAll();
        refreshInjection();
        closeDrawer();
        toast('已更新');
        return;
    }

    pushMemories([mkRecord({ templateId: tplId, title, values, tags, importance })]);
    refreshInjection();
    refreshAll();
    closeDrawer();
    toast('记录已归档');
}

/* ---------- 模板编辑器 ---------- */

function openTemplateEditor(tplId, isNew = false) {
    buildUI();
    ensureDrawer();

    const base = getTemplate(tplId);

    if (isNew || base.builtin) {
        // 内置模板不允许原地修改，复制一份副本再编辑，未保存不会落库
        draftTemplate = newTemplateFrom(base, isNew ? '我的记忆表' : `${base.name} 副本`);
        if (!isNew) toast('内置模板已复制，改的是副本');
    } else {
        draftTemplate = { ...base, fields: base.fields.map(f => ({ ...f })) };
    }

    editingTemplateId = draftTemplate.id;
    paintTemplateEditor();
    openDrawer();
}

function paintTemplateEditor() {
    const d = el('#mw-drawer');
    el('[data-dr="title"]', d).innerHTML = `编辑模板<small>TEMPLATE</small>`;
    el('[data-dr="tplbar"]', d).innerHTML = `<span style="font-size:11.5px;color:var(--mw-faint)">字段越少，手机上填得越快</span>`;

    const body = el('[data-dr="body"]', d);
    body.innerHTML = `
      <div class="mw-field">
        <label>模板名称</label>
        <input type="text" data-tpl="name" value="${esc(draftTemplate.name)}">
      </div>

      <div class="mw-group" style="margin-bottom:14px">
        <div class="mw-row">
          <div class="mw-row-main"><b>快照模式</b><small>只保留最新一条，每次保存覆盖</small></div>
          <label class="mw-switch"><input type="checkbox" data-tpl="singleton"${draftTemplate.singleton ? ' checked' : ''}><i></i></label>
        </div>
        <div class="mw-row">
          <div class="mw-row-main"><b>每轮自动重填</b><small>从上一轮对话按字段提取，覆盖旧值</small></div>
          <label class="mw-switch"><input type="checkbox" data-tpl="autofill"${draftTemplate.autofill ? ' checked' : ''}><i></i></label>
        </div>
      </div>

      <div class="mw-group-title" style="padding-left:0">字段</div>
      <div data-tpl="fields">
        ${draftTemplate.fields.map((f, i) => `
          <div class="mw-fieldedit ${f.group === 'main' ? 'major' : ''}">
            <input type="text" data-tpl="label" data-idx="${i}" value="${esc(f.label)}">
            <select data-tpl="type" data-idx="${i}">
              ${FIELD_TYPES.map(t => `<option value="${t.v}"${t.v === f.type ? ' selected' : ''}>${t.label}</option>`).join('')}
            </select>
            <button class="mw-mini" data-tpl="toggle-group" data-idx="${i}" title="主字段/次字段">${f.group === 'main' ? '★' : '☆'}</button>
            <button class="mw-mini" data-tpl="move-field" data-idx="${i}" data-dir="-1" title="上移">↑</button>
            <button class="mw-mini" data-tpl="move-field" data-idx="${i}" data-dir="1" title="下移">↓</button>
            <button class="mw-mini" data-tpl="del-field" data-idx="${i}" title="删除">×</button>
          </div>
          ${f.type === 'select' ? `
            <div class="mw-field" style="margin:-2px 0 10px">
              <input type="text" data-tpl="options" data-idx="${i}"
                     value="${esc((f.options || []).join('，'))}" placeholder="选项，用逗号分隔">
            </div>` : ''}
        `).join('')}
      </div>
      <button class="mw-btn" data-tpl="add-field" style="width:100%;margin-top:4px">＋ 添加字段</button>
      <p style="font-size:11px;color:var(--mw-faint);line-height:1.6;margin:12px 2px 4px">
        ★ 表示主字段，直接显示在卡片上；☆ 表示次字段，折叠在「展开更多」里。
      </p>
    `;
    body.scrollTop = 0;
}

function saveTemplate() {
    if (!draftTemplate) return;
    const d = el('#mw-drawer');
    const nameInput = el('[data-tpl="name"]', d);
    if (nameInput) draftTemplate.name = nameInput.value.trim() || '未命名模板';

    if (!draftTemplate.fields.length) { toast('至少留一个字段'); return; }

    draftTemplate.fields.forEach((f, i) => {
        f.label = String(f.label || `字段${i + 1}`).slice(0, 16);
        f.id = f.id || 'f_' + i;
    });

    const idx = S.templates.findIndex(t => t.id === draftTemplate.id);
    if (idx >= 0) S.templates[idx] = { ...draftTemplate };
    else S.templates.push({ ...draftTemplate });

    persist();
    renderTemplatePanel();
    closeDrawer();
    toast('模板已保存');
}

/** 精确到分钟：当天只显示 HH:MM，跨天带月日 */
function minuteLabel(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const sameDay = d.getFullYear() === now.getFullYear()
        && d.getMonth() === now.getMonth()
        && d.getDate() === now.getDate();
    return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function renderTemplatePanel() {
    if (!ui.tplpanel) return;
    const list = getTemplates();

    ui.tplpanel.innerHTML = list.map(t => {
        const isSnap = !!t.singleton;
        const snap = isSnap ? getSnapshot(t.id) : null;

        const autoBtn = isSnap
            ? `<button class="mw-chipbtn ${t.autofill ? 'on' : ''}"
                       data-tpl-toggle="${t.id}" data-flag="autofill">${t.autofill ? '自动更新' : '仅手动'}</button>`
            : '';

        const mainBtn = isSnap
            ? `<button class="mw-chipbtn" data-snap-edit="${t.id}">${snap ? '修改' : '填写'}</button>`
            : `<button class="mw-chipbtn" data-tpl-edit="${t.id}">${t.builtin ? '复制' : '编辑'}</button>`;

        let body = '';
        if (isSnap) {
            if (snap && hasAnyValue(snap.values)) {
                const rows = t.fields
                    .map(f => {
                        const v = snap.values?.[f.id];
                        const str = Array.isArray(v) ? v.join('、') : v;
                        return str ? `<div><dt>${esc(f.label)}</dt><dd>${esc(String(str))}</dd></div>` : '';
                    })
                    .filter(Boolean)
                    .join('');

                body = `
                  <div class="mw-snap-meta">
                    <span class="mw-snap-time">更新于 ${minuteLabel(snap.updatedTs)}</span>
                    <span class="mw-snap-src ${snap.source === 'auto' ? 'auto' : ''}">${snap.source === 'auto' ? '自动' : '手动'}</span>
                    <button class="mw-snap-clear" data-snap-clear="${t.id}">清空</button>
                  </div>
                  <dl class="mw-snap-fields">${rows}</dl>`;
            } else {
                body = `<div class="mw-snap-empty">还没有内容 —— 聊完一轮会自动填进来</div>`;
            }
        }

        return `
          <div class="mw-tpl-card ${isSnap ? 'is-snap' : ''}">
            <div class="mw-tpl-head">
              <div class="mw-tpl-name">
                <b>${esc(t.name)}</b>
                ${t.builtin ? '<span class="mw-tag-mini">内置</span>' : ''}
                ${isSnap ? '<span class="mw-tag-mini snap">快照</span>' : ''}
              </div>
              <div class="mw-tpl-btns">${autoBtn}${mainBtn}</div>
            </div>
            <div class="mw-tpl-sub">${t.fields.length} 个字段${isSnap ? ' · 只保留最新一条' : ' · 每次新建一条'}</div>
            ${body}
          </div>`;
    }).join('');
}

function toggleTemplateFlag(tplId, flag) {
    const tpl = getTemplate(tplId);
    S.tplFlags = S.tplFlags || {};
    S.tplFlags[tplId] = { ...(S.tplFlags[tplId] || {}), [flag]: !tpl[flag] };
    persist();
    renderTemplatePanel();
    refreshInjection();
}

function createTemplate() {
    openTemplateEditor(GENERAL_TEMPLATE.id, true);
}

function importTemplate() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            const tpl = normalizeTemplate(data);
            if (!tpl) throw new Error('格式不对');
            S.templates.push(tpl);
            persist();
            renderTemplatePanel();
            toast(`已导入「${tpl.name}」`);
        } catch (e) {
            console.error('[织忆] 模板导入失败', e);
            toast('导入失败，检查一下 JSON');
        }
    };
    input.click();
}

function normalizeTemplate(data) {
    if (!data || !Array.isArray(data.fields) || !data.fields.length) return null;
    return {
        id: 'tpl_' + Date.now().toString(36),
        name: String(data.name || '导入的模板').slice(0, 24),
        builtin: false,
        singleton: !!data.singleton,
        autofill: !!data.autofill,
        fields: data.fields.slice(0, 24).map((f, i) => ({
            id: String(f.id || `f_${i}`),
            label: String(f.label || `字段${i + 1}`).slice(0, 16),
            type: FIELD_TYPES.some(t => t.v === f.type) ? f.type : 'text',
            group: f.group === 'extra' ? 'extra' : 'main',
            required: !!f.required,
            placeholder: String(f.placeholder || ''),
            options: Array.isArray(f.options) ? f.options.map(String) : undefined,
        })),
    };
}

/* =========================================================
 * 标签 chips
 * ========================================================= */

function renderChips(wrap, tags) {
    const input = el('input', wrap);
    els('.chip', wrap).forEach(c => c.remove());
    const frag = document.createDocumentFragment();
    for (const t of tags) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.dataset.v = t;
        chip.innerHTML = `${esc(t)}<button type="button">×</button>`;
        frag.appendChild(chip);
    }
    wrap.insertBefore(frag, input);
}

/* =========================================================
 * 悬浮球
 * ========================================================= */

function mountFab() {
    if (document.getElementById('mw-fab')) return;

    const fab = document.createElement('button');
    fab.id = 'mw-fab';
    fab.type = 'button';
    fab.title = '织忆';
    fab.innerHTML = `<span class="mw-fab-ring"></span>${ICON.weave}`;
    document.body.appendChild(fab);
    ui.fab = fab;

    if (S.fab && typeof S.fab.x === 'number') {
        fab.style.left = S.fab.x + 'px';
        fab.style.top = S.fab.y + 'px';
        fab.style.bottom = 'auto';
        fab.style.right = 'auto';
    }

    fab.addEventListener('pointerdown', onFabDown);
    fab.addEventListener('click', ev => {
        if (fabDrag?.moved) { ev.preventDefault(); ev.stopPropagation(); return; }
        openPanel();
    });
}

function toggleFab(show) {
    const fab = document.getElementById('mw-fab');
    if (show) { mountFab(); fab?.classList.remove('mw-hidden'); }
    else fab?.classList.add('mw-hidden');
}

function onFabDown(ev) {
    const fab = ev.currentTarget;
    const rect = fab.getBoundingClientRect();
    fabDrag = {
        moved: false,
        startX: ev.clientX,
        startY: ev.clientY,
        offsetX: ev.clientX - rect.left,
        offsetY: ev.clientY - rect.top,
    };
    fab.setPointerCapture(ev.pointerId);
    fab.addEventListener('pointermove', onFabMove);
    fab.addEventListener('pointerup', onFabUp);
}

function onFabMove(ev) {
    if (!fabDrag) return;
    const dx = ev.clientX - fabDrag.startX;
    const dy = ev.clientY - fabDrag.startY;
    if (!fabDrag.moved && Math.hypot(dx, dy) < 6) return;

    fabDrag.moved = true;
    const fab = document.getElementById('mw-fab');
    const size = fab.offsetWidth || 46;
    const x = Math.min(Math.max(ev.clientX - fabDrag.offsetX, 4), window.innerWidth - size - 4);
    const y = Math.min(Math.max(ev.clientY - fabDrag.offsetY, 4), window.innerHeight - size - 4);
    fab.style.left = x + 'px';
    fab.style.top = y + 'px';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
}

function onFabUp(ev) {
    const fab = ev.currentTarget;
    fab.removeEventListener('pointermove', onFabMove);
    fab.removeEventListener('pointerup', onFabUp);
    if (fabDrag?.moved) {
        const rect = fab.getBoundingClientRect();
        S.fab = { x: Math.round(rect.left), y: Math.round(rect.top) };
        persist();
    }
    setTimeout(() => { fabDrag = null; }, 0);
}

/* =========================================================
 * 扩展菜单入口
 * ========================================================= */

function mountMenuEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('mw-menu-item')) return;

    const item = document.createElement('div');
    item.id = 'mw-menu-item';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = `<span class="mw-menu-icon">${ICON.weave}</span><span>织忆 · 记忆</span>`;
    item.addEventListener('click', openPanel);
    menu.appendChild(item);
}

/* =========================================================
 * 事件
 * ========================================================= */

let autoTimer = null;
let fillTimer = null;

function scheduleAuto() {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => autoTick('auto'), 1500);
}

/** 快照更新排在编织之后，避免两条链路同时打模型 */
function scheduleFill() {
    clearTimeout(fillTimer);
    fillTimer = setTimeout(() => autoFillSnapshots(), 3000);
}

function onChatChanged() {
    refreshInjection();
    if (ui.app?.classList.contains('mw-open')) refreshAll();
}

function bindEvents() {
    const { eventSource, eventTypes } = ctx;

    eventSource.on(eventTypes.APP_READY, onReady);

    if (eventTypes.MESSAGE_RECEIVED) {
        eventSource.on(eventTypes.MESSAGE_RECEIVED, () => {
            updateStats();
            scheduleAuto();
            scheduleFill();
        });
    }
    if (eventTypes.MESSAGE_SENT) {
        eventSource.on(eventTypes.MESSAGE_SENT, () => {
            updateStats();
            scheduleAuto();
        });
    }
    if (eventTypes.CHAT_CHANGED) eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    if (eventTypes.GROUP_UPDATED) eventSource.on(eventTypes.GROUP_UPDATED, onChatChanged);
    if (eventTypes.GENERATION_AFTER_COMMANDS) {
        eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, refreshInjection);
    }
}

function onReady() {
    if (ready) return;
    ready = true;

    buildUI();
    if (S.showFab) mountFab();
    if (S.showMenuEntry) mountMenuEntry();
    refreshInjection();
    updateStats();

    console.log('[织忆] 已就绪 ·', chatKey());
}

/* =========================================================
 * 启动
 * ========================================================= */

async function init() {
    await ensureContext();
    loadSettings();
    bindEvents();

    setTimeout(() => { if (!ready) onReady(); }, 2000);

    globalThis.MemoryWeave = {
        open: openPanel,
        close: closePanel,
        form: () => openForm(),
        weave: manualWeave,
        backfill: backfillAll,
        fill: () => { store().fillSig = ''; return autoFillSnapshots(); },
        template: () => openTemplateEditor(GENERAL_TEMPLATE.id, true),
        get settings() { return S; },
        get store() { return store(); },
        exportTemplate() {
            return JSON.stringify(GENERAL_TEMPLATE, null, 2);
        },
        info() {
            const node = store();
            return {
                chatKey: chatKey(),
                memories: node.memories.length,
                records: node.memories.filter(m => m.kind === 'record').length,
                snapshots: Object.entries(node.snapshots).map(([id, s]) => ({
                    template: getTemplate(id).name,
                    updated: new Date(s.updatedTs).toLocaleString(),
                    filled: Object.keys(s.values || {}).length,
                })),
                cursor: node.cursor,
                pending: countPending(),
                templates: getTemplates().map(t => `${t.name}${t.singleton ? '[快照]' : ''}(${t.fields.length})`),
            };
        },
    };
}

init().catch(e => console.error('[织忆] 初始化失败', e));
