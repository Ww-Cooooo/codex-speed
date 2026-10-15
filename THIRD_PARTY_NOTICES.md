# 第三方来源与许可

- **TokenPulse**：从 https://github.com/zzccchen/token-pulse 固定提交 `edc27b1ab28709e6906667ef50decf12c7002e35` 复用 domain / rollout / tailer / stats 核心，已收窄字段及隐私边界。MIT 许可和版权保留在 `backend/TOKENPULSE-LICENSE.txt`，改动见 `backend/THIRD_PARTY.md`。未使用该项目 EXE。
- **React、Ant Design、Ant Design Icons、AntV G2 / g-svg、Electron、Vite、TypeScript**：采用各自 npm 固定版本；原始许可随本地依赖保留，汇总在 `public/licenses/npm-notices.txt`。Pts 使用 Apache 2.0。
- **GSAP 与 @gsap/react**：适用 [GSAP Standard License](https://gsap.com/standard-license/)，不是 MIT。此处用于普通本地统计窗口的展开过渡；不提供动画制作工具。保留源码版权声明和许可链接。
- **Lenis 1.3.26**：MIT，来自 [官方仓库](https://github.com/darkroomengineering/lenis)。只用于多对话列表的平滑滚动；收起及减少动态效果时停止平滑处理，键盘和滚动条保留原生行为。许可已纳入本地依赖汇总。
- **Noto Sans SC / Space Grotesk**：自带字体，SIL OFL 1.1，许可证在 `public/licenses/`；不在运行时请求字体网站。
- **Barlow Condensed Medium 500**：用于紧凑面板的速度数字，来自 [google/fonts 官方字体源](https://github.com/google/fonts/tree/main/ofl/barlowcondensed)，版权归 The Barlow Project Authors，SIL OFL 1.1。字体在 `public/fonts/BarlowCondensed-Medium.ttf`，完整许可在 `public/licenses/BarlowCondensed-OFL.txt`；本地加载。
- **Electron / Chromium**：官方 Electron 44.7.0 Windows x64 运行环境，下载使用 npm Electron 包的内置校验和；许可在 `node_modules/electron/dist/LICENSE` 和 `LICENSES.chromium.html`。没有修改或替换成 TokenPulse 可执行文件。

设计研究使用官方及公开页面观察，不复制 MotionSites、Aceternity、React Bits、Uiverse 或 Anime.js 的界面代码或资产。托盘标记为本项目原创简单像素图。统计样例为本项目合成数据。

本项目自有代码采用根目录 LICENSE 中的 MIT 许可证。第三方代码、字体及运行环境继续适用各自许可证；项目 MIT 许可不覆盖或变更这些第三方许可，GSAP 也不是 MIT。
