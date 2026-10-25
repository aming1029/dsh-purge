// tests/prompts-lib.test.mjs — 提示词库离线自测（不碰真实 $DSH_HOME）
//
// 用法：node tests/prompts-lib.test.mjs
// 覆盖：初始化 / 新建 / 应用（双通道落盘）/ 默认 / 官方只读 / 删除 / 空正文守卫 / HTTP 路由（含错误码）

import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const libUrl = pathToFileURL(path.join(import.meta.dirname, "..", "lib", "prompts-lib.js")).href;
const mod = await import(libUrl);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-prompts-test-"));
const read = async (fp) => {
  try {
    return await fsp.readFile(fp, "utf8");
  } catch {
    return null;
  }
};
const stripBom = (s) => String(s ?? "").replace(/^\uFEFF/, "");
const injectPath = path.join(home, "prompt-inject.md");
const agentsPath = path.join(home, "AGENTS.md");

let passed = 0;
const ok = (name, cond, extra) => {
  assert.ok(cond, `${name}${extra === undefined ? "" : " => " + JSON.stringify(extra)}`);
  passed += 1;
  console.log("  ✓ " + name);
};

// 假 webServer：抓住注册的路由
const routes = new Map();
const webServer = { register: (spec) => { routes.set(spec.path, spec.handler); return () => {}; } };
mod.installPromptsHttp(webServer, {
  allow: () => true,
  home: () => home,
  refresh: () => {},
  sendJson: (res, code, body) => { res._code = code; res._body = body; res.end(); },
  readJsonBody: async (req) => req._body,
});
const call = async (method, urlPath, payload) => {
  const res = { end() {}, writeHead(code, headers) { this._code = code; this._headers = headers; } };
  await routes.get("/dsh-purge/prompts")({ method, url: urlPath, _body: payload }, res);
  return { code: res._code || 200, body: res._body };
};

try {
  console.log("[1] 初始化");
  const index = await mod.ensureStore(home);
  ok("index.json 建好", fs.existsSync(path.join(home, "dsh-purge", "prompts", "index.json")));
  ok("default.md 建好", fs.existsSync(path.join(home, "dsh-purge", "prompts", "default.md")));
  ok("初始无条目", index.items.length === 0, index.items);

  console.log("[2] 新建");
  const made = await mod.savePrompt(home, { name: "测试甲", text: "甲正文第一行\n甲正文第二行" });
  ok("返回 id", /^p-/.test(made.id), made);
  ok("字符数正确", made.chars === "甲正文第一行\n甲正文第二行".length, made.chars);
  await assert.rejects(() => mod.savePrompt(home, { name: "空", text: "   " }), /正文为空/);
  ok("空正文拒绝新建", true);

  console.log("[3] 列表");
  let list = await mod.listStore(home);
  ok("条目数 1", list.items.length === 1, list.items.map((i) => i.id));
  ok("官方条目只读", list.official.readonly === true);
  ok("官方条目正文非空", list.official.text.length > 100, list.official.docChars);
  ok("activeId 初始为空", list.activeId === null, list.activeId);

  console.log("[4] 应用（双通道）");
  let applied = await mod.applyEffective(home, made.id);
  ok("source=item", applied.applied && applied.applied.source === "item", applied.applied);
  ok("prompt-inject.md 写入", stripBom(await read(injectPath)) === "甲正文第一行\n甲正文第二行");
  ok("AGENTS.md 镜像", stripBom(await read(agentsPath)).startsWith("甲正文第一行"));
  ok("agents.mode=mirror", applied.agents.mode === "mirror", applied.agents);
  ok("activeId 已置", (await mod.listStore(home)).activeId === made.id);

  console.log("[5] 官方条目 = 清空两个通道");
  applied = await mod.applyEffective(home, mod.OFFICIAL_ID);
  ok("source=official", applied.applied.source === "official", applied.applied);
  ok("prompt-inject.md 清空", (stripBom(await read(injectPath)) || "") === "");
  ok("AGENTS.md 删除", (await read(agentsPath)) === null);
  ok("empty=true", applied.empty === true);

  console.log("[6] 默认提示词");
  await mod.setDefault(home, "默认甲");
  applied = await mod.applyEffective(home, mod.DEFAULT_ID);
  ok("source=default", applied.applied.source === "default", applied.applied);
  ok("默认正文生效", stripBom(await read(injectPath)) === "默认甲");
  await assert.rejects(() => mod.deletePrompt(home, mod.DEFAULT_ID), /不能删除/);
  ok("默认条目拒删", true);

  console.log("[7] 删除");
  const del = await mod.deletePrompt(home, made.id);
  ok("wasActive 判定正确", del.wasActive === false, del);
  ok("条目已删", (await mod.listStore(home)).items.length === 0);

  console.log("[8] HTTP 契约");
  let r = await call("GET", "/dsh-purge/prompts?op=list");
  ok("list 200", r.code === 200 && Array.isArray(r.body.items), r.code);
  r = await call("GET", "/dsh-purge/prompts?op=official");
  ok("official 200 且只读", r.code === 200 && r.body.readonly === true, r.code);
  r = await call("POST", "/dsh-purge/prompts", { op: "save", name: "http", text: "http 正文" });
  const httpId = r.body.id;
  ok("save 200", r.code === 200 && /^p-/.test(httpId), r.code);
  r = await call("POST", "/dsh-purge/prompts", { op: "apply", id: httpId });
  ok("apply 200", r.code === 200 && r.body.applied.source === "item", r.code);
  r = await call("POST", "/dsh-purge/prompts", { op: "delete", id: "" });
  ok("delete 空 id 返回 400（不是 500）", r.code === 400, r.code);
  r = await call("POST", "/dsh-purge/prompts", { op: "apply", id: mod.OFFICIAL_ID });
  ok("回官方 200", r.code === 200 && r.body.empty === true, r.code);

  console.log("[9] UI 页面");
  const ui = await new Promise((resolve) => {
    const res = { writeHead() {}, end(s) { resolve(String(s)); } };
    routes.get("/dsh-purge/prompts/ui")({ method: "GET", url: "/dsh-purge/prompts/ui" }, res);
  });
  ok("UI 含官方条目文案", ui.includes("DSH 官方默认提示词"));
  ok("UI 含只读分支", ui.includes('=== "official"'));
  ok("UI 含新建按钮", ui.includes("createBtn") || ui.includes("另存为新提示词"));

  console.log(`\n全部通过：${passed} 项断言`);
} finally {
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
