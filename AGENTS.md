# 项目约定

## 工作流

- **每次更新代码后，自动部署到本地笔记本供用户验收**，无需询问：
  ```bash
  npm run build && rsync -av --delete dist/ "$HOME/SiYuanKnowledgeBase/data/plugins/siyuan-ai-agent/"
  ```
  (即 package.json 中的 `deploy:local`;$SIYUAN_WORKSPACE 未设置时不要跑 `deploy`)
- 部署前确保 `npx tsc --noEmit` 通过。
- 部署后提醒用户：在思源中重载界面(Ctrl/Cmd+R)或重开插件即可验收。

## 技术要点

- 插件基于 pi 引擎(@mariozechner/pi-ai + pi-agent-core),对话窗口挂在右侧 Dock。
- 悬停预览等能力优先复用思源全局机制(如 `initBlockPopover` 对 `data-type="block-ref"` + `data-id` 元素文档级生效),样式对齐原生 `_wysiwyg.scss`。
- 原生智能体实现参考:`app/src/layout/dock/agent/`(siyuan-note/siyuan 仓库)。
