import { TERRAIN_TYPES } from "./config.js";
import {
  coordinateSeed,
  ensureVisibleTiles,
  generateTileCombatRequirement,
  generateTilePopulationCost,
  mulberry32,
  revealSecondRingTiles,
  resetPlayerRevealedTiles
} from "./map.js";

// 随机事件模块只负责“选择事件”和“把事件效果应用到状态”。
// 回合流程、弹窗和日志由 rules.js / ui.js 处理。

const ORIGIN_KEY = "0,0";

// maxRoll 使用半开区间：roll < maxRoll。
// 因此 0-59 普通，60-89 稀有，90-99 罕见。
export const RANDOM_EVENT_RARITIES = [
  { id: "common", label: "普通", maxRoll: 60 },
  { id: "rare", label: "稀有", maxRoll: 90 },
  { id: "legendary", label: "罕见", maxRoll: 100 }
];

function clampPopulation(value) {
  // 人口始终保持非负整数，避免百分比损失后出现小数或负数。
  return Math.max(0, Math.floor(value));
}

function getOwnedTiles(state) {
  return [...state.tiles.values()].filter((tile) => tile.owned);
}

function getActiveOwnedCoord(state) {
  // 事件可能移除当前选中的领地；若 activeCoord 失效，则回退到排序后的第一个领地。
  const activeTile = state.tiles.get(`${state.activeCoord?.q},${state.activeCoord?.r}`);
  if (activeTile?.owned) return state.activeCoord;
  const ownedTile = getOwnedTiles(state).sort((left, right) => left.key.localeCompare(right.key))[0];
  return ownedTile ? { q: ownedTile.q, r: ownedTile.r } : { q: 0, r: 0 };
}

function resetAndEnsureVisibleTiles(state) {
  return ensureVisibleTiles(resetPlayerRevealedTiles(state));
}

function shuffleTiles(tiles, random) {
  // 先按 key 排序再洗牌，确保同一 seed 下事件结果稳定。
  const shuffled = [...tiles].sort((left, right) => left.key.localeCompare(right.key));
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function removePlayerTiles(state, count, random) {
  // 随机领地损失保护起源格，降低普通事件把玩家直接判死的概率。
  const removableTiles = getOwnedTiles(state).filter((tile) => tile.key !== ORIGIN_KEY);
  const removedTiles = shuffleTiles(removableTiles, random).slice(0, Math.max(0, count));
  if (removedTiles.length === 0) {
    return { state, removedCount: 0 };
  }

  const nextTiles = new Map(state.tiles);
  for (const tile of removedTiles) {
    nextTiles.set(tile.key, {
      ...tile,
      owned: false,
      revealed: false,
      scouted: false
    });
  }

  return {
    state: resetAndEnsureVisibleTiles({
      ...state,
      tiles: nextTiles,
      activeCoord: getActiveOwnedCoord({ ...state, tiles: nextTiles })
    }),
    removedCount: removedTiles.length
  };
}

function removeAiTiles(state, factionId, count, random) {
  // AI 领地没有起源保护，灾变和生态崩塌可以直接清空某个敌对族群。
  const aiTiles = [...state.tiles.values()].filter((tile) => tile.aiFactionId === factionId);
  const removedTiles = shuffleTiles(aiTiles, random).slice(0, Math.max(0, count));
  const nextTiles = new Map(state.tiles);

  for (const tile of removedTiles) {
    nextTiles.set(tile.key, {
      ...tile,
      aiFactionId: null,
      revealed: false,
      scouted: false
    });
  }

  return {
    state: {
      ...state,
      tiles: nextTiles
    },
    removedCount: removedTiles.length
  };
}

function applyTerrainToTile(state, tile, nextTerrainId) {
  // 地形转换会重算该格子的战力/人口成本，使用原 generatedTurn 保持难度曲线一致。
  const terrain = TERRAIN_TYPES[nextTerrainId];
  const generatedTurn = tile.generatedTurn ?? state.turn;
  const random = mulberry32(coordinateSeed(state.seed, tile, generatedTurn, state.terrainEpoch ?? 0));
  const conquerable = terrain.conquerable;
  const nextTile = {
    ...tile,
    terrain: nextTerrainId,
    combatRequired: conquerable ? generateTileCombatRequirement(generatedTurn, nextTerrainId, random) : 0,
    populationCost: conquerable ? generateTilePopulationCost(generatedTurn, nextTerrainId, random) : 0,
    populationMultiplierDelta: terrain.populationMultiplierDelta,
    combatBonus: terrain.combatBonus,
    conquerable
  };

  if (!conquerable) {
    // 变成水域或山地时，玩家和 AI 都会失去这个格子。
    return {
      ...nextTile,
      owned: false,
      aiFactionId: null,
      revealed: false,
      scouted: false
    };
  }

  return nextTile;
}

function convertTerrain(state, fromTerrainId, toTerrainId) {
  // 批量地形事件会扫描所有已生成格子；尚未生成的远方地图不受影响。
  let convertedCount = 0;
  const nextTiles = new Map();
  let playerLostTerritory = false;

  for (const [key, tile] of state.tiles) {
    if (tile.terrain === fromTerrainId) {
      convertedCount += 1;
      const nextTile = applyTerrainToTile(state, tile, toTerrainId);
      if (tile.owned && !nextTile.owned) {
        playerLostTerritory = true;
      }
      nextTiles.set(key, nextTile);
    } else {
      nextTiles.set(key, tile);
    }
  }

  const nextState = {
    ...state,
    tiles: nextTiles
  };

  const stateWithActiveCoord = {
    ...nextState,
    activeCoord: getActiveOwnedCoord(nextState)
  };

  return {
    state: playerLostTerritory ? resetAndEnsureVisibleTiles(stateWithActiveCoord) : stateWithActiveCoord,
    convertedCount
  };
}

function revealFromActiveCoord(state, count) {
  // 侦察类事件从当前有效领地向第二圈揭示，返回实际新增数量用于文案。
  const activeCoord = getActiveOwnedCoord(state);
  const beforeCount = state.extraRevealedKeys?.length ?? 0;
  const nextState = revealSecondRingTiles({ ...state, activeCoord }, activeCoord, count);
  const revealedCount = (nextState.extraRevealedKeys?.length ?? 0) - beforeCount;
  return {
    state: nextState,
    revealedCount
  };
}

function applyPercentLoss(population, rate, minimumLoss) {
  // 百分比损失设置最低损失值，使小人口也能感受到负面事件。
  if (population <= 0) return 0;
  const loss = Math.min(population, Math.max(minimumLoss, Math.floor(population * rate)));
  return clampPopulation(population - loss);
}

function getPercentLoss(population, rate, minimumLoss) {
  if (population <= 0) return 0;
  return Math.min(population, Math.max(minimumLoss, Math.floor(population * rate)));
}

function applyAllAiPopulationLoss(state, rate, minimumLoss) {
  const aiFactions = state.aiFactions ?? [];
  if (aiFactions.length === 0) {
    return { state, totalLoss: 0, affectedCount: 0 };
  }

  let totalLoss = 0;
  const nextAiFactions = aiFactions.map((faction) => {
    const population = faction.population ?? 0;
    const loss = getPercentLoss(population, rate, minimumLoss);
    totalLoss += loss;
    return {
      ...faction,
      population: clampPopulation(population - loss)
    };
  });

  return {
    state: { ...state, aiFactions: nextAiFactions },
    totalLoss,
    affectedCount: aiFactions.length
  };
}

function applyAllAiBasePowerLoss(state, lossAmount) {
  const aiFactions = state.aiFactions ?? [];
  if (aiFactions.length === 0) {
    return { state, totalLoss: 0, affectedCount: 0 };
  }

  let totalLoss = 0;
  const nextAiFactions = aiFactions.map((faction) => {
    const previousPower = faction.basePower ?? 1;
    const nextPower = Math.max(0, previousPower - lossAmount);
    totalLoss += previousPower - nextPower;
    return {
      ...faction,
      basePower: nextPower
    };
  });

  return {
    state: { ...state, aiFactions: nextAiFactions },
    totalLoss,
    affectedCount: aiFactions.length
  };
}

// 事件对象约定：
// id 用于测试和调试；title/message 用于 UI；apply 返回 { state, effectSummary }。
// effectSummary 会进入日志和事件弹窗，必须简短描述状态变化。
const COMMON_EVENTS = [
  {
    id: "warm_wet_spell",
    title: "短暂暖湿期",
    message: "湿润气候让幼体更容易存活，种群在短时间内扩张。",
    apply(state) {
      const gain = state.reproduction * 2;
      return {
        state: { ...state, population: state.population + gain },
        effectSummary: `人口 +${gain}`
      };
    }
  },
  {
    id: "prey_migration",
    title: "猎物迁徙",
    message: "大批猎物穿过领地，捕食窗口短暂打开。",
    apply(state) {
      return {
        state: { ...state, population: state.population + 6 },
        effectSummary: "人口 +6"
      };
    }
  },
  {
    id: "nest_alert",
    title: "巢穴警觉",
    message: "边缘巢穴发现异常踪迹，族群掌握了更远处的地形。",
    apply(state) {
      const result = revealFromActiveCoord(state, 2);
      return {
        state: result.state,
        effectSummary: `额外揭示 ${result.revealedCount} 个格子`
      };
    }
  },
  {
    id: "forest_ambush",
    title: "林间伏击",
    message: "族群借助密林伏击猎物，短期战力上升。",
    apply(state) {
      return {
        state: { ...state, temporaryPowerBonus: (state.temporaryPowerBonus ?? 0) + 1 },
        effectSummary: "临时战力 +1"
      };
    }
  },
  {
    id: "small_prey_boom",
    title: "小型猎物繁盛",
    message: "小型猎物大量出现，带来食物与新的演化压力。",
    apply(state) {
      return {
        state: {
          ...state,
          population: state.population + 4,
          mutationPoints: (state.mutationPoints ?? 0) + 1
        },
        effectSummary: "人口 +4，变异点 +1"
      };
    }
  },
  {
    id: "dry_season_pressure",
    title: "旱季压力",
    message: "干旱削弱了猎物补给，幼体存活率下降。",
    apply(state) {
      const nextPopulation = applyPercentLoss(state.population, 0.1, 1);
      return {
        state: { ...state, population: nextPopulation },
        effectSummary: `人口 -${state.population - nextPopulation}`
      };
    }
  },
  {
    id: "enemy_food_shortage",
    title: "敌群食物短缺",
    message: "周边敌群的猎物供给断裂，所有敌群都被迫缩减规模。",
    apply(state) {
      const result = applyAllAiPopulationLoss(state, 0.2, 1);
      return {
        state: result.state,
        effectSummary: result.affectedCount > 0 ? `所有敌群人口 -${result.totalLoss}` : "没有敌群受到影响"
      };
    }
  },
  {
    id: "failed_hunt",
    title: "捕猎失手",
    message: "连续失败的围猎让族群暂时失去压制力。",
    apply(state) {
      const previousPower = state.temporaryPowerBonus ?? 0;
      const nextPower = Math.max(0, previousPower - 1);
      return {
        state: { ...state, temporaryPowerBonus: nextPower },
        effectSummary: `临时战力 -${previousPower - nextPower}`
      };
    }
  },
  {
    id: "border_habitat_unrest",
    title: "边缘栖地动荡",
    message: "边缘栖地开始崩解，族群不得不放弃部分外围区域。",
    apply(state, random) {
      const result = removePlayerTiles(state, 1, random);
      if (result.removedCount > 0) {
        return {
          state: result.state,
          effectSummary: `失去 ${result.removedCount} 个领地`
        };
      }
      const loss = Math.min(state.population, 2);
      return {
        state: { ...state, population: clampPopulation(state.population - loss) },
        effectSummary: `人口 -${loss}`
      };
    }
  }
];

// 稀有事件通常有更强的正负效果，包括地形转换和 AI 状态变化。
const RARE_EVENTS = [
  {
    id: "volcanic_ash",
    title: "火山灰遮天",
    message: "火山灰遮蔽天空，环境压力推动少数幸存血脉变异。",
    apply(state) {
      const nextPopulation = applyPercentLoss(state.population, 0.2, 1);
      return {
        state: {
          ...state,
          population: nextPopulation,
          mutationPoints: (state.mutationPoints ?? 0) + 1
        },
        effectSummary: `人口 -${state.population - nextPopulation}，变异点 +1`
      };
    }
  },
  {
    id: "rival_infighting",
    title: "竞争族群内斗",
    message: "敌对族群同时爆发内斗，所有敌群的扩张压力下降。",
    apply(state) {
      const result = applyAllAiPopulationLoss(state, 0.25, 1);
      return {
        state: result.state,
        effectSummary: result.affectedCount > 0 ? `所有敌群人口 -${result.totalLoss}` : "没有敌群受到影响"
      };
    }
  },
  {
    id: "open_hunting_ground",
    title: "开阔猎场",
    message: "开阔地形暴露了猎物路线，族群短期战力上升。",
    apply(state) {
      return {
        state: { ...state, temporaryPowerBonus: (state.temporaryPowerBonus ?? 0) + 2 },
        effectSummary: "临时战力 +2"
      };
    }
  },
  {
    id: "rich_hatching_season",
    title: "丰饶孵化季",
    message: "食物、温度和巢穴条件同时转好，新生个体大幅增加。",
    apply(state) {
      const gain = state.reproduction * 4;
      return {
        state: { ...state, population: state.population + gain },
        effectSummary: `人口 +${gain}`
      };
    }
  },
  {
    id: "migration_clues",
    title: "迁徙线索",
    message: "猎物迁徙留下清晰路线，族群发现了更远的可探索区域。",
    apply(state) {
      const result = revealFromActiveCoord(state, 4);
      return {
        state: result.state,
        effectSummary: `额外揭示 ${result.revealedCount} 个格子`
      };
    }
  },
  {
    id: "desert_to_grassland",
    title: "沙漠变湿地",
    message: "持续降雨改造了干旱区域，沙地重新长出植被。",
    apply(state) {
      const result = convertTerrain(state, "desert", "grassland");
      return {
        state: result.state,
        effectSummary: `${result.convertedCount} 个沙漠变为湿地`
      };
    }
  },
  {
    id: "grassland_to_desert",
    title: "湿地变沙漠",
    message: "水源退去，原本丰饶的湿地逐渐沙化。",
    apply(state) {
      const result = convertTerrain(state, "grassland", "desert");
      return {
        state: result.state,
        effectSummary: `${result.convertedCount} 个湿地变为沙漠`
      };
    }
  },
  {
    id: "plague_spread",
    title: "瘟疫扩散",
    message: "病原在巢穴间扩散，密集种群损失惨重。",
    apply(state) {
      const nextPopulation = applyPercentLoss(state.population, 0.25, 3);
      return {
        state: { ...state, population: nextPopulation },
        effectSummary: `人口 -${state.population - nextPopulation}`
      };
    }
  },
  {
    id: "enemy_bloom",
    title: "敌群繁盛",
    message: "敌对族群迎来繁盛季，边界压力上升。",
    apply(state) {
      const nextAiFactions = (state.aiFactions ?? []).map((faction) => {
        const population = faction.population ?? 0;
        return {
          ...faction,
          population: population + Math.max(3, Math.floor(population * 0.2))
        };
      });
      return {
        state: { ...state, aiFactions: nextAiFactions },
        effectSummary: nextAiFactions.length > 0 ? "所有敌群人口 +20%" : "没有敌群受到影响"
      };
    }
  },
  {
    id: "enemy_power_decay",
    title: "敌群战意衰退",
    message: "敌群连续内耗后失去压制力，所有敌群的基础战力下降。",
    apply(state) {
      const result = applyAllAiBasePowerLoss(state, 1);
      return {
        state: result.state,
        effectSummary: result.affectedCount > 0 ? `所有敌群基础战力 -${result.totalLoss}` : "没有敌群受到影响"
      };
    }
  },
  {
    id: "habitat_collapse",
    title: "栖地塌陷",
    message: "地面塌陷撕裂了外围栖地，部分领地被迫放弃。",
    apply(state, random) {
      const result = removePlayerTiles(state, 2, random);
      return {
        state: result.state,
        effectSummary: `失去 ${result.removedCount} 个领地`
      };
    }
  }
];

// 罕见事件是高冲击事件，会明显改变地图或领地结构。
const LEGENDARY_EVENTS = [
  {
    id: "ecosystem_collapse",
    title: "生态崩塌",
    message: "食物链成片断裂，玩家和敌对族群都失去大量栖地。",
    apply(state, random) {
      const playerLoss = Math.floor(getOwnedTiles(state).length / 2);
      let result = removePlayerTiles(state, playerLoss, random);
      let nextState = result.state;
      let aiRemovedCount = 0;

      for (const faction of nextState.aiFactions ?? []) {
        const aiTileCount = [...nextState.tiles.values()].filter((tile) => tile.aiFactionId === faction.id).length;
        const aiResult = removeAiTiles(nextState, faction.id, Math.floor(aiTileCount / 2), random);
        nextState = aiResult.state;
        aiRemovedCount += aiResult.removedCount;
      }

      return {
        state: nextState,
        effectSummary: `玩家失去 ${result.removedCount} 个领地，敌群失去 ${aiRemovedCount} 个领地`
      };
    }
  },
  {
    id: "desert_to_water",
    title: "沙漠变水域",
    message: "地壳沉降与洪水改写地貌，大片沙漠被水域吞没。",
    apply(state) {
      const result = convertTerrain(state, "desert", "water");
      return {
        state: result.state,
        effectSummary: `${result.convertedCount} 个沙漠变为水域`
      };
    }
  },
  {
    id: "grassland_to_mountain",
    title: "湿地变高山",
    message: "剧烈地质活动抬升地表，湿地被高山地形取代。",
    apply(state) {
      const result = convertTerrain(state, "grassland", "mountain");
      return {
        state: result.state,
        effectSummary: `${result.convertedCount} 个湿地变为高山`
      };
    }
  },
  {
    id: "water_to_grassland",
    title: "水域变湿地",
    message: "水位退去后淤泥沉积，新的温暖湿地从旧水域中显露。",
    apply(state) {
      const result = convertTerrain(state, "water", "grassland");
      return {
        state: result.state,
        effectSummary: `${result.convertedCount} 个水域变为湿地`
      };
    }
  },
  {
    id: "mountain_to_desert",
    title: "高山变沙漠",
    message: "山体崩塌与干热气候重塑地貌，高山逐渐化为荒漠。",
    apply(state) {
      const result = convertTerrain(state, "mountain", "desert");
      return {
        state: result.state,
        effectSummary: `${result.convertedCount} 个高山变为沙漠`
      };
    }
  }
];

export const RANDOM_EVENT_POOLS = {
  common: COMMON_EVENTS,
  rare: RARE_EVENTS,
  legendary: LEGENDARY_EVENTS
};

export function selectRandomEventRarity(roll) {
  // roll 是 0-99 的整数，测试会覆盖 60/90 两个边界。
  return RANDOM_EVENT_RARITIES.find((rarity) => roll < rarity.maxRoll) ?? RANDOM_EVENT_RARITIES.at(-1);
}

export function getRandomEventById(eventId) {
  // 测试辅助和未来调试入口：按事件 id 在所有池子里查找。
  for (const events of Object.values(RANDOM_EVENT_POOLS)) {
    const event = events.find((candidate) => candidate.id === eventId);
    if (event) return event;
  }
  return null;
}

export function chooseRandomEvent(state) {
  // 事件随机数由 seed 和 turn 派生，确保同一局同一回合触发结果可复现。
  const random = mulberry32((state.seed ^ Math.imul(state.turn + 1, 1597334677) ^ 0x85ebca6b) >>> 0);
  const rarity = selectRandomEventRarity(Math.floor(random() * 100));
  const pool = RANDOM_EVENT_POOLS[rarity.id];
  const event = pool[Math.floor(random() * pool.length)];
  return { event, rarity, random };
}

export function applyRandomEvent(state) {
  // 将事件效果附加为 randomEvent 载荷，由 rules.js 负责转成通知和日志。
  const { event, rarity, random } = chooseRandomEvent(state);
  const result = event.apply(state, random);
  return {
    ...result.state,
    randomEvent: {
      eventId: event.id,
      rarity: rarity.id,
      rarityLabel: rarity.label,
      title: event.title,
      message: event.message,
      effectSummary: result.effectSummary
    }
  };
}
