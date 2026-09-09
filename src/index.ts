/**
 * SiYuan Agent (pi) —— 以 pi(pi-ai + pi-agent-core)为智能体引擎的思源笔记插件。
 *
 * pi 的 Agent 循环运行在插件侧(渲染进程),思源内核 REST API 被包装为工具;
 * 对话窗口挂载在右侧 Dock 侧边栏(参考思源内置智能体与 obsidian-copilot),
 * 与思源内置智能体相互独立。
 */
import {confirm, Plugin, showMessage} from "siyuan";
import "./index.css";
import {AgentRunner, DEFAULT_CONFIG, STORAGE_CONFIG, STORAGE_SESSION} from "./agent-runner";
import type {AgentPluginConfig} from "./agent-runner";
import type {AgentMessage} from "@mariozechner/pi-agent-core";
import {ChatPanel} from "./chat-panel";
import {SettingsDialog} from "./settings-dialog";

/** Dock 注册 id,也是 rightDock.toggleModel 使用的类型。 */
const DOCK_ID = "siyuan-agent-chat";

const ROBOT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></svg>`;
/** addIcons 需要 <symbol> 包裹的图形,复用顶栏图标的内部图形。 */
const ROBOT_SYMBOL = `<symbol id="iconSiyuanAgent" viewBox="0 0 24 24">${ROBOT_SVG.replace(/<\/?svg[^>]*>/g, "")}</symbol>`;

export default class SiyuanAgentPlugin extends Plugin {
    private config: AgentPluginConfig = {...DEFAULT_CONFIG};
    private runner!: AgentRunner;
    private panel: ChatPanel | null = null;
    private sending = false;

    constructor(options: any) {
        super(options);
    }

    override async onload(): Promise<void> {
        try {
            const stored = await this.loadData(STORAGE_CONFIG);
            if (stored) {
                this.config = {...DEFAULT_CONFIG, ...stored};
            }
        } catch (e) {
            console.error("[siyuan-agent] 读取配置失败", e);
        }
        this.runner = new AgentRunner(
            () => this.config,
            (toolName, label, args) => this.confirmWrite(toolName, label, args),
            (event) => this.panel?.handleEvent(event),
            () => this.persistSession(),
        );

        this.addTopBar({
            icon: ROBOT_SVG,
            title: "SiYuan Agent (pi)",
            callback: () => this.openChat(),
        });

        this.registerChatDock();

        // 会话恢复:下次 ensureAgent 时注入
        try {
            const session = await this.loadData(STORAGE_SESSION);
            const messages: AgentMessage[] = session?.messages ?? [];
            if (messages.length > 0) {
                this.runner.scheduleRestore(messages);
            }
        } catch (e) {
            console.error("[siyuan-agent] 读取会话失败", e);
        }
    }

    override onunload(): void {
        this.panel?.destroy();
        this.panel = null;
    }

    /** 对话窗口注册为右侧 Dock 页签,布局随思源工作区持久化。 */
    private registerChatDock(): void {
        this.addIcons(ROBOT_SYMBOL);
        this.addDock({
            id: DOCK_ID,
            type: DOCK_ID,
            config: {
                position: "RightTop",
                size: {width: 400, height: 0},
                icon: "iconSiyuanAgent",
                hotkey: "⌥⇧A",
                title: "SiYuan Agent",
                show: false,
            },
            data: {},
            init: (custom) => {
                const el = custom.element as HTMLElement;
                this.panel = new ChatPanel(el, this.runner, {
                    onSend: (textValue) => void this.send(textValue),
                    onStop: () => this.runner.stop(),
                    onNewSession: () => {
                        this.runner.reset();
                        void this.persistSession();
                        this.panel?.requestRender();
                    },
                    onOpenSettings: () => this.openSetting(),
                    getState: () => ({
                        modelId: this.config.modelId,
                        configured: Boolean(this.config.apiKey && this.config.modelId),
                    }),
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
            showMessage("未找到右侧 Dock,请尝试重置布局", 4000, "error");
            return;
        }
        if (!this.config.apiKey || !this.config.modelId) {
            showMessage(this.i18n["needConfig"] || "请先在插件设置中配置接口地址、API Key 和模型", 5000, "error");
            this.openSetting();
            return;
        }
        // 思源将插件 dock 的类型生成为 `${pluginName}${dockId}`
        const dockType = `${this.name}${DOCK_ID}`;
        const item = document.querySelector(`#dockRight [data-type="${dockType}"]`);
        const visible = item?.classList.contains("dock__item--active");
        dock.toggleModel(dockType, !visible, visible);
    }

    private async persistSession(): Promise<void> {
        try {
            await this.saveData(STORAGE_SESSION, {messages: this.runner.serializeSession()});
        } catch (e) {
            console.error("[siyuan-agent] 保存会话失败", e);
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
                "SiYuan Agent (pi)",
                `智能体请求执行写操作「${label}」(${toolName}),是否允许?\n\n<code class="fn__code">${detail
                    .replace(/&/g, "&amp;").replace(/</g, "&lt;").slice(0, 1500)}</code>`,
                () => resolve(true),
                () => resolve(false),
            );
        });
    }

    private async send(textValue: string): Promise<void> {
        if (this.sending || this.runner.isStreaming) {
            return;
        }
        this.sending = true;
        this.panel?.requestRender();
        try {
            await this.runner.send(textValue);
        } catch (e: any) {
            console.error("[siyuan-agent] 运行失败", e);
            showMessage(`智能体运行失败: ${e?.message ?? e}`, 6000, "error");
        } finally {
            this.sending = false;
            this.panel?.requestRender();
        }
    }

    override openSetting(): void {
        const dialog = new SettingsDialog({
            getConfig: () => this.config,
            onSave: (cfg) => {
                this.config = cfg;
                void this.saveData(STORAGE_CONFIG, cfg);
            },
            onClearSession: async () => {
                this.runner.reset();
                await this.persistSession();
            },
            sessionMessageCount: () => this.runner.messages.length,
        });
        dialog.open();
    }
}
