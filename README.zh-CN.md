# Tibo Rush

[English](README.md) | 中文

Codex 订阅额度按周期重置，没用完的部分不会累积到下个周期。Tibo Rush 让你用一条命令，把 Oh My Pi 和 Pi 的所有已接入会话切到更快消耗额度的冲刺模式；用完后执行 `off`，每个会话各自恢复原来的设置。

**Oh My Pi**

![Tibo Rush 在 Oh My Pi 中](assets/tibo-rush-omp-demo.gif)

**Pi**

![Tibo Rush 在 Pi 中](assets/tibo-rush-pi-demo.gif)

*录制于隔离环境，未配置凭据，未发送模型请求。没有凭据时，`fast` 切换会失败并明确报告，不会显示 `applied`；`off` 仍可恢复会话。*

**Tibo Rush 是主体，宿主是平级适配项目。** 在任意已接入会话发出同一条命令，切换共享状态目录下的会话；关闭后恢复每个会话入档前的状态。

| 适配项目 / 分发包 | 宿主 | 会话内命令 |
| --- | --- | --- |
| `tibo-rush-omp` | Oh My Pi（OMP） | `/tibo-rush fast` |
| `tibo-rush-pi` | 原版 Pi | `/tibo-rush fast` |

社区项目，与 OpenAI、Tibo、OMP 或 Pi 官方无隶属关系。不读取额度，不预测或兑换额度重置，什么时候冲刺由你决定；不保证提速、额度收益或模型可用性。扩展在宿主进程中运行，**不是沙箱插件**，安装前请审阅源码。

## 安装

当前适配的宿主 API：OMP 18.12.5 / 18.12.6、Pi 1.4.0。宿主验收环境为 macOS；不据此宣称 Windows、Linux 完整宿主行为已验证。独立 CLI 和开发工具需要 Bun >= 1.3；Pi 自身需要其支持的 Node 版本（1.4.0 要求 >=22.19）。

### OMP：`tibo-rush-omp`

在 OMP 会话中：

```text
/marketplace add happyfeetw/tibo-rush
/marketplace install tibo-rush-omp@tibo-rush
/restart
```

或终端执行前两步：

```sh
omp plugin marketplace add happyfeetw/tibo-rush
omp plugin install tibo-rush-omp@tibo-rush
```

每个现有 OMP 会话首次需各 `/restart`。以后切档无需重启。市场安装不保证将独立 CLI 加入 PATH。

### Pi：`tibo-rush-pi`

Git 安装使用主仓库的 Pi 清单，只加载 Pi 适配器，不加载 OMP：

```sh
pi install git:github.com/happyfeetw/tibo-rush@v0.2.1
```

在每个现有 Pi 会话执行 `/reload`，或退出并续接原会话，加载新扩展。之后命令与 OMP 完全相同。

需要宿主专属分发包时，从 [Releases](https://github.com/happyfeetw/tibo-rush/releases) 下载 `tibo-rush-pi-0.2.1.tgz` 或 `tibo-rush-omp-0.2.1.tgz`，解压到固定目录，再使用 `pi install /absolute/path/to/package` 或 `omp plugin link /absolute/path/to/package`。每个分发包仅携带自身适配器和共享核心。**同一宿主只选择一种安装方式，避免重复加载。**

Pi gallery 的发现依赖 npm 发布的 `pi-package` 包；GitHub Release 和 Git 安装不等于已经上架该目录。

### 独立终端 CLI（可选）

```sh
git clone https://github.com/happyfeetw/tibo-rush.git
cd tibo-rush
git checkout v0.2.1
bun bin/tibo-rush.mjs status
```

需要短命令时，在该目录执行 `bun link`，确保 Bun 全局 bin 目录在 PATH 中。唯一 CLI 命令名是 `tibo-rush`。`bun link` 本身不向 OMP 或 Pi 注册扩展。

## 一致的使用方式

两个宿主都使用：

```text
/tibo-rush regular
/tibo-rush fast
/tibo-rush extreme
/tibo-rush off
/tibo-rush status
```

终端使用 `tibo-rush <mode>`、`tibo-rush status` 或 `tibo-rush status --json`。

| 预设 | 主模型 | OMP 普通编码 | 请求速度档 |
| --- | --- | --- | --- |
| regular | Sol high | Sol high | Standard |
| fast | Astra medium | Sol high | Standard |
| extreme | Astra medium | Sol high | priority / Fast |
| off | 恢复各会话原状态 | 恢复原路由 | 恢复原状态 |

示例预设的 OMP 分工还包括 Astra high 审核、Astra xhigh 攻坚、Gemini 前端和 Luna 轻量角色。这是作者模型目录的示例，**不是所有账号都拥有的通用模型 ID**。先检查并按自己的宿主目录修改预设。扩展不安装代理定义、创建订阅、读取其他宿主的登录文件或兑换账号权益。

### 相同命令，不伪造相同能力

- **OMP**：应用主模型、思考、服务速度档，以及 OMP 原生的角色与子代理路由设置。
- **Pi**：应用主模型和思考；针对原生 ChatGPT Codex endpoint，通过 `before_provider_request` 设置 `service_tier`，不改写其他 API 的请求。它没有同等的 OMP 角色路由接口，不会假装设置了编码、审核或前端子代理模型。状态包含宿主与能力标记。已用真实 Pi 的合成 provider payload 验证钩子，未向 OpenAI 发请求验证服务端接受情况或速度。
- `priority` 的实际可用性与额度计费由供应商决定。策略校验拒绝 Ultrafast；代理 priority 只允许指向显式声明的 OpenAI / Codex 模型，非 OpenAI 或未声明目标会被拒绝。
- 不改写宿主已有 fallback chains、审核门槛、搜索 provider 顺序或第三方子代理扩展配置。若宿主随后通过回退链切换 provider，实际代理路由与速度语义仍由宿主决定，需自行审查回退配置。

## 配置与共享范围

默认共享状态目录是 **`~/.tibo-rush`**。用 `TIBO_RUSH_HOME` 覆盖；CLI 与目标宿主进程必须使用同一目录。相同目录下的 OMP 和 Pi 会话会同时接收请求；需要分组隔离就给进程设置不同目录。这不是跨机器同步。

默认策略在 [`presets/tibo-rush.json`](presets/tibo-rush.json)。自定义方式：

```sh
mkdir -p ~/.tibo-rush
cp presets/tibo-rush.json ~/.tibo-rush/policies.json
```

编辑完整 JSON 的 `modes.regular`、`modes.fast`、`modes.extreme`：

- `main`：`provider`、`id`、`thinking`。当前仅支持 `openai-codex` 主模型；不暗示支持其他供应商的等价速度控制。
- `roles`：OMP 模型角色映射。
- `agentModels`：OMP 代理名到模型或 `@角色` 的映射，引用角色必须在策略里声明。代理定义本身须已存在。
- `tier`：`default` 或 `priority`。
- `agentTiers`：OMP 代理速度档。`priority` 要求对应 `agentModels` 显式目标或其角色指向 OpenAI / Codex；不允许 `ultrafast`。
- `instruction`：策略说明，必须与实际能力一致；Pi 不使用它冒充 OMP 路由已生效。

修改后重新执行一次目标模式命令，以新 revision 通知各会话。无效策略不写入新活动请求。**即使策略文件损坏，`off` 仍可恢复**。模型或认证不可用时显示错误，不自动开通其他渠道。

## 状态、忙碌会话和恢复

- 请求不会中断当前模型调用；忙碌主会话显示 `pending`，空闲后再切换主模型与速度。OMP 后续子代理路由可先更新，已运行子代理不重启。
- `status` 仅统计有有效心跳的已接入会话。零客户端不是全部生效；`pending` 不是已生效；出错不会报告 `applied`。
- 使用会话内覆盖，不改写用户持久角色配置。`off` 恢复每个会话进入活动模式前的状态，而不是把所有会话统一改回 Sol。
- 活动期退出进程保留恢复基线。即使离线期间切到 `off`，续接原会话仍会尝试恢复。
- OMP 通过公开 SDK 注册表定位当前会话，并校验会话 ID 与 manager 身份，再读取配置级思考选择和确认恢复记录落盘。身份不匹配或 SDK 能力缺失时拒绝修改；落盘失败保留恢复基线并报告错误，不将内存恢复冒充持久化成功。
- OMP 活动期分支/派生会话通过宿主日志里的隐藏自包含交接记录承接原基线，随后写共享状态目录；不把已经切过的模型当作原始状态。交接前使用 `handoffs/` 下的临时令牌记录及源日志意图保护歧义路径；若两份交接存储都失败，报告恢复受阻，不猜测父会话当前基线。日志记录是非上下文元数据，不发送给模型，但包含恢复配置，仍应保密。
- OMP 活动期创建无父会话的新会话时，先在空闲边界恢复原状态，避免新会话继承没有恢复依据的活动模型；忙碌时会取消该次新建并提示稍后重试。若其他扩展随后否决新建，原会话仍保持接入并重新应用请求模式。
- OMP 的异步切换准备若超过宿主超时，独立同步门禁会取消本次提交；原生模型 setter 若仍未结束，后续会话切换及模式修改继续等待，`off` 也保持 `pending`，直到该操作安全结束，不启动另一轮修改去竞争。
- 当前验证范围是 OMP 标准 CLI 的本地文件会话及 `--no-session`；SDK 注入的远端会话存储未验证。持久会话可能因恢复确认而提前创建日志文件；`--no-session` 仅恢复内存状态。
- 持久化确认采用宿主 flush 语义，覆盖已验证的软件崩溃恢复，不额外承诺断电级 fsync 保证。恢复元数据被人为删除后也不能保证自动恢复。
- 在活动模式中通过宿主命令手动改模型、思考或速度，会报告策略漂移，不强行覆盖用户新选择。重新发目标模式可再次应用；`off` 仍恢复原基线。
- 不支持把同一个宿主会话 ID 同时在多个进程中打开。活动期不要用其他扩展同时修改同一组设置；已有运行时映射按入档快照恢复。
- 状态目录中的 `state.json`、`clients/`、`baselines/`、`handoffs/` 包含会话 ID、工作目录和恢复配置，**不得公开上传**。扩展本身不做遥测或发起模型请求。
- 命名 profile、`--no-extensions` 等宿主加载选项可能影响接入；必须实际加载适配器才受控制。

### 卸载

**先 `off`，确认相关会话恢复，再卸载。** 离线会话先续接完成恢复；不要提前删除恢复基线。

OMP 市场卸载：

```text
/tibo-rush off
/marketplace uninstall tibo-rush-omp@tibo-rush
/restart
```

Pi 使用 `pi remove <安装时的来源>`，再 `/reload`。终端命令是否保留取决于独立 CLI 的安装方式。

### 从 v0.1.0 或旧手工安装升级

v0.1.0 的公开项目 / 主包是 `happyfeetw/tibo-impact` / `tibo-impact`，宿主包是 `tibo-impact-omp`、`tibo-impact-pi`；状态目录为 `~/.tibo-impact`，环境变量为 `TIBO_IMPACT_HOME`。**卸载旧版、安装或加载新版之前，必须先用旧版命令 `/tibo-impact off`（旧 CLI 为 `tibo-impact off` 或 `omp-impact off`），并确认所有相关会话恢复；离线会话也须先续接、完成恢复。** 若设置过旧环境变量，须让旧控制器和旧宿主仍指向原目录完成收尾，再停用该变量。

恢复完成后，使用 `/marketplace uninstall tibo-impact-omp@tibo-impact` 卸载旧 OMP 市场包；Pi 使用 `pi remove <旧安装来源>`；独立 CLI 按原安装方式解除链接或卸载。随后按上面的 v0.2.1 安装步骤安装 Tibo Rush，并在每个会话重启或重新加载，避免新旧适配器同时运行。新版只注册 `/tibo-rush` 和 `tibo-rush`，不保留旧命令别名。

更早的手工版本可能使用 `~/.omp/agent/extensions/tibo-impact.ts`、状态目录 `~/.omp/agent/tibo-impact` 和 `~/.local/bin/omp-impact` 包装器。同样必须先通过旧入口让所有旧会话 `off` 并完成恢复，再移走旧扩展入口及包装器；用 `command -v omp-impact` 检查 PATH 不再命中旧控制器。旧会话恢复前保留可用的旧控制器，不要提前删除其恢复数据。

新版默认使用全新的 `~/.tibo-rush` 状态目录（覆盖变量为 `TIBO_RUSH_HOME`）。**不会自动导入、移动或删除旧状态、基线或日志。不要把旧目录复制到新目录，也不要复制恢复元数据或改写日志标记字符串来冒充迁移。** 需要保留自定义策略时，只人工核对并重新配置 `policies.json` 中的模型策略，不复制 `state.json`、`clients/`、`baselines/`、`handoffs/` 或宿主日志恢复记录。

## 仓库结构与开发

```text
tibo-rush/
├── src/
│   ├── core/
│   ├── cli/
│   └── hosts/
│       ├── tibo-rush-omp/
│       └── tibo-rush-pi/
├── presets/
├── tests/
├── scripts/
└── package.json
```

共享核心不导入宿主 API；适配器互不导入，能力差异留在各自目录。根清单便于 Git 安装；发布构建为每个宿主生成独立命名的包。

以下开发命令在 Git 源码 checkout 中运行；宿主专属发行包不包含测试与构建脚本。

```sh
bun test
OMP_BIN=/absolute/path/to/omp bun run smoke
PI_CLI_JS=/absolute/path/to/pi-cli.js bun run smoke:pi
bun run pack:hosts
```

测试隔离状态目录。真实宿主 smoke 使用临时配置与会话，不调用网络模型；Pi 可用本地合成响应测试生命周期，不代表供应商实际速度验证。缺少宿主或模型能力不算验证通过。GitHub CI 的离线检查不能替代实际宿主验收。

测试用的合成凭据位于 `tests/fixtures/offline-provider.mjs`。漏洞报告方式见 [SECURITY.md](SECURITY.md)。

`pack:hosts` 输出 `dist/tibo-rush-omp-<version>.tgz` 与 `dist/tibo-rush-pi-<version>.tgz`，只含分发白名单源码，不含运行状态。发布前还需隔离验证市场/包安装与新会话加载。

## 许可与资料

[MIT](LICENSE)。源码从作者本地扩展整理，不包含宿主本体源码或个人会话记录。

- [OMP](https://github.com/can1357/oh-my-pi)
- [OMP 市场文档](https://github.com/can1357/oh-my-pi/blob/main/docs/marketplace.md)
- [Pi 包规范](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md)
- [Pi 扩展规范](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
