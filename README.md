# DSHCodeServerView

> 一个 DeepSeek Harness（DSH）插件：把 **code-server**（VS Code 网页版）作为 DSH Web 界面的**右侧栏原生标签页**内嵌；可选地由插件**托管 code-server 进程**（attach 优先，缺则自动拉起），以及**摘掉它内置的 Copilot**。

在 DSH 里一边和模型对话，一边在同一个窗口里用完整的 VS Code 改代码、开终端。

当前版本 **1.3.1** ｜ DSH `0.2.0-rc+` ｜ code-server `4.x`（实测 4.140.0）｜ 契约测试 **46 项**

---

## 它能做什么

| 模式 | 需要配什么 | 行为 |
|---|---|---|
| **只内嵌**（默认） | 什么都不用配 | 面板连你手动起的 code-server；插件不碰进程 |
| **自动登录** | `+ password` | 宿主渲染登录页替浏览器登录，密码不进前端 JS，面板直接开在已登录的工作台 |
| **全托管** | `+ manage: true` 和 `root` | DSH 起来就把 code-server 一起拉起；已有人跑则接管（不重复起第二个）；DSH 退出时连带回收 |
| **顺带禁用 Copilot** | `+ copilot.disable: true` | 内置 Copilot 扩展**根本不加载** + AI 功能开关关掉 + 清理残留（不改发行版、不需要 fork） |

面板本身是原生右栏页面：可停靠、可浮窗、可全屏、按会话保存布局、可多开。底部工具条显示当前地址、**进程状态徽标**（`运行中` / `已接管现有实例` / `正在启动` / `已退出` / `启动失败`）、`重新加载`、`重启 code-server`（仅托管模式）、`在浏览器标签页中打开`。

从右侧栏「+ / 添加标签页」的引导页点 **VS Code** 卡片即可打开面板。

## 环境要求

| 项 | 要求 |
|---|---|
| DSH | `0.2.0-rc.1+`（本插件按 `0.2.0-rc.2` 的客户端契约编写，并在真实实例上验证装载） |
| code-server | `4.x`（实测 4.140.0）。**手动运行或让插件托管都可以**：托管模式地址默认 `http://127.0.0.1:8080/`，可用 `url` 改 |
| 内嵌可行性 | 已核验：code-server 的响应**不带** `X-Frame-Options`、也没有 `frame-ancestors`；DSH 页面同样没有 CSP 限制。两侧同站（同 `127.0.0.1`，仅端口不同），因此 code-server 的登录 cookie 在 iframe 里正常生效 |

## 安装

下面示例里的 `D:\src\DSHCodeServerView`（本仓库）与 `D:\code-server`（code-server 安装目录）都是**占位示例**，请换成你自己的路径。占位形式说明：`<repo>` = 本仓库的绝对路径。

> **链接安装前，先在本仓库装一次依赖。** 插件以 `link:`（目录链接）方式装进 profile 时，运行时是从**本仓库的真实路径**解析它的依赖的；桌面版（Electron）运行时不会替链接插件解析 DSH 自带库，所以仓库里必须有 `node_modules`：
>
> ```sh
> npm install     # 唯一的运行时依赖：@deepseek-ai/schemastery
> ```
>
> 漏掉这一步的症状是启用失败：`dsh: warning: 1 entry did not activate code-server-view (DSHCodeServerView): failed to import`。

### 方式 A：Desktop 应用（推荐）

桌面应用的 `desktop` profile 由 Electron 独占管理，命令行 `dsh plugin --profile desktop ...` 会被明确拒绝，所以请在界面里安装：

1. DSH → 右侧栏 **Plugins**（插件管理）页 → **Add plugin / 添加插件**
2. 填入 **`<repo>`**（本仓库的绝对路径）
3. 装好后 `desktop` profile 的 `dsh.profile.bundles` 会追加 `DSHCodeServerView`；**无需重启**（实测 4 秒内热生效）

### 方式 B：普通 profile（命令行）

```sh
dsh plugin --profile <profile> add <repo>
dsh --profile <profile> --dump-config      # 应出现 "# == DSHCodeServerView" 层与 "- id: code-server-view"
```

`add` 会同时建立目录链接并自动把 bundle 名追加进 `dsh.profile.bundles`。宿主半部只依赖 DSH 自带的能力（`@deepseek-ai/schemastery` 以 peer 声明，从 DSH 安装里解析），不需要下载额外依赖。

### 方式 C：隔离实例预览（不动任何现有 profile）

```powershell
$repo = 'D:\src\DSHCodeServerView'          # ← 换成你的仓库路径
$base = "$env:TEMP\dsh-codeserver-preview"
$prof = "$base\home\profiles\devtest"
New-Item -ItemType Directory -Force -Path "$prof\node_modules","$base\home\storages" | Out-Null

# profile 清单：bundle 列表里加上本插件（link: 用正斜杠）
$manifest = @{
  name = 'dsh-profile-devtest'; private = $true
  dependencies = @{ DSHCodeServerView = 'link:' + ($repo -replace '\\', '/') }
  dsh = @{ profile = @{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'DSHCodeServerView') } }
}
# 注意：profile 清单不能带 BOM —— DSH 的 readProfileManifest 直接 JSON.parse，带 BOM 会解析失败
[IO.File]::WriteAllText("$prof\package.json", ($manifest | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
'[]' | Set-Content "$prof\cordis.patch.yml" -Encoding utf8
New-Item -ItemType Junction -Path "$prof\node_modules\DSHCodeServerView" -Target $repo

$env:DSH_HOME = "$base\home"
dsh --profile devtest --port 3099 --no-open
```

日志里出现 `[code-server-view] host half mounted`、首页启动图里出现本插件条目即装载成功。

右栏是**会话级**的：全新实例里没有会话时它不会挂载。可以先在 `$DSH_HOME\storages\workspace.json` 里预置一个工作区（把两处 `<guid>` 换成同一个 GUID，`path` 换成你想在 VS Code 里打开的目录——JSON 里反斜杠要写成 `\\`）：

```json
{
  "unit": { "name": "workspace", "version": 2 },
  "global": { "initialized": true, "defaultWorkspaceId": "<guid>", "workspaceIds": ["<guid>"], "archivedSessionIds": [], "pinnedSessionIds": [] },
  "tables": { "workspaces": { "<guid>": { "path": "D:\\src\\my-project", "title": "my-project", "sessionIds": [], "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" } } }
}
```

## 配置

宿主半部用标准的 cordis `Config` 声明（`index.js` 导出 schema 与默认值）。在 profile 的 `cordis.patch.yml`（或更晚的补丁层）里覆盖本插件的行即可——补丁会**整行替换** `config`，所以要写全你需要的键。

### 全部配置项

| 键 | 默认值 | 含义 |
|---|---|---|
| `url` | `http://127.0.0.1:8080/` | code-server 地址；缺 scheme 自动补 `http://`、缺尾斜杠自动补，可带路径前缀（`http://host:8080/code/`） |
| `password` | 空 | code-server 密码；留空则面板显示 code-server 自己的登录页 |
| `autoLogin` | `true` | 配了密码时是否自动登录 |
| `manage` | `false` | 由插件托管进程：先探测 `url`，活着就接管，没活才拉起 |
| `root` | 空 | code-server 根目录（release 目录或**构建过的**源码目录）；留空时用构建过的 `vendor/code-server` 子模块 |
| `args` | `[]` | 额外的 code-server 参数；留空则从 `url` 推导 `--bind-addr` |
| `cwd` | 空 | 子进程工作目录；留空用 `root` |
| `dataDir` | 空 | 传给 `--user-data-dir`；留空用 code-server 的默认数据目录（开了 Copilot 层时插件会把这个默认值**显式钉住**，好让它知道设置与缓存写在哪） |
| `healthPath` | `/healthz` | 判断"是否已就绪/是否已有人跑"的探测路径 |
| `startTimeoutMs` | `30000` | 启动后等待就绪的上限 |
| `graceMs` | `8000` | 终止子进程时给的宽限时间 |
| `restart` | `on-failure` | 非预期退出后的重启策略（`never` / `on-failure`，最多 3 次退避重试） |
| `stopOnUnload` | `false` | 插件卸载时是否停掉进程（默认不停，理由见「托管进程」） |
| `workDir` | 空 | 派生文件（过滤后的内置扩展目录）放哪；留空用 `$DSH_HOME\cache\code-server-view`，没有 `DSH_HOME` 时用平台缓存目录 |
| `copilot` | 见下 | 内置 Copilot 的处理方式；`disable` 默认 `false`（完全不动） |

`copilot` 子项：

| 键 | 默认值 | 含义 |
|---|---|---|
| `disable` | `false` | 总开关；`false` 时该层完全不动作 |
| `builtinExtensions` | `true` | 杠杆 1：用过滤后的 `--builtin-extensions-dir` 让 Copilot 不被加载 |
| `exclude` | `['GitHub.copilot-chat', 'GitHub.copilot']` | 按 `publisher.name` 匹配（大小写不敏感） |
| `excludePublishers` | `[]` | 按 publisher 整片摘掉；例如 `['GitHub']` 会连 GitHub 认证一起摘（会影响 git 登录） |
| `settings` | `true` | 杠杆 2：合并 AI-off 设置块 |
| `settingsPolicy` | `enforce` | `enforce` 覆盖冲突值；`fill` 只补缺失键 |
| `purgeCaches` | `true` | 杠杆 3：清 Copilot 残留与内置扩展缓存 |
| `purgeChatModels` | `false` | 是否连 BYOK 模型登记（`chatLanguageModels.json`）一起删 |

### 两份最小示例

```yaml
# ① 只内嵌：面板连你手动起的 code-server
- id: code-server-view
  name: 'DSHCodeServerView'
  config:
    url: 'http://127.0.0.1:8080/'
    password: '你的 code-server 密码'
    autoLogin: true

# ② 全托管 + 禁用 Copilot
- id: code-server-view
  name: 'DSHCodeServerView'
  config:
    url: 'http://127.0.0.1:8080/'
    manage: true
    root: 'D:\code-server'
    dataDir: 'D:\code-server-data'
    password: '你的 code-server 密码'
    copilot:
      disable: true
```

### 生效方式

- 改 **`config`**：HMR 热替换宿主半部，**不用重启 DSH**（实测保存后 4 秒生效）；已经打开的面板**重新打开一次标签页**即可读到新配置。
- 改 **插件源码**：需要重启 DSH（实测源码改动不会热加载）。

### 让别的插件指定地址

导航参数优先级最高，且此时不读配置、也不自动登录：

```js
ctx.sidebarRight.openTab('code-server-view', { params: { url: 'http://127.0.0.1:8080/?folder=D:/proj' } })
```

## 密码与自动登录

面板里的 iframe 是跨源的：父页面**不能**读它的 DOM，也不能替它填表单。所以插件没有把密码交给页面：

1. 宿主在 `/codeserver-view/config` 只发布 `{ url, autoLogin, hasPassword, supervisor }` —— **不含密码**；
2. 配了密码时，浏览器半部把 iframe 指向宿主的 `/codeserver-view/login`：宿主渲染的页面里是一个自动提交的表单，把密码 POST 到 code-server 自己的 `/login`；
3. code-server 校验通过后种下会话 cookie 并 302 回工作台；失败则回到它自己的登录页——面板于是显示登录表单，而不是白屏。

因此密码只存在于宿主内存与那一次页面响应里，前端 JS 里既没有密码也没有地址常量。这个登录页（以及另两条路由）**只应答回环地址的请求**，其它来源一律 404。自动登录要求浏览器能**直接**访问 code-server 地址。

## 托管 code-server 进程

`manage: true` 时：

1. **先探测再决定**：`healthPath` 有响应就接管（`attached`），不响应才从 `root` 拉起（`managed`）。所以你手动起的实例、或 HMR 重载后的第二个插件实例，都不会抢同一个端口或同一份数据目录。
2. **启动命令**：`<root>\lib\node.exe <root> --bind-addr <host:port> [--user-data-dir …] [--builtin-extensions-dir …]`（release 布局用自带的 `lib/node`；构建过的源码布局退回系统 `node`）。密码走**环境变量 `PASSWORD`**，绝不进命令行。启动失败（如 `EADDRINUSE`）会在 `startTimeoutMs` 后连**子进程输出尾部**一起报出来，面板同时给出 `重启` 按钮。
3. **收尾靠 Job Object，不靠插件**：DSH 的子进程服务把子进程放进 Windows kill-on-close Job，`terminate()` + `waitForExit()` 覆盖整棵进程树。所以 `stopOnUnload` 默认 `false`——**改配置触发的 HMR 重载不会把你的 IDE 杀掉重启**；而 DSH 进程真正退出时，Job 关闭会连带收走 code-server，不留孤儿（实测：直接杀宿主进程，2 秒内 code-server 随之消失）。
4. **状态可查**：`GET /codeserver-view/config` 的 `supervisor` 字段给出 `mode/state/root/rootSource/version/exitCode/restarts/message/uptimeMs`（子进程服务不暴露 pid）。

## 禁用内置 Copilot（可选）

code-server 把 GitHub Copilot Chat 作为**内置扩展**随 VS Code 一起装进来——既不能在扩展面板里卸载，也不能用 `--disable-extension`（code-server 的 CLI 对表外选项直接报 `Unknown option`，也没有把任意参数转给 VS Code server 的机制）。所以插件用三条**不需要 fork、也不改发行版**的杠杆：

| 杠杆 | 做法 | 写在哪 |
|---|---|---|
| 1 过滤内置扩展 | 把 `<root>/lib/vscode/extensions` 里除 Copilot 之外的扩展用 junction 链到自己的目录，启动时传 `--builtin-extensions-dir` → Copilot **根本没被加载** | 插件的 `workDir`（派生的 junction 集合） |
| 2 设置 | 合并写入 `chat.disableAIFeatures`、`chat.commandCenter.enabled: false`、`workbench.secondarySideBar.defaultVisibility: hidden`、`github.copilot.enable: {"*": false}`、`telemetry.telemetryLevel: off` | code-server 数据目录的 `User/settings.json` |
| 3 清残留 | 删 `User/globalStorage/github.copilot*`、`CachedProfilesData/*/extensions.builtin.cache`、两个内置扩展缓存 | code-server 数据目录 |

几个刻意的设计决定：

- **只在托管模式生效**：插件得自己 spawn 才能决定 argv 与数据目录；attach（接管你已有的实例）时什么都不动，状态里写明原因。
- **升级自愈**：过滤目录是**派生数据**，指纹由「源目录条目 + 每个扩展的 `id@版本` + 排除名单」算出。换 code-server 版本（换子模块 tag 或覆盖安装）后指纹变化 → 下次启动自动重建、旧目录清掉；指纹不变则复用（实测第二次启动不重建）。设置与缓存在数据目录里，不受安装覆盖影响。
- **按扩展 id 匹配**：读每个候选目录的 `package.json` 取 `publisher.name`，所以上游改目录名也照样命中；**读不出清单的目录一律保留**（不认识的东西绝不动）。
- **安全护栏**：`workDir` 落在插件包内或安装目录内 → **拒绝执行**并报 `unsafe-work-dir`，保证不往你的仓库或发行版里写任何东西。
- **设置是合并不是覆盖**：JSONC（允许注释）容错解析；解析失败就**放弃写入并报告**，绝不改写你的文件；首次写入前留一份 `settings.json.dsh-backup`。

## code-server 从哪来：Git Submodule

本仓库用 **`vendor/code-server` 子模块**钉住 code-server 的版本（当前 `v4.140.0` / `ccc19ad`），而不是把上游代码抄进来：

```sh
git submodule update --init --depth 1 vendor/code-server     # 克隆后初始化
# 升级到某个上游版本：换 tag、checkout、再提交 gitlink
git -C vendor/code-server fetch --depth 1 origin tag v4.140.0
git -C vendor/code-server checkout v4.140.0
git add vendor/code-server .gitmodules
```

**关键区别：子模块是源码，不是可运行产物。** 刚 clone 的 `vendor/code-server` 没有 `lib/vscode` 也没有 `out/`，跑不起来；插件只在它**被构建过**（存在 `out/node/entry.js`）时才拿它当 `root`，否则要用 `config.root` 指向现成 release（例如解压出来的 `D:\code-server`）。想"完全由子模块驱动"就得构建 code-server（Windows 上较麻烦，官方更推荐 WSL/Docker），取舍见「已知限制」。

另外：以 tarball / registry 方式安装本插件时**不会带子模块内容**（`files` 白名单里没有 `vendor/`）。子模块只服务于"从 git 检出本仓库"的情形，作为版本锚点与升级入口。

## 工作原理

本包是一个标准 DSH **bundle**：

| 文件 | 作用 |
|---|---|
| `package.json` | `dsh.bundle.patch` 指向补丁层；`dsh.client`（`platform: "web"` + 依赖包顺序）声明浏览器半部；`exports["./client"]` 指向客户端产物；`icon` 供 Plugins 页显示 |
| `cordis.patch.yml` | 一行 `insert`，把宿主半部挂成 Loader 行 `code-server-view`（`name` 必须是**裸包名**）；注释里带完整配置说明 |
| `index.js` | 宿主半部：`Config` schema、三条回环路由、把 supervisor 与 Copilot guard 接到 spawn 路径上 |
| `supervisor.js` | 进程托管状态机：探测/接管/启动/健康等待/退出处理/重启/收尾 |
| `copilot.js` | Copilot 三条杠杆与安全护栏 |
| `client.js` | 浏览器半部：`window.__ModuleLoader__.load({ id, factory })` 懒工厂，`require('react')` 走 shell 的共享模块表 |
| `locale/zh.json`、`locale/en.json` | Plugins 页显示的标题与描述（`meta.title` / `meta.description`） |
| `icon.svg` | Plugins 页的图标。**必须在清单根写 `"icon": "./icon.svg"`**：只声明 `exports["./icon"]` 时本机 loader 会静默解析失败、页面退回兜底字形（实测，详见[验证记录](docs/verification.md)） |

**宿主三条路由**（都只应答回环来源）：

| 路由 | 作用 |
|---|---|
| `GET /codeserver-view/config` | 发布 `{ url, autoLogin, hasPassword, supervisor }`，**不含密码** |
| `GET /codeserver-view/login` | 自动提交表单，替浏览器登录 code-server |
| `POST /codeserver-view/restart` | 停掉受管进程（terminate + waitForExit）后重新启动 |

**浏览器半部**在 `apply(ctx)` 里注册四件事，每件都由 `ctx.effect` 拥有、卸载自动回收：

1. `ctx.locale.register('DSHCodeServerView', { zh, en })` —— 中英文案
2. `ctx.sidebarRightTabs.register({ id, kind, priority: 'extension', title, guide })` —— 标签页**类型** + 引导页卡片（`openTab` 在没有会话界面时会抛错，所以本插件不主动抢开）
3. `ctx.slots.inject('sidebar.right.pane.tab')` + `register({ key: 类型 id }, 正文)` —— 正文 iframe
4. `ctx.slots.inject('sidebar.right.pane.tab.title')` + `register({ key: 类型 id }, 标题)` —— 芯片标题

```
右侧栏 (ui-sidebar-right)
└─ sidebar.right.pane.tab        ← keyed 座位，key = DSHCodeServerView  → 正文
└─ sidebar.right.pane.tab.title  ← keyed 座位，key = DSHCodeServerView  → 标题
```

## 开发

```sh
node --check index.js supervisor.js copilot.js client.js   # 语法
node test/contract.test.mjs                                # 契约测试，46 项
node test/docs.test.mjs                                    # 文档检查，12 项
npm test                                                   # 两者都跑
```

`test/contract.test.mjs` 是**零依赖**的：它把 `supervisor.js` / `copilot.js` 当真实模块 import，把 `index.js` 放进沙箱（替换 `@deepseek-ai/schemastery` 为桩）、用桩 React 与桩 `fetch` 执行真实的 `client.js`，覆盖：

- **包与清单**：patch 行名、`dsh.client.platform`、`icon` 存在、每个 locale 的 title/description、peer 声明
- **浏览器半部**：模块装载握手、工厂无副作用、四处注册与 key 取值、等待配置的占位、按配置选择 iframe 目标（地址 / 宿主登录路由 / `params.url` 覆盖 / 无宿主时回退默认）、工具条控件
- **宿主路由**：配置归一化与非法地址回退、密码不进响应体、登录页转义与自动提交、无密码或关闭自动登录时改 302、非回环来源 404
- **托管状态机**：开关关闭时零动作、活地址被接管而非重复 spawn、argv 推导（`--bind-addr`/`--user-data-dir`）、密码只在 env 不在 argv、不可运行的 root 被拒、超时报告输出尾部、退出上报、重启路由、`stopOnUnload` 两种语义
- **Copilot guard**：关闭时零写入、按 id 过滤并保留不可读目录、publisher 规则、升级后重建与旧目录清理、设置合并且保留用户键、不可解析时不动文件、`fill`/`enforce` 两种策略、清理范围与无关状态保留、`workDir` 护栏

`test/docs.test.mjs` 同样零依赖，检查文档是否还与代码一致：schema 里每个配置键与每条路由都被写到、版本号与两套测试的项数与实际一致、每个打包文件与宿主模块都被描述、所有相对链接都落到真实文件、**仓库里不允许出现位图资源**（文档一律纯文字）、不允许出现某台机器专属的绝对路径、所有文本文件必须是合法 UTF-8（无 BOM、无替换字符），以及那几个改过的错句不得复活。

## 验证

七层实测（隔离实例 + 无头 Edge 驱动真实 DSH 客户端），结论：

| 层 | 结论 |
|---|---|
| 契约与装载 | 宿主半部装载；启动图含本插件；client bundle 逐字节一致 |
| 浏览器界面 | 引导页卡片 → 原生标签页 → iframe 渲染出 code-server（707×757） |
| 与 `dsh-better-sidebar` 共存 | 两者的引导卡片并列，互不遮挡，面板表现一致 |
| 真实安装路径 | `dsh plugin add <dir>` 自动追加 bundle，运行中实例**免重启**生效；Plugins 页标题/描述/状态/图标正确 |
| 配置与自动登录 | 密码不进响应体；自动登录后 `document.cookie` 出现 `code-server-session`，面板直接进工作台；改 `config` 4 秒热生效 |
| 进程托管 | 插件拉起 code-server（密码在 env）；重启路由替换进程；**杀宿主不留孤儿** |
| Copilot 禁用 | 95 保留/1 移除；设置与缓存落盘；VS Code 自己解析出的 94 个内置扩展**无一含 copilot**；工作台没有 Chat 入口 |

逐条证据、命令与响应体见 **[docs/verification.md](docs/verification.md)**（纯文字记录，不含截图）。

仍未验证：用**你自己的** code-server 密码登录后的观感；**装进真实 `desktop` profile 之后的运行**（插件目前尚未安装，步骤见「安装」方式 A）。

## 已知限制

- **目录链接安装需要先在本仓库 `npm install`**：链接安装（`link:`）时插件从本仓库真实路径解析依赖，而打包后的桌面（Electron）运行时不替链接插件解析 DSH 自带库；漏装的症状是 `failed to import`。以 tarball/实体方式装进 profile 的副本不受影响
- **没有 Settings 图形界面**：配置走补丁层 YAML。改 `config` 会 HMR 热替换，**改插件源码需要重启 DSH**
- **Copilot 层只在托管模式生效**，且**不改发行版的 `product.json`**（该激进项未实现）——所以"连 Chat 的身份一起去掉"做不到，命令面板里可能仍残留个别入口；扩展不加载 + AI 开关 + 清理已覆盖实际使用面
- **子模块是源码不是可运行产物**：必须 `config.root` 指向现成 release，或在 Windows 上构建 code-server（成本高、易失败）
- **包名含大写**：`DSHCodeServerView` 不是 npm 注册表可接受的新包名，只能以本地路径 / git / 私有源安装；改名要同步 `cordis.patch.yml`、`client.js` 与 `dsh.client`（包名同时是 Loader 行 id、浏览器模块 id 与 `window.__ModuleLoader__.load({ id })` 的键）
- **自动登录**依赖浏览器能直连 code-server 地址，且其登录页是标准表单（code-server 4.x 是）
- 子进程服务不暴露 pid，面板状态里只有状态/根目录/版本/退出码
- 内嵌的是 iframe：code-server 保留自己的主题与快捷键，不继承 DSH 的主题 token；焦点在面板内时快捷键由 VS Code 处理，可能与 DSH 冲突
- 未加 `sandbox` 属性收紧（code-server 需要自身 origin 的存储与 WebSocket）；`allow` 仅开放剪贴板与全屏

## English

`DSHCodeServerView` is a DeepSeek Harness plugin bundle that embeds a **code-server** (VS Code for the Web) instance as a native tab in the Harness Web GUI's right sidebar, optionally supervises that instance's process, and optionally keeps its built-in Copilot out.

- **Panel**: one right-sidebar tab type plus a guide-page capsule; the body is an `<iframe>` with a toolbar showing the address, a supervision-state badge, reload, restart (managed mode) and open-in-browser. Registrations go through `ctx.sidebarRightTabs.register` and the keyed `sidebar.right.pane.tab` / `.title` seats; React comes from the shell's shared module table.
- **Configuration** (cordis `Config`, edited from a profile patch): `url`, `password`, `autoLogin` for where the panel points and how it logs in; `manage`, `root`, `args`, `cwd`, `dataDir`, `healthPath`, `startTimeoutMs`, `graceMs`, `restart`, `stopOnUnload` for process supervision; `workDir` and a `copilot` block for the Copilot layer.
- **Process supervision**: probe first and adopt whatever answers, spawn only when nothing does (`<root>\lib\node.exe <root> --bind-addr …`), with the password passed through the child's environment rather than argv. Lifetime rides the subprocess service's kill-on-close Job, so a config reload never kills your IDE and DSH exiting leaves no orphan.
- **Copilot removal** (opt-in, no fork, installation untouched): a filtered `--builtin-extensions-dir` so Copilot is never loaded, the AI-off settings block merged into the user settings, and Copilot's caches purged. The filtered directory is keyed by a fingerprint, so an upgrade rebuilds it while an unchanged installation reuses it.
- **Host routes** (loopback only): `GET /codeserver-view/config`, `GET /codeserver-view/login` (auto-submitting login, so the password never reaches the browser half), `POST /codeserver-view/restart`.
- **code-server tracking**: a Git submodule pinned to `v4.140.0`, used as the version anchor; the submodule is source, not a runnable artifact.
- Install with `dsh plugin --profile <name> add <this directory>`, or through the Desktop application's Plugins page. A linked install (a directory link into this checkout) resolves its dependencies from this checkout, so run `npm install` here first — otherwise activation fails with `failed to import`. `npm test` runs the dependency-free contract test (46 checks) for both halves.

## License

MIT
