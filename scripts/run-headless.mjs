#!/usr/bin/env node
// 无头模式 CLI — 在终端运行 AI 策略，输出局面报告。
//
// 用法：
//   node scripts/run-headless.mjs list                         罗列可用策略
//   node scripts/run-headless.mjs single <策略> [seed]         单局详情
//   node scripts/run-headless.mjs many <数量> <策略> [起始seed]  批量统计
//   node scripts/run-headless.mjs compare <数量> [策略...]      对比策略
//   node scripts/run-headless.mjs history <seed> [策略]         输出 CSV 历史
//   node scripts/run-headless.mjs evolve [代数] [种群] [种子/评] 遗传算法优化策略
//
// 示例：
//   node scripts/run-headless.mjs single balanced
//   node scripts/run-headless.mjs many 50 growth
//   node scripts/run-headless.mjs compare 30 growth power balanced adaptive random
//   node scripts/run-headless.mjs history 12345 growth
//   node scripts/run-headless.mjs evolve 10 20 5

import { runHeadlessGame, runManyGames, STRATEGIES } from "../src/headless.js";
import { getOwnedTiles, getTotalPower } from "../src/rules.js";
import { evolve } from "../src/optimizer.js";

const command = process.argv[2];

// ── 工具函数 ──

function formatResult(result) {
  const s = result.state;
  const outcome = s.result?.type === "extinction" ? "❌ 灭绝" : "✅ 胜利";
  const resultLabel =
    s.result?.type === "population"
      ? "（种群冗余）"
      : s.result?.type === "power"
        ? "（巨兽抗灾）"
        : s.result?.type === "adaptation"
          ? "（飞向新世界）"
          : "";
  return [
    `  策略:     ${result.strategyLabel}`,
    `  种子:     ${result.seed}`,
    `  结果:     ${outcome}${resultLabel}`,
    `  回合:     ${s.turn} / 186 (${s.currentMa} Ma)`,
    `  人口:     ${Math.floor(s.population)}`,
    `  总战力:   ${getTotalPower(s)}`,
    `  领地:     ${getOwnedTiles(s).length}`,
    `  异变:     ${(s.unlockedMutationIds ?? []).length} 项`,
    `  异变点数: ${s.mutationPoints ?? 0}`,
    `  AI 族群:  ${s.aiFactions?.length ?? 0}`,
    `  日志:     ${s.log?.[0] ?? ""}`
  ].join("\n");
}

function formatAggregate(stats, label) {
  const s = stats.stats;
  const header = `── ${label} ──`;
  const winLine = `  胜率: ${(stats.victories.winRate * 100).toFixed(1)}% ` +
    `(人口${(stats.populationVictory.rate * 100).toFixed(0)}% ` +
    `战力${(stats.powerVictory.rate * 100).toFixed(0)}% ` +
    `适应${(stats.adaptationVictory.rate * 100).toFixed(0)}%)`;
  const lines = [
    header,
    winLine,
    `  灭绝率:  ${(stats.extinction.rate * 100).toFixed(1)}%`,
    `  最终人口: ${s.finalPopulation.avg.toFixed(0)} (中位数 ${s.finalPopulation.median} 范围 ${s.finalPopulation.min}-${s.finalPopulation.max})`,
    `  最终战力: ${s.finalPower.avg.toFixed(1)} (中位数 ${s.finalPower.median} 范围 ${s.finalPower.min}-${s.finalPower.max})`,
    `  最终领地: ${s.finalTiles.avg.toFixed(1)} (中位数 ${s.finalTiles.median} 范围 ${s.finalTiles.min}-${s.finalTiles.max})`,
    `  存续回合: ${s.turnsSurvived.avg.toFixed(0)} (中位数 ${s.turnsSurvived.median} 范围 ${s.turnsSurvived.min}-${s.turnsSurvived.max})`,
    `  解锁异变: ${s.mutationsUnlocked.avg.toFixed(1)} (中位数 ${s.mutationsUnlocked.median} 范围 ${s.mutationsUnlocked.min}-${s.mutationsUnlocked.max})`
  ];
  return lines.join("\n");
}

// ── Commands ──

function cmdList() {
  console.log("可用策略：\n");
  for (const [key, s] of Object.entries(STRATEGIES)) {
    console.log(`  ${key.padEnd(12)} ${s.label} — ${s.description}`);
  }
}

function cmdSingle() {
  const strategyName = process.argv[3] ?? "balanced";
  const seed = process.argv[4] ? Number(process.argv[4]) >>> 0 : undefined;
  const strategy = STRATEGIES[strategyName];
  if (!strategy) {
    console.error(`未知策略: ${strategyName}。用 list 查看可用策略。`);
    process.exit(1);
  }

  console.log(`\n运行单局: strategy=${strategyName} seed=${seed ?? "随机"}\n`);
  const result = runHeadlessGame({ strategy: strategyName, seed });
  console.log(formatResult(result));
}

function cmdMany() {
  const count = Number(process.argv[3]) || 10;
  const strategyName = process.argv[4] ?? "balanced";
  const startSeed = process.argv[5] ? Number(process.argv[5]) >>> 0 : 12345;
  const strategy = STRATEGIES[strategyName];
  if (!strategy) {
    console.error(`未知策略: ${strategyName}`);
    process.exit(1);
  }

  console.log(`\n批量运行: strategy=${strategyName} count=${count} startSeed=${startSeed}\n`);
  const result = runManyGames({ count, startSeed, strategy: strategyName, verbose: true });
  console.log(`\n${formatAggregate(result, strategyName)}\n`);
}

function cmdCompare() {
  const count = Number(process.argv[3]) || 10;
  const strategyNames = process.argv.slice(4);
  const validNames = strategyNames.length > 0
    ? strategyNames.filter((n) => STRATEGIES[n])
    : Object.keys(STRATEGIES);

  if (validNames.length === 0) {
    console.error("没有有效的策略名。");
    process.exit(1);
  }

  const results = {};
  for (const name of validNames) {
    console.log(`运行策略: ${name} ...`);
    const result = runManyGames({ count, startSeed: 10000, strategy: name, verbose: false });
    results[name] = result;
  }

  console.log("\n\n========== 策略对比 ==========\n");
  for (const name of validNames) {
    console.log(`${formatAggregate(results[name], results[name].results?.[0]?.strategyLabel ?? name)}\n`);
  }

  // 胜率排行
  console.log("── 胜率排行 ──\n");
  const sorted = [...validNames]
    .map((n) => ({ name: n, label: results[n].results?.[0]?.strategyLabel ?? n, winRate: results[n].victories.winRate }))
    .sort((a, b) => b.winRate - a.winRate);
  for (const entry of sorted) {
    console.log(`  ${(entry.winRate * 100).toFixed(1).padStart(5)}%  ${entry.label}`);
  }
}

function cmdHistory() {
  const seed = Number(process.argv[3]) >>> 0;
  const strategyName = process.argv[4] ?? "balanced";

  const result = runHeadlessGame({ seed, strategy: strategyName });
  const h = result.history;

  // CSV header
  console.log("turn,ma,population,power,tileCount,powerBonus,popMultiplier,mutationPoints,mutations,aiFactions");
  for (const row of h) {
    console.log(
      `${row.turn},${row.ma},${row.population},${row.power},${row.tileCount},` +
      `${row.powerBonus},${row.populationMultiplier},${row.mutationPoints},${row.unlockedMutations},${row.aiFactionCount}`
    );
  }

  console.error(`\n--- ${result.strategyLabel} seed=${seed} → ${result.state.result?.title} ---`);
  console.error(`最后: 人口=${Math.floor(result.state.population)} 战力=${getTotalPower(result.state)} 领地=${getOwnedTiles(result.state).length}`);
}

function cmdEvolve() {
  const generations = Number(process.argv[3]) || 10;
  const popSize = Number(process.argv[4]) || 20;
  const seedsPerEval = Number(process.argv[5]) || 5;

  console.log("🧬 遗传算法优化\n");
  evolve({ generations, popSize, seedsPerEval, verbose: true });
}

// ── Dispatch ──

switch (command) {
  case "list":
    cmdList();
    break;
  case "single":
    cmdSingle();
    break;
  case "many":
    cmdMany();
    break;
  case "compare":
    cmdCompare();
    break;
  case "history":
    cmdHistory();
    break;
  case "evolve":
    cmdEvolve();
    break;
  default:
    console.log(`
无头模式 - 恐龙星球 AI 自动运行器

用法:
  node scripts/run-headless.mjs list
  node scripts/run-headless.mjs single <策略> [seed]
  node scripts/run-headless.mjs many <数量> <策略> [起始seed]
  node scripts/run-headless.mjs compare <数量> [策略...]
  node scripts/run-headless.mjs history <seed> [策略]
  node scripts/run-headless.mjs evolve [代数] [种群] [种子/评]

示例:
  node scripts/run-headless.mjs single balanced
  node scripts/run-headless.mjs many 50 growth
  node scripts/run-headless.mjs compare 30 growth power balanced adaptive greedy random
  node scripts/run-headless.mjs evolve 10 20 5
`);
    break;
}