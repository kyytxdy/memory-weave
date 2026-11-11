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
    autoSummarize: true,      // 时间线：逐轮自动总结
    autoArc: true,            // 记录：每 N 轮自动大总结
    autoFillSnapshots: true,  // 每轮更新人物档案
    personTTL: 10,            // 超过这么多轮没出现就移除
    personMinImportance: 3,   // 低于这个重要度的新人物不建档
    useAI: true,
    beatEvery: 1,             // 每几轮生成一条短总结
    arcEvery: 10,             // 每几轮生成一条大总结
    injectBeats: 6,           // 注入多少条短总结
    injectArcs: 2,            // 注入多少条大总结
    maxKeep: 500,
    showFab: true,
    showMenuEntry: true,
    tone: 'archive',
    fab: null,
    templates: [],      // 用户自定义模板
    tplFlags: {},       // 内置模板的开关覆盖值 { [tplId]: { singleton, autofill } }
    chats: {},          // chatKey -> { beats[], arcs[], memos[], snapshots{}, beatMark, arcMark, fillSig }
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

/*
 * 人物档案：一个人一张卡。
 * scope 标记字段归属 —— self 只在主角卡出现，npc 只在其他人物卡出现，
 * 不写 scope 的是通用字段。自己看自己，和看别人，关心的东西本来就不同。
 */
const PERSON_TEMPLATE = {
    id: 'person',
    name: '人物档案',
    builtin: true,
    entity: true,
    keyField: 'name',
    autofill: true,
    fields: [
        { id: 'name', label: '姓名', type: 'text', group: 'main', required: true },
        { id: 'role', label: '身份', type: 'text', group: 'main', hint: '职业或社会角色，一句话说清' },
        { id: 'age', label: '年龄', type: 'text', group: 'main', hint: '对话里明确提到才写，不要推测' },
        { id: 'relation', label: '关系', type: 'text', group: 'main', scope: 'npc', hint: '和玩家角色的关系' },
        { id: 'attitude', label: '对我的态度', type: 'text', group: 'main', scope: 'npc', hint: '从语气和举动判断，不要猜内心' },
        { id: 'time', label: '时间', type: 'text', group: 'main', scope: 'self', hint: '故事内的第几天、什么时辰，如「第三天的深夜」' },
        { id: 'recent', label: '最近动态', type: 'textarea', group: 'main', hint: '这一轮里这个人做了什么' },
        { id: 'place', label: '所在地', type: 'text', group: 'extra', hint: '当前所在或常驻地' },
        { id: 'birthday', label: '生日', type: 'text', group: 'extra', hint: '对话里提到过才写，可以只写到季节' },
        { id: 'look', label: '外貌', type: 'text', group: 'extra', hint: '一眼能认出的特征，不要泛泛而谈' },
        { id: 'note', label: '备注', type: 'text', group: 'extra', hint: '其它值得留意的细节' },
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
let editingEntity = null;      // { tplId, key }
let draftEntity = null;        // 正在改某个人物的字段时：{ tplId, key }
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
    const base = [PERSON_TEMPLATE, ...S.templates];
    const flags = S.tplFlags || {};
    return base.map(t => (flags[t.id] ? { ...t, ...flags[t.id] } : t));
}

function entityTemplates() {
    return getTemplates().filter(t => t.entity && t.autofill);
}

function getTemplate(id) {
    return getTemplates().find(t => t.id === id) || PERSON_TEMPLATE;
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
    if (!S.chats[k]) S.chats[k] = {};
    const node = S.chats[k];
    if (!Array.isArray(node.memories)) node.memories = [];   // 旧版遗留，只保留不显示
    if (!Array.isArray(node.beats)) node.beats = [];
    if (!Array.isArray(node.arcs)) node.arcs = [];
    if (!Array.isArray(node.memos)) node.memos = [];
    if (typeof node.cursor !== 'number') node.cursor = 0;
    if (typeof node.inited !== 'boolean') node.inited = false;
    if (typeof node.beatMark !== 'number') node.beatMark = 0;   // 已总结到的 assistant 条数
    if (typeof node.arcMark !== 'number') node.arcMark = 0;
    if (!node.snapshots || typeof node.snapshots !== 'object') node.snapshots = {};
    if (!node.entities || typeof node.entities !== 'object') node.entities = {};
    if (typeof node.fillSig !== 'string') node.fillSig = '';
    return node;
}

/* ---------- 实体卡（一个人物一张） ---------- */

function entityPool(tplId) {
    const node = store();
    if (!node.entities[tplId] || typeof node.entities[tplId] !== 'object') {
        node.entities[tplId] = {};
    }
    return node.entities[tplId];
}

function listEntities(tplId) {
    return Object.values(entityPool(tplId))
        .sort((a, b) => (b.importance - a.importance) || (b.updatedTs - a.updatedTs));
}

function getEntity(tplId, key) {
    return entityPool(tplId)[key] || null;
}

function upsertEntity(tplId, key, values, importance, round) {
    const pool = entityPool(tplId);
    const prev = pool[key];
    const now = Date.now();

    // 空字段不覆盖旧值，模型这轮没提到不代表信息失效
    const merged = { ...(prev?.values || {}) };
    for (const [k, v] of Object.entries(values || {})) {
        if (v && String(v).trim()) merged[k] = String(v).trim().slice(0, 200);
    }

    pool[key] = {
        kind: 'entity',
        id: prev?.id || uid('e'),
        templateId: tplId,
        key,
        values: merged,
        importance: Math.max(Number(importance) || 0, prev?.importance || 0),
        fields: prev?.fields || getTemplate(tplId).fields.map(f => ({ ...f })),
        ts: prev?.ts || now,
        updatedTs: now,
        lastRound: round,
        source: 'auto',
    };
    persist();
    return pool[key];
}

function dropEntity(tplId, key) {
    const pool = entityPool(tplId);
    if (!pool[key]) return;
    delete pool[key];
    persist();
}

/** 超过 N 轮没出现的人物自动移除 */
function pruneEntities() {
    const total = assistantTotal();
    const ttl = Math.max(1, Number(S.personTTL) || 10);
    let removed = 0;

    for (const tpl of getTemplates().filter(t => t.entity)) {
        const pool = entityPool(tpl.id);
        for (const [key, e] of Object.entries(pool)) {
            const last = Number(e.lastRound) || 0;
            if (total - last > ttl) {
                delete pool[key];
                removed++;
            }
        }
    }
    if (removed) persist();
    return removed;
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

function allMemos() {
    return store().memos;
}

const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

/**
 * 清掉模型爱加的包装：代码块、引号、开场白、markdown 标题。
 * 之前每行都收进记忆，就是因为没做这一步。
 */
function cleanSummary(raw, maxLen = 400) {
    let t = String(raw || '').trim();

    t = t.replace(/^```[a-zA-Z]*\s*/i, '').replace(/```\s*$/, '');
    t = t.replace(/^["'“”「『]+/, '').replace(/["'“”」』]+$/, '');
    t = t.replace(/^(好的|好的，|以下是|这是|总结[：:]|摘要[：:]|概要[：:]|本轮[：:])\s*/g, '');
    t = t.replace(/^#{1,6}\s*/gm, '');
    t = t.replace(/^\s*[-*•]\s*/gm, '');
    t = t.replace(/\s+/g, ' ').trim();

    if (t.length > maxLen) t = t.slice(0, maxLen).replace(/[，、；,;。]$/, '') + '…';
    return t;
}

/** 明显不是总结的回复，直接判废，不写入 */
function isUsableSummary(t) {
    if (!t || t.length < 6) return false;
    if (/^(我无法|抱歉|作为(一个)?(AI|语言模型)|我不能)/.test(t)) return false;
    return true;
}

/** 时间线条目：一轮对话压成一句话，约 50 字 */
function mkBeat(text, from, to) {
    return {
        kind: 'beat',
        id: uid('b'),
        ts: Date.now(),
        text: cleanSummary(text, 200),
        from,
        to,
    };
}

/** 记录条目：跨多轮的大总结，约 200 字 */
function mkArc(text, from, to) {
    return {
        kind: 'arc',
        id: uid('a'),
        ts: Date.now(),
        text: cleanSummary(text, 900),
        from,
        to,
    };
}

/** 手动填的表 */
function mkMemo(payload) {
    return {
        kind: 'memo',
        id: uid('m'),
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

function pushCapped(key, item) {
    const node = store();
    node[key].push(item);
    if (node[key].length > S.maxKeep) node[key] = node[key].slice(-S.maxKeep);
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

/* =========================================================
 * 摘要引擎
 * 两层：beat（每轮 50 字）+ arc（每 N 轮 200 字，从 beat 合并而来）
 * ========================================================= */

/** 当前聊天里 AI 回复的条数，也就是"轮数" */
function assistantTotal() {
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    let n = 0;
    for (const m of chat) {
        if (m && !m.is_system && !m.is_user && m.mes && String(m.mes).trim()) n++;
    }
    return n;
}

/** 展开成带轮次序号的流：user 消息挂在它所属的那一轮上 */
function seqHistory() {
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const out = [];
    let seq = 0;
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m || m.is_system || !m.mes || !String(m.mes).trim()) continue;
        if (!m.is_user) seq++;
        out.push({ seq, index: i, msg: m });
    }
    return out;
}

function speakerOf(m) {
    if (m.is_user) return ctx.name1 || 'User';
    return m.name || ctx.name2 || 'Character';
}

function buildBeatPrompt(transcript) {
    return [
        '把下面这一段角色扮演对话压缩成一句话。',
        '',
        '要求：',
        '- 50 字左右，最多不超过 70 字。',
        '- 写清谁做了什么、结果如何，保留出现的人名和具体动作。',
        '- 用名字指代，不要用「他」「她」「对方」，否则过几轮就分不清是谁。',
        '- 不复述台词，不评价，不写「接着」「这一轮」「然后」这类过场词。',
        '- 直接输出正文。不要引号、不要标题、不要分点、不要任何解释。',
        '',
        '对话：',
        transcript,
    ].join('\n');
}

function buildArcPrompt(beats) {
    return [
        '下面是一段角色扮演中若干条按时间排列的短摘要。',
        '请把它们合并成一段完整的概要。',
        '',
        '要求：',
        '- 200 字左右，最多不超过 260 字。',
        '- 写清整体发生了什么、人物关系有什么变化、留下了什么悬念。',
        '- 用第三人称客观陈述，不评价，不复述台词。',
        '- 直接输出正文。不要标题、不要分点、不要任何解释。',
        '',
        '短摘要：',
        beats,
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

/** 生成一条时间线短总结，覆盖 fromRound..toRound */
async function generateBeat(fromRound, toRound) {
    const msgs = seqHistory().filter(x => x.seq >= fromRound && x.seq <= toRound);
    if (!msgs.length) return null;

    const transcript = msgs
        .map(r => `${speakerOf(r.msg)}：${String(r.msg.mes).trim().slice(0, 700)}`)
        .join('\n');

    let text = '';
    if (S.useAI) {
        text = cleanSummary(await aiCall(buildBeatPrompt(transcript), 200, 'memory-beat'), 200);
    }
    if (!isUsableSummary(text)) {
        // 模型不配合时退化成截取，至少不断链
        const joined = msgs.map(r => String(r.msg.mes).trim()).join(' ');
        text = cleanSummary(joined.slice(0, 60) + '…', 200);
    }
    if (!isUsableSummary(text)) return null;

    const beat = mkBeat(text, fromRound, toRound);
    pushCapped('beats', beat);
    return beat;
}

/** 生成一条大总结，把 arcMark 之后的 beat 合并，每 arcEvery 轮一次 */
async function generateArc() {
    const node = store();
    const total = assistantTotal();
    if (total - node.arcMark < S.arcEvery) return null;

    const from = node.arcMark + 1;
    const to = node.arcMark + S.arcEvery;
    const picked = node.beats.filter(b => b.rTo >= from && b.rTo <= to);

    node.arcMark = to;
    persist();

    if (!picked.length) return null;

    const list = picked.map((b, i) => `${i + 1}. ${b.text}`).join('\n');
    const text = cleanSummary(await aiCall(buildArcPrompt(list), 700, 'memory-arc'), 900);
    if (!isUsableSummary(text)) return null;

    const arc = mkArc(text, from, to);
    pushCapped('arcs', arc);
    return arc;
}/** 通用模型调用：三条通道依次降级，任何一条通了就用 */
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

/* =========================================================
 * 人物档案：每轮找人、填字段、清掉久未出现的
 * ========================================================= */

function buildPersonPrompt(transcript, tpl) {
    const keyId = tpl.keyField || 'name';
    const fmt = list => list.map(f => (f.hint ? `${f.label}（${f.hint}）` : f.label)).join('、');
    const common = fmt(tpl.fields.filter(f => !f.scope && f.id !== keyId));
    const npcOnly = fmt(tpl.fields.filter(f => f.scope === 'npc'));
    const selfOnly = fmt(tpl.fields.filter(f => f.scope === 'self'));
    const me = String(ctx.name1 || '').trim() || '玩家角色';

    return [
        '下面是一段角色扮演对话。请找出这段对话里出现的人物，为每个人物填写档案。',
        '',
        '输出格式（严格遵守，不要输出解释、不要代码块）：',
        '【人物名】重要度:1-5',
        '随后每行一条字段，格式为「字段名：内容」，不要加编号或符号。',
        '',
        `所有人物都要填的字段：${common}`,
        npcOnly ? `除「${me}」以外的人物，另外填：${npcOnly}` : '',
        selfOnly ? `如果这个人就是「${me}」（玩家自己），改填这些：${selfOnly}` : '',
        '',
        '重要度标准：',
        '5 = 主角或贯穿剧情的核心角色',
        '4 = 有名字、有独立台词、之后大概率还会出现',
        '3 = 有名字、有明确互动',
        '2 = 只被顺口提到一次',
        '1 = 背景路人',
        `重要度低于 ${S.personMinImportance} 的人物直接不输出。`,
        '',
        '规则：',
        '- 只写对话里明确出现的信息。没写的字段整行省略，不要写「未知」「无」「未提及」。',
        '- 不要编造外貌、年龄、生日、身世。没提到就空着。',
        '- 人称指代不明时宁可不写，也不要猜。',
        '',
        '对话：',
        transcript,
    ].filter(x => x !== '').join('\n');
}

function parsePeople(raw, tpl) {
    const labelToId = new Map(tpl.fields.map(f => [f.label, f.id]));
    const keyId = tpl.keyField || 'name';
    const out = [];

    for (const block of String(raw).split(/(?=【)/)) {
        const head = block.match(/^【\s*([^】]{1,20})\s*】\s*(?:重要度\s*[:：]\s*([1-5]))?/);
        if (!head) continue;

        const name = head[1].replace(/[「」“”"'']/g, '').trim();
        if (!name) continue;

        const values = { [keyId]: name };
        const allowed = new Set(visibleFields(tpl, isSelfName(name)).map(f => f.id));

        for (const line of block.split(/\r?\n/).slice(1)) {
            const m = line.trim().match(/^[-*•\s]*([^：:]{1,12})\s*[：:]\s*(.+)$/);
            if (!m) continue;

            const fid = labelToId.get(m[1].trim());
            if (!fid || fid === keyId || !allowed.has(fid)) continue;

            const val = m[2].trim().slice(0, 200);
            if (!val || /^(无|未知|未提及|不明|不详|n\/a|none|-|—)$/i.test(val)) continue;
            values[fid] = val;
        }

        out.push({ name, importance: Number(head[2]) || 3, values });
    }
    return out;
}

async function autoUpdatePeople() {
    if (!ready || filling || weaving || !S.enabled || !S.autoFillSnapshots) return;

    const tpls = entityTemplates();
    if (!tpls.length) return;

    const round = lastRoundMessages();
    if (!round.length) return;

    // 同一轮不重复跑
    const sig = round.map(r => r.index).join(',');
    const node = store();
    if (node.fillSig === sig) return;
    node.fillSig = sig;
    persist();

    filling = true;
    try {
        const transcript = round
            .map(r => `${speakerOf(r.msg)}：${String(r.msg.mes).trim().slice(0, 600)}`)
            .join('\n');
        const roundNo = assistantTotal();

        for (const tpl of tpls) {
            try {
                const raw = await aiCall(buildPersonPrompt(transcript, tpl), 900, 'memory-person');
                if (!raw) continue;

                const people = parsePeople(raw, tpl);
                for (const p of people) {
                    if (p.importance < S.personMinImportance) continue;
                    upsertEntity(tpl.id, p.name, p.values, p.importance, roundNo);
                }
            } catch (e) {
                console.warn('[织忆] 人物提取失败', tpl.name, e);
            }
        }

        const removed = pruneEntities();
        refreshAll();
        refreshInjection();
        if (removed) console.log(`[织忆] 移除 ${removed} 个超过 ${S.personTTL} 轮未出现的人物`);
    } finally {
        filling = false;
    }
}

/* =========================================================
 * 自动记忆
 * ========================================================= */

/* =========================================================
 * 自动总结调度
 * ========================================================= */

/**
 * 首次接入某个聊天时，把游标对齐到当前轮次。
 * 否则一装好就欠着全部历史，点「补全部」会跑几十上百次模型调用。
 */
function initChatCursor() {
    const node = store();
    if (node.inited) return;
    node.inited = true;
    if (node.beatMark === 0 && assistantTotal() > 0) {
        node.beatMark = assistantTotal();
        node.arcMark = node.beatMark;
    }
    persist();
}

function pendingRounds() {
    return Math.max(0, assistantTotal() - store().beatMark);
}

/** 走一步：先补一条 beat，够数就再合并一条 arc */
async function stepWeave(force = false) {
    const node = store();
    const total = assistantTotal();
    const span = Math.max(1, Number(S.beatEvery) || 1);

    if (total <= node.beatMark) return { beat: null, arc: null };
    if (!force && total - node.beatMark < span) return { beat: null, arc: null };

    const from = node.beatMark + 1;
    const to = Math.min(node.beatMark + span, total);

    const beat = await generateBeat(from, to);
    node.beatMark = to;
    persist();

    let arc = null;
    if (S.autoArc) {
        try {
            arc = await generateArc();
        } catch (e) {
            console.warn('[织忆] 大总结生成失败', e);
        }
    }
    return { beat, arc };
}

async function autoTick() {
    if (!ready || weaving || filling) return;
    if (!S.enabled || !S.autoSummarize) return;
    if (pendingRounds() < Math.max(1, Number(S.beatEvery) || 1)) return;

    weaving = true;
    setBusyState(true);
    try {
        const { beat, arc } = await stepWeave();
        if (beat || arc) {
            refreshInjection();
            refreshAll();
            if (arc) toast('大总结已更新');
            else if (beat) toast('记下一条');
        }
    } catch (e) {
        console.error('[织忆] 自动总结失败', e);
    } finally {
        weaving = false;
        setBusyState(false);
        updateStats();
    }
}

async function backfillAll() {
    if (weaving) { toast('正在处理中…'); return; }
    if (!pendingRounds()) { toast('没有待整理的对话'); return; }

    weaving = true;
    setBusyState(true);
    let n = 0;
    try {
        for (let guard = 0; guard < 300; guard++) {
            if (!pendingRounds()) break;
            const { beat, arc } = await stepWeave(true);
            if (beat) n++;
            if (arc) n++;
            toast(`已整理到第 ${store().beatMark} 轮…`);
        }
        refreshInjection();
        refreshAll();
        toast(n ? `整理完成，新增 ${n} 条` : '没有可整理的内容');
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
    if (weaving) { toast('正在处理中…'); return; }
    if (!pendingRounds()) { toast('没有新的对话可总结'); return; }

    weaving = true;
    setBusyState(true);
    try {
        const { beat, arc } = await stepWeave(true);
        refreshInjection();
        refreshAll();
        if (arc) toast('大总结已更新');
        else if (beat) toast('记下一条');
        else toast('这一轮没什么可记的');
    } catch (e) {
        console.error('[织忆] 手动总结失败', e);
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

    const node = store();
    const snap = snapshotBlock();

    const arcs = node.arcs.slice(-Math.max(1, Number(S.injectArcs) || 2));
    const beats = node.beats.slice(-Math.max(1, Number(S.injectBeats) || 6));
    const memos = node.memos.slice(-3);

    const parts = ['<long_term_memory>'];
    let has = false;

    if (snap) {
        parts.push(snap, '');
        has = true;
    }

    if (arcs.length) {
        parts.push('剧情概要（由早到晚）：');
        for (const a of arcs) parts.push(`- ${a.text}`);
        parts.push('');
        has = true;
    }

    if (beats.length) {
        parts.push('最近的经过（由早到晚）：');
        for (const b of beats) parts.push(`- ${b.text}`);
        parts.push('');
        has = true;
    }

    if (memos.length) {
        parts.push('你记下的条目：');
        for (const m of memos) parts.push(`- 【${recordCat(m)}】${recordLine(m)}`);
        parts.push('');
        has = true;
    }

    if (!has) return clear();

    parts.push('回应时保持连贯，但不要直接复述以上内容，也不要说"根据我的记忆"。');
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
          <div class="mw-stat"><b data-mw="stat-total">0</b><span>条目</span></div>
          <div class="mw-stat"><b data-mw="stat-floor">0</b><span>已记录</span></div>
          <div class="mw-stat"><b data-mw="stat-pending">0</b><span>待总结</span></div>
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
              <p>时间线还是空的</p>
              <span>每轮对话会自动记一条，也可以点下方手动补</span>
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
                <div class="mw-row-main"><b>时间线自动记录</b><small>每 N 轮压成一句话放进时间线</small></div>
                <label class="mw-switch"><input type="checkbox" data-opt="autoSummarize"><i></i></label>
              </div>
              <div class="mw-row">
                <div class="mw-row-main"><b>大总结自动合并</b><small>攒够间隔后合并成一段长概要</small></div>
                <label class="mw-switch"><input type="checkbox" data-opt="autoArc"><i></i></label>
              </div>
              <div class="mw-row">
                <div class="mw-row-main"><b>自动建档人物</b><small>每轮从对话里找人，判定重要度后建档</small></div>
                <label class="mw-switch"><input type="checkbox" data-opt="autoFillSnapshots"><i></i></label>
              </div>
              <div class="mw-row">
                <div class="mw-row-main"><b>用模型总结</b><small>关闭则退化为截取原文，质量较差</small></div>
                <label class="mw-switch"><input type="checkbox" data-opt="useAI"><i></i></label>
              </div>
              <div class="mw-row">
                <div class="mw-row-main"><b>悬浮球</b><small>随时唤出这面板</small></div>
                <label class="mw-switch"><input type="checkbox" data-opt="showFab"><i></i></label>
              </div>
            </div>

            <div class="mw-group">
              <div class="mw-row mw-row-col">
                <div class="mw-row-main"><b>时间线间隔</b><small>每 <span data-mw="val-beat">1</span> 轮记一条短总结</small></div>
                <input type="range" min="1" max="10" step="1" data-opt="beatEvery">
              </div>
              <div class="mw-row mw-row-col">
                <div class="mw-row-main"><b>大总结间隔</b><small>每 <span data-mw="val-arc">10</span> 轮合并一段长概要</small></div>
                <input type="range" min="5" max="60" step="5" data-opt="arcEvery">
              </div>
              <div class="mw-row mw-row-col">
                <div class="mw-row-main"><b>注入条数</b><small>带 <span data-mw="val-inject">6</span> 条短总结进上下文</small></div>
                <input type="range" min="2" max="20" step="1" data-opt="injectBeats">
              </div>
              <div class="mw-row mw-row-col">
                <div class="mw-row-main"><b>人物保留</b><small>超过 <span data-mw="val-ttl">10</span> 轮没出现就移除</small></div>
                <input type="range" min="3" max="40" step="1" data-opt="personTTL">
              </div>
              <div class="mw-row mw-row-col">
                <div class="mw-row-main"><b>建档门槛</b><small>重要度 ≥ <span data-mw="val-imp">3</span> 才建表，5 最难</small></div>
                <input type="range" min="1" max="5" step="1" data-opt="personMinImportance">
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
          <button class="mw-btn mw-btn-primary" data-mw="weave">记一条</button>
          <button class="mw-btn" data-mw="backfill">补全部</button>
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

        const personHead = ev.target.closest('[data-person-toggle]');
        if (personHead) {
            const row = personHead.closest('.mw-person');
            const tk = row?.dataset.tk;
            if (tk) {
                const open = row.classList.toggle('open');
                if (open) openPeople.add(tk);
                else openPeople.delete(tk);
            }
            return;
        }

        const personEdit = ev.target.closest('[data-person-edit]');
        if (personEdit) { openPersonForm(personEdit.dataset.tpl, personEdit.dataset.key); return; }

        const personDel = ev.target.closest('[data-person-del]');
        if (personDel) {
            const { tpl, key } = personDel.dataset;
            const pool = entityPool(tpl);
            const saved = pool[key];
            dropEntity(tpl, key);
            openPeople.delete(`${tpl}::${key}`);
            refreshAll();
            refreshInjection();
            showUndoToast('已移除', () => {
                if (saved) {
                    pool[key] = saved;
                    persist();
                    refreshAll();
                    refreshInjection();
                }
            });
            return;
        }

        const personFields = ev.target.closest('[data-person-fields]');
        if (personFields) { openEntityFieldEditor(personFields.dataset.tpl, personFields.dataset.key); return; }

        const personAdd = ev.target.closest('[data-person-add]');
        if (personAdd) { openPersonForm(personAdd.dataset.personAdd, null); return; }

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
        timeline: `<button class="mw-btn mw-btn-primary" data-mw="weave">记一条</button>
                   <button class="mw-btn" data-mw="backfill">补全部</button>`,
        records: '',
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
    const vb = el('[data-mw="val-beat"]');
    const va = el('[data-mw="val-arc"]');
    const vi = el('[data-mw="val-inject"]');
    const vt = el('[data-mw="val-ttl"]');
    const vimp = el('[data-mw="val-imp"]');
    if (vb) vb.textContent = S.beatEvery;
    if (va) va.textContent = S.arcEvery;
    if (vi) vi.textContent = S.injectBeats;
    if (vt) vt.textContent = S.personTTL;
    if (vimp) vimp.textContent = S.personMinImportance;
}

function applyOption(input, isRange = false) {
    const key = input.dataset.opt;
    if (input.type === 'checkbox') S[key] = input.checked;
    else if (input.type === 'range') S[key] = Number(input.value);
    else S[key] = input.value;

    if (key === 'beatEvery') el('[data-mw="val-beat"]').textContent = S.beatEvery;
    if (key === 'arcEvery') el('[data-mw="val-arc"]').textContent = S.arcEvery;
    if (key === 'injectBeats') el('[data-mw="val-inject"]').textContent = S.injectBeats;
    if (key === 'personTTL') el('[data-mw="val-ttl"]').textContent = S.personTTL;
    if (key === 'personMinImportance') el('[data-mw="val-imp"]').textContent = S.personMinImportance;
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
/* 手动填的表 */
function memoCardHTML(r) {
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

    return `
      <div class="mw-card-top">
        <span class="mw-cat ${catClass(cat)}">${esc(cat)}</span>
        <span class="mw-round memo">手记</span>
        <time>${clockLabel(r.ts)}</time>
      </div>
      <h3 class="mw-rec-title">${esc(r.title)}</h3>
      ${mainHTML ? `<dl class="mw-rec-fields">${mainHTML}</dl>` : ''}
      ${extraHTML ? `<dl class="mw-rec-fields mw-rec-more">${extraHTML}</dl>
        <span class="mw-expand-hint">展开更多 ›</span>` : ''}
      ${tags.length ? `<div class="mw-tags">${tags.map(t => `<span>#${esc(t)}</span>`).join('')}</div>` : ''}
    `;
}

/* 时间线条目：一句话 */
function beatCardHTML(b) {
    return `
      <div class="mw-card-top">
        <span class="mw-round">第 ${b.to ?? '?'} 轮</span>
        <time>${clockLabel(b.ts)}</time>
      </div>
      <p class="mw-text">${esc(b.text)}</p>
    `;
}

/* 大总结 */
function arcCardHTML(a) {
    return `
      <div class="mw-card-top">
        <span class="mw-round arc">第 ${a.from}–${a.to} 轮</span>
        <time>${clockLabel(a.ts)}</time>
      </div>
      <p class="mw-arc-text">${esc(a.text)}</p>
    `;
}

function cardHTML(item) {
    const kind = item.kind;
    const body = kind === 'arc' ? arcCardHTML(item)
        : kind === 'memo' ? memoCardHTML(item)
            : beatCardHTML(item);

    return `
      <article class="mw-item is-${kind}" style="--i:0" data-id="${item.id}" data-kind="${kind}">
        <span class="mw-node"></span>
        <div class="mw-card">
          ${body}
          <div class="mw-card-act">
            <button data-act="edit" data-id="${item.id}">编辑</button>
            <button data-act="del" data-id="${item.id}">删除</button>
          </div>
        </div>
      </article>`;
}

function renderTimeline() {
    if (!ui.timeline) return;
    const node = store();
    const items = [
        ...node.beats.map(b => ({ ...b, kind: 'beat' })),
        ...node.memos.map(m => ({ ...m, kind: 'memo' })),
    ].sort((a, b) => b.ts - a.ts);

    if (!items.length) {
        ui.timeline.innerHTML = '';
        if (ui.empty) ui.empty.hidden = false;
        return;
    }
    if (ui.empty) ui.empty.hidden = true;

    const groups = new Map();
    for (const m of items) {
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
    const arcs = [...store().arcs].sort((a, b) => b.ts - a.ts);

    if (!arcs.length) {
        ui.recordlist.innerHTML = '';
        if (ui.recEmpty) {
            ui.recEmpty.hidden = false;
            const p = el('p', ui.recEmpty);
            if (p) p.textContent = '还没有大总结';
            const s = el('span', ui.recEmpty);
            if (s) s.textContent = `聊满 ${S.arcEvery} 轮会自动合并一条`;
        }
        return;
    }
    if (ui.recEmpty) ui.recEmpty.hidden = true;

    let html = `<div class="mw-timeline">`;
    let i = 0;
    for (const a of arcs) {
        html += cardHTML({ ...a, kind: 'arc' }).replace('--i:0', `--i:${Math.min(i, 12)}`);
        i++;
    }
    html += `</div>`;
    ui.recordlist.innerHTML = html;
}

function updateStats() {
    if (!ui.app) return;
    const node = store();
    const set = (k, v) => {
        const n = el(`[data-mw="stat-${k}"]`);
        if (n) n.textContent = v;
    };
    set('total', node.beats.length + node.arcs.length + node.memos.length);
    set('floor', node.beatMark);
    set('pending', pendingRounds());
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

function findItem(id) {
    const node = store();
    return node.beats.find(x => x.id === id)
        || node.arcs.find(x => x.id === id)
        || node.memos.find(x => x.id === id)
        || null;
}

function handleCardAction(btn) {
    const id = btn.dataset.id;
    const item = findItem(id);
    if (!item) return;

    if (btn.dataset.act === 'edit') {
        if (item.kind === 'memo') { openForm(id); return; }
        const card = btn.closest('.mw-card');
        const p = el('.mw-text, .mw-arc-text', card);
        if (!p || el('.mw-edit', card)) return;
        const ta = document.createElement('textarea');
        ta.className = 'mw-edit';
        ta.dataset.id = id;
        ta.value = item.text;
        ta.rows = item.kind === 'arc' ? 6 : 3;
        p.replaceWith(ta);
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        return;
    }

    if (btn.dataset.act === 'del') {
        const node = store();
        const key = item.kind === 'arc' ? 'arcs' : item.kind === 'memo' ? 'memos' : 'beats';
        const before = node[key].slice();
        node[key] = node[key].filter(x => x.id !== id);
        persist();
        refreshAll();
        refreshInjection();
        showUndoToast('已删除', () => {
            node[key] = before;
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
    const item = findItem(ta.dataset.id);
    if (ta.dataset.cancelled === '1' || !item) { refreshAll(); return; }
    const val = ta.value.replace(/\s+/g, ' ').trim();
    if (val && val !== item.text) {
        item.text = val.slice(0, item.kind === 'arc' ? 900 : 200);
        persist();
        refreshInjection();
        toast('已更新');
    }
    refreshAll();
}

function clearMemories() {
    const node = store();
    const total = node.beats.length + node.arcs.length + node.memos.length + node.memories.length;
    if (!total) { toast('本来就是空的'); return; }

    const btn = el('[data-mw="clear"]', ui.app);
    if (btn.dataset.armed !== '1') {
        btn.dataset.armed = '1';
        btn.textContent = `确认清空 ${total} 条？再点一次`;
        setTimeout(() => {
            btn.dataset.armed = '0';
            btn.textContent = '清空本角色的全部记忆';
        }, 4000);
        return;
    }

    const before = {
        beats: node.beats.slice(),
        arcs: node.arcs.slice(),
        memos: node.memos.slice(),
        memories: node.memories.slice(),
        beatMark: node.beatMark,
        arcMark: node.arcMark,
        cursor: node.cursor,
    };

    node.beats = [];
    node.arcs = [];
    node.memos = [];
    node.memories = [];
    node.beatMark = 0;
    node.arcMark = 0;
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

        const thint = ev.target.closest('[data-tpl="hint"]');
        if (thint) {
            draftTemplate.fields[Number(thint.dataset.idx)].hint = thint.value;
            return;
        }

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
        const tscope = ev.target.closest('[data-tpl="scope"]');
        if (tscope) {
            const f = draftTemplate.fields[Number(tscope.dataset.idx)];
            f.scope = tscope.value || undefined;
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
    editingEntity = null;
    draftEntity = null;
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

    const found = recordId ? findItem(recordId) : null;
    const rec = found && found.kind === 'memo' ? found : null;
    editingRecordId = rec?.id || null;
    editingSnapshotTpl = null;

    const tplId = rec?.templateId || PERSON_TEMPLATE.id;
    renderFormShell(rec, tplId, 'record');
    openDrawer();
}

/** 打开快照表单：同一个模板永远只有一条，保存即覆盖 */
function openSnapshotForm(tplId) {
    if (!ui.app) buildUI();
    if (!ui.app.classList.contains('mw-open')) openPanel();
    ensureDrawer();

    editingRecordId = null;
    editingSnapshotTpl = tplId;
    editingEntity = null;
    renderFormShell(getSnapshot(tplId), tplId, 'snapshot');
    openDrawer();
}

/** 打开人物表单：key 存在则编辑，否则新建 */
function openPersonForm(tplId, key) {
    if (!ui.app) buildUI();
    if (!ui.app.classList.contains('mw-open')) openPanel();
    ensureDrawer();

    editingRecordId = null;
    editingSnapshotTpl = null;
    editingEntity = { tplId, key: key || null };

    renderFormShell(key ? getEntity(tplId, key) : null, tplId, 'entity');
    openDrawer();
}

function renderFormShell(rec, tplId, mode = 'record') {
    const d = el('#mw-drawer');
    const tpl = getTemplate(tplId);
    const isSnapshot = mode === 'snapshot';
    const isEntity = mode === 'entity';

    const headTitle = isEntity
        ? (rec ? '编辑人物' : '新建人物')
        : isSnapshot
            ? (rec ? '修改快照' : '填写快照')
            : (rec ? '编辑记录' : '新建记录');

    el('[data-dr="title"]', d).innerHTML = `${headTitle}<small>${esc(tpl.name)}</small>`;

    el('[data-dr="tplbar"]', d).innerHTML = (rec || isSnapshot || isEntity)
        ? `${isSnapshot ? `<span class="mw-snapbar">最后更新 ${rec ? minuteLabel(rec.updatedTs) : '—'}</span>` : ''}
           ${isEntity && rec ? `<span class="mw-snapbar">上次出现 第 ${rec.lastRound || '?'} 轮</span>` : ''}
           <button data-dr="tpledit">编辑模板</button>`
        : `
      <select data-dr="tplsel">
        ${getTemplates().filter(t => !t.singleton && !t.entity).map(t => `<option value="${t.id}"${t.id === tplId ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}
      </select>
      <button data-dr="tpledit">编辑模板</button>`;

    const tplSel = el('[data-dr="tplsel"]', d);
    if (tplSel) {
        tplSel.onchange = () => renderFormShell(null, tplSel.value, 'record');
    }
    const tplEditBtn = el('[data-dr="tpledit"]', d);
    if (tplEditBtn) {
        tplEditBtn.onclick = () => openTemplateEditor(tpl.id);
    }

    const values = rec ? { ...(rec.values || {}) } : {};
    if (rec?.tags?.length) values.tags = rec.tags.slice();

    let fieldSet = tpl.fields;
    if (isEntity && rec) {
        const recName = rec.values?.[tpl.keyField || 'name'] || rec.key;
        const base = rec.fields ? { ...tpl, fields: rec.fields } : tpl;
        fieldSet = visibleFields(base, isSelfName(recName));
    }
    const mainFields = fieldSet.filter(f => f.group === 'main');
    const extraFields = fieldSet.filter(f => f.group === 'extra');

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

    // 编辑人物时锁住名字，避免改名产生重复卡
    if (isEntity && rec) {
        const keyInput = el(`[data-fid="${tpl.keyField}"]`, d);
        if (keyInput) {
            keyInput.readOnly = true;
            keyInput.style.opacity = '0.55';
        }
    }

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

    // 人物分支
    if (editingEntity) {
        const tpl = getTemplate(editingEntity.tplId);
        const { values, tags, tagFieldId } = collectValues();
        if (tagFieldId) values[tagFieldId] = tags;

        const keyId = tpl.keyField || 'name';
        const name = String(values[keyId] || '').trim();
        if (!name) { toast('名字不能为空'); return; }

        const rating = el('[data-dr="rating"]', d);
        const imp = Number(rating?.dataset.value || 3);

        upsertEntity(editingEntity.tplId, name, values, imp, assistantTotal());
        refreshInjection();
        refreshAll();
        closeDrawer();
        toast('已保存');
        return;
    }

    const tplId = el('[data-dr="tplsel"]', d)?.value
        || (editingRecordId ? findItem(editingRecordId)?.templateId : PERSON_TEMPLATE.id)
        || PERSON_TEMPLATE.id;
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
        const mem = findItem(editingRecordId);
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

    pushCapped('memos', mkMemo({ templateId: tplId, title, values, tags, importance }));
    refreshInjection();
    refreshAll();
    closeDrawer();
    toast('记录已归档');
}

/* ---------- 模板编辑器 ---------- */

/** 单独改某个人物的字段：复制一份到他自己身上，不动模板 */
function openEntityFieldEditor(tplId, key) {
    if (!ui.app) buildUI();
    if (!ui.app.classList.contains('mw-open')) openPanel();
    ensureDrawer();

    const ent = getEntity(tplId, key);
    if (!ent) return;

    const base = ent.fields || getTemplate(tplId).fields;
    const name = ent.values?.['name'] || key;

    draftTemplate = {
        id: 'entity:' + key,
        name,
        fields: base.map(f => ({ ...f })),
    };
    draftEntity = { tplId, key };
    paintTemplateEditor();
    openDrawer();
}

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
    el('[data-dr="title"]', d).innerHTML = draftEntity
        ? `改 ${esc(draftTemplate.name)} 的字段<small>只影响这一个人</small>`
        : `编辑模板<small>TEMPLATE</small>`;
    el('[data-dr="tplbar"]', d).innerHTML = draftEntity
        ? ''
        : `<span style="font-size:11.5px;color:var(--mw-faint)">改的是你自己的副本</span>`;

    const scopeSelect = f => `
        <select data-tpl="scope" data-idx="__IDX__">
          <option value=""${!f.scope ? ' selected' : ''}>通用</option>
          <option value="self"${f.scope === 'self' ? ' selected' : ''}>仅主角</option>
          <option value="npc"${f.scope === 'npc' ? ' selected' : ''}>仅其他</option>
        </select>`;

    const body = el('[data-dr="body"]', d);
    body.innerHTML = `
      ${draftEntity ? '' : `
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
      `}

      <div class="mw-group-title" style="padding-left:0">字段</div>
      <div data-tpl="fields">
        ${draftTemplate.fields.map((f, i) => `
          <div class="mw-fieldedit ${f.group === 'main' ? 'major' : ''}">
            <div class="mw-fe-row">
              <input type="text" data-tpl="label" data-idx="${i}" value="${esc(f.label)}" placeholder="字段名">
              ${scopeSelect(f).replace('__IDX__', i)}
            </div>
            <div class="mw-fe-row">
              <select data-tpl="type" data-idx="${i}">
                ${FIELD_TYPES.map(t => `<option value="${t.v}"${t.v === f.type ? ' selected' : ''}>${t.label}</option>`).join('')}
              </select>
              <button class="mw-mini" data-tpl="toggle-group" data-idx="${i}" title="主体 / 折叠">${f.group === 'main' ? '★' : '☆'}</button>
              <button class="mw-mini" data-tpl="move-field" data-idx="${i}" data-dir="-1" title="上移">↑</button>
              <button class="mw-mini" data-tpl="move-field" data-idx="${i}" data-dir="1" title="下移">↓</button>
              <button class="mw-mini" data-tpl="del-field" data-idx="${i}" title="删除">×</button>
            </div>
            <input type="text" class="mw-fe-hint" data-tpl="hint" data-idx="${i}"
                   value="${esc(f.hint || '')}" placeholder="给模型的提示，如「明确提到才写」">
            ${f.type === 'select' ? `
              <input type="text" class="mw-fe-hint" data-tpl="options" data-idx="${i}"
                     value="${esc((f.options || []).join('，'))}" placeholder="选项，用逗号分隔">` : ''}
          </div>
        `).join('')}
      </div>
      <button class="mw-btn" data-tpl="add-field" style="width:100%;margin-top:4px">＋ 添加字段</button>
      <p style="font-size:11px;color:var(--mw-faint);line-height:1.7;margin:12px 2px 4px">
        ★ 主体（直接显示）· ☆ 折叠（点开才看到）<br>
        通用 = 所有人都填；仅主角 = 只在你自己那张卡上出现；仅其他 = 只在别人卡上出现。<br>
        提示词会拼进给模型的字段清单，用来限定怎么填，比如「不要推测」。
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

    if (draftEntity) {
        const ent = getEntity(draftEntity.tplId, draftEntity.key);
        if (ent) {
            ent.fields = draftTemplate.fields.map(f => ({ ...f }));
            persist();
        }
        draftEntity = null;
        renderTemplatePanel();
        closeDrawer();
        toast('字段已更新');
        return;
    }

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

/* 展开状态跨重绘保留 */
const openPeople = new Set();

function isSelfName(name) {
    const me = String(ctx.name1 || '').trim();
    return !!me && String(name || '').trim() === me;
}

/** 按主角 / 非主角筛出该显示的字段 */
function visibleFields(tpl, isSelf) {
    return tpl.fields.filter(f => {
        if (!f.scope) return true;
        return isSelf ? f.scope === 'self' : f.scope === 'npc';
    });
}

function personRowHTML(t, p) {
    const keyId = t.keyField || 'name';
    const name = p.values?.[keyId] || p.key;
    const isSelf = isSelfName(name);
    const tplDef = p.fields ? { ...t, fields: p.fields } : t;
    const fields = visibleFields(tplDef, isSelf);
    const brief = [p.values?.role, p.values?.relation].filter(Boolean).join(' · ');

    const detail = fields
        .filter(f => f.id !== keyId)
        .map(f => {
            const v = p.values?.[f.id];
            return v ? `<div><dt>${esc(f.label)}</dt><dd>${esc(String(v))}</dd></div>` : '';
        })
        .filter(Boolean)
        .join('');

    const tk = `${t.id}::${p.key}`;
    const open = openPeople.has(tk);

    return `
      <div class="mw-person ${isSelf ? 'is-self' : ''} ${open ? 'open' : ''}" data-tk="${esc(tk)}">
        <button class="mw-person-head" data-person-toggle>
          <span class="mw-person-dot lv${p.importance}"></span>
          <span class="mw-person-name">${esc(name)}${isSelf ? '<i class="mw-self-tag">我</i>' : ''}</span>
          <span class="mw-person-brief">${esc(brief)}</span>
          <span class="mw-person-arrow">›</span>
        </button>
        <div class="mw-person-body">
          ${detail
            ? `<dl class="mw-snap-fields">${detail}</dl>`
            : `<div class="mw-person-empty">档案还是空的</div>`}
          <div class="mw-person-foot">
            <span class="mw-snap-time">更新于 ${minuteLabel(p.updatedTs)}</span>
            <button class="mw-link" data-person-edit data-tpl="${esc(t.id)}" data-key="${esc(p.key)}">修改</button>
            <button class="mw-link" data-person-fields data-tpl="${esc(t.id)}" data-key="${esc(p.key)}">改字段</button>
            <button class="mw-link danger" data-person-del data-tpl="${esc(t.id)}" data-key="${esc(p.key)}">移除</button>
          </div>
        </div>
      </div>`;
}

function entityCardHTML(t) {
    const keyId = t.keyField || 'name';
    const people = listEntities(t.id).sort((a, b) => {
        const sa = isSelfName(a.values?.[keyId] || a.key) ? 1 : 0;
        const sb = isSelfName(b.values?.[keyId] || b.key) ? 1 : 0;
        return sb - sa || (b.importance - a.importance) || (b.updatedTs - a.updatedTs);
    });
    const ttl = Math.max(1, Number(S.personTTL) || 10);

    return `
      <div class="mw-tpl-card is-entity">
        <div class="mw-tpl-head">
          <div class="mw-tpl-name">
            <b>${esc(t.name)}</b>
            ${t.builtin ? '<span class="mw-tag-mini">内置</span>' : ''}
            <span class="mw-tag-mini snap">按人</span>
          </div>
          <div class="mw-tpl-btns">
            <button class="mw-chipbtn ${t.autofill ? 'on' : ''}" data-tpl-toggle="${t.id}" data-flag="autofill">${t.autofill ? '自动建档' : '仅手动'}</button>
            <button class="mw-chipbtn" data-person-add="${t.id}">＋</button>
          </div>
        </div>
        <div class="mw-tpl-sub">${people.length} 人 · ${ttl} 轮未出现自动移除</div>
        ${people.length
            ? `<div class="mw-person-list">${people.map(p => personRowHTML(t, p)).join('')}</div>`
            : `<div class="mw-snap-empty">还没有人物 —— 聊几轮会自动建档</div>`}
      </div>`;
}

function snapshotCardHTML(t) {
    const snap = getSnapshot(t.id);
    let body = '';

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
        body = `<div class="mw-snap-empty">还没有内容 —— 点「填写」手动记一次</div>`;
    }

    return `
      <div class="mw-tpl-card is-snap">
        <div class="mw-tpl-head">
          <div class="mw-tpl-name">
            <b>${esc(t.name)}</b>
            ${t.builtin ? '<span class="mw-tag-mini">内置</span>' : ''}
            <span class="mw-tag-mini snap">快照</span>
          </div>
          <div class="mw-tpl-btns">
            <button class="mw-chipbtn ${t.autofill ? 'on' : ''}" data-tpl-toggle="${t.id}" data-flag="autofill">${t.autofill ? '自动更新' : '仅手动'}</button>
            <button class="mw-chipbtn" data-snap-edit="${t.id}">${snap ? '修改' : '填写'}</button>
          </div>
        </div>
        <div class="mw-tpl-sub">${t.fields.length} 个字段 · 只保留最新一条</div>
        ${body}
      </div>`;
}

function plainCardHTML(t) {
    return `
      <div class="mw-tpl-card">
        <div class="mw-tpl-head">
          <div class="mw-tpl-name">
            <b>${esc(t.name)}</b>
            ${t.builtin ? '<span class="mw-tag-mini">内置</span>' : ''}
          </div>
          <div class="mw-tpl-btns">
            <button class="mw-chipbtn" data-tpl-edit="${t.id}">${t.builtin ? '复制' : '编辑'}</button>
          </div>
        </div>
        <div class="mw-tpl-sub">${t.fields.length} 个字段 · 每次新建一条</div>
      </div>`;
}

function renderTemplatePanel() {
    if (!ui.tplpanel) return;
    ui.tplpanel.innerHTML = getTemplates().map(t => {
        if (t.entity) return entityCardHTML(t);
        if (t.singleton) return snapshotCardHTML(t);
        return plainCardHTML(t);
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
    openTemplateEditor(PERSON_TEMPLATE.id, true);
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
    fillTimer = setTimeout(() => autoUpdatePeople(), 3000);
}

function onChatChanged() {
    initChatCursor();
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
    initChatCursor();

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
        fill: () => { store().fillSig = ''; return autoUpdatePeople(); },
        template: () => openTemplateEditor(PERSON_TEMPLATE.id, true),
        get settings() { return S; },
        get store() { return store(); },
        exportTemplate() {
            return JSON.stringify(PERSON_TEMPLATE, null, 2);
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
                pending: pendingRounds(),
                templates: getTemplates().map(t => `${t.name}${t.singleton ? '[快照]' : ''}(${t.fields.length})`),
            };
        },
    };
}

init().catch(e => console.error('[织忆] 初始化失败', e));
