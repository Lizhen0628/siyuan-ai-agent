/**
 * SiYuan Agent (pi) —— 以 pi(pi-ai + pi-agent-core)为智能体引擎的思源笔记插件。
 *
 * pi 的 Agent 循环运行在插件侧(渲染进程),思源内核 REST API 被包装为工具;
 * 与思源内置智能体相互独立。
 */
import {confirm, Dialog, Plugin, Setting, showMessage} from "siyuan";
import "./index.css";
import {AgentRunner, DEFAULT_CONFIG, STORAGE_CONFIG, STORAGE_SESSION} from "./agent-runner";
import type {AgentPluginConfig} from "./agent-runner";
import type {AgentMessage} from "@mariozechner/pi-agent-core";
import {ChatPanel} from "./chat-panel";

const DIALOG_CLASS = "sy-agent-dialog";

export default class SiyuanAgentPlugin extends Plugin {
    private config: AgentPluginConfig = {...DEFAULT_CONFIG};
    private runner!: AgentRunner;
    private dialog: Dialog | null = null;
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
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></svg>`,
            title: "SiYuan Agent (pi)",
            callback: () => this.openChat(),
        });

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
        this.dialog?.destroy();
        this.dialog = null;
    }

    private async persistSession(): Promise<void> {
        try {
            await this.saveData(STORAGE_SESSION, {messages: this.runner.serializeSession()});
        } catch (e) {
            console.error("[siyuan-agent] 保存会话失败", e);
        }
    }

    private confirmWrite(toolName: string, label: string, args: unknown): Promise<boolean> {
        return new Promise((resolve) => {
            let detail = "";
            try {
                detail = JSON.stringify(args, null, 1);
            } catch {
                detail = String(args);
            }
            confirm(
                "SiYuan Agent (pi)",
                `智能体请求执行写操作「${label}」(${toolName}),是否允许?\n\n<code class="fn__code">${detail
                    .replace(/&/g, "&amp;").replace(/</g, "&lt;").slice(0, 1500)}</code>`,
                () => resolve(true),
                () => resolve(false),
            );
        });
    }

    openChat(): void {
        if (this.dialog) {
            this.dialog.element.classList.remove("fn__none");
            return;
        }
        if (!this.config.apiKey || !this.config.modelId) {
            showMessage(this.i18n["needConfig"] || "请先在插件设置中配置接口地址、API Key 和模型", 5000, "error");
            this.openSetting();
            return;
        }
        this.dialog = new Dialog({
            title: "SiYuan Agent (pi)",
            content: `<div class="sy-agent-root"></div>`,
            width: "760px",
            height: "82vh",
            destroyCallback: () => {
                this.dialog = null;
                this.panel = null;
            },
        });
        this.dialog.element.classList.add(DIALOG_CLASS);
        const root = this.dialog.element.querySelector(".sy-agent-root") as HTMLElement;
        this.panel = new ChatPanel(root, this.runner, {
            onSend: (textValue) => this.send(textValue),
            onStop: () => this.runner.stop(),
            onNewSession: () => {
                this.runner.reset();
                void this.persistSession();
                this.panel?.requestRender();
            },
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
        // 直接闭包捕获输入元素,保存时读取(Setting 类型不暴露 element)
        const els: Record<string, HTMLInputElement | HTMLSelectElement> = {};
        const input = (id: string, value: string, type = "text"): HTMLInputElement => {
            const el = document.createElement("input");
            el.className = "b3-text-field fn__block";
            el.type = type;
            el.value = value;
            els[id] = el;
            return el;
        };

        const setting = new Setting({
            width: "640px",
            confirmCallback: () => {
                this.config = {
                    baseURL: els.baseURL.value.trim(),
                    apiKey: els.apiKey.value.trim(),
                    modelId: els.modelId.value.trim(),
                    api: els.api.value as AgentPluginConfig["api"],
                    contextWindow: Number(els.context.value) || DEFAULT_CONFIG.contextWindow,
                    maxTokens: Number(els.maxTokens.value) || DEFAULT_CONFIG.maxTokens,
                    confirmWrites: (els.confirm as HTMLInputElement).checked,
                };
                void this.saveData(STORAGE_CONFIG, this.config);
                showMessage("已保存,SiYuan Agent 将使用新配置", 3000);
            },
        });

        setting.addItem({
            title: "接口地址 (Base URL)",
            description: "OpenAI 兼容接口地址,一般以 /v1 结尾",
            createActionElement: () => input("baseURL", this.config.baseURL),
        });
        setting.addItem({
            title: "API Key",
            description: "模型服务密钥,明文保存在本地工作空间中",
            createActionElement: () => input("apiKey", this.config.apiKey, "password"),
        });
        setting.addItem({
            title: "模型 ID",
            description: "如 gpt-4o、glm-5.3-flash、claude-sonnet-4 等",
            createActionElement: () => input("modelId", this.config.modelId),
        });
        setting.addItem({
            title: "接口协议",
            description: "OpenAI 兼容选 openai-completions;Anthropic 选 anthropic-messages;Google 选 google-generative-ai",
            createActionElement: () => {
                const el = document.createElement("select");
                el.className = "b3-select fn__block";
                for (const api of ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]) {
                    const opt = document.createElement("option");
                    opt.value = api;
                    opt.textContent = api;
                    opt.selected = api === this.config.api;
                    el.appendChild(opt);
                }
                els.api = el;
                return el;
            },
        });
        setting.addItem({
            title: "上下文窗口 (tokens)",
            description: "模型上下文长度,仅用于本地估算",
            createActionElement: () => input("context", String(this.config.contextWindow), "number"),
        });
        setting.addItem({
            title: "最大输出 tokens",
            createActionElement: () => input("maxTokens", String(this.config.maxTokens), "number"),
        });
        setting.addItem({
            title: "写操作需要确认",
            description: "创建/更新/插入/删除笔记前弹窗确认",
            createActionElement: () => {
                const el = document.createElement("input");
                el.type = "checkbox";
                el.classList.add("b3-switch");
                el.checked = this.config.confirmWrites;
                els.confirm = el;
                return el;
            },
        });
        this.setting = setting;
        setting.open(this.name);
    }
}
