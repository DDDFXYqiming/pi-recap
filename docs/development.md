# 开发与验证

## 环境

Node.js `>=22.19.0`，离线测试直接用 node 运行 `.ts`。终端焦点行为需在支持 1004 focus reporting 的交互 TUI 中验证。

## 命令

```powershell
npm test              # typecheck + 5 组离线测试
npm run test:e2e:manual
```

离线测试覆盖状态机、presence adapter、配置解析、原子写入、辅助请求构造和扩展生命周期。手动 CLI E2E 使用临时会话目录和 Pi RPC，可通过 `PI_E2E_MODEL` 与 `PI_E2E_THINKING` 指定已配置的模型及思考等级。

## 文件

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 扩展装配：命令、事件、卡片与状态行、定时器与取消 |
| `core.ts` | 纯状态机：分支解析、完成轮锚点、快照校验与恢复、文本收敛 |
| `generation.ts` | 有界辅助请求：transcript 构造、模型路由、响应取文 |
| `presence.ts` | focus reporting adapter |
| `config.ts` | 配置解析、边界钳制与原子写入 |
