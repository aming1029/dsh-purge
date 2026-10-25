# 提示词库（Prompts Library）

把插件里原本分散的「提示词框 / 规则集」统一成一份**可多份管理**的提示词库：新建、改名、编辑、删除、设为默认，点「应用」当场生效；没有应用任何条目时使用「默认提示词」；两者都可编辑、都在界面里可见。「DSH 官方默认提示词」是一条**只读**条目，代表「什么都不注入，让 DSH 自己组装」。

> 补丁（`lib/core.js` 里那 66 条）逻辑未改动，本模块只负责提示词的存取与应用。

## 1. 模型

```
$DSH_HOME/dsh-purge/prompts/
├── index.json      { version, activeId, items:[{id,name,createdAt,updatedAt,chars}], migrationDone }
├── default.md      默认提示词（未应用任何条目时生效，可编辑、界面可见）
├── <id>.md         用户新建的提示词（可多份，可改可删）
├── official.md     官方基线快照（只读条目，每次读取时重新生成）
└── backups/        覆盖 / 删除 / 迁移前的历史副本
```

- `activeId`：当前生效条目；`"official"` = 官方默认（虚拟条目，不落文件）；`null` 且 `default.md` 非空时按 `default` 生效。
- 条目 id 形如 `p-<slug>-<rand>`，可用字符 `[a-z0-9_-]`。
- 首次初始化时 `default.md` 从插件加密槽（`table-read.js openSlot()`）灌一次；之后**缺失一律建空文件**，避免用户清空后又被灌回出厂人设。

## 2. 「应用」到底做了什么

`applyEffective(home, id)` 双通道即时落盘，**不需要重启**：

| 通道 | 落点 | 作用 |
|---|---|---|
| ① system 层 | `$DSH_HOME/prompt-inject.md` | 走插件官方入口 `core.saveOverrideContent()`：原子写 + 进程内钉（`rememberCommittedOverride`）+ 标记 `customized`，所以下一轮装配就带新文本 |
| ② workspace 层 | `$DSH_HOME/AGENTS.md` | 镜像同一份正文（`\uFEFF` + 正文 + `\n`）；正文为空则**删除该文件**，workspace 层回到官方默认 |

应用完成后调用方执行 `refreshHungOperator(core.findDshHome())`，把内存钉子同步刷新。

为什么要两个通道：某些中转网关会重写 / 丢弃 `system` 字段（实测 `mywb2` 会吞、`me-ds` 透传）。`AGENTS.md` 以 user 轮 `<system-reminder>` 形式投递，是穿透这类网关的兜底；换回透传网关后 system 通道即第一层。

## 3. HTTP 契约

单一路由 `/dsh-purge/prompts`（`installPromptsHttp(webServer, deps)` 注册；面板 iframe 与独立页面都走它）：

| 方法 | 请求 | 返回要点 |
|---|---|---|
| GET | `?op=list` | `{ok, activeId, items[], default{}, official{}, dir, effective{}}` |
| GET | `?op=get&id=<id>` | `{ok, id, name, text}`（`official` 返回只读快照） |
| GET | `?op=official` | `{ok, ...officialSnapshot}` |
| POST | `{op:"save", id?, name, text}` | 有 `id` 覆盖、无 `id` 新建；空正文拒绝（`400 正文为空`） |
| POST | `{op:"set-default", text}` / `{op:"reset-default"}` | 改默认提示词 / 恢复出厂默认 |
| POST | `{op:"delete", id}` | 默认条目不可删；删掉生效条目则 `activeId=null` |
| POST | `{op:"apply", id}` | `id:"official"` 等价「清空两个通道」 |

页面：`GET /dsh-purge/prompts/ui`（单文件内嵌 HTML，面板里以 iframe 内嵌，也可独立窗口打开）。

错误约定：参数 / 语义错误统一 `400 {ok:false,error}`，不再出现裸 `500`。

## 4. 前端行为

- 「应用」先保存当前编辑再 `apply`，不会把刚粘进去的正文冲掉。
- 任何输入都会写 `localStorage['dshp-pl-draft:<id>']` 草稿；切换条目自动保存，服务端为空时自动恢复草稿。
- 「新建 / 另存为新提示词」要求正文非空，创建后立即选中，可直接应用。
- `official` 与只读条目：禁用「保存 / 删除 / 设为默认」，「另存为新提示词」只复制快照里的官方原文。

## 5. 自测

```bash
node tests/prompts-lib.test.mjs     # 33 项断言，使用临时 home，不碰真实 $DSH_HOME
```

覆盖：初始化、新建（含空正文守卫）、列表、应用（双通道落盘）、官方条目清空、默认提示词、删除（`wasActive` 判定）、HTTP 契约（含错误码）、UI 页面关键节点。

## 6. 回滚

模块文件 `lib/prompts-lib.js` 与 `lib/index.js` 的接线是纯新增：

```powershell
# 停用：删掉 lib/index.js 里 trackRoute(promptsLib.installPromptsHttp(...)) 那一行
# 或者整目录删掉，插件回退到旧的提示词框（旧 POST /dsh-purge/override 已被 409 关闭，需要一并恢复）
```

数据层回滚：把 `prompts/backups/` 里对应文件拷回 `prompts/<id>.md`；要让宿主彻底回官方提示词，应用 `official` 条目即可（等价于 `prompt-inject.md` 清空 + 删除 `AGENTS.md`）。
