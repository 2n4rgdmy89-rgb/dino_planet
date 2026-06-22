// 遗传算法优化器 — 将 AI 策略参数化，通过进化找到最优权重。
// 每代评估多组权重，选出最优者，交叉变异产生下一代。
//
// 用法：node scripts/run-headless.mjs evolve <代数> <种群大小>

import { runHeadlessGame } from "./headless.js";
import { canExpandTo, getEffectiveCombatRequirement, getExpansionPopulationCost, getOwnedTiles, getTotalPower } from "./rules.js";
import { getNeighbors, coordKey } from "./map.js";
import { TERRAIN_TYPES } from "./config.js";

// ── 策略参数化 ──

export function makeEvolvedStrategy(weights, id) {
  return {
    name: id ?? "evolved",
    label: `进化优化 ${id}`,
    weights,

    scoreTile(state, tile) {
      if (!canExpandTo(state, tile)) return -Infinity;
      const terrain = TERRAIN_TYPES[tile.terrain];
      if (!terrain?.conquerable) return -Infinity;

      const terrainVal = {
        grassland: weights.wGrassland,
        forest: weights.wForest,
        desert: weights.wDesert
      }[tile.terrain] ?? 0;

      const aiBonus = tile.aiFactionId ? weights.wAI : 0;
      const margin = Math.max(0, getTotalPower(state) - getEffectiveCombatRequirement(state, tile));
      const marginScore = margin * weights.wMargin;
      const popPenalty = -getExpansionPopulationCost(state, tile) * weights.wPopCost;
      const unseen = getNeighbors(tile).filter(
        (n) => !state.tiles.get(coordKey(n))?.revealed
      ).length;
      const exploreScore = unseen * weights.wExplore;

      return terrainVal + aiBonus + marginScore + popPenalty + exploreScore;
    },

    pickMutation(state, choices) {
      const affordable = choices.filter((c) => c.available);
      if (affordable.length === 0) return choices[0]?.id;

      // 卡扩张时强制选战力
      const canExpand = [...state.tiles.values()].some((t) => canExpandTo(state, t));
      if (!canExpand) {
        const pwr = affordable.find((c) => c.id === "basic_power");
        if (pwr) return pwr.id;
      }

      const preferPower = weights.wPowerFirst > 0.5;

      // 高级异变：允许进化器学会“攒点后花点”。
      // 优先适应属性，因为当前真实胜利样本来自飞向新世界路线。
      if ((state.mutationPoints ?? 0) >= 5 && weights.wAdvanced > 0.5) {
        const adaptAdv = affordable.find((c) => c.type === "advanced" && c.attribute === "adaptation");
        if (adaptAdv) return adaptAdv.id;
        const adv = affordable.find((c) => c.type === "advanced");
        if (adv) return adv.id;
      }

      // 优先选策略偏好的基础异变
      const primary = affordable.find(
        (c) => c.id === (preferPower ? "basic_power" : "basic_reproduction")
      );
      if (primary) return primary.id;

      const secondary = affordable.find(
        (c) => c.id === (preferPower ? "basic_reproduction" : "basic_power")
      );
      if (secondary) return secondary.id;

      return affordable[0].id;
    }
  };
}

// ── 基因定义 ──

const GENE_DEFS = {
  wGrassland: { min: 50, max: 200 },
  wForest: { min: 20, max: 150 },
  wDesert: { min: 10, max: 150 },
  wAI: { min: 10, max: 100 },
  wMargin: { min: 1, max: 20 },
  wPopCost: { min: 1, max: 10 },
  wExplore: { min: 0, max: 15 },
  wPowerFirst: { min: 0, max: 1 },
  wAdvanced: { min: 0, max: 1 }
};

function randomWeights() {
  const w = {};
  for (const [key, def] of Object.entries(GENE_DEFS)) {
    w[key] = +(def.min + Math.random() * (def.max - def.min)).toFixed(2);
  }
  return w;
}

function crossoverWeights(w1, w2) {
  const child = {};
  for (const key of Object.keys(GENE_DEFS)) {
    child[key] = Math.random() < 0.5 ? w1[key] : w2[key];
  }
  return child;
}

function mutateWeights(w, rate) {
  for (const [key, def] of Object.entries(GENE_DEFS)) {
    if (Math.random() < rate) {
      const delta = (Math.random() - 0.5) * 2 * (def.max - def.min) * 0.3;
      w[key] = +(Math.max(def.min, Math.min(def.max, w[key] + delta))).toFixed(2);
    }
  }
}

// ── 适应度函数 ──

function fitness(gameResult) {
  const history = gameResult.history ?? [];
  const finalPop = Math.floor(gameResult.state.population);
  const finalTiles = getOwnedTiles(gameResult.state).length;
  const finalPower = getTotalPower(gameResult.state);
  const won = gameResult.state.result?.type !== "extinction";
  const fullTurns = gameResult.state.turn >= 186;

  // 不只看最终局面：很多失败局在中盘曾经有很好的增长曲线。
  // 用“全局峰值”给遗传算法更密的学习信号，避免所有灭绝局都接近 0 分。
  const peakPopulation = Math.max(finalPop, ...history.map((row) => row.population ?? 0));
  const peakTiles = Math.max(finalTiles, ...history.map((row) => row.tileCount ?? 0));
  const peakPower = Math.max(finalPower, ...history.map((row) => row.power ?? 0));

  let score = 0;
  score += gameResult.state.turn * 120; // 活得久本身有价值
  score += peakPopulation * 1.5; // 人口峰值代表滚雪球能力
  score += finalPop * 0.5; // 但也保留终局人口价值
  score += peakTiles * 700; // 领地峰值强烈影响恢复能力
  score += finalTiles * 250;
  score += peakPower * 180; // 战力能抗 AI/开高要求地块

  // 赢了的巨大奖励
  if (won) score += 1_000_000;

  // 活满的额外奖励
  if (fullTurns && !won) score += 10_000;

  return score;
}

// ── 进化主循环 ──

export function evolve(options = {}) {
  const {
    generations = 10,
    popSize = 20,
    seedsPerEval = 5,
    keepRate = 0.3,
    mutateRate = 0.3,
    baseSeed = 10000,
    verbose = true
  } = options;

  if (verbose) {
    console.log(`进化开始: ${generations}代 × ${popSize}个体 × ${seedsPerEval}种子`);
    console.log("─".repeat(60));
  }

  // 初始随机种群
  let population = Array.from({ length: popSize }, (_, i) => ({
    weights: randomWeights(),
    id: `g0_${i}`,
    fitness: 0
  }));

  let allTimeBest = { fitness: -Infinity, weights: null };

  for (let gen = 0; gen < generations; gen++) {
    // 评估
    for (const indiv of population) {
      const strategy = makeEvolvedStrategy(indiv.weights, indiv.id);
      let totalFitness = 0;
      // 每代使用同一组训练种子，保证分数可比。
      // 泛化能力留给最终的独立 20 seeds 评估。
      const seedBase = baseSeed;
      for (let s = 0; s < seedsPerEval; s++) {
        const seed = (seedBase + s) >>> 0;
        const result = runHeadlessGame({ seed, strategy });
        totalFitness += fitness(result);
      }
      indiv.fitness = totalFitness / seedsPerEval;
    }

    // 排序
    population.sort((a, b) => b.fitness - a.fitness);

    if (population[0].fitness > allTimeBest.fitness) {
      allTimeBest = { fitness: population[0].fitness, weights: { ...population[0].weights } };
    }

    if (verbose) {
      const best = population[0];
      const avgFit = population.reduce((s, i) => s + i.fitness, 0) / population.length;
      console.log(
        `Gen ${String(gen).padStart(2)} ` +
          `best=${best.fitness.toFixed(0).padStart(6)} ` +
          `avg=${avgFit.toFixed(0).padStart(6)} ` +
          `[草地=${best.weights.wGrassland} 森林=${best.weights.wForest} 沙=${best.weights.wDesert} ` +
          `AI=${best.weights.wAI} 余量=${best.weights.wMargin} 人口费=${best.weights.wPopCost} ` +
          `探索=${best.weights.wExplore} 战先=${best.weights.wPowerFirst.toFixed(1)} 高级=${best.weights.wAdvanced.toFixed(1)}]`
      );
    }

    // 精英保留
    const keepCount = Math.max(2, Math.floor(popSize * keepRate));
    const survivors = population.slice(0, keepCount);

    // 生成下一代
    const nextGen = survivors.map((s) => ({
      weights: { ...s.weights },
      id: `g${gen + 1}_elite_${s.id}`,
      fitness: 0
    }));

    while (nextGen.length < popSize) {
      const p1 = survivors[Math.floor(Math.random() * survivors.length)];
      const p2 = survivors[Math.floor(Math.random() * survivors.length)];
      const child = crossoverWeights(p1.weights, p2.weights);
      if (Math.random() < mutateRate) {
        mutateWeights(child, 1.0);
      }
      nextGen.push({
        weights: child,
        id: `g${gen + 1}_${nextGen.length}`,
        fitness: 0
      });
    }

    population = nextGen;
  }

  // 最终深度评估
  if (verbose) {
    console.log("─".repeat(60));
    console.log("最终评估最优策略 (20 seeds)...");
  }

  const bestStrategy = makeEvolvedStrategy(allTimeBest.weights, "champion");
  const results = [];
  let wins = 0;
  for (let s = 0; s < 20; s++) {
    const seed = (baseSeed + 9999 + s) >>> 0;
    const r = runHeadlessGame({ seed, strategy: bestStrategy });
    results.push(r);
    if (r.state.result?.type !== "extinction") wins++;
  }

  const avgPop = results.reduce((s, r) => s + Math.floor(r.state.population), 0) / results.length;
  const avgTiles = results.reduce((s, r) => s + getOwnedTiles(r.state).length, 0) / results.length;
  const avgTurn = results.reduce((s, r) => s + r.state.turn, 0) / results.length;

  if (verbose) {
    console.log(`  胜率: ${wins}/20 (${(wins * 5).toFixed(0)}%)`);
    console.log(`  平均人口: ${avgPop.toFixed(0)}`);
    console.log(`  平均领地: ${avgTiles.toFixed(1)}`);
    console.log(`  平均回合: ${avgTurn.toFixed(1)}`);
    console.log(`  最优权重: ${JSON.stringify(allTimeBest.weights)}`);
  }

  return {
    bestStrategy,
    weights: allTimeBest.weights,
    fitness: allTimeBest.fitness,
    results,
    winRate: wins / 20,
    avgPopulation: avgPop,
    avgTiles,
    avgTurn
  };
}
