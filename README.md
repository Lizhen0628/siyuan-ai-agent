# SiYuan Agent (pi)

思源笔记插件：以 [pi](https://pi.dev/)（[@mariozechner/pi-ai](https://www.npmjs.com/package/@mariozechner/pi-ai) + [@mariozechner/pi-agent-core](https://www.npmjs.com/package/@mariozechner/pi-agent-core)）作为智能体引擎的第二套智能体。

pi 的 agent 循环（工具调用、会话管理、事件流）直接打包进插件运行在思源前端；思源内核 REST API 被包装成智能体工具。与思源内置智能体互不影响、会话独立。

## 功能

- 顶栏图标打开聊天对话框，Enter 发送、Shift+Enter 换行，流式输出
- 内置笔记工具：列出笔记本 / 全文搜索 / 读文档 / 读块 / 创建文档 / 更新块 / 插入块 / 删除块
- 写操作（创建/更新/插入/删除）默认弹窗确认后执行
- 会话自动持久化，重启思源后恢复
- 支持任意 OpenAI 兼容接口，以及 Anthropic、Google 原生协议

## 配置

插件设置中填写：

| 项 | 说明 |
| --- | --- |
| 接口地址 | 一般以 `/v1` 结尾，如 `https://api.openai.com/v1`。注意：pi 按标准 OpenAI 惯例拼接 `/chat/completions`，不会像思源内核那样自动补 `/v1`，所以地址需要显式带版本号 |
| API Key | 模型服务密钥（明文存于本地工作空间） |
| 模型 ID | 如 `gpt-4o`、`glm-5.3-flash` |
| 接口协议 | openai-completions / openai-responses / anthropic-messages / google-generative-ai |

## 已验证

- 思源 v3.8.3 桌面端/浏览器端加载、设置面板、聊天面板、错误提示 ✅
- 工具集对应的内核 API（lsNotebooks / query.sql / block 读写删）✅
- pi-ai 对自定义 `Model` + 自定义 baseUrl 的调用链 ✅（在 Node 环境直连验证到 HTTP 层）
- 完整的模型往返调用依赖你的 API Key 在该客户端可用；实测部分 coding-plan 中转的密钥绑定特定客户端，在思源（或其它环境）调用会返回 401「填写 sk-zcode- 格式密钥」，需换通用密钥或官方 API

## 构建

```bash
pnpm install
pnpm build          # 产物在 dist/
pnpm deploy:local   # 构建并部署到 ~/SiYuanKnowledgeBase/data/plugins/siyuan-agent
```

## 已知边界

- 桌面端（Electron）完整可用；浏览器端（浏览器访问内核）因无 Node 环境部分依赖不可用
- pi 全量依赖（各厂商官方 SDK）未做裁剪，`dist/index.js` 体积较大
- 与思源内置智能体的会话、审批策略、技能体系互不相通
