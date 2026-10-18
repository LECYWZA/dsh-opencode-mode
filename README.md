# dsh-opencode-mode

**opencode 式 plan/build 双挡位 for DSH**：`OC Plan` / `OC Build`，Tab 键切换，计划挡位在调度层硬拒写操作与高危命令（不弹审批框），挡位提示走尾部用户消息以保住 KV 前缀缓存。

## 为什么需要它

DSH 内置的 `/plan`（`dsh-plan-mode`）只注入系统提示词：工具目录**刻意保持不变**（为请求缓存稳定），所以模型仍看得见 `write`/`bash`，越界时才靠沙箱/审批兜底——于是出现"plan 下还试图写、写就弹框要权限"。opencode 的 plan agent 是**运行时 deny**（`edit: {"*":"deny"}`），模型直接调不动，只会说"请切 build"。

本插件把 opencode 的口径搬到 DSH，同时**不牺牲缓存**：

| 机制 | opencode | 本插件 |
|---|---|---|
| 两挡位 | build / plan agent | `OC Build` / `OC Plan` 权限档 |
| 切换 | Tab（agent cycle） | Tab 键（可用 `/mode` 命令，客户端可改键） |
| 计划挡位约束 | `edit: deny`（运行时） | `ctx.tools.guard()` 运行时硬拒，**不改工具 schema** |
| 模式提示 | system-reminder（尾部用户消息） | `agent.inject()`（尾部用户消息） |
| 缓存 | 前缀不动 | 前缀不动（system prompt 不重写） |

## 安装

本插件是标准 DSH bundle（`dsh.bundle.patch` + `dsh.client`），用 `plugin_manager` 的 `install_bundle` 指向本目录安装；HMR 热加载，新装 bundle 不需要重启。

## 挡位定义

本 bundle 自带 `cordis.patch.yml`，定义 `OC Plan` / `OC Build` 两挡并**整段替换** `permission` 行。⚠️ DSH 的 patch 对同一 `id` 是**整段替换、不做深合并**——如果你的 profile 自己也有 `permission` 行，请把这两挡写进去（示例）：

```yaml
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      oc-plan:
        sandbox: workspace-write      # 沙箱允许 /tmp（练习场）；正式目录由 guard 拦
        approval: never               # 不弹审批框
        name: OC Plan
        description: 只读计划：临时目录可写，正式目录与高危命令被拒
      oc-build:
        sandbox: workspace-write
        approval: never
        name: OC Build
    defaultPreset: oc-build
```

## 用法

### 挡位切换

- `/mode oc-plan` / `/mode oc-build`（服务端命令，带挡位提示）
- `/mode`（不带参数）报告当前挡位
- **Tab 键**：在当前查看的会话里切换挡位（覆盖浏览器焦点导航；改键见 DSH 设置里的快捷键面板）

### OC Plan 挡位放行/拒绝清单

| 放行 | 拒绝 |
|---|---|
| 只读工具：read / grep / glob / list / web / image / skill | write / edit / patch 到**正式目录**（只允许 `/tmp`、平台临时目录） |
| bash 只读命令：ls/cat/head/tail/wc/stat/du/df/find/rg/sed -n/awk、git status·log·diff·show·branch·rev-parse、ps/top/free/uname/ss/netstat/ip a、docker ps·images·logs·inspect、systemctl status·journalctl、nvidia-smi | 包管理：apt/pip install/npm install -g |
| **ssh 只读命令**（`ssh host "ls"` 等） | 服务变更：reboot/shutdown/systemctl restart·stop·enable |
| 临时目录练习：`javac`/`java 输出 main`、`python -c`、`node -e`、`go run` 等一次性运行 | 进程：kill/pkill |
| 临时目录读写：`mkdir -p /tmp`、`touch /tmp`、`mktemp`、`> /tmp`、`tee /tmp` | 容器变更：docker run/rm/stop/pull/exec |
| 拉取/下载到 /tmp 阅读：`git clone`、`curl`、`wget`、`pip download`、`npm pack` | git 写入：commit/push/reset/checkout/clean |
| — | 沙箱升级（避免弹框） |
| — | 重定向（`>`/`>>`）到非临时目录 |

原则：**临时目录是 AI 的练习场**——可以编译、运行、下载、写草稿，但不得影响任何程序运行（不装包、不改服务、不动进程、不写正式目录）。

### 缓存行为

- 挡位提示通过 `agent.inject()` 落在**尾部用户消息**，system prompt 与工具 schema 不变 → 切换挡位后前缀缓存仍命中（与 opencode 同口径）
- guard 只在调度时拒绝，不改工具目录 → 不破坏请求字节

## 设计取舍

- **不用 `tools.restrict()`**：裁工具会改 schema，导致从第一个改动 token 起缓存失效
- **不用内置 `/plan`**：它的 section 在 system prompt 中部，切换会改写 system 节点、丢前缀缓存
- bash 白名单基于命令前缀匹配，与 opencode 的 bash 权限同口径——能防住常见误操作，不是沙箱级保证（`$()`、管道、二进制编码等仍可能绕过）

## 后续计划

- `/undo`（消息版撤回：截断历史、保留日志，撤回点之前缓存命中）+ `/redo`
- `/rename`（接 `sessionTitle.rename`）、`/export` markdown 到指定目录、`/seesession`（查看其他会话）

## 许可

MIT
