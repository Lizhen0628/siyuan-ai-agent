# 项目约定

## 工作流

- **每次更新代码后，自动部署到本地笔记本供用户验收**，无需询问：
  - 开发目录 `dist/` 已软链到插件目录 `~/SiYuanKnowledgeBase/data/plugins/siyuan-ai-agent`（原目录备份为 `siyuan-ai-agent.bak`），构建即部署，无需 rsync。
  - 持续开发跑 `pnpm dev`（webpack watch 模式），保存即自动重建。
  - 生产构建跑 `pnpm run build`。
- 部署前确保 `npx tsc --noEmit` 通过。
- 部署后提醒用户验收方式（无需重启思源）：**设置 → 集市 → 已下载 → 关闭再开启本插件开关**（真正重载插件代码），或 Cmd+Shift+R 强制刷新界面。

## 技术要点

- 对话窗口挂在右侧 Dock。
- 悬停预览等能力优先复用思源全局机制(如 `initBlockPopover` 对 `data-type="block-ref"` + `data-id` 元素文档级生效),样式对齐原生 `_wysiwyg.scss`。
- 原生智能体实现参考:`app/src/layout/dock/agent/`(siyuan-note/siyuan 仓库)。
