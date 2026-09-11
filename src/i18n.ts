/**
 * 界面与工具文案 i18n:跟随思源界面语言(window.siyuan.config.lang)。
 * 两份语言包随插件打包(同时由 webpack 拷贝到 dist/i18n/ 供思源插件加载器读取);
 * 思源切换界面语言后本身要求重启,因此语言在插件加载时一次定型,不做动态跟随。
 */
import enUS from "./i18n/en_US.json";
import zhCN from "./i18n/zh_CN.json";

/** 当前思源界面是否为中文(zh_CN / zh_CHT 等)。 */
export function isZh(): boolean {
    const lang = (window.siyuan?.config?.lang ?? "") as string;
    return lang.toLowerCase().startsWith("zh");
}

let dict: Record<string, string> = isZh() ? {...enUS, ...zhCN} : {...enUS};

/**
 * 插件 onload 时以思源注入的 this.i18n 覆盖内置语言包。
 * 思源按界面语言加载 i18n/<lang>.json(缺失时回退 en_US),与内置包一致,双保险。
 */
export function initI18n(pluginI18n?: Record<string, string> | null): void {
    dict = {
        ...enUS,
        ...(isZh() ? zhCN : {}),
        ...(pluginI18n ?? {}),
    };
}

/** 取文案,{var} 占位符替换;缺键时返回键名,便于发现遗漏。 */
export function t(key: string, vars?: Record<string, string | number>): string {
    let s = dict[key] ?? key;
    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            s = s.split(`{${k}}`).join(String(v));
        }
    }
    return s;
}
