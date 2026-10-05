# DSHCodeServerView

> 一个 DeepSeek Harness（DSH）插件：把本机运行的 **code-server**（VS Code 网页版）作为 DSH Web 界面的**右侧栏标签页**内嵌进来。

在 DSH 里一边和模型对话，一边在同一个窗口里用完整的 VS Code 改代码、开终端。

---

## 效果与用法

- 打开 DSH 右侧栏 → 「+ / 添加标签页」→ 在引导页里点 **VS Code** 卡片
- 该标签页就是一个原生右栏页面：可停靠、可浮窗、可全屏、按会话保存布局、可多开（每开一个独立标签页）
- 面板底部一条细工具条：当前地址、**重新加载**、**在浏览器标签页中打开**
- 面板正文是一个 `iframe`，内容即 `http://127.0.0.1:8080/`；code-server 的登录页也会内嵌显示，密码在面板里直接输入即可

## 环境要求

| 项 | 要求 |
|---|---|
| DSH | `0.2.0-rc.1+`（本插件按 `0.2.0-rc.2` 的客户端契约编写，并已在真实 DSH 实例上验证装载） |
| code-server | 运行中，默认监听 `http://127.0.0.1:8080/`（如 `code-server --bind-addr 127.0.0.1:8080`） |
| 内嵌可行性 | 已核验：code-server 4.140.0 的响应**不带** `X-Frame-Options`、也没有 `frame-ancestors`；DSH 页面同样没有 CSP 限制。两侧同站（同 `127.0.0.1`，仅端口不同），因此 code-server 的登录 cookie 在 iframe 里正常生效 |

## 安装

### 方式 A：Desktop 应用（推荐）

桌面应用的 `desktop` profile 由 Electron 独占管理，命令行 `dsh plugin --profile desktop ...` 会被明确拒绝，所以请在界面里安装：

1. DSH → 右侧栏 **Plugins**（插件管理）页
2. **Add plugin / 添加插件** → 填入本仓库的绝对路径：`E:\it-project\DSHCodeServerView`
3. 安装成功后，`desktop` profile 的 `dsh.profile.bundles` 会追加 `DSHCodeServerView`；profile 开启 HMR 时立即生效，无需重启

> 该操作等价于在 profile 目录里执行 `pnpm add link:E:/it-project/DSHCodeServerView` 并把 bundle 名追加进 `dsh.profile.bundles`。本包没有任何运行时依赖，安装不需要联网。

### 方式 B：普通 profile（命令行）

```sh
dsh plugin --profile <profile> add E:\it-project\DSHCodeServerView
dsh --profile <profile> --dump-config      # 应出现 "# == DSHCodeServerView" 层与 "- id: code-server-view"
```

### 方式 C：开发者验证 / 预览（不动任何现有 profile）

用一个隔离的 `DSH_HOME` 起一个临时实例——本项目所有验证都是这样做的（Windows 路径）：

```powershell
$prev = "$env:TEMP\dsh-codeserver-preview"
$prof = "$prev\home\profiles\devtest"
New-Item -ItemType Directory -Force -Path "$prof\node_modules","$prev\home\storages" | Out-Null
# profile 清单：bundle 列表里加上本插件
@'
{ "name": "dsh-profile-devtest", "private": true,
  "dependencies": { "DSHCodeServerView": "link:E:/it-project/DSHCodeServerView" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "DSHCodeServerView"] } } }
'@ | Set-Content "$prof\package.json" -Encoding utf8
'[]' | Set-Content "$prof\cordis.patch.yml" -Encoding utf8      # 该 profile 的补丁层
'[]' | Set-Content "$prof\cordis.yml" -Encoding utf8
New-Item -ItemType Junction -Path "$prof\node_modules\DSHCodeServerView" -Target 'E:\it-project\DSHCodeServerView'

$env:DSH_HOME = "$prev\home"
dsh --profile devtest --port 3099 --no-open
```

日志里出现 `[code-server-view] host half mounted`，首页启动图里出现本插件条目即装载成功。
首次打开界面没有工作区时会提示选择文件夹，可以先在 `$DSH_HOME\storages\workspace.json` 里预置一个工作区（见本文「验证记录」一节的做法）。

## 配置

插件通过标准的 cordis `Config` 暴露可选配置项（宿主半部 `index.js` 导出 schema 与默认值）。前三个决定“面板连哪里、怎么登录”，其余决定“插件要不要自己把 code-server 跑起来”：

| 键 | 默认值 | 含义 |
|---|---|---|
| `url` | `http://127.0.0.1:8080/` | code-server 地址；缺 scheme 会自动补 `http://`、缺尾斜杠会自动补，可以带路径前缀（如 `http://host:8080/code/`） |
| `password` | 空 | code-server 密码；留空则面板显示 code-server 自己的登录页 |
| `autoLogin` | `true` | 配了密码时是否自动登录；设为 `false` 表示保留密码但不自动登录 |
| `manage` | `false` | **让插件托管进程**：先探测 `url`，活着就接管（attach），没活才拉起（spawn） |
| `root` | 空 | code-server 根目录（release 目录或构建好的源码目录）；留空时自动使用构建过的 `vendor/code-server` 子模块 |
| `args` | `[]` | 额外的 code-server 参数；留空则从 `url` 推导 `--bind-addr` |
| `cwd` | 空 | 子进程工作目录；留空用 `root` |
| `dataDir` | 空 | 传给 `--user-data-dir`；留空用 code-server 自己的默认数据目录 |
| `healthPath` | `/healthz` | 用来判断"是否已就绪"的探测路径 |
| `startTimeoutMs` | `30000` | 启动后等待就绪的上限 |
| `graceMs` | `8000` | 终止时给子进程的宽限时间 |
| `restart` | `on-failure` | 非预期退出后的重启策略（`never` / `on-failure`） |
| `stopOnUnload` | `false` | 插件卸载时是否停掉进程（默认不停，见下） |

在 profile 的 `cordis.patch.yml`（或任何更晚的补丁层）里覆盖本插件的行即可。补丁会**整行替换** `config`，所以要写全你需要的键：

```yaml
# 只内嵌：不碰进程，面板连你手动起的 code-server
- id: code-server-view
  name: 'DSHCodeServerView'
  config:
    url: 'http://127.0.0.1:8080/'
    password: '你的 code-server 密码'
    autoLogin: true

# 托管：DSH 起来就把 code-server 一起带起来（已有人跑则自动接管，不会起第二个）
- id: code-server-view
  name: 'DSHCodeServerView'
  config:
    url: 'http://127.0.0.1:8080/'
    manage: true
    root: 'E:\code-server'
    dataDir: 'C:\Users\you\code-server-data'
    password: '你的 code-server 密码'
```

保存即生效：Harness 的 HMR 会热替换宿主半部（改 `config` 无需重启 DSH，**改插件源码才需要重启**）；已经打开的面板重新打开一次标签页即可读到新配置。

其它插件也可以用导航参数临时指定地址——它优先级最高，且此时不读配置、也不自动登录：

```js
ctx.sidebarRight.openTab('code-server-view', { params: { url: 'http://127.0.0.1:8080/?folder=E:/proj' } })
```

### 托管模式做了什么

1. **先探测再决定**：`url` 的 `healthPath` 有响应就接管（状态 `attached`），不响应才从 `root` 拉起（状态 `managed`）。因此你手动起的实例、或 HMR 重载后的第二个插件实例，都不会抢同一个端口或同一份数据目录。
2. **启动**：`<root>\lib\node.exe <root> --bind-addr <host:port> [--user-data-dir …]`。密码走**环境变量 `PASSWORD`**，绝不进命令行（进程列表是公开的）；`EADDRINUSE` 之类失败会在 `startTimeoutMs` 后连子进程输出尾部一起报出来。
3. **收尾靠 Job Object，不靠插件**：DSH 的子进程服务把子进程放进 Windows kill-on-close Job，`terminate()` + `waitForExit()` 覆盖整棵进程树。所以默认 `stopOnUnload: false`——**改配置触发 HMR 重载时不会把你的 IDE 杀掉重启**；而 DSH 进程真正退出时，Job 关闭会连带收走 code-server，不留孤儿。
4. **面板**：工具条显示 `运行中 / 已接管现有实例 / 正在启动 / 已退出 / 启动失败` 状态徽标与 `重启 code-server` 按钮（走 `POST /codeserver-view/restart`，它 terminate + waitForExit 后重新 spawn）。启动中面板显示占位而不是去 frame 一个还没监听的端口。

### 自动干掉 code-server 的 Copilot（可选）

code-server 把 GitHub Copilot Chat 作为**内置扩展**随 VS Code 一起装进来——既不能在扩展面板里卸载，也不能用 `--disable-extension`（code-server 的 CLI 对表外选项直接报 `Unknown option`，我实测确认过）。所以插件用的是三条**不需要 fork、也不改发行版**的杠杆：

| 杠杆 | 做法 | 写在哪 |
|---|---|---|
| 1 过滤内置扩展 | 把 `<root>/lib/vscode/extensions` 里除 Copilot 之外的扩展用 junction 链到自己的目录，启动时传 `--builtin-extensions-dir` → Copilot **根本没被加载** | 插件的 `workDir`（派生的 junction 集合） |
| 2 设置 | 合并写入 `chat.disableAIFeatures`、`chat.commandCenter.enabled: false`、`workbench.secondarySideBar.defaultVisibility: hidden`、`github.copilot.enable: {"*": false}`、`telemetry.telemetryLevel: off` | code-server 数据目录的 `User/settings.json` |
| 3 清残留 | 删 `User/globalStorage/github.copilot*`、`CachedProfilesData/*/extensions.builtin.cache`、两个内置扩展缓存 | code-server 数据目录 |

```yaml
- id: code-server-view
  name: 'DSHCodeServerView'
  config:
    manage: true
    root: 'E:\code-server'
    dataDir: 'C:\Users\you\code-server-data'
    copilot:
      disable: true                  # 总开关，默认 false（完全不动）
      builtinExtensions: true        # 杠杆 1
      exclude: ['GitHub.copilot-chat', 'GitHub.copilot']
      excludePublishers: []          # 例如填 ['GitHub'] 会连 GitHub 认证一起摘掉（会影响 git 登录）
      settings: true                 # 杠杆 2
      settingsPolicy: 'enforce'      # enforce 覆盖冲突值；fill 只补缺失键
      purgeCaches: true              # 杠杆 3
      purgeChatModels: false         # 是否连 BYOK 模型登记（chatLanguageModels.json）一起删
    workDir: ''                      # 派生文件位置；默认 $DSH_HOME\cache\code-server-view
```

几个刻意的设计决定：

- **只在托管模式生效**：插件得自己 spawn 才能决定 argv 与数据目录；attach（接管你手动起的实例）时什么都不动，状态里写明原因。
- **升级自愈**：过滤目录是**派生数据**，指纹由「源目录条目 + 每个扩展的 `id@版本` + 排除名单」算出。你换 code-server 版本（换子模块 tag 或覆盖安装）后指纹变化 → 下次启动自动重建，旧目录清掉。设置与缓存在数据目录里，不受安装覆盖影响。
- **按扩展 id 匹配**：读每个候选目录的 `package.json` 取 `publisher.name`，所以上游改目录名也照样命中；**读不出清单的目录一律保留**（不认识的东西绝不动）。
- **安全护栏**：`workDir` 若落在插件包内或 code-server 安装目录内，插件**拒绝执行**并在状态里报 `unsafe-work-dir`——保证不往你的仓库或发行版里写任何东西。
- **设置是合并不是覆盖**：JSONC（允许注释）容错解析；解析失败就**放弃写入并报告**，绝不改写你的文件；首次写入前留一份 `settings.json.dsh-backup`。

### code-server 从哪来：Git Submodule

本仓库用 **`vendor/code-server` 子模块**钉住 code-server 的版本，而不是把上游代码抄进来：

```sh
git submodule update --init --depth 1 vendor/code-server     # 克隆后初始化
# 升级到某个上游版本：换 tag、checkout、再提交 gitlink
git -C vendor/code-server fetch --depth 1 origin tag v4.140.0
git -C vendor/code-server checkout v4.140.0
git add vendor/code-server .gitmodules
```

**关键区别：子模块是源码，不是可运行产物。** 一个刚 clone 的 `vendor/code-server` 没有 `lib/vscode` 也没有 `out/`，跑不起来；插件只在它**被构建过**（存在 `out/node/entry.js`）时才会拿它当 `root`，否则需要 `config.root` 指向一个现成的 release 目录（例如 `E:\code-server`）。想在插件里"完全由子模块驱动"，就得在 Windows 上构建 code-server（需要 Node/yarn + VS Code 构建链，官方更推荐 WSL/Docker，耗时且易失败）——这条路的取舍见「已知限制」。

注意：以 tarball/registry 方式安装本插件时**不会带子模块内容**（`files` 白名单里没有 `vendor/`）。子模块只服务于"从 git 检出本仓库"的情形，作为版本锚点与升级入口。

### 密码是怎么用的（以及为什么不放进浏览器半部）

面板里的 iframe 是跨源的：父页面**不能**读它的 DOM，也不能替它填表单。所以插件没有把密码交给页面，而是：

1. 宿主在 `/codeserver-view/config` 只发布 `{ url, autoLogin, hasPassword, supervisor }` —— **不含密码**（`supervisor` 是进程状态，见「托管模式」）；浏览器半部挂载时读它，据此决定是否走自动登录；
2. 配了密码时，浏览器半部把 iframe 指向宿主的 `/codeserver-view/login`：这是宿主渲染的页面，里面是一个会自动提交的表单，把密码 POST 到 code-server 自己的 `/login`；
3. code-server 校验通过后种下会话 cookie 并 302 回工作台；校验失败则回到它自己的登录页 —— 面板于是显示登录表单，而不是白屏。

因此密码只存在于宿主内存与那一个宿主渲染的页面响应里，前端 JS 里既没有密码也没有地址常量。这个登录页**只在回环地址请求时**才应答（其它来源一律 404），避免把带密码的页面发给网络；`/codeserver-view/config` 做了同样的回环判断。自动登录要求浏览器能直接访问 code-server（同机 `127.0.0.1` 或内网地址都行，因为是浏览器自己去连）。

## 工作原理

本包是一个标准的 DSH **bundle**，由三部分组成：

| 文件 | 作用 |
|---|---|
| `package.json` | `dsh.bundle.patch` 指向 patch 层；`dsh.client`（`platform: "web"` + 依赖包顺序）声明浏览器半部；`exports["./client"]` 指向构建产物 |
| `cordis.patch.yml` | 一行 `insert`，把宿主半部挂成 Loader 行 `code-server-view`（`name` 必须是**裸包名**，浏览器半部才能挂到同一行上） |
| `index.js` | 宿主半部：只打印一行日志。它的存在意义是让本包成为 profile 的 Loader 成员，宿主才会扫描 `dsh.client` 并把 `client.js` 发布进启动图 |
| `client.js` | 浏览器半部：`window.__ModuleLoader__.load({ id, factory })` 懒工厂，`require('react')` 走平台共享模块表（不会打包第二份 React） |

浏览器半部在 `apply(ctx)` 里做三件事，每件都由 `ctx.effect` 拥有，插件卸载时自动回收：

1. `ctx.sidebarRightTabs.register({ id, kind, priority: 'extension', title, guide })` —— 注册标签页**类型**，并在右栏引导页放一张可点击的 "VS Code" 卡片（用户由此打开面板；`openTab` 在没有会话界面时会抛错，所以本插件不主动抢开）
2. `ctx.slots.inject('sidebar.right.pane.tab', …)` + `ctx.slots.register({ key: 类型 id }, 正文组件)`，以及同样方式注册 `.title` 座位 —— 正文是 iframe，标题是图标 + 标签文本
3. `ctx.locale.register('DSHCodeServerView', { zh, en })` —— 中英文案

```
右侧栏 (ui-sidebar-right)
└─ sidebar.right.pane.tab        ← keyed 座位，key = DSHCodeServerView   → 本插件正文
└─ sidebar.right.pane.tab.title  ← keyed 座位，key = DSHCodeServerView   → 本插件标题
```

## 开发与验证

```sh
node --check client.js          # 语法
node test/contract.test.mjs     # 零依赖契约测试（npm test）
```

`test/contract.test.mjs` 用桩 React 执行真实的 `client.js`，断言：模块装载握手、工厂无副作用、四处注册项（类型 / 正文 / 标题 / 文案）与 key 的取值、正文渲染出的 iframe 属性（`src`、`allow`、铺满面板）、`params.url` 覆盖、双语 key 完整性。

已完成的实测（全部在隔离实例上，未改动任何现有 profile）：

**一、契约与装载**

- 宿主半部在真实组合中装载：日志 `[code-server-view] host half mounted`
- 服务端渲染的首页启动图里出现 `{"id":"DSHCodeServerView","url":"plugins/??DSHCodeServerView/client.js&rev=…","inject":[…]}`
- `/plugins/??DSHCodeServerView/client.js&rev=…` 返回 200，且响应体与本仓库 `client.js` **逐字节一致**（仅追加 `;` 与 sourcemap 尾注）
- 用 DSH 同款 React 18.3.1 渲染正文组件，产出 `<iframe src="http://127.0.0.1:8080/" allow="clipboard-read; clipboard-write; fullscreen">`

**二、真实浏览器里的界面验证**（无头 Edge 154 + DevTools 协议驱动真实 DSH Web 客户端）

按用户路径逐步走通，每一步都有 DOM 取证与截图：

| 步骤 | 证据 |
|---|---|
| 客户端启动 | 页面内 `window.__DSH_BOOT__` 含本插件条目，`#root` 完成挂载 |
| 引导页出现卡片 | 右侧栏引导页里与 DSH 自带的「工作区文件」「新建终端」并列出现 **VS Code** 卡片，标题与描述来自本插件 locale（[截图](.verify/01-guide-capsule.png)） |
| 点击卡片打开面板 | 右侧栏出现原生标签页，chip 文本 `VS Code`（本插件注册的标题座位 + 自绘图标） |
| 正文渲染 | `iframe[src="http://127.0.0.1:8080/"]`，实测尺寸 **707×757 px**，面板内渲染出 code-server 的登录页（`Welcome to code-server / Please log in below`）（[截图](.verify/02-panel-code-server.png)） |
| 本地控件 | 底部工具条显示 `http://127.0.0.1:8080/`、`重新加载`、`在浏览器标签页中打开`，按钮存在于可点击元素列表中 |

**三、与 `dsh-better-sidebar` 共存的验证**（它接管了 DSH 原生右侧栏，是你的 desktop profile 里实际装着的那个）

另起一个 profile：`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + `dsh-better-sidebar` + `DSHCodeServerView`，同一个浏览器脚本再跑一遍：

- 启动图里两个插件条目同时存在，两个 client bundle 都返回 200（better-sidebar 的 1.08 MB）
- 引导页里 better-sidebar 自己的页签（`文件`、`文件变动`、`任务管理`、`侧边对话(beta)`）与本插件的 **VS Code** 卡片并列出现，互不遮挡
- 点开 VS Code 卡片后结果与裸 profile 完全一致：`iframe[src="http://127.0.0.1:8080/"]` 尺寸 **707×757 px**，面板内渲染出 code-server 登录页（[截图](.verify/04-panel-with-better-sidebar.png) / [引导页截图](.verify/05-guide-with-better-sidebar.png)）

**四、真实安装路径与运行时表现**

在**正在运行**的隔离实例上执行真实安装命令（与 Desktop 插件页内部走同一套 `operations.ts`）：

```sh
dsh plugin --profile devtest add E:\it-project\DSHCodeServerView
# dependencies: + DSHCodeServerView link:E:/it-project/DSHCodeServerView
```

| 观察项 | 结果 |
|---|---|
| 清单改动 | pnpm 建立目录链接，并**自动**把 `DSHCodeServerView` 追加进 `dsh.profile.bundles`（无需手改） |
| 是否需要重启 | **不需要**。4 秒内运行中的实例启动图就出现本插件条目，宿主日志打印 `[code-server-view] host half mounted` |
| Plugins 页 | `已安装 1`：标题 `VS Code（code-server）`、描述来自 `locale/zh.json`，状态 `running`，开关为启用 |
| 图标 | 页面渲染 `<img src="data:image/svg+xml;base64,…">`，解码后正是本仓库的 `icon.svg`（24×24） |

图标这一项踩过一个坑，值得留给后来者：Plugins 页的图标来自**清单根字段 `icon`**，或退而求其次读导出的 `<包名>/icon`。实测后者在本机 loader 的解析下会**静默失败**（普通 `require.resolve('DSHCodeServerView/icon')` 能解析，但 `readPluginMeta` 走的是另一套 resolver），表现是页面渲染兜底字形而非你的图标。所以 `package.json` 里必须显式写 `"icon": "./icon.svg"`（`exports["./icon"]` 保留即可）。

**五、配置项与自动登录的端到端验证**

另起一个**带已知密码**的 code-server（`127.0.0.1:8081`，`auth: password`，独立数据目录），把隔离实例的插件配置指向它：

| 观察项 | 结果 |
|---|---|
| 宿主装载 | 日志 `[code-server-view] host half mounted; code-server http://127.0.0.1:8081/ (auto-login configured)` |
| 配置路由 | `GET /codeserver-view/config` → `{"url":"http://127.0.0.1:8081/","autoLogin":true,"hasPassword":true}` —— 响应体里**没有**密码字段 |
| 登录路由 | `GET /codeserver-view/login` → `action="http://127.0.0.1:8081/login?to=%2F"` 的自动提交表单，密码经属性转义 |
| 浏览器行为 | 点开 VS Code 卡片后 iframe 指向 `/codeserver-view/login`，随后 `document.cookie` 出现 `code-server-session`（`autoLoggedIn: true`），面板渲染出**已登录的 VS Code 工作台**（[截图](.verify/06-config-autologin.png)） |
| 工具条 | 显示配置的地址 `http://127.0.0.1:8081/`（而不是登录路由） |
| 反例 | 用错密码时 code-server 的 `/login` 返回 200 登录页（已用 curl 单独确认），面板于是显示登录表单 |

**六、进程托管的端到端验证**（隔离实例，`manage: true` + `root: E:\code-server` + 独立 `dataDir`，端口 8082）

| 观察项 | 结果 |
|---|---|
| 自动拉起 | 日志 `starting code-server from E:\code-server (config)` → `code-server is running at http://127.0.0.1:8082/`；`/healthz` 返回 200 |
| 真实进程 | `E:\code-server\lib\node.exe E:\code-server --bind-addr 127.0.0.1:8082 --user-data-dir …\dsh-codeserver-managed-data`，**父进程就是 DSH 宿主**（在 Job Object 内），命令行里**没有密码** |
| 状态发布 | `/codeserver-view/config` → `supervisor: {mode:"managed", state:"running", root:"E:\\code-server", rootSource:"config", version:"4.140.0", vendored:"source checkout, not built"}` |
| 面板 | 工具条显示 `http://127.0.0.1:8082/`、**`运行中`** 徽标、`重新加载`、**`重启 code-server`**、`在浏览器标签页中打开`；iframe 经宿主登录页自动登录后直接进入 VS Code 工作台（[截图](.verify/07-managed-panel.png)） |
| 接管而非重复 | 地址已有人应答时 `mode: attach`、`state: attached`，**不产生任何 spawn**（单元测试覆盖） |
| 重启 | `POST /codeserver-view/restart` → 旧进程 9128 消失、新进程 27324 起来、8082 重新 200，返回的 status `uptimeMs: 0` |
| 不留孤儿 | 只 `Stop-Process` 掉 DSH 宿主进程（不做树杀），2 秒内 code-server 随之消失、8082 down —— Job Object 的 kill-on-close 生效，无需 `stopOnUnload` |

**七、Copilot 禁用层的端到端验证**（隔离实例：`manage: true` + `copilot.disable: true` + 独立 `dataDir`/`workDir`）

| 观察项 | 结果 |
|---|---|
| 宿主日志 | `built-in extensions filtered: 95 kept, 1 removed (GitHub.copilot-chat)` |
| spawn argv | `… --user-data-dir <data> --builtin-extensions-dir …\work\builtin-extensions\afc76cb5ee3571af` |
| 过滤目录 | 95 个 junction，**没有 `copilot` 条目**；`manifest.json` 记录 `excluded: ["GitHub.copilot-chat"]` |
| 设置 | `<data>\User\settings.json` 合并为 AI-off 五键（原文件先备份成 `settings.json.dsh-backup`） |
| 残留清理 | 预置的三处残留（`User/globalStorage/github.copilot-chat`、`extensions.builtin.cache`、`customBuiltinExtensionsCache.json`）被逐个报告并删除；无关状态原样保留 |
| 幂等 | 第二次启动指纹未变 → **不重建**（日志无 rebuild 行），`builtin-extensions` 下只有一个指纹目录 |
| 安全护栏 | 把 `workDir` 指到安装目录/插件包内 → 状态 `unsafe-work-dir`，**什么都没创建**（单测覆盖） |
| **VS Code 自己的解析结果** | 客户端连上后 VS Code 重新生成的 `extensions.builtin.cache`：**94 个内置扩展，id 含 "copilot" 的数量为 0**，且所有 location 都指向过滤目录 |
| 界面 | 工作台活动栏**没有 Chat/Copilot 图标**、右侧**没有 Chat 面板**、欢迎页**没有 "Build with Agent" 卡片**（[截图](.verify/08-copilot-disabled.png)） |

**仍未验证**：

- 用真实密码登录 code-server 之后完整 VS Code 工作台的观感（登录页之后的界面属于 code-server 自身，与本插件无关）
- 你机器上 19387 那个实例里的渲染——插件还没有装进 `desktop` profile（Desktop 由 Electron 独占管理，需要你在界面里安装，见「安装」方式 A）

## 已知限制

- **包名含大写**：`DSHCodeServerView` 不是 npm 官方注册表可接受的新包名（新建包不允许大写），所以本包适合以**本地路径 / git / 私有源**方式安装，不能 `npm publish`。若要发布需改名（如 `dsh-code-server-view`）——包名同时是 Loader 行 id、浏览器模块 id 与 `window.__ModuleLoader__.load({ id })` 的键，改名要同步改 `cordis.patch.yml`、`client.js` 与 `dsh.client` 相关处
- 地址与密码走 cordis `Config`（见「配置」），但**没有 Settings 图形界面**：改配置要编辑补丁层里的 YAML。改 `config` 会 HMR 热替换宿主半部；**改插件源码需要重启 DSH**
- **子模块是源码，不是可运行产物**：`vendor/code-server` 只有在上游被构建过（存在 `out/node/entry.js`）时才会被当作 `root`；否则必须用 `config.root` 指向现成 release。想在 Windows 上构建 code-server 需要 Node/yarn + VS Code 构建链，官方更推荐 WSL/Docker，成本高且易失败
- 子进程服务不向外暴露 pid（"managed-range identities remain provider-private"），所以面板状态里没有 pid，只有状态、根目录、版本与退出码
- **Copilot 禁用只在托管模式生效**：插件得自己 spawn 才能决定 argv 与数据目录；attach（接管你已有的实例）时不动任何东西，状态里写明原因
- Copilot 层**不改发行版的 `product.json`**（那个激进项未实现），所以"连 Chat 的身份一起去掉"做不到——但扩展不再加载 + AI 功能开关 + 清理残留已经覆盖了实际使用面
- 按扩展 id 排除需要读到每个候选目录的 `package.json`；读不出来的目录一律**保留**（不认识的东西绝不动）
- 自动登录走的是「宿主渲染一个自动提交表单」这条路：它要求浏览器能**直接**访问 code-server 地址，且 code-server 的登录页必须是标准表单（code-server 4.x 是）
- 内嵌的是 iframe：code-server 保留自己的主题与快捷键，不继承 DSH 的主题 token；焦点在面板内时快捷键由 VS Code 处理，可能与 DSH 冲突
- 未加 `sandbox` 属性收紧（code-server 需要自身 origin 的存储与 WebSocket）；`allow` 仅开放剪贴板与全屏
- 未做 code-server 健康检查：服务没起时面板只会显示浏览器自己的连接失败页

## English

`DSHCodeServerView` is a DeepSeek Harness plugin bundle that embeds a locally running **code-server** (VS Code for the Web) as a native tab in the Harness Web GUI's right sidebar.

- Host half (`index.js`): the `Config` schema (`url`, `password`, `autoLogin`) plus two loopback-only routes — `/codeserver-view/config` publishes `{ url, autoLogin, hasPassword }`, and `/codeserver-view/login` serves an auto-submitting form that logs the browser into code-server, so the password never reaches the browser half.
- Browser half (`client.js`): a lazy `window.__ModuleLoader__.load({ id, factory })` artifact that registers one right-sidebar tab type (`ctx.sidebarRightTabs.register`) plus its body and chip title into the keyed `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` seats, reads the Host configuration, and renders an `<iframe>` pointed at the configured address (or at the Host login route when a password is configured). React comes from the shell's shared module table.
- Configure it from a profile patch: `- id: code-server-view` with `config: { url, password, autoLogin }`; an HMR reload applies an edit without restarting the Harness, and an opener can override the address per tab with `ctx.sidebarRight.openTab('code-server-view', { params: { url } })`.
- Install it into a profile with `dsh plugin --profile <name> add <this directory>`; the Desktop application installs bundles through its own Plugins page.
- `npm test` runs the dependency-free contract test for both halves.

## License

MIT
