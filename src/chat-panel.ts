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
import {t} from "./i18n";

marked.setOptions({gfm: true, breaks: true});

/** 引用思源原生图标 sprite。 */
const icon = (id: string, cls?: string): string =>
    `<svg${cls ? ` class="${cls}"` : ""}><use xlink:href="#${id}"/></svg>`;
/** 原生图标库没有扳手,工具调用图标保留自定义线性 SVG。 */
const TOOL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>`;

/** 空会话欢迎页的示例问题(跟随界面语言)。 */
function quickPrompts(): string[] {
    return [t("quickPrompt1"), t("quickPrompt2"), t("quickPrompt3")];
}

/** 紧凑数字(K/M 单位):1234 → 1.2K,128000 → 128K,1200000 → 1.2M。 */
function compactNum(n: number): string {
    if (n >= 1000000) {
        return `${(n / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
    }
    if (n >= 1000) {
        return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
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

/** 思源块引用语法:((20260101120000-abcdefg '锚文本')),分组:1=块 id,2=引号,3=锚文本。 */
const BLOCK_REF_SRC = String.raw`\(\(\s*(\d{14}-[0-9a-zA-Z]{7})\s+(['"])([\s\S]*?)\2\s*\)\)`;

/** 模型的纯文本引用格式:《标题》(hpath: /路径, id: 块id)——括号内需含 hpath/id 标注与块 id。
 *  分组:1=书名号标题(可缺省),2=括号内容。 */
const CITE_SRC = String.raw`(?:《([^》]+)》\s*)?[（(]([^()（）]*(?:hpath|id)\s*:[^()（）]*)[)）]`;
/** 思源块 id:14 位时间戳 + 短横线 + 7 位随机字符。 */
const BLOCK_ID_RE = /\d{14}-[0-9a-zA-Z]{7}/;

/** CJK/英文引号开闭对照,用于折叠 “「标题」([标题](siyuan://…))” 重复引用。 */
const QUOTE_PAIRS: Record<string, string> = {
    "「": "」",
    "『": "』",
    "《": "》",
    "【": "】",
    "“": "”",
    "‘": "’",
    '"': '"',
    "'": "'",
};

/** 把文本中的思源引用拆为片段:《标题》(hpath:..., id:...) 纯文本引用与 ((id '锚文本')) 语法。 */
function splitRefSegments(text: string): (string | {id: string; anchor: string})[] {
    const segments: (string | {id: string; anchor: string})[] = [];
    // 第一遍:纯文本引用标注(模型未按块引用语法输出时的兜底)
    const citeRe = new RegExp(CITE_SRC, "g");
    let m: RegExpExecArray | null;
    let last = 0;
    while ((m = citeRe.exec(text))) {
        const id = BLOCK_ID_RE.exec(m[2])?.[0];
        if (!id) {
            continue; // 括号里没有合法块 id,保留原文
        }
        const hpath = /hpath\s*:\s*([^,，;；]+)/.exec(m[2])?.[1]?.trim() ?? "";
        const anchor = m[1] ?? (hpath.split("/").filter(Boolean).pop() || id);
        if (m.index > last) {
            segments.push(text.slice(last, m.index));
        }
        segments.push({id, anchor});
        last = m.index + m[0].length;
    }
    if (last < text.length) {
        segments.push(text.slice(last));
    }
    // 第二遍:剩余文本中的 ((id '锚文本')) 块引用语法
    const out: (string | {id: string; anchor: string})[] = [];
    for (const seg of segments) {
        if (typeof seg !== "string") {
            out.push(seg);
            continue;
        }
        const re = new RegExp(BLOCK_REF_SRC, "g");
        let mm: RegExpExecArray | null;
        let l = 0;
        while ((mm = re.exec(seg))) {
            if (mm.index > l) {
                out.push(seg.slice(l, mm.index));
            }
            out.push({id: mm[1], anchor: mm[3]});
            l = mm.index + mm[0].length;
        }
        if (l < seg.length) {
            out.push(seg.slice(l));
        }
    }
    return out;
}

/** 粘贴/序列化时视为段落边界的块级标签(转换为换行)。 */
const PASTE_BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION",
    "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN",
    "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TR", "UL",
]);

/** 原生样式的块引用行级元素:着色 + data-id,思源全局悬停弹层(popover)据此识别并预览文档内容。 */
function refSpanHtml(id: string, anchor: string): string {
    return `<span data-type="block-ref" data-id="${escapeHtml(id)}" data-subtype="d">${escapeHtml(anchor)}</span>`;
}

/** 把 ((id '锚文本')) 语法替换为原生块引用 span,返回 HTML。 */
function blockRefsToHtml(text: string): string {
    const re = new RegExp(BLOCK_REF_SRC, "g");
    let m: RegExpExecArray | null;
    let last = 0;
    let out = "";
    while ((m = re.exec(text))) {
        out += escapeHtml(text.slice(last, m.index)) + refSpanHtml(m[1], m[3]);
        last = m.index + m[0].length;
    }
    return out + escapeHtml(text.slice(last));
}

/**
 * 思源剪贴板 HTML → 输入框 HTML,对齐原生智能体输入框(protyle)的粘贴行为:
 * 块引用保留为原生样式的 span(着色 + 悬停预览),其余格式降级为纯文本,块级结构还原为换行。
 * 非思源内容返回 null,走纯文本粘贴。
 */
function siyuanClipboardToHtml(html: string): string | null {
    if (!/data-node-id=|data-type=/.test(html)) {
        return null;
    }
    const doc = new DOMParser().parseFromString(html, "text/html");
    // protyle-attr 是编辑器里的属性节点({: id=...}),不属于正文
    doc.querySelectorAll("script,style,.protyle-attr").forEach((el) => el.remove());
    const out = Array.from(doc.body.childNodes).map(serializePasteNode).join("");
    return out
        .replace(/\u200B/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^\n+|\n+$/g, "");
}

function serializePasteNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
        return escapeHtml(node.textContent ?? "");
    }
    if (!(node instanceof HTMLElement)) {
        return "";
    }
    const dataType = node.getAttribute("data-type") ?? "";
    if (dataType.split(" ").includes("block-ref") && node.getAttribute("data-id")) {
        return refSpanHtml(node.getAttribute("data-id")!, (node.textContent ?? "").trim());
    }
    if (node.tagName === "BR") {
        return "\n";
    }
    const inner = Array.from(node.childNodes).map(serializePasteNode).join("");
    if (PASTE_BLOCK_TAGS.has(node.tagName)) {
        return inner && !inner.endsWith("\n") ? `${inner}\n` : inner;
    }
    return inner;
}

/** 输入框(contenteditable)内容序列化:块引用按 syntax 模式转为 ((id '锚文本'))(模型可据此定位笔记),块级元素 → 换行。 */
function serializeInputNode(node: Node, refMode: "syntax" | "anchor"): string {
    if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent ?? "";
    }
    if (node instanceof HTMLElement) {
        const dataType = node.dataset?.type ?? "";
        if (dataType.split(" ").includes("block-ref") && node.dataset.id) {
            const anchor = (node.textContent ?? "").trim();
            return refMode === "syntax" ? `((${node.dataset.id} '${anchor}'))` : anchor;
        }
        if (node.tagName === "BR") {
            return "\n";
        }
        const inner = Array.from(node.childNodes).map((n) => serializeInputNode(n, refMode)).join("");
        if (PASTE_BLOCK_TAGS.has(node.tagName)) {
            return inner && !inner.endsWith("\n") ? `${inner}\n` : inner;
        }
        return inner;
    }
    // DocumentFragment 等容器节点:递归子节点
    return Array.from(node.childNodes ?? []).map((n) => serializeInputNode(n, refMode)).join("");
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
/** assistant 消息的正文文本总长度(打字机进度基准;思考内容不参与门控,流式即显)。 */
function assistantTextLength(msg: AgentMessage): number {
    let len = 0;
    for (const block of (msg as any).content ?? []) {
        if (block.type === "text" && block.text) {
            len += block.text.length;
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

/** 思考等级按钮标签(首字母大写)。 */
const THINKING_LABELS: Record<string, string> = {
    off: "Off",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Xhigh",
    max: "Max",
};

export interface ChatPanelCallbacks {
    onSend: (text: string, images?: ImageContent[]) => void;
    /** 编辑重发:index 为被编辑的用户消息在会话中的下标,发送后截断其后的对话。 */
    onEditResend: (index: number, text: string, images?: ImageContent[]) => void;
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
    /** 打开块引用指向的笔记(点击消息中的引用)。 */
    onOpenBlock: (id: string) => void;
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
    /** 上下文用量圆环(对齐原生 agent-chat__tokens)。 */
    private readonly tokensEl: HTMLElement;
    /** 圆环旁的文字统计:缓存命中率 + 累计输入/输出 tokens。 */
    private readonly statsEl: HTMLElement;
    /** 上下文用量明细浮层与定时器(对齐原生 agent-token-popup)。 */
    private tokenPopup: HTMLElement | null = null;
    private tokenPopupShowTimer = 0;
    private tokenPopupHideTimer = 0;
    private tokenPopupOutsideClickHandler: (() => void) | null = null;
    private tokenPopupResizeHandler: (() => void) | null = null;
    /** aria-label 悬浮提示延时隐藏:提示文字会遮住用量浮层,浮层出现约 1.2s 后隐藏 tooltip 并摘除 aria-label。 */
    private tokenTooltipTimer = 0;
    private tokensAriaLabel: string | null = null;
    private readonly inputEl: HTMLElement;
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
    /** 消息编辑模式:正在编辑的用户消息下标,null 表示非编辑模式。 */
    private editingIndex: number | null = null;
    /** 打字机:当前正在揭示的 assistant 消息与已揭示字符数。 */
    private revealMsg: AgentMessage | null = null;
    private revealCount = 0;
    private revealTimer: number | null = null;
    private typingActive = false;
    private readonly runner: AgentRunner;

    constructor(container: HTMLElement, runner: AgentRunner, private readonly callbacks: ChatPanelCallbacks) {
        this.runner = runner;
        container.innerHTML = `
<div class="sy-ai-agent-root sy-chat">
    <div class="block__icons fn__hidescrollbar sy-chat-header">
        <div class="block__logo fn__flex-1 sy-chat-title">SiYuan Ai Agent</div>
        <span class="block__icon block__icon--show ariaLabel sy-action-history" data-position="north" aria-label="${t("history")}">${icon("iconHistory")}</span>
        <span class="block__icon block__icon--show ariaLabel sy-action-new" data-position="north" aria-label="${t("newSession")}">${icon("iconAdd")}</span>
        <span class="fn__space"></span>
        <span class="block__icon block__icon--show ariaLabel sy-action-settings" data-position="north" aria-label="${t("settings")}">${icon("iconSettings")}</span>
    </div>
    <div class="sy-ai-agent-messages-wrap">
        <div class="sy-ai-agent-messages"></div>
        <span class="sy-chat-scroll-bottom ariaLabel fn__none" data-position="west" aria-label="${t("scrollToBottom")}">${icon("iconArrowDown")}</span>
    </div>
    <div class="sy-chat-input-area">
        <div class="sy-chat-attach-strip fn__none"></div>
        <div class="sy-chat-skill-chip fn__none"></div>
        <div class="sy-ai-agent-input" contenteditable="true" data-placeholder="${t("inputPlaceholder")}"></div>
        <div class="sy-chat-skill-pop fn__none"></div>
        <div class="sy-chat-buttons">
            <button class="b3-button b3-button--icon b3-button--text sy-chat-attach ariaLabel" aria-label="${t("insertImage")}" data-position="n" type="button">${icon("iconImage")}</button>
            <button class="b3-select b3-select--noborder sy-chat-combo sy-chat-thinking ariaLabel" data-position="n" type="button">${icon("iconBrain", "sy-chat-model-icon")}<span class="sy-chat-thinking-label"></span></button>
            <button class="b3-select b3-select--noborder sy-chat-combo sy-chat-model ariaLabel" data-position="n" type="button">${icon("iconAtom", "sy-chat-model-icon")}<span class="sy-chat-model-label"></span></button>
            <span class="fn__flex-1"></span>
            <span class="sy-chat-stats fn__none"></span>
            <span class="sy-chat-tokens fn__none ariaLabel" aria-label="${t("contextUsage")}" data-position="north"><svg viewBox="0 0 24 24"><circle class="sy-chat-tokens-track" cx="12" cy="12" r="9" stroke-width="3"></circle><circle class="sy-chat-tokens-arc" cx="12" cy="12" r="9" stroke-width="3" stroke-dasharray="0 56.55"></circle></svg></span>
            <button class="b3-button b3-button--icon b3-button--text sy-chat-send ariaLabel" aria-label="${t("sendEnter")}" type="button">${icon("iconSend")}</button>
            <button class="b3-button b3-button--icon b3-button--cancel sy-chat-stop fn__none ariaLabel" aria-label="${t("stop")}" type="button">${icon("iconSquareStop")}</button>
        </div>
    </div>
    <input type="file" accept="image/*" multiple class="sy-chat-file fn__none" />
    <div class="sy-chat-history fn__none">
        <div class="fn__flex sy-chat-history-head">
            <span class="fn__flex-1 sy-chat-history-title">${t("history")}</span>
            <span class="block__icon block__icon--show ariaLabel sy-history-close" data-position="west" aria-label="${t("close")}">${icon("iconClose")}</span>
        </div>
        <div class="sy-chat-history-list"></div>
    </div>
</div>`;
        this.rootEl = container.querySelector(".sy-chat")!;
        this.messagesEl = container.querySelector(".sy-ai-agent-messages")!;
        this.modelBtnEl = container.querySelector(".sy-chat-model")!;
        this.modelLabelEl = container.querySelector(".sy-chat-model-label")!;
        this.tokensEl = container.querySelector(".sy-chat-tokens")!;
        this.statsEl = container.querySelector(".sy-chat-stats")!;
        // 上下文用量明细浮层:桌面 hover 200ms 延迟弹出/移出 300ms 关闭;所有设备点击 toggle(对齐原生)
        if (window.matchMedia("(hover: hover)").matches) {
            this.tokensEl.addEventListener("mouseenter", () => {
                window.clearTimeout(this.tokenPopupHideTimer);
                this.tokenPopupShowTimer = window.setTimeout(() => this.showTokenPopup(), 200);
            });
            this.tokensEl.addEventListener("mouseleave", () => {
                window.clearTimeout(this.tokenPopupShowTimer);
                this.tokenPopupHideTimer = window.setTimeout(() => this.closeTokenPopup(), 300);
            });
        }
        this.tokensEl.addEventListener("click", (e) => {
            e.stopPropagation();
            if (this.tokenPopup) {
                this.closeTokenPopup();
            } else {
                this.showTokenPopup();
            }
        });
        this.inputEl = container.querySelector(".sy-ai-agent-input")!;
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
            this.cancelEdit();
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
                showMessage(t("imageNotSupportedSwitch"), 3000, "error");
                return;
            }
            this.fileInputEl.click();
        });
        this.fileInputEl.addEventListener("change", () => {
            const files = Array.from(this.fileInputEl.files ?? []);
            this.fileInputEl.value = "";
            void this.addImageFiles(files);
        });
        // 粘贴剪贴板图片/思源内容(编辑态气泡复用同一逻辑)
        this.bindComposerPaste(this.inputEl);
        this.sendBtnEl.addEventListener("click", () => this.primaryAction());
        this.stopBtnEl.addEventListener("click", () => callbacks.onStop());
        this.scrollBottomEl.addEventListener("click", () => {
            this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
            this.updateScrollBottom();
        });
        this.messagesEl.addEventListener("scroll", () => this.updateScrollBottom());
        // 块引用/思源链接点击打开笔记(对齐原生智能体消息渲染);悬停预览由思源全局 popover 提供
        this.messagesEl.addEventListener("click", (e) => {
            const target = e.target as HTMLElement;
            let el = target.closest?.("[data-type~='block-ref'][data-id]") as HTMLElement | null;
            let id = el?.getAttribute("data-id") ?? "";
            if (!id) {
                el = target.closest?.('a[data-href^="siyuan://blocks/"]') as HTMLElement | null;
                id = /siyuan:\/\/blocks\/(\d{14}-[0-9a-zA-Z]{7})/.exec(el?.getAttribute("data-href") ?? "")?.[1] ?? "";
            }
            if (id && el && this.messagesEl.contains(el)) {
                e.preventDefault();
                e.stopPropagation();
                this.callbacks.onOpenBlock(id);
                return;
            }
            // 点击用户消息正文(非交互元素且未在选中文本)进入编辑(对齐原生 agent-chat__body 点击行为)
            const bodyEl = target.closest?.(".sy-ai-agent-msg.user .sy-msg-body") as HTMLElement | null;
            if (!bodyEl || this.editingIndex !== null || this.runner.isStreaming) {
                return;
            }
            if (target.closest("[data-type], a[href], img, pre, button, input, textarea, select")) {
                return;
            }
            const wrap = bodyEl.closest(".sy-ai-agent-msg.user") as HTMLElement;
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed && wrap.contains(sel.anchorNode)) {
                return; // 正在选中消息文本,不进入编辑
            }
            const idx = Number(wrap.dataset.msgIndex ?? -1);
            if (idx >= 0) {
                this.startEdit(idx);
            }
        });
        this.inputEl.addEventListener("input", () => {
            // 内容为空时清掉浏览器残留的 <br>/<div>,保证 :empty 占位符生效
            if (!this.inputEl.textContent && !this.inputEl.querySelector("span,img")) {
                this.inputEl.innerHTML = "";
            }
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
        const upto = this.caretBeforeText();
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
        const upto = this.caretBeforeText();
        const m = /(?:^|\s)\/[^\s/]*$/.exec(upto);
        if (m) {
            this.deleteTextBeforeCaret(m[0].length);
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
            del.setAttribute("aria-label", t("removeSkill"));
            del.setAttribute("data-position", "north");
            del.innerHTML = icon("iconClose");
            del.addEventListener("click", () => this.setActiveSkill(null));
            this.skillChipEl.append(iconEl, name, del);
        }
        // 只刷新发送按钮可用态,避免整树重绘
        this.sendBtnEl.disabled = !this.runner.isStreaming && this.isInputEmpty()
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
                `<div class="b3-label__text sy-chat-history-empty">${t("noHistory")}</div>`);
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
                    : `<span class="block__icon block__icon--show ariaLabel sy-history-del" data-position="west" aria-label="${t("delete")}">${icon("iconTrashcan")}</span>`);
            item.addEventListener("click", () => {
                if (s.id !== currentId) {
                    this.cancelEdit();
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
            this.sendBtnEl.disabled = this.isInputEmpty() && this.attachments.length === 0 && !this.activeSkill;
        }
    }

    /** 输入框是否为空(无文本且无引用/图片元素)。 */
    private isInputEmpty(): boolean {
        return !this.inputEl.textContent?.trim() && !this.inputEl.querySelector("[data-type~='block-ref'],img");
    }

    /** 输入框待发送文本:块引用序列化为 ((id '锚文本')),模型可据此定位笔记。 */
    private getInputText(): string {
        return Array.from(this.inputEl.childNodes).map((n) => serializeInputNode(n, "syntax")).join("");
    }

    private setInputText(text: string): void {
        this.inputEl.textContent = text;
        this.autoResize();
    }

    /** 光标前的文本(技能弹层匹配用;块引用按锚文本计)。 */
    private caretBeforeText(): string {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || !this.inputEl.contains(sel.getRangeAt(0).startContainer)) {
            return this.getInputText();
        }
        const range = sel.getRangeAt(0);
        const before = range.cloneRange();
        before.selectNodeContents(this.inputEl);
        before.setEnd(range.startContainer, range.startOffset);
        return serializeInputNode(before.cloneContents(), "anchor");
    }

    /** 删除光标前的 count 个文本字符(技能弹层选中后移除 /触发词)。 */
    private deleteTextBeforeCaret(count: number): void {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || !sel.isCollapsed || !this.inputEl.contains(sel.getRangeAt(0).startContainer)) {
            return;
        }
        const range = sel.getRangeAt(0);
        const del = document.createRange();
        del.setEnd(range.startContainer, range.startOffset);
        let remaining = count;
        // 定位删除起点:从光标位置向文档开头逐个文本节点回退
        let node: Node | null = range.startContainer;
        let offset = range.startOffset;
        if (node.nodeType === Node.ELEMENT_NODE) {
            // 光标落在元素节点上:跳到前一个子节点末尾
            const prev: Node | null = offset > 0 ? node.childNodes[offset - 1] : null;
            if (!prev) {
                return;
            }
            node = prev;
            while (node.lastChild) {
                node = node.lastChild;
            }
            offset = node.nodeType === Node.TEXT_NODE ? (node.textContent ?? "").length : 0;
        }
        while (remaining > 0 && node) {
            if (node.nodeType === Node.TEXT_NODE) {
                const take = Math.min(offset, remaining);
                offset -= take;
                remaining -= take;
                if (remaining === 0) {
                    del.setStart(node, offset);
                    break;
                }
            }
            if (node === this.inputEl) {
                break;
            }
            // 回退到深度优先顺序中的前一个节点
            let cur: Node = node;
            let prev: Node | null = cur.previousSibling;
            while (!prev && cur !== this.inputEl && cur.parentNode) {
                cur = cur.parentNode;
                prev = cur.previousSibling;
            }
            if (!prev) {
                break;
            }
            node = prev;
            while (node.lastChild) {
                node = node.lastChild;
            }
            offset = node.nodeType === Node.TEXT_NODE ? (node.textContent ?? "").length : 0;
        }
        if (remaining === 0) {
            del.deleteContents();
            sel.removeAllRanges();
            sel.addRange(del);
        }
    }

    /** 输入框/编辑器的粘贴处理:剪贴板图片入附件(仅主输入框);思源内容还原为原生块引用 span。 */
    private bindComposerPaste(el: HTMLElement): void {
        el.addEventListener("paste", (e) => {
            const files = Array.from(e.clipboardData?.items ?? [])
                .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
                .map((it) => it.getAsFile())
                .filter((f): f is File => Boolean(f));
            if (files.length > 0) {
                e.preventDefault();
                if (el !== this.inputEl) {
                    showMessage(t("editNoImage"), 3000, "error");
                    return;
                }
                if (!this.callbacks.getState().supportsImage) {
                    showMessage(t("imageNotSupported"), 3000, "error");
                    return;
                }
                void this.addImageFiles(files);
                return;
            }
            const cd = e.clipboardData;
            if (!cd) {
                return;
            }
            // contenteditable 统一接管粘贴,避免带入网页富文本格式;
            // 思源内容还原为原生块引用 span(着色 + 悬停预览,对齐原生智能体输入框)
            e.preventDefault();
            const html = cd.getData("text/html");
            const fromHtml = html ? siyuanClipboardToHtml(html) : null;
            if (fromHtml !== null) {
                this.insertHtml(fromHtml, el);
                return;
            }
            const plain = cd.getData("text/plain");
            if (plain) {
                // 纯文本中的 ((id '锚文本')) 语法同样还原为块引用 span
                this.insertHtml(blockRefsToHtml(plain), el);
            }
        });
    }

    /** 在光标处插入 HTML(优先 execCommand 以保留撤销栈)。 */
    private insertHtml(html: string, host: HTMLElement = this.inputEl): void {
        host.focus();
        if (document.execCommand && document.execCommand("insertHTML", false, html)) {
            return;
        }
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) {
            return;
        }
        const range = sel.getRangeAt(0);
        if (!host.contains(range.commonAncestorContainer)) {
            return;
        }
        range.deleteContents();
        const frag = range.createContextualFragment(html);
        const last = frag.lastChild;
        range.insertNode(frag);
        if (last) {
            range.setStartAfter(last);
        }
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        host.dispatchEvent(new Event("input", {bubbles: true}));
    }

    /** 读入图片文件:超过 2MB 或长边超 1568px 时先压缩再转 base64。 */
    private async addImageFiles(files: File[]): Promise<void> {
        for (const file of files) {
            if (!file.type.startsWith("image/")) {
                continue;
            }
            if (file.size > 10 * 1024 * 1024) {
                showMessage(t("imageTooLarge", {name: file.name}), 3000, "error");
                continue;
            }
            try {
                this.attachments.push(await fileToPendingImage(file));
            } catch {
                showMessage(t("imageReadFailed", {name: file.name}), 3000, "error");
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

    /**
     * 进入消息编辑模式(对齐原生 beginEditUserMessage):气泡正文就地变为编辑器,
     * 操作行替换为取消/发送按钮;生成中或已有编辑中的消息时忽略。
     */
    private startEdit(index: number): void {
        if (this.editingIndex !== null || this.runner.isStreaming) {
            return;
        }
        const msg = this.runner.messages[index];
        if (!msg || msg.role !== "user") {
            return;
        }
        this.editingIndex = index;
        this.requestRender(); // render 中该气泡构建为编辑态
    }

    /** 退出消息编辑模式,气泡恢复原始内容(对齐原生 restore)。 */
    cancelEdit(): void {
        if (this.editingIndex === null) {
            return;
        }
        this.editingIndex = null;
        this.requestRender();
    }

    /**
     * 编辑态气泡:图片附件缩略图(默认保留原消息图片,可单独移除) +
     * contenteditable 编辑器(块引用还原为彩色 span) + 取消/发送按钮。
     * Enter 发送 / Esc 取消。对齐原生编辑草稿(initialContent/initialBlockHTML 回填)。
     */
    private editMessageNode(msg: AgentMessage): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = "sy-ai-agent-msg user sy-editing";
        // 原消息的图片附件随编辑保留,重发时一并提交
        const images: ImageContent[] = (Array.isArray(msg.content) ? msg.content : [])
            .filter((b) => b.type === "image")
            .map((b) => {
                const img = b as ImageContent;
                return {type: "image" as const, data: img.data, mimeType: img.mimeType};
            });
        const strip = document.createElement("div");
        strip.className = "sy-chat-attach-strip sy-msg-edit-attach";
        const renderStrip = () => {
            strip.classList.toggle("fn__none", images.length === 0);
            strip.textContent = "";
            images.forEach((img, i) => {
                const item = document.createElement("div");
                item.className = "sy-chat-attach-item";
                const thumb = document.createElement("img");
                thumb.src = `data:${img.mimeType};base64,${img.data}`;
                thumb.alt = "image";
                const del = document.createElement("span");
                del.className = "sy-chat-attach-del ariaLabel";
                del.setAttribute("aria-label", t("removeImage"));
                del.setAttribute("data-position", "north");
                del.innerHTML = icon("iconClose");
                del.addEventListener("click", () => {
                    images.splice(i, 1);
                    renderStrip();
                });
                item.append(thumb, del);
                strip.append(item);
            });
        };
        renderStrip();
        const editor = document.createElement("div");
        editor.className = "sy-ai-agent-input sy-msg-edit-input";
        editor.contentEditable = "true";
        // 与粘贴处理一致:((id '锚文本')) 语法还原为原生块引用 span
        editor.innerHTML = blockRefsToHtml(plainText(msg));
        const actions = document.createElement("div");
        actions.className = "sy-msg-edit-actions";
        const cancel = document.createElement("button");
        cancel.className = "b3-button b3-button--small b3-button--cancel";
        cancel.textContent = window.siyuan?.languages?.cancel ?? t("cancel");
        const submit = document.createElement("button");
        submit.className = "b3-button b3-button--small b3-button--text";
        submit.textContent = t("send");
        actions.append(cancel, submit);
        // 图片缩略图条与编辑器一起包在气泡容器内(与普通消息气泡的图片布局一致)
        const bubble = document.createElement("div");
        bubble.className = "sy-msg-edit-bubble";
        bubble.append(strip, editor);
        wrap.append(bubble, actions);
        const submitEdit = () => {
            const text = Array.from(editor.childNodes).map((n) => serializeInputNode(n, "syntax")).join("").trim();
            if ((!text && images.length === 0) || this.editingIndex === null) {
                editor.focus();
                return;
            }
            const index = this.editingIndex;
            this.editingIndex = null;
            this.callbacks.onEditResend(index, text, images.length > 0 ? images : undefined);
        };
        cancel.addEventListener("click", () => this.cancelEdit());
        submit.addEventListener("click", submitEdit);
        editor.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                submitEdit();
            } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                this.cancelEdit();
            }
        });
        this.bindComposerPaste(editor);
        // 挂载后聚焦并把光标移到末尾(对齐原生 editComposer.focus(true))
        requestAnimationFrame(() => {
            if (!wrap.isConnected) {
                return;
            }
            editor.focus();
            const sel = window.getSelection();
            if (!sel) {
                return;
            }
            const range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        return wrap;
    }

    private primaryAction(): void {
        if (this.runner.isStreaming) {
            return;
        }
        const value = this.getInputText().trim();
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
        this.inputEl.innerHTML = "";
        this.setActiveSkill(null);
        this.clearAttachments();
        this.closeSkillPop();
        this.cancelEdit(); // 发送新消息时退出可能存在的消息编辑态
        this.autoResize();
        this.callbacks.onSend(text, images);
    }

    /** 思考强度热力色:Off/最低档 = 灰,其余按档位从主色渐变到警示红,强度越高越“热”。 */
    private thinkingHeatColor(idx: number, total: number): string {
        if (idx <= 0 || total <= 1) {
            return "var(--b3-theme-on-surface-light)";
        }
        const heat = Math.round((idx / (total - 1)) * 100);
        return `color-mix(in srgb, var(--b3-theme-primary), var(--b3-theme-error) ${heat}%)`;
    }

    /** 思考等级菜单(原生 b3-menu 容器 + b3-slider 滑块,向上展开)。 */
    private thinkingMenu: HTMLElement | null = null;

    private toggleThinkingMenu(): void {
        if (this.thinkingMenu) {
            this.closeThinkingMenu();
            return;
        }
        const {thinking} = this.callbacks.getState();
        const levels = thinking.levels;
        if (levels.length === 0) {
            return;
        }
        const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
        const currentIdx = Math.max(0, levels.indexOf(thinking.level));

        const pop = document.createElement("div");
        pop.className = "b3-menu sy-ai-agent-thinking-menu";
        pop.style.setProperty("--sy-think-color", this.thinkingHeatColor(currentIdx, levels.length));

        // 当前档位名(拖动滑块时实时预览)
        const valueEl = document.createElement("div");
        valueEl.className = "sy-ai-agent-thinking-menu-value";
        valueEl.textContent = cap(levels[currentIdx]);

        // 滑块:左端 = 最低档,右端 = 最高档;拖动结束才提交
        const slider = document.createElement("input");
        slider.className = "b3-slider sy-ai-agent-thinking-menu-slider";
        slider.type = "range";
        slider.min = "0";
        slider.max = String(levels.length - 1);
        slider.step = "1";
        slider.value = String(currentIdx);
        slider.addEventListener("input", () => {
            const idx = Number(slider.value);
            valueEl.textContent = cap(levels[idx] ?? levels[0]);
            pop.style.setProperty("--sy-think-color", this.thinkingHeatColor(idx, levels.length));
        });
        slider.addEventListener("change", () => {
            const lv = levels[Number(slider.value)];
            if (lv && lv !== thinking.level) {
                this.callbacks.onSetThinking(lv);
            }
        });

        // 两端档位名,帮助定位
        const ends = document.createElement("div");
        ends.className = "sy-ai-agent-thinking-menu-ends";
        ends.innerHTML = `<span>${cap(levels[0])}</span><span>${cap(levels[levels.length - 1])}</span>`;

        const body = document.createElement("div");
        body.className = "sy-ai-agent-thinking-menu-body";
        body.append(valueEl, slider, ends);
        pop.appendChild(body);
        document.body.append(pop);
        const siyuanGlobal = (window as unknown as {siyuan?: {zIndex?: number}}).siyuan;
        if (siyuanGlobal && typeof siyuanGlobal.zIndex === "number") {
            pop.style.zIndex = String(++siyuanGlobal.zIndex);
        }
        // 向上展开:先隐藏测量实际高度,再把菜单底边贴到按钮上方(按钮位于面板底部,向下会被遮蔽)
        const rect = this.thinkingBtnEl.getBoundingClientRect();
        pop.style.visibility = "hidden";
        pop.style.left = `${Math.max(8, rect.left)}px`;
        pop.style.top = `${Math.max(8, rect.top - pop.offsetHeight - 6)}px`;
        pop.style.visibility = "";
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
        pop.className = "sy-ai-agent-combo-pop sy-ai-agent-model-menu";
        for (const m of models) {
            const item = document.createElement("div");
            item.className = "sy-ai-agent-combo-item";
            const label = document.createElement("span");
            label.className = "sy-ai-agent-combo-id";
            label.textContent = m.label;
            item.appendChild(label);
            if (m.label !== m.id) {
                const note = document.createElement("span");
                note.className = "sy-ai-agent-combo-note";
                note.textContent = m.id;
                item.appendChild(note);
            }
            if (m.active) {
                const check = document.createElement("span");
                check.className = "sy-ai-agent-combo-check";
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

    /**
     * 思源引用增强(对齐原生智能体消息渲染):
     * - ((id '锚文本')) 语法 → 原生块引用 span(着色 + 悬停预览文档内容)
     * - 《标题》(hpath:..., id:...) 纯文本引用标注 → 同上(模型未按语法输出时的兜底)
     * - siyuan://blocks 链接 → data-type="a" + data-href,原生 popover 同样识别
     * 悬停预览由思源全局 popover(initBlockPopover,文档级 mouseover 监听)自动提供;
     * 点击打开由 messagesEl 上的事件委托处理。
     */
    private enhanceRefs(container: HTMLElement): void {
        container.querySelectorAll<HTMLAnchorElement>('a[href^="siyuan://blocks/"]').forEach((a) => {
            a.setAttribute("data-type", "a");
            a.setAttribute("data-href", a.getAttribute("href") ?? "");
            this.dedupeRefLink(a);
        });
        const probe = new RegExp(`${BLOCK_REF_SRC}|hpath\s*:`);
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        const targets: Text[] = [];
        while (walker.nextNode()) {
            const node = walker.currentNode as Text;
            if (node.parentElement?.closest("code,pre,a,[data-type]")) {
                continue;
            }
            if (node.data && probe.test(node.data)) {
                targets.push(node);
            }
        }
        for (const node of targets) {
            const segments = splitRefSegments(node.data);
            if (!segments.some((s) => typeof s !== "string")) {
                continue;
            }
            const frag = document.createDocumentFragment();
            for (const seg of segments) {
                if (typeof seg === "string") {
                    frag.append(document.createTextNode(seg));
                    continue;
                }
                const span = document.createElement("span");
                span.setAttribute("data-type", "block-ref");
                span.setAttribute("data-id", seg.id);
                span.setAttribute("data-subtype", "d");
                span.textContent = seg.anchor;
                frag.append(span);
            }
            node.replaceWith(frag);
        }
    }

    /**
     * 折叠重复引用:模型未按约定直接链化标题时,会输出 “「标题」([标题](siyuan://…))”
     * (原文 + 括号内重复一份带链接的文本)。识别该模式并折叠为 “「标题」”——标题文本本身即链接,
     * 对齐原生智能体“在正文上直接挂引用链接”的呈现。结构不匹配时不做任何改动。
     */
    private dedupeRefLink(a: HTMLAnchorElement): void {
        const label = (a.textContent ?? "").trim();
        const prev = a.previousSibling;
        const next = a.nextSibling;
        if (!label || prev?.nodeType !== Node.TEXT_NODE || next?.nodeType !== Node.TEXT_NODE) {
            return;
        }
        const prevText = (prev as Text).data;
        const nextText = (next as Text).data;
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // 前文以 [开引号]标题[闭引号]( 结尾,后文以 ) 开头 → 判定为重复引用
        const m = new RegExp(`([「『《【“‘"']?)${escaped}[」』》】”’"']?\\s*[（(]\\s*$`).exec(prevText);
        if (!m || !/^\s*[)）]/.test(nextText)) {
            return;
        }
        const openQuote = m[1];
        (prev as Text).data = prevText.slice(0, m.index) + openQuote;
        (next as Text).data = nextText.replace(/^\s*[)）]/, QUOTE_PAIRS[openQuote] ?? "");
    }

    /** 原生样式的悬停操作行:编辑(仅用户消息)+ 复制,block__icon 图标右对齐。 */
    private actionRow(text: string, onEdit?: () => void): HTMLElement {
        const row = document.createElement("div");
        row.className = "sy-msg-actions";
        const mkBtn = (label: string, iconId: string, onClick: () => void): HTMLElement => {
            const btn = document.createElement("span");
            btn.className = "block__icon block__icon--show ariaLabel";
            btn.setAttribute("data-position", "north");
            btn.setAttribute("aria-label", label);
            btn.innerHTML = icon(iconId);
            btn.addEventListener("click", onClick);
            return btn;
        };
        if (onEdit) {
            row.appendChild(mkBtn(window.siyuan?.languages?.edit ?? t("edit"), "iconEdit", onEdit));
        }
        row.appendChild(mkBtn(t("copy"), "iconCopy", () => {
            navigator.clipboard?.writeText(text).then(
                () => showMessage(t("copied"), 1500),
                () => showMessage(t("copyFailed"), 1500, "error"),
            );
        }));
        return row;
    }

    private messageNode(msg: AgentMessage, revealLen?: number, msgIndex?: number): HTMLElement {
        const wrap = document.createElement("div");
        if (msg.role === "user") {
            wrap.className = "sy-ai-agent-msg user";
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
            this.enhanceRefs(body);
            wrap.append(body, this.actionRow(
                plainText(msg),
                msgIndex !== undefined ? () => this.startEdit(msgIndex) : undefined,
            ));
            return wrap;
        }
        if (msg.role === "assistant") {
            wrap.className = "sy-ai-agent-msg assistant";
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
                    // 思考内容流式即显,不走打字机预算(预算只门控正文;否则长思考会拖住正文出现)
                    // 打字期间展开并显示「思考中」(对齐原生 agentThinking 文案),结束后折叠
                    const typing = revealLen !== undefined;
                    html +=
                        `<details class="sy-ai-agent-thinking"${typing ? " open" : ""}><summary>${typing ? t("thinking") : t("thoughtProcess")}</summary>` +
                        `<div class="sy-ai-agent-thinking-body">${escapeHtml(thinkingText)}</div></details>`;
                } else if (block.type === "toolCall") {
                    const call = block as any;
                    const args = summarizeArgs(call.arguments);
                    html +=
                        `<div class="sy-ai-agent-tool-card"><div class="sy-ai-agent-tool-head">${TOOL_ICON}` +
                        `<span class="sy-ai-agent-tool-title">${escapeHtml(call.name)}</span></div>` +
                        (args ? `<pre class="sy-ai-agent-tool-detail">${args}</pre>` : "") +
                        `</div>`;
                }
            }
            // 打字机期间始终显示闪烁光标(对齐原生 streaming-after 的闪烁块)
            if (revealLen !== undefined) {
                html += `<span class="sy-ai-agent-caret"></span>`;
            }
            body.innerHTML = html;
            this.enhanceRefs(body);
            wrap.append(body, this.actionRow(plainText(msg)));
            return wrap;
        }
        // toolResult
        wrap.className = "sy-ai-agent-msg tool";
        const result = msg as any;
        const detail = document.createElement("details");
        detail.className = `sy-ai-agent-tool-card sy-ai-agent-tool-result${result.isError ? " error" : ""}`;
        const textOut = (result.content ?? [])
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n");
        detail.innerHTML =
            `<summary>${result.isError ? icon("iconTriangleAlert") : CHECK_ICON}` +
            `<span class="sy-ai-agent-tool-title">${t("toolResult", {name: escapeHtml(result.toolName ?? "")})}</span></summary>` +
            `<pre class="sy-ai-agent-tool-detail">${escapeHtml(textOut.slice(0, 2000))}</pre>`;
        wrap.appendChild(detail);
        return wrap;
    }

    private emptyNode(configured: boolean): HTMLElement {
        const empty = document.createElement("div");
        empty.className = "sy-ai-agent-welcome";
        const greeting = document.createElement("div");
        greeting.className = "sy-ai-agent-welcome__greeting";
        greeting.textContent = t("greeting");
        empty.appendChild(greeting);
        if (configured) {
            const examples = document.createElement("div");
            examples.className = "sy-ai-agent-welcome__examples";
            for (const prompt of quickPrompts()) {
                const item = document.createElement("div");
                item.className = "sy-ai-agent-welcome__example";
                item.textContent = prompt;
                item.addEventListener("click", () => {
                    this.setInputText(prompt);
                    this.focusInput();
                });
                examples.appendChild(item);
            }
            empty.appendChild(examples);
        } else {
            const card = document.createElement("div");
            card.className = "sy-ai-agent-welcome__no-model";
            const title = document.createElement("div");
            title.className = "sy-ai-agent-welcome__no-model-title";
            title.textContent = t("noModelTitle");
            const tip = document.createElement("div");
            tip.className = "sy-ai-agent-welcome__no-model-tip";
            tip.textContent = t("noModelTip");
            const btn = document.createElement("button");
            btn.className = "b3-button sy-ai-agent-welcome__go-setting";
            btn.textContent = t("goSettings");
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

    /** 收集上下文统计:最近一轮 prompt tokens(= input+cacheRead+cacheWrite,覆盖式取最后一条带 usage 的 assistant
     *  消息,对齐原生 contextTokens 语义)、本轮输出 tokens 与全会话输入/输出字数。 */
    private collectUsageStats(): {used: number; cacheRead: number; output: number; inTokTotal: number; outTokTotal: number; cacheReadTotal: number} {
        let inTokTotal = 0;
        let outTokTotal = 0;
        let cacheReadTotal = 0;
        let used = 0;
        let cacheRead = 0;
        let output = 0;
        const walk = (m: AgentMessage) => {
            const u = (m as {usage?: {input?: number; output?: number; cacheRead?: number; cacheWrite?: number}}).usage;
            if (m.role === "assistant" && u) {
                // pi usage 语义:input 不含已缓存部分,提示词总量 = input + cacheRead + cacheWrite
                const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
                const out = u.output ?? 0;
                // 上下文已用/本轮明细:覆盖式取最后一条带 usage 的 assistant 消息(对齐原生 contextTokens 语义)。
                // 但运行失败/中止产生的错误消息 usage 全零,覆盖后会把圆环清空隐藏——跳过零用量消息,保留上一轮真实用量
                if (prompt > 0 || out > 0) {
                    used = prompt;
                    cacheRead = u.cacheRead ?? 0;
                    output = out;
                }
                // 累计输入/输出/缓存命中 tokens:全轮次求和(零用量不影响累加)
                inTokTotal += prompt;
                outTokTotal += out;
                cacheReadTotal += u.cacheRead ?? 0;
            }
        };
        this.runner.messages.forEach(walk);
        const streamMsg = this.runner.streamingMessage;
        if (streamMsg) {
            walk(streamMsg);
        }
        return {used, cacheRead, output, inTokTotal, outTokTotal, cacheReadTotal};
    }

    /** 上下文用量圆环(对齐原生 agent-chat__tokens):弧长 = 最近一轮 prompt tokens / 模型上下文窗口;无数据时隐藏。 */
    private updateTokenDisplay(): void {
        const {used, inTokTotal, outTokTotal, cacheReadTotal} = this.collectUsageStats();
        if (used <= 0 && inTokTotal <= 0) {
            this.tokensEl.classList.add("fn__none");
            this.statsEl.classList.add("fn__none");
            this.closeTokenPopup();
            return;
        }
        this.tokensEl.classList.remove("fn__none");
        const arc = this.tokensEl.querySelector<SVGCircleElement>(".sy-chat-tokens-arc");
        if (arc) {
            const circumference = 2 * Math.PI * 9; // r=9 → ≈56.55
            const limit = this.runner.model?.contextWindow ?? 0;
            // 已知上限按真实占用率画弧;未知上限(limit=0)不画弧,只留灰色轨道圈(对齐原生)
            const ratio = limit > 0 ? Math.min(used / limit, 1) : 0;
            arc.setAttribute("stroke-dasharray", `${(circumference * ratio).toFixed(2)} ${circumference.toFixed(2)}`);
        }
        // 文字统计:缓存命中率(仅实际命中时显示) + 累计输入/输出 tokens
        const parts: string[] = [];
        if (inTokTotal > 0 && cacheReadTotal > 0) {
            parts.push(`${Math.round((cacheReadTotal / inTokTotal) * 100)}%`);
        }
        parts.push(`↑${compactNum(inTokTotal)}`, `↓${compactNum(outTokTotal)}`);
        this.statsEl.textContent = parts.join(" ");
        this.statsEl.classList.remove("fn__none");
    }

    /** 上下文用量明细浮层(对齐原生 agent-token-popup):总量行 + 占用横条 + 缓存命中/输出/字数明细。 */
    private showTokenPopup(): void {
        const {used, cacheRead, output, inTokTotal, outTokTotal} = this.collectUsageStats();
        if (used <= 0) {
            return;
        }
        this.closeTokenPopup();
        const limit = this.runner.model?.contextWindow ?? 0;
        // 甜甜圈 + 右侧信息列即全部内容(不再单独设明细区):
        // 本轮缓存/输出合并为一行,累计输入/输出用 ↑↓ 箭头表示
        const pct = limit > 0 ? Math.round((used / limit) * 100) : null;
        const donutArc = pct !== null ? Math.min(pct, 100) : 0;
        const donutColor = pct !== null && pct >= 80 ? " style=\"stroke: var(--b3-card-error-color, #ea7b6f)\"" : "";
        const subs: string[] = [];
        if (limit > 0) {
            subs.push(t("tokensRemaining", {n: compactNum(Math.max(limit - used, 0))}));
        }
        const roundParts: string[] = [];
        if (cacheRead > 0) {
            roundParts.push(t("tokensCache", {n: Math.round((cacheRead / used) * 1000) / 10}));
        }
        if (output > 0) {
            roundParts.push(t("tokensOutput", {n: compactNum(output)}));
        }
        if (roundParts.length > 0) {
            subs.push(t("tokensRound", {detail: roundParts.join(" · ")}));
        }
        subs.push(t("tokensTotal", {in: compactNum(inTokTotal), out: compactNum(outTokTotal)}));
        const html = '<div class="b3-menu__items">'
            + '<div class="sy-token-popup__hero">'
            + '<div class="sy-token-popup__left">'
            + '<div class="sy-token-popup__donut">'
            + '<svg viewBox="0 0 36 36">'
            + '<circle class="sy-token-popup__donut-track" cx="18" cy="18" r="15.9155"></circle>'
            + `<circle class="sy-token-popup__donut-arc" cx="18" cy="18" r="15.9155" stroke-dasharray="${donutArc} 100"${donutColor}></circle>`
            + "</svg>"
            + `<span class="sy-token-popup__donut-text">${pct !== null ? pct + "%" : "—"}</span>`
            + "</div>"
            + `<div class="sy-token-popup__donut-value">${compactNum(used)}${limit > 0 ? " / " + compactNum(limit) : ""}</div>`
            + "</div>"
            + '<div class="sy-token-popup__meta">'
            + `<div class="sy-token-popup__meta-label">${t("contextUsage")}</div>`
            + subs.map((s) => `<div class="sy-token-popup__meta-sub">${s}</div>`).join("")
            + "</div>"
            + "</div>"
            + "</div>";
        const popup = document.createElement("div");
        popup.className = "sy-token-popup b3-menu";
        popup.innerHTML = html;
        document.body.appendChild(popup);
        const siyuan = (window as unknown as {siyuan?: {zIndex?: number}}).siyuan;
        if (siyuan && typeof siyuan.zIndex === "number") {
            popup.style.zIndex = String(++siyuan.zIndex);
        }
        // 定位:右对齐 trigger 右边缘(width 280 固定),向上展开——
        // trigger 位于输入区底部,向下展开会超出 Dock 面板被遮蔽;
        // 先隐藏测量实际高度,再把浮层底边贴到 trigger 上方
        const rect = this.tokensEl.getBoundingClientRect();
        popup.style.visibility = "hidden";
        // 浮层宽度自适应内容,右对齐 trigger 需先测量实际宽度;
        // 再把浮层底边贴到 trigger 上方(向下展开会超出 Dock 面板被遮蔽)
        const popupWidth = popup.offsetWidth;
        const popupHeight = popup.offsetHeight;
        popup.style.left = `${Math.max(8, rect.right - popupWidth)}px`;
        popup.style.top = `${Math.max(8, rect.top - popupHeight - 6)}px`;
        popup.style.visibility = "";
        // aria-label 悬浮提示(“上下文用量”)会遮住浮层上半部分:浮层出现约 1.2s 后,
        // 隐藏思源全局 #tooltip 并摘除 aria-label 防止再次弹出;关闭浮层时恢复
        window.clearTimeout(this.tokenTooltipTimer);
        this.tokenTooltipTimer = window.setTimeout(() => {
            document.getElementById("tooltip")?.classList.add("fn__none");
            this.tokensAriaLabel = this.tokensEl.getAttribute("aria-label");
            if (this.tokensAriaLabel) {
                this.tokensEl.removeAttribute("aria-label");
                this.tokensEl.classList.remove("ariaLabel");
            }
        }, 1200);
        // popup 自身 hover 保持显示
        popup.addEventListener("mouseenter", () => window.clearTimeout(this.tokenPopupHideTimer));
        popup.addEventListener("mouseleave", () => {
            this.tokenPopupHideTimer = window.setTimeout(() => this.closeTokenPopup(), 300);
        });
        popup.addEventListener("click", (e) => e.stopPropagation());
        // 点击外部/resize 关闭
        this.tokenPopupOutsideClickHandler = () => this.closeTokenPopup();
        this.tokenPopupResizeHandler = () => this.closeTokenPopup();
        setTimeout(() => {
            if (this.tokenPopupOutsideClickHandler) {
                document.addEventListener("click", this.tokenPopupOutsideClickHandler);
            }
        }, 10);
        window.addEventListener("resize", this.tokenPopupResizeHandler);
        this.tokenPopup = popup;
    }

    private closeTokenPopup(): void {
        window.clearTimeout(this.tokenTooltipTimer);
        if (this.tokensAriaLabel) {
            this.tokensEl.setAttribute("aria-label", this.tokensAriaLabel);
            this.tokensEl.classList.add("ariaLabel");
            this.tokensAriaLabel = null;
        }
        if (this.tokenPopupOutsideClickHandler) {
            document.removeEventListener("click", this.tokenPopupOutsideClickHandler);
            this.tokenPopupOutsideClickHandler = null;
        }
        if (this.tokenPopupResizeHandler) {
            window.removeEventListener("resize", this.tokenPopupResizeHandler);
            this.tokenPopupResizeHandler = null;
        }
        window.clearTimeout(this.tokenPopupShowTimer);
        window.clearTimeout(this.tokenPopupHideTimer);
        this.tokenPopup?.remove();
        this.tokenPopup = null;
    }

    private render(): void {
        const streaming = this.runner.isStreaming;
        const {modelId, configured, thinking, supportsImage} = this.callbacks.getState();

        // 原生行为:生成中隐藏发送、显示停止
        this.sendBtnEl.classList.toggle("fn__none", streaming);
        this.stopBtnEl.classList.toggle("fn__none", !streaming);
        this.sendBtnEl.disabled = !streaming && this.isInputEmpty() && this.attachments.length === 0 && !this.activeSkill;
        this.modelLabelEl.textContent = modelId || t("modelNotConfigured");
        this.modelBtnEl.classList.toggle("unconfigured", !configured);
        this.modelBtnEl.setAttribute(
            "aria-label",
            this.callbacks.getState().models.length > 0 ? t("switchModel") : t("modelNotConfiguredClick"),
        );
        // 思考强度徽标(原生 ariaLabel 文案)
        const lv = thinking.level ?? "off";
        this.thinkingLabelEl.textContent = THINKING_LABELS[lv] ?? lv;
        this.thinkingBtnEl.classList.toggle("unconfigured", lv === "off");
        this.thinkingBtnEl.setAttribute("aria-label", thinking.reasoning ? "Thinking level" : "Thinking level (not supported by current model)");
        // 热力色:强度越高按钮颜色越“热”(灰 → 主色 → 警示红)
        this.thinkingBtnEl.style.color = this.thinkingHeatColor(thinking.levels.indexOf(lv), thinking.levels.length);
        // 图片能力
        this.attachBtnEl.classList.toggle("unconfigured", !supportsImage);

        this.updateTokenDisplay();

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
            // msgIndex 与 runner.messages 的下标一致(流式消息追加在末尾,不影响已有下标),
            // 供用户消息的“编辑重发”定位会话截断点
            let msgIndex = 0;
            // 编辑中的气泡保留既有 DOM,避免重绘覆盖正在输入的内容
            const editingNode = this.editingIndex !== null
                ? this.messagesEl.querySelector<HTMLElement>(".sy-ai-agent-msg.sy-editing")
                : null;
            for (const msg of displayMessages) {
                if (msg.role === "user" && msgIndex === this.editingIndex) {
                    frag.appendChild(editingNode ?? this.editMessageNode(msg));
                    msgIndex++;
                    continue;
                }
                const node = this.messageNode(
                    msg,
                    typing && msg === streamMsg ? this.revealCount : undefined,
                    msg.role === "user" ? msgIndex : undefined,
                );
                if (msg.role === "user") {
                    node.dataset.msgIndex = String(msgIndex);
                }
                frag.appendChild(node);
                msgIndex++;
            }
            if (streaming && !typing) {
                const waiting = document.createElement("div");
                waiting.className = "sy-ai-agent-msg assistant";
                waiting.innerHTML = `<div class="sy-ai-agent-waiting"><span class="sy-ai-agent-spinner"></span></div>`;
                frag.appendChild(waiting);
            }
        }
        // 重建前记录流式消息思考体的滚动位置(整条消息每帧重建会把 scrollTop 重置回顶部,导致无法下滑查看)
        const oldThinkingBody = typing
            ? this.messagesEl.querySelector<HTMLElement>(".sy-ai-agent-msg.assistant:last-child .sy-ai-agent-thinking-body")
            : null;
        const thinkingScroll = oldThinkingBody
            ? {
                top: oldThinkingBody.scrollTop,
                atBottom: oldThinkingBody.scrollTop + oldThinkingBody.clientHeight >= oldThinkingBody.scrollHeight - 4,
            }
            : null;
        this.messagesEl.replaceChildren(frag);
        if (typing && thinkingScroll) {
            const el = this.messagesEl.querySelector<HTMLElement>(".sy-ai-agent-msg.assistant:last-child .sy-ai-agent-thinking-body");
            if (el) {
                // 用户贴底时跟随生成内容滚到底;用户上滚阅读时保持原位置
                el.scrollTop = thinkingScroll.atBottom ? el.scrollHeight : Math.min(thinkingScroll.top, el.scrollHeight);
            }
        }

        // 滚动到底部(用户未主动上滚时)
        const nearBottom =
            this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight < 80;
        if (nearBottom || streaming) {
            this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        }
        this.updateScrollBottom();

        // 错误横幅(原生 body--error 卡片样式)
        const bannerId = "sy-ai-agent-error-banner";
        document.getElementById(bannerId)?.remove();
        if (this.lastError && !streaming) {
            const banner = document.createElement("div");
            banner.id = bannerId;
            banner.className = "sy-ai-agent-error";
            banner.innerHTML = `${icon("iconTriangleAlert")}<span>${t("lastRunFailed", {msg: escapeHtml(this.lastError)})}</span>`;
            this.messagesEl.parentElement?.insertBefore(banner, this.messagesEl);
        }
    }
}
