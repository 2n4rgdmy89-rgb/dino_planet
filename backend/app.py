"""恐龙星球 Flask 后端 — 静态文件服务 + 存档 API"""

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

# ── 基础配置 ──────────────────────────────────────────────
# 项目根目录（index.html 所在位置）
PROJECT_ROOT = Path(__file__).resolve().parent.parent
SAVE_DIR = PROJECT_ROOT / "saves"

app = Flask(__name__, static_folder=None)  # 禁用内置 static，自己控制路由
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024  # 存档上限 2 MB


# ── 辅助函数 ──────────────────────────────────────────────
def _ensure_save_dir():
    SAVE_DIR.mkdir(parents=True, exist_ok=True)


def _save_path(save_id: str) -> Path:
    return SAVE_DIR / f"{save_id}.json"


def _list_saves():
    """返回所有存档摘要，按保存时间倒序。"""
    _ensure_save_dir()
    saves = []
    for p in SAVE_DIR.glob("*.json"):
        try:
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
            saves.append({
                "id": p.stem,
                "savedAt": data.get("savedAt", ""),
                "turn": data.get("state", {}).get("turn", 0),
                "currentMa": data.get("state", {}).get("currentMa", 252),
            })
        except (json.JSONDecodeError, OSError):
            continue
    saves.sort(key=lambda s: s["savedAt"], reverse=True)
    return saves


# ── 前端静态文件路由 ──────────────────────────────────────
@app.route("/")
def serve_index():
    return send_from_directory(PROJECT_ROOT, "index.html")


@app.route("/<path:filename>")
def serve_static(filename):
    """提供 src/、scripts/、docs/ 等目录下的静态文件。"""
    filepath = (PROJECT_ROOT / filename).resolve()
    # 安全检查：不允许跳出项目根目录
    if not filepath.is_relative_to(PROJECT_ROOT):
        return jsonify({"error": "Forbidden"}), 403
    if not filepath.is_file():
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(PROJECT_ROOT, filename)


# ── 存档 API ─────────────────────────────────────────────
@app.route("/api/saves", methods=["GET"])
def api_list_saves():
    """GET /api/saves — 列出所有存档摘要"""
    return jsonify({"saves": _list_saves()})


@app.route("/api/saves", methods=["POST"])
def api_create_save():
    """POST /api/saves — 创建新存档，body 为完整 serializeState 输出"""
    payload = request.get_json(silent=True)
    if not payload or not isinstance(payload, dict):
        return jsonify({"error": "无效的存档数据"}), 400

    _ensure_save_dir()
    save_id = uuid.uuid4().hex[:8]
    payload["savedAt"] = datetime.now(timezone.utc).isoformat()
    # 如果前端没传 id 字段，补上
    payload["id"] = save_id

    with open(_save_path(save_id), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    return jsonify({"id": save_id, "savedAt": payload["savedAt"]}), 201


@app.route("/api/saves/<save_id>", methods=["GET"])
def api_get_save(save_id: str):
    """GET /api/saves/:id — 读取指定存档"""
    path = _save_path(save_id)
    if not path.is_file():
        return jsonify({"error": "存档不存在"}), 404
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return jsonify(data)
    except (json.JSONDecodeError, OSError):
        return jsonify({"error": "存档已损坏"}), 500


@app.route("/api/saves/<save_id>", methods=["DELETE"])
def api_delete_save(save_id: str):
    """DELETE /api/saves/:id — 删除指定存档"""
    path = _save_path(save_id)
    if not path.is_file():
        return jsonify({"error": "存档不存在"}), 404
    path.unlink()
    return jsonify({"deleted": save_id})


@app.route("/api/saves/latest", methods=["GET"])
def api_get_latest_save():
    """GET /api/saves/latest — 读取最近一次存档"""
    saves = _list_saves()
    if not saves:
        return jsonify({"error": "没有存档"}), 404
    latest = saves[0]
    return api_get_save(latest["id"])


# ── 健康检查 ─────────────────────────────────────────────
@app.route("/api/health", methods=["GET"])
def api_health():
    return jsonify({"status": "ok", "version": "1.0.0"})


# ── 入口 ─────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "1") == "1"
    print(f"恐龙星球后端启动 → http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=debug)
