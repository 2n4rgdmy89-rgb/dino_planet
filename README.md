# 恐龙星球项目备忘

一个原生 HTML/CSS/JavaScript 写的六边形演化策略小游戏。玩家从 252 Ma 的三叠纪早期开始扩张领地、积累人口和变异能力，在 66 Ma 陨石事件到来时尝试通过人口规模、总战力或适应演化幸存。

## 快速运行

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

## 项目结构

```text
index.html              页面骨架和挂载点
src/config.js           全局配置：时间轴、初始状态、胜利条件、地形表
src/gameState.js        初始状态组装入口
src/map.js              六边形坐标、地图生成、可见性和侦察逻辑
src/evolution.js        永久异变配置、稀有度费用和查询函数
src/randomEvents.js     随机事件池、事件选择和事件效果
src/rules.js            核心规则：扩张、AI、灾变、胜负、回合推进
src/ui.js               DOM 渲染、按钮事件、SVG 地图、弹窗和异变记录
src/styles.css          全部界面样式和动效
scripts/serve.mjs       本地静态服务器
test/rules.test.mjs     规则层测试
```

## 核心规则备忘

- 时间从 `START_MA = 252` 推进到 `END_MA = 66`，每回合减少 1 Ma。
- 每个 5Ma 周期开始会获得 1 个异变点，并从 4 个永久异变选项中选择 1 个。
- 4 选 1 前两个固定免费：繁殖能力 +1 或基础战力 +1；第 20 回合开放第一个高级槽，第 40 回合开放第二个高级槽。
- 高级异变分为力量、敏捷、适应三类；选择高级异变会让对应属性 +1。
- 高级槽默认刷新稀有异变；某属性达到 3 后，该属性下的罕见异变才有 20% 概率刷新。稀有消耗 5 点，罕见消耗 10 点。
- 胜利有三条路线：人口达到 `40000`，或总战力达到 `100`；霸王龙能力会把总战力目标降到 `50`；若已获得“飞向新世界”，终局时适应等级达到 `5` 也会胜利。
- 扩张要求总战力超过格子要求。
- 扩张人口要求是“当前人口必须大于消耗”，不是大于等于。
- 山地和水域不可占领。水域默认阻断视野，棘龙能力可以让视野穿过水域。
- AI 会开局生成两个隐藏族群，之后每 20 回合生成计划波次。
- 历史大灭绝在跨过 201 Ma 和 145 Ma 后触发，玩家和 AI 都会损失领地和 90% 人口。

## 常见修改位置

- 调地形收益或难度：改 `src/config.js` 的 `TERRAIN_TYPES` 和 `TERRAIN_WEIGHTS`。
- 加新高级异变：改 `src/evolution.js` 的 `EVOLUTION_NODES`，设置 `attribute`、`rarity`、`pressureTags` 和能力说明，再在 `src/rules.js` 对应能力 id 写规则。
- 调随机事件：改 `src/randomEvents.js` 的事件池，保持 `apply(state)` 返回 `{ state, effectSummary }`。
- 调 AI 强度：改 `src/rules.js` 顶部的 AI 常量和 `getAiFactionPower` / `runAiFactionTurn`。
- 改界面文案或弹窗：主要在 `src/ui.js`，静态骨架在 `index.html`。
- 改布局和视觉：改 `src/styles.css`，里面已按区域分段注释。

## 维护注意

- `rules.js` 尽量保持纯状态转换，不要在里面操作 DOM。
- `ui.js` 可以读规则派生值，但不要复制复杂规则公式。
- 地图格子是惰性生成的，只有进入可见、侦察、天眼或 AI 相关流程时才写入 `state.tiles`。
- 随机逻辑依赖 seed、turn 和 salt 保持可复现，改随机流程时要同步看测试。
- 项目使用原生 ES module，没有打包步骤；浏览器必须通过本地服务器访问，直接双击 HTML 可能受模块加载限制。
