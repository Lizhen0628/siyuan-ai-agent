/**
 * 聊天面板 UI —— 对齐思源原生智能体(agent-chat)的视觉与结构:
 * - 头部:原生 block__icons 行(block__logo 标题 + block__icon 按钮 + ariaLabel 悬浮提示)
 * - 消息:用户气泡(右侧 surface 底) + AI 无气泡全文;悬停显示 block__icon 操作
 * - 工具调用/结果:描边卡片(头部 + 参数详情)
 * - 输入区:带边框圆角盒 + 按钮行(模型徽标 + 发送/停止),与原生输入区一致
 * 渲染策略:整树重绘 + rAF 节流,会话规模下性能足够。
 */
import {showMessage} from "siyuan";
import type {AgentEvent, AgentMessage} from "@mariozechner/pi-agent-core";
import type {ImageContent} from "@mariozechner/pi-ai";
import {marked} from "marked";
import type {AgentRunner, AgentThinkingLevel} from "./agent-runner";

marked.setOptions({gfm: true, breaks: true});

/** 引用思源原生图标 sprite。 */
const icon = (id: string, cls?: string): string =>
    `<svg${cls ? ` class="${cls}"` : ""}><use xlink:href="#${id}"/></svg>`;
/** 原生图标库没有扳手,工具调用图标保留自定义线性 SVG。 */
const TOOL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>`;

const QUICK_PROMPTS = [
    "列出我的所有笔记本",
    "搜索笔记:LLM",
    "我的工具笔记本里有什么?",
];

/** 紧凑数字:1234 → 1.2k,56000 → 5.6万。 */
function compactNum(n: number): string {
    if (n >= 10000) {
        return `${(n / 10000).toFixed(1).replace(/\.0$/, "")}万`;
    }
    if (n >= 1000) {
        return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    }
    return String(n);
}

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
/** assistant 消息的纯文本总长度(打字机进度基准,含思考内容)。 */
function assistantTextLength(msg: AgentMessage): number {
    let len = 0;
    for (const block of (msg as any).content ?? []) {
        if (block.type === "text" && block.text) {
            len += block.text.length;
        } else if (block.type === "thinking" && block.thinking) {
            len += block.thinking.length;
        }
    }
    return len;
}

/** 文件 → 待发送图片:小图直接用原格式;大图 canvas 缩放至长边 1568 并转 jpeg。 */
async function fileToPendingImage(file: File): Promise<PendingImage> {
    const direct = file.size <= 2 * 1024 * 1024;
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
    if (direct) {
        return {data: dataUrl.split(",")[1] ?? "", mimeType: file.type, preview: dataUrl, name: file.name};
    }
    // 压缩
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1568 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const out = canvas.toDataURL("image/jpeg", 0.85);
    return {data: out.split(",")[1] ?? "", mimeType: "image/jpeg", preview: out, name: file.name};
}

function plainText(msg: AgentMessage): string {
    if (typeof msg.content === "string") {
        return msg.content;
    }
    return (msg.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => (b as any).text ?? "")
        .join("\n");
}

/** 待发送的图片附件。 */
interface PendingImage {
    data: string;      // base64(无前缀)
    mimeType: string;
    preview: string;   // data URL,用于缩略图
    name: string;
}

/** 思考等级的中文标签。 */
const THINKING_LABELS: Record<string, string> = {
    off: "关",
    minimal: "最小",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
    max: "最大",
};

export interface ChatPanelCallbacks {
    onSend: (text: string, images?: ImageContent[]) => void;
    onStop: () => void;
    onNewSession: () => void;
    onOpenSettings: () => void;
    /** 切换当前模型。 */
    onSwitchModel: (id: string) => void;
    /** 设置思考等级。 */
    onSetThinking: (level: AgentThinkingLevel) => void;
    /** 历史会话列表(按更新时间倒序)。 */
    listSessions: () => {id: string; title: string; updatedAt: number}[];
    /** 恢复某个历史会话。 */
    onOpenSession: (id: string) => void;
    /** 删除某个历史会话(不会是当前会话)。 */
    onDeleteSession: (id: string) => void;
    /** 输入 / 时唤起的已启用技能列表。 */
    listSkills: () => {id: string; name: string; description: string}[];
    /** 当前模型/思考/图片能力与配置完成度。 */
    getState: () => {
        modelId: string;
        configured: boolean;
        sessionId: string;
        models: {id: string; label: string; active: boolean}[];
        thinking: {level: AgentThinkingLevel; reasoning: boolean; levels: AgentThinkingLevel[]};
        supportsImage: boolean;
    };
}

export class ChatPanel {
    private readonly rootEl: HTMLElement;
    private readonly messagesEl: HTMLElement;
    private readonly modelBtnEl: HTMLElement;
    private readonly modelLabelEl: HTMLElement;
    private readonly statsEl: HTMLElement;
    private readonly inputEl: HTMLTextAreaElement;
    private readonly sendBtnEl: HTMLButtonElement;
    private readonly stopBtnEl: HTMLButtonElement;
    private readonly scrollBottomEl: HTMLElement;
    private readonly thinkingBtnEl: HTMLElement;
    private readonly thinkingLabelEl: HTMLElement;
    private readonly attachBtnEl: HTMLButtonElement;
    private readonly attachRowEl: HTMLElement;
    private readonly fileInputEl: HTMLInputElement;
    private readonly historyEl: HTMLElement;
    private readonly historyListEl: HTMLElement;
    private readonly skillPopEl: HTMLElement;
    private readonly skillChipEl: HTMLElement;
    /** / 技能弹层的当前匹配与选中项。 */
    private skillMatches: {id: string; name: string; description: string}[] = [];
    private skillPopIndex = 0;
    /** 当前挂载的技能胶囊(发送时转为 /技能id 前缀)。 */
    private activeSkill: {id: string; name: string; description: string} | null = null;
    private attachments: PendingImage[] = [];
    private renderQueued = false;
    private lastError = "";
    /** 打字机:当前正在揭示的 assistant 消息与已揭示字符数。 */
    private revealMsg: AgentMessage | null = null;
    private revealCount = 0;
    private revealTimer: number | null = null;
    private typingActive = false;
    private readonly runner: AgentRunner;

    constructor(container: HTMLElement, runner: AgentRunner, private readonly callbacks: ChatPanelCallbacks) {
        this.runner = runner;
        container.innerHTML = `
<div class="sy-agent-root sy-chat">
    <div class="block__icons fn__hidescrollbar sy-chat-header">
        <div class="block__logo fn__flex-1 sy-chat-title">SiYuan Agent</div>
        <span class="block__icon block__icon--show ariaLabel sy-action-history" data-position="north" aria-label="对话历史">${icon("iconHistory")}</span>
        <span class="block__icon block__icon--show ariaLabel sy-action-new" data-position="north" aria-label="新会话">${icon("iconAdd")}</span>
        <span class="fn__space"></span>
        <span class="block__icon block__icon--show ariaLabel sy-action-settings" data-position="north" aria-label="设置">${icon("iconSettings")}</span>
    </div>
    <div class="sy-agent-messages-wrap">
        <div class="sy-agent-messages"></div>
        <span class="sy-chat-scroll-bottom ariaLabel fn__none" data-position="west" aria-label="回到底部">${icon("iconArrowDown")}</span>
    </div>
    <div class="sy-chat-input-area">
        <div class="sy-chat-attach-strip fn__none"></div>
        <div class="sy-chat-skill-chip fn__none"></div>
        <textarea class="sy-agent-input" rows="1" placeholder="输入消息，/技能…"></textarea>
        <div class="sy-chat-skill-pop fn__none"></div>
        <div class="sy-chat-buttons">
            <button class="b3-button b3-button--icon b3-button--text sy-chat-attach ariaLabel" aria-label="插入图片" data-position="n" type="button">${icon("iconImage")}</button>
            <button class="b3-select b3-select--noborder sy-chat-combo sy-chat-thinking ariaLabel" data-position="n" type="button">${icon("iconBrain", "sy-chat-model-icon")}<span class="sy-chat-thinking-label"></span></button>
            <button class="b3-select b3-select--noborder sy-chat-combo sy-chat-model ariaLabel" data-position="n" type="button">${icon("iconAtom", "sy-chat-model-icon")}<span class="sy-chat-model-label"></span></button>
            <span class="fn__flex-1"></span>
            <span class="sy-chat-stats ariaLabel fn__none" data-position="north"></span>
            <button class="b3-button b3-button--icon b3-button--text sy-chat-send ariaLabel" aria-label="发送 (Enter)" type="button">${icon("iconSend")}</button>
            <button class="b3-button b3-button--icon b3-button--cancel sy-chat-stop fn__none ariaLabel" aria-label="停止" type="button">${icon("iconSquareStop")}</button>
        </div>
    </div>
    <input type="file" accept="image/*" multiple class="sy-chat-file fn__none" />
    <div class="sy-chat-history fn__none">
        <div class="fn__flex sy-chat-history-head">
            <span class="fn__flex-1 sy-chat-history-title">对话历史</span>
            <span class="block__icon block__icon--show ariaLabel sy-history-close" data-position="west" aria-label="关闭">${icon("iconClose")}</span>
        </div>
        <div class="sy-chat-history-list"></div>
    </div>
</div>`;
        this.rootEl = container.querySelector(".sy-chat")!;
        this.messagesEl = container.querySelector(".sy-agent-messages")!;
        this.modelBtnEl = container.querySelector(".sy-chat-model")!;
        this.modelLabelEl = container.querySelector(".sy-chat-model-label")!;
        this.statsEl = container.querySelector(".sy-chat-stats")!;
        this.inputEl = container.querySelector(".sy-agent-input")!;
        this.sendBtnEl = container.querySelector(".sy-chat-send")!;
        this.stopBtnEl = container.querySelector(".sy-chat-stop")!;
        this.scrollBottomEl = container.querySelector(".sy-chat-scroll-bottom")!;
        this.thinkingBtnEl = container.querySelector(".sy-chat-thinking")!;
        this.thinkingLabelEl = container.querySelector(".sy-chat-thinking-label")!;
        this.attachBtnEl = container.querySelector(".sy-chat-attach")!;
        this.attachRowEl = container.querySelector(".sy-chat-attach-strip")!;
        this.fileInputEl = container.querySelector(".sy-chat-file")!;
        this.historyEl = container.querySelector(".sy-chat-history")!;
        this.historyListEl = container.querySelector(".sy-chat-history-list")!;
        this.skillPopEl = container.querySelector(".sy-chat-skill-pop")!;
        this.skillChipEl = container.querySelector(".sy-chat-skill-chip")!;

        container.querySelector(".sy-action-history")!.addEventListener("click", () => this.toggleHistory());
        container.querySelector(".sy-history-close")!.addEventListener("click", () => this.closeHistory());

        container.querySelector(".sy-action-new")!.addEventListener("click", () => {
            this.lastError = "";
            this.setActiveSkill(null);
            callbacks.onNewSession();
        });
        container.querySelector(".sy-action-settings")!.addEventListener("click", () => callbacks.onOpenSettings());
        this.modelBtnEl.addEventListener("click", () => {
            if (this.callbacks.getState().models.length === 0) {
                callbacks.onOpenSettings();
                return;
            }
            this.toggleModelMenu();
        });
        this.thinkingBtnEl.addEventListener("click", () => this.toggleThinkingMenu());
        this.attachBtnEl.addEventListener("click", () => {
            if (!this.callbacks.getState().supportsImage) {
                showMessage("当前模型不支持图片输入,请切换支持图片的模型", 3000, "error");
                return;
            }
            this.fileInputEl.click();
        });
        this.fileInputEl.addEventListener("change", () => {
            const files = Array.from(this.fileInputEl.files ?? []);
            this.fileInputEl.value = "";
            void this.addImageFiles(files);
        });
        // 粘贴剪贴板图片
        this.inputEl.addEventListener("paste", (e) => {
            const files = Array.from(e.clipboardData?.items ?? [])
                .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
                .map((it) => it.getAsFile())
                .filter((f): f is File => Boolean(f));
            if (files.length > 0) {
                e.preventDefault();
                if (!this.callbacks.getState().supportsImage) {
                    showMessage("当前模型不支持图片输入", 3000, "error");
                    return;
                }
                void this.addImageFiles(files);
            }
        });
        this.sendBtnEl.addEventListener("click", () => this.primaryAction());
        this.stopBtnEl.addEventListener("click", () => callbacks.onStop());
        this.scrollBottomEl.addEventListener("click", () => {
            this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
            this.updateScrollBottom();
        });
        this.messagesEl.addEventListener("scroll", () => this.updateScrollBottom());
        this.inputEl.addEventListener("input", () => {
            this.autoResize();
            this.updateSkillPop();
        });
        this.inputEl.addEventListener("keydown", (e) => {
            // 技能弹层打开时优先响应导航键
            if (!this.skillPopEl.classList.contains("fn__none")) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    const delta = e.key === "ArrowDown" ? 1 : -1;
                    this.skillPopIndex = (this.skillPopIndex + delta + this.skillMatches.length) % this.skillMatches.length;
                    this.renderSkillPop();
                    return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    this.pickSkill(this.skillMatches[this.skillPopIndex]);
                    return;
                }
                if (e.key === "Escape") {
                    e.preventDefault();
                    this.closeSkillPop();
                    return;
                }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                this.primaryAction();
            }
        });
        this.render();
    }

    destroy(): void {
        this.stopReveal();
        this.closeModelMenu();
        this.closeThinkingMenu();
        this.rootEl.remove();
    }

    /** 切换历史会话面板。 */
    private toggleHistory(): void {
        if (this.historyEl.classList.contains("fn__none")) {
            this.renderHistory();
            this.historyEl.classList.remove("fn__none");
        } else {
            this.closeHistory();
        }
    }

    closeHistory(): void {
        this.historyEl.classList.add("fn__none");
    }

    /** 输入 / 开头的指令时展示已启用技能列表(参考原生智能体)。支持在任意位置输入 / 唤起。 */
    private updateSkillPop(): void {
        const pos = this.inputEl.selectionStart ?? this.inputEl.value.length;
        const upto = this.inputEl.value.slice(0, pos);
        const m = /(?:^|\s)\/([^\s/]*)$/.exec(upto);
        if (!m) {
            this.closeSkillPop();
            return;
        }
        const q = m[1].toLowerCase();
        const skills = this.callbacks.listSkills().filter((s) =>
            !q || s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
        if (skills.length === 0) {
            this.closeSkillPop();
            return;
        }
        this.skillMatches = skills;
        this.skillPopIndex = 0;
        this.renderSkillPop();
        this.skillPopEl.classList.remove("fn__none");
    }

    private renderSkillPop(): void {
        this.skillPopEl.textContent = "";
        this.skillMatches.forEach((s, i) => {
            const item = document.createElement("div");
            item.className = "sy-chat-skill-item" + (i === this.skillPopIndex ? " sy-chat-skill-item--active" : "");
            item.innerHTML =
                `<div class="sy-chat-skill-name">/${escapeHtml(s.id)}<span class="sy-chat-skill-cn">${escapeHtml(s.name)}</span></div>` +
                (s.description ? `<div class="sy-chat-skill-desc">${escapeHtml(s.description)}</div>` : "");
            item.addEventListener("mousedown", (e) => {
                e.preventDefault();
                this.pickSkill(s);
            });
            this.skillPopEl.append(item);
        });
    }

    /** 选中技能:移除输入框中的 /触发词,挂载技能胶囊(原生做法)。 */
    private pickSkill(skill: {id: string; name: string; description: string} | undefined): void {
        if (!skill) {
            return;
        }
        const pos = this.inputEl.selectionStart ?? this.inputEl.value.length;
        const upto = this.inputEl.value.slice(0, pos);
        const m = /(?:^|\s)\/[^\s/]*$/.exec(upto);
        if (m) {
            const tokenStart = pos - m[0].length + (m[0].startsWith("/") ? 0 : 1);
            this.inputEl.value = this.inputEl.value.slice(0, tokenStart) + this.inputEl.value.slice(pos);
        }
        this.setActiveSkill(skill);
        this.closeSkillPop();
        this.autoResize();
        this.inputEl.focus();
    }

    /** 挂载/移除技能胶囊。 */
    private setActiveSkill(skill: {id: string; name: string; description: string} | null): void {
        this.activeSkill = skill;
        this.skillChipEl.classList.toggle("fn__none", !skill);
        this.skillChipEl.textContent = "";
        if (skill) {
            const iconEl = document.createElement("span");
            iconEl.className = "sy-chat-skill-chip-icon";
            iconEl.innerHTML = icon("iconPlugin");
            const name = document.createElement("span");
            name.textContent = skill.name;
            const del = document.createElement("span");
            del.className = "sy-chat-skill-chip-del ariaLabel";
            del.setAttribute("aria-label", "移除技能");
            del.setAttribute("data-position", "north");
            del.innerHTML = icon("iconClose");
            del.addEventListener("click", () => this.setActiveSkill(null));
            this.skillChipEl.append(iconEl, name, del);
        }
        // 只刷新发送按钮可用态,避免整树重绘
        this.sendBtnEl.disabled = !this.runner.isStreaming && !this.inputEl.value.trim()
            && this.attachments.length === 0 && !this.activeSkill;
    }

    private closeSkillPop(): void {
        this.skillPopEl.classList.add("fn__none");
        this.skillMatches = [];
    }

    /** 渲染历史会话列表(点击恢复,非当前会话可删除)。 */
    private renderHistory(): void {
        const sessions = this.callbacks.listSessions();
        const currentId = this.callbacks.getState().sessionId;
        this.historyListEl.textContent = "";
        if (sessions.length === 0) {
            this.historyListEl.insertAdjacentHTML("beforeend",
                `<div class="b3-label__text sy-chat-history-empty">暂无历史对话</div>`);
            return;
        }
        for (const s of sessions) {
            const item = document.createElement("div");
            item.className = "sy-chat-history-item" + (s.id === currentId ? " sy-chat-history-item--active" : "");
            const time = new Date(s.updatedAt);
            const timeText = `${time.getMonth() + 1}-${time.getDate()} ${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
            item.innerHTML =
                `<div class="fn__flex-1 sy-chat-history-item-main">` +
                `<div class="sy-chat-history-item-title">${escapeHtml(s.title)}</div>` +
                `<div class="sy-chat-history-item-time">${timeText}</div></div>` +
                (s.id === currentId
                    ? ""
                    : `<span class="block__icon block__icon--show ariaLabel sy-history-del" data-position="west" aria-label="删除">${icon("iconTrashcan")}</span>`);
            item.addEventListener("click", () => {
                if (s.id !== currentId) {
                    this.callbacks.onOpenSession(s.id);
                }
            });
            item.querySelector(".sy-history-del")?.addEventListener("click", (e) => {
                e.stopPropagation();
                this.callbacks.onDeleteSession(s.id);
                this.renderHistory();
            });
            this.historyListEl.append(item);
        }
    }

    focusInput(): void {
        this.inputEl.focus();
    }

    private autoResize(): void {
        this.inputEl.style.height = "auto";
        this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 120)}px`;
        if (!this.runner.isStreaming) {
            this.sendBtnEl.disabled = !this.inputEl.value.trim() && this.attachments.length === 0 && !this.activeSkill;
        }
    }

    /** 读入图片文件:超过 2MB 或长边超 1568px 时先压缩再转 base64。 */
    private async addImageFiles(files: File[]): Promise<void> {
        for (const file of files) {
            if (!file.type.startsWith("image/")) {
                continue;
            }
            if (file.size > 10 * 1024 * 1024) {
                showMessage(`图片 ${file.name} 超过 10MB,已跳过`, 3000, "error");
                continue;
            }
            try {
                this.attachments.push(await fileToPendingImage(file));
            } catch {
                showMessage(`读取图片 ${file.name} 失败`, 3000, "error");
            }
        }
        this.renderAttachStrip();
        this.autoResize();
    }

    private removeAttachment(index: number): void {
        this.attachments.splice(index, 1);
        this.renderAttachStrip();
        this.autoResize();
    }

    /** 附件缩略图条(输入区上方),非整树重绘区,手动刷新。 */
    private renderAttachStrip(): void {
        this.attachRowEl.classList.toggle("fn__none", this.attachments.length === 0);
        this.attachRowEl.textContent = "";
        this.attachments.forEach((img, i) => {
            const item = document.createElement("div");
            item.className = "sy-chat-attach-item ariaLabel";
            item.setAttribute("aria-label", img.name);
            item.setAttribute("data-position", "north");
            const thumb = document.createElement("img");
            thumb.src = img.preview;
            thumb.alt = img.name;
            const del = document.createElement("span");
            del.className = "sy-chat-attach-del";
            del.innerHTML = icon("iconClose");
            del.addEventListener("click", () => this.removeAttachment(i));
            item.append(thumb, del);
            this.attachRowEl.appendChild(item);
        });
    }

    private clearAttachments(): void {
        this.attachments = [];
        this.renderAttachStrip();
    }

    private primaryAction(): void {
        if (this.runner.isStreaming) {
            return;
        }
        const value = this.inputEl.value.trim();
        const images: ImageContent[] = this.attachments.map((a) => ({
            type: "image",
            data: a.data,
            mimeType: a.mimeType,
        }));
        if (!value && images.length === 0 && !this.activeSkill) {
            return;
        }
        // 技能胶囊转为 /技能id 前缀,模型按系统提示词中的技能正文执行
        const text = this.activeSkill ? `/${this.activeSkill.id}${value ? " " + value : ""}` : value;
        this.lastError = "";
        this.inputEl.value = "";
        this.setActiveSkill(null);
        this.clearAttachments();
        this.closeSkillPop();
        this.autoResize();
        this.callbacks.onSend(text, images);
    }

    /** 思考等级菜单(与模型菜单同一浮层样式)。 */
    private thinkingMenu: HTMLElement | null = null;

    private toggleThinkingMenu(): void {
        if (this.thinkingMenu) {
            this.closeThinkingMenu();
            return;
        }
        const {thinking} = this.callbacks.getState();
        const pop = document.createElement("div");
        pop.className = "sy-agent-combo-pop sy-agent-model-menu";
        if (!thinking.reasoning) {
            const note = document.createElement("div");
            note.className = "sy-agent-combo-empty";
            note.textContent = "当前模型未标记支持思考,设置可能不会生效";
            pop.appendChild(note);
        }
        for (const lv of thinking.levels) {
            const item = document.createElement("div");
            item.className = "sy-agent-combo-item";
            const label = document.createElement("span");
            label.className = "sy-agent-combo-id";
            label.textContent = THINKING_LABELS[lv] ?? lv;
            item.appendChild(label);
            const note = document.createElement("span");
            note.className = "sy-agent-combo-note";
            note.textContent = lv;
            item.appendChild(note);
            if (lv === thinking.level) {
                const check = document.createElement("span");
                check.className = "sy-agent-combo-check";
                check.innerHTML = icon("iconSelect");
                item.appendChild(check);
            }
            item.addEventListener("click", () => {
                this.closeThinkingMenu();
                this.callbacks.onSetThinking(lv);
            });
            pop.appendChild(item);
        }
        document.body.append(pop);
        const rect = this.thinkingBtnEl.getBoundingClientRect();
        pop.style.left = `${rect.left}px`;
        pop.style.bottom = `${window.innerHeight - rect.top + 4}px`;
        pop.style.minWidth = `${Math.max(rect.width, 140)}px`;
        pop.style.maxWidth = "240px";
        this.thinkingMenu = pop;
        window.addEventListener("mousedown", this.onThinkingDocMouseDown, true);
        window.addEventListener("resize", this.closeThinkingMenu);
        window.addEventListener("scroll", this.onThinkingScroll, true);
    }

    private closeThinkingMenu = (): void => {
        if (!this.thinkingMenu) {
            return;
        }
        this.thinkingMenu.remove();
        this.thinkingMenu = null;
        window.removeEventListener("mousedown", this.onThinkingDocMouseDown, true);
        window.removeEventListener("resize", this.closeThinkingMenu);
        window.removeEventListener("scroll", this.onThinkingScroll, true);
    };

    private onThinkingScroll = (e: Event): void => {
        if (this.thinkingMenu && e.target instanceof Node && this.thinkingMenu.contains(e.target)) {
            return;
        }
        this.closeThinkingMenu();
    };

    private onThinkingDocMouseDown = (e: MouseEvent): void => {
        if (this.thinkingMenu?.contains(e.target as Node) || this.thinkingBtnEl.contains(e.target as Node)) {
            return;
        }
        this.closeThinkingMenu();
    };

    /** 模型切换菜单(原生 model-picker 行为:浮出已启用模型列表)。 */
    private modelMenu: HTMLElement | null = null;

    private toggleModelMenu(): void {
        if (this.modelMenu) {
            this.closeModelMenu();
            return;
        }
        const {models} = this.callbacks.getState();
        const pop = document.createElement("div");
        pop.className = "sy-agent-combo-pop sy-agent-model-menu";
        for (const m of models) {
            const item = document.createElement("div");
            item.className = "sy-agent-combo-item";
            const label = document.createElement("span");
            label.className = "sy-agent-combo-id";
            label.textContent = m.label;
            item.appendChild(label);
            if (m.label !== m.id) {
                const note = document.createElement("span");
                note.className = "sy-agent-combo-note";
                note.textContent = m.id;
                item.appendChild(note);
            }
            if (m.active) {
                const check = document.createElement("span");
                check.className = "sy-agent-combo-check";
                check.innerHTML = icon("iconSelect");
                item.appendChild(check);
            }
            item.addEventListener("click", () => {
                this.closeModelMenu();
                this.callbacks.onSwitchModel(m.id);
            });
            pop.appendChild(item);
        }
        document.body.append(pop);
        const rect = this.modelBtnEl.getBoundingClientRect();
        pop.style.left = `${rect.left}px`;
        pop.style.bottom = `${window.innerHeight - rect.top + 4}px`;
        pop.style.minWidth = `${Math.max(rect.width, 180)}px`;
        pop.style.maxWidth = "300px";
        this.modelMenu = pop;
        window.addEventListener("mousedown", this.onMenuDocMouseDown, true);
        window.addEventListener("resize", this.closeModelMenu);
        window.addEventListener("scroll", this.onMenuScroll, true);
    }

    private closeModelMenu = (): void => {
        if (!this.modelMenu) {
            return;
        }
        this.modelMenu.remove();
        this.modelMenu = null;
        window.removeEventListener("mousedown", this.onMenuDocMouseDown, true);
        window.removeEventListener("resize", this.closeModelMenu);
        window.removeEventListener("scroll", this.onMenuScroll, true);
    };

    private onMenuScroll = (e: Event): void => {
        if (this.modelMenu && e.target instanceof Node && this.modelMenu.contains(e.target)) {
            return;
        }
        this.closeModelMenu();
    };

    private onMenuDocMouseDown = (e: MouseEvent): void => {
        if (this.modelMenu?.contains(e.target as Node) || this.modelBtnEl.contains(e.target as Node)) {
            return;
        }
        this.closeModelMenu();
    };

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

    /** 打字机定时器:按积压量自适应步进,揭示速度始终略慢于生成速度。 */
    private ensureRevealTimer(): void {
        if (this.revealTimer !== null) {
            return;
        }
        this.revealTimer = window.setInterval(() => {
            const streamMsg = this.runner.streamingMessage;
            if (!this.runner.isStreaming || !streamMsg || streamMsg.role !== "assistant") {
                this.stopReveal();
                return;
            }
            this.revealMsg = streamMsg;
            const full = assistantTextLength(streamMsg);
            const backlog = full - this.revealCount;
            if (backlog > 0) {
                // 基础速度约 30 字符/秒;积压多时自适应加速追平,避免长回复拖尾太久
                const step = Math.max(1, Math.min(48, Math.ceil(backlog / 14)));
                this.revealCount = Math.min(full, this.revealCount + step);
                this.requestRender();
            }
        }, 30);
    }

    private stopReveal(): void {
        if (this.revealTimer !== null) {
            clearInterval(this.revealTimer);
            this.revealTimer = null;
        }
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

    /** 原生样式的悬停操作行(复制),block__icon 图标右对齐。 */
    private actionRow(text: string): HTMLElement {
        const row = document.createElement("div");
        row.className = "sy-msg-actions";
        const btn = document.createElement("span");
        btn.className = "block__icon block__icon--show ariaLabel";
        btn.setAttribute("data-position", "north");
        btn.setAttribute("aria-label", "复制");
        btn.innerHTML = icon("iconCopy");
        btn.addEventListener("click", () => {
            navigator.clipboard?.writeText(text).then(
                () => showMessage("已复制", 1500),
                () => showMessage("复制失败", 1500, "error"),
            );
        });
        row.appendChild(btn);
        return row;
    }

    private messageNode(msg: AgentMessage, revealLen?: number): HTMLElement {
        const wrap = document.createElement("div");
        if (msg.role === "user") {
            wrap.className = "sy-agent-msg user";
            const body = document.createElement("div");
            body.className = "sy-msg-body b3-typography";
            // 图片附件渲染在文本之前
            const contentBlocks = Array.isArray(msg.content) ? msg.content : [];
            const imgs = contentBlocks
                .filter((b: any) => b.type === "image")
                .map(
                    (b: any) =>
                        `<img class="sy-msg-img" src="data:${b.mimeType};base64,${b.data}" alt="image">`,
                )
                .join("");
            body.innerHTML = imgs + renderMarkdown(plainText(msg) || " ");
            wrap.append(body, this.actionRow(plainText(msg)));
            return wrap;
        }
        if (msg.role === "assistant") {
            wrap.className = "sy-agent-msg assistant";
            const body = document.createElement("div");
            body.className = "sy-msg-body b3-typography";
            let html = "";
            let budget = revealLen ?? Infinity;   // 打字机:剩余可揭示的文本字符数
            for (const block of msg.content ?? []) {
                if (block.type === "text" && block.text) {
                    if (block.text.length > budget) {
                        html += renderMarkdown(block.text.slice(0, budget));
                        budget = 0;
                    } else {
                        html += renderMarkdown(block.text);
                        budget -= block.text.length;
                    }
                } else if (block.type === "thinking") {
                    const thinkingText = String((block as any).thinking ?? "");
                    const shown = thinkingText.length > budget ? thinkingText.slice(0, budget) : thinkingText;
                    budget = Math.max(0, budget - thinkingText.length);
                    // 打字期间展开并显示「思考中」(对齐原生 agentThinking 文案),结束后折叠
                    const typing = revealLen !== undefined;
                    html +=
                        `<details class="sy-agent-thinking"${typing ? " open" : ""}><summary>${typing ? "思考中" : "思考过程"}</summary>` +
                        `<div class="sy-agent-thinking-body">${escapeHtml(shown)}</div></details>`;
                } else if (block.type === "toolCall") {
                    const call = block as any;
                    const args = summarizeArgs(call.arguments);
                    html +=
                        `<div class="sy-agent-tool-card"><div class="sy-agent-tool-head">${TOOL_ICON}` +
                        `<span class="sy-agent-tool-title">${escapeHtml(call.name)}</span></div>` +
                        (args ? `<pre class="sy-agent-tool-detail">${args}</pre>` : "") +
                        `</div>`;
                }
            }
            // 打字机期间始终显示闪烁光标(对齐原生 streaming-after 的闪烁块)
            if (revealLen !== undefined) {
                html += `<span class="sy-agent-caret"></span>`;
            }
            body.innerHTML = html;
            wrap.append(body, this.actionRow(plainText(msg)));
            return wrap;
        }
        // toolResult
        wrap.className = "sy-agent-msg tool";
        const result = msg as any;
        const detail = document.createElement("details");
        detail.className = `sy-agent-tool-card sy-agent-tool-result${result.isError ? " error" : ""}`;
        const textOut = (result.content ?? [])
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n");
        detail.innerHTML =
            `<summary>${result.isError ? icon("iconTriangleAlert") : CHECK_ICON}` +
            `<span class="sy-agent-tool-title">工具结果: ${escapeHtml(result.toolName ?? "")}</span></summary>` +
            `<pre class="sy-agent-tool-detail">${escapeHtml(textOut.slice(0, 2000))}</pre>`;
        wrap.appendChild(detail);
        return wrap;
    }

    private emptyNode(configured: boolean): HTMLElement {
        const empty = document.createElement("div");
        empty.className = "sy-agent-welcome";
        const greeting = document.createElement("div");
        greeting.className = "sy-agent-welcome__greeting";
        greeting.textContent = "你好,我是 SiYuan Agent";
        empty.appendChild(greeting);
        if (configured) {
            const examples = document.createElement("div");
            examples.className = "sy-agent-welcome__examples";
            for (const prompt of QUICK_PROMPTS) {
                const item = document.createElement("div");
                item.className = "sy-agent-welcome__example";
                item.textContent = prompt;
                item.addEventListener("click", () => {
                    this.inputEl.value = prompt;
                    this.autoResize();
                    this.focusInput();
                });
                examples.appendChild(item);
            }
            empty.appendChild(examples);
        } else {
            const card = document.createElement("div");
            card.className = "sy-agent-welcome__no-model";
            const title = document.createElement("div");
            title.className = "sy-agent-welcome__no-model-title";
            title.textContent = "尚未配置模型";
            const tip = document.createElement("div");
            tip.className = "sy-agent-welcome__no-model-tip";
            tip.textContent = "请先配置模型服务商、API Key 和模型 ID";
            const btn = document.createElement("button");
            btn.className = "b3-button sy-agent-welcome__go-setting";
            btn.textContent = "前往设置";
            btn.addEventListener("click", () => this.callbacks.onOpenSettings());
            card.append(title, tip, btn);
            empty.appendChild(card);
        }
        return empty;
    }

    /** 用户上滚后显示"回到底部"悬浮按钮(原生 agent-chat__scroll-bottom 行为)。 */
    private updateScrollBottom(): void {
        const nearBottom =
            this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight < 80;
        this.scrollBottomEl.classList.toggle("fn__none", nearBottom);
    }

    /** 会话统计:缓存命中率(来自 pi usage) + 输入/输出字数(含流式中的消息)。 */
    private updateStats(): void {
        let inChars = 0;
        let outChars = 0;
        let inTok = 0;
        let cacheTok = 0;
        const walk = (m: AgentMessage) => {
            if (Array.isArray(m.content)) {
                for (const b of m.content as any[]) {
                    if (b.type === "text") {
                        if (m.role === "user") {
                            inChars += (b.text ?? "").length;
                        } else if (m.role === "assistant") {
                            outChars += (b.text ?? "").length;
                        }
                    }
                }
            }
            const u = (m as any).usage;
            if (m.role === "assistant" && u) {
                inTok += (u.input ?? 0) + (u.cacheRead ?? 0);
                cacheTok += u.cacheRead ?? 0;
            }
        };
        this.runner.messages.forEach(walk);
        const streamMsg = this.runner.streamingMessage;
        if (streamMsg) {
            walk(streamMsg);
        }
        if (inChars === 0 && outChars === 0) {
            this.statsEl.classList.add("fn__none");
            return;
        }
        const parts: string[] = [];
        if (inTok > 0) {
            parts.push(`${Math.round((cacheTok / inTok) * 100)}%`);
        }
        parts.push(`↑${compactNum(inChars)}`, `↓${compactNum(outChars)}`);
        this.statsEl.textContent = parts.join(" ");
        this.statsEl.setAttribute("aria-label",
            `本会话统计\n缓存命中率: ${inTok > 0 ? `${Math.round((cacheTok / inTok) * 100)}%(${cacheTok.toLocaleString()}/${inTok.toLocaleString()} tokens)` : "无数据"}\n输入字数: ${inChars.toLocaleString()}\n输出字数: ${outChars.toLocaleString()}`);
        this.statsEl.classList.remove("fn__none");
    }

    private render(): void {
        const streaming = this.runner.isStreaming;
        const {modelId, configured, thinking, supportsImage} = this.callbacks.getState();

        // 原生行为:生成中隐藏发送、显示停止
        this.sendBtnEl.classList.toggle("fn__none", streaming);
        this.stopBtnEl.classList.toggle("fn__none", !streaming);
        this.sendBtnEl.disabled = !streaming && !this.inputEl.value.trim() && this.attachments.length === 0 && !this.activeSkill;
        this.modelLabelEl.textContent = modelId || "未配置模型";
        this.modelBtnEl.classList.toggle("unconfigured", !configured);
        this.modelBtnEl.setAttribute(
            "aria-label",
            this.callbacks.getState().models.length > 0 ? "切换模型" : "未配置模型,点击打开设置",
        );
        // 思考强度徽标(原生 ariaLabel 文案)
        const lv = thinking.level ?? "off";
        this.thinkingLabelEl.textContent = THINKING_LABELS[lv] ?? lv;
        this.thinkingBtnEl.classList.toggle("unconfigured", lv === "off");
        this.thinkingBtnEl.setAttribute("aria-label", thinking.reasoning ? "思考强度" : "思考强度(当前模型未标记支持思考)");
        // 图片能力
        this.attachBtnEl.classList.toggle("unconfigured", !supportsImage);

        this.updateStats();

        const messages = this.runner.messages;
        // 打字机:流式期间进行中的 assistant 消息在 runner.streamingMessage(message_end 才并入 messages)
        const streamMsg = this.runner.streamingMessage;
        const typing = streaming && streamMsg?.role === "assistant";
        if (typing) {
            if (!this.typingActive) {
                // 新一轮回复开始才重置进度;streamingMessage 对象可能被替换,不做身份比较
                this.revealCount = 0;
                this.typingActive = true;
            }
            this.revealMsg = streamMsg!;
            this.ensureRevealTimer();
        } else {
            this.typingActive = false;
            this.revealMsg = null;
            if (!streaming) {
                this.stopReveal();
            }
        }
        const displayMessages = typing ? [...messages, streamMsg!] : messages;
        const frag = document.createDocumentFragment();
        if (displayMessages.length === 0 && !streaming) {
            frag.appendChild(this.emptyNode(configured));
        } else {
            for (const msg of displayMessages) {
                frag.appendChild(this.messageNode(msg, typing && msg === streamMsg ? this.revealCount : undefined));
            }
            if (streaming && !typing) {
                const waiting = document.createElement("div");
                waiting.className = "sy-agent-msg assistant";
                waiting.innerHTML = `<div class="sy-agent-waiting"><span class="sy-agent-spinner"></span></div>`;
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
        this.updateScrollBottom();

        // 错误横幅(原生 body--error 卡片样式)
        const bannerId = "sy-agent-error-banner";
        document.getElementById(bannerId)?.remove();
        if (this.lastError && !streaming) {
            const banner = document.createElement("div");
            banner.id = bannerId;
            banner.className = "sy-agent-error";
            banner.innerHTML = `${icon("iconTriangleAlert")}<span>上次运行失败: ${escapeHtml(this.lastError)}</span>`;
            this.messagesEl.parentElement?.insertBefore(banner, this.messagesEl);
        }
    }
}
