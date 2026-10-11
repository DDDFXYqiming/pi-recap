简体中文 | [English](README.en.md)

# pi-recap

**Pi Coding Agent 的无侵入式终端会话智能回顾扩展**。

当开发者切出终端窗口处理其他事务时，`pi-recap` 在后台自动利用辅助模型生成一段凝练的进度回顾；当切回终端时，编辑器上方呈现结构化的上下文卡片，直击核心目标、已完成进展与下一步动作，消除长时间离开造成的思路断层。

---

## 核心特性

* **焦点感知驱动（Focus-Aware）**：利用终端协议 `\x1b[?1004h` 监听失焦与重获焦点，只有真正切走窗口且空闲达到阈值（默认 3 分钟且至少 3 个完成轮次）时才触发，窗口保持聚焦时绝不浪费模型调用。
* **零上下文污染（Zero Context Pollution）**：回顾内容作为 Pi 自定义会话状态（`pi-recap/state`）独立持久化，绝不作为对话消息追加，不消耗后续大模型对话上下文与 Token 预算。
* **确定性分支同步**：与会话树、分支导航、Fork 和 Compaction 原生联动。在途请求随会话切换、新轮次启动或分支跳转自动中止（AbortController），确保所见内容始终与最新代码分支严格对齐。
* **自适应语言契约**：根据用户输入语种动态确定输出语言；硬性约束模型直接输出 2~4 句硬核结论（点名具体修改文件、命令与数值结果），杜绝 AI 客套话与抽象陈述。
* **优雅降级与极简管理**：提供状态栏常驻指示（`recap on · focused` / `manual-only`）；支持手动 `/recap` 随时呼出。

---

## 运行时架构与原理

```
[终端窗口切出 (ESC[O)] ──> [Presence Adapter 计时] ──> [满足门槛: 3min + 3 turns]
                                                              │
                                                              ▼
[状态栏更新 / 渲染卡片] <── [写入 pi-recap/state] <── [过滤工具日志 / 提取意图]
          │                                                   │
          ▼                                                   ▼
[切回窗口 (ESC[I)] ─────────────────────────────────> [独立辅助模型调用]
```

1. **终端协议无感劫持**：通过 Presence Adapter 开启终端 1004 focus reporting，拦截并消费 `ESC[I`（聚焦）与 `ESC[O`（失焦）序列，不干扰常规标准输入。
2. **有界输入构建**：剥离冗长的原始命令与工具执行日志，仅提取最新用户目标、压缩摘要（History Summary）与近期意图，构建紧凑且高度保真的提示词。
3. **并发安全与状态隔离**：每个请求由独立的 `AbortController` 和代际计数器管控，任何用户新击键、会话重载或新分支切换立即作废旧请求。

---

## 模式支持

| 运行环境 | 自动失焦回顾 | 手动 `/recap` | 说明 |
| :--- | :---: | :---: | :--- |
| **Regular TUI** | ✅ | ✅ | 完整支持终端 1004 Focus Reporting 协议 |
| **Fullscreen TUI** | ❌ | ✅ | 全屏渲染器优先消费控制序列，自动平滑退化为手动模式 |
| **RPC 模式** | ❌ | ✅ | 无终端前台窗口，提供标准命令通道 |
| **Print 模式 (`-p`)** | ❌ | ✅ | 无交互界面，支持按需命令执行 |

*注：在不支持 1004 协议的终端中，状态栏将自动标注 `manual-only`。*

---

## 安装与快速上手

### 插件安装

```bash
pi install git:github.com/DDDFXYqiming/pi-recap
```

### 本地开发加载

```powershell
git clone https://github.com/DDDFXYqiming/pi-recap.git
cd pi-recap
pi -e .\index.ts
```

启动时将输出加载日志确认配置状态：
```text
[pi-recap] loaded (idleMs=180000 minTurns=3 maxChars=600 maxOutputTokens=2048 focus=auto)
```

---

## 交互指令

```text
/recap            立即为当前会话生成回顾卡片
/recap status     查看当前回顾开关、焦点感知状态、锚点与轮次信息
/recap dismiss    关闭当前显示的回顾横幅
/recap on         启用自动失焦回顾（写入用户配置）
/recap off        关闭自动失焦回顾（仅保留手动调用）
```

回顾卡片示例：
```text
↩ recap: 已完成会话持久化与分支状态隔离；下一步运行发布前回归脚本。
```

---

## 配置指南

配置文件路径为 `~/.pi/agent/pi-recap.json`，在首次运行 `/recap on` 或 `/recap off` 时自动生成：

```jsonc
{
  "enabled": true,           // 是否启用自动失焦回顾
  "idleMs": 180000,          // 触发等待时间（毫秒，默认 3 分钟）
  "minTurns": 3,             // 触发所需的最小完成对话轮次
  "maxChars": 600,           // 回顾正文字符上限
  "maxInputChars": 8000,     // 提炼时截取的最大上下文长度
  "recentMessages": 12,      // 参与意图提炼的最近消息条数
  "provider": null,          // 可选：指定模型提供商（null 则复用当前会话模型）
  "model": null,             // 可选：指定辅助模型名称
  "maxOutputTokens": 2048    // 辅助调用最大输出 Token
}
```

*若需临时排查终端兼容性问题，可设置环境变量 `$env:PI_RECAP_FOCUS="0"` 启动，插件将安全退化为纯手动模式。*

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
