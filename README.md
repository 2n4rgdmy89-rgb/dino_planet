# 恐龙星球

一个原生 HTML/CSS/JavaScript 写成的六边形演化策略小游戏。玩家从 252 Ma 的三叠纪早期开始扩张领地、积累人口和异变能力，在 66 Ma 陨石事件到来时尝试幸存。

## 在线游玩

推送到 GitHub 后，GitHub Pages 会通过 `.github/workflows/pages.yml` 自动发布静态版。

预计地址：

```text
https://2n4rgdmy89-rgb.github.io/dino_planet/
```

静态版不需要 Flask 后端。保存和读取使用玩家当前浏览器的 `localStorage`，不会跨设备同步。

## 本地运行

```bash
npm.cmd start
```

默认地址：

```text
http://localhost:4173
```

如果 PowerShell 不能直接执行 `npm`，用 `npm.cmd`。测试命令同理：

```bash
npm.cmd test
```

## 带后端运行

Flask 后端用于本地服务端存档 API，不是 GitHub Pages 发布的必要条件。

```bash
npm.cmd backend
```

默认地址：

```text
http://localhost:5000
```

## 项目结构

```text
index.html              页面骨架和挂载点
src/config.js           全局配置：时间轴、初始状态、胜利条件、地形表
src/gameState.js        初始状态组装入口
src/map.js              六边形坐标、地图生成、可见性和侦察逻辑
src/evolution.js        永久异变配置、稀有度费用和查询函数
src/randomEvents.js     随机事件池、事件选择和事件效果
src/rules.js            核心规则：扩张、AI、灾变、胜负、回合推进
src/saveGame.js         本地存档和可选服务端存档
src/ui.js               DOM 渲染、按钮事件、SVG 地图、弹窗和异变记录
src/styles.css          全部界面样式和动效
scripts/serve.mjs       本地静态服务器
backend/app.py          Flask 静态文件服务和存档 API
test/                   规则和存档测试
```

## 维护注意

- `rules.js` 保持纯状态转换，不要操作 DOM。
- `ui.js` 可以读取规则派生值，但不要复制复杂规则公式。
- 地图格子是惰性生成的，只有进入可见、侦察、天眼或 AI 相关流程时才写入 `state.tiles`。
- 随机逻辑依赖 seed、turn 和 salt 保持可复现，改随机流程时要同步看测试。
- 项目使用原生 ES module，没有打包步骤；浏览器应通过 HTTP 服务访问，不要直接双击 HTML。
