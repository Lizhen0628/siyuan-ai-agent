/**
 * 分页式设置面板:左侧分类导航 + 右侧内容页。
 * 页:模型服务(服务商/密钥/地址/协议/模型 + 测试连接/获取上游模型)、
 *     模型参数、智能体行为(确认开关/系统提示词/会话管理)、关于。
 */
import {Dialog, showMessage} from "siyuan";
import {getModels} from "@mariozechner/pi-ai";
import type {AgentApi, AgentPluginConfig} from "./agent-runner";
import {DEFAULT_CONFIG, DEFAULT_SYSTEM_PROMPT} from "./agent-runner";
import {PROVIDER_GROUPS, findCatalogModel, listProviders, providerMeta} from "./provider-catalog";
import type {ProviderMeta} from "./provider-catalog";
import {listUpstreamModels, testChat, testConnection} from "./model-service";
import type {TestOutcome, UpstreamModelInfo} from "./model-service";
import pkg from "../package.json";

export interface SettingsDialogOptions {
    getConfig: () => AgentPluginConfig;
    onSave: (config: AgentPluginConfig) => void;
    onClearSession: () => Promise<void> | void;
    sessionMessageCount: () => number;
}

type PageId = "provider" | "params" | "behavior" | "about";

const ICONS: Record<PageId, string> = {
    provider: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></svg>`,
    params: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/></svg>`,
    behavior: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    about: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>`,
};

const PAGE_TITLES: Record<PageId, string> = {
    provider: "模型服务",
    params: "模型参数",
    behavior: "智能体行为",
    about: "关于",
};

const API_OPTIONS: {value: AgentApi; label: string}[] = [
    {value: "openai-completions", label: "openai-completions(OpenAI 兼容,最常用)"},
    {value: "openai-responses", label: "openai-responses(OpenAI Responses API)"},
    {value: "anthropic-messages", label: "anthropic-messages(Claude 系)"},
    {value: "google-generative-ai", label: "google-generative-ai(Gemini 系)"},
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (cls) {
        node.className = cls;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

/** SiYuan 设置项行的通用结构:左侧标题+说明,右侧控件。 */
function settingRow(title: string, desc: string | HTMLElement | undefined, controls: HTMLElement[]): HTMLElement {
    const row = el("label", "b3-label fn__flex sy-agent-row");
    row.style.display = "flex";
    const left = el("div", "fn__flex-1");
    const head = el("div", "ft__on-surface", title);
    left.append(head);
    if (typeof desc === "string") {
        left.append(el("div", "b3-label__text", desc));
    } else if (desc instanceof HTMLElement) {
        left.append(desc);
    }
    const right = el("div", "sy-agent-row-ctl");
    for (const c of controls) {
        right.append(c);
    }
    row.append(left, right);
    return row;
}

export class SettingsDialog {
    private dialog: Dialog | null = null;
    private readonly els: Record<string, any> = {};
    /** 服务端获取的模型缓存,provider/baseURL/协议变化时失效 */
    private fetchedModels: UpstreamModelInfo[] | null = null;
    private busy = false;

    constructor(private readonly options: SettingsDialogOptions) {}

    open(): void {
        const cfg = this.options.getConfig();
        const root = el("div", "sy-agent-settings");

        const nav = el("div", "sy-agent-settings-nav");
        const navList = el("div", "b3-list b3-list--background");
        const pages = el("div", "sy-agent-settings-body");
        for (const id of Object.keys(PAGE_TITLES) as PageId[]) {
            const item = el("div", "b3-list-item b3-list-item--narrow sy-agent-nav-item");
            const icon = el("span", "sy-agent-nav-icon");
            icon.innerHTML = ICONS[id];
            item.append(icon, el("span", undefined, PAGE_TITLES[id]));
            item.addEventListener("click", () => this.showPage(id));
            item.dataset.page = id;
            navList.append(item);
            const page = el("div", `sy-agent-page fn__none`);
            page.dataset.page = id;
            pages.append(page);
            this.buildPage(id, page, cfg);
        }
        nav.append(navList, this.buildStatusChip());
        root.append(nav, pages);

        const footer = el("div", "sy-agent-settings-footer");
        const btnReset = el("button", "b3-button b3-button--cancel", "恢复默认");
        btnReset.addEventListener("click", () => this.resetDefaults());
        const btnCancel = el("button", "b3-button b3-button--cancel", "取 消");
        btnCancel.addEventListener("click", () => this.dialog?.destroy());
        const btnSave = el("button", "b3-button", "保 存");
        btnSave.addEventListener("click", () => this.save());
        footer.append(btnReset, btnCancel, btnSave);

        const wrap = el("div", "sy-agent-settings-wrap");
        wrap.append(root, footer);

        this.dialog = new Dialog({
            title: "SiYuan Agent 设置",
            content: `<div class="sy-agent-settings-mount"></div>`,
            width: "960px",
            height: "78vh",
            destroyCallback: () => {
                this.dialog = null;
            },
        });
        // 通过 mount 节点注入,不依赖思源 Dialog 内部结构(b3-dialog__body 等)
        const mount = this.dialog.element.querySelector(".sy-agent-settings-mount") as HTMLElement;
        mount.append(wrap);
        this.showPage("provider");
    }

    /** 左下角配置状态角标。 */
    private buildStatusChip(): HTMLElement {
        const cfg = this.options.getConfig();
        const chip = el("div", "sy-agent-status-chip");
        const ok = Boolean(cfg.apiKey && cfg.modelId);
        chip.append(el("span", ok ? "sy-agent-dot sy-agent-dot--ok" : "sy-agent-dot"));
        chip.append(el("span", undefined, ok ? "已配置" : "未配置"));
        return chip;
    }

    private showPage(id: PageId): void {
        this.dialog?.element.querySelectorAll(".sy-agent-nav-item").forEach((n) => {
            n.classList.toggle("b3-list-item--focus", (n as HTMLElement).dataset.page === id);
        });
        this.dialog?.element.querySelectorAll(".sy-agent-page").forEach((n) => {
            n.classList.toggle("fn__none", (n as HTMLElement).dataset.page !== id);
        });
    }

    // ---------------------------------------------------------------- 模型服务
    private buildPage(id: PageId, page: HTMLElement, cfg: AgentPluginConfig): void {
        if (id === "provider") {
            this.buildProviderPage(page, cfg);
        } else if (id === "params") {
            this.buildParamsPage(page, cfg);
        } else if (id === "behavior") {
            this.buildBehaviorPage(page, cfg);
        } else {
            this.buildAboutPage(page);
        }
    }

    private buildProviderPage(page: HTMLElement, cfg: AgentPluginConfig): void {
        // 服务商
        const providerSel = el("select", "b3-select");
        for (const group of PROVIDER_GROUPS) {
            const metas = listProviders().filter((p) => p.group === group.id);
            if (metas.length === 0) {
                continue;
            }
            const og = el("optgroup");
            og.label = group.label;
            for (const m of metas) {
                const opt = el("option", undefined, m.modelCount > 0 ? `${m.label}(${m.modelCount})` : m.label);
                opt.value = m.id;
                og.append(opt);
            }
            providerSel.append(og);
        }
        providerSel.value = providerMeta(cfg.provider).id;
        providerSel.addEventListener("change", () => this.onProviderChange(providerMeta(providerSel.value)));
        this.els.provider = providerSel;

        const providerHint = el("div", "b3-label__text sy-agent-hint");
        page.append(settingRow("服务商", providerHint, [providerSel]));
        this.renderProviderHint(providerHint, providerMeta(providerSel.value));
        this.els.providerHint = providerHint;

        // API Key
        const keyInput = el("input", "b3-text-field") as HTMLInputElement;
        keyInput.type = "password";
        keyInput.placeholder = "sk-…";
        keyInput.style.width = "280px";
        keyInput.value = cfg.apiKey;
        keyInput.addEventListener("input", () => {
            this.fetchedModels = null;
        });
        const eyeBtn = el("button", "b3-button b3-button--small sy-agent-icon-btn", "👁");
        eyeBtn.title = "显示/隐藏密钥";
        eyeBtn.addEventListener("click", () => {
            keyInput.type = keyInput.type === "password" ? "text" : "password";
        });
        this.els.apiKey = keyInput;
        page.append(settingRow("API Key / Token", "密钥仅保存在本地思源工作空间,不会上传", [keyInput, eyeBtn]));

        // Base URL
        const baseInput = el("input", "b3-text-field") as HTMLInputElement;
        baseInput.placeholder = "https://api.example.com/v1";
        baseInput.style.width = "330px";
        baseInput.value = cfg.baseURL;
        baseInput.addEventListener("change", () => {
            this.fetchedModels = null;
        });
        this.els.baseURL = baseInput;
        page.append(settingRow(
            "接口地址 (Base URL)",
            "选择内置服务商会自动填充;OpenAI 兼容接口一般以 /v1 结尾,Anthropic/Google 例外",
            [baseInput],
        ));

        // 协议
        const apiSel = el("select", "b3-select");
        for (const opt of API_OPTIONS) {
            const o = el("option", undefined, opt.label);
            o.value = opt.value;
            apiSel.append(o);
        }
        apiSel.value = cfg.api;
        apiSel.addEventListener("change", () => {
            this.fetchedModels = null;
        });
        this.els.api = apiSel;
        page.append(settingRow("接口协议", "决定 pi 使用哪种请求格式,选择内置服务商时按目录自动带出", [apiSel]));

        // 模型
        const modelSel = el("select", "b3-select sy-agent-model-select");
        modelSel.addEventListener("change", () => this.onModelSelect(modelSel.value));
        this.els.model = modelSel;
        const fetchBtn = el("button", "b3-button b3-button--outline", "获取上游模型");
        fetchBtn.addEventListener("click", () => void this.fetchModels(fetchBtn));
        this.els.fetchBtn = fetchBtn;
        page.append(settingRow(
            "模型",
            "下拉为 pi 内置目录推荐;点「获取上游模型」拉取服务端实际支持的模型列表",
            [modelSel, fetchBtn],
        ));

        const overrideInput = el("input", "b3-text-field") as HTMLInputElement;
        overrideInput.placeholder = "留空则使用上方下拉选择的模型";
        overrideInput.style.width = "330px";
        overrideInput.value = "";
        this.els.modelOverride = overrideInput;
        page.append(settingRow("模型 ID 手动覆盖", "上游目录里没有的模型(如中转站新模型)在此填写", [overrideInput]));

        // 测试区
        const testRow = el("div", "sy-agent-test");
        const connBtn = el("button", "b3-button b3-button--outline", "测试连接");
        connBtn.addEventListener("click", () => void this.runTest("connection", connBtn));
        const chatBtn = el("button", "b3-button b3-button--outline", "发送测试消息");
        chatBtn.addEventListener("click", () => void this.runTest("chat", chatBtn));
        const btns = el("div", "sy-agent-test-btns");
        btns.append(connBtn, chatBtn);
        testRow.append(btns);
        const result = el("div", "sy-agent-result fn__none");
        const resultMsg = el("div", "sy-agent-result-msg");
        const resultDetails = el("pre", "sy-agent-result-details fn__none");
        result.append(resultMsg, resultDetails);
        testRow.append(result);
        this.els.result = result;
        this.els.resultMsg = resultMsg;
        this.els.resultDetails = resultDetails;
        page.append(testRow);

        this.rebuildModelOptions(cfg.modelId);
    }

    private renderProviderHint(hint: HTMLElement, meta: ProviderMeta): void {
        hint.textContent = "";
        const parts: string[] = [];
        if (meta.modelCount > 0) {
            parts.push(`pi 目录收录 ${meta.modelCount} 个模型`);
        }
        if (meta.apis.length > 0) {
            parts.push(`协议 ${meta.apis.join(" / ")}`);
        }
        if (meta.envKey) {
            parts.push(`对应密钥 ${meta.envKey}`);
        }
        if (parts.length > 0) {
            hint.append(el("span", undefined, parts.join(" · ")), el("br"));
        }
        if (meta.note) {
            hint.append(el("span", "sy-agent-warn", meta.note));
        } else if (meta.group === "plan") {
            hint.append(el("span", "sy-agent-warn", "订阅制服务,密钥栏请粘贴对应 API Key / Token"));
        }
    }

    private onProviderChange(meta: ProviderMeta): void {
        this.fetchedModels = null;
        this.els.modelOverride.value = "";
        if (meta.id !== "custom") {
            if (meta.defaultBase) {
                this.els.baseURL.value = meta.defaultBase;
            }
            if (meta.apis[0]) {
                this.els.api.value = meta.apis[0];
            }
        } else {
            // 切回自定义时清掉上一个服务商残留的协议,回到默认
            this.els.api.value = DEFAULT_CONFIG.api;
        }
        if (this.els.providerHint) {
            this.renderProviderHint(this.els.providerHint, meta);
        }
        this.rebuildModelOptions("");
    }

    private onModelSelect(modelId: string): void {
        if (this.els.modelOverride.value.trim()) {
            return;
        }
        const cfg = this.collectDraft();
        const catalog = findCatalogModel(cfg.provider, modelId);
        if (catalog) {
            this.els.context.value = String(catalog.contextWindow);
            this.els.maxTokens.value = String(catalog.maxTokens);
            this.els.api.value = catalog.api;
        }
    }

    /** 重建模型下拉:内置目录 + 服务端获取 + 当前值兜底。 */
    private rebuildModelOptions(currentId: string): void {
        const sel = this.els.model as HTMLSelectElement;
        sel.textContent = "";
        const cfg = this.collectDraft();
        const catalogModels = catalogOf(cfg.provider);
        if (catalogModels.length > 0) {
            const og = el("optgroup");
            og.label = `pi 内置目录(${catalogModels.length})`;
            for (const m of catalogModels) {
                const o = el("option", undefined, `${m.id} · ${Math.round(m.contextWindow / 1000)}k ctx`);
                o.value = m.id;
                og.append(o);
            }
            sel.append(og);
        }
        if (this.fetchedModels && this.fetchedModels.length > 0) {
            const og = el("optgroup");
            og.label = `服务端获取(${this.fetchedModels.length})`;
            for (const m of this.fetchedModels) {
                const o = el("option", undefined, m.name ? `${m.id} · ${m.name}` : m.id);
                o.value = m.id;
                og.append(o);
            }
            sel.append(og);
        }
        const selected = currentId || this.els.modelOverride?.value?.trim() || "";
        const known = [...sel.options].some((o) => o.value === selected);
        if (selected) {
            if (!known) {
                const og = el("optgroup");
                og.label = "当前配置";
                const o = el("option", undefined, `${selected}(不在列表中)`);
                o.value = selected;
                og.append(o);
                sel.append(og);
            }
            sel.value = selected;
        } else if (sel.options.length > 0) {
            sel.value = "";
            const placeholder = el("option", undefined, "— 请选择模型 —");
            placeholder.value = "";
            placeholder.selected = true;
            placeholder.disabled = true;
            sel.insertBefore(placeholder, sel.firstChild);
        } else {
            const placeholder = el("option", undefined, "— 获取上游模型或手动填写 —");
            placeholder.value = "";
            placeholder.selected = true;
            placeholder.disabled = true;
            sel.append(placeholder);
        }
    }

    private async fetchModels(btn: HTMLButtonElement): Promise<void> {
        if (this.busy) {
            return;
        }
        this.busy = true;
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = "获取中…";
        try {
            const {models, latencyMs} = await listUpstreamModels(this.collectDraft());
            this.fetchedModels = models;
            const current = this.collectDraft().modelId;
            this.rebuildModelOptions(current);
            this.renderResult({
                ok: true,
                message: `已获取 ${models.length} 个模型(${latencyMs}ms),可在「模型」下拉中选择`,
            });
        } catch (e: any) {
            this.renderResult({ok: false, message: e?.message ? String(e.message) : String(e)});
        } finally {
            this.busy = false;
            btn.disabled = false;
            btn.textContent = old;
        }
    }

    private async runTest(kind: "connection" | "chat", btn: HTMLButtonElement): Promise<void> {
        if (this.busy) {
            return;
        }
        this.busy = true;
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = "测试中…";
        try {
            const cfg = this.collectDraft();
            const outcome: TestOutcome = kind === "connection" ? await testConnection(cfg) : await testChat(cfg);
            this.renderResult(outcome);
        } finally {
            this.busy = false;
            btn.disabled = false;
            btn.textContent = old;
        }
    }

    private renderResult(outcome: TestOutcome): void {
        const box = this.els.result as HTMLElement;
        const msg = this.els.resultMsg as HTMLElement;
        const details = this.els.resultDetails as HTMLElement;
        box.classList.remove("fn__none", "sy-agent-result--ok", "sy-agent-result--err");
        box.classList.add(outcome.ok ? "sy-agent-result--ok" : "sy-agent-result--err");
        msg.textContent = `${outcome.ok ? "✅" : "❌"} ${outcome.message}`;
        if (outcome.details) {
            details.textContent = outcome.details;
            details.classList.remove("fn__none");
        } else {
            details.classList.add("fn__none");
        }
    }

    // ---------------------------------------------------------------- 模型参数
    private buildParamsPage(page: HTMLElement, cfg: AgentPluginConfig): void {
        const ctx = el("input", "b3-text-field") as HTMLInputElement;
        ctx.type = "number";
        ctx.style.width = "160px";
        ctx.value = String(cfg.contextWindow);
        this.els.context = ctx;
        page.append(settingRow("上下文窗口 (tokens)", "模型上下文长度,用于本地估算与截断;选择目录模型时自动带出", [ctx]));

        const max = el("input", "b3-text-field") as HTMLInputElement;
        max.type = "number";
        max.style.width = "160px";
        max.value = String(cfg.maxTokens);
        this.els.maxTokens = max;
        page.append(settingRow("最大输出 tokens", "单次回复的输出上限", [max]));

        page.append(el("div", "b3-label__text sy-agent-hint", "提示:这两项会在「模型服务」页选择 pi 目录中的模型时自动填充。"));
    }

    // ---------------------------------------------------------------- 行为
    private buildBehaviorPage(page: HTMLElement, cfg: AgentPluginConfig): void {
        const sw = el("input", "b3-switch") as HTMLInputElement;
        sw.type = "checkbox";
        sw.checked = cfg.confirmWrites;
        this.els.confirmWrites = sw;
        page.append(settingRow("写操作需要确认", "创建/更新/插入/删除笔记前弹窗确认,拒绝后智能体不会重试", [sw]));

        const ta = el("textarea", "b3-text-field fn__block sy-agent-prompt") as HTMLTextAreaElement;
        ta.rows = 12;
        ta.spellcheck = false;
        ta.value = cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT;
        this.els.systemPrompt = ta;
        const taRow = settingRow("系统提示词", "定义智能体的角色与工作准则,留空恢复默认", []);
        taRow.append(ta);
        page.append(taRow);

        const sessionText = el("span", undefined, `当前会话 ${this.options.sessionMessageCount()} 条消息`);
        this.els.sessionText = sessionText;
        const clearBtn = el("button", "b3-button b3-button--cancel", "清空会话");
        clearBtn.addEventListener("click", async () => {
            await this.options.onClearSession();
            sessionText.textContent = "当前会话 0 条消息";
            showMessage("会话已清空", 2000);
        });
        page.append(settingRow("会话管理", "会话持久保存在工作空间,重启思源后自动恢复", [clearBtn, sessionText]));
    }

    // ---------------------------------------------------------------- 关于
    private buildAboutPage(page: HTMLElement): void {
        const list = el("div", "sy-agent-about");
        const deps = pkg.dependencies as Record<string, string>;
        const lines: [string, string][] = [
            ["插件版本", `v${pkg.version}`],
            ["智能体引擎", `@mariozechner/pi-ai ${deps["@mariozechner/pi-ai"] ?? ""} · @mariozechner/pi-agent-core ${deps["@mariozechner/pi-agent-core"] ?? ""}`],
            ["开源仓库", "github.com/Lizhen0628/siyuan-agent"],
        ];
        for (const [k, v] of lines) {
            const rowEl = el("div", "sy-agent-about-row");
            rowEl.append(el("span", "sy-agent-about-key", k), el("span", "sy-agent-about-val", v));
            list.append(rowEl);
        }
        page.append(list);
        const notes = el("div", "b3-label__text");
        for (const text of [
            "· 密钥与配置明文保存在 data/storage/petal/siyuan-agent/ 下,请勿同步到公开仓库。",
            "· 各家 Coding Plan(ChatGPT Codex、Kimi Coding、小米 Token 包等)可直接在「模型服务」选择对应服务商并粘贴 Token。",
            "· OpenAI 兼容接口地址一般以 /v1 结尾;Anthropic 与 Google 由 pi 自动处理路径。",
        ]) {
            notes.append(el("div", undefined, text));
        }
        page.append(notes);
    }

    // ---------------------------------------------------------------- 通用
    private collectDraft(): AgentPluginConfig {
        return {
            provider: this.els.provider?.value ?? "custom",
            baseURL: (this.els.baseURL?.value ?? "").trim(),
            apiKey: (this.els.apiKey?.value ?? "").trim(),
            modelId: ((this.els.modelOverride?.value ?? "").trim() || (this.els.model?.value ?? "")).trim(),
            api: (this.els.api?.value ?? "openai-completions") as AgentApi,
            contextWindow: Number(this.els.context?.value) || DEFAULT_CONFIG.contextWindow,
            maxTokens: Number(this.els.maxTokens?.value) || DEFAULT_CONFIG.maxTokens,
            confirmWrites: this.els.confirmWrites?.checked ?? true,
            systemPrompt: this.els.systemPrompt?.value ?? "",
        };
    }

    private resetDefaults(): void {
        const keepKey = this.els.apiKey.value;
        this.els.baseURL.value = DEFAULT_CONFIG.baseURL;
        this.els.api.value = DEFAULT_CONFIG.api;
        this.els.provider.value = "custom";
        this.els.modelOverride.value = "";
        this.els.context.value = String(DEFAULT_CONFIG.contextWindow);
        this.els.maxTokens.value = String(DEFAULT_CONFIG.maxTokens);
        this.els.confirmWrites.checked = DEFAULT_CONFIG.confirmWrites;
        this.els.systemPrompt.value = DEFAULT_SYSTEM_PROMPT;
        this.els.apiKey.value = keepKey;
        this.fetchedModels = null;
        this.rebuildModelOptions("");
        showMessage("已恢复默认值(保留 API Key),保存后生效", 2500);
    }

    private save(): void {
        const cfg = this.collectDraft();
        if (!cfg.baseURL) {
            showMessage("接口地址不能为空", 3000, "error");
            this.showPage("provider");
            return;
        }
        this.options.onSave(cfg);
        if (!cfg.apiKey || !cfg.modelId) {
            showMessage("已保存,但 API Key 或模型 ID 为空,对话前请补全", 4000);
        } else {
            showMessage("已保存,SiYuan Agent 将使用新配置", 2500);
        }
        this.dialog?.destroy();
    }
}

/** 内置目录模型列表(带上下文信息)。 */
function catalogOf(provider: string): {id: string; api: AgentApi; contextWindow: number}[] {
    if (!provider || provider === "custom") {
        return [];
    }
    try {
        return getModels(provider as never).map((m) => ({
            id: m.id,
            api: m.api as AgentApi,
            contextWindow: m.contextWindow,
        }));
    } catch {
        return [];
    }
}
