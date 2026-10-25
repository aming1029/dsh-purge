// prompts-lib.js — 把「提示词」和「规则集」统一成一份「提示词库」
//
// 模型：
//   $DSH_HOME/dsh-purge/prompts/default.md   默认提示词（可改、界面可见；未应用任何条目时用它）
//   $DSH_HOME/dsh-purge/prompts/<id>.md      用户新建的提示词（可多份，可改可删）
//   $DSH_HOME/dsh-purge/prompts/index.json   { activeId, items:[{id,name,createdAt,updatedAt,chars}] }
//
// 「应用」= 立即生效（不等重启、不等定时任务）：
//   1) 写 $DSH_HOME/prompt-inject.md  —— 走插件自己的 saveOverrideContent（原子写 + 进程内钉 + 标记 customized）
//   2) 写 $DSH_HOME/AGENTS.md         —— workspace instructions 通道（mywb2 这类会吞 system 的网关靠它）
//   3) 调用方刷新插件内存 pin（refreshHungOperator），下一轮请求即带新文本
//
// 正文为空 = 明确「不要提示词」：prompt-inject.md 空 + AGENTS.md 删除 => 回到 DSH 官方提示词。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as core from "./core.js";
import { openSlot } from "./table-read.js";

export const DEFAULT_ID = "default";
/** 官方默认（不注入任何提示词）虚拟条目 id。 */
export const OFFICIAL_ID = "official";
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/i;

const storeDir = (home) => path.join(home, "dsh-purge", "prompts");
const indexPath = (home) => path.join(storeDir(home), "index.json");
const itemPath = (home, id) => path.join(storeDir(home), `${id}.md`);
const defaultPath = (home) => path.join(storeDir(home), `${DEFAULT_ID}.md`);
const backupDir = (home) => path.join(storeDir(home), "backups");
const agentsPath = (home) => path.join(home, "AGENTS.md");
const agentsBak = (home) => path.join(home, "AGENTS.md.prompt-sync.bak");

const clean = (s) => String(s ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
const hash = (s) => crypto.createHash("sha256").update(String(s ?? ""), "utf8").digest("hex").slice(0, 16);
const nowIso = () => new Date().toISOString();
const head = (s, n = 40) => clean(s).slice(0, n).replace(/\n/g, " / ");

async function readTextSafe(fp) {
  try { return await fsp.readFile(fp, "utf8"); } catch { return null; }
}

async function backupFile(fp, tag) {
  const text = await readTextSafe(fp);
  if (text === null) return null;
  try {
    fs.mkdirSync(backupDir(path.dirname(path.dirname(fp))), { recursive: true });
  } catch { /* ignore */ }
  const base = path.basename(fp).replace(/\.md$/, "");
  const dest = path.join(path.dirname(path.dirname(fp)), "backups", `${base}.${tag}.md`);
  try { await fsp.mkdir(path.dirname(dest), { recursive: true }); await fsp.writeFile(dest, text, "utf8"); return dest; } catch { return null; }
}

// ---------------- index.json ----------------

async function readIndex(home) {
  const raw = await readTextSafe(indexPath(home));
  if (raw) {
    try {
      const obj = JSON.parse(raw);
      return {
        activeId: typeof obj?.activeId === "string" ? obj.activeId : null,
        items: Array.isArray(obj?.items) ? obj.items.filter((it) => it && ID_RE.test(String(it.id))) : [],
      };
    } catch { /* 落到重建 */ }
  }
  return { activeId: null, items: [] };
}

async function writeIndex(home, index) {
  await fsp.mkdir(storeDir(home), { recursive: true });
  const tmp = `${indexPath(home)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ version: 1, ...index }, null, 2), "utf8");
  await fsp.rename(tmp, indexPath(home));
}

function newId(name) {
  const slug = String(name || "prompt").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "prompt";
  return `p-${slug}-${crypto.randomBytes(3).toString("hex")}`;
}

// ---------------- 初始化 / 迁移 ----------------

/**
 * 幂等初始化：补 default.md、把历史 rules/*.md 与现有 prompt-inject.md 迁进提示词库。
 * 迁移只做一次（index.json 里 migrationDone=true 后不再跑）。
 */
export async function ensureStore(home) {
  await fsp.mkdir(storeDir(home), { recursive: true });
  const index = await readIndex(home);

  // 1) 默认提示词：仅在首次初始化时从加密槽灌一次；之后缺失一律建空文件（尊重用户清空）
  if (!fs.existsSync(defaultPath(home))) {
    let seed = "";
    if (!fs.existsSync(path.join(storeDir(home), "index.json"))) {
      try { seed = clean(openSlot()); } catch { seed = ""; }
    }
    await fsp.writeFile(defaultPath(home), seed, "utf8");
  }

  if (index.migrationDone) return index;

  // 2) 迁移历史规则集（rules/<id>.md + <id>.json{name}）
  const rulesDir = path.join(home, "rules");
  let names = [];
  try { names = await fsp.readdir(rulesDir); } catch { names = []; }
  for (const f of names) {
    if (!f.toLowerCase().endsWith(".md")) continue;
    const id = f.replace(/\.md$/i, "");
    if (!ID_RE.test(id)) continue;
    if (index.items.some((it) => it.id === id)) continue;
    const body = clean(await readTextSafe(path.join(rulesDir, f)));
    if (!body) continue;
    let label = id;
    try {
      const meta = JSON.parse(await readTextSafe(path.join(rulesDir, `${id}.json`)) || "{}");
      if (meta?.name) label = String(meta.name);
    } catch { /* 用文件名 */ }
    await fsp.writeFile(itemPath(home, id), body, "utf8");
    index.items.push({ id, name: label, createdAt: nowIso(), updatedAt: nowIso(), chars: body.length, migratedFrom: "rules" });
  }

  // [prompts-lib] 不再把 prompt-inject.md 自动收成条目（apply 会写它，避免垃圾条目）


  index.migrationDone = true;
  await writeIndex(home, index);
  return index;
}

// ---------------- 官方默认（DSH 自带提示词） ----------------

const officialLabel = "DSH 官方默认提示词";

/** activeId 归一化：允许 official 这个虚拟 id 直接生效。 */
function normalizeActive(index) {
  const a = index.activeId;
  if (a === OFFICIAL_ID) return OFFICIAL_ID;
  if (a && index.items.some((it) => it.id === a)) return a;
  return null;
}

/** 定位宿主 @deepseek-ai/dsh-system-prompt 的 index.js（解开树优先，其次 asar.unpacked / 上一版提取树）。 */
function findSystemPromptFile() {
  // 1) 先按进程自身位置推导（桌面宿主进程 execPath = DeepSeek Harness.exe，最准）
  const roots = [];
  try { if (process.resourcesPath) roots.push(path.dirname(path.normalize(process.resourcesPath))); } catch { /* ignore */ }
  try { if (process.execPath) roots.push(path.dirname(process.execPath)); } catch { /* ignore */ }
  if (process.env.DSH_INSTALL_DIR) roots.push(process.env.DSH_INSTALL_DIR);
  if (process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, "DeepSeek Harness"));
  const rels = [
    ["resources", "app", "dsh", "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js"],
    ["resources", "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js"],
    ["resources", "app.dshpurge-prev", "dsh", "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js"],
  ];
  for (const root of roots) {
    for (const rel of rels) {
      const fp = path.join(root, ...rel);
      if (fs.existsSync(fp)) return fp;
    }
  }
  // 2) 兜底：插件自己的安装根定位（web/CLI 面走 $DSH_HOME 那套）
  try {
    const ai = core.findAiBase();
    if (ai) {
      const fp = path.join(ai, "dsh-system-prompt", "lib", "index.js");
      if (fs.existsSync(fp)) return fp;
    }
  } catch { /* ignore */ }
  return null;
}

/** 从 index.js 源码抠出 harness:identity 段的正文。 */
function identitySectionText(fp) {
  if (!fp || !fs.existsSync(fp)) return null;
  try {
    const text = fs.readFileSync(fp, "utf8");
    const m = text.match(/name:\s*"harness:identity"[\s\S]{0,600}?text:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) return null;
    return String(JSON.parse(String.fromCharCode(34) + m[1] + String.fromCharCode(34))).trim();
  } catch { return null; }
}

/**
 * 「DSH 官方默认提示词」只读快照：官方基线文本 + 本机补丁状态说明。
 * 该条目代表「什么都不注入，让 DSH 自己组装系统提示词」。
 */
export async function officialSnapshot(home) {
  const live = findSystemPromptFile();
  const bak = live ? live + ".dshpurge.bak" : null;
  const officialRaw = identitySectionText(bak && fs.existsSync(bak) ? bak : live);
  const liveSrc = live ? await readTextSafe(live) : "";
  const stripped = /\[dsh-purge\]\s*identity stripped/.test(liveSrc);
  const lines = [];
  lines.push("# DSH 官方默认提示词（官方基线快照）");
  lines.push("");
  lines.push("> 只读条目：它代表「不注入任何提示词，让 DSH 自己组装系统提示词」。");
  lines.push("> 想改成自己的版本：点「另存为新提示词」，得到一份可编辑副本。");
  lines.push("");
  lines.push("## 1. harness:identity（@deepseek-ai/dsh-system-prompt 官方原文）");
  lines.push("");
  lines.push(officialRaw || "（未读到官方原文：安装目录下未找到 dsh-system-prompt）");
  lines.push("");
  lines.push("## 2. 官方运行时另外拼装的内容");
  lines.push("");
  lines.push("- 各插件注册的 system 段落（按 order 排序后 join）");
  lines.push("- 工具定义（以 schema 数组随请求发出）");
  lines.push("- 运行时上下文（Current runtime context：工作目录 / 文件策略 / 审批策略 / Web GUI URL 等）");
  lines.push("- workspace 指令（~/.dsh/AGENTS.md，存在时以 system-reminder 形式注入）");
  lines.push("");
  lines.push("## 3. 本机当前状态");
  lines.push("");
  lines.push(stripped
    ? "- 补丁 #55 SYSTEM_PROMPT_REPLACE_HEAD 正在生效：harness:identity 正文已被清成空串，includeHarnessIdentity 默认为 false ⇒ 实际发出的 system prompt 中没有那句官方身份文本。"
    : "- 补丁 #55 未生效：harness:identity 保留官方原文。");
  lines.push("- 官方源文件：" + (live || "（未找到）"));
  lines.push("- 快照时间：" + nowIso());
  const text = lines.join("\n") + "\n";
  const fp = path.join(storeDir(home), OFFICIAL_ID + ".md");
  try { await fsp.writeFile(fp, text, "utf8"); } catch { /* 快照写不出也不影响展示 */ }
  return {
    id: OFFICIAL_ID,
    name: officialLabel,
    text,
    readonly: true,
    chars: 0,
    docChars: text.length,
    hash: hash(text),
    head: head(text),
    patched: stripped,
    officialText: officialRaw || "",
    sourcePath: live || "",
    capturedAt: nowIso(),
  };
}
/* [official-prompt] 官方默认条目 block end */

// ---------------- 读 ----------------

export async function listStore(home) {
  const index = await ensureStore(home);
  const defText = clean(await readTextSafe(defaultPath(home)));
  const items = [];
  for (const it of index.items) {
    const body = clean(await readTextSafe(itemPath(home, it.id)));
    items.push({
      id: it.id,
      name: it.name || it.id,
      chars: body.length,
      hash: hash(body),
      head: head(body),
      updatedAt: it.updatedAt || "",
      missing: body.length === 0,
    });
  }
  items.sort((a, b) => (a.name || "").localeCompare(b.name || "", "zh"));
  return {
    activeId: normalizeActive(index),
    items,
    official: await officialSnapshot(home),
    default: { id: DEFAULT_ID, name: "默认提示词", chars: defText.length, hash: hash(defText), head: head(defText), editable: true },
    dir: storeDir(home),
    effective: await effectiveInfo(home, index),
  };
}

async function effectiveText(home, index) {
  if (index.activeId === OFFICIAL_ID) return { id: OFFICIAL_ID, name: officialLabel, text: "", source: "official" };
  const id = index.activeId && index.items.some((it) => it.id === index.activeId) ? index.activeId : null;
  if (id) {
    const body = clean(await readTextSafe(itemPath(home, id)));
    const meta = index.items.find((it) => it.id === id);
    return { id, name: meta?.name || id, text: body, source: "item" };
  }
  const body = clean(await readTextSafe(defaultPath(home)));
  if (!body) return { id: OFFICIAL_ID, name: officialLabel, text: "", source: "official" };
  return { id: DEFAULT_ID, name: "默认提示词", text: body, source: "default" };
}

export async function effectiveInfo(home, indexMaybe) {
  const index = indexMaybe || (await readIndex(home));
  const eff = await effectiveText(home, index);
  const diskText = clean(await readTextSafe(core.findOverrideFile(home)));
  const agentsRaw = await readTextSafe(agentsPath(home));
  return {
    activeId: normalizeActive(index),
    id: eff.id,
    name: eff.name,
    source: eff.source,
    chars: eff.text.length,
    hash: hash(eff.text),
    head: head(eff.text),
    inSync: {
      promptInject: diskText === eff.text,
      agents: eff.text ? clean(agentsRaw || "") === eff.text : agentsRaw === null,
    },
    agents: agentsRaw === null ? "absent" : `mirror(${clean(agentsRaw).length} 字符)`,
  };
}

export async function getPrompt(home, id) {
  const index = await ensureStore(home);
  if (String(id) === OFFICIAL_ID) return await officialSnapshot(home);
  const want = !id || id === DEFAULT_ID ? DEFAULT_ID : String(id);
  if (want === DEFAULT_ID) {
    return { id: DEFAULT_ID, name: "默认提示词", text: clean(await readTextSafe(defaultPath(home))) };
  }
  const meta = index.items.find((it) => it.id === want);
  if (!meta) throw new Error(`提示词不存在: ${want}`);
  return { id: want, name: meta.name || want, text: clean(await readTextSafe(itemPath(home, want))) };
}

// ---------------- 写 ----------------

export async function savePrompt(home, { id, name, text }) {
  const index = await ensureStore(home);
  const body = clean(text);
  let targetId = id && String(id).trim();
  if (!targetId && !body) throw new Error("正文为空：先在编辑框里写内容再新建");
  if (!targetId) {
    targetId = newId(name);
    index.items.push({ id: targetId, name: String(name || "未命名提示词").slice(0, 60), createdAt: nowIso(), updatedAt: nowIso(), chars: body.length });
  } else {
    if (targetId === DEFAULT_ID) throw new Error("默认提示词请用 setDefault");
    if (!ID_RE.test(targetId)) throw new Error(`非法 id: ${targetId}`);
    const meta = index.items.find((it) => it.id === targetId);
    if (!meta) throw new Error(`提示词不存在: ${targetId}`);
    await backupFile(itemPath(home, targetId), new Date().toISOString().replace(/[:.]/g, "-"));
    meta.updatedAt = nowIso();
    meta.chars = body.length;
    if (typeof name === "string" && name.trim()) meta.name = name.trim().slice(0, 60);
  }
  await fsp.writeFile(itemPath(home, targetId), body, "utf8");
  await writeIndex(home, index);
  return { id: targetId, chars: body.length, hash: hash(body), applied: false };
}

export async function setDefault(home, text) {
  await ensureStore(home);
  const body = clean(text);
  await backupFile(defaultPath(home), new Date().toISOString().replace(/[:.]/g, "-"));
  await fsp.writeFile(defaultPath(home), body, "utf8");
  return { chars: body.length, hash: hash(body) };
}

export async function resetDefault(home) {
  await ensureStore(home);
  let seed = "";
  try { seed = clean(openSlot()); } catch { seed = ""; }
  return setDefault(home, seed);
}

export async function deletePrompt(home, id) {
  const index = await ensureStore(home);
  if (!id || id === DEFAULT_ID) throw new Error("默认提示词不能删除，可以清空它");
  const at = index.items.findIndex((it) => it.id === id);
  if (at < 0) throw new Error(`提示词不存在: ${id}`);
  const meta = index.items[at];
  await backupFile(itemPath(home, id), `deleted-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  try { fs.rmSync(itemPath(home, id), { force: true }); } catch { /* ignore */ }
  index.items.splice(at, 1);
  if (index.activeId === id) index.activeId = null;
  await writeIndex(home, index);
  return { deleted: id, name: meta.name || id, activeId: index.activeId, wasActive: meta.id === id };
}

// ---------------- 应用（立即生效）----------------

async function writeAgents(home, text) {
  const fp = agentsPath(home);
  const prev = await readTextSafe(fp);
  if (!text) {
    if (prev !== null) {
      try { await fsp.mkdir(backupDir(home), { recursive: true }); await fsp.writeFile(agentsBak(home), prev, "utf8"); } catch { /* ignore */ }
      fs.rmSync(fp, { force: true });
      return { mode: "official", note: "AGENTS.md 已删除，workspace 层回到官方默认" };
    }
    return { mode: "official", note: "本来就没有 AGENTS.md" };
  }
  const body = `\ufeff${text}\n`;
  if (prev === body) return { mode: "mirror", bytes: Buffer.byteLength(body, "utf8"), chars: text.length, unchanged: true };
  try { if (prev !== null) { await fsp.mkdir(backupDir(home), { recursive: true }); await fsp.writeFile(agentsBak(home), prev, "utf8"); } } catch { /* ignore */ }
  await fsp.writeFile(fp, body, "utf8");
  return { mode: "mirror", bytes: Buffer.byteLength(body, "utf8"), chars: text.length };
}

/**
 * 把「当前选中的提示词」落到两个通道，返回结果。
 * 调用方负责随后刷新插件内存 pin（index.js 里做，本模块不 import index.js）。
 */
export async function applyEffective(home, id) {
  const index = await ensureStore(home);
  let targetId = id === undefined ? index.activeId : id;
  if (targetId === DEFAULT_ID || targetId === null || targetId === "") targetId = null;
  const wantOfficial = targetId === OFFICIAL_ID;
  if (targetId !== null && !wantOfficial) {
    if (!ID_RE.test(String(targetId))) throw new Error(`非法 id: ${targetId}`);
    if (!index.items.some((it) => it.id === targetId)) throw new Error(`提示词不存在: ${targetId}`);
  }
  index.activeId = targetId;
  await writeIndex(home, index);

  const eff = await effectiveText(home, index);
  const body = wantOfficial ? "" : eff.text;

  // 1) system 通道：prompt-inject.md（插件自己的保存路径，含 customized 标记与进程内钉）
  let saved;
  try {
    saved = await core.saveOverrideContent(home, body);
  } catch (e) {
    throw new Error(`写 prompt-inject.md 失败: ${e?.message || e}`);
  }

  // 2) workspace 通道：AGENTS.md
  const agents = await writeAgents(home, body);

  return {
    ok: true,
    activeId: index.activeId,
    applied: { id: eff.id, name: eff.name, source: eff.source },
    chars: body.length,
    hash: hash(body),
    head: head(body),
    promptInject: { path: saved?.path || core.findOverrideFile(home), bytes: Buffer.byteLength(body, "utf8"), customized: Boolean(saved?.customized) },
    agents,
    empty: body.length === 0,
  };
}

// ---------------- HTML 页面 ----------------

export const UI_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>提示词库 · dsh-purge</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#272c36;--fg:#e6e9ef;--dim:#8b93a3;--accent:#4c9aff;--ok:#3fb950;--warn:#d29922;--err:#f85149}
*{box-sizing:border-box}body{margin:0;font:14px/1.6 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:16px;align-items:center;padding:12px 18px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:5}
h1{font-size:15px;margin:0 12px 0 0}
.badge{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
.badge.on{color:var(--ok);border-color:#1d3b25;background:#12251a}
.wrap{display:grid;grid-template-columns:300px 1fr;gap:0;height:calc(100vh - 57px)}
@media (max-width:780px){/* [prompt-sync] responsive */
  header{flex-wrap:wrap;padding:10px 12px;gap:8px}
  .wrap{display:block;height:auto}
  aside{border-right:0;border-bottom:1px solid var(--line);max-height:190px;overflow:auto}
  main{padding:12px}
  body{font-size:13px}
}
aside{border-right:1px solid var(--line);overflow:auto;background:#12151b}
.item{padding:10px 14px;border-bottom:1px solid #1c2029;cursor:pointer}
.item:hover{background:#181c24}.item.sel{background:#1b2230;box-shadow:inset 3px 0 0 var(--accent)}
.item.active .nm::after{content:"  ● 生效中";color:var(--ok);font-size:11px}
.nm{font-weight:600}.sub{color:var(--dim);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
main{padding:16px 18px;overflow:auto}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
input[type=text]{background:#0d1015;border:1px solid var(--line);color:var(--fg);padding:7px 10px;border-radius:6px;min-width:220px}
textarea{width:100%;height:calc(100vh - 300px);min-height:280px;background:#0d1015;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:12px;font:13px/1.55 ui-monospace,Consolas,monospace;resize:vertical}
button{background:#222834;color:var(--fg);border:1px solid var(--line);padding:7px 13px;border-radius:6px;cursor:pointer;font-size:13px}
button:hover{background:#2a3140}button.primary{background:#1f5fbf;border-color:#2d6fd6}button.primary:hover{background:#2670da}
button.danger{color:#ffb4ad;border-color:#5a2a26}button.ghost{background:transparent}
.meta{color:var(--dim);font-size:12px}#msg{margin-left:auto;font-size:12px}
#log{margin-top:10px;padding:10px;background:#0b0e13;border:1px solid var(--line);border-radius:8px;font:12px/1.5 ui-monospace,Consolas,monospace;color:var(--dim);max-height:150px;overflow:auto;white-space:pre-wrap}
</style></head><body>
<header>
  <h1>提示词库</h1>
  <span class="badge" id="effBadge">加载中…</span>
  <span class="badge" id="chanBadge"></span>
  <span id="msg"></span>
</header>
<div class="wrap">
  <aside id="list"></aside>
  <main>
    <div class="row">
      <input type="text" id="name" placeholder="名称（新建时用）">
      <button class="primary" id="applyBtn">应用（立即生效）</button>
      <button id="saveBtn">保存</button>
      <button id="createBtn" class="ghost">新建</button>
      <button id="newBtn" class="ghost">另存为新提示词</button>
      <button id="delBtn" class="danger ghost">删除</button>
      <button id="defaultBtn" class="ghost">设为默认提示词</button>
    </div>
    <textarea id="body" spellcheck="false" placeholder="在这里写提示词正文…"></textarea>
    <div id="log"></div>
  </main>
</div>
<script>
const API = "/dsh-purge/prompts";
let state = { sel: "default", items: [], activeId: null, dirty: false, official: null };
const $ = (id) => document.getElementById(id);
// [ui-fix] 草稿保护：编辑内容即时暂存到 localStorage，刷新/切换都不会丢
const draftKey = (id) => "dshp-pl-draft:" + id;
function saveDraft(id, text) { try { if (id) localStorage.setItem(draftKey(id), text || ""); } catch (e) { /* ignore */ } }
function dropDraft(id) { try { if (id) localStorage.removeItem(draftKey(id)); } catch (e) { /* ignore */ } }
function loadDraft(id) { try { return id ? localStorage.getItem(draftKey(id)) : null; } catch (e) { return null; } }
const say = (t, kind) => { const m = $("msg"); m.textContent = t || ""; m.style.color = kind === "err" ? "var(--err)" : kind === "ok" ? "var(--ok)" : "var(--dim)"; };
const logLine = (t) => { const l = $("log"); l.textContent = t + (l.textContent ? "\\n" + l.textContent : ""); };

async function api(method, payload) {
  const url = method === "GET" ? API + (payload ? "?" + new URLSearchParams(payload) : "") : API;
  const r = await fetch(url, method === "GET" ? { cache: "no-store", credentials: "same-origin" }
    : { method, headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(payload || {}) });
  const d = await r.json().catch(() => ({ ok: false, error: "非 JSON 响应" }));
  if (!r.ok || d.ok === false) throw new Error(d.error || ("HTTP " + r.status));
  return d;
}

function renderList() {
  const box = $("list");
  box.innerHTML = "";
  const mk = (id, name, chars, extra) => {
    const el = document.createElement("div");
    el.className = "item" + (state.sel === id ? " sel" : "") + (state.activeId === id || (id === "default" && !state.activeId) ? " active" : "");
    el.innerHTML = '<div class="nm"></div><div class="sub"></div>';
    el.querySelector(".nm").textContent = name;
    el.querySelector(".sub").textContent = (extra || "") + chars + " 字符";
    el.onclick = () => select(id);
    box.appendChild(el);
  };
  mk("official", "DSH 官方默认提示词（只读）", 0, "官方基线 · 不注入 · ");
  mk("default", "默认提示词", state.default.chars, "未应用任何条目时使用 · ");
  for (const it of state.items) mk(it.id, it.name, it.chars, it.missing ? "⚠ 空 · " : "");
}

async function refresh(keepSel) {
  const d = await api("GET", { op: "list" });
  state.items = d.items; state.activeId = d.activeId; state.default = d.default; state.official = d.official;
  $("effBadge").textContent = "生效中：" + d.effective.name + "（" + d.effective.chars + " 字符 · " + d.effective.hash + "）"
    + (d.effective.inSync.promptInject && d.effective.inSync.agents ? " ✓ 已对齐" : " ⚠ 未对齐");
  $("effBadge").className = "badge " + (d.effective.inSync.promptInject && d.effective.inSync.agents ? "on" : "");
  $("chanBadge").textContent = "通道：prompt-inject.md + " + d.effective.agents;
  if (!keepSel) state.sel = d.activeId || "default";
  renderList();
  await select(state.sel, true);
}

async function select(id, silent) {
  // [ui-fix] 切换条目之前，先把没保存的编辑落盘
  if (!silent && state.sel && state.sel !== id && state.dirty) {
    try {
      if (state.sel !== "official" && state.sel !== "new") {
        if (state.sel === "default") await api("POST", { op: "set-default", text: $("body").value });
        else await api("POST", { op: "save", id: state.sel, name: $("name").value, text: $("body").value });
        logLine(new Date().toLocaleTimeString() + " 切换前自动保存 -> " + state.sel);
      }
      state.dirty = false;
    } catch (e) { say("切换前保存失败：" + e.message + "（已阻止切换，避免丢字）", "err"); return; }
  }
  state.sel = id;
  renderList();
  try {
    const d = await api("GET", { op: "get", id });
    $("body").value = d.text;
    $("name").value = d.name || "";
    const ro = id === "official" || Boolean(d.readonly);
    $("body").readOnly = ro;
    $("saveBtn").disabled = ro;
    $("delBtn").disabled = ro || id === "default";
    $("defaultBtn").disabled = ro || id === "default";
    if (id === "official" && !silent) say("只读快照：点「应用」= 清空两条通道回到 DSH 官方默认；点「新建」/「另存为新提示词」= 复制成可编辑副本");
    state.dirty = false;
    if (!ro) {
      const draft = loadDraft(id);
      if (!String(d.text || "").trim() && draft) { $("body").value = draft; state.dirty = true; say("已恢复本机暂存的未保存内容（点「应用」落地）"); }
    }
    if (!silent) say("");
  } catch (e) { say(e.message, "err"); }
}

// [ui-fix] 「应用」先把编辑内容写进库，再落地：粘进去的字不会因为刷新被冲掉
async function ensureSaved() {
  const text = $("body").value;
  if (state.sel === "official") return "official";
  if (state.sel === "new") {
    if (!String(text || "").trim()) throw new Error("正文为空：先把提示词写进文本框，再点「应用」");
    const d = await api("POST", { op: "save", name: $("name").value || "新提示词", text });
    state.sel = d.id; state.dirty = false;
    logLine(new Date().toLocaleTimeString() + " 已新建 -> " + d.id + " (" + d.chars + " 字符)");
    return d.id;
  }
  if (!String(text || "").trim()) throw new Error("正文为空：先把提示词写进文本框；想回官方提示词请选「DSH 官方默认提示词」再点应用");
  if (state.sel === "default") {
    if (state.dirty) { await api("POST", { op: "set-default", text }); state.dirty = false; }
    return "default";
  }
  if (state.dirty) { await api("POST", { op: "save", id: state.sel, name: $("name").value, text }); state.dirty = false; }
  return state.sel;
}

$("createBtn").onclick = async () => {
  if (state.dirty && !confirm("当前编辑内容还没保存，新建会丢掉它（继续？）")) return;
  state.sel = "new"; state.dirty = false;
  $("name").value = "";
  $("body").value = "";
  $("body").readOnly = false;
  $("saveBtn").disabled = false; $("delBtn").disabled = true; $("defaultBtn").disabled = false;
  renderList();
  say("新建模式：写下正文 + 名称，点「应用」= 保存并立即生效", "ok");
};

$("applyBtn").onclick = async () => {
  try {
    const id = await ensureSaved();
    const d = await api("POST", { op: "apply", id });
    logLine(new Date().toLocaleTimeString() + " 应用 -> " + d.applied.name + " (" + d.chars + " 字符, " + d.hash + "), AGENTS.md=" + d.agents.mode + (d.empty ? " · 空=官方默认" : ""));
    dropDraft(id);
    say("已应用并生效", "ok");
    await refresh(true);
  } catch (e) { say(e.message, "err"); }
};

$("saveBtn").onclick = async () => {
  try {
    if (state.sel === "official") { say("官方条目只读：请点「新建」或「另存为新提示词」", "err"); return; }
    const id = await ensureSaved();
    dropDraft(id);
    say("已保存（点「应用」才落地生效）", "ok");
    await refresh(true);
  } catch (e) { say(e.message, "err"); }
};

$("newBtn").onclick = async () => {
  try {
    // 官方默认条目是只读快照：另存时只复制官方原文，不复制说明文档
    const useOfficial = state.sel === "official" && state.official && state.official.officialText;
    const text = useOfficial ? state.official.officialText : $("body").value;
    if (!String(text || "").trim()) { say("正文为空：先在文本框里写内容，再点「另存为新提示词」", "err"); return; }
    const d = await api("POST", { op: "save", name: $("name").value || "新提示词", text });
    say("已另存为新提示词：" + d.id, "ok");
    dropDraft(state.sel);
    state.dirty = false;
    await refresh();
    await select(d.id, true);
  } catch (e) { say(e.message, "err"); }
};

$("delBtn").onclick = async () => {
  if (!confirm("删除当前提示词？")) return;
  try {
    await api("POST", { op: "delete", id: state.sel });
    dropDraft(state.sel);
    say("已删除", "ok");
    await refresh();
  } catch (e) { say(e.message, "err"); }
};

$("defaultBtn").onclick = async () => {
  if (!confirm("把当前正文设为「默认提示词」？")) return;
  try {
    await api("POST", { op: "set-default", text: $("body").value });
    state.dirty = false;
    say("已设为默认提示词（点「应用」落地）", "ok");
    await refresh(true);
  } catch (e) { say(e.message, "err"); }
};

// [ui-fix] 任何输入都标记为未保存并即时暂存
$("body").addEventListener("input", () => { state.dirty = true; saveDraft(state.sel, $("body").value); });
$("name").addEventListener("input", () => { state.dirty = true; });
refresh().catch((e) => say(e.message, "err"));
</script></body></html>`;

// ---------------- HTTP 路由 ----------------

export function installPromptsHttp(webServer, deps) {
  const disposers = [];
  const register = (spec, label) => {
    const wrapped = {
      ...spec,
      handler: async (request, response) => {
        if (typeof deps.allow === "function" && !deps.allow(request, response)) return;
        try {
          await spec.handler(request, response);
        } catch (e) {
          try { deps.sendJson(response, 500, { ok: false, error: String(e?.message || e) }); } catch { /* ignore */ }
        }
      },
    };
    const d = webServer.register(wrapped, label);
    if (typeof d === "function") disposers.push(d);
    return d;
  };

  const home = () => deps.home();

  register({
    kind: "exact",
    path: "/dsh-purge/prompts",
    handler: async (request, response) => {
      const h = home();
      const url = new URL(request.url || "/", "http://localhost");
      if (request.method === "GET") {
        const op = url.searchParams.get("op") || "list";
        if (op === "get") {
          const got = await getPrompt(h, url.searchParams.get("id") || DEFAULT_ID);
          deps.sendJson(response, 200, { ok: true, ...got });
          return;
        }
        if (op === "official") {
          deps.sendJson(response, 200, { ok: true, ...(await officialSnapshot(h)) });
          return;
        }
        const list = await listStore(h);
        deps.sendJson(response, 200, { ok: true, ...list });
        return;
      }
      if (request.method === "POST") {
        // [prompt-sync] api-try
        try {
        const body = await deps.readJsonBody(request);
        const op = String(body?.op || "");
        switch (op) {
          case "save": {
            const r = await savePrompt(h, { id: body.id, name: body.name, text: body.text });
            deps.sendJson(response, 200, { ok: true, ...r });
            return;
          }
          case "set-default": {
            const r = await setDefault(h, body.text);
            deps.sendJson(response, 200, { ok: true, ...r });
            return;
          }
          case "reset-default": {
            const r = await resetDefault(h);
            deps.sendJson(response, 200, { ok: true, ...r });
            return;
          }
          case "delete": {
            const r = await deletePrompt(h, body.id);
            deps.sendJson(response, 200, { ok: true, ...r });
            return;
          }
          case "apply": {
            const r = await applyEffective(h, body.id === undefined ? undefined : (body.id === DEFAULT_ID ? null : body.id));
            try { if (typeof deps.refresh === "function") deps.refresh(); } catch { /* ignore */ }
            deps.sendJson(response, 200, r);
            return;
          }
          default:
            deps.sendJson(response, 400, { ok: false, error: `未知 op: ${op}` });
            return;
        }
        } catch (e) {
          try { deps.sendJson(response, 400, { ok: false, error: String((e && e.message) || e || "操作失败") }); }
          catch { /* ignore */ }
          return;
        }
      }
      response.writeHead(405, { allow: "GET, POST" });
      response.end();
    },
  }, "dsh-purge: prompts");

  register({
    kind: "exact",
    path: "/dsh-purge/prompts/ui",
    handler: async (request, response) => {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      });
      response.end(UI_HTML);
    },
  }, "dsh-purge: prompts ui");

  return () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  };
}
