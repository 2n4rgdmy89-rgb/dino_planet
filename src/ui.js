import { START_MA, TERRAIN_TYPES, VICTORY } from "./config.js";
import {
  EVOLUTION_NODES,
  MUTATION_ATTRIBUTES,
  getAdvancedMutationNodes,
  getMutationAttribute,
  getMutationRarity,
  getSpeciesNode
} from "./evolution.js";
import { createTile } from "./map.js";
import {
  advanceTurn,
  canExpandTo,
  canChooseMutation,
  canPlayerConquerTile,
  chooseMutation,
  expandToTile,
  findSecondExpansionTerrainTargets,
  findTutorialGrasslandKey,
  getEffectiveCombatRequirement,
  getEffectivePopulationCost,
  getExpansionPopulationCost,
  getAiFactionById,
  getAiFactionPower,
  getTileAiPower,
  getPopulationGrowth,
  getPopulationMultiplier,
  getPopulationMultiplierDelta,
  getPowerVictoryTarget,
  getRecentTurnHistory,
  getTemporaryPowerBonus,
  getTilePowerBonus,
  getTotalPower,
  hasAbility,
  isTileThreatenedByAi,
  prepareSecondExpansionTerrain,
  prepareTutorialGrassland,
  resolveExpandedTurnState
} from "./rules.js";
import { hasSaveGame, loadGame, saveGame, saveGameToServer, loadGameFromServer, hasSaveGameOnServer } from "./saveGame.js";

const HEX_SIZE = 42;
const SQRT3 = Math.sqrt(3);
const OWNED_TILE_COLOR = "#d7b45a";
const AI_TILE_COLOR = "#b54d4d";
const TUTORIAL_TOPICS = {
  mutationPoint: "mutation-point",
  advancedSlot: "advanced-slot",
  randomEvent: "random-event",
  enemy: "enemy",
  expansionPenalty: "expansion-penalty",
  secondExpansionTerrain: "second-expansion-terrain"
};

// GameUI 是唯一直接操作 DOM 的类。
// 它持有当前 state，并把按钮、地图点击、弹窗选择转换为 rules.js 的纯状态更新。
export class GameUI {
  constructor(state) {
    // UI 自身状态只保存显示相关内容，不参与核心规则计算。
    // 教程地形准备推迟到玩家选择"开始引导"时执行，避免改写未参与教程的游戏状态。
    this.state = state;
    this.selectedTileKey = null;
    this.skyEyeActive = false;
    this.skyEyeTiles = new Map();
    this.mutationTreeOpen = false;
    this.rulebookOpen = false;
    this.tutorialOpen = false;
    this.tutorialStep = "intro";
    this.tutorialSkipped = false;
    this.tutorialTargetTileKey = findTutorialGrasslandKey(this.state);
    this.seenTutorialTopics = new Set();
    this.mapBaseViewBox = null;
    this.mapViewBox = null;
    this.mapUserAdjusted = false;
    this.isMapPanning = false;
    this.mapPanStart = null;
    this.suppressMapClick = false;
    this.handleResize = () => {
      if (this.mutationTreeOpen) {
        this.renderMutationTree();
      }
      this.applyMapViewBox();
    };
    this.elements = {
      // 集中缓存 DOM 节点，避免每次 render 都重复 querySelector。
      eraLabel: document.querySelector("#eraLabel"),
      maLabel: document.querySelector("#maLabel"),
      turnLabel: document.querySelector("#turnLabel"),
      speciesName: document.querySelector("#speciesName"),
      abilityName: document.querySelector("#abilityName"),
      abilityDescription: document.querySelector("#abilityDescription"),
      mutationPoints: document.querySelector("#mutationPoints"),
      openRulebookButton: document.querySelector("#openRulebookButton"),
      saveGameButton: document.querySelector("#saveGameButton"),
      loadGameButton: document.querySelector("#loadGameButton"),
      openMutationTreeButton: document.querySelector("#openMutationTreeButton"),
      basePower: document.querySelector("#basePower"),
      tilePower: document.querySelector("#tilePower"),
      totalPower: document.querySelector("#totalPower"),
      reproduction: document.querySelector("#reproduction"),
      populationMultiplier: document.querySelector("#populationMultiplier"),
      population: document.querySelector("#population"),
      averagePopulation: document.querySelector("#averagePopulation"),
      populationGoal: document.querySelector("#populationGoal"),
      populationProgress: document.querySelector("#populationProgress"),
      powerGoal: document.querySelector("#powerGoal"),
      powerProgress: document.querySelector("#powerProgress"),
      hexMap: document.querySelector("#hexMap"),
      threatWarnings: document.querySelector("#threatWarnings"),
      visibleEnemySummary: document.querySelector("#visibleEnemySummary"),
      tileDetail: document.querySelector("#tileDetail"),
      skyEyeButton: document.querySelector("#skyEyeButton"),
      endTurnButton: document.querySelector("#endTurnButton"),
      zoomInButton: document.querySelector("#zoomInButton"),
      zoomOutButton: document.querySelector("#zoomOutButton"),
      resetMapViewButton: document.querySelector("#resetMapViewButton"),
      eventLog: document.querySelector("#eventLog"),
      modalRoot: document.querySelector("#modalRoot"),
      mutationRoot: document.querySelector("#mutationRoot"),
      tileTooltip: document.querySelector("#tileTooltip")
    };

    this.elements.skyEyeButton.addEventListener("click", () => this.toggleSkyEye());
    this.elements.endTurnButton.addEventListener("click", () => this.advanceCurrentTurn());
    this.elements.saveGameButton.addEventListener("click", () => this.saveCurrentGame());
    this.elements.loadGameButton.addEventListener("click", () => this.loadSavedGame());
    this.elements.openRulebookButton.addEventListener("click", () => {
      this.tutorialOpen = false;
      this.rulebookOpen = true;
      this.renderModal();
    });
    this.elements.openMutationTreeButton.addEventListener("click", () => {
      this.mutationTreeOpen = true;
      this.renderMutationTree();
    });
    this.elements.zoomInButton?.addEventListener("click", () => this.zoomMap(0.82));
    this.elements.zoomOutButton?.addEventListener("click", () => this.zoomMap(1.22));
    this.elements.resetMapViewButton?.addEventListener("click", () => this.resetMapView());
    this.bindMapNavigation();
    window.addEventListener("resize", this.handleResize);

    // 异步检查服务端是否有存档，如有则启用读取按钮。
    this.checkServerSaveAvailability();
  }

  async checkServerSaveAvailability() {
    // localStorage 有存档时按钮已启用，只需在无本地存档时检查服务器。
    if (!hasSaveGame()) {
      const serverHas = await hasSaveGameOnServer();
      if (serverHas) {
        this.elements.loadGameButton.disabled = false;
      }
    }
  }

  updateState(nextState) {
    // 所有状态更新都走这里，统一刷新天眼、选中格有效性和界面。
    this.state = this.shouldPrepareSecondExpansionTerrain(nextState) ? prepareSecondExpansionTerrain(nextState) : nextState;
    if (this.isTutorialRunning() && !this.tutorialTargetTileKey) {
      this.tutorialTargetTileKey = findTutorialGrasslandKey(this.state);
    }
    this.refreshSkyEyeTiles();
    const selectedTile = this.getDisplayTile(this.selectedTileKey);
    if (this.selectedTileKey && !this.isTileDisplayVisible(selectedTile)) {
      this.selectedTileKey = null;
    }
    this.render();
  }

  isTutorialRunning() {
    return !this.tutorialSkipped && this.tutorialStep !== "done";
  }

  isTutorialStep(step) {
    return this.isTutorialRunning() && this.tutorialStep === step;
  }

  canShowContextGuide(topic) {
    return !this.tutorialSkipped && !this.seenTutorialTopics.has(topic);
  }

  markContextGuideSeen(topic) {
    this.seenTutorialTopics.add(topic);
  }

  shouldShowMutationPointGuide() {
    return this.canShowContextGuide(TUTORIAL_TOPICS.mutationPoint) && this.state.pendingMutationChoice && (this.state.mutationPoints ?? 0) > 0;
  }

  shouldShowAdvancedSlotGuide() {
    return this.canShowContextGuide(TUTORIAL_TOPICS.advancedSlot) && this.state.mutationChoices?.[2]?.type === "advanced";
  }

  getFirstVisibleEnemyTile() {
    return [...this.state.tiles.values()]
      .filter((tile) => tile.aiFactionId && tile.revealed)
      .sort((left, right) => left.key.localeCompare(right.key))[0] ?? null;
  }

  shouldShowEnemyGuide() {
    return this.canShowContextGuide(TUTORIAL_TOPICS.enemy) && Boolean(this.getFirstVisibleEnemyTile());
  }

  shouldShowExpansionPenaltyGuide() {
    return (
      this.canShowContextGuide(TUTORIAL_TOPICS.expansionPenalty) &&
      this.state.turn === 2 &&
      !this.state.gameOver &&
      !this.state.pendingMutationChoice
    );
  }

  getActiveContextGuide() {
    const notice = this.state.notices?.[0];
    if (notice?.type === "random-event" && this.canShowContextGuide(TUTORIAL_TOPICS.randomEvent)) {
      return {
        topic: TUTORIAL_TOPICS.randomEvent,
        eyebrow: "First Event",
        title: "第一次遇到随机事件",
        message: "随机事件可能改变人口、地形、敌群或资源。先看清事件效果，再决定下一回合怎么走。",
        target: "event"
      };
    }
    if (notice) return null;
    if (this.shouldShowMutationPointGuide()) {
      return {
        topic: TUTORIAL_TOPICS.mutationPoint,
        eyebrow: "Mutation Points",
        title: "第一次获得异变点",
        message: "每个 5 回合周期会获得 1 点异变点。异变点可以积累起来，用来支付更强的高级异变；免费基础异变不会消耗它。",
        target: "mutation-points"
      };
    }
    if (this.shouldShowAdvancedSlotGuide()) {
      return {
        topic: TUTORIAL_TOPICS.advancedSlot,
        eyebrow: "Advanced Slot",
        title: "第三个异变槽开放",
        message: "第 3 张卡开始出现高级异变。它通常会消耗异变点，但能带来更强、可继承的新能力。",
        target: "advanced-slot"
      };
    }
    if (this.shouldShowExpansionPenaltyGuide()) {
      return {
        topic: TUTORIAL_TOPICS.expansionPenalty,
        eyebrow: "Expansion Warning",
        title: "第二回合：不要无脑扩张",
        message: "扩张会消耗人口。若平均每格人口低于 2，回合推进时会失去边缘领地；先确认人口够稳，再继续扩张。",
        details: `
          <div class="context-guide-terrain-values">
            <div><strong>惩罚线</strong><span>平均人口 / 格 &lt; 2：会触发领地流失惩罚。</span></div>
            <div><strong>安全思路</strong><span>扩张前看人口消耗和平均人口，别只因为格子能点就立刻占。</span></div>
          </div>
        `,
        target: "population"
      };
    }
    if (this.shouldShowSecondExpansionTerrainGuide()) {
      return {
        topic: TUTORIAL_TOPICS.secondExpansionTerrain,
        eyebrow: "Terrain Choices",
        title: "第三回合：认识森林和沙漠",
        message: "这两个地块适合不同路线。森林偏短期扩张，沙漠偏战力成长；地图上已经分别高亮。",
        details: `
          <div class="context-guide-terrain-values">
            <div><strong>森林</strong><span>临时战力 +1，到下一个 5Ma 节点前有效，适合连续扩张。</span></div>
            <div><strong>沙漠</strong><span>人口倍率 -1，但永久战力 +1，适合走战力路线；部分异变会提供半点加成。</span></div>
          </div>
        `,
        target: "terrain"
      };
    }
    if (this.shouldShowEnemyGuide()) {
      return {
        topic: TUTORIAL_TOPICS.enemy,
        eyebrow: "First Contact",
        title: "第一次看到敌方族群",
        message: "敌群也有人口和战力。接壤后，如果它们更强，可能会争夺你的领地。你也可以夺取敌方领地，但通常要付出约 3 倍敌方格均人口的代价。",
        target: "enemy"
      };
    }
    return null;
  }

  dismissContextGuide(topic) {
    this.markContextGuideSeen(topic);
    this.render();
  }

  shouldPrepareSecondExpansionTerrain(state) {
    return (
      this.canShowContextGuide(TUTORIAL_TOPICS.secondExpansionTerrain) &&
      state.turn === 3 &&
      !state.gameOver &&
      !state.pendingMutationChoice &&
      !state.hasExpandedThisTurn &&
      [...state.tiles.values()].filter((tile) => tile.owned).length >= 2
    );
  }

  getSecondExpansionTerrainTargets() {
    return findSecondExpansionTerrainTargets(this.state);
  }

  shouldShowSecondExpansionTerrainGuide() {
    const targets = this.getSecondExpansionTerrainTargets();
    return (
      this.canShowContextGuide(TUTORIAL_TOPICS.secondExpansionTerrain) &&
      this.state.turn === 3 &&
      !this.state.gameOver &&
      !this.state.pendingMutationChoice &&
      !this.state.hasExpandedThisTurn &&
      Boolean(targets.forest || targets.desert)
    );
  }

  startTutorialGuide() {
    // 仅在玩家明确选择"开始引导"时准备教程地形，避免改写跳过教程的游戏状态。
    this.state = prepareTutorialGrassland(this.state);
    this.tutorialTargetTileKey = findTutorialGrasslandKey(this.state);
    this.tutorialStep = "end-turn";
    this.tutorialOpen = false;
    this.render();
  }

  skipTutorialGuide() {
    this.tutorialSkipped = true;
    this.tutorialStep = "done";
    this.tutorialOpen = false;
    this.seenTutorialTopics = new Set(Object.values(TUTORIAL_TOPICS));
    this.render();
  }

  finishTutorialGuide() {
    this.tutorialStep = "done";
    this.tutorialOpen = false;
  }

  toggleSkyEye() {
    // 天眼只影响显示范围，不写入核心地图状态。
    if (this.state.gameOver) return;
    this.skyEyeActive = !this.skyEyeActive;
    this.refreshSkyEyeTiles();
    const selectedTile = this.getDisplayTile(this.selectedTileKey);
    if (this.selectedTileKey && !this.isTileDisplayVisible(selectedTile)) {
      this.selectedTileKey = null;
    }
    this.render();
  }

  advanceFromState(state) {
    // 扩张后和“结束回合”共用这个入口，确保临时 UI 状态被清理。
    this.skyEyeActive = false;
    this.skyEyeTiles = new Map();
    this.selectedTileKey = null;
    this.updateState(advanceTurn(state));
  }

  advanceCurrentTurn() {
    // 待选周期异变或游戏结束时，禁止直接结束回合。
    if (this.state.pendingMutationChoice || this.state.gameOver) return;
    if (this.isTutorialStep("end-turn")) {
      this.tutorialStep = "mutation";
    }
    this.advanceFromState(this.state);
  }

  expandTileAndAdvance(tileKey) {
    // 点击扩张后先看扩张次数是否用完；免费扩张保留在当前 Ma。
    if (this.isTutorialStep("grassland") && tileKey !== this.tutorialTargetTileKey) return;
    const tile = this.state.tiles.get(tileKey);
    if (!canExpandTo(this.state, tile)) return;
    this.skyEyeActive = false;
    this.skyEyeTiles = new Map();
    this.selectedTileKey = null;
    if (this.isTutorialStep("grassland") && tileKey === this.tutorialTargetTileKey) {
      this.finishTutorialGuide();
    }
    this.updateState(resolveExpandedTurnState(expandToTile(this.state, tileKey)));
  }

  chooseMutationChoice(choiceId) {
    if (this.isTutorialStep("mutation") && choiceId !== "basic_power") return;
    const nextState = chooseMutation(this.state, choiceId);
    if (this.isTutorialStep("mutation") && choiceId === "basic_power") {
      this.tutorialStep = "grassland";
      this.tutorialTargetTileKey = findTutorialGrasslandKey(nextState) ?? this.tutorialTargetTileKey;
    }
    this.updateState(nextState);
  }

  dismissCurrentNotice() {
    const notice = this.state.notices?.[0];
    if (notice?.type === "random-event" && this.canShowContextGuide(TUTORIAL_TOPICS.randomEvent)) {
      this.markContextGuideSeen(TUTORIAL_TOPICS.randomEvent);
    }
    // notices 是队列；关闭当前弹窗后显示下一条。
    this.updateState({
      ...this.state,
      notices: (this.state.notices ?? []).slice(1)
    });
  }

  appendLocalLog(entry) {
    this.updateState({
      ...this.state,
      log: [entry, ...(this.state.log ?? [])].slice(0, 14)
    });
  }

  resetTransientUiState() {
    this.skyEyeActive = false;
    this.skyEyeTiles = new Map();
    this.selectedTileKey = null;
    this.mutationTreeOpen = false;
    this.rulebookOpen = false;
    this.tutorialOpen = false;
    this.tutorialStep = "done";
    this.tutorialSkipped = true;
    this.tutorialTargetTileKey = null;
    this.seenTutorialTopics = new Set(Object.values(TUTORIAL_TOPICS));
  }

  async saveCurrentGame() {
    // 优先保存到服务端，失败时回退到 localStorage。
    const serverId = await saveGameToServer(this.state);
    if (serverId) {
      this.appendLocalLog(`${this.state.currentMa} Ma：当前局面已保存至服务器。`);
      return;
    }
    const saved = saveGame(this.state);
    this.appendLocalLog(
      saved
        ? `${this.state.currentMa} Ma：当前局面已保存至本地。`
        : `${this.state.currentMa} Ma：保存失败，浏览器可能禁用了本地存储。`
    );
  }

  async loadSavedGame() {
    // 优先从服务端读取，失败时回退到 localStorage。
    const serverState = await loadGameFromServer();
    if (serverState) {
      this.resetTransientUiState();
      this.updateState({
        ...serverState,
        log: [`${serverState.currentMa} Ma：已读取服务器存档。`, ...(serverState.log ?? [])].slice(0, 14)
      });
      return;
    }
    const savedState = loadGame();
    if (!savedState) {
      this.appendLocalLog(`${this.state.currentMa} Ma：存档不可用或已损坏。`);
      return;
    }

    this.resetTransientUiState();
    this.updateState({
      ...savedState,
      log: [`${savedState.currentMa} Ma：已读取本地存档。`, ...(savedState.log ?? [])].slice(0, 14)
    });
  }

  render() {
    // render 拆成多个小块，方便未来只替换某个面板而不碰整体流程。
    this.renderStats();
    this.renderThreatWarnings();
    this.renderVisibleEnemySummary();
    this.renderMap();
    this.renderThreatArrowMarkers();
    this.renderTileDetail();
    this.renderLog();
    this.renderModal();
    this.renderMutationTree();
  }

  renderStats() {
    // 顶栏和左侧统计面板全部来自派生规则函数，避免 UI 自己复制玩法公式。
    const era = this.state.currentMa >= 201 ? "三叠纪" : this.state.currentMa >= 145 ? "侏罗纪" : "白垩纪";
    const species = getSpeciesNode(this.state.currentSpeciesId);
    const tilePower = getTilePowerBonus(this.state);
    const temporaryPower = getTemporaryPowerBonus(this.state);
    const totalPower = getTotalPower(this.state);
    const multiplier = getPopulationMultiplier(this.state);
    const population = Math.floor(this.state.population);
    const powerTarget = getPowerVictoryTarget(this.state);
    const adaptationValue = this.state.mutationAttributes?.adaptation ?? 0;
    const quillGrowthBonus = hasAbility(this.state, "quill_growth") ? Math.floor(this.getPlayerOwnedTileCount() / 5) : 0;

    this.elements.eraLabel.textContent = era;
    this.elements.maLabel.textContent = `${this.state.currentMa} Ma`;
    this.elements.turnLabel.textContent = `第 ${this.state.turn} 回合`;
    const attribute = getMutationAttribute(species.attribute);
    this.elements.speciesName.textContent = species.abilityName;
    this.elements.abilityName.textContent = species.id === "primitive" ? "基础" : `${attribute?.label ?? "高级"}异变`;
    this.elements.abilityDescription.innerHTML = `
      <span class="ability-text">${species.abilityDescription}</span>
      ${this.renderMutationEffectDetail(species, "hover-effect-detail")}
    `;
    this.elements.mutationPoints.textContent = formatNumber(this.state.mutationPoints);
    this.elements.mutationPoints.classList.toggle("context-guide-target", this.getActiveContextGuide()?.topic === TUTORIAL_TOPICS.mutationPoint);
    if (this.elements.basePower) {
      this.elements.basePower.textContent = this.state.basePower;
    }
    if (this.elements.tilePower) {
      this.elements.tilePower.textContent = formatNumber(tilePower + temporaryPower);
    }
    this.elements.totalPower.textContent = `${formatNumber(totalPower)}（${formatNumber(this.state.basePower)}+${formatNumber(tilePower + temporaryPower)}）`;
    this.elements.reproduction.textContent = this.state.reproduction;
    this.elements.populationMultiplier.textContent = `${formatNumber(multiplier)}x${quillGrowthBonus > 0 ? `（羽管 +${formatNumber(quillGrowthBonus)}）` : ""}`;
    // 显示预计下回合人口增长，并标注额外增长来自哪些异变。
    const growthInfo = getPopulationGrowth(this.state);
    const growthParts = [`+${formatNumber(growthInfo.baseGrowth)}`];
    if (growthInfo.lightClusterExtra > 0) growthParts.push(`+${formatNumber(growthInfo.lightClusterExtra)}（集群）`);
    if (growthInfo.featherGrowthExtra > 0) growthParts.push(`+${formatNumber(growthInfo.featherGrowthExtra)}（羽毛）`);
    const growthText = growthParts.join("");
    this.elements.population.innerHTML = `${population.toLocaleString("zh-CN")} <span class="growth-preview">${growthText}</span>`;
    this.elements.averagePopulation.textContent = this.formatAveragePopulation(this.getPlayerAveragePopulation());
    this.elements.averagePopulation.classList.toggle("context-guide-target", this.getActiveContextGuide()?.topic === TUTORIAL_TOPICS.expansionPenalty);
    this.elements.populationGoal.textContent = `人口 ${population.toLocaleString("zh-CN")} / ${VICTORY.population.toLocaleString("zh-CN")}`;
    this.elements.powerGoal.textContent = hasAbility(this.state, "flight_to_new_world")
      ? `总战力 ${formatNumber(totalPower)} / ${formatNumber(powerTarget)} ｜ 适应 ${formatNumber(adaptationValue)} / 5`
      : `总战力 ${formatNumber(totalPower)} / ${formatNumber(powerTarget)}`;
    this.elements.populationProgress.value = Math.min(population, VICTORY.population);
    this.elements.powerProgress.max = powerTarget;
    this.elements.powerProgress.value = Math.min(totalPower, powerTarget);
    this.elements.skyEyeButton.textContent = this.skyEyeActive ? "关闭天眼" : "开启天眼";
    this.elements.skyEyeButton.classList.toggle("active", this.skyEyeActive);
    this.elements.skyEyeButton.disabled = this.state.gameOver;
    this.elements.endTurnButton.disabled = this.state.pendingMutationChoice || this.state.gameOver;
    this.elements.endTurnButton.classList.toggle("tutorial-target", this.isTutorialStep("end-turn"));
    this.elements.loadGameButton.disabled = !hasSaveGame();
  }

  getPlayerAveragePopulation() {
    const ownedTileCount = [...this.state.tiles.values()].filter((tile) => tile.owned).length;
    if (ownedTileCount === 0) return 0;
    return Math.floor(this.state.population / ownedTileCount);
  }

  getAiAveragePopulation(factionId) {
    const faction = getAiFactionById(this.state, factionId);
    const tileCount = [...this.state.tiles.values()].filter((tile) => tile.aiFactionId === factionId).length;
    if (!faction || tileCount === 0) return 0;
    return Math.floor((faction.population ?? 0) / tileCount);
  }

  formatAveragePopulation(value) {
    return Math.floor(value).toLocaleString("zh-CN");
  }

  renderThreatWarnings() {
    // 仅保留占位，不输出文字——改用地图上的箭头标记。
    if (!this.elements.threatWarnings) return;
    this.elements.threatWarnings.innerHTML = "";
  }

  renderThreatArrowMarkers() {
    // 在六边形地图上绘制敌群方向箭头箭头，随地图拖拽/缩放自然移动。
    const factions = [...(this.state.aiFactions ?? [])]
      .filter((faction) => faction.warningDirection)
      .sort((left, right) => right.spawnTurn - left.spawnTurn || right.id - left.id)
      .slice(0, 3);

    if (factions.length === 0) return;

    const { x: vx, y: vy, width: vw, height: vh } = this.mapBaseViewBox;
    if (vw <= 0 || vh <= 0) return;
    const cx = vx + vw / 2;
    const cy = vy + vh / 2;
    const mapRadius = Math.max(vw, vh) * 0.42;

    // 轴向六边形的方向角度（SVG 坐标，y 向下为正）
    const directionAngles = {
      "东": 0,
      "东南": Math.PI / 3,
      "西南": 2 * Math.PI / 3,
      "西": Math.PI,
      "西北": 4 * Math.PI / 3,
      "东北": 5 * Math.PI / 3
    };

    for (const faction of factions) {
      const angle = directionAngles[faction.warningDirection];
      if (angle === undefined) continue;

      const x = cx + mapRadius * Math.cos(angle);
      const y = cy + mapRadius * Math.sin(angle);
      const arrowAngle = angle + Math.PI; // 指向地图中心
      const deg = arrowAngle * 180 / Math.PI;

      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.classList.add("threat-arrow-marker");
      group.setAttribute("transform", `translate(${x}, ${y}) rotate(${deg})`);

      // 初始威胁仅显示三角箭头，非初始威胁显示完整箭头（虚线+文字）
      const isInitial = faction.spawnTurn === 0;

      // 箭头主体（虚线）- 初始威胁不显示
      if (!isInitial) {
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", "0");
        line.setAttribute("y1", "0");
        line.setAttribute("x2", "-60");
        line.setAttribute("y2", "0");
        line.setAttribute("stroke", "#c0392b");
        line.setAttribute("stroke-width", "3");
        line.setAttribute("stroke-dasharray", "6,3");
        group.appendChild(line);
      }

      // 箭头头部
      const head = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      head.setAttribute("points", "0,-8 -20,0 0,8");
      head.setAttribute("fill", "#c0392b");
      group.appendChild(head);

      // 标签文字 - 初始威胁不显示
      if (!isInitial) {
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", "-30");
        label.setAttribute("y", "-15");
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("fill", "#e74c3c");
        label.setAttribute("font-size", "13");
        label.setAttribute("font-weight", "bold");
        label.textContent = "集结活动";
        group.appendChild(label);
      }

      this.elements.hexMap.appendChild(group);
    }
  }

  renderVisibleEnemySummary() {
    // 展示当前可见敌群的概要；天眼开启时会把天眼范围也纳入可见集合。
    const root = this.elements.visibleEnemySummary;
    if (!root) return;

    const visibleTiles = this.skyEyeActive ? this.getMapTiles() : [...this.state.tiles.values()];
    const visibleFactionIds = [
      ...new Set(
        visibleTiles
          .filter((tile) => tile.aiFactionId && tile.revealed)
          .map((tile) => tile.aiFactionId)
      )
    ];
    const summaries = visibleFactionIds
      .map((factionId) => {
        const faction = getAiFactionById(this.state, factionId);
        if (!faction) return null;
        return {
          faction,
          tileCount: [...this.state.tiles.values()].filter((tile) => tile.aiFactionId === factionId).length,
          power: getAiFactionPower(this.state, faction)
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.power - left.power || right.faction.population - left.faction.population)
      .slice(0, 3);

    if (summaries.length === 0) {
      root.classList.remove("context-guide-target");
      root.innerHTML = "";
      return;
    }

    const activeEnemyGuide = this.getActiveContextGuide()?.topic === TUTORIAL_TOPICS.enemy;
    const showEnemyGuide = false;
    root.classList.toggle("context-guide-target", activeEnemyGuide);
    root.innerHTML = `
      ${
        showEnemyGuide
          ? `
            <div class="tutorial-context-guide enemy-tutorial-guide">
              <p class="eyebrow">First Contact</p>
              <strong>第一次看到敌方族群</strong>
              <span>敌群也有人口和战力。接壤后，如果它们更强，可能会争夺你的领地。</span>
            </div>
          `
          : ""
      }
      <h3>可见敌群</h3>
      <div class="enemy-summary-list">
        ${summaries
          .map(
            ({ faction, tileCount, power }) => `
              <article>
                <div class="enemy-summary-head">
                  <strong>敌群 #${faction.id}</strong>
                  <span>${faction.warningDirection ?? "未知方向"}</span>
                </div>
                <dl>
                  <div><dt>人口</dt><dd>${Math.floor(faction.population ?? 0).toLocaleString("zh-CN")}</dd></div>
                  <div><dt>格子</dt><dd>${tileCount}</dd></div>
                  <div><dt>战力</dt><dd>${formatNumber(power)}</dd></div>
                </dl>
              </article>
            `
          )
          .join("")}
      </div>
    `;
  }

  getPopulationSummaries() {
    // 终局面板使用的种群排行，玩家始终排在第一项。
    const playerTiles = [...this.state.tiles.values()].filter((tile) => tile.owned).length;
    const playerSpecies = getSpeciesNode(this.state.currentSpeciesId);
    const playerSummary = {
      label: playerSpecies.abilityName,
      role: "玩家种群",
      population: Math.floor(this.state.population),
      power: getTotalPower(this.state),
      tileCount: playerTiles
    };
    const aiSummaries = [...(this.state.aiFactions ?? [])]
      .map((faction) => ({
        label: `敌群 #${faction.id}`,
        role: faction.warningDirection ?? "敌对族群",
        population: Math.floor(faction.population ?? 0),
        power: getAiFactionPower(this.state, faction),
        tileCount: [...this.state.tiles.values()].filter((tile) => tile.aiFactionId === faction.id).length
      }))
      .sort((left, right) => right.population - left.population || right.power - left.power || left.label.localeCompare(right.label));

    return [playerSummary, ...aiSummaries];
  }

  renderEndPopulationList() {
    // 将终局排行渲染成紧凑列表，便于对比玩家和 AI 的最终状态。
    return this.getPopulationSummaries()
      .map(
        (summary) => `
          <article class="population-result-row">
            <div>
              <strong>${summary.label}</strong>
              <span>${summary.role}</span>
            </div>
            <dl>
              <div><dt>人口</dt><dd>${summary.population.toLocaleString("zh-CN")}</dd></div>
              <div><dt>战力</dt><dd>${formatNumber(summary.power)}</dd></div>
              <div><dt>格子</dt><dd>${summary.tileCount}</dd></div>
            </dl>
          </article>
        `
      )
      .join("");
  }

  renderEndTurnHistory() {
    const history = getRecentTurnHistory(this.state, 6)
      .map((turn) => ({
        ...turn,
        events: turn.events.filter((event) => event.showInGameOver !== false)
      }))
      .filter((turn) => turn.events.length > 0)
      .slice(0, 2);
    if (history.length === 0) return "";

    return `
      <section class="end-turn-history" aria-label="最后两回合">
        <h3>最后两回合</h3>
        ${history
          .map(
            (turn) => `
              <article>
                <div class="end-turn-history-header">
                  <strong>${turn.ma} Ma</strong>
                  <span>人口 ${turn.populationBefore.toLocaleString("zh-CN")} -> ${turn.populationAfter.toLocaleString("zh-CN")} (${signed(turn.populationDelta)})</span>
                </div>
                <ol>
                  ${turn.events
                    .map(
                      (event) => `
                        <li>
                          <span>${event.text}</span>
                          <small>${event.populationBefore.toLocaleString("zh-CN")} -> ${event.populationAfter.toLocaleString("zh-CN")} (${signed(event.populationDelta)})</small>
                        </li>
                      `
                    )
                    .join("")}
                </ol>
              </article>
            `
          )
          .join("")}
      </section>
    `;
  }

  getDisplayTile(key) {
    // 选中格可能来自真实 state.tiles，也可能只来自天眼临时地图。
    if (!key) return null;
    return this.state.tiles.get(key) ?? this.skyEyeTiles.get(key) ?? null;
  }

  isTileDisplayVisible(tile) {
    // 只有已拥有、已揭示或天眼临时生成的格子能在详情面板中展示。
    if (!tile) return false;
    return tile.owned || tile.revealed || this.skyEyeTiles.has(tile.key);
  }

  refreshSkyEyeTiles() {
    // 天眼关闭时释放临时 Map，避免旧的全图视野继续影响选择逻辑。
    this.skyEyeTiles = this.skyEyeActive ? computeSkyEyeTiles(this.state) : new Map();
  }

  getMapTiles() {
    // 合并真实可见格和天眼临时格；同 key 时真实状态优先保留最新归属。
    const tilesByKey = new Map();
    for (const tile of this.state.tiles.values()) {
      if (tile.owned || tile.revealed) {
        tilesByKey.set(tile.key, tile);
      }
    }
    if (this.skyEyeActive) {
      for (const [key, tile] of this.skyEyeTiles) {
        tilesByKey.set(key, tile);
      }
    }
    return [...tilesByKey.values()];
  }

  bindMapNavigation() {
    const svg = this.elements.hexMap;
    if (!svg) return;

    svg.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.zoomMap(event.deltaY < 0 ? 0.86 : 1.16, event.clientX, event.clientY);
    }, { passive: false });

    svg.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !this.mapViewBox) return;
      this.isMapPanning = true;
      this.mapPanStart = {
        clientX: event.clientX,
        clientY: event.clientY,
        viewBox: { ...this.mapViewBox },
        distance: 0,
        captured: false
      };
    });

    svg.addEventListener("pointermove", (event) => {
      if (!this.isMapPanning || !this.mapPanStart) return;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const dx = event.clientX - this.mapPanStart.clientX;
      const dy = event.clientY - this.mapPanStart.clientY;
      this.mapPanStart.distance = Math.max(this.mapPanStart.distance, Math.hypot(dx, dy));
      if (this.mapPanStart.distance > 4) {
        if (!this.mapPanStart.captured) {
          svg.setPointerCapture?.(event.pointerId);
          this.mapPanStart.captured = true;
        }
        svg.classList.add("panning");
        this.mapUserAdjusted = true;
        this.mapViewBox = {
          ...this.mapPanStart.viewBox,
          x: this.mapPanStart.viewBox.x - (dx / rect.width) * this.mapPanStart.viewBox.width,
          y: this.mapPanStart.viewBox.y - (dy / rect.height) * this.mapPanStart.viewBox.height
        };
        this.applyMapViewBox();
      }
    });

    const endPan = (event) => {
      if (!this.isMapPanning) return;
      if (this.mapPanStart?.captured) {
        svg.releasePointerCapture?.(event.pointerId);
      }
      svg.classList.remove("panning");
      this.isMapPanning = false;
      this.suppressMapClick = (this.mapPanStart?.distance ?? 0) > 4;
      this.mapPanStart = null;
      if (this.suppressMapClick) {
        window.setTimeout(() => {
          this.suppressMapClick = false;
        }, 0);
      }
    };

    svg.addEventListener("pointerup", endPan);
    svg.addEventListener("pointercancel", endPan);
    svg.addEventListener("pointerleave", endPan);
  }

  zoomMap(scale, clientX = null, clientY = null) {
    if (!this.mapViewBox || !this.mapBaseViewBox) return;
    const minWidth = this.mapBaseViewBox.width * 0.35;
    const maxWidth = this.mapBaseViewBox.width * 2.8;
    const nextWidth = clamp(this.mapViewBox.width * scale, minWidth, maxWidth);
    const actualScale = nextWidth / this.mapViewBox.width;
    const anchor = this.getMapPoint(clientX, clientY);

    this.mapViewBox = {
      x: anchor.x - (anchor.x - this.mapViewBox.x) * actualScale,
      y: anchor.y - (anchor.y - this.mapViewBox.y) * actualScale,
      width: this.mapViewBox.width * actualScale,
      height: this.mapViewBox.height * actualScale
    };
    this.mapUserAdjusted = true;
    this.applyMapViewBox();
  }

  getMapPoint(clientX, clientY) {
    const viewBox = this.mapViewBox ?? this.mapBaseViewBox;
    const svg = this.elements.hexMap;
    const rect = svg.getBoundingClientRect();
    if (!viewBox) return { x: 0, y: 0 };
    if (clientX == null || clientY == null || rect.width === 0 || rect.height === 0) {
      return {
        x: viewBox.x + viewBox.width / 2,
        y: viewBox.y + viewBox.height / 2
      };
    }
    return {
      x: viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.width,
      y: viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.height
    };
  }

  resetMapView() {
    if (!this.mapBaseViewBox) return;
    this.mapUserAdjusted = false;
    this.mapViewBox = { ...this.mapBaseViewBox };
    this.applyMapViewBox();
  }

  applyMapViewBox() {
    if (!this.mapViewBox) return;
    const { x, y, width, height } = this.mapViewBox;
    this.elements.hexMap.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
  }

  /** 为单个地块构建悬浮提示内容 */
  buildTileTooltipContent(tile) {
    const terrain = TERRAIN_TYPES[tile.terrain];
    const isOwned = tile.owned;
    const popBonus = this.getTilePopulationContribution(tile);
    const combatSources = this.getTileCombatExtras(tile);
    const extraTotal = combatSources.reduce((sum, s) => sum + s.value, 0);

    let html = `
      <div class="tooltip-title">
        <span class="terrain-swatch" style="background:${terrain.color}"></span>
        ${terrain.label}
      </div>
      <div class="tooltip-row">
        <span class="label">人口倍率</span>
        <span class="value">${signed(popBonus.delta)}</span>
      </div>
    `;

    if (popBonus.popSources.length > 0) {
      html += `<ul class="tooltip-source-list">${popBonus.popSources.map((s) => `<li>${s}</li>`).join("")}</ul>`;
    }

    html += `<div class="tooltip-divider"></div>`;

    if (isOwned) {
      const basePower = this.state.basePower;
      html += `
        <div class="tooltip-row">
          <span class="label">战力</span>
          <span class="value">基础 ${formatNumber(basePower)} + 额外 ${formatNumber(extraTotal)}</span>
        </div>
      `;
      if (combatSources.length > 0) {
        html += `<ul class="tooltip-source-list">${combatSources.map((s) => `<li>${s.text}</li>`).join("")}</ul>`;
      }

      const ownedCount = this.getPlayerOwnedTileCount();
      const currentPop = Math.floor(this.state.population);
      const nextGrowth = getPopulationGrowth(this.state).totalGrowth;
      const popNextTurn = currentPop + nextGrowth;
      const density = this.getDensityInfo(popNextTurn, ownedCount);
      html += `
        <div class="tooltip-row">
          <span class="label">当前格均</span>
          <span class="value">${this.formatAveragePopulation(Math.floor(currentPop / ownedCount))}</span>
        </div>
        <div class="tooltip-row">
          <span class="label">下次增长</span>
          <span class="value" style="color:var(--accent-2)">+${formatNumber(nextGrowth)}</span>
        </div>
        <div class="tooltip-row">
          <span class="label">下回合格均</span>
          <span class="value">${this.formatAveragePopulation(density.avg)}</span>
        </div>
        <div class="tooltip-row">
          <span class="label">种群密度</span>
          <span class="value" style="color:${density.penalized ? "var(--danger)" : "var(--accent-2)"}">${density.penalized ? "危险" : "安全"}</span>
        </div>
      `;
      if (density.penalized) {
        html += `<div class="tooltip-row" style="font-size:0.78rem;color:var(--danger);padding-top:0">下回合可能丢失领地</div>`;
      }
    } else if (tile.aiFactionId) {
      html += `
        <div class="tooltip-row">
          <span class="label">敌群战力</span>
          <span class="value">${formatNumber(getTileAiPower(this.state, tile))}</span>
        </div>
        <div class="tooltip-row">
          <span class="label">敌群格均人口</span>
          <span class="value">${this.formatAveragePopulation(this.getAiAveragePopulation(tile.aiFactionId))}</span>
        </div>
      `;
    } else {
      const canConquer = canPlayerConquerTile(this.state, tile);
      if (canConquer) {
        const ownedCount = this.getPlayerOwnedTileCount();
        const popCost = getExpansionPopulationCost(this.state, tile);
        const currentPop = Math.floor(this.state.population);
        // 扩张后新领地的贡献
        const tileContribution = this.getTilePopulationContribution(tile);
        const newDelta = getPopulationMultiplierDelta(this.state) + tileContribution.delta;
        const newMultiplier = Math.max(1, Math.floor(1 + newDelta));
        const growthAfterBase = this.state.reproduction * newMultiplier;
        const growthAfter = growthAfterBase
          + (hasAbility(this.state, "light_cluster") ? Math.round(growthAfterBase * 0.3) : 0)
          + (hasAbility(this.state, "feather_growth") ? 2 : 0);
        // 扩张消耗 + 下回合增长后的总人口
        const popAfterExpansion = Math.max(0, currentPop - popCost);
        const popAfterGrowth = popAfterExpansion + growthAfter;
        const tileCountAfter = ownedCount + 1;
        const densityAfter = this.getDensityInfo(popAfterGrowth, tileCountAfter);
        const densityText = densityAfter.penalized ? "危险" : "安全";
        const densityColor = densityAfter.penalized ? "var(--danger)" : "var(--accent-2)";
        html += `
          <div class="tooltip-row">
            <span class="label">扩张消耗</span>
            <span class="value">${formatNumber(popCost)} 人口</span>
          </div>
          <div class="tooltip-row">
            <span class="label">下回合增长</span>
            <span class="value" style="color:var(--accent-2)">+${formatNumber(growthAfter)}</span>
          </div>
          <div class="tooltip-row">
            <span class="label">下回合格均</span>
            <span class="value">${this.formatAveragePopulation(densityAfter.avg)}</span>
          </div>
          <div class="tooltip-row">
            <span class="label">种群密度</span>
            <span class="value" style="color:${densityColor}">${densityText}</span>
          </div>
        `;
        const expansionNotes = this.getExpansionEffectNotes();
        if (expansionNotes.length > 0) {
          html += `<ul class="tooltip-source-list">${expansionNotes.map((note) => `<li>${note}</li>`).join("")}</ul>`;
        }
        if (densityAfter.penalized) {
          html += `<div class="tooltip-row" style="font-size:0.78rem;color:var(--danger);padding-top:0">下回合可能丢失领地</div>`;
        }
      } else {
        html += `<div class="tooltip-row"><span class="label" style="color:var(--danger)">不可征服</span></div>`;
      }
    }

    return html;
  }

  /** 计算种群密度信息：人口 < 领地×2 时触发惩罚 */
  getDensityInfo(population, tileCount) {
    const avg = tileCount > 0 ? Math.floor(population / tileCount) : population;
    const penalized = population < tileCount * 2;
    return { avg, penalized };
  }

  /** 获取玩家已拥有地块数 */
  getPlayerOwnedTileCount() {
    let count = 0;
    for (const tile of this.state.tiles.values()) {
      if (tile.owned) count += 1;
    }
    return count;
  }

  /** 计算单个地块的人口倍率贡献（含能力加成） */
  getTilePopulationContribution(tile) {
    let delta = tile.populationMultiplierDelta;
    const popSources = [];

    if (hasAbility(this.state, "agile_breeding") && tile.terrain === "grassland") {
      delta += 1;
      popSources.push("灵巧繁殖·湿地 +1");
    }
    if (hasAbility(this.state, "wetland_brood") && tile.terrain === "grassland") {
      delta += 1;
      popSources.push("湿地孵育·湿地 +1");
    }
    if (hasAbility(this.state, "desert_brood") && tile.terrain === "desert") {
      delta += 0.5;
      popSources.push("沙漠孵育·沙漠 +0.5");
    }
    if (hasAbility(this.state, "water_settlement") && tile.terrain === "water") {
      delta += 1;
      popSources.push("水域定居·水域 +1");
    }

    return { delta, popSources };
  }

  getExpansionEffectNotes() {
    const notes = [];
    if (hasAbility(this.state, "scent_tracking")) {
      notes.push("嗅觉追踪·普通扩张消耗 -1");
    }
    if (hasAbility(this.state, "glide_spread")) {
      notes.push("滑翔扩散·占领后额外揭示第二圈最多 2 格");
    }
    return notes;
  }

  /** 计算单个地块提供的额外战力来源 */
  getTileCombatExtras(tile) {
    const sources = [];

    if (tile.combatBonus > 0) {
      sources.push({
        text: `${TERRAIN_TYPES[tile.terrain].label}·永久 +${formatNumber(tile.combatBonus)}`,
        value: tile.combatBonus
      });
    }

    const tempBonus = TERRAIN_TYPES[tile.terrain].temporaryCombatBonus ?? 0;
    if (tempBonus > 0) {
      sources.push({
        text: `${TERRAIN_TYPES[tile.terrain].label}·临时 +${formatNumber(tempBonus)}（本周期）`,
        value: tempBonus
      });
    }

    if (hasAbility(this.state, "skull_charge") && tile.terrain === "desert") {
      sources.push({
        text: "技能「碎颅冲锋」·沙漠 +0.5",
        value: 0.5
      });
    }
    if (hasAbility(this.state, "mountain_hold") && tile.terrain === "mountain") {
      sources.push({
        text: "技能「山地据守」·山地 +1",
        value: 1
      });
    }

    return sources;
  }

  /** 显示或更新地块悬浮提示框 */
  showTileTooltip(tile, event) {
    const el = this.elements.tileTooltip;
    if (!el) return;

    const tileForDisplay = this.getDisplayTile(tile.key) ?? tile;
    el.innerHTML = this.buildTileTooltipContent(tileForDisplay);
    el.classList.remove("hidden");

    const offsetX = 16;
    const offsetY = 16;
    const maxX = window.innerWidth - el.offsetWidth - 10;
    const maxY = window.innerHeight - el.offsetHeight - 10;
    let x = event.clientX + offsetX;
    let y = event.clientY + offsetY;

    el.style.left = `${Math.min(x, maxX)}px`;
    el.style.top = `${Math.min(y, maxY)}px`;

    // 同时也更新右侧详情面板
    this.selectedTileKey = tile.key;
    this.renderTileDetail();
  }

  /** 隐藏地块悬浮提示框 */
  hideTileTooltip() {
    const el = this.elements.tileTooltip;
    if (!el) return;
    el.classList.add("hidden");
  }

  renderMap() {
    // SVG 地图每次全量重绘。当前项目规模较小，这比局部 diff 更简单可靠。
    const tiles = this.getMapTiles();
    if (tiles.length === 0) {
      this.mapBaseViewBox = { x: -HEX_SIZE * 2, y: -HEX_SIZE * 2, width: HEX_SIZE * 4, height: HEX_SIZE * 4 };
      this.mapViewBox = { ...this.mapBaseViewBox };
      this.applyMapViewBox();
      this.elements.hexMap.innerHTML = "";
      return;
    }
    const points = tiles.map((tile) => axialToPixel(tile.q, tile.r));
    const minX = Math.min(...points.map((point) => point.x)) - HEX_SIZE * 2;
    const maxX = Math.max(...points.map((point) => point.x)) + HEX_SIZE * 2;
    const minY = Math.min(...points.map((point) => point.y)) - HEX_SIZE * 2;
    const maxY = Math.max(...points.map((point) => point.y)) + HEX_SIZE * 2;

    this.mapBaseViewBox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    if (!this.mapUserAdjusted || !this.mapViewBox) {
      this.mapViewBox = { ...this.mapBaseViewBox };
    }
    this.applyMapViewBox();
    this.elements.hexMap.innerHTML = "";

    const enemyGuideTargetKey = this.getActiveContextGuide()?.topic === TUTORIAL_TOPICS.enemy ? this.getFirstVisibleEnemyTile()?.key : null;
    const terrainGuideTargets = this.shouldShowSecondExpansionTerrainGuide() ? this.getSecondExpansionTerrainTargets() : {};
    for (const tile of tiles) {
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      const isAiTile = Boolean(tile.aiFactionId);
      const isSkyEyeOnly = this.skyEyeTiles.has(tile.key) && !this.state.tiles.get(tile.key)?.revealed && !this.state.tiles.get(tile.key)?.owned;
      const isTutorialTarget = this.isTutorialStep("grassland") && tile.key === this.tutorialTargetTileKey;
      const isEnemyGuideTarget = enemyGuideTargetKey && tile.key === enemyGuideTargetKey;
      const terrainGuideType =
        tile.key === terrainGuideTargets.forest ? "forest" : tile.key === terrainGuideTargets.desert ? "desert" : null;
      const isTerrainGuideTarget = Boolean(terrainGuideType);
      group.classList.add("hex-tile");
      if (tile.owned) group.classList.add("owned");
      if (isAiTile) group.classList.add("ai-owned");
      if (isSkyEyeOnly) group.classList.add("sky-eye");
      if (isTileThreatenedByAi(this.state, tile)) group.classList.add("threatened");
      if (tile.scouted) group.classList.add("scouted");
      if (tile.key === this.selectedTileKey) group.classList.add("selected");
      if (!tile.owned) group.classList.add(canExpandTo(this.state, tile) ? "available" : "locked");
      if (isTutorialTarget || isEnemyGuideTarget || isTerrainGuideTarget) group.classList.add("tutorial-target");
      if (isEnemyGuideTarget) group.classList.add("enemy-tutorial-target");
      if (isTerrainGuideTarget) group.classList.add("terrain-tutorial-target", `${terrainGuideType}-tutorial-target`);
      if (this.isTutorialStep("grassland") && !tile.owned && !isTutorialTarget) group.classList.add("tutorial-muted");
      if (!canPlayerConquerTile(this.state, tile)) group.classList.add("impassable");
      group.dataset.key = tile.key;

      const center = axialToPixel(tile.q, tile.r);
      const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      polygon.setAttribute("points", polygonPoints(center.x, center.y, HEX_SIZE));
      polygon.setAttribute("fill", tile.owned ? OWNED_TILE_COLOR : isAiTile ? AI_TILE_COLOR : TERRAIN_TYPES[tile.terrain].color);
      group.appendChild(polygon);

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", center.x);
      label.setAttribute("y", center.y - 3);
      label.textContent = TERRAIN_TYPES[tile.terrain].label;
      group.appendChild(label);

      const subLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
      subLabel.setAttribute("x", center.x);
      subLabel.setAttribute("y", center.y + 17);
      subLabel.classList.add("sub-label");
      subLabel.textContent = tile.owned
        ? `战 ${formatNumber(getTotalPower(this.state))} / 均 ${this.formatAveragePopulation(this.getPlayerAveragePopulation())}`
        : !canPlayerConquerTile(this.state, tile)
          ? "不可征服"
          : tile.scouted
            ? "侦察"
              : `战 ${formatNumber(getEffectiveCombatRequirement(this.state, tile))} / 人 ${formatNumber(getExpansionPopulationCost(this.state, tile))}`;
      if (isAiTile) {
        subLabel.textContent = `战 ${getTileAiPower(this.state, tile)} / 均 ${this.formatAveragePopulation(this.getAiAveragePopulation(tile.aiFactionId))}`;
      }
      group.appendChild(subLabel);

      if (isTutorialTarget || isEnemyGuideTarget || isTerrainGuideTarget) {
        const cursor = document.createElementNS("http://www.w3.org/2000/svg", "text");
        cursor.setAttribute("x", center.x + HEX_SIZE * 0.75);
        cursor.setAttribute("y", center.y - HEX_SIZE * 0.75);
        cursor.classList.add("tutorial-cursor");
        cursor.textContent = isEnemyGuideTarget ? "敌人" : terrainGuideType === "forest" ? "森林" : terrainGuideType === "desert" ? "沙漠" : "点击";
        group.appendChild(cursor);
      }

      if (!tile.owned) {
        // 可扩张格点击后直接扩张；不可扩张但可见的格子点击后显示详情。
        group.addEventListener("click", () => {
          if (this.suppressMapClick) return;
          if (this.isTutorialStep("grassland") && tile.key !== this.tutorialTargetTileKey) return;
          if (canExpandTo(this.state, tile)) {
            this.expandTileAndAdvance(tile.key);
            return;
          }
          this.selectedTileKey = tile.key;
          this.render();
        });
      }

      // 悬浮显示地块信息
      group.addEventListener("mouseenter", (event) => {
        this.showTileTooltip(tile, event);
      });
      group.addEventListener("mousemove", (event) => {
        // 仅更新位置，内容不变
        const el = this.elements.tileTooltip;
        if (!el || el.classList.contains("hidden")) return;
        const ox = 16, oy = 16;
        const maxX = window.innerWidth - el.offsetWidth - 10;
        const maxY = window.innerHeight - el.offsetHeight - 10;
        el.style.left = `${Math.min(event.clientX + ox, maxX)}px`;
        el.style.top = `${Math.min(event.clientY + oy, maxY)}px`;
      });
      group.addEventListener("mouseleave", () => {
        this.hideTileTooltip();
      });

      this.elements.hexMap.appendChild(group);
    }
  }

  renderSecondExpansionTerrainGuide() {
    return "";
    if (!this.shouldShowSecondExpansionTerrainGuide()) return "";
    const targets = this.getSecondExpansionTerrainTargets();
    return `
      <div class="tutorial-context-guide terrain-tutorial-guide">
        <p class="eyebrow">Terrain Choices</p>
        <strong>森林与沙漠的用途</strong>
        <span>${targets.forest ? "森林已在地图上高亮：占领后到下一个 5Ma 节点前临时战力 +1，适合短期连续扩张。" : "遇到森林时要记得：它会提供周期内的临时战力，适合短期连续扩张。"}</span>
        <span>${targets.desert ? "沙漠已在地图上高亮：人口倍率 -1，但永久战力 +1，适合走战力路线；部分异变会提供半点加成。" : "遇到沙漠时要记得：它会降低人口增长，但能提供永久战力。"}</span>
      </div>
    `;
  }

  renderTileDetail() {
    // 右侧详情面板负责解释选中格为什么能/不能扩张。
    const tile = this.getDisplayTile(this.selectedTileKey);
    const terrainGuide = this.renderSecondExpansionTerrainGuide();
    if (!tile) {
      this.elements.tileDetail.className = terrainGuide ? "tile-detail" : "tile-detail empty";
      this.elements.tileDetail.innerHTML = `${terrainGuide}<p>选择一个可见六边形格子查看扩张条件。</p>`;
      if (terrainGuide) this.markContextGuideSeen(TUTORIAL_TOPICS.secondExpansionTerrain);
      return;
    }

    const terrain = TERRAIN_TYPES[tile.terrain];
    const canExpand = canExpandTo(this.state, tile);
    const isSkyEyeOnly = this.skyEyeTiles.has(tile.key) && !this.state.tiles.get(tile.key)?.revealed && !this.state.tiles.get(tile.key)?.owned;
    const expandHint = canExpand
      ? "可以扩张"
      : !canPlayerConquerTile(this.state, tile)
        ? "不可征服"
        : isSkyEyeOnly
          ? "天眼已揭示，仍需扩张到相邻边界后才能占领"
        : tile.scouted
          ? "已侦察，仍需扩张到相邻边界后才能占领"
          : this.state.hasExpandedThisTurn
            ? "本回合已经扩张过"
            : "当前战力或人口不足";
    const combatRequired = !canPlayerConquerTile(this.state, tile) ? "不可征服" : getEffectiveCombatRequirement(this.state, tile);
    const populationCost = !canPlayerConquerTile(this.state, tile) ? "不可征服" : getExpansionPopulationCost(this.state, tile);
    const temporaryCombatBonus = TERRAIN_TYPES[tile.terrain].temporaryCombatBonus ?? 0;
    const temporaryPowerDetail =
      temporaryCombatBonus > 0
        ? `<div><dt>临时战力</dt><dd>${signed(temporaryCombatBonus)}</dd></div>`
        : "";
    const aiPowerDetail = tile.aiFactionId ? `<div><dt>敌群战力</dt><dd>${formatNumber(getTileAiPower(this.state, tile))}</dd></div>` : "";
    const threatDetail = isTileThreatenedByAi(this.state, tile) ? `<div><dt>边境状态</dt><dd>受威胁</dd></div>` : "";
    this.elements.tileDetail.className = "tile-detail";
    this.elements.tileDetail.innerHTML = `
      ${terrainGuide}
      <div class="tile-title">
        <span class="terrain-swatch" style="background:${terrain.color}"></span>
        <strong>${terrain.label}</strong>
      </div>
      <p>${terrain.description}</p>
      <dl class="detail-list">
        <div><dt>实际战力要求</dt><dd>${formatMaybeNumber(combatRequired)}</dd></div>
        <div><dt>实际人口消耗</dt><dd>${formatMaybeNumber(populationCost)}</dd></div>
        <div><dt>人口倍率</dt><dd>${signed(tile.populationMultiplierDelta)}</dd></div>
        <div><dt>永久战力</dt><dd>${signed(tile.combatBonus)}</dd></div>
        ${temporaryPowerDetail}
        ${aiPowerDetail}
        ${threatDetail}
      </dl>
      <p class="${canExpand ? "can-expand" : "cannot-expand"}">
        ${expandHint}
      </p>
    `;
    if (terrainGuide) this.markContextGuideSeen(TUTORIAL_TOPICS.secondExpansionTerrain);
  }

  renderLog() {
    // 日志内容已经在 rules.js 截断，通过 textContent 安全渲染。
    this.elements.eventLog.replaceChildren(
      ...(this.state.log ?? []).map((entry) => {
        const li = document.createElement("li");
        li.textContent = entry;
        return li;
      })
    );
  }

  renderContextGuideCard(guide) {
    if (!guide) return "";
    return `
      <div class="context-guide-shield" aria-hidden="true"></div>
      <section class="context-guide-card context-guide-${guide.target}" role="dialog" aria-label="${guide.title}">
        <div class="context-guide-arrow" aria-hidden="true"></div>
        <p class="eyebrow">${guide.eyebrow}</p>
        <h2>${guide.title}</h2>
        <p>${guide.message}</p>
        ${guide.details ?? ""}
        <div class="context-guide-actions">
          <button class="notice-action" type="button" data-dismiss-context-guide="${guide.topic}">知道了</button>
          <button class="secondary-action" type="button" data-skip-tutorial-guide>跳过引导</button>
        </div>
      </section>
    `;
  }

  bindContextGuideActions(root, guide) {
    if (!guide) return;
    root.querySelector("[data-dismiss-context-guide]")?.addEventListener("click", () => this.dismissContextGuide(guide.topic));
    root.querySelectorAll("[data-skip-tutorial-guide]").forEach((button) => {
      button.addEventListener("click", () => this.skipTutorialGuide());
    });
  }

  renderModal() {
    // 弹窗优先级：notice 队列 > 规则书 > 终局 > 周期异变 > 隐藏。
    const root = this.elements.modalRoot;
    root.innerHTML = "";
    root.onclick = null;
    const notice = this.state.notices?.[0];
    const isLegendaryRandomEvent = notice?.type === "random-event" && notice.rarity === "legendary";
    const activeContextGuide = this.getActiveContextGuide();
    const showRandomEventGuide = false;
    document.body.classList.toggle("mass-extinction-active", notice?.type === "mass-extinction");
    document.body.classList.toggle("legendary-event-active", isLegendaryRandomEvent);

    if (this.isTutorialStep("intro")) {
      root.className = "modal-root tutorial-intro-root";
      root.setAttribute("aria-hidden", "false");
      root.innerHTML = `
        <section class="modal tutorial-modal tutorial-intro-modal" role="dialog" aria-label="新手引导">
          <p class="eyebrow">Tutorial</p>
          <h2>活到 66 Ma</h2>
          <p>你的目标是带领族群扩张、繁殖和进化，在陨石事件到来时通过人口、总战力或特殊路线幸存下来。</p>
          <div class="tutorial-actions">
            <button class="notice-action" type="button" data-start-tutorial-guide>开始引导</button>
            <button class="secondary-action" type="button" data-skip-tutorial-guide>跳过引导</button>
          </div>
        </section>
      `;
      root.querySelector("[data-start-tutorial-guide]").addEventListener("click", () => this.startTutorialGuide());
      root.querySelector("[data-skip-tutorial-guide]").addEventListener("click", () => this.skipTutorialGuide());
      return;
    }

    if (this.isTutorialStep("end-turn")) {
      root.className = "modal-root tutorial-guide-root";
      root.setAttribute("aria-hidden", "false");
      root.innerHTML = `
        <section class="tutorial-guide-card tutorial-guide-card-end" role="dialog" aria-label="结束回合引导">
          <p class="eyebrow">Step 1</p>
          <h2>先结束一个回合</h2>
          <p>点击右侧的“结束回合”，让时间前进并触发第一次战力加成选择。</p>
          <button type="button" data-skip-tutorial-guide>跳过引导</button>
        </section>
      `;
      root.querySelector("[data-skip-tutorial-guide]").addEventListener("click", () => this.skipTutorialGuide());
      return;
    }

    if (this.isTutorialStep("grassland")) {
      root.className = "modal-root tutorial-guide-root";
      root.setAttribute("aria-hidden", "false");
      root.innerHTML = `
        <section class="tutorial-guide-card tutorial-guide-card-map" role="dialog" aria-label="湿地引导">
          <p class="eyebrow">Step 3</p>
          <h2>点击温暖湿地</h2>
          <p>现在点击地图上高亮的 grassland 方块，占领它来提高人口增长。</p>
          <button type="button" data-skip-tutorial-guide>跳过引导</button>
        </section>
      `;
      root.querySelector("[data-skip-tutorial-guide]").addEventListener("click", () => this.skipTutorialGuide());
      return;
    }

    if (this.tutorialOpen) {
      root.className = "modal-root";
      root.setAttribute("aria-hidden", "false");
      root.innerHTML = `
        <section class="modal tutorial-modal" role="dialog" aria-label="新手教程">
          <div class="rulebook-header">
            <div>
              <p class="eyebrow">Tutorial</p>
              <h2>新手教程</h2>
            </div>
          </div>
          <div class="tutorial-intro">
            <p>从 252 Ma 开始扩张、繁殖和进化，在 66 Ma 陨石事件到来时幸存下来。</p>
          </div>
          <div class="tutorial-steps">
            <section>
              <h3>目标</h3>
              <ul>
                <li>人口达到 40,000</li>
                <li>总战力达到胜利目标</li>
                <li>获得特殊路线</li>
              </ul>
            </section>
            <section>
              <h3>开局</h3>
              <ul>
                <li>点击周围六边形格子查看扩张条件。</li>
                <li>优先占领人口消耗低、收益好的格子。</li>
                <li>战力不够时先结束回合，等待人口增长或异变强化。</li>
              </ul>
            </section>
            <section>
              <h3>回合</h3>
              <ul>
                <li>每回合前进 1 Ma。</li>
                <li>扩张会消耗人口，结束回合会增长人口。</li>
                <li>人口太少、领地太多时会失去边缘领地。</li>
              </ul>
            </section>
            <section>
              <h3>地形</h3>
              <ul>
                <li>湿地提高人口增长。</li>
                <li>森林提供临时战力。</li>
                <li>沙漠降低人口增长，但提供永久战力。</li>
                <li>山地 / 水域默认不能占领。</li>
              </ul>
            </section>
            <section>
              <h3>敌群</h3>
              <ul>
                <li>注意它们来自哪个方向。</li>
                <li>提前提高总战力。</li>
                <li>敌群战力超过你时，接壤后可能夺走领地。</li>
              </ul>
            </section>
            <section>
              <h3>灾变与终局</h3>
              <p>大灭绝会重塑世界并造成严重人口损失。到 66 Ma 时触发最终幸存判定。</p>
            </section>
          </div>
          <div class="tutorial-actions">
            <button class="notice-action" type="button" data-close-tutorial>开始游戏</button>
            <button class="secondary-action" type="button" data-open-rulebook-from-tutorial>查看规则书</button>
          </div>
        </section>
      `;
      root.querySelector("[data-close-tutorial]").addEventListener("click", () => {
        this.tutorialOpen = false;
        this.renderModal();
      });
      root.querySelector("[data-open-rulebook-from-tutorial]").addEventListener("click", () => {
        this.tutorialOpen = false;
        this.rulebookOpen = true;
        this.renderModal();
      });
      return;
    }

    if (notice) {
      const noticeRootClass =
        notice.type === "mass-extinction"
          ? "extinction-root"
          : notice.type === "population-density"
            ? "density-root"
            : notice.type === "habitat-cutoff"
              ? "density-root"
            : isLegendaryRandomEvent
              ? "legendary-event-root"
              : "";
      root.className = `modal-root notice-root ${noticeRootClass} ${activeContextGuide ? "context-guide-root" : ""}`;
      root.setAttribute("aria-hidden", "false");
      root.innerHTML =
        notice.type === "mass-extinction"
          ? `
            <section class="modal notice-modal extinction-modal">
              <div class="impact-sky" aria-hidden="true">
                <span class="meteor meteor-a"></span>
                <span class="meteor meteor-b"></span>
                <span class="shockwave"></span>
                <span class="ash ash-a"></span>
                <span class="ash ash-b"></span>
                <span class="ash ash-c"></span>
              </div>
              <p class="eyebrow">${notice.eyebrow}</p>
              <h2>${notice.title}</h2>
              <p>${notice.message}</p>
              <dl class="detail-list extinction-stats">
                <div><dt>种群</dt><dd>${notice.populationBefore.toLocaleString("zh-CN")} → ${notice.populationAfter.toLocaleString("zh-CN")}</dd></div>
                <div><dt>领地</dt><dd>${notice.tilesBefore} → ${notice.tilesAfter}</dd></div>
                <div><dt>损失格子</dt><dd>${notice.removedTileCount}</dd></div>
                <div><dt>灾变强度</dt><dd>90%</dd></div>
              </dl>
              <button class="notice-action" type="button" data-dismiss-notice>继续演化</button>
            </section>
          `
          : notice.type === "population-density"
            ? `
              <section class="modal notice-modal density-modal">
                <p class="eyebrow">${notice.eyebrow}</p>
                <h2>${notice.title}</h2>
                <p>${notice.message}</p>
                <dl class="detail-list">
                  <div><dt>种群</dt><dd>${notice.populationBefore.toLocaleString("zh-CN")}</dd></div>
                  <div><dt>领地</dt><dd>${notice.tilesBefore} → ${notice.tilesAfter}</dd></div>
                  <div><dt>维持需求</dt><dd>${notice.threshold.toLocaleString("zh-CN")}</dd></div>
                  <div><dt>损失格子</dt><dd>${notice.removedTileCount}</dd></div>
                </dl>
                <button class="notice-action" type="button" data-dismiss-notice>继续演化</button>
              </section>
            `
            : notice.type === "habitat-cutoff"
              ? `
                <section class="modal notice-modal density-modal">
                  <p class="eyebrow">${notice.eyebrow}</p>
                  <h2>${notice.title}</h2>
                  <p>${notice.message}</p>
                  <dl class="detail-list">
                    <div><dt>种群</dt><dd>${notice.populationBefore.toLocaleString("zh-CN")} → ${notice.populationAfter.toLocaleString("zh-CN")}</dd></div>
                    <div><dt>领地</dt><dd>${notice.tilesBefore} → ${notice.tilesAfter}</dd></div>
                    <div><dt>格均人口</dt><dd>${notice.populationPerTile.toLocaleString("zh-CN")}</dd></div>
                    <div><dt>损失格子</dt><dd>${notice.removedTileCount}</dd></div>
                  </dl>
                  <button class="notice-action" type="button" data-dismiss-notice>继续演化</button>
                </section>
              `
            : notice.type === "random-event"
              ? `
                <section class="modal notice-modal random-event-modal random-event-${notice.rarity} ${isLegendaryRandomEvent ? "legendary-event-modal" : ""} ${activeContextGuide?.topic === TUTORIAL_TOPICS.randomEvent ? "context-guide-target" : ""}">
                  ${isLegendaryRandomEvent ? `
                    <div class="legendary-event-effects" aria-hidden="true">
                      <span class="legendary-glow"></span>
                      <span class="legendary-shock legendary-shock-a"></span>
                      <span class="legendary-shock legendary-shock-b"></span>
                      <span class="legendary-fracture legendary-fracture-a"></span>
                      <span class="legendary-fracture legendary-fracture-b"></span>
                    </div>
                  ` : ""}
                  <p class="eyebrow">${notice.eyebrow}</p>
                  <h2>${notice.title}</h2>
                  <p>${notice.message}</p>
                  ${
                    showRandomEventGuide
                      ? `
                        <div class="tutorial-context-guide">
                          <p class="eyebrow">Random Event</p>
                          <strong>第一次遇到随机事件</strong>
                          <span>随机事件可能改变人口、地形、敌群或资源。先看事件效果，再决定下一回合怎么走。</span>
                        </div>
                      `
                      : ""
                  }
                  <dl class="detail-list">
                    <div><dt>事件档位</dt><dd>${notice.rarityLabel}</dd></div>
                    <div><dt>事件效果</dt><dd>${notice.effectSummary}</dd></div>
                  </dl>
                  <button class="notice-action" type="button" data-dismiss-notice>继续演化</button>
                </section>
              `
          : `
            <section class="modal notice-modal mutation-point-modal">
              <div class="mutation-pulse" aria-hidden="true">
                <span></span><span></span><span></span>
              </div>
              <p class="eyebrow">${notice.eyebrow}</p>
              <h2>${notice.title}</h2>
              <p>${notice.message}</p>
              <dl class="detail-list">
                <div><dt>当前变异点</dt><dd>${formatNumber(notice.mutationPoints)}</dd></div>
                <div><dt>可用行动</dt><dd>查看异变</dd></div>
              </dl>
              <button class="notice-action" type="button" data-dismiss-notice>继续演化</button>
            </section>
          `;
      root.innerHTML += this.renderContextGuideCard(activeContextGuide);
      this.bindContextGuideActions(root, activeContextGuide);
      root.querySelector("[data-dismiss-notice]").addEventListener("click", () => this.dismissCurrentNotice());
      return;
    }

    if (this.rulebookOpen) {
      root.className = "modal-root";
      root.setAttribute("aria-hidden", "false");
      root.innerHTML = `
        <section class="modal rulebook-modal" role="dialog" aria-label="规则书">
          <div class="rulebook-header">
            <div>
              <p class="eyebrow">Rulebook</p>
              <h2>规则书</h2>
            </div>
            <button type="button" data-close-rulebook aria-label="关闭规则书">×</button>
          </div>
          <div class="rulebook-content">
            <section>
              <h3>目标与失败</h3>
              <p>从 252 Ma 演化到 66 Ma。陨石事件到来时，人口达到 40,000、总战力达到胜利目标，或完成特殊适应路线即可幸存。人口归零或失去全部领地会立刻灭绝。</p>
            </section>
            <section>
              <h3>回合流程</h3>
              <p>每回合前进 1 Ma。回合开始会先检查栖息地连通和灭绝，随后人口按“繁殖能力 × 人口倍率”增长，再处理灾变、密度、异变、随机事件和敌群行动。</p>
            </section>
            <section>
              <h3>扩张规则</h3>
              <p>通常每回合只能占领 1 个相邻可见格子。目标必须已揭示且可征服；你的总战力必须严格高于实际战力要求，当前人口也必须严格高于显示的人口消耗。</p>
            </section>
            <section>
              <h3>地形</h3>
              <ul>
                <li>起源巢穴：开局领地，没有额外收益。</li>
                <li>温暖湿地：人口倍率 +1，战力和人口门槛更低。</li>
                <li>森林：占领后到下一个 5Ma 周期前临时战力 +1。</li>
                <li>沙漠：人口倍率 -1，但永久战力 +1，扩张成本更高；部分异变会提供半点加成。</li>
                <li>山地和水域：默认不能占领，也会阻挡继续探索。</li>
              </ul>
            </section>
            <section>
              <h3>人口与领地稳定</h3>
              <p>人口倍率最低为 1。若人口低于领地数 × 2，会随机失去 1 个非起源边缘领地。若领地被切断，只保留最大连通栖息地，孤立领地会丧失并造成人口损失。</p>
            </section>
            <section>
              <h3>异变</h3>
              <p>每个 5Ma 周期开始获得异变点，并从 4 个选项中选 1 个。前两个固定为免费基础项：繁殖能力 +1 或基础战力 +1。高级槽在第 20 / 40 回合开放；稀有消耗 5 点，罕见消耗 10 点。罕见异变需要对应属性达到 3 后才有机会出现。</p>
            </section>
            <section>
              <h3>敌群</h3>
              <p>开局会生成隐藏敌群，之后每 20 回合可能出现更强的新敌群。敌群会增长、扩张并互相攻击；当敌群战力高于你的总战力且接壤时，才会尝试攻占你的领地。</p>
            </section>
            <section>
              <h3>战斗损失</h3>
              <ul>
                <li>收复敌群格：先算敌群密度成本 <code>向上取整(敌群人口 / 敌群领地数 × 2)</code>。</li>
                <li>玩家消耗为 <code>向上取整(敌群密度成本 × 1.5)</code>；敌群损失为 <code>四舍五入(敌群密度成本 × 0.75)</code>。</li>
                <li>敌群攻占玩家格：先算玩家密度成本 <code>向上取整(玩家人口 / 玩家领地数 × 2)</code>。</li>
                <li>玩家损失为 <code>四舍五入(玩家密度成本 × 0.75)</code>；敌群损失为 <code>向上取整(玩家密度成本 × 1.5)</code>。</li>
                <li>敌群只有在人口严格大于自身损失时才会发动攻占。拥有“无损掠袭”时，玩家收复敌群格消耗减半并向上取整，但敌群仍会损失人口。</li>
              </ul>
            </section>
            <section>
              <h3>随机事件与探索</h3>
              <p>每个 5Ma 周期第三年会触发随机事件：普通 60%，稀有 30%，罕见 10%。事件可能增减人口、改变地形、揭示格子或影响敌群。天眼只临时显示全局视野，不写入核心地图。</p>
            </section>
            <section>
              <h3>灾变与终局</h3>
              <p>跨过 201 Ma 和 145 Ma 会触发大灭绝：按灾前人口 / 20 四舍五入，最多保留 10 块相连原有领地，世界地形随机重塑，并损失 90% 人口。到 66 Ma 时进行最终幸存判定。</p>
            </section>
          </div>
        </section>
      `;
      root.querySelector("[data-close-rulebook]").addEventListener("click", () => {
        this.rulebookOpen = false;
        this.renderModal();
      });
      root.onclick = (event) => {
        if (event.target === root) {
          this.rulebookOpen = false;
          this.renderModal();
        }
      };
      return;
    }

    if (this.state.gameOver) {
      root.className = "modal-root";
      root.setAttribute("aria-hidden", "false");
      root.innerHTML = `
        <section class="modal game-over-modal">
          <p class="eyebrow">${this.state.currentMa} Ma</p>
          <h2>${this.state.result.title}</h2>
          <p>${this.state.result.message}</p>
          ${this.renderEndTurnHistory()}
          <dl class="detail-list">
            <div><dt>总人口</dt><dd>${Math.floor(this.state.population).toLocaleString("zh-CN")}</dd></div>
            <div><dt>总战力</dt><dd>${formatNumber(getTotalPower(this.state))}</dd></div>
            <div><dt>最终异变</dt><dd>${getSpeciesNode(this.state.currentSpeciesId).abilityName}</dd></div>
          </dl>
          <div class="population-result-list">
            ${this.renderEndPopulationList()}
          </div>
        </section>
      `;
      return;
    }

    if (this.state.pendingMutationChoice) {
      root.className = `modal-root ${activeContextGuide ? "context-guide-root" : ""}`;
      root.setAttribute("aria-hidden", "false");
      const choices = this.state.mutationChoices ?? [];
      const tutorialMutationGuide = this.isTutorialStep("mutation")
        ? `
          <div class="tutorial-inline-guide">
            <div>
              <p class="eyebrow">Step 2</p>
              <strong>选择“基础战力 +1”</strong>
              <span>先提高战力，下一步就能占领 grassland。</span>
            </div>
            <button type="button" data-skip-tutorial-guide>跳过引导</button>
          </div>
        `
        : "";
      const showMutationPointGuide = false;
      const showAdvancedSlotGuide = false;
      const mutationGuides = [
        tutorialMutationGuide,
        showMutationPointGuide
          ? `
            <div class="tutorial-context-guide">
              <p class="eyebrow">Mutation Point</p>
              <strong>第一次获得异变点</strong>
              <span>异变点可以保留下来，用来支付更强的高级异变；免费基础项不会消耗它。</span>
            </div>
          `
          : "",
        showAdvancedSlotGuide
          ? `
            <div class="tutorial-context-guide">
              <p class="eyebrow">Advanced Slot</p>
              <strong>第三个异变槽开放</strong>
              <span>第 3 张卡开始出现高级异变，通常会消耗异变点，但能继承新的能力。</span>
            </div>
          `
          : ""
      ].join("");
      root.innerHTML = `
        <section class="modal mutation-choice-modal ${this.isTutorialStep("mutation") ? "tutorial-mutation-modal" : ""}">
          <p class="eyebrow">5Ma 稳定异变</p>
          <h2>选择一个可继承异变</h2>
          <p>当前异变点：${formatNumber(this.state.mutationPoints)}</p>
          ${mutationGuides}
          <div class="choice-grid mutation-choice-grid">
            ${choices.map((choice) => this.renderMutationChoiceCard(choice)).join("")}
          </div>
        </section>
      `;
      root
        .querySelector(".mutation-choice-modal > p:nth-of-type(2)")
        ?.classList.toggle("context-guide-target", activeContextGuide?.topic === TUTORIAL_TOPICS.mutationPoint);
      root.innerHTML += this.renderContextGuideCard(activeContextGuide);
      this.bindContextGuideActions(root, activeContextGuide);
      root.querySelectorAll("[data-mutation-choice]").forEach((button) => {
        button.addEventListener("click", () => this.chooseMutationChoice(button.dataset.mutationChoice));
      });
      root.querySelector("[data-skip-tutorial-guide]")?.addEventListener("click", () => this.skipTutorialGuide());
      return;
    }

    if (activeContextGuide) {
      root.className = "modal-root context-guide-root context-guide-map-root";
      root.setAttribute("aria-hidden", "false");
      root.innerHTML = this.renderContextGuideCard(activeContextGuide);
      this.bindContextGuideActions(root, activeContextGuide);
      return;
    }

    root.className = "modal-root hidden";
    root.setAttribute("aria-hidden", "true");
  }

  renderMutationChoiceCard(choice) {
    const tutorialLocked = this.isTutorialStep("mutation") && choice.id !== "basic_power";
    const isTutorialTarget = this.isTutorialStep("mutation") && choice.id === "basic_power";
    const isAdvancedSlotTarget = this.getActiveContextGuide()?.topic === TUTORIAL_TOPICS.advancedSlot && choice.slot === 3;
    const canChoose = canChooseMutation(this.state, choice.id) && !tutorialLocked;
    const disabledReason = tutorialLocked ? "新手引导先选择基础战力 +1" : choice.lockedReason ?? (canChoose ? "" : `需要 ${choice.cost} 异变点`);
    const reasonText = (choice.pressureReasons ?? []).join(" / ");
    const rarityClass = `rarity-${choice.rarity ?? "locked"}`;
    const node = choice.mutationId ? getSpeciesNode(choice.mutationId) : null;
    return `
      <button
        class="mutation-choice-card ${choice.type} ${rarityClass} ${canChoose ? "available" : "locked"} ${isTutorialTarget || isAdvancedSlotTarget ? "tutorial-target" : ""}"
        type="button"
        data-mutation-choice="${choice.id}"
        ${canChoose ? "" : "disabled"}
      >
        <span class="mutation-choice-meta">选项 ${choice.slot} · ${choice.attributeLabel ? `${choice.attributeLabel} · ` : ""}${choice.rarityLabel} · 消耗 ${choice.cost}</span>
        <strong>${choice.name}</strong>
        <span>${choice.abilityName}：${choice.abilityDescription}</span>
        ${node ? this.renderMutationEffectDetail(node, "mutation-effect-detail") : ""}
        <small>${canChoose ? reasonText : disabledReason}</small>
      </button>
    `;
  }

  getOwnedTerrainCount(terrainId) {
    let count = 0;
    for (const tile of this.state.tiles.values()) {
      if (tile.owned && tile.terrain === terrainId) count += 1;
    }
    return count;
  }

  getMutationEffectLines(node) {
    if (!node?.abilityId) return [];
    const ownedCount = this.getPlayerOwnedTileCount();
    const mountainCount = this.getOwnedTerrainCount("mountain");
    const waterCount = this.getOwnedTerrainCount("water");
    const grasslandCount = this.getOwnedTerrainCount("grassland");
    const desertCount = this.getOwnedTerrainCount("desert");
    const adaptationValue = this.getMutationAttributeValue("adaptation");
    const growthInfo = getPopulationGrowth(this.state);

    switch (node.abilityId) {
      case "light_cluster":
        return [`当前人口增长 +${formatEffectNumber(growthInfo.lightClusterExtra)}/回合（30%）`];
      case "ambush_hunter":
        return ["普通扩张人口消耗 ×0.8（四舍五入）"];
      case "crest_threat":
        return ["普通格战力要求 -1"];
      case "skull_charge":
        return [`每块沙漠额外战力 +0.5；当前合计 +${formatEffectNumber(desertCount * 0.5)}`];
      case "desert_brood":
        return [`每块沙漠人口倍率 +0.5；当前合计 +${formatEffectNumber(desertCount * 0.5)}`];
      case "bloodless_assault":
        return ["攻打敌群时人口消耗减半（向上取整）"];
      case "mountain_hold":
        return [`已解锁山地占领；当前山地战力 +${formatEffectNumber(mountainCount)}`];
      case "burst_stride":
        return ["每个 5Ma 周期第一次扩张人口消耗为 0"];
      case "wetland_brood":
      case "agile_breeding":
        return [`每块湿地人口倍率 +1；当前合计 +${formatEffectNumber(grasslandCount)}`];
      case "nimble_advance":
        return ["所有扩张目标战力要求 -1"];
      case "water_settlement":
        return [`已解锁水域占领；当前水域人口倍率 +${formatEffectNumber(waterCount)}`];
      case "pack_hunt":
        return [`当前总战力 +${formatEffectNumber(Math.floor(ownedCount / 5))}（每 5 领地 +1）`];
      case "last_stand_surge":
        return ["选择时人口变为 1", "选择时基础战力 +50"];
      case "scent_tracking":
        return ["普通扩张人口消耗 -1", "额外侦查边界外一圈候选格"];
      case "apex_bite":
        return [`总战力胜利门槛 ${formatEffectNumber(getPowerVictoryTarget(this.state))}（原 100）`];
      case "adaptive_mutation_gain_1":
      case "adaptive_mutation_gain_2":
        return ["每个 5Ma 周期额外获得 0.5 变异点"];
      case "feather_growth":
        return ["每回合人口增长 +2", `当前总增长 ${formatEffectNumber(growthInfo.totalGrowth)}/回合`];
      case "quill_growth":
        return [`每 5 个领地人口倍率 +1；当前额外 +${formatEffectNumber(Math.floor(ownedCount / 5))}`];
      case "flight_to_new_world": {
        const need = Math.max(0, 5 - adaptationValue);
        return [`当前适应 ${formatEffectNumber(adaptationValue)} / 5${need > 0 ? `（还差 ${formatEffectNumber(need)}）` : "（已达成）"}`, "选择时返还 2 变异点", "每个 5Ma 周期额外 +1 变异点"];
      }
      case "sickle_raid":
        return ["每周期第一次扩张不消耗本回合扩张次数"];
      case "glide_spread":
        return ["每次扩张后额外揭示第二圈最多 2 格"];
      case "brood_focus":
        return ["选择时繁殖能力 +20", "之后不能攻打敌群领地"];
      default:
        return [];
    }
  }

  renderMutationEffectDetail(node, className = "mutation-effect-detail") {
    const lines = this.getMutationEffectLines(node);
    if (lines.length === 0) return "";
    return `
      <span class="${className}">
        <strong>当前效果</strong>
        <span class="mutation-effect-lines">${lines.map((line) => `<span>${line}</span>`).join("")}</span>
      </span>
    `;
  }

  getMutationAttributeValue(attributeId) {
    return this.state.mutationAttributes?.[attributeId] ?? 0;
  }

  renderMutationAttributeChart() {
    const attributes = Object.values(MUTATION_ATTRIBUTES);
    const values = Object.fromEntries(attributes.map((attribute) => [attribute.id, this.getMutationAttributeValue(attribute.id)]));
    const maxValue = Math.max(3, ...Object.values(values));
    const vertices = {
      power: { x: 100, y: 16 },
      agility: { x: 20, y: 170 },
      adaptation: { x: 180, y: 170 }
    };
    const center = { x: 100, y: 118.7 };
    const valuePoint = (attributeId) => {
      const ratio = Math.max(0, Math.min(1, values[attributeId] / maxValue));
      const vertex = vertices[attributeId];
      return {
        x: center.x + (vertex.x - center.x) * ratio,
        y: center.y + (vertex.y - center.y) * ratio
      };
    };
    const fillPoints = ["power", "agility", "adaptation"]
      .map((attributeId) => {
        const point = valuePoint(attributeId);
        return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
      })
      .join(" ");

    return `
      <section class="mutation-attribute-chart" aria-label="异变三属性能力图">
        <div class="mutation-triangle-wrap">
          <svg class="mutation-triangle" viewBox="0 0 200 190" role="img" aria-label="力量、敏捷、适应三角图">
            <polygon class="mutation-triangle-frame" points="100,16 20,170 180,170"></polygon>
            <line class="mutation-triangle-axis" x1="100" y1="118.7" x2="100" y2="16"></line>
            <line class="mutation-triangle-axis" x1="100" y1="118.7" x2="20" y2="170"></line>
            <line class="mutation-triangle-axis" x1="100" y1="118.7" x2="180" y2="170"></line>
            <polygon class="mutation-triangle-fill" points="${fillPoints}"></polygon>
            <circle class="mutation-triangle-dot" cx="${valuePoint("power").x.toFixed(1)}" cy="${valuePoint("power").y.toFixed(1)}" r="3.5"></circle>
            <circle class="mutation-triangle-dot" cx="${valuePoint("agility").x.toFixed(1)}" cy="${valuePoint("agility").y.toFixed(1)}" r="3.5"></circle>
            <circle class="mutation-triangle-dot" cx="${valuePoint("adaptation").x.toFixed(1)}" cy="${valuePoint("adaptation").y.toFixed(1)}" r="3.5"></circle>
          </svg>
        </div>
        <div class="mutation-attribute-stats">
          ${attributes
            .map(
              (attribute) => `
                <article>
                  <span>${attribute.label}</span>
                  <strong>${values[attribute.id]}</strong>
                </article>
              `
            )
            .join("")}
        </div>
      </section>
    `;
  }

  renderMutationAttributeColumn(attribute, nodes) {
    const value = this.getMutationAttributeValue(attribute.id);
    const renderMutationRecord = (node) => `
      <article class="mutation-node unlocked" data-node-id="${node.id}">
        <div class="mutation-node-head">
          <strong>${node.abilityName}</strong>
          <span>已继承</span>
        </div>
        <div class="mutation-node-badge">${getMutationRarity(node.rarity)?.label ?? "高级"} · ${node.mutationCost}</div>
        <p>${node.abilityDescription}</p>
        ${this.renderMutationEffectDetail(node, "mutation-effect-detail")}
      </article>
    `;
    const records =
      nodes.length > 0
        ? nodes.map((node) => renderMutationRecord(node)).join("")
        : `<article class="mutation-node-empty">暂无已继承异变</article>`;

    return `
      <section class="mutation-attribute-column" data-attribute="${attribute.id}">
        <div class="mutation-column-head">
          <div>
            <p class="eyebrow">${attribute.id}</p>
            <h3>${attribute.label}</h3>
          </div>
          <strong>${value}</strong>
        </div>
        <p class="mutation-column-hint">达到 3 后解锁罕见刷新</p>
        <div class="mutation-column-list">
          ${records}
        </div>
      </section>
    `;
  }

  renderMutationTree() {
    // 永久异变记录只展示已继承的高级异变。
    const root = this.elements.mutationRoot;
    root.innerHTML = "";
    if (!this.mutationTreeOpen) {
      root.className = "mutation-root hidden";
      root.setAttribute("aria-hidden", "true");
      return;
    }

    root.className = "mutation-root";
    root.setAttribute("aria-hidden", "false");
    const unlocked = new Set(this.state.unlockedMutationIds ?? ["primitive"]);
    const advancedMutations = getAdvancedMutationNodes();
    const attributeSections = Object.values(MUTATION_ATTRIBUTES)
      .map((attribute) => {
        const nodes = advancedMutations.filter((node) => node.attribute === attribute.id && unlocked.has(node.id));
        return this.renderMutationAttributeColumn(attribute, nodes);
      })
      .join("");

    root.innerHTML = `
      <section class="mutation-window" role="dialog" aria-label="已继承异变">
        <div class="mutation-header">
          <div>
            <p class="eyebrow">Stable Mutations</p>
            <h2>已继承异变</h2>
          </div>
          <div class="mutation-summary">
            <span>变异点 <strong>${formatNumber(this.state.mutationPoints)}</strong></span>
            <button type="button" data-close-mutation aria-label="关闭异变记录">×</button>
          </div>
        </div>
        <p class="mutation-edges">这里只显示已继承的高级异变；所有已获得能力都会永久继承。</p>
        ${this.renderMutationAttributeChart()}
        <div class="mutation-attribute-columns">${attributeSections}</div>
      </section>
    `;

    root.querySelector("[data-close-mutation]").addEventListener("click", () => {
      this.mutationTreeOpen = false;
      this.renderMutationTree();
    });
    root.querySelectorAll(".mutation-node").forEach((node) => {
      node.addEventListener("mouseenter", () => {
        node.classList.add("hovered");
      });
      node.addEventListener("mouseleave", () => {
        node.classList.remove("hovered");
      });
    });
  }

}

function computeSkyEyeTiles(state) {
  // 天眼生成一个临时全局视野半径：至少 5 格，并覆盖当前玩家/AI 已生成范围。
  const normalVisibleTiles = [...state.tiles.values()].filter((tile) => tile.owned || tile.revealed);
  const aiTiles = [...state.tiles.values()].filter((tile) => tile.aiFactionId);
  const radius = Math.max(
    5,
    maxTileDistance(normalVisibleTiles),
    maxTileDistance(aiTiles)
  );
  const tiles = new Map();

  for (const coord of coordinatesWithinRadius(radius)) {
    const key = `${coord.q},${coord.r}`;
    const existingTile = state.tiles.get(key);
    const tile = existingTile ?? createTile(coord, state.turn, state.seed, false, state.terrainEpoch ?? 0);
    tiles.set(key, {
      ...tile,
      revealed: true,
      scouted: false
    });
  }

  return tiles;
}

function coordinatesWithinRadius(radius) {
  // axial 坐标中，满足距离 <= radius 的点构成一个六边形区域。
  const coords = [];
  for (let q = -radius; q <= radius; q += 1) {
    for (let r = -radius; r <= radius; r += 1) {
      const coord = { q, r };
      if (axialDistance(coord) <= radius) {
        coords.push(coord);
      }
    }
  }
  return coords;
}

function maxTileDistance(tiles) {
  // 计算一组格子距离起源的最大六边形距离。
  return tiles.reduce((max, tile) => Math.max(max, axialDistance(tile)), 0);
}

function axialDistance(coord) {
  return (Math.abs(coord.q) + Math.abs(coord.r) + Math.abs(coord.q + coord.r)) / 2;
}

function axialToPixel(q, r) {
  // axial -> SVG 像素坐标，使用尖顶六边形布局。
  return {
    x: HEX_SIZE * SQRT3 * (q + r / 2),
    y: HEX_SIZE * 1.5 * r
  };
}

function polygonPoints(cx, cy, size) {
  // 生成 SVG polygon 的 6 个顶点。
  const points = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    points.push(`${cx + size * Math.cos(angle)},${cy + size * Math.sin(angle)}`);
  }
  return points.join(" ");
}

function signed(value) {
  // 面板中统一显示 +1 / -1 这类带符号数值。
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
}

function formatMaybeNumber(value) {
  return typeof value === "number" ? formatNumber(value) : value;
}

function formatEffectNumber(value) {
  if (!Number.isFinite(value)) return `${value}`;
  return Number.isInteger(value) ? `${value}` : value.toFixed(1).replace(/\.0$/, "");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return `${value}`;
  return `${Math.floor(value)}`;
}
