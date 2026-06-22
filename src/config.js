// 全局玩法配置：这里集中放置时间轴、初始状态、胜利条件和地形表。
// 其他模块只读取这些常量，避免规则数字散落在 UI 或状态流转代码里。

// 游戏从三叠纪早期 252 Ma 开始，推进到白垩纪末 66 Ma。
// Ma 表示 million years ago，即“距今百万年”。
export const START_MA = 252;
export const END_MA = 66;
export const MAX_TURNS = START_MA - END_MA;

// 初始状态只放“可序列化、可复制”的基础值。
// 运行期派生字段，例如 tiles、visibleKeys、log，会在 gameState.js 中组装。
export const INITIAL_STATE = {
  currentMa: START_MA,
  turn: 0,
  population: 10,
  basePower: 1,
  temporaryPowerBonus: 0,
  reproduction: 1,
  currentSpeciesId: "primitive"
};

// 陨石事件发生时的两条幸存路线：
// 1. 人口规模足够大；2. 总战力足够高。
// 注意第二条胜利路线使用总战力判定，包含基础战力、地形加成和临时战力。
export const VICTORY = {
  population: 40000,
  basePower: 100
};

// 地形定义同时承担显示和规则职责。
// populationMultiplierDelta：占领后影响人口增长倍率。
// combatBonus：占领后的永久战力加成。
// combatModifier / populationCostModifier：生成新格子时影响征服门槛。
export const TERRAIN_TYPES = {
  origin: {
    id: "origin",
    label: "起源巢穴",
    conquerable: true,
    populationMultiplierDelta: 0,
    combatBonus: 0,
    combatModifier: 0,
    populationCostModifier: 0,
    color: "#b9a36a",
    description: "最初的栖息地，没有额外增益。"
  },
  grassland: {
    id: "grassland",
    label: "温暖湿地",
    conquerable: true,
    populationMultiplierDelta: 1,
    combatBonus: 0,
    combatModifier: -1,
    populationCostModifier: -1,
    color: "#76a85b",
    description: "温暖、食物稳定，永久提高人口增长倍率。"
  },
  forest: {
    id: "forest",
    label: "森林",
    conquerable: true,
    populationMultiplierDelta: 0,
    combatBonus: 0,
    temporaryCombatBonus: 1,
    combatModifier: 0,
    populationCostModifier: 0,
    color: "#2f7d65",
    description: "掩护和猎物丰富，占领后到下一个 5Ma 强化节点前临时战力 +1。"
  },
  desert: {
    id: "desert",
    label: "沙漠",
    conquerable: true,
    populationMultiplierDelta: -1,
    combatBonus: 1,
    combatModifier: 1,
    populationCostModifier: 2,
    color: "#c98f45",
    description: "环境严酷，降低人口倍率，但磨炼战力。"
  },
  mountain: {
    id: "mountain",
    label: "山地",
    conquerable: false,
    populationMultiplierDelta: 0,
    combatBonus: 0,
    combatModifier: 0,
    populationCostModifier: 0,
    color: "#7c8280",
    description: "陡峭山地无法被征服，会阻挡领地继续向该方向扩张。"
  },
  water: {
    id: "water",
    label: "水域",
    conquerable: false,
    populationMultiplierDelta: 0,
    combatBonus: 0,
    combatModifier: 0,
    populationCostModifier: 0,
    color: "#3f85a6",
    description: "深水区域无法被征服，会阻挡领地继续向该方向扩张。"
  }
};

// 随机生成普通格子时的地形权重，总和约为 1。
// origin 不参与随机生成，只会在 (0,0) 创建。
export const TERRAIN_WEIGHTS = [
  ["grassland", 0.32],
  ["forest", 0.28],
  ["desert", 0.22],
  ["mountain", 0.1],
  ["water", 0.08]
];
