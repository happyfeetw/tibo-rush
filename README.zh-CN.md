<p align="center">
  <img src="assets/tibo-rush-icon.png" width="128" height="128" alt="Tibo Rush">
</p>

<h1 align="center">Tibo Rush</h1>

<p align="center"><a href="README.md">English</a> | 中文</p>

**一条命令，让共享状态目录下所有已接入的 Oh My Pi 和 Pi 会话一起切换到冲刺模式。结束后执行 `off`，各自恢复原来的设置。**

Codex 订阅额度按周期重置，没用完的部分不会留到下个周期。如果你想在重置前集中使用剩余额度，Tibo Rush 可以帮你统一切换会话配置。它不会读取额度，也不预测重置时间，何时开启、何时结束，都由你决定。

- `fast` / `extreme` 用于冲刺，`regular` 用于日常；`off` 恢复每个会话启用模式前的设置。
- OMP 支持切换主模型、思考强度、服务档位，以及角色和子代理路由；Pi 支持切换主模型和思考强度，并为原生 Codex 请求设置 `service_tier`。

| 适配项目 / 分发包 | 宿主 | 会话内命令 |
| --- | --- | --- |
| `tibo-rush-omp` | Oh My Pi（OMP） | `/tibo-rush fast` |
| `tibo-rush-pi` | 原版 Pi | `/tibo-rush fast` |

```text
/tibo-rush regular
/tibo-rush fast
/tibo-rush extreme
/tibo-rush off
/tibo-rush status
```

**Oh My Pi**

![Tibo Rush 在 Oh My Pi 中](assets/tibo-rush-omp-switch.gif)

**Pi**

![Tibo Rush 在 Pi 中](assets/tibo-rush-pi-switch.gif)

*以上演示均在隔离项目中录制，使用真实 Codex 订阅。`fast` 从 GPT-6.1 Sol（high）切到 GPT-6 Astra（medium），`off` 再切回来。全程没有发送模型请求。*

> **社区项目**，与 OpenAI、Tibo、OMP 或 Pi 官方无隶属关系。
> 扩展在宿主进程中运行，**不是沙箱插件**，安装前请审阅源码。
> 不承诺提速、额度收益或模型可用性。

## 目录

- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [状态与恢复](#状态与恢复)
- [卸载](#卸载)
- [开发](#开发)

## 安装

按你使用的宿主安装对应适配器：Oh My Pi 对应 `tibo-rush-omp`，Pi 对应 `tibo-rush-pi`。两边使用相同的会话内命令。

目前已适配的宿主 API 版本为 OMP 18.12.5 / 18.12.6、Pi 1.4.0。实际宿主验证在 macOS 上完成，Windows 和 Linux 尚未经过同等验证。独立 CLI 和开发工具需要 Bun >= 1.3；Pi 1.4.0 需要 Node >= 22.19。

### Oh My Pi

在 OMP 会话中：

```text
/marketplace add happyfeetw/tibo-rush
/marketplace install tibo-rush-omp@tibo-rush
/restart
```

也可以在终端执行前两步：

```sh
omp plugin marketplace add happyfeetw/tibo-rush
omp plugin install tibo-rush-omp@tibo-rush
```

安装后，每个已有的 OMP 会话都需要执行一次 `/restart`，才能加载扩展。之后切换模式无需重启。插件市场安装不保证将独立 CLI 加入 PATH。

### Pi

通过 Git 安装时，使用的是主仓库中的 Pi 包清单，只会加载 Pi 适配器：

```sh
pi install git:github.com/happyfeetw/tibo-rush@v0.2.1
```

安装后，在每个已有的 Pi 会话中执行 `/reload`，或退出后续接原会话，以加载扩展。加载后的模式命令与 OMP 相同。

<details>
<summary>分发包、独立 CLI 和其他安装方式</summary>

如果需要单独安装宿主分发包，可以从 [Releases](https://github.com/happyfeetw/tibo-rush/releases) 下载 `tibo-rush-pi-0.2.1.tgz` 或 `tibo-rush-omp-0.2.1.tgz`，解压到固定目录，再按宿主选择下面的命令：

```sh
pi install /absolute/path/to/package
omp plugin link /absolute/path/to/package
```

每个分发包只包含对应的适配器和共享核心。**同一宿主只选择一种安装方式，避免重复加载。**

Pi gallery 依赖 npm 上发布的 `pi-package` 包来发现项目。提供 GitHub Release 或 Git 安装方式，并不代表项目已经上架 Pi gallery。

也可以直接从源码使用独立终端 CLI（可选）：

```sh
git clone https://github.com/happyfeetw/tibo-rush.git
cd tibo-rush
git checkout v0.2.1
bun bin/tibo-rush.mjs status
```

如果希望在终端直接使用短命令，在仓库目录执行 `bun link`，并确保 Bun 的全局 bin 目录已加入 PATH。CLI 的命令名只有 `tibo-rush`。`bun link` 不会为 OMP 或 Pi 注册扩展。

</details>

## 使用

在会话中，两个宿主都使用上面的 `/tibo-rush <mode>`。在终端中，则使用 `tibo-rush <mode>`、`tibo-rush status` 或 `tibo-rush status --json`。

`regular` 使用日常配置，`fast` 和 `extreme` 用于冲刺。`fast` 将主模型切到预设的冲刺配置。产品的 `fast` 模式不等于 priority/Fast 档：示例里的 `fast` 仍是 Standard，`extreme` 才启用 priority。Standard 对应配置里的 `default`，priority 对应供应商的 Fast 服务档位。priority 如何计入额度，由供应商决定。

仓库自带的示例预设（[`presets/tibo-rush.json`](presets/tibo-rush.json)）如下：

| 模式 | 主模型 | OMP 编码（task） | 服务档位 |
| --- | --- | --- | --- |
| `regular` | Sol high | Sol high | Standard |
| `fast` | Astra medium | Sol high | Standard |
| `extreme` | Astra medium | Sol high | priority / Fast |
| `off` | 恢复各会话原状态 | 恢复原路由 | 恢复原状态 |

表中的 OMP 编码（task）指 task 角色。`fast` / `extreme` 还会把分析 analyst、规划 plan 角色切到 Astra medium；Pi 不设置这些角色。

这套示例用的是我自己的模型配置，还为 OMP 配置了 Astra high 审核、Astra xhigh 攻坚、Gemini 前端和 Luna 轻量角色。**其中的模型 ID 并非所有账号都可用**，使用前请先确认宿主中有哪些可用模型，再按自己的账号配置调整预设。

扩展不会安装代理定义、创建订阅、读取其他宿主的登录文件，也不会兑换账号权益。

### OMP 和 Pi 分别支持哪些设置

两边的命令相同，但能调整的设置不同。状态信息会标明当前宿主及其支持的能力。

- **OMP**：切换主模型、思考强度、服务档位，以及 OMP 原生的角色与子代理路由设置。
- **Pi**：切换主模型和思考强度。只针对原生 ChatGPT Codex 接口，通过 `before_provider_request` 设置 `service_tier`，不会改写其他 API 请求。Pi 没有与 OMP 对等的角色路由接口，状态中也不会将编码、审核或前端子代理模型标记为已设置。

  Pi 的请求钩子已通过真实 Pi 中的合成 provider payload 验证，但尚未向 OpenAI 发送请求，因此没有验证服务端是否接受该设置，也没有验证实际速度。

`priority` 是否可用、如何计入额度，由供应商决定。策略校验会拒绝 Ultrafast；子代理的 priority 只允许用于显式声明的 OpenAI / Codex 模型，非 OpenAI 模型或未声明的目标都会被拒绝。

扩展不会改动宿主已有的回退链（fallback chains）、审核门槛、搜索服务（provider）顺序或第三方子代理扩展配置。如果宿主随后通过回退链切换了 provider，实际的代理路由和服务档位仍由宿主决定，需要自行检查回退配置。

## 配置

默认使用 **`~/.tibo-rush`** 作为共享状态目录，可以通过 `TIBO_RUSH_HOME` 指定其他目录。CLI 与要控制的宿主进程必须使用同一目录；使用该目录的 OMP 和 Pi 会话会同时收到切换请求。

要把会话分成互不影响的几组，就给各组进程设置不同的目录。Tibo Rush 本身不提供跨机器同步。

默认策略位于 [`presets/tibo-rush.json`](presets/tibo-rush.json)。需要自定义时，先复制一份：

```sh
mkdir -p ~/.tibo-rush
cp presets/tibo-rush.json ~/.tibo-rush/policies.json
```

在复制后的完整 JSON 中修改 `modes.regular`、`modes.fast`、`modes.extreme`：

- `main`：主模型的 `provider`、`id`、`thinking`。目前只支持 `openai-codex`，不为其他供应商提供同等的服务档位控制。
- `roles`：OMP 的模型角色映射。
- `agentModels`：指定 OMP 代理使用的模型，也可以通过 `@角色` 引用角色。引用的角色必须在策略中声明，代理定义本身也必须已经存在。
- `tier`：`default` 或 `priority`。
- `agentTiers`：OMP 代理的服务档位。使用 `priority` 时，对应的 `agentModels` 显式目标或其引用的角色必须指向 OpenAI / Codex 模型；不允许 `ultrafast`。
- `instruction`：策略说明，内容必须与实际能力一致。它不能替代路由设置，Pi 也不会据此将 OMP 路由报告为已生效。

保存后，重新执行目标模式命令，各会话才会应用新策略。策略无效时，不会写入新的活动请求。**即使策略文件损坏，`off` 仍可恢复**。模型或认证不可用时会报错，不会自动开通其他渠道。

## 状态与恢复

只有在原有设置已经写入磁盘、模式切换也已生效后，状态才会显示为 `applied`。

- 切换请求不会打断正在进行的模型调用。主会话忙碌时显示 `pending`，等空闲后再切换主模型和服务档位。OMP 可以先更新后续子代理的路由，但不会重启已经运行的子代理。
- `status` 只统计心跳仍有效的已接入会话。客户端数量为零不代表全部生效，`pending` 也不代表已经生效；出错时不会报告 `applied`。
- 这些修改只在会话内生效，不会改写你持久保存的角色配置。`off` 会恢复每个会话启用活动模式前的设置，而不是把所有会话统一改回 Sol。
- 在活动模式下退出进程，不会丢弃启用模式前保存的原始设置（恢复基线）。即使在会话离线时执行了 `off`，续接原会话后仍会尝试恢复。
- 卸载前先执行 `off`，并确认相关会话已恢复。离线会话也要先续接并完成恢复，不要提前删除恢复基线。

<details>
<summary>OMP 的会话分支、新建会话与切换超时</summary>

- 修改设置前，OMP 会通过公开 SDK 注册表定位当前会话，核对会话 ID 和 manager 身份，再读取配置中选定的思考强度，并确认恢复记录已写入磁盘。身份不匹配或缺少所需 SDK 能力时，会拒绝修改。写入失败时会保留恢复基线并报错，不会把内存中的恢复结果当作持久化成功。
- 在活动模式下创建分支或派生会话时，OMP 会通过宿主日志中携带完整恢复信息的隐藏交接记录，继承原来的恢复基线，再写入共享状态目录，不会把切换后的模型当作原始状态。交接前会使用 `handoffs/` 下的临时令牌记录和源日志中的交接意图，处理可能存在歧义的交接情况。如果两处交接存储都失败，会报告恢复受阻，不会猜测父会话当前的基线。这些日志记录不属于模型上下文，不会发送给模型，但包含恢复配置，仍需保密。
- 在活动模式下创建没有父会话的新会话时，OMP 会先在会话空闲时恢复原有设置，避免新会话继承没有恢复依据的活动模型。如果当前正忙，会取消这次新建并提示稍后重试。如果其他扩展随后否决了新建，原会话仍会保持接入，并重新应用请求的模式。
- 如果异步切换的准备过程超过宿主超时时限，OMP 会通过独立的同步检查取消本次提交。如果原生模型设置操作（setter）尚未结束，后续会话切换和模式修改都会继续等待，`off` 也会保持 `pending`。只有等该操作安全结束后才会继续，不会并行发起另一轮设置修改。

</details>

<details>
<summary>验证范围与使用注意事项</summary>

- 目前已验证 OMP 标准 CLI 的本地文件会话和 `--no-session`；通过 SDK 注入的远端会话存储尚未验证。持久会话可能为了确认恢复结果而提前创建日志文件；`--no-session` 只恢复内存中的状态。
- 持久化确认采用宿主的 flush 语义，覆盖已验证的软件崩溃恢复场景，不额外承诺 fsync 级别的断电保护。人为删除恢复元数据后，也不能保证自动恢复。
- 在活动模式下通过宿主命令手动修改模型、思考强度或服务档位时，扩展会报告配置偏离预设（策略漂移），但不会强行覆盖你的选择。重新执行目标模式命令可以再次应用预设；`off` 仍会恢复原基线。
- 不支持在多个进程中同时打开同一个宿主会话 ID。启用活动模式期间，不要用其他扩展同时修改同一组设置；已有的运行时映射会按启用模式前的快照恢复。
- 状态目录中的 `state.json`、`clients/`、`baselines/`、`handoffs/` 包含会话 ID、工作目录和恢复配置，**不得公开上传**。扩展本身不做遥测，也不会发起模型请求。
- 命名 profile、`--no-extensions` 等宿主加载选项可能影响扩展是否加载。只有实际加载了适配器的会话，才会响应切换请求。

</details>

## 卸载

**先执行 `off`，确认相关会话已恢复，再卸载。** 离线会话也要先续接并完成恢复，不要提前删除恢复基线。

OMP 市场卸载：

```text
/tibo-rush off
/marketplace uninstall tibo-rush-omp@tibo-rush
/restart
```

Pi 使用 `pi remove <安装时的来源>` 卸载，再执行 `/reload`。终端命令是否保留，取决于独立 CLI 的安装方式。

## 开发

Tibo Rush 是项目主体，`tibo-rush-omp` 和 `tibo-rush-pi` 分别负责对接两个宿主，彼此平级。

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

共享核心不依赖宿主 API，两个适配器也互不导入，各自处理宿主间的能力差异。根目录的包清单用于支持 Git 安装；发布时会为每个宿主构建独立命名的包。

以下命令需要在 Git 源码仓库中执行；宿主专属发行包不包含测试与构建脚本。

```sh
bun test
OMP_BIN=/absolute/path/to/omp bun run smoke
PI_CLI_JS=/absolute/path/to/pi-cli.js bun run smoke:pi
bun run pack:hosts
```

测试使用隔离的状态目录。真实宿主 smoke 使用临时配置与会话，不调用网络模型；Pi 可以通过本地合成响应测试生命周期，但这不代表已经验证供应商的实际速度。缺少宿主或所需模型能力时，不能算验证通过。GitHub CI 的离线检查不能替代真实宿主验证。

测试用的合成凭据位于 `tests/fixtures/offline-provider.mjs`。漏洞报告方式见 [SECURITY.md](SECURITY.md)。

`pack:hosts` 会生成 `dist/tibo-rush-omp-<version>.tgz` 和 `dist/tibo-rush-pi-<version>.tgz`，只包含分发白名单中的源码，不包含运行状态。发布前还需要在隔离环境中验证市场或分发包安装，以及新会话能否正确加载扩展。

## 许可与资料

[MIT](LICENSE)。这个项目由我的本地扩展整理而来，不包含宿主本体源码或个人会话记录。

- [OMP](https://github.com/can1357/oh-my-pi)
- [OMP 市场文档](https://github.com/can1357/oh-my-pi/blob/main/docs/marketplace.md)
- [Pi 包规范](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md)
- [Pi 扩展规范](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
