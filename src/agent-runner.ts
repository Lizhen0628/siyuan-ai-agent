/**
 * pi 智能体运行器：组装 pi 的 Agent 循环(模型、工具、系统提示词),
 * 提供发送/停止/新会话能力,并把事件透传给 UI。
 */
import {Agent} from "@mariozechner/pi-agent-core";
import type {AgentEvent, AgentMessage, AgentTool} from "@mariozechner/pi-agent-core";
import type {Api, Model} from "@mariozechner/pi-ai";
import {SiYuanClient} from "./siyuan-client";
import {WRITE_TOOLS, createSiyuanTools} from "./tools";

export interface AgentPluginConfig {
    /** OpenAI 兼容等接口的 Base URL,如 https://api.example.com/v1 */
    baseURL: string;
    apiKey: string;
    /** 模型 id,如 glm-5.3-flash */
    modelId: string;
    /** pi 协议适配器 */
    api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
    contextWindow: number;
    maxTokens: number;
    /** 写操作工具是否需要逐次确认 */
    confirmWrites: boolean;
}

export const DEFAULT_CONFIG: AgentPluginConfig = {
    baseURL: "https://api.openai.com/v1",
    apiKey: "",
    modelId: "",
    api: "openai-completions",
    contextWindow: 128000,
    maxTokens: 8192,
    confirmWrites: true,
};

export const STORAGE_CONFIG = "agent-config";
export const STORAGE_SESSION = "agent-session";

function buildModel(cfg: AgentPluginConfig): Model<Api> {
    return {
        id: cfg.modelId,
        name: cfg.modelId,
        api: cfg.api,
        provider: "siyuan-agent",
        baseUrl: cfg.baseURL.replace(/\/+$/, ""),
        reasoning: false,
        input: ["text"],
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
        contextWindow: cfg.contextWindow,
        maxTokens: cfg.maxTokens,
    };
}

const SYSTEM_PROMPT = `你是思源笔记中的智能体助手,可以借助工具对当前用户的笔记库进行检索、阅读和编辑。

工作准则:
- 涉及笔记内容的问题,先用 search_notes 检索,再 read_note 阅读,不要凭空编造笔记内容。
- 创建/修改笔记前,先用 list_notebooks 确认笔记本 id;写操作会向用户请求确认,被拒绝时不要重试,改为询问用户意图。
- 引用笔记内容时注明来源路径(hpath)。
- 回答使用简体中文,输出使用 Markdown;列表/标题层级清晰,不要输出嵌套代码块包裹的普通文本。`;

export class AgentRunner {
    private agent: Agent | null = null;
    private readonly client: SiYuanClient;
    private sessionRestored = false;

    constructor(
        private cfgProvider: () => AgentPluginConfig,
        /** 写操作确认: resolve(true) 放行,resolve(false) 拒绝。 */
        private readonly confirmWrite: (toolName: string, label: string, args: unknown) => Promise<boolean>,
        private readonly onEvent: (event: AgentEvent) => void,
        private readonly onSessionChange: () => void,
    ) {
        this.client = new SiYuanClient();
    }

    /** 是否已有(可能从磁盘恢复的)会话。 */
    get hasSession(): boolean {
        return this.agent !== null && this.agent.state.messages.length > 0;
    }

    get isStreaming(): boolean {
        return this.agent?.state.isStreaming ?? false;
    }

    get messages(): AgentMessage[] {
        if (this.agent) {
            return this.agent.state.messages;
        }
        return this.pendingRestore ?? [];
    }

    get errorMessage(): string | undefined {
        return this.agent?.state.errorMessage;
    }

    /** 创建(或按需恢复)智能体实例。 */
    private ensureAgent(): Agent {
        if (this.agent) {
            // 配置可能已变化,重建模型对象但保留会话记录
            const cfg = this.cfgProvider();
            this.agent.state.model = buildModel(cfg);
            this.agent.state.tools = this.buildTools();
            this.agent.state.systemPrompt = SYSTEM_PROMPT;
            return this.agent;
        }
        const cfg = this.cfgProvider();
        this.agent = new Agent({
            initialState: {
                systemPrompt: SYSTEM_PROMPT,
                model: buildModel(cfg),
                tools: this.buildTools(),
                messages: this.pendingRestore ?? [],
            },
            getApiKey: () => this.cfgProvider().apiKey,
            toolExecution: "sequential",
            beforeToolCall: async (ctx) => {
                const cfg = this.cfgProvider();
                if (!cfg.confirmWrites || !(WRITE_TOOLS as readonly string[]).includes(ctx.toolCall.name)) {
                    return undefined;
                }
                const tool = ctx.context.tools?.find((t) => t.name === ctx.toolCall.name);
                const allowed = await this.confirmWrite(ctx.toolCall.name, tool?.label ?? ctx.toolCall.name, ctx.args);
                if (!allowed) {
                    return {block: true, reason: "用户拒绝了本次写操作。请询问用户应如何处理,不要自动重试。"};
                }
                return undefined;
            },
        });
        this.agent.subscribe((event) => {
            this.onEvent(event);
            if (event.type === "agent_end" || event.type === "turn_end") {
                this.onSessionChange();
            }
        });
        // 恢复后清空暂存,避免重复
        this.pendingRestore = undefined;
        this.sessionRestored = true;
        return this.agent;
    }

    private pendingRestore: AgentMessage[] | undefined;

    private buildTools(): AgentTool<any>[] {
        return createSiyuanTools(this.client);
    }

    /** 从磁盘恢复的会话消息,在下一次 ensureAgent 时注入。 */
    scheduleRestore(messages: AgentMessage[]): void {
        if (this.sessionRestored || this.agent) {
            return;
        }
        this.pendingRestore = messages;
    }

    async send(text: string): Promise<void> {
        const agent = this.ensureAgent();
        await agent.prompt(text);
    }

    stop(): void {
        this.agent?.abort();
    }

    /** 开启全新会话(丢弃当前记录)。 */
    reset(): void {
        this.agent = null;
        this.pendingRestore = undefined;
        // 立即用最新配置重建,保证 UI 拿到空记录
        this.ensureAgent();
        this.onSessionChange();
    }

    serializeSession(): AgentMessage[] {
        return this.agent ? JSON.parse(JSON.stringify(this.agent.state.messages)) : [];
    }
}
