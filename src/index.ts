/**
 * SiYuan Ai Agent —— 思源笔记智能体插件(基于 pi 引擎:pi-ai + pi-agent-core)。
 *
 * pi 的 Agent 循环运行在插件侧(渲染进程),思源内核 REST API 被包装为工具;
 * 对话窗口挂载在右侧 Dock 侧边栏(参考思源内置智能体与 obsidian-copilot),
 * 与思源内置智能体相互独立。
 */
import {confirm, getFrontend, openMobileFileById, openTab, Plugin, showMessage} from "siyuan";
import "./index.css";
import {AgentRunner, DEFAULT_CONFIG, STORAGE_CONFIG, STORAGE_SESSION, migrateConfig, modelCapabilities, resolveActiveModel} from "./agent-runner";
import {refreshUserSkills, enabledSkills} from "./skills";
import type {AgentPluginConfig} from "./agent-runner";
import type {AgentMessage} from "@mariozechner/pi-agent-core";
import {ChatPanel} from "./chat-panel";
import {SettingsDialog} from "./settings-dialog";
import {initI18n, t} from "./i18n";

/** Dock 注册 id,也是 rightDock.toggleModel 使用的类型。 */
const DOCK_ID = "siyuan-ai-agent-chat";
/** 多会话存储(替代旧版单会话 STORAGE_SESSION)。 */
const STORAGE_SESSIONS = "agent-sessions";
/** 历史会话保留上限。 */
const MAX_SESSIONS = 50;

/** 一条持久化的历史会话。 */
interface StoredSession {
    id: string;
    title: string;
    updatedAt: number;
    modelId: string;
    messages: AgentMessage[];
}

function genSessionId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 会话标题:取第一条用户消息的前 40 个字符。 */
function deriveSessionTitle(messages: AgentMessage[]): string {
    for (const m of messages) {
        if (m.role !== "user") {
            continue;
        }
        const blocks = (m as any).content;
        if (typeof blocks === "string") {
            return blocks.slice(0, 40) || t("newChatTitle");
        }
        for (const b of blocks ?? []) {
            if (b.type === "text" && b.text?.trim()) {
                return b.text.trim().slice(0, 40);
            }
        }
        return t("imageMsg");
    }
    return t("newChatTitle");
}

/**
 * 插件图标:采用思源原生大脑图标的 path(描边风格,stroke-width 1.7),
 * 但以独立 symbol 注册(addIcons),不依赖运行时 sprite 解析,顶栏/边栏都能稳定显示。
 */
const AGENT_ICON_PATHS =
    `<path d="M12 18V5"/><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"/>` +
    `<path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"/>` +
    `<path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/><path d="M18 18a4 4 0 0 0 2-7.464"/>` +
    `<path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/>` +
    `<path d="M6 18a4 4 0 0 1-2-7.464"/><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/>`;
const AGENT_ICON_ATTRS = `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"`;
const AGENT_ICON_SYMBOL = `<symbol id="iconSiyuanAgent" ${AGENT_ICON_ATTRS}>${AGENT_ICON_PATHS}</symbol>`;

export default class SiyuanAgentPlugin extends Plugin {
    private config: AgentPluginConfig = {...DEFAULT_CONFIG};
    private runner!: AgentRunner;
    private panel: ChatPanel | null = null;
    private sending = false;
    private sessions: StoredSession[] = [];
    private currentSessionId = genSessionId();

    constructor(options: any) {
        super(options);
    }

    override async onload(): Promise<void> {
        // 界面文案跟随思源界面语言(window.siyuan.config.lang)
        initI18n(this.i18n as unknown as Record<string, string>);
        // 预热用户技能缓存(~/.agents/skills),供系统提示词与设置页使用
        void refreshUserSkills();
        try {
            const stored = await this.loadData(STORAGE_CONFIG);
            if (stored) {
                // 兼容旧版单模型配置(modelId) → 多模型列表
                this.config = migrateConfig(stored);
            }
        } catch (e) {
            console.error("[siyuan-ai-agent] 读取配置失败", e);
        }
        this.runner = new AgentRunner(
            () => this.config,
            (toolName, label, args) => this.confirmWrite(toolName, label, args),
            (event) => this.panel?.handleEvent(event),
            () => this.persistSession(),
            this.app,
        );

        // 注册图标 symbol,侧边栏 dock 引用它
        this.addIcons(AGENT_ICON_SYMBOL);

        this.registerChatDock();

        // 会话恢复:加载历史会话列表,恢复最近一次的会话;兼容旧版单会话存储
        try {
            const store = await this.loadData(STORAGE_SESSIONS);
            this.sessions = Array.isArray(store?.sessions) ? store.sessions : [];
            if (store?.currentId && this.sessions.some((s) => s.id === store.currentId)) {
                this.currentSessionId = store.currentId;
            }
            if (this.sessions.length === 0) {
                const legacy = await this.loadData(STORAGE_SESSION);
                const legacyMsgs: AgentMessage[] = legacy?.messages ?? [];
                if (legacyMsgs.length > 0) {
                    this.sessions = [{
                        id: this.currentSessionId,
                        title: deriveSessionTitle(legacyMsgs),
                        updatedAt: Date.now(),
                        modelId: "",
                        messages: legacyMsgs,
                    }];
                }
            }
            const current = this.sessions.find((s) => s.id === this.currentSessionId)
                ?? this.sessions[0];
            if (current) {
                this.currentSessionId = current.id;
                this.runner.scheduleRestore(current.messages);
            }
        } catch (e) {
            console.error("[siyuan-ai-agent] 读取会话失败", e);
        }
    }

    override onunload(): void {
        this.panel?.destroy();
        this.panel = null;
    }

    /** 对话窗口注册为右侧 Dock 页签,布局随思源工作区持久化。 */
    private registerChatDock(): void {
        this.addDock({
            id: DOCK_ID,
            type: DOCK_ID,
            config: {
                position: "RightTop",
                size: {width: 400, height: 0},
                icon: "iconSiyuanAgent",
                hotkey: "⌥⇧A",
                title: "SiYuan Ai Agent",
                show: false,
            },
            data: {},
            init: (custom) => {
                const el = custom.element as HTMLElement;
                this.panel = new ChatPanel(el, this.runner, {
                    onSend: (textValue, images) => void this.send(textValue, images),
                    onEditResend: (index, textValue, images) => void this.editResend(index, textValue, images),
                    onStop: () => this.runner.stop(),
                    onNewSession: () => {
                        this.currentSessionId = genSessionId();
                        this.runner.reset();
                        void this.persistSession();
                        this.panel?.requestRender();
                    },
                    onOpenSettings: () => this.openSetting(),
                    listSessions: () => this.sessions.map((s) => ({id: s.id, title: s.title, updatedAt: s.updatedAt})),
                    /** 输入 / 时唤起的已启用技能列表。 */
                    listSkills: () => enabledSkills(this.config)
                        .map((s) => ({id: s.id, name: s.name, description: s.description})),
                    onOpenSession: (id) => {
                        if (id === this.currentSessionId || this.runner.isStreaming) {
                            return;
                        }
                        const target = this.sessions.find((s) => s.id === id);
                        if (!target) {
                            return;
                        }
                        this.currentSessionId = id;
                        this.runner.loadMessages(target.messages);
                        this.panel?.closeHistory();
                        this.panel?.requestRender();
                    },
                    onDeleteSession: (id) => {
                        if (id === this.currentSessionId) {
                            return;
                        }
                        this.sessions = this.sessions.filter((s) => s.id !== id);
                        void this.saveData(STORAGE_SESSIONS, {currentId: this.currentSessionId, sessions: this.sessions});
                    },
                    /** 点击消息中的块引用:打开对应笔记(对齐原生智能体)。 */
                    onOpenBlock: (id) => {
                        if (getFrontend() === "mobile") {
                            openMobileFileById(this.app, id);
                        } else {
                            void openTab({app: this.app, doc: {id}});
                        }
                    },
                    getState: () => {
                        const active = resolveActiveModel(this.config);
                        const caps = modelCapabilities(this.config);
                        return {
                            modelId: active.id,
                            configured: Boolean(this.config.apiKey && active.id),
                            sessionId: this.currentSessionId,
                            models: this.config.models
                                .filter((m) => m.enabled && m.id)
                                .map((m) => ({
                                    id: m.id,
                                    label: m.displayName || m.id,
                                    active: m.id === active.id,
                                })),
                            thinking: {
                                level: this.config.thinkingLevel ?? "off",
                                reasoning: caps.reasoning,
                                levels: caps.thinkingLevels,
                            },
                            supportsImage: caps.image,
                        };
                    },
                    onSwitchModel: (id) => {
                        if (this.config.activeModelId === id) {
                            return;
                        }
                        this.config.activeModelId = id;
                        void this.saveData(STORAGE_CONFIG, this.config);
                        this.panel?.requestRender();
                    },
                    onSetThinking: (level) => {
                        if (this.config.thinkingLevel === level) {
                            return;
                        }
                        this.config.thinkingLevel = level;
                        void this.saveData(STORAGE_CONFIG, this.config);
                        this.panel?.requestRender();
                    },
                });
            },
            destroy: () => {
                this.panel?.destroy();
                this.panel = null;
            },
            resize: () => {
                this.panel?.requestRender();
            },
        });
    }

    /** 打开(或聚焦)右侧侧边栏对话面板;已在前台时再点收起。 */
    openChat(): void {
        const dock = (window as any).siyuan?.layout?.rightDock;
        if (!dock) {
            showMessage(t("dockNotFound"), 4000, "error");
            return;
        }
        if (!this.config.apiKey || !resolveActiveModel(this.config).id) {
            showMessage(t("needConfig"), 5000, "error");
            this.openSetting();
            return;
        }
        // 思源将插件 dock 的类型生成为 `${pluginName}${dockId}`
        const dockType = `${this.name}${DOCK_ID}`;
        const item = document.querySelector(`#dockRight [data-type="${dockType}"]`);
        const visible = item?.classList.contains("dock__item--active");
        dock.toggleModel(dockType, !visible, visible);
    }

    /** 持久化当前会话到历史列表(空会话不保存),并记录最近会话 id。 */
    private async persistSession(): Promise<void> {
        try {
            const messages = this.runner.serializeSession();
            const idx = this.sessions.findIndex((s) => s.id === this.currentSessionId);
            if (messages.length === 0) {
                if (idx >= 0) {
                    this.sessions.splice(idx, 1);
                }
            } else {
                const record: StoredSession = {
                    id: this.currentSessionId,
                    title: deriveSessionTitle(messages),
                    updatedAt: Date.now(),
                    modelId: resolveActiveModel(this.config).id,
                    messages,
                };
                if (idx >= 0) {
                    this.sessions[idx] = record;
                } else {
                    this.sessions.push(record);
                }
                this.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
                this.sessions = this.sessions.slice(0, MAX_SESSIONS);
            }
            await this.saveData(STORAGE_SESSIONS, {currentId: this.currentSessionId, sessions: this.sessions});
        } catch (e) {
            console.error("[siyuan-ai-agent] 保存会话失败", e);
        }
    }

    private confirmWrite(toolName: string, label: string, args: unknown): Promise<boolean> {
        const detail = (() => {
            try {
                return JSON.stringify(args, null, 1);
            } catch {
                return String(args);
            }
        })();
        return new Promise<boolean>((resolve) => {
            confirm(
                "SiYuan Ai Agent",
                `${t("confirmWriteBody", {label, tool: toolName})}\n\n<code class="fn__code">${detail
                    .replace(/&/g, "&amp;").replace(/</g, "&lt;").slice(0, 1500)}</code>`,
                () => resolve(true),
                () => resolve(false),
            );
        });
    }

    private async send(textValue: string, images?: import("@mariozechner/pi-ai").ImageContent[]): Promise<void> {
        if (this.sending || this.runner.isStreaming) {
            return;
        }
        this.sending = true;
        this.panel?.requestRender();
        try {
            await this.runner.send(textValue, images);
        } catch (e: any) {
            console.error("[siyuan-ai-agent] 运行失败", e);
            showMessage(t("runFailed", {msg: e?.message ?? e}), 6000, "error");
        } finally {
            this.sending = false;
            this.panel?.requestRender();
        }
    }

    /** 编辑重发:截断被编辑消息及其后的对话,以新内容重新发送(生成中先中止)。
     *  对齐原生 regenerateResponse:若被编辑消息之后执行过工具(笔记可能已被修改),
     *  弹确认框提示历史将被删除且副作用不会回滚。 */
    private async editResend(index: number, textValue: string, images?: import("@mariozechner/pi-ai").ImageContent[]): Promise<void> {
        if (this.sending) {
            return;
        }
        // hasAgentExecutedToolsAfter 的等价判断:后续 assistant 消息中含工具调用
        const toolsAfter = this.runner.messages.slice(index + 1).some((m) =>
            m.role === "assistant" && Array.isArray(m.content)
            && (m.content as {type?: string}[]).some((b) => b.type === "toolCall"));
        if (toolsAfter && !(await this.confirmEditTruncation())) {
            return;
        }
        this.sending = true;
        try {
            if (!(await this.runner.truncateFrom(index))) {
                showMessage(t("cannotEditMessage"), 3000, "error");
                return;
            }
            this.panel?.requestRender();
            await this.runner.send(textValue, images);
        } catch (e: any) {
            console.error("[siyuan-ai-agent] 运行失败", e);
            showMessage(t("runFailed", {msg: e?.message ?? e}), 6000, "error");
        } finally {
            this.sending = false;
            this.panel?.requestRender();
        }
    }

    /** 截断确认(对齐原生 agentEditHistoryWarning):已执行的工具操作不会回滚。 */
    private confirmEditTruncation(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            confirm(
                window.siyuan?.languages?.confirm ?? "Confirm",
                window.siyuan?.languages?.agentEditHistoryWarning
                    ?? t("editHistoryWarning"),
                () => resolve(true),
                () => resolve(false),
            );
        });
    }

    override openSetting(): void {
        const dialog = new SettingsDialog({
            getConfig: () => this.config,
            onSave: (cfg) => {
                this.config = migrateConfig(cfg);
                void this.saveData(STORAGE_CONFIG, this.config);
            },
            onClearSession: async () => {
                this.runner.reset();
                await this.persistSession();
            },
            sessionMessageCount: () => this.runner.messages.length,
            app: this.app,
        });
        dialog.open();
    }
}
