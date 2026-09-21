# 开发与验证

## 环境

Node.js `>=22.19.0`，离线测试直接用 node 运行 `.ts`。终端焦点行为需在支持 1004 focus reporting 的交互 TUI 中验证。

## 命令

```powershell
npm test              # typecheck + 5 组离线测试
npm run test:e2e:manual
node --test test/startup-probe.test.mjs  # 独立启动诊断回归，不调用模型
```

离线测试覆盖状态机、presence adapter、配置解析、原子写入、辅助请求构造和扩展生命周期。手动 CLI E2E 使用临时会话目录和 Pi RPC，可通过 `PI_E2E_MODEL` 与 `PI_E2E_THINKING` 指定已配置的模型及思考等级。上述测试不能代替 Windows Terminal/ConPTY 冷启动验证。

手动 E2E 会先向会话里塞一轮“loud”的 markdown 长汇报（加粗、行内代码、有序列表、冒号引导句），再 `/recap`，用来量提示词的合规度，断言包括：回顾正文不含 markdown 语法、不折行、不以描述转录的引导句开头、不超 `maxChars`、不含思考标签泄漏。换模型时这几项是主要回归信号：实测 MiniMax-M3 会把思考写进正文通道，因此 `manual-recap-persisted` 会故意失败（插件拒收），而 `aliyun-deepseek/qwen3.8-flash`、`deepseek/deepseek-v4-flash` 应全部通过。

## Windows TUI 首启卡住

`[pi-recap] loaded` 只说明扩展工厂完成了注册，不证明 `session_start` 已经执行，更不能直接证明卡在 focus reporting。Pi 0.86.0 的 `main.ts` 在创建运行时之后还检查 piped stdin，然后才进入交互 TUI；`interactive-mode.ts` 在 TUI start 和 managed-tool setup 之后才绑定会话扩展。

上一版将 focus 安装延迟 25ms，但本地反馈仍有首启卡住。**25ms 仅是时序实验，不是“首帧完成”或“键盘协议协商完成”的握手保证。** 不应继续依据最后一条 `loaded` 日志盲目增大延迟。当前 peer 范围仍是 `>=0.84.4 <0.86.0`，本机 0.86.0 需另外验证；范围外本身也不证明是本次卡死原因。

### 保留真实终端的诊断入口

先在已有窗口拉取代码，然后每个实验新开一个终端窗口/标签页，并把下面脚本当作该窗口的第一次 Pi 启动。不要先运行 `pi --version`、`pi --help` 或测试性的 `pi`，否则可能消耗掉“第一次”的触发条件。用脚本的完整路径运行，保持原故障出现时的工作目录，不要为了运行脚本先切到插件仓库。

```powershell
& '路径\pi-recap\scripts\diagnose-startup.ps1' -Case normal
```

另一个全新终端中运行：

```powershell
& '路径\pi-recap\scripts\diagnose-startup.ps1' -Case focus-off
```

若关闭 focus 仍然卡，再用全新终端测试 `-Case no-extensions`。`-Case recap-only` 会禁用自动发现的扩展，只显式加载仓库的 `index.ts`。多个实验不能在同一窗口连续跑完后称为冷启动对照。卡住后等待约 10 秒再 Ctrl+C；日志已逐条落盘，强制关闭窗口也不会清掉已写的文件。

脚本不修改 profile、用户配置或 Pi 安装，不重新启动 shell，不重定向 stdin/stdout，不使用管道或 `Tee-Object`。它临时设置 Node preload，调用当前 shell 实际解析到的 `pi` 命令，并在返回时恢复原有环境变量。可用 `-PiCommand` 指定其它启动命令，或用 `-OutputDirectory` 指定日志目录。默认位置是系统临时目录下的 `pi-startup-traces`，每次测试建立独立目录；继承环境的 Node 子进程会各写各的 PID 日志。

### 先用 Pi 自带的分阶段计时

在怀疑扩展之前，可以先让 Pi 自己报出每个扩展的模块导入耗时。`PI_TIMING=1` 会把分阶段计时写到 stderr，`PI_STARTUP_BENCHMARK=1` 会在 `interactive-mode.init()` 之后直接退出，因此不需要手工退出 TUI。交互模式需要真实终端，同时把 stderr 重定向到文件即可留档：

```powershell
$env:PI_TIMING = '1'; $env:PI_STARTUP_BENCHMARK = '1'
& pi 2> "$env:TEMP\pi-timing.txt"
Get-Content "$env:TEMP\pi-timing.txt"
```

输出里的 `Startup Timings: extensions` 段按扩展给出 `module import` 与 `factory` 两项。若某个扩展的 `module import` 占了大头，卡顿来自该扩展的加载，而不是 recap 的 focus 安装；对照 `pi --no-extensions` 的 TOTAL 可以先量出扩展开销的上限。

### 日志怎么读

`node-<pid>-<timestamp>.jsonl` 每条包含相对时间、PID、事件名称。先选包含 `recap:factory:return` 的 Pi 进程日志；`no-extensions` 对照则根据 `probe:start` 和终端标记选择。

| 最后能确认的阶段 | 下一步调查范围（不是未经验证的根因结论） |
| --- | --- |
| `recap:factory:return`，未见 `recap:session-start:enter` | 扩展工厂已返回，但 Pi 尚未调用这个回调；查其它扩展、运行时和 TUI 启动，不是把 presence 的延迟再加大 |
| `setRawMode:begin`，未见对应 `end` | Node/控制台切换 raw mode 的同步调用尚未返回 |
| `dlopen:begin`，未见对应 `end` | 原生模块加载的同步调用尚未返回 |
| `spawnSync` / `execFileSync` / `execSync` 的 `begin` 无配对结束 | 查对应调用和子进程，不先断言是 PowerShell profile |
| `recap:session-start:done`，随后出现 `recap:presence:install-begin` | 已进入真正的 focus 安装阶段；继续结合 focus-off 对照 |
| `recap:presence:install-ok` | listener/enable 写入调用已返回；不等于终端确认支持该协议或首帧已经显示 |
| 心跳持续，但画面不动 | JavaScript 事件循环仍能调度；进一步看异步等待、输出和 TTY 状态 |
| 心跳停止 | 可能有同步阻塞，也可能是进程退出/暂停、日志失败或观测窗口结束；必须结合其它事件判断 |

每秒心跳记录 TTY/raw 状态、stdin data listener 数、累计输出字节数、Node 活跃资源类型以及尚未关闭的被观察子进程。探针只识别少量固定终端控制序列，不保存按键、普通输出、模型正文、请求内容、命令参数、完整环境或凭据。没有新增 stdin data listener，也不主动启动网络请求。最多观察两分钟、写两千条事件；到时停止诊断并恢复可恢复的包装，不终止 Pi。

**诊断会改变启动时序**，因此带探针不复现不能证明已修复。若它反而稳定，要记录这个差异。stdout 的配对记录只说明 `write()` 调用已返回，不代表终端实际完成显示；未记录某个控制序列也不能单独当作它从未发送的证明。

测试 profile 时，必须让全新终端直接以 `pwsh -NoProfile` 启动。在一个已经执行过 profile 的窗口里再输入 `pwsh -NoProfile`，不能撤销此前启动的后台进程，不能作为干净对照。

## 文件

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 命令、事件、卡片与状态行、定时器与取消；可选启动检查点 |
| `core.ts` | 纯状态机、分支与快照、文本收敛 |
| `generation.ts` | 有界辅助请求 |
| `presence.ts` | focus reporting adapter |
| `config.ts` | 配置解析与原子写入 |
| `scripts/diagnose-startup.ps1` | 保留 cwd、Pi 命令和终端句柄的诊断启动器 |
| `scripts/startup-probe.cjs` | 仅在显式启用时观察 Node 启动，不接管输入 |
