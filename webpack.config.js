const path = require("path");
const fs = require("fs");
const webpack = require("webpack");
const {EsbuildPlugin} = require("esbuild-loader");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyPlugin = require("copy-webpack-plugin");

// pi-ai 及其依赖(各家官方 SDK)引用了大量 Node 内建模块。
// 思源渲染进程 nodeIntegration: true, 运行时可通过 window.require 取到真正的 Node 模块,
// 因此这里为每个内建模块生成一个转发 shim,缺失环境下仅在实际调用时抛错。
const NODE_BUILTINS = [
    "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
    "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http",
    "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks",
    "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys",
    "timers", "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
];

const shimsDir = path.resolve(__dirname, ".shims");
fs.mkdirSync(shimsDir, {recursive: true});
for (const builtin of NODE_BUILTINS) {
    const spec = builtin.startsWith("node:") ? builtin : `node:${builtin}`;
    fs.writeFileSync(
        path.join(shimsDir, `${builtin}.js`),
        `"use strict";\n` +
        `function nodeReq() {\n` +
        `  if (typeof window !== "undefined" && window.require) return window.require;\n` +
        `  if (typeof globalThis.require === "function") return globalThis.require;\n` +
        `  return null;\n` +
        `}\n` +
        `let real;\n` +
        `try { const r = nodeReq(); real = r ? r(${JSON.stringify(spec)}) : null; } catch (e) { real = null; }\n` +
        `module.exports = real !== null && (typeof real === "object" || typeof real === "function")\n` +
        `  ? real\n` +
        `  : new Proxy(function () {}, {\n` +
        `      get(target, prop) {\n` +
        `        if (prop === "__esModule") return false;\n` +
        `        if (prop === "default") return module.exports;\n` +
        `        throw new Error("Node builtin '${builtin}' is not available in this frontend (browser frontends cannot use Node modules).");\n` +
        `      },\n` +
        `      apply() {\n` +
        `        throw new Error("Node builtin '${builtin}' is not available in this frontend (browser frontends cannot use Node modules).");\n` +
        `      },\n` +
        `    });\n`,
    );
}

module.exports = (env, argv) => {
    const production = argv.mode === "production";
    return {
        mode: argv.mode || "development",
        devtool: production ? false : "eval-source-map",
        output: {
            filename: "index.js",
            path: production ? path.resolve(__dirname, "dist") : path.resolve(__dirname),
            publicPath: "",
            libraryTarget: "commonjs2",
            library: {type: "commonjs2"},
        },
        externals: {
            siyuan: "commonjs siyuan",
        },
        resolve: {
            extensions: [".ts", ".js", ".json"],
            alias: Object.fromEntries(NODE_BUILTINS.flatMap((b) => [
                [b, path.join(shimsDir, `${b}.js`)],
                [`node:${b}`, path.join(shimsDir, `${b}.js`)],
            ])),
            fallback: {
                process: require.resolve("process/browser.js"),
            },
        },
        entry: "./src/index.ts",
        optimization: {
            // 注意:不要用 esbuild-loader 的 EsbuildPlugin 压缩——它会重排 webpack 的
            // commonjs2 输出,丢掉对思源插件加载器注入的 module.exports 的赋值
            concatenateModules: false,
        },
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    include: [path.resolve(__dirname, "src")],
                    use: [{loader: "esbuild-loader", options: {target: "es2022", loader: "ts"}}],
                },
                {
                    test: /\.css$/,
                    include: [path.resolve(__dirname, "src")],
                    use: [MiniCssExtractPlugin.loader, "css-loader"],
                },
            ],
        },
        plugins: [
            // 思源只加载 index.js,把动态 import 产生的异步 chunk 全部合并进主文件
            new webpack.optimize.LimitChunkCountPlugin({maxChunks: 1}),
            new webpack.ProvidePlugin({
                process: "process/browser.js",
                global: ["process/browser.js", "global"],
            }),
            new MiniCssExtractPlugin({
                filename: production ? "index.css" : "index.css",
            }),
            new CopyPlugin({
                patterns: [
                    {from: "plugin.json", to: "./"},
                    {from: "README.md", to: "./"},
                    {from: "src/i18n/", to: "./i18n/"},
                    {from: "icon.png", to: "./", noErrorOnMissing: true},
                    {from: "preview.png", to: "./", noErrorOnMissing: true},
                ],
            }),
        ],
    };
};
