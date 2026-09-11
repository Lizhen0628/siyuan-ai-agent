/**
 * 思源风格的可输入组合框:input + 自定义浮层列表(仿 b3-menu 视觉)。
 * 输入即过滤(子串、忽略大小写),方向键选择、回车确认、Esc 关闭;
 * 列表中没有的值直接作为输入生效(自由文本)。
 * 浮层 fixed 定位并挂到 body,避免被设置面板的滚动容器裁剪。
 */
import {t} from "./i18n";

export interface ComboItem {
    value: string;
    /** 右侧灰色标注(如上下文窗口/模型名称)。 */
    note?: string;
    /** 分组标签,相同连续分组合并显示一个小标题。 */
    group?: string;
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

/** 单次渲染条数上限,避免超长列表卡顿;超出时提示继续输入过滤。 */
const MAX_RENDER = 200;

export class ComboBox {
    readonly wrap: HTMLElement;
    readonly input: HTMLInputElement;
    /** 从浮层选中某一项时触发(自由输入场景走原生 change 事件)。 */
    onChange: (value: string) => void = () => undefined;

    private pop: HTMLElement | null = null;
    private items: ComboItem[] = [];
    private filtered: ComboItem[] = [];
    private active = -1;

    constructor(placeholder: string) {
        this.wrap = el("div", "sy-ai-agent-combo");
        this.input = el("input", "b3-text-field") as HTMLInputElement;
        this.input.placeholder = placeholder;
        this.input.spellcheck = false;
        this.wrap.append(this.input);

        this.input.addEventListener("focus", () => this.open());
        this.input.addEventListener("click", () => this.open());
        this.input.addEventListener("input", () => this.open());
        this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
        this.input.addEventListener("blur", () => this.close());
    }

    setItems(items: ComboItem[]): void {
        this.items = items;
        this.renderItems();
    }

    open(): void {
        if (this.pop) {
            this.renderItems();
            return;
        }
        const pop = el("div", "sy-ai-agent-combo-pop");
        document.body.append(pop);
        this.pop = pop;
        this.position();
        this.renderItems();
        window.addEventListener("mousedown", this.onDocMouseDown, true);
        window.addEventListener("resize", this.close);
        window.addEventListener("scroll", this.onScroll, true);
    }

    close = (): void => {
        if (!this.pop) {
            return;
        }
        this.pop.remove();
        this.pop = null;
        window.removeEventListener("mousedown", this.onDocMouseDown, true);
        window.removeEventListener("resize", this.close);
        window.removeEventListener("scroll", this.onScroll, true);
    };

    private onScroll = (e: Event): void => {
        // 浮层自身滚动不关闭
        if (this.pop && e.target instanceof Node && this.pop.contains(e.target)) {
            return;
        }
        this.close();
    };

    private onDocMouseDown = (e: MouseEvent): void => {
        if (this.pop?.contains(e.target as Node) || e.target === this.input) {
            return;
        }
        this.close();
    };

    private position(): void {
        const pop = this.pop;
        if (!pop) {
            return;
        }
        const rect = this.input.getBoundingClientRect();
        const maxH = 260;
        pop.style.left = `${rect.left}px`;
        pop.style.width = `${rect.width}px`;
        pop.style.maxHeight = `${maxH}px`;
        pop.style.top = "";
        pop.style.bottom = "";
        // 下方空间不足且上方够放时向上展开
        if (window.innerHeight - rect.bottom < maxH + 16 && rect.top > maxH + 16) {
            pop.style.bottom = `${window.innerHeight - rect.top + 4}px`;
        } else {
            pop.style.top = `${rect.bottom + 4}px`;
        }
    }

    private renderItems(): void {
        const pop = this.pop;
        if (!pop) {
            return;
        }
        const q = this.input.value.trim().toLowerCase();
        this.filtered = this.items.filter((it) =>
            !q || it.value.toLowerCase().includes(q) || (it.note ?? "").toLowerCase().includes(q));
        this.active = -1;
        pop.textContent = "";
        if (this.filtered.length === 0) {
            pop.append(el("div", "sy-ai-agent-combo-empty", t("comboNoMatch")));
            return;
        }
        let lastGroup: string | undefined;
        for (const [idx, it] of this.filtered.entries()) {
            if (idx >= MAX_RENDER) {
                pop.append(el("div", "sy-ai-agent-combo-label", t("comboMore", {count: this.filtered.length - MAX_RENDER})));
                break;
            }
            if (it.group !== lastGroup) {
                lastGroup = it.group;
                if (lastGroup) {
                    pop.append(el("div", "sy-ai-agent-combo-label", lastGroup));
                }
            }
            const item = el("div", "sy-ai-agent-combo-item");
            item.append(el("span", "sy-ai-agent-combo-id", it.value));
            if (it.note) {
                item.append(el("span", "sy-ai-agent-combo-note", it.note));
            }
            item.addEventListener("mousedown", (e) => {
                e.preventDefault();
                this.pick(it.value);
            });
            item.addEventListener("mousemove", () => this.setActive(idx));
            pop.append(item);
        }
    }

    private setActive(idx: number): void {
        this.active = idx;
        this.pop?.querySelectorAll(".sy-ai-agent-combo-item").forEach((n, i) => {
            n.classList.toggle("active", i === idx);
        });
    }

    private pick(value: string): void {
        this.input.value = value;
        this.close();
        this.input.focus();
        this.onChange(value);
    }

    private onKeyDown(e: KeyboardEvent): void {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!this.pop) {
                this.open();
                return;
            }
            const len = Math.min(this.filtered.length, MAX_RENDER);
            if (len === 0) {
                return;
            }
            const delta = e.key === "ArrowDown" ? 1 : -1;
            this.setActive((this.active + delta + len) % len);
            this.pop?.querySelectorAll(".sy-ai-agent-combo-item")[this.active]
                ?.scrollIntoView({block: "nearest"});
        } else if (e.key === "Enter" && this.pop) {
            if (this.active >= 0 && this.filtered[this.active]) {
                e.preventDefault();
                this.pick(this.filtered[this.active].value);
            } else {
                this.close();
            }
        } else if (e.key === "Escape") {
            this.close();
        }
    }
}
