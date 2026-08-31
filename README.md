简体中文 | [English](README.en.md)

# pi-recap

> **Pi TUI 会话回顾**：在 π Coding Agent 中生成简短、可恢复上下文的 Claude Code 风格 recap。

## 它在做什么

- `/recap` 手动生成当前会话的目标、进展和一个下一步动作。
- 在 regular TUI 中使用终端 focus reporting 识别用户离开和回来。
- 默认在最后一个完成 turn 三分钟后、至少三轮且终端失焦时自动生成。
- recap 作为 Pi custom session entry 保存，不进入后续 LLM 上下文。
- 会话恢复、树导航、fork 和 compaction 后按当前 branch 恢复状态。
- 使用独立、有限时长、有限输入和输出的辅助模型请求。

## 安装

```text
pi install git:github.com/DDDFXYqiming/pi-recap
```

本地开发：

```powershell
git clone https://github.com/DDDFXYqiming/pi-recap D:\AI_Projects\pi-recap
pi -e D:\AI_Projects\pi-recap\index.ts
```

## 使用

```text
/recap
/recap status
/recap dismiss
/recap on
/recap off
```

成功后，recap 会显示在编辑器上方：

```text
↩ recap: 已完成持久化验证，下一步运行发布前回归。
```

新输入会隐藏当前卡片；生成结果不会注入新的 agent turn。

## 自动模式与终端模式

自动 recap 只在交互 TUI 中运行。regular TUI 支持终端的 `ESC[I` / `ESC[O` focus in/out 报告；fullscreen TUI 保留手动 `/recap`，因为 Pi fullscreen renderer 会在扩展之前消费 focus 序列。RPC 和 print 模式提供手动命令所需的非阻塞 UI 通道，但不触发自动 away recap。

## 配置

配置文件：`~/.pi/agent/pi-recap.json`。默认配置：

```json
{
  "enabled": true,
  "idleMs": 180000,
  "minTurns": 3,
  "recentMessages": 30,
  "maxChars": 400,
  "maxInputChars": 24000,
  "maxOutputTokens": 512,
  "timeoutMs": 30000,
  "provider": "",
  "model": "",
  "reasoningEffort": ""
}
```

默认使用当前 Pi 模型；`provider` 和 `model` 同时填写时使用固定模型。`reasoningEffort` 为空时跟随当前 thinking level，并按模型能力映射。

## 已验证测试

离线测试：

```powershell
npm test
```

手动 CLI E2E 使用临时 session 目录、Pi RPC、阿里云 Code Plan 的 `aliyun-tokenplan/qwen3.8-flash` 和 `--thinking high`：

```powershell
npm run test:e2e:manual
```

模型可以通过 `PI_E2E_MODEL` 和 `PI_E2E_THINKING` 覆盖，默认值保持上述验收路径。自动 focus 行为由离线状态机和 presence adapter 测试覆盖，真实窗口切换适合在本机交互 TUI 中验证。

## 许可

MIT License。Copyright (c) 2026 DDDFXYqiming。
