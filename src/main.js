import { createInitialState } from "./gameState.js";
import { GameUI } from "./ui.js";

// 浏览器入口：创建初始状态，交给 UI 层完成首次渲染和后续交互绑定。
const ui = new GameUI(createInitialState());
ui.render();
