简体中文 | [English](README.en.md)

# pi-recap

**Pi Coding Agent 的 TUI 会话回顾插件**。你切走终端窗口，它在后台生成一份简短回顾；回到终端时，编辑器上方一行卡片概括当前会话的整体目标、已完成进展和下一步动作。

当前版本：**0.2.0**

## 为什么需要它

离开屏幕的理由很多，可能是一场会，也可能是一顿饭。回来时会话还停在原处，思路却断了，往上翻很久的消息记录才接得上刚才做到哪里。离开一段时间后回来，先读一段短回顾，再决定从哪里继续——这个插件把这段行为带进 Pi 的交互 TUI。回顾由一次独立的辅助模型请求生成，写好的正文不会进入后续 LLM 上下文。

## 能力

- 仅在终端失焦时后台生成；窗口保持聚焦时，单纯空闲不会调用模型。
- 默认要求最后一个完成 turn 已过去 3 分钟，且会话至少有 3 个完成 turn，同一个完成轮不会连续生成两次。这两道门槛挡住了短暂分心带来的无意义回顾。
- `/recap` 随时按需生成；`/recap off` 只关闭自动回顾，手动命令始终可用。
- 回顾正文跟随会话里用户消息的语言，英文提示词不会强制英文输出。
- 结果以单行卡片显示在编辑器上方，最长 400 字符；输入新消息、开始新 turn、切换会话或关闭横幅后当前回顾会隐藏。
- 关闭状态按「会话分支 + 回顾对应的完成轮」隔离；切走再切回，横幅不会重新出现。
- 回顾作为 Pi custom session entry（`pi-recap/state`）持久化，不追加普通消息，也不进入后续 LLM 上下文。会话恢复、树导航、fork 和 compaction 之后按当前 branch 恢复状态。
- 默认复用会话当前模型，也可用 `provider` + `model` 固定路由。辅助调用不发送任何思考等级，`maxOutputTokens` 只是输出上限；`temperature` 与 `stopSequences` 可选覆盖。
- 请求期间会话若开始新 turn、完成了更新的轮次或换了分支，旧结果不会提交。你回来后看到的正文始终和当前进度对得上。
- 状态栏常驻 `recap on · focused` / `recap off · manual-only` 一行，能直接看出当前档位和终端在不在焦点；自动回顾失败时追加 `· failed: <原因>`，下次成功或新输入即清除。

## 工作方式

1. presence adapter 打开终端 focus reporting（`\x1b[?1004h`），把 `ESC[I` / `ESC[O` 映射为 focused / away，并消费这两个序列，不影响正常输入。
2. 只有会话处于 away、最后一个完成 turn 已超过 `idleMs`、完成轮数达到 `minTurns`、没有未闭合 turn 且该轮还没有回顾时才排定定时器。延迟按 `anchor.timestamp + idleMs - now` 计算，所以失焦得晚和失焦得早都落在同一个时刻。
3. 插件从当前 branch 的会话消息构造有界输入（`recentMessages`、`maxInputChars`）：先剔除工具结果消息（原始命令输出不算意图），再以最近一条用户请求为当前任务锚点，发起一次独立辅助请求，生成不超过 40 词、一到两句的纯文本回顾，内容是当前任务、已完成进展和下一步。
4. 每次生成带一个 `AbortController` 和 runtime generation 计数。焦点回来、新 turn、切会话、fork、compaction、换模型都会取消在途请求；提交前再校验 anchor 是否仍是最新完成轮。
5. 结果通过 `pi.appendEntry()` 写成 custom entry 持久化（写入前 `structuredClone`，避免 SessionManager 按引用持有内存对象），随后渲染卡片与状态行。
6. 自动回顾失败不弹通知（你人不在终端前），而是记成状态行的 `recap on · away · failed: <原因>`，同时在 stderr 打 `[pi-recap] ...`；一次新输入或下一次成功会把它清掉。手动 `/recap` 的错误直接以 error 通知说明原因。

## 安装

```text
pi install git:github.com/DDDFXYqiming/pi-recap
```

本地开发：

```powershell
git clone https://github.com/DDDFXYqiming/pi-recap D:\AI_Projects\pi-recap
pi -e D:\AI_Projects\pi-recap\index.ts
```

改过源码需要让运行中的 Pi 重新加载：`/reload`，或重启 `pi`。启动时 stderr 会打一行加载日志，可用来确认内存里加载的是哪一版：

```text
[pi-recap] loaded (idleMs=180000 minTurns=3 maxChars=400 maxOutputTokens=2048)
```

## 使用

```text
/recap            立即生成当前会话回顾
/recap status     打印开关、焦点、完成轮数、状态和 anchor
/recap dismiss    关闭当前回顾横幅
/recap on         打开自动回顾（写入配置文件）
/recap off        关闭自动回顾（写入配置文件）
```

成功后卡片显示在编辑器上方：

```text
↩ recap: 已完成持久化验证，下一步运行发布前回归。
```

`/recap status` 的输出形如：

```text
pi-recap: automatic on; focused; turns=7; state=ready; anchor=3f2a91c04b7d
```

`state` 取 `empty` / `ready` / `dismissed`。手动命令在会话空闲时才会执行，正在流式输出时会提示等这一轮结束。

## 模式支持

| 运行模式 | 自动回顾 | 手动 `/recap` | 说明 |
| --- | --- | --- | --- |
| regular TUI | ✅ | ✅ | 使用终端 focus reporting 判断离开与回来 |
| fullscreen TUI | ❌ | ✅ | Pi 的 fullscreen renderer 会在扩展之前消费 focus 序列，因此退化为手动 |
| RPC 模式 | ❌ | ✅ | 提供命令所需的非阻塞 UI 通道 |
| print 模式（`-p`） | ❌ | ✅ | 同上，无终端焦点概念 |

终端不支持 1004 focus reporting 时同样退化为手动，状态行显示 `manual-only`。

## 配置

配置文件：`~/.pi/agent/pi-recap.json`。首次执行 `/recap on` 或 `/recap off` 时写入；文件不存在时使用下面这份默认值，未知键会被忽略。

```jsonc
{
  "enabled": true,        // 只控制自动回顾，/recap 始终可用
  "idleMs": 180000,       // 最后一个完成 turn 到自动回顾的最短时间（毫秒）
  "minTurns": 3,          // 自动回顾所需的最少完成轮数
  "recentMessages": 80,   // 进入回顾请求的最近消息数（1–200，只计用户/助手消息）
  "maxChars": 400,        // 回顾正文显示上限（80–400）
  "maxInputChars": 24000, // 回顾输入预算（字节，1000–200000）
  "maxOutputTokens": 2048,// 辅助请求的输出 token 上限（16–16384）
  "timeoutMs": 30000,     // 单次辅助请求超时
  "provider": "",         // 留空：复用会话当前 provider
  "model": "",            // 留空：复用会话当前 model；固定路由时与 provider 成对填写
  "stopSequences": []     // 可选停止词，最多 8 条、每条 200 字符
}
```

`temperature` 是可选键，默认不写入：整行省略就不发送该字段，采样温度由模型/服务端决定；填了会被钳到 0–2。`stopSequences` 走 OpenAI 兼容适配器的请求体透传（`samplingParams.stop`），Anthropic 等其它 API 会忽略。

`provider` 与 `model` 必须成对填写，只填一个会直接报错。两者留空时回顾跟着会话真正在用的模型走，不需要单独指定路由。

回顾是辅助调用，**不发送思考等级**：它不继承会话的 `thinking level`。继承会让推理 token 吃掉 `maxOutputTokens`，返回只剩 thinking 块、正文为空，卡片就报没有文本。`maxOutputTokens` 的语义是防跑飞的输出上限而不是预算——40 词回顾实测只用 50 个 token 左右，正常永远碰不到它；真撞上，报错会直接给出当前上限值。

## 状态与持久化

回顾写入 Pi 的会话历史，类型为 `pi-recap/state` 的 custom entry：

| 字段 | 含义 |
| --- | --- |
| `version` | 快照结构版本，当前为 `1` |
| `anchorEntryId` | 回顾对应的那个完成轮 id，用于判旧和隔离 dismiss 状态 |
| `text` | 回顾正文，按 `maxChars` 收敛为单行 |
| `generatedAt` | 生成时间戳 |
| `source` | `automatic` 或 `manual` |
| `dismissed` | 是否已被关闭 |

同一分支上只取最新一条有效快照，因此会话前进后每个分支留下的始终是当前那一份。它是 custom entry，不是消息，不会进入后续 LLM 上下文；`/recap` 也不会注入新的 agent turn。

## 兼容性

| 项目 | 版本或范围 |
| --- | --- |
| pi-recap | `0.2.0`（`package.json`） |
| `@earendil-works/pi-coding-agent` | `>=0.84.4 <0.85.0`（peerDependency） |
| Node.js | `>=22.19.0`（与 Pi 运行时范围一致，离线测试直接用 node 跑 `.ts`） |
| 终端 | 需要支持 1004 focus reporting（如 Windows Terminal、xterm、iTerm2、kitty、wezterm）；不支持则自动退化为手动 |

## 开发与验证

```powershell
npm test              # typecheck + 5 组离线测试
npm run test:e2e:manual
```

离线测试覆盖状态机、presence adapter、配置解析与原子写、辅助请求构造和扩展生命周期契约，全部无需网络和终端。手动 CLI E2E 使用临时 session 目录、Pi RPC，默认走 `aliyun-tokenplan/qwen3.8-flash` + `--thinking high`，可用 `PI_E2E_MODEL` 和 `PI_E2E_THINKING` 覆盖。真实窗口切换带来的 focus 行为适合在本机交互 TUI 里验证。

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 扩展装配：命令、事件、卡片与状态行、定时器与取消 |
| `core.ts` | 纯状态机：分支解析、完成轮锚点、快照校验与恢复、文本收敛 |
| `generation.ts` | 有界辅助请求：transcript 构造、模型路由、响应取文 |
| `presence.ts` | focus reporting adapter |
| `config.ts` | 配置解析、边界钳制与原子写入 |

## 相关

- [Pi Coding Agent](https://github.com/earendil-works/pi)（`packages/coding-agent`，扩展文档在其 `docs/extensions.md`）
- [dsh-session-recap](https://github.com/DDDFXYqiming/dsh-session-recap)：同一行为在 DeepSeek Harness Web 上的实现

## 许可

MIT License。Copyright (c) 2026 DDDFXYqiming。
