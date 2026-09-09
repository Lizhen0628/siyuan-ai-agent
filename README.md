# SiYuan Agent (pi)

思源笔记插件：以 [pi](https://pi.dev/)（[@mariozechner/pi-ai](https://www.npmjs.com/package/@mariozechner/pi-ai) + [@mariozechner/pi-agent-core](https://www.npmjs.com/package/@mariozechner/pi-agent-core)）作为智能体引擎的第二套智能体。

pi 的 agent 循环（工具调用、会话管理、事件流）直接打包进插件运行在思源前端；思源内核 REST API 被包装成智能体工具。与思源内置智能体互不影响、会话独立。

## 功能

- 顶栏图标打开聊天对话框，Enter 发送、Shift+Enter 换行，流式输出
- 内置笔记工具：列出笔记本 / 全文搜索 / 读文档 / 读块 / 创建文档 / 更新块 / 插入块 / 删除块
- 写操作（创建/更新/插入/删除）默认弹窗确认后执行
- 会话自动持久化，重启思源后恢复
- 支持任意 OpenAI 兼容接口，以及 Anthropic、Google 原生协议

## 设置面板（v0.2.0 重构）

左侧分类导航 + 右侧分页：

- **模型服务**：内置 pi 目录全部 31 家服务商（订阅制 Coding Plan：ChatGPT Codex / Kimi Coding / 小米 Token 包 / GitHub Copilot 等；直连 API：Anthropic / OpenAI / Gemini / DeepSeek / 智谱 Z.AI 等；聚合网关：OpenRouter / OpenCode / Vercel AI Gateway 等；云平台：Bedrock / Azure / Vertex）。选择内置服务商自动填充地址与协议；模型下拉来自 pi 目录，选中即带出上下文窗口等参数
  - **获取上游模型**：按协议调用上游"列出模型"接口（OpenAI `/models`、Anthropic `/v1/models`、Google `/v1beta/models`），拉取服务端实际支持的模型
  - **测试连接**：零成本验证地址与密钥（即一次模型列表请求，显示模型数与延迟）
  - **发送测试消息**：走 pi 完整管线发一条真实消息，验证密钥、模型与协议全链路可用
- **模型参数**：上下文窗口、最大输出 tokens
- **智能体行为**：写操作确认开关、自定义系统提示词、清空会话
- **关于**：版本、引擎、仓库与使用说明

## 配置

插件设置中填写：

| 项 | 说明 |
| --- | --- |
| 服务商 | 内置 31 家或"自定义"；内置服务商自动填充地址/协议/模型目录 |
| 接口地址 | 一般以 `/v1` 结尾，如 `https://api.openai.com/v1`。注意：pi 按标准 OpenAI 惯例拼接 `/chat/completions`，不会像思源内核那样自动补 `/v1`，所以地址需要显式带版本号 |
| API Key | 模型服务密钥（明文存于本地工作空间） |
| 模型 ID | 从目录/上游列表选择，或手动覆盖填写，如 `gpt-4o`、`glm-5.3-flash` |
| 接口协议 | openai-completions / openai-responses / anthropic-messages / google-generative-ai |

## 已验证

- 思源 v3.8.3 桌面端/浏览器端加载、设置面板（分页导航、服务商切换自动填充、模型目录、参数带出、测试连接错误渲染、保存与旧配置迁移）、聊天面板、错误提示 ✅
- 工具集对应的内核 API（lsNotebooks / query.sql / block 读写删）✅
- pi-ai 对自定义 `Model` + 自定义 baseUrl 的调用链 ✅（在 Node 环境直连验证到 HTTP 层）
- 完整的模型往返调用依赖你的 API Key 在该客户端可用；实测部分 coding-plan 中转的密钥绑定特定客户端，在思源（或其它环境）调用会返回 401「填写 sk-zcode- 格式密钥」，需换通用密钥或官方 API
- 测试连接/获取上游模型在思源桌面端（Electron，webSecurity 关闭）可直连任意上游；在浏览器访问内核时受 CORS 限制属正常现象（面板会给出对应提示）

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
