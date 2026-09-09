/**
 * 聊天面板 UI:渲染会话记录、流式输出、工具调用状态与输入框。
 * 采用"整树重绘 + rAF 节流"的简单策略,会话规模下性能足够。
 */
import type {AgentEvent, AgentMessage} from "@mariozechner/pi-agent-core";
import {marked} from "marked";
import type {AgentRunner} from "./agent-runner";

marked.setOptions({gfm: true, breaks: true});

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

export interface ChatPanelCallbacks {
    onSend: (text: string) => void;
    onStop: () => void;
    onNewSession: () => void;
}

export class ChatPanel {
    private readonly messagesEl: HTMLElement;
    private readonly statusEl: HTMLElement;
    private readonly inputEl: HTMLTextAreaElement;
    private readonly sendBtnEl: HTMLButtonElement;
    private renderQueued = false;
    private lastError = "";
    private readonly runner: AgentRunner;

    constructor(container: HTMLElement, runner: AgentRunner, callbacks: ChatPanelCallbacks) {
        this.runner = runner;
        container.innerHTML = `
<div class="sy-agent-toolbar">
    <button class="b3-button b3-button--small sy-agent-new" title="开始一个全新会话">新会话</button>
    <span class="sy-agent-status"></span>
</div>
<div class="sy-agent-messages"></div>
<div class="sy-agent-input-row">
    <textarea class="b3-text-field sy-agent-input" rows="2"
        placeholder="输入消息,Enter 发送,Shift+Enter 换行"></textarea>
    <button class="b3-button sy-agent-send">发送</button>
</div>`;
        this.messagesEl = container.querySelector(".sy-agent-messages")!;
        this.statusEl = container.querySelector(".sy-agent-status")!;
        this.inputEl = container.querySelector(".sy-agent-input")!;
        this.sendBtnEl = container.querySelector(".sy-agent-send")!;

        container.querySelector(".sy-agent-new")!.addEventListener("click", () => {
            this.lastError = "";
            callbacks.onNewSession();
        });
        this.sendBtnEl.addEventListener("click", () => this.primaryAction(callbacks));
        this.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                this.primaryAction(callbacks);
            }
        });
        this.render();
        this.inputEl.focus();
    }

    private primaryAction(callbacks: ChatPanelCallbacks): void {
        if (this.runner.isStreaming) {
            callbacks.onStop();
            return;
        }
        const value = this.inputEl.value.trim();
        if (!value) {
            return;
        }
        this.lastError = "";
        this.inputEl.value = "";
        callbacks.onSend(value);
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
        if (this.renderQueued) {
            return;
        }
        this.renderQueued = true;
        requestAnimationFrame(() => {
            this.renderQueued = false;
            this.render();
        });
    }

    private messageNode(msg: AgentMessage): HTMLElement {
        const wrap = document.createElement("div");
        if (msg.role === "user") {
            wrap.className = "sy-agent-msg user";
            const bubble = document.createElement("div");
            bubble.className = "bubble";
            const content = typeof msg.content === "string" ? msg.content
                : msg.content.filter((b) => b.type === "text").map((b) => (b as any).text).join("\n");
            bubble.innerHTML = renderMarkdown(content || "");
            wrap.appendChild(bubble);
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
            wrap.appendChild(bubble);
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

    private render(): void {
        const streaming = this.runner.isStreaming;
        this.sendBtnEl.textContent = streaming ? "停止" : "发送";
        this.sendBtnEl.classList.toggle("b3-button--outline", streaming);
        this.statusEl.textContent = streaming ? "运行中…" : "";

        const frag = document.createDocumentFragment();
        for (const msg of this.runner.messages) {
            frag.appendChild(this.messageNode(msg));
        }
        if (streaming && this.runner.messages.length === 0) {
            const waiting = document.createElement("div");
            waiting.className = "sy-agent-msg assistant";
            waiting.innerHTML = `<div class="bubble sy-agent-waiting">思考中…</div>`;
            frag.appendChild(waiting);
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
