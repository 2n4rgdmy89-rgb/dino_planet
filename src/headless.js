// 无头模式 — 纯状态驱动的游戏运行器和 AI 策略。
// 不依赖任何 DOM/浏览器 API，可以在 Node.js 中直接运行。
// 核心循环：选择异变 → 扩张 → 推进回合，模拟人类玩家的决策周期。

import { createInitialState } from "./gameState.js";
import {
  advanceTurn,
  expandToTile,
  chooseMutation,
  canExpandTo,
  getOwnedTiles,
  getTotalPower,
  getPopulationMultiplier,
  getEffectiveCombatRequirement,
  getExpansionPopulationCost,
  resolveExpandedTurnState,
  hasAbility,
  getPowerVictoryTarget,
  getTilePowerBonus
} from "./rules.js";
import { getNeighbors, coordKey } from "./map.js";
import { TERRAIN_TYPES } from "./config.js";

// ── Internal helpers ──

function getPowerMargin(state, tile) {
  return getTotalPower(state) - getEffectiveCombatRequirement(state, tile);
}

function getAvgPopulation(state) {
  const tiles = getOwnedTiles(state).length;
  return tiles > 0 ? Math.floor(state.population) / tiles : 0;
}

function hasExpandableTile(state) {
  for (const tile of state.tiles.values()) {
    if (canExpandTo(state, tile)) return true;
  }
  return false;
}

function shouldPrioritizePower(state) {
  // 是否因为战力不足而卡住扩张
  if (hasExpandableTile(state)) return false;
  const totalPower = getTotalPower(state);
  // 如果 visible 格子的战力要求都高于我方战力，需要加力量
  for (const tile of state.tiles.values()) {
    if (!tile.revealed || tile.owned || !TERRAIN_TYPES[tile.terrain]?.conquerable) continue;
    if (getEffectiveCombatRequirement(state, tile) <= totalPower) continue;
    return true; // 至少有一个可征服格子是因为战力不够而无法占领
  }
  return false;
}

// ── Tile Evaluation ──

function genericTileScore(state, tile) {
  // 通用评分，给每种策略一个一致的基线
  if (!tile || !canExpandTo(state, tile)) return -Infinity;
  const terrain = TERRAIN_TYPES[tile.terrain];
  if (!terrain?.conquerable) return -Infinity;

  const terrainValue = { grassland: 100, forest: 60, desert: 30, origin: 0 }[tile.terrain] ?? 0;
  const aiBonus = tile.aiFactionId ? 50 : 0;
  const powerMargin = getPowerMargin(state, tile);
  const combatScore = Math.min(Math.max(powerMargin, 0) * 5, 30);
  const popCost = getExpansionPopulationCost(state, tile);
  const exploreBonus = getNeighbors(tile)
    .filter((n) => !state.tiles.get(coordKey(n))?.revealed).length * 5;

  return terrainValue + aiBonus + combatScore - popCost * 3 + exploreBonus;
}

function findBestTile(state, strategy) {
  let best = null;
  let bestScore = -Infinity;
  for (const tile of state.tiles.values()) {
    if (!canExpandTo(state, tile)) continue;
    const score = strategy.scoreTile(state, tile);
    if (score > bestScore) {
      bestScore = score;
      best = tile;
    }
  }
  return best;
}

// ── 策略定义 ──
// 每个策略实现两个接口：
//   scoreTile(state, tile) → number     (土地评分，越高越优先扩张)
//   pickMutation(state, choices) → id   (选异变)

export const STRATEGIES = {
  growth: {
    name: "growth",
    label: "成长优先",
    description: "优先繁殖和湿地，追求人口增长",

    scoreTile(state, tile) {
      if (!canExpandTo(state, tile)) return -Infinity;
      const terrain = TERRAIN_TYPES[tile.terrain];
      if (!terrain?.conquerable) return -Infinity;

      const terrainScore = { grassland: 100, forest: 40, desert: 15 }[tile.terrain] ?? 0;
      const aiBonus = tile.aiFactionId ? 30 : 0;
      const safety = getPowerMargin(state, tile) > 2 ? 20 : 0;
      const popCost = getExpansionPopulationCost(state, tile);

      return terrainScore + aiBonus + safety - popCost * 3;
    },

    pickMutation(state, choices) {
      const affordable = choices.filter((c) => c.available);
      if (affordable.length === 0) return choices[0]?.id;

      // 卡扩张时优先补战力
      if (shouldPrioritizePower(state)) {
        const pwr = affordable.find((c) => c.id === "basic_power");
        if (pwr) return pwr.id;
        const powerAdv = affordable.find((c) => c.type === "advanced" && c.attribute === "power");
        if (powerAdv) return powerAdv.id;
      }

      const repro = affordable.find((c) => c.id === "basic_reproduction");
      if (repro) return repro.id;

      const growthAdv = affordable.find(
        (c) =>
          c.type === "advanced" &&
          (c.attribute === "adaptation" || c.attribute === "agility")
      );
      if (growthAdv) return growthAdv.id;

      const power = affordable.find((c) => c.id === "basic_power");
      if (power) return power.id;

      return affordable[0].id;
    }
  },

  power: {
    name: "power",
    label: "战力优先",
    description: "优先战力，追求巨兽路线获胜",

    scoreTile(state, tile) {
      if (!canExpandTo(state, tile)) return -Infinity;
      const terrain = TERRAIN_TYPES[tile.terrain];
      if (!terrain?.conquerable) return -Infinity;

      const terrainScore = { grassland: 30, forest: 50, desert: 80 }[tile.terrain] ?? 0;
      const aiBonus = tile.aiFactionId ? 40 : 0;
      const powerMargin = getPowerMargin(state, tile);
      const popCost = getExpansionPopulationCost(state, tile);

      return terrainScore + aiBonus + Math.max(powerMargin, 0) * 8 - popCost * 2;
    },

    pickMutation(state, choices) {
      const affordable = choices.filter((c) => c.available);
      if (affordable.length === 0) return choices[0]?.id;

      // 卡扩张时继续堆战力
      if (shouldPrioritizePower(state)) {
        const pwr = affordable.find((c) => c.id === "basic_power");
        if (pwr) return pwr.id;
      }

      const pwr = affordable.find((c) => c.id === "basic_power");
      if (pwr) return pwr.id;

      const powerAdv = affordable.find((c) => c.type === "advanced" && c.attribute === "power");
      if (powerAdv) return powerAdv.id;

      const repro = affordable.find((c) => c.id === "basic_reproduction");
      if (repro) return repro.id;

      return affordable[0].id;
    }
  },

  balanced: {
    name: "balanced",
    label: "平衡发展",
    description: "根据人口密度和战力差额平衡决策",

    scoreTile(state, tile) {
      return genericTileScore(state, tile);
    },

    pickMutation(state, choices) {
      const affordable = choices.filter((c) => c.available);
      if (affordable.length === 0) return choices[0]?.id;

      const avgPop = getAvgPopulation(state);

      // 卡扩张时优先补战力
      if (shouldPrioritizePower(state)) {
        const pwr = affordable.find((c) => c.id === "basic_power");
        if (pwr) return pwr.id;
      }

      // 人口偏低时优先繁殖
      if (avgPop < 3) {
        const repro = affordable.find((c) => c.id === "basic_reproduction");
        if (repro) return repro.id;
      }

      // 战力不足时优先战力
      if (getTotalPower(state) < 5) {
        const pwr = affordable.find((c) => c.id === "basic_power");
        if (pwr) return pwr.id;
      }

      // 有异变点，尝试高级异变
      if ((state.mutationPoints ?? 0) >= 5) {
        const adv = affordable.find((c) => c.type === "advanced");
        if (adv) return adv.id;
      }

      // 回到免费基础
      const repro2 = affordable.find((c) => c.id === "basic_reproduction");
      const pwr2 = affordable.find((c) => c.id === "basic_power");
      return (avgPop < 5 ? repro2 : pwr2)?.id ?? affordable[0].id;
    }
  },

  adaptive: {
    name: "adaptive",
    label: "适应路线",
    description: "走适应属性，追求「飞向新世界」终局胜利",

    scoreTile(state, tile) {
      return genericTileScore(state, tile);
    },

    pickMutation(state, choices) {
      const affordable = choices.filter((c) => c.available);
      if (affordable.length === 0) return choices[0]?.id;

      // 卡扩张时补战力
      if (shouldPrioritizePower(state)) {
        const pwr = affordable.find((c) => c.id === "basic_power");
        if (pwr) return pwr.id;
      }

      const adaptAdv = affordable.find(
        (c) => c.type === "advanced" && c.attribute === "adaptation"
      );
      if (adaptAdv) return adaptAdv.id;

      const repro = affordable.find((c) => c.id === "basic_reproduction");
      if (repro) return repro.id;

      const pwr = affordable.find((c) => c.id === "basic_power");
      if (pwr) return pwr.id;

      return affordable[0].id;
    }
  },

  greedy: {
    name: "greedy",
    label: "贪婪扩张",
    description: "只管扩张，不挑地形，尽可能多占格子",

    scoreTile(state, tile) {
      if (!canExpandTo(state, tile)) return -Infinity;
      const popCost = getExpansionPopulationCost(state, tile);
      const powerMargin = getPowerMargin(state, tile);
      return powerMargin * 10 - popCost * 4 + (tile.aiFactionId ? 20 : 0);
    },

    pickMutation(state, choices) {
      const affordable = choices.filter((c) => c.available);
      if (affordable.length === 0) return choices[0]?.id;

      // 卡扩张时补战力
      if (shouldPrioritizePower(state)) {
        const pwr = affordable.find((c) => c.id === "basic_power");
        if (pwr) return pwr.id;
      }

      // 贪婪：优先人口（为了更多扩张）
      const repro = affordable.find((c) => c.id === "basic_reproduction");
      if (repro) return repro.id;
      const pwr = affordable.find((c) => c.id === "basic_power");
      if (pwr) return pwr.id;
      return affordable[0].id;
    }
  },

  random: {
    name: "random",
    label: "随机决策",
    description: "纯随机选择（基线对比用）",

    scoreTile(state, tile) {
      const base = genericTileScore(state, tile);
      return base === -Infinity ? -Infinity : base + Math.random() * 50;
    },

    pickMutation(state, choices) {
      const affordable = choices.filter((c) => c.available);
      if (affordable.length === 0) return choices[0]?.id;
      return affordable[Math.floor(Math.random() * affordable.length)].id;
    }
  }
};

// ── 单局游戏 ──

export function runHeadlessGame(options = {}) {
  const seed =
    Number.isInteger(options.seed)
      ? options.seed >>> 0
      : (Math.floor(Math.random() * 0xffffffff) >>> 0);
  const strategy =
    typeof options.strategy === "string"
      ? STRATEGIES[options.strategy]
      : (options.strategy ?? STRATEGIES.balanced);
  const maxExpansionsPerMa = options.maxExpansionsPerMa ?? 2;

  if (!strategy) {
    throw new Error(`Unknown strategy: ${options.strategy}`);
  }

  let state = createInitialState({ seed });
  const history = [];
  let turnCounter = 0;

  function snapshot() {
    const owned = getOwnedTiles(state);
    return {
      turn: state.turn,
      ma: state.currentMa,
      population: Math.floor(state.population),
      power: getTotalPower(state),
      tileCount: owned.length,
      powerBonus: getTilePowerBonus(state),
      populationMultiplier: getPopulationMultiplier(state),
      mutationPoints: state.mutationPoints ?? 0,
      unlockedMutations: (state.unlockedMutationIds ?? []).length,
      aiFactionCount: state.aiFactions?.length ?? 0,
      hasPendingMutation: state.pendingMutationChoice,
      result: state.result
    };
  }

  history.push(snapshot());

  while (!state.gameOver) {
    // ── 1. 处理待选异变 ──
    if (state.pendingMutationChoice) {
      const choiceId = strategy.pickMutation(state, state.mutationChoices);
      state = chooseMutation(state, choiceId);
      // advanceTurn 可能因为 pendingMutationChoice 返回，选了之后继续循环
      continue;
    }

    // ── 2. 扩张阶段：每 Ma 可扩张若干次 ──
    let didExpand = false;
    let expansions = 0;
    while (expansions < maxExpansionsPerMa && !state.gameOver) {
      const tile = findBestTile(state, strategy);
      if (!tile || !canExpandTo(state, tile)) break;

      didExpand = true;
      state = expandToTile(state, tile.key);
      // resolveExpandedTurnState 会在 hasExpandedThisTurn 为 true 时
      // 自动调用 advanceTurn（推进到下一 Ma）
      const turnBefore = state.turn;
      state = resolveExpandedTurnState(state);
      expansions++;

      // 扩张推进时间后可能会触发 pendingMutationChoice（新 5Ma 周期）
      if (state.pendingMutationChoice && !state.gameOver) {
        const choiceId = strategy.pickMutation(state, state.mutationChoices);
        state = chooseMutation(state, choiceId);
      }
    }

    history.push(snapshot());

    // ── 3. 无事可做时直接推进时间（仅在本次循环未扩张时执行）──
    if (!state.gameOver && !didExpand && !state.hasExpandedThisTurn && !state.pendingMutationChoice) {
      state = advanceTurn(state);
      history.push(snapshot());
    }

    // 清除 notice 队列（纯 UI 用途，无头模式不需要）
    if (state.notices?.length > 0) {
      state = { ...state, notices: [] };
    }

    // 防止死循环
    if (++turnCounter > 200) {
      console.warn(`[headless] seed=${seed}: 超过 200 次循环仍未结束，强制终止`);
      break;
    }
  }

  history.push(snapshot());

  return {
    state,
    history,
    seed,
    strategyName: strategy.name,
    strategyLabel: strategy.label
  };
}

// ── 统计分析 ──

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function aggregateResults(results) {
  const total = results.length;
  if (total === 0) return { total: 0 };

  const victories = results.filter((r) => r.state.result?.type !== "extinction");
  const popVic = results.filter((r) => r.state.result?.type === "population");
  const powVic = results.filter((r) => r.state.result?.type === "power");
  const adpVic = results.filter((r) => r.state.result?.type === "adaptation");
  const ext = results.filter((r) => r.state.result?.type === "extinction");

  const finalPop = results.map((r) => Math.floor(r.state.population));
  const finalPow = results.map((r) => getTotalPower(r.state));
  const finalTil = results.map((r) => getOwnedTiles(r.state).length);
  const turns = results.map((r) => r.state.turn);
  const muts = results.map((r) => (r.state.unlockedMutationIds ?? []).length);

  const strategyCounts = {};
  for (const r of results) {
    strategyCounts[r.strategyName] = (strategyCounts[r.strategyName] ?? 0) + 1;
  }

  return {
    total,
    strategyCounts,
    victories: { count: victories.length, winRate: victories.length / total },
    populationVictory: { count: popVic.length, rate: popVic.length / total },
    powerVictory: { count: powVic.length, rate: powVic.length / total },
    adaptationVictory: { count: adpVic.length, rate: adpVic.length / total },
    extinction: { count: ext.length, rate: ext.length / total },
    stats: {
      finalPopulation: {
        avg: avg(finalPop),
        median: median(finalPop),
        min: Math.min(...finalPop),
        max: Math.max(...finalPop)
      },
      finalPower: {
        avg: avg(finalPow),
        median: median(finalPow),
        min: Math.min(...finalPow),
        max: Math.max(...finalPow)
      },
      finalTiles: {
        avg: avg(finalTil),
        median: median(finalTil),
        min: Math.min(...finalTil),
        max: Math.max(...finalTil)
      },
      turnsSurvived: {
        avg: avg(turns),
        median: median(turns),
        min: Math.min(...turns),
        max: Math.max(...turns)
      },
      mutationsUnlocked: {
        avg: avg(muts),
        median: median(muts),
        min: Math.min(...muts),
        max: Math.max(...muts)
      }
    }
  };
}

// ── 批量运行 ──

export function runManyGames(options = {}) {
  const count = options.count ?? 10;
  const startSeed = Number.isInteger(options.startSeed) ? options.startSeed >>> 0 : 12345;
  const strategy = options.strategy ?? "balanced";
  const verbose = options.verbose ?? false;

  const results = [];
  for (let i = 0; i < count; i++) {
    const seed = (startSeed + i) >>> 0;
    const result = runHeadlessGame({ seed, strategy });
    results.push(result);
    if (verbose) {
      const outcome = result.state.result?.type === "extinction" ? "❌灭绝" : "✅胜利";
      console.log(
        `  [#${i}] seed=${seed}  ${outcome}  ` +
        `人口=${Math.floor(result.state.population)}  ` +
        `战力=${getTotalPower(result.state)}  ` +
        `领地=${getOwnedTiles(result.state).length}  ` +
        `回合=${result.state.turn}`
      );
    }
  }

  return { results, ...aggregateResults(results) };
}