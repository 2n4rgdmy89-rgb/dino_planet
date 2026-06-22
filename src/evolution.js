// 稳定异变配置：每个节点描述一个可永久继承的形态和能力。
// 规则模块根据 rarity、压力标签和已解锁状态生成每个周期的高级候选。

export const MUTATION_RARITY = {
  rare: {
    id: "rare",
    label: "稀有",
    cost: 5
  },
  uncommon: {
    id: "uncommon",
    label: "罕见",
    cost: 10
  }
};

export const MUTATION_ATTRIBUTES = {
  power: {
    id: "power",
    label: "力量"
  },
  agility: {
    id: "agility",
    label: "敏捷"
  },
  adaptation: {
    id: "adaptation",
    label: "适应"
  }
};

export const EVOLUTION_NODES = [
  {
    id: "primitive",
    name: "原始小型肉食恐龙",
    minPower: 1,
    minReproduction: 1,
    tier: 0,
    mutationCost: 0,
    rarity: "basic",
    attribute: null,
    pressureTags: [],
    abilityId: null,
    abilityName: "原始种群",
    abilityDescription: "没有特殊能力，是所有变异分支的起点。"
  },
  {
    id: "coelophysis",
    name: "腔骨龙型",
    minPower: 2,
    minReproduction: 3,
    tier: 1,
    abilityId: "light_cluster",
    rarity: "rare",
    attribute: "agility",
    pressureTags: ["low_population", "growth_focus", "early_game"],
    abilityName: "轻捷集群",
    abilityDescription: "人口增长额外获得 30%。"
  },
  {
    id: "herrerasaurus",
    name: "始盗龙/艾雷拉龙型",
    minPower: 3,
    minReproduction: 2,
    tier: 1,
    abilityId: "ambush_hunter",
    rarity: "rare",
    attribute: "power",
    pressureTags: ["ai_border", "power_focus", "early_game"],
    abilityName: "伏击猎手",
    abilityDescription: "扩张时人口消耗降低 20%，四舍五入，最低为 1。"
  },
  {
    id: "dilophosaurus",
    name: "双脊龙型",
    minPower: 4,
    minReproduction: 3,
    tier: 2,
    abilityId: "crest_threat",
    rarity: "rare",
    attribute: "power",
    pressureTags: ["forest_frontier", "power_focus"],
    abilityName: "威吓冠饰",
    abilityDescription: "普通格子的战力要求视为 -1，最低为 0。"
  },
  {
    id: "ceratosaurus",
    name: "角鼻龙型",
    minPower: 6,
    minReproduction: 3,
    tier: 3,
    abilityId: "skull_charge",
    rarity: "rare",
    attribute: "power",
    pressureTags: ["desert_owned", "power_focus"],
    abilityName: "厚颅冲撞",
    abilityDescription: "沙漠领地的永久战力奖励额外 +0.5。"
  },
  {
    id: "desert_brood",
    name: "沙漠育巢",
    minPower: 5,
    minReproduction: 4,
    tier: 2,
    abilityId: "desert_brood",
    rarity: "rare",
    attribute: "power",
    pressureTags: ["desert_owned", "growth_focus"],
    abilityName: "沙漠育巢",
    abilityDescription: "沙漠领地的人口倍率额外 +0.5，部分抵消沙漠的繁殖惩罚。"
  },
  {
    id: "bloodless_assault",
    name: "无损掠袭",
    minPower: 7,
    minReproduction: 3,
    tier: 3,
    abilityId: "bloodless_assault",
    rarity: "rare",
    attribute: "power",
    pressureTags: ["ai_border", "power_focus"],
    abilityName: "无损掠袭",
    abilityDescription: "攻占敌群领地时，玩家人口消耗减半，向上取整。"
  },
  {
    id: "mountain_hold",
    name: "山地据守",
    minPower: 7,
    minReproduction: 3,
    tier: 3,
    abilityId: "mountain_hold",
    rarity: "rare",
    attribute: "power",
    pressureTags: ["exploration_blocked", "power_focus"],
    abilityName: "山地据守",
    abilityDescription: "可以占领山地；每个山地领地提供永久总战力 +1。"
  },
  {
    id: "carnotaurus",
    name: "食肉牛龙型",
    minPower: 8,
    minReproduction: 4,
    tier: 4,
    abilityId: "burst_stride",
    rarity: "rare",
    attribute: "agility",
    pressureTags: ["rapid_expansion", "late_game"],
    abilityName: "短距爆发",
    abilityDescription: "每个 5Ma 周期第一次扩张不消耗人口。"
  },
  {
    id: "wetland_brood",
    name: "湿地繁殖",
    minPower: 3,
    minReproduction: 5,
    tier: 2,
    abilityId: "wetland_brood",
    rarity: "rare",
    attribute: "agility",
    pressureTags: ["grassland_owned", "growth_focus"],
    abilityName: "湿地繁殖",
    abilityDescription: "湿地领地的人口倍率额外 +1，可与其他湿地繁殖加成叠加。"
  },
  {
    id: "nimble_advance",
    name: "轻捷推进",
    minPower: 4,
    minReproduction: 4,
    tier: 2,
    abilityId: "nimble_advance",
    rarity: "rare",
    attribute: "agility",
    pressureTags: ["rapid_expansion", "power_focus"],
    abilityName: "轻捷推进",
    abilityDescription: "所有扩张目标的最终战力要求 -1，最低为 0。"
  },
  {
    id: "water_settlement",
    name: "水域栖居",
    minPower: 4,
    minReproduction: 5,
    tier: 2,
    abilityId: "water_settlement",
    rarity: "rare",
    attribute: "agility",
    pressureTags: ["water_frontier", "exploration_blocked", "growth_focus"],
    abilityName: "水域栖居",
    abilityDescription: "可以占领水域；每个水域领地提供人口倍率 +1。"
  },
  {
    id: "allosaurus",
    name: "异特龙型",
    minPower: 7,
    minReproduction: 3,
    tier: 3,
    abilityId: "pack_hunt",
    rarity: "rare",
    attribute: "power",
    pressureTags: ["many_tiles", "power_focus"],
    abilityName: "群猎",
    abilityDescription: "每拥有 5 个领地，总战力额外 +1。"
  },
  {
    id: "giganotosaurus",
    name: "鲨齿龙/南方巨兽龙型",
    minPower: 11,
    minReproduction: 3,
    tier: 4,
    abilityId: "giant_pressure",
    rarity: "uncommon",
    attribute: "power",
    disabled: true,
    pressureTags: ["power_focus", "ai_border", "late_game"],
    abilityName: "巨兽压制",
    abilityDescription: "可以扩张到战力要求等于总战力的格子。"
  },
  {
    id: "last_stand_surge",
    name: "濒死暴起",
    minPower: 10,
    minReproduction: 3,
    tier: 5,
    abilityId: "last_stand_surge",
    rarity: "uncommon",
    attribute: "power",
    pressureTags: ["low_population", "power_focus", "late_game"],
    abilityName: "濒死暴起",
    abilityDescription: "选择时人口回到 1，基础战力永久 +50。"
  },
  {
    id: "spinosaurid",
    name: "早期棘龙型",
    minPower: 7,
    minReproduction: 4,
    tier: 3,
    abilityId: "shore_adaptation",
    rarity: "rare",
    attribute: "adaptation",
    disabled: true,
    pressureTags: ["water_frontier", "growth_focus"],
    abilityName: "滨岸适应",
    abilityDescription: "水域旁的可征服格子人口消耗 -2，最低为 1。"
  },
  {
    id: "spinosaurus",
    name: "棘龙型",
    minPower: 10,
    minReproduction: 4,
    tier: 4,
    abilityId: "water_passage",
    rarity: "uncommon",
    attribute: "adaptation",
    disabled: true,
    pressureTags: ["water_frontier", "late_game"],
    abilityName: "涉水通道",
    abilityDescription: "水域不再阻断视野扩张，但仍不可占领。"
  },
  {
    id: "tyrannosauroid",
    name: "早期暴龙型",
    minPower: 6,
    minReproduction: 5,
    tier: 3,
    abilityId: "scent_tracking",
    rarity: "rare",
    attribute: "agility",
    pressureTags: ["exploration_blocked", "late_game"],
    abilityName: "嗅觉追踪",
    abilityDescription: "每回合可看到当前边界外一圈额外候选格子；普通扩张人口消耗 -1，最低为 1。"
  },
  {
    id: "yutyrannus",
    name: "羽暴龙型",
    minPower: 8,
    minReproduction: 5,
    tier: 4,
    abilityId: "thermal_plumage",
    rarity: "uncommon",
    attribute: "adaptation",
    disabled: true,
    pressureTags: ["low_population", "post_extinction", "growth_focus"],
    abilityName: "羽毛保温",
    abilityDescription: "选择免费繁殖异变时，额外获得 +1 人口。"
  },
  {
    id: "tyrannosaurus",
    name: "霸王龙型",
    minPower: 13,
    minReproduction: 4,
    tier: 5,
    abilityId: "apex_bite",
    rarity: "uncommon",
    attribute: "power",
    pressureTags: ["power_focus", "late_game"],
    abilityName: "顶级咬合",
    abilityDescription: "总战力胜利目标从 100 降到 50。"
  },
  {
    id: "coelurosaur",
    name: "小型虚骨龙型",
    minPower: 4,
    minReproduction: 6,
    tier: 2,
    abilityId: "agile_breeding",
    rarity: "rare",
    attribute: "adaptation",
    disabled: true,
    pressureTags: ["grassland_owned", "growth_focus"],
    abilityName: "敏捷繁殖",
    abilityDescription: "草地领地的人口倍率额外 +1。"
  },
  {
    id: "adaptive_mutation_gain_1",
    name: "适应增殖",
    minPower: 2,
    minReproduction: 3,
    tier: 2,
    abilityId: "adaptive_mutation_gain_1",
    rarity: "rare",
    attribute: "adaptation",
    pressureTags: ["growth_focus", "post_extinction"],
    abilityName: "适应增殖",
    abilityDescription: "每个 5Ma 周期获得变异点额外 +0.5。"
  },
  {
    id: "adaptive_mutation_gain_2",
    name: "适应共振",
    minPower: 2,
    minReproduction: 4,
    tier: 2,
    abilityId: "adaptive_mutation_gain_2",
    rarity: "rare",
    attribute: "adaptation",
    pressureTags: ["growth_focus", "late_game"],
    abilityName: "适应共振",
    abilityDescription: "每个 5Ma 周期获得变异点额外 +0.5，可与适应增殖叠加。"
  },
  {
    id: "feather_growth",
    name: "获得羽毛",
    minPower: 3,
    minReproduction: 4,
    tier: 2,
    abilityId: "feather_growth",
    rarity: "rare",
    attribute: "adaptation",
    pressureTags: ["low_population", "post_extinction"],
    abilityName: "获得羽毛",
    abilityDescription: "获得羽毛特征，提升适应等级；每回合人口增长额外 +2。"
  },
  {
    id: "quill_growth",
    name: "获得羽管",
    minPower: 3,
    minReproduction: 5,
    tier: 3,
    abilityId: "quill_growth",
    rarity: "rare",
    attribute: "adaptation",
    pressureTags: ["growth_focus", "late_game"],
    abilityName: "获得羽管",
    abilityDescription: "获得羽管结构，提升适应等级；每拥有 5 个领地，人口倍率额外 +1。"
  },
  {
    id: "flight_to_new_world",
    name: "飞向新世界",
    minPower: 4,
    minReproduction: 7,
    tier: 5,
    abilityId: "flight_to_new_world",
    rarity: "uncommon",
    attribute: "adaptation",
    pressureTags: ["late_game", "post_extinction", "growth_focus"],
    abilityName: "飞向新世界",
    abilityDescription: "选择时返还 2 变异点；每个 5Ma 周期获得变异点额外 +1；若终局时适应等级达到 5，触发适应胜利。"
  },
  {
    id: "dromaeosaur",
    name: "恐爪龙/伶盗龙型",
    minPower: 6,
    minReproduction: 7,
    tier: 3,
    abilityId: "sickle_raid",
    rarity: "uncommon",
    attribute: "agility",
    pressureTags: ["rapid_expansion", "growth_focus"],
    abilityName: "镰爪突袭",
    abilityDescription: "每个周期第一次扩张不消耗本回合扩张次数。"
  },
  {
    id: "microraptor",
    name: "小盗龙型",
    minPower: 5,
    minReproduction: 9,
    tier: 4,
    abilityId: "glide_spread",
    rarity: "rare",
    attribute: "agility",
    pressureTags: ["exploration_blocked", "rapid_expansion", "late_game"],
    abilityName: "滑翔扩散",
    abilityDescription: "扩张后额外揭示新领地周围第二圈中最多 2 个格子。"
  },
  {
    id: "brood_focus",
    name: "繁殖专注",
    minPower: 6,
    minReproduction: 10,
    tier: 5,
    abilityId: "brood_focus",
    rarity: "uncommon",
    attribute: "agility",
    pressureTags: ["low_population", "growth_focus", "late_game"],
    abilityName: "繁殖专注",
    abilityDescription: "选择时繁殖能力永久 +20；之后不能攻打敌群领地。"
  }
].map((node) => ({
  // 费用由稀有度决定；primitive 和基础成长不作为高级候选。
  ...node,
  mutationCost: node.mutationCost ?? MUTATION_RARITY[node.rarity]?.cost ?? 0
}));

const NODE_BY_ID = new Map(EVOLUTION_NODES.map((node) => [node.id, node]));

export function getSpeciesNode(id) {
  // 外部传入未知 id 时回退到 primitive，避免 UI 因坏状态直接崩溃。
  return NODE_BY_ID.get(id) ?? NODE_BY_ID.get("primitive");
}

export function getAdvancedMutationNodes() {
  return EVOLUTION_NODES.filter((node) => node.id !== "primitive" && !node.disabled && MUTATION_RARITY[node.rarity]);
}

export function getMutationRarity(rarityId) {
  return MUTATION_RARITY[rarityId] ?? null;
}

export function getMutationAttribute(attributeId) {
  return MUTATION_ATTRIBUTES[attributeId] ?? null;
}
