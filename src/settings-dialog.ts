/**
 * 分页式设置面板:左侧分类导航 + 右侧内容页。
 * 页:模型服务(服务商/密钥/地址/协议/模型 + 测试连接/获取上游模型)、
 *     模型参数、智能体行为(确认开关/系统提示词/会话管理)、关于。
 */
import {Dialog, showMessage} from "siyuan";
import type {App} from "siyuan";
import {getModels} from "@mariozechner/pi-ai";
import type {AgentApi, AgentModelEntry, AgentPluginConfig} from "./agent-runner";
import {DEFAULT_CONFIG, defaultSystemPrompt} from "./agent-runner";
import {PROVIDER_GROUPS, findCatalogModel, listProviders, providerMeta} from "./provider-catalog";
import type {ProviderMeta} from "./provider-catalog";
import {listUpstreamModels, testChat, testConnection} from "./model-service";
import type {TestOutcome, UpstreamModelInfo} from "./model-service";
import {ComboBox} from "./combo-box";
import type {ComboItem} from "./combo-box";
import {BUILTIN_SKILLS, getStorageSkillDir, refreshUserSkills} from "./skills";
import type {SkillInfo} from "./skills";
import {WRITE_TOOLS, createSiyuanTools} from "./tools";
import {SiYuanClient} from "./siyuan-client";
import {isZh, t} from "./i18n";

export interface SettingsDialogOptions {
    getConfig: () => AgentPluginConfig;
    onSave: (config: AgentPluginConfig) => void;
    onClearSession: () => Promise<void> | void;
    sessionMessageCount: () => number;
    /** 思源 App 实例,能力页用它构造含前端能力的完整工具清单。 */
    app?: App;
}

type PageId = "provider" | "params" | "skills" | "capabilities" | "behavior";

/** 设置侧边栏图标:直接使用思源原生图标精灵(appearance/icons)。 */
const ICONS: Record<PageId, string> = {
    provider: `<svg><use xlink:href="#iconCloud"/></svg>`,
    params: `<svg><use xlink:href="#iconAlignSettings"/></svg>`,
    skills: `<svg><use xlink:href="#iconPlugin"/></svg>`,
    capabilities: `<svg><use xlink:href="#iconPlugZap"/></svg>`,
    behavior: `<svg><use xlink:href="#iconSparkles"/></svg>`,
};

const PAGE_TITLE_KEYS: Record<PageId, string> = {
    provider: "pageProvider",
    params: "pageParams",
    skills: "pageSkills",
    capabilities: "pageCapabilities",
    behavior: "pageBehavior",
};

const API_OPTION_KEYS: {value: AgentApi; key: string}[] = [
    {value: "openai-completions", key: "apiOptCompletions"},
    {value: "openai-responses", key: "apiOptResponses"},
    {value: "anthropic-messages", key: "apiOptAnthropic"},
    {value: "google-generative-ai", key: "apiOptGoogle"},
];

const CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>`;
const WARN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>`;

const MASK_CHAR = "\u2022";
/** 密钥掩码:首末各保留 5 位,中间用圆点代替;过短的密钥全部掩码。 */
function maskKey(k: string): string {
    if (k.length <= 10) {
        return MASK_CHAR.repeat(Math.max(k.length, 8));
    }
    return `${k.slice(0, 5)}${MASK_CHAR.repeat(6)}${k.slice(-5)}`;
}

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

/** SiYuan 设置项行的通用结构:左侧标题+说明,右侧控件。
 *  注意用 div 而非 label:label 会让点击行内任意位置都聚焦到输入框,
 *  导致掩码态的密钥输入框被意外聚焦并显示明文。 */
function settingRow(title: string, desc: string | HTMLElement | undefined, controls: HTMLElement[]): HTMLElement {
    const row = el("div", "b3-label fn__flex sy-ai-agent-row");
    const left = el("div", "fn__flex-1");
    const head = el("div", "sy-ai-agent-row-title", title);
    left.append(head);
    if (typeof desc === "string") {
        left.append(el("div", "b3-label__text", desc));
    } else if (desc instanceof HTMLElement) {
        left.append(desc);
    }
    const right = el("div", "sy-ai-agent-row-ctl");
    for (const c of controls) {
        right.append(c);
    }
    row.append(left, right);
    return row;
}

/**
 * 可折叠行(参考原生能力列表):头部为 > 展开图标 + 名称 + 控件,
 * 描述/详情默认收起,点击头部展开,避免长描述撑乱列表。
 */
function foldRow(title: string, body: HTMLElement, controls: HTMLElement[]): HTMLElement {
    const root = el("div", "sy-ai-agent-fold");
    const head = el("div", "fn__flex sy-ai-agent-fold-head");
    const arrow = el("span", "sy-ai-agent-fold-arrow");
    arrow.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`;
    head.append(arrow, el("div", "fn__flex-1 sy-ai-agent-fold-name", title), ...controls);
    const bodyEl = el("div", "sy-ai-agent-fold-body fn__none");
    bodyEl.append(body);
    head.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("input,select,button")) {
            return;
        }
        const collapsed = bodyEl.classList.toggle("fn__none");
        root.classList.toggle("sy-ai-agent-fold--open", !collapsed);
    });
    root.append(head, bodyEl);
    return root;
}

export class SettingsDialog {
    private dialog: Dialog | null = null;
    private readonly els: Record<string, any> = {};
    /** 服务端获取的模型缓存,provider/baseURL/协议变化时失效 */
    private fetchedModels: UpstreamModelInfo[] | null = null;
    private modelsListEl: HTMLElement | null = null;
    private modelCombos: ComboBox[] = [];
    /** 技能页草稿(内置记禁用,用户记启用)与能力页草稿 */
    private skillsDraft = {builtinDisabled: new Set<string>(), userEnabled: new Set<string>()};
    private capsDraft = {disabled: new Set<string>(), approval: {} as Record<string, "follow" | "always" | "auto">};
    private userSkills: SkillInfo[] = [];
    private busy = false;

    constructor(private readonly options: SettingsDialogOptions) {}

    open(): void {
        const cfg = this.options.getConfig();
        this.skillsDraft = {
            builtinDisabled: new Set(cfg.skills?.builtinDisabled ?? []),
            userEnabled: new Set(cfg.skills?.userEnabled ?? []),
        };
        this.capsDraft = {
            disabled: new Set(cfg.capabilities?.disabled ?? []),
            approval: {...(cfg.capabilities?.approval ?? {})},
        };
        const root = el("div", "sy-ai-agent-settings");

        const nav = el("div", "sy-ai-agent-settings-nav");
        const navList = el("div", "b3-list b3-list--background");
        const pages = el("div", "sy-ai-agent-settings-body");
        for (const id of Object.keys(PAGE_TITLE_KEYS) as PageId[]) {
            const item = el("div", "b3-list-item b3-list-item--narrow sy-ai-agent-nav-item");
            const icon = el("span", "sy-ai-agent-nav-icon");
            icon.innerHTML = ICONS[id];
            item.append(icon, el("span", undefined, t(PAGE_TITLE_KEYS[id])));
            item.addEventListener("click", () => this.showPage(id));
            item.dataset.page = id;
            navList.append(item);
            const page = el("div", `sy-ai-agent-page fn__none`);
            page.dataset.page = id;
            pages.append(page);
            this.buildPage(id, page, cfg);
        }
        nav.append(navList, this.buildStatusChip());
        root.append(nav, pages);

        const footer = el("div", "sy-ai-agent-settings-footer");
        const btnReset = el("button", "b3-button b3-button--cancel", t("resetDefault"));
        btnReset.addEventListener("click", () => this.resetDefaults());
        const btnCancel = el("button", "b3-button b3-button--cancel", t("cancelBtn"));
        btnCancel.addEventListener("click", () => this.dialog?.destroy());
        const btnSave = el("button", "b3-button", t("saveBtn"));
        btnSave.addEventListener("click", () => this.save());
        footer.append(btnReset, btnCancel, btnSave);

        const wrap = el("div", "sy-ai-agent-settings-wrap");
        wrap.append(root, footer);

        this.dialog = new Dialog({
            title: t("settingsTitle"),
            content: `<div class="sy-ai-agent-settings-mount"></div>`,
            width: "960px",
            height: "78vh",
            destroyCallback: () => {
                this.dialog = null;
            },
        });
        // 通过 mount 节点注入,不依赖思源 Dialog 内部结构(b3-dialog__body 等)
        const mount = this.dialog.element.querySelector(".sy-ai-agent-settings-mount") as HTMLElement;
        mount.append(wrap);
        this.showPage("provider");
    }

    /** 左下角配置状态角标。 */
    private buildStatusChip(): HTMLElement {
        const cfg = this.options.getConfig();
        const chip = el("div", "sy-ai-agent-status-chip");
        const ok = Boolean(cfg.apiKey && cfg.models?.some((m) => m.enabled && m.id));
        chip.append(el("span", ok ? "sy-ai-agent-dot sy-ai-agent-dot--ok" : "sy-ai-agent-dot"));
        chip.append(el("span", undefined, ok ? t("statusConfigured") : t("statusUnconfigured")));
        return chip;
    }

    private showPage(id: PageId): void {
        this.dialog?.element.querySelectorAll(".sy-ai-agent-nav-item").forEach((n) => {
            n.classList.toggle("b3-list-item--focus", (n as HTMLElement).dataset.page === id);
        });
        this.dialog?.element.querySelectorAll(".sy-ai-agent-page").forEach((n) => {
            n.classList.toggle("fn__none", (n as HTMLElement).dataset.page !== id);
        });
    }

    // ---------------------------------------------------------------- 模型服务
    private buildPage(id: PageId, page: HTMLElement, cfg: AgentPluginConfig): void {
        if (id === "provider") {
            this.buildProviderPage(page, cfg);
        } else if (id === "params") {
            this.buildParamsPage(page, cfg);
        } else if (id === "skills") {
            this.buildSkillsPage(page);
        } else if (id === "capabilities") {
            this.buildCapabilitiesPage(page);
        } else if (id === "behavior") {
            this.buildBehaviorPage(page, cfg);
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
                const opt = el("option", undefined, m.label);
                opt.value = m.id;
                og.append(opt);
            }
            providerSel.append(og);
        }
        providerSel.value = providerMeta(cfg.provider).id;
        providerSel.addEventListener("change", () => this.onProviderChange(providerMeta(providerSel.value)));
        this.els.provider = providerSel;

        const providerHint = el("div", "b3-label__text sy-ai-agent-hint");
        page.append(settingRow(t("providerLabel"), providerHint, [providerSel]));
        this.renderProviderHint(providerHint, providerMeta(providerSel.value));
        this.els.providerHint = providerHint;

        // API Key:失焦掩码显示首末各 5 位,聚焦恢复明文以便编辑
        const keyInput = el("input", "b3-text-field") as HTMLInputElement;
        keyInput.placeholder = "sk-…";
        keyInput.spellcheck = false;
        keyInput.autocomplete = "off";
        keyInput.addEventListener("input", () => {
            this.fetchedModels = null;
        });
        keyInput.addEventListener("focus", () => {
            const real = keyInput.dataset.real;
            if (real && keyInput.value === maskKey(real)) {
                keyInput.value = real;
            }
        });
        keyInput.addEventListener("blur", () => {
            const v = keyInput.value.trim();
            if (v) {
                keyInput.dataset.real = v;
                keyInput.value = maskKey(v);
            } else {
                delete keyInput.dataset.real;
            }
        });
        if (cfg.apiKey) {
            keyInput.dataset.real = cfg.apiKey;
            keyInput.value = maskKey(cfg.apiKey);
        }
        this.els.apiKey = keyInput;
        page.append(settingRow(
            "API Key / Token",
            t("apiKeyDesc"),
            [keyInput],
        ));

        // Base URL
        const baseInput = el("input", "b3-text-field") as HTMLInputElement;
        baseInput.placeholder = "https://api.example.com/v1";
        baseInput.value = cfg.baseURL;
        baseInput.addEventListener("change", () => {
            this.fetchedModels = null;
        });
        this.els.baseURL = baseInput;
        page.append(settingRow(
            t("baseUrlLabel"),
            t("baseUrlDesc"),
            [baseInput],
        ));

        // 协议
        const apiSel = el("select", "b3-select");
        for (const opt of API_OPTION_KEYS) {
            const o = el("option", undefined, t(opt.key));
            o.value = opt.value;
            apiSel.append(o);
        }
        apiSel.value = cfg.api;
        apiSel.addEventListener("change", () => {
            this.fetchedModels = null;
        });
        this.els.api = apiSel;
        page.append(settingRow(t("apiProtocolLabel"), t("apiProtocolDesc"), [apiSel]));

        // 模型列表(参考原生 设置-人工智能-API 提供商:可添加/启停多个模型)
        const modelsRow = el("div", "sy-ai-agent-row sy-ai-agent-row--block");
        const modelsHead = el("div", "fn__flex sy-ai-agent-models-head");
        const headLeft = el("div", "fn__flex-1");
        headLeft.append(
            el("div", "sy-ai-agent-row-title", t("modelsLabel")),
            el("div", "b3-label__text", t("modelsDesc")),
        );
        const fetchBtn = el("button", "b3-button b3-button--outline sy-ai-agent-btn-flex", t("fetchModels"));
        fetchBtn.addEventListener("click", () => void this.fetchModels(fetchBtn));
        this.els.fetchBtn = fetchBtn;
        const addBtn = el("button", "b3-button b3-button--outline sy-ai-agent-btn-flex");
        addBtn.innerHTML = `<svg class="b3-button__icon"><use xlink:href="#iconAdd"/></svg><span>${t("addModel")}</span>`;
        addBtn.addEventListener("click", () => this.addModelRow({id: "", enabled: true}));
        // 与上方标准行保持一致的列结构:文字在左列,两个按钮在右侧控件列(320px)内均分
        const headRight = el("div", "sy-ai-agent-row-ctl");
        headRight.append(fetchBtn, addBtn);
        modelsHead.append(headLeft, headRight);
        const modelsList = el("div", "sy-ai-agent-models");
        modelsRow.append(modelsHead, modelsList);
        // 行内测试结果展示区(最近一次测试的结果)
        const result = el("div", "sy-ai-agent-result fn__none");
        const resultMsg = el("div", "sy-ai-agent-result-msg");
        const resultDetails = el("pre", "sy-ai-agent-result-details fn__none");
        result.append(resultMsg, resultDetails);
        this.els.result = result;
        this.els.resultMsg = resultMsg;
        this.els.resultDetails = resultDetails;
        modelsRow.append(result);
        page.append(modelsRow);
        this.modelsListEl = modelsList;
        this.modelCombos = [];
        for (const m of cfg.models) {
            this.addModelRow(m);
        }
        if (cfg.models.length === 0) {
            this.addModelRow({id: "", enabled: true});
        }
    }

    private renderProviderHint(hint: HTMLElement, meta: ProviderMeta): void {
        hint.textContent = "";
        const parts: string[] = [];
        if (meta.modelCount > 0) {
            parts.push(t("catalogModels", {count: meta.modelCount}));
        }
        if (meta.apis.length > 0) {
            parts.push(t("protocolsLabel", {apis: meta.apis.join(" / ")}));
        }
        if (meta.envKey) {
            parts.push(t("envKeyLabel", {key: meta.envKey}));
        }
        if (parts.length > 0) {
            hint.append(el("span", undefined, parts.join(" · ")), el("br"));
        }
        if (meta.note) {
            hint.append(el("span", "sy-ai-agent-warn", meta.note));
        } else if (meta.group === "plan") {
            hint.append(el("span", "sy-ai-agent-warn", t("planNote")));
        }
    }

    private onProviderChange(meta: ProviderMeta): void {
        this.fetchedModels = null;
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
        this.refreshModelCombos();
    }

    /** 添加一行模型配置(原生行:启用开关 + 模型 ID + 显示名 + 上下文 + 删除)。 */
    private addModelRow(entry: AgentModelEntry): void {
        const list = this.modelsListEl;
        if (!list) {
            return;
        }
        const row = el("div", "fn__flex sy-ai-agent-model-row");

        const sw = el("input", "b3-switch fn__flex-center") as HTMLInputElement;
        sw.type = "checkbox";
        sw.checked = entry.enabled;
        sw.title = t("enable");
        sw.dataset.field = "enabled";

        const combo = new ComboBox(t("modelIdPlaceholder"));
        combo.wrap.style.flex = "1.4";
        combo.input.value = entry.id;
        combo.input.dataset.field = "id";
        combo.setItems(this.modelCandidates());
        combo.onChange = (v) => this.fillRowParams(row, v);
        combo.input.addEventListener("change", () => this.fillRowParams(row, combo.input.value.trim()));
        this.modelCombos.push(combo);

        const nameInput = el("input", "b3-text-field") as HTMLInputElement;
        nameInput.placeholder = t("displayNamePlaceholder");
        nameInput.spellcheck = false;
        nameInput.value = entry.displayName ?? "";
        nameInput.dataset.field = "displayName";
        nameInput.style.flex = "1";

        const ctxInput = el("input", "b3-text-field sy-ai-agent-model-ctx") as HTMLInputElement;
        ctxInput.type = "number";
        ctxInput.placeholder = t("ctxPlaceholder");
        ctxInput.title = t("ctxTitle");
        ctxInput.value = entry.contextWindow ? String(entry.contextWindow) : "";
        ctxInput.dataset.field = "contextWindow";

        const del = el("button", "b3-button b3-button--remove b3-button--icon ariaLabel");
        del.setAttribute("aria-label", t("delete"));
        del.setAttribute("data-position", "north");
        del.innerHTML = `<svg><use xlink:href="#iconTrashcan"/></svg>`;
        del.addEventListener("click", () => {
            const idx = this.modelCombos.indexOf(combo);
            if (idx >= 0) {
                this.modelCombos.splice(idx, 1);
            }
            row.remove();
        });

        // 行内测试按钮(只测当前行的模型)
        const connBtn = el("button", "b3-button b3-button--outline b3-button--icon ariaLabel");
        connBtn.setAttribute("aria-label", t("testConnection"));
        connBtn.setAttribute("data-position", "north");
        connBtn.innerHTML = `<svg><use xlink:href="#iconPlugZap"/></svg>`;
        connBtn.addEventListener("click", () => void this.runRowTest(row, "connection", connBtn));
        const chatBtn = el("button", "b3-button b3-button--outline b3-button--icon ariaLabel");
        chatBtn.setAttribute("aria-label", t("sendTestMsg"));
        chatBtn.setAttribute("data-position", "north");
        chatBtn.innerHTML = `<svg><use xlink:href="#iconSend"/></svg>`;
        chatBtn.addEventListener("click", () => void this.runRowTest(row, "chat", chatBtn));

        // 顺序:模型 ID | 显示名 | 上下文 | 启用开关 | 删除 | 测试连接 | 发送测试消息
        row.append(combo.wrap, nameInput, ctxInput, sw, del, connBtn, chatBtn);
        list.append(row);
    }

    /** 选中目录/上游模型时带出该行的上下文窗口与接口协议。 */
    private fillRowParams(row: HTMLElement, modelId: string): void {
        if (!modelId) {
            return;
        }
        const catalog = findCatalogModel(this.els.provider?.value ?? "", modelId);
        if (!catalog) {
            return;
        }
        const ctxInput = row.querySelector<HTMLInputElement>('[data-field="contextWindow"]');
        if (ctxInput) {
            ctxInput.value = String(catalog.contextWindow);
        }
        if (catalog.api && this.els.api) {
            this.els.api.value = catalog.api;
        }
    }

    /** 模型候选(内置目录 + 服务端获取,去重)。 */
    private modelCandidates(): ComboItem[] {
        const seen = new Set<string>();
        const items: ComboItem[] = [];
        for (const m of catalogOf(this.els.provider?.value ?? "")) {
            if (seen.has(m.id)) {
                continue;
            }
            seen.add(m.id);
            items.push({value: m.id, note: `${Math.round(m.contextWindow / 1000)}k ctx`, group: t("groupCatalog")});
        }
        for (const m of this.fetchedModels ?? []) {
            if (seen.has(m.id)) {
                continue;
            }
            seen.add(m.id);
            items.push({value: m.id, note: m.name || undefined, group: t("groupFetched")});
        }
        return items;
    }

    private refreshModelCombos(): void {
        const items = this.modelCandidates();
        for (const combo of this.modelCombos) {
            combo.setItems(items);
        }
    }

    private async fetchModels(btn: HTMLButtonElement): Promise<void> {
        if (this.busy) {
            return;
        }
        this.busy = true;
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = t("fetching");
        try {
            const {models, latencyMs} = await listUpstreamModels(this.collectDraft());
            this.fetchedModels = models;
            this.refreshModelCombos();
            this.renderResult({
                ok: true,
                message: t("fetchedModels", {count: models.length, latency: latencyMs}),
            });
        } catch (e: any) {
            this.renderResult({ok: false, message: e?.message ? String(e.message) : String(e)});
        } finally {
            this.busy = false;
            btn.disabled = false;
            btn.textContent = old;
        }
    }

    /** 行内测试:只针对该行的模型生效(连接测试与具体模型无关,聊天测试用当前行模型)。 */
    private async runRowTest(row: HTMLElement, kind: "connection" | "chat", btn: HTMLButtonElement): Promise<void> {
        if (this.busy) {
            return;
        }
        const modelId = (row.querySelector<HTMLInputElement>('[data-field="id"]')?.value ?? "").trim();
        if (kind === "chat" && !modelId) {
            showMessage(t("fillModelId"), 3000, "error");
            return;
        }
        this.busy = true;
        btn.disabled = true;
        try {
            const cfg = this.collectDraft();
            // 指定用当前行的模型测试(即便它未启用/未设为活跃模型)
            cfg.activeModelId = modelId;
            cfg.models = cfg.models.map((m) => (m.id === modelId ? {...m, enabled: true} : m));
            if (!cfg.models.some((m) => m.id === modelId) && modelId) {
                cfg.models.push({id: modelId, enabled: true});
            }
            const outcome: TestOutcome = kind === "connection" ? await testConnection(cfg) : await testChat(cfg);
            this.renderResult(outcome);
        } finally {
            this.busy = false;
            btn.disabled = false;
        }
    }

    private renderResult(outcome: TestOutcome): void {
        const box = this.els.result as HTMLElement;
        const msg = this.els.resultMsg as HTMLElement;
        const details = this.els.resultDetails as HTMLElement;
        box.classList.remove("fn__none", "sy-ai-agent-result--ok", "sy-ai-agent-result--err");
        box.classList.add(outcome.ok ? "sy-ai-agent-result--ok" : "sy-ai-agent-result--err");
        msg.textContent = "";
        const ic = el("span", "sy-ai-agent-result-ic");
        ic.innerHTML = outcome.ok ? CHECK_ICON : WARN_ICON;
        msg.append(ic, document.createTextNode(outcome.message));
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
        ctx.value = String(cfg.contextWindow);
        this.els.context = ctx;
        page.append(settingRow(t("contextWindowLabel"), t("contextWindowDesc"), [ctx]));

        const max = el("input", "b3-text-field") as HTMLInputElement;
        max.type = "number";
        max.value = String(cfg.maxTokens);
        this.els.maxTokens = max;
        page.append(settingRow(t("maxTokensLabel"), t("maxTokensDesc"), [max]));

        page.append(el("div", "b3-label__text sy-ai-agent-hint", t("paramsHint")));
    }

    // ---------------------------------------------------------------- 技能
    private buildSkillsPage(page: HTMLElement): void {
        page.append(el("div", "b3-label__text sy-ai-agent-hint",
            t("skillsHint")));

        // 外部技能目录说明:全局 ~/.agents/skills + 插件存储目录(约定给其他插件安装技能)
        const dirText = el("div", "b3-label__text sy-ai-agent-hint");
        dirText.append(
            document.createTextNode(t("externalSkillDirs")),
            el("code", undefined, "~/.agents/skills"),
        );
        if (getStorageSkillDir()) {
            dirText.append(
                document.createTextNode(isZh() ? "、" : ", "),
                el("code", undefined, "data/storage/petal/siyuan-ai-agent/skills"),
                document.createTextNode(t("storageSkillNote")),
            );
        }
        page.append(dirText);

        const listEl = el("div", "sy-ai-agent-skill-list");
        page.append(listEl);
        listEl.append(el("div", "b3-label__text sy-ai-agent-hint", t("loadingSkills")));

        // 打开设置面板时重新扫描全部外部技能目录(全局 + 插件存储目录)并统一渲染
        void refreshUserSkills().then((userSkills) => {
            if (!listEl.isConnected) {
                return;
            }
            this.userSkills = userSkills;
            listEl.textContent = "";
            const all = [...BUILTIN_SKILLS, ...userSkills];
            if (all.length === 0) {
                listEl.append(el("div", "b3-label__text sy-ai-agent-hint", t("noSkills")));
                return;
            }
            for (const skill of all) {
                const isUser = skill.source === "user";
                const sw = el("input", "b3-switch") as HTMLInputElement;
                sw.type = "checkbox";
                // 默认启用的内置技能记录禁用;默认关闭的(用户技能或 defaultEnabled:false 的内置技能)记录启用
                const defaultOn = !isUser && skill.defaultEnabled !== false;
                sw.checked = defaultOn
                    ? !this.skillsDraft.builtinDisabled.has(skill.id)
                    : this.skillsDraft.userEnabled.has(skill.id);
                sw.addEventListener("change", () => {
                    const set = defaultOn ? this.skillsDraft.builtinDisabled : this.skillsDraft.userEnabled;
                    // 勾选状态与集合成员关系相反(默认开→记禁用;默认关→记启用)
                    if (sw.checked !== defaultOn) {
                        set.add(skill.id);
                    } else {
                        set.delete(skill.id);
                    }
                });
                const body = el("div");
                if (skill.description) {
                    body.append(el("div", "b3-label__text", skill.description));
                }
                if (skill.path) {
                    const pathLine = el("div", "b3-label__text");
                    pathLine.append(el("code", undefined, skill.path));
                    body.append(pathLine);
                }
                listEl.append(foldRow(skill.name, body, [sw]));
            }
        });
    }

    // ---------------------------------------------------------------- 能力
    private buildCapabilitiesPage(page: HTMLElement): void {
        page.append(el("div", "b3-label__text sy-ai-agent-hint",
            t("capsHint")));

        const tools = createSiyuanTools(new SiYuanClient(), this.options.app);
        const writeSet = new Set<string>(WRITE_TOOLS as readonly string[]);

        // 工具栏:搜索 + 统计 + 全部启用/禁用(参考原生能力选择器)
        const toolbar = el("div", "fn__flex sy-ai-agent-caps-toolbar");
        const search = el("input", "b3-text-field fn__flex-1") as HTMLInputElement;
        search.placeholder = t("searchCapsPlaceholder");
        const count = el("span", "b3-label__text sy-ai-agent-caps-count");
        const enableAll = el("button", "b3-button b3-button--outline sy-ai-agent-btn-flex", t("enableAll"));
        const disableAll = el("button", "b3-button b3-button--outline sy-ai-agent-btn-flex", t("disableAll"));
        toolbar.append(search, count, enableAll, disableAll);
        page.append(toolbar);

        const listEl = el("div", "sy-ai-agent-caps-list");
        page.append(listEl);

        const updateCount = () => {
            count.textContent = t("selectedCount", {n: tools.length - this.capsDraft.disabled.size, total: tools.length});
        };
        const renderList = () => {
            const kw = search.value.trim().toLowerCase();
            listEl.textContent = "";
            for (const tool of tools) {
                if (kw && !`${tool.name} ${tool.label ?? ""} ${tool.description ?? ""}`.toLowerCase().includes(kw)) {
                    continue;
                }
                const isWrite = writeSet.has(tool.name);
                const sw = el("input", "b3-switch") as HTMLInputElement;
                sw.type = "checkbox";
                sw.checked = !this.capsDraft.disabled.has(tool.name);
                sw.addEventListener("change", () => {
                    if (sw.checked) {
                        this.capsDraft.disabled.delete(tool.name);
                    } else {
                        this.capsDraft.disabled.add(tool.name);
                    }
                    updateCount();
                });
                const body = el("div");
                body.append(el("div", "b3-label__text", tool.description ?? ""));
                const meta = el("div", "b3-label__text");
                meta.append(
                    el("code", undefined, tool.name),
                    el("span", `sy-ai-agent-cap-badge${isWrite ? " sy-ai-agent-cap-badge--write" : ""}`,
                        (tool as any).frontend ? t("capFrontend") : isWrite ? t("capWrite") : t("capRead")),
                );
                body.append(meta);
                const controls: HTMLElement[] = [];
                if (isWrite) {
                    // 写能力的批准方式(参考原生能力批准方式)
                    const sel = el("select", "b3-select sy-ai-agent-cap-approval");
                    for (const [v, label] of [["follow", t("approvalFollow")], ["always", t("approvalAlways")], ["auto", t("approvalAuto")]] as const) {
                        const opt = el("option", undefined, label);
                        opt.value = v;
                        sel.append(opt);
                    }
                    sel.value = this.capsDraft.approval[tool.name] ?? "follow";
                    sel.addEventListener("change", () => {
                        this.capsDraft.approval[tool.name] = sel.value as "follow" | "always" | "auto";
                    });
                    controls.push(sel);
                }
                controls.push(sw);
                listEl.append(foldRow(tool.label ?? tool.name, body, controls));
            }
            updateCount();
        };
        search.addEventListener("input", renderList);
        enableAll.addEventListener("click", () => {
            this.capsDraft.disabled.clear();
            renderList();
        });
        disableAll.addEventListener("click", () => {
            for (const t of tools) {
                this.capsDraft.disabled.add(t.name);
            }
            renderList();
        });
        renderList();
    }

    // ---------------------------------------------------------------- 行为
    private buildBehaviorPage(page: HTMLElement, cfg: AgentPluginConfig): void {
        const sw = el("input", "b3-switch") as HTMLInputElement;
        sw.type = "checkbox";
        sw.checked = cfg.confirmWrites;
        this.els.confirmWrites = sw;
        page.append(settingRow(t("confirmWritesLabel"), t("confirmWritesDesc"), [sw]));

        // 联网搜索的首选引擎(失败时自动尝试其余引擎)
        const engineSel = el("select", "b3-select") as HTMLSelectElement;
        for (const [v, label] of [["duckduckgo", "DuckDuckGo"], ["bing", "Bing"], ["baidu", "百度"], ["google", "Google"]] as const) {
            const opt = el("option", undefined, label);
            opt.value = v;
            engineSel.append(opt);
        }
        engineSel.value = cfg.searchEngine ?? "duckduckgo";
        this.els.searchEngine = engineSel;
        page.append(settingRow(t("searchEngineLabel"), t("searchEngineDesc"), [engineSel]));

        const ta = el("textarea", "b3-text-field fn__block sy-ai-agent-prompt") as HTMLTextAreaElement;
        ta.rows = 12;
        ta.spellcheck = false;
        ta.value = cfg.systemPrompt || defaultSystemPrompt();
        this.els.systemPrompt = ta;
        const promptRow = el("div", "sy-ai-agent-row sy-ai-agent-row--block");
        promptRow.append(
            el("div", "sy-ai-agent-row-title", t("systemPromptLabel")),
            el("div", "b3-label__text", t("systemPromptDesc")),
            ta,
        );
        page.append(promptRow);

        const sessionText = el("span", undefined, t("sessionCount", {count: this.options.sessionMessageCount()}));
        this.els.sessionText = sessionText;
        const clearBtn = el("button", "b3-button b3-button--cancel", t("clearSession"));
        clearBtn.addEventListener("click", async () => {
            await this.options.onClearSession();
            sessionText.textContent = t("sessionCount", {count: 0});
            showMessage(t("sessionCleared"), 2000);
        });
        page.append(settingRow(t("sessionManageLabel"), t("sessionManageDesc"), [clearBtn, sessionText]));
    }

    // ---------------------------------------------------------------- 通用
    private collectDraft(): AgentPluginConfig {
        const models: AgentModelEntry[] = [];
        this.modelsListEl?.querySelectorAll<HTMLElement>(".sy-ai-agent-model-row").forEach((row) => {
            const id = (row.querySelector<HTMLInputElement>('[data-field="id"]')?.value ?? "").trim();
            if (!id) {
                return;
            }
            const displayName = (row.querySelector<HTMLInputElement>('[data-field="displayName"]')?.value ?? "").trim();
            const ctx = Number(row.querySelector<HTMLInputElement>('[data-field="contextWindow"]')?.value) || undefined;
            models.push({
                id,
                enabled: row.querySelector<HTMLInputElement>('[data-field="enabled"]')?.checked ?? true,
                displayName: displayName || undefined,
                contextWindow: ctx,
            });
        });
        return {
            provider: this.els.provider?.value ?? "custom",
            baseURL: (this.els.baseURL?.value ?? "").trim(),
            apiKey: (this.els.apiKey?.dataset?.real ?? this.els.apiKey?.value ?? "").trim(),
            models,
            activeModelId: this.options.getConfig().activeModelId,
            api: (this.els.api?.value ?? "openai-completions") as AgentApi,
            contextWindow: Number(this.els.context?.value) || DEFAULT_CONFIG.contextWindow,
            maxTokens: Number(this.els.maxTokens?.value) || DEFAULT_CONFIG.maxTokens,
            confirmWrites: this.els.confirmWrites?.checked ?? true,
            searchEngine: (this.els.searchEngine?.value as AgentPluginConfig["searchEngine"]) || "duckduckgo",
            systemPrompt: this.els.systemPrompt?.value ?? "",
            thinkingLevel: this.options.getConfig().thinkingLevel ?? "off",
            skills: {
                builtinDisabled: [...this.skillsDraft.builtinDisabled],
                userEnabled: [...this.skillsDraft.userEnabled],
            },
            capabilities: {
                disabled: [...this.capsDraft.disabled],
                approval: {...this.capsDraft.approval},
            },
        };
    }

    private resetDefaults(): void {
        const keepKey = this.els.apiKey.value;
        this.els.baseURL.value = DEFAULT_CONFIG.baseURL;
        this.els.api.value = DEFAULT_CONFIG.api;
        this.els.provider.value = "custom";
        this.modelsListEl!.textContent = "";
        this.modelCombos = [];
        this.addModelRow({id: "", enabled: true});
        this.els.context.value = String(DEFAULT_CONFIG.contextWindow);
        this.els.maxTokens.value = String(DEFAULT_CONFIG.maxTokens);
        this.els.confirmWrites.checked = DEFAULT_CONFIG.confirmWrites;
        if (this.els.searchEngine) {
            this.els.searchEngine.value = DEFAULT_CONFIG.searchEngine;
        }
        this.els.systemPrompt.value = defaultSystemPrompt();
        this.els.apiKey.value = keepKey;
        this.fetchedModels = null;
        this.skillsDraft = {builtinDisabled: new Set(), userEnabled: new Set()};
        this.capsDraft = {disabled: new Set(), approval: {}};
        showMessage(t("restoredDefaults"), 2500);
    }

    private save(): void {
        const cfg = this.collectDraft();
        if (!cfg.baseURL) {
            showMessage(t("baseUrlRequired"), 3000, "error");
            this.showPage("provider");
            return;
        }
        this.options.onSave(cfg);
        if (!cfg.apiKey || !cfg.models.some((m) => m.enabled)) {
            showMessage(t("savedButIncomplete"), 4000);
        } else {
            showMessage(t("savedOk"), 2500);
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
