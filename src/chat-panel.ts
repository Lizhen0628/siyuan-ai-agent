/**
 * 聊天面板 UI(参考 obsidian-copilot 与思源内置智能体的侧边栏对话设计):
 * 头部(模型徽标/新会话/设置) + 消息区(气泡/悬停复制/工具卡片) + 自适应输入区。
 * 采用"整树重绘 + rAF 节流"的简单策略,会话规模下性能足够。
 */
import {showMessage} from "siyuan";
import type {AgentEvent, AgentMessage} from "@mariozechner/pi-agent-core";
import {marked} from "marked";
import type {AgentRunner} from "./agent-runner";

marked.setOptions({gfm: true, breaks: true});

const SEND_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>`;
const STOP_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
const NEW_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`;
const GEAR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
const ROBOT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></svg>`;
const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

const QUICK_PROMPTS = [
    "列出我的所有笔记本",
    "搜索笔记:LLM",
    "我的工具笔记本里有什么?",
];

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** 极简净化:去除脚本类标签与事件属性,防止模型输出直接注入 HTML。 */
function sanitizeHtml(html: string): string {
    const template = document.createElement("template");
    template.innerHTML = html;
    const dangerous = "SCRIPT,STYLE,IFRAME,OBJECT,EMBED,LINK,META,BASE,FORM";
    template.content.querySelectorAll(dangerous).forEach((el) => el.remove());
    template.content.querySelectorAll("*").forEach((el) => {
        for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();
            if (name.startsWith("on") || ((name === "href" || name === "src") && attr.value.trim().toLowerCase().startsWith("javascript:"))) {
                el.removeAttribute(attr.name);
            }
        }
    });
    return template.innerHTML;
}

function renderMarkdown(md: string): string {
    try {
        return sanitizeHtml(marked.parse(md, {async: false}) as string);
    } catch {
        return escapeHtml(md);
    }
}

function summarizeArgs(args: Record<string, any>): string {
    try {
        const parts = Object.entries(args ?? {}).map(([k, v]) => {
            const s = typeof v === "string" ? v : JSON.stringify(v);
            return `${k}: ${(s ?? "").length > 60 ? `${s.slice(0, 60)}…` : s}`;
        });
        return escapeHtml(parts.join(", "));
    } catch {
        return "";
    }
}

/** 取消息纯文本(用于复制)。 */
function plainText(msg: AgentMessage): string {
    if (typeof msg.content === "string") {
        return msg.content;
    }
    return (msg.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => (b as any).text ?? "")
        .join("\n");
}

export interface ChatPanelCallbacks {
    onSend: (text: string) => void;
    onStop: () => void;
    onNewSession: () => void;
    onOpenSettings: () => void;
    /** 当前模型信息与配置完成度,用于头部徽标与空态提示。 */
    getState: () => {modelId: string; configured: boolean};
}

export class ChatPanel {
    private readonly rootEl: HTMLElement;
    private readonly messagesEl: HTMLElement;
    private readonly modelBadgeEl: HTMLElement;
    private readonly hintEl: HTMLElement;
    private readonly inputEl: HTMLTextAreaElement;
    private readonly sendBtnEl: HTMLButtonElement;
    private renderQueued = false;
    private lastError = "";
    private readonly runner: AgentRunner;

    constructor(container: HTMLElement, runner: AgentRunner, private readonly callbacks: ChatPanelCallbacks) {
        this.runner = runner;
        container.innerHTML = `
<div class="sy-agent-root sy-chat">
    <header class="sy-chat-header">
        <span class="sy-chat-logo">${ROBOT_ICON}</span>
        <div class="sy-chat-titlegroup">
            <div class="sy-chat-title">SiYuan Agent</div>
            <div class="sy-chat-model" title="当前模型"></div>
        </div>
        <span class="fn__flex-1"></span>
        <button class="b3-button b3-button--small sy-icon-btn sy-action-new" title="开始一个全新会话">${NEW_ICON}</button>
        <button class="b3-button b3-button--small sy-icon-btn sy-action-settings" title="插件设置">${GEAR_ICON}</button>
    </header>
    <div class="sy-agent-messages"></div>
    <footer class="sy-chat-footer">
        <div class="sy-chat-inputwrap">
            <textarea class="b3-text-field sy-agent-input" rows="1"
                placeholder="给 SiYuan Agent 发送消息…"></textarea>
            <button class="sy-chat-send" title="发送 (Enter)"></button>
        </div>
        <div class="sy-chat-hint">Enter 发送 · Shift+Enter 换行</div>
    </footer>
</div>`;
        this.rootEl = container.querySelector(".sy-chat")!;
        this.messagesEl = container.querySelector(".sy-agent-messages")!;
        this.modelBadgeEl = container.querySelector(".sy-chat-model")!;
        this.hintEl = container.querySelector(".sy-chat-hint")!;
        this.inputEl = container.querySelector(".sy-agent-input")!;
        this.sendBtnEl = container.querySelector(".sy-chat-send")!;

        container.querySelector(".sy-action-new")!.addEventListener("click", () => {
            this.lastError = "";
            callbacks.onNewSession();
        });
        container.querySelector(".sy-action-settings")!.addEventListener("click", () => callbacks.onOpenSettings());
        this.sendBtnEl.addEventListener("click", () => this.primaryAction());
        this.inputEl.addEventListener("input", () => this.autoResize());
        this.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                this.primaryAction();
            }
        });
        this.render();
    }

    destroy(): void {
        this.rootEl.remove();
    }

    focusInput(): void {
        this.inputEl.focus();
    }

    private autoResize(): void {
        this.inputEl.style.height = "auto";
        this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 140)}px`;
        if (!this.runner.isStreaming) {
            this.sendBtnEl.disabled = !this.inputEl.value.trim();
        }
    }

    private primaryAction(): void {
        if (this.runner.isStreaming) {
            this.callbacks.onStop();
            return;
        }
        const value = this.inputEl.value.trim();
        if (!value) {
            return;
        }
        this.lastError = "";
        this.inputEl.value = "";
        this.autoResize();
        this.callbacks.onSend(value);
    }

    /** 由插件转发的 pi 事件入口。 */
    handleEvent(event: AgentEvent): void {
        if (event.type === "agent_end") {
            const err = this.runner.errorMessage;
            if (err) {
                this.lastError = err;
            }
        }
        this.requestRender();
    }

    requestRender(): void {
        if (this.renderQueued || !this.rootEl.isConnected) {
            return;
        }
        this.renderQueued = true;
        requestAnimationFrame(() => {
            this.renderQueued = false;
            if (this.rootEl.isConnected) {
                this.render();
            }
        });
    }

    private actionRow(text: string, alignRight: boolean): HTMLElement {
        const row = document.createElement("div");
        row.className = `sy-msg-actions${alignRight ? " right" : ""}`;
        const btn = document.createElement("button");
        btn.className = "sy-msg-action";
        btn.title = "复制";
        btn.innerHTML = COPY_ICON;
        btn.addEventListener("click", () => {
            navigator.clipboard?.writeText(text).then(
                () => showMessage("已复制", 1500),
                () => showMessage("复制失败", 1500, "error"),
            );
        });
        row.appendChild(btn);
        return row;
    }

    private messageNode(msg: AgentMessage): HTMLElement {
        const wrap = document.createElement("div");
        if (msg.role === "user") {
            wrap.className = "sy-agent-msg user";
            const bubble = document.createElement("div");
            bubble.className = "bubble";
            bubble.innerHTML = renderMarkdown(plainText(msg));
            const group = document.createElement("div");
            group.className = "sy-msg-group";
            group.append(bubble, this.actionRow(plainText(msg), true));
            wrap.appendChild(group);
            return wrap;
        }
        if (msg.role === "assistant") {
            wrap.className = "sy-agent-msg assistant";
            const bubble = document.createElement("div");
            bubble.className = "bubble";
            let html = "";
            for (const block of msg.content ?? []) {
                if (block.type === "text" && block.text) {
                    html += renderMarkdown(block.text);
                } else if (block.type === "thinking") {
                    html += `<details class="sy-agent-thinking"><summary>思考过程</summary><div>${escapeHtml((block as any).thinking ?? "")}</div></details>`;
                } else if (block.type === "toolCall") {
                    const call = block as any;
                    html += `<div class="sy-agent-tool-call">🔧 调用工具 <b>${escapeHtml(call.name)}</b>(${summarizeArgs(call.arguments)})</div>`;
                }
            }
            bubble.innerHTML = html;
            const group = document.createElement("div");
            group.className = "sy-msg-group";
            group.append(bubble, this.actionRow(plainText(msg), false));
            wrap.appendChild(group);
            return wrap;
        }
        // toolResult
        wrap.className = "sy-agent-msg tool";
        const result = msg as any;
        const detail = document.createElement("details");
        detail.className = `sy-agent-tool-result${result.isError ? " error" : ""}`;
        const textOut = (result.content ?? [])
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n");
        detail.innerHTML =
            `<summary>${result.isError ? "⚠️" : "✅"} 工具结果: ${escapeHtml(result.toolName ?? "")}</summary>` +
            `<pre>${escapeHtml(textOut.slice(0, 2000))}</pre>`;
        wrap.appendChild(detail);
        return wrap;
    }

    private emptyNode(configured: boolean): HTMLElement {
        const empty = document.createElement("div");
        empty.className = "sy-agent-empty";
        const logo = document.createElement("div");
        logo.className = "sy-agent-empty-logo";
        logo.innerHTML = ROBOT_ICON;
        const title = document.createElement("div");
        title.className = "sy-agent-empty-title";
        title.textContent = "你好,我是 SiYuan Agent";
        const sub = document.createElement("div");
        sub.className = "sy-agent-empty-sub";
        sub.textContent = configured
            ? "可以检索、阅读和编辑你的笔记库,试试下面的快捷提问:"
            : "尚未配置模型服务,请先点击右上角设置完成配置。";
        empty.append(logo, title, sub);
        if (configured) {
            const chips = document.createElement("div");
            chips.className = "sy-agent-empty-chips";
            for (const prompt of QUICK_PROMPTS) {
                const chip = document.createElement("button");
                chip.className = "sy-agent-chip";
                chip.textContent = prompt;
                chip.addEventListener("click", () => {
                    this.inputEl.value = prompt;
                    this.autoResize();
                    this.focusInput();
                });
                chips.appendChild(chip);
            }
            empty.appendChild(chips);
        }
        return empty;
    }

    private render(): void {
        const streaming = this.runner.isStreaming;
        const {modelId, configured} = this.callbacks.getState();

        this.sendBtnEl.innerHTML = streaming ? STOP_ICON : SEND_ICON;
        this.sendBtnEl.classList.toggle("stopping", streaming);
        this.sendBtnEl.disabled = !streaming && !this.inputEl.value.trim();
        this.modelBadgeEl.textContent = modelId || "未配置模型";
        this.modelBadgeEl.classList.toggle("unconfigured", !configured);
        this.hintEl.textContent = streaming ? "生成中…点击右侧按钮停止" : "Enter 发送 · Shift+Enter 换行";

        const messages = this.runner.messages;
        const frag = document.createDocumentFragment();
        if (messages.length === 0) {
            frag.appendChild(this.emptyNode(configured));
        } else {
            for (const msg of messages) {
                frag.appendChild(this.messageNode(msg));
            }
            if (streaming) {
                const waiting = document.createElement("div");
                waiting.className = "sy-agent-msg assistant";
                waiting.innerHTML = `<div class="bubble sy-agent-waiting"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
                frag.appendChild(waiting);
            }
        }
        this.messagesEl.replaceChildren(frag);

        // 滚动到底部(用户未主动上滚时)
        const nearBottom =
            this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight < 80;
        if (nearBottom || streaming) {
            this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        }

        // 错误横幅
        const bannerId = "sy-agent-error-banner";
        document.getElementById(bannerId)?.remove();
        if (this.lastError && !streaming) {
            const banner = document.createElement("div");
            banner.id = bannerId;
            banner.className = "sy-agent-error";
            banner.textContent = `上次运行失败: ${this.lastError}`;
            this.messagesEl.parentElement?.insertBefore(banner, this.messagesEl);
        }
    }
}
