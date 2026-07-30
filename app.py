"""
求职自动化与数据分析系统 - Flask 后端
=====================================
提供 API 接口 + 仪表盘页面 + 报告生成
"""

import os
import json
import re
import time
import logging
import threading
from datetime import datetime, timedelta
from collections import defaultdict

import requests
from flask import Flask, request, jsonify, render_template, send_from_directory

from config import (
    DATA_DIR, RESUME_DIR, SETTINGS_FILE,
    FLASK_HOST, FLASK_PORT, FLASK_DEBUG, DASHBOARD_PASSWORD,
    DEFAULT_SETTINGS, AVAILABLE_MODELS,
    MAX_RESUME_SIZE, MAX_RESUME_COUNT,
    build_match_evaluation_prompt, FOLLOWUP_PROMPT,
    load_settings, save_settings, get_setting,
    ensure_data_dir, invalidate_cache,
    get_resume_knowledge_base, get_version,
)

# ============================================================
# 确保数据目录存在（必须在日志初始化之前）
# ============================================================
ensure_data_dir()

# ============================================================
# 日志配置
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(os.path.join(DATA_DIR, "server.log"), encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger(__name__)

# ============================================================
# Flask 初始化
# ============================================================
app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY") or os.urandom(24)
# 强制所有 JSON 响应使用 UTF-8 编码
app.config['JSON_AS_ASCII'] = False
app.config['JSONIFY_MIMETYPE'] = 'application/json; charset=utf-8'

@app.after_request
def add_utf8_header(response):
    """确保所有响应都有正确的 UTF-8 编码头"""
    ct = response.headers.get('Content-Type', '')
    if 'application/json' in ct and 'charset' not in ct:
        response.headers['Content-Type'] = 'application/json; charset=utf-8'
    return response


# ============================================================
# 安全中间件：CORS 支持 + 可选密码保护
# ============================================================

@app.before_request
def security_middleware():
    """在每个请求前执行的安全检查"""
    # CORS：允许 Tampermonkey 脚本从 BOSS直聘页面跨域调用
    origin = request.headers.get('Origin', '')
    if origin:
        # 允许任意本地来源（Tampermonkey 从浏览器页面发起请求）
        from flask import make_response
        if request.method == 'OPTIONS':
            resp = make_response()
            resp.headers['Access-Control-Allow-Origin'] = origin
            resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
            resp.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
            resp.headers['Access-Control-Allow-Credentials'] = 'true'
            return resp

    # 可选密码保护：仅保护页面和 API（不保护健康检查）
    if DASHBOARD_PASSWORD and request.path != '/api/health':
        auth = request.headers.get('Authorization', '')
        expected = f"Bearer {DASHBOARD_PASSWORD}"
        # 也检查 cookie 中的简单 token（用于浏览器直接访问）
        cookie_auth = request.cookies.get('dashboard_auth', '')
        if auth != expected and cookie_auth != DASHBOARD_PASSWORD:
            # 如果是 API 请求，返回 401；如果是页面请求，返回登录页
            if request.path.startswith('/api/'):
                return jsonify({"success": False, "message": "未授权：请在请求头中提供 Authorization: Bearer <密码>"}), 401
            elif request.path == '/' or request.path.startswith('/static/'):
                # 简单的登录检查
                pass  # 让请求继续到路由，由前端处理


@app.after_request
def add_cors_headers(response):
    """为所有响应添加 CORS 头"""
    origin = request.headers.get('Origin', '')
    if origin:
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Access-Control-Allow-Credentials'] = 'true'
    return response

# ============================================================
# 数据持久化工具
# ============================================================

def _daily_file(date_str: str = None) -> str:
    """获取指定日期的 JSON 文件路径"""
    if date_str is None:
        date_str = datetime.now().strftime("%Y-%m-%d")
    return os.path.join(DATA_DIR, f"{date_str}.json")


def load_daily_data(date_str: str = None) -> list:
    """加载指定日期的数据，返回列表"""
    filepath = _daily_file(date_str)
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    return data
                return []
        except (json.JSONDecodeError, IOError) as e:
            logger.error(f"读取 {filepath} 失败: {e}")
            return []
    return []


def save_daily_data(records: list, date_str: str = None):
    """保存数据到指定日期的 JSON 文件"""
    filepath = _daily_file(date_str)
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False, indent=2)
        logger.info(f"数据已保存: {filepath} ({len(records)} 条记录)")
    except IOError as e:
        logger.error(f"保存 {filepath} 失败: {e}")


# ============================================================
# AI 调用工具
# ============================================================

def call_ai(prompt: str, system_prompt: str = None, temperature: float = 0.7) -> dict | None:
    """
    调用阿里云百炼 DashScope API（兼容 OpenAI 格式）
    返回解析后的 JSON dict，失败返回 None
    """
    settings = load_settings()
    api_key = settings.get("api_key", "").strip()
    if not api_key:
        logger.error("[AI] API Key 未配置")
        return None

    model = settings.get("model_name", "kimi-k2.7")
    api_url = settings.get("api_url", DEFAULT_SETTINGS["api_url"])

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": 2000,
    }

    try:
        logger.info(f"[AI] 调用模型: {model}")
        resp = requests.post(api_url, headers=headers, json=payload, timeout=60)
        if resp.status_code == 200:
            result = resp.json()
            content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
            logger.info(f"[AI] 响应成功，长度: {len(content)}")

            # 尝试从返回内容中提取 JSON
            json_match = re.search(r'\{[\s\S]*\}', content)
            if json_match:
                try:
                    return json.loads(json_match.group())
                except json.JSONDecodeError:
                    logger.warning(f"[AI] JSON 解析失败，原始: {content[:200]}")
                    return {"raw": content}
            return {"raw": content}
        else:
            logger.error(f"[AI] API 返回错误 {resp.status_code}: {resp.text[:300]}")
            return None
    except requests.exceptions.Timeout:
        logger.error("[AI] 请求超时")
        return None
    except Exception as e:
        logger.error(f"[AI] 请求异常: {e}")
        return None


def evaluate_match(job_title: str, company_name: str, job_description: str = "") -> dict:
    """评估岗位匹配度（v2：基于技能/职责语义匹配），返回 {score, reason, greeting}"""
    settings = load_settings()
    knowledge_base = get_resume_knowledge_base()
    target_roles = settings.get("target_roles", "")
    core_skills = settings.get("core_skills", "")

    prompt_template = build_match_evaluation_prompt(settings)
    prompt = prompt_template.format(
        resume_knowledge_base=knowledge_base,
        target_roles=target_roles or "未指定",
        core_skills=core_skills or "（未填写，请根据简历内容推断）",
        job_title=job_title,
        company_name=company_name,
        job_description=job_description or "（无详细描述，请仅根据岗位名称和公司名做保守评估）",
    )

    result = call_ai(prompt)
    if result is None:
        return {"score": 0, "reason": "AI 调用失败", "greeting": ""}

    if "raw" in result:
        # AI 返回了非 JSON 内容
        return {"score": 0, "reason": f"AI 返回格式异常: {result['raw'][:100]}", "greeting": ""}

    score = result.get("score", 0)
    reason = result.get("reason", "")
    greeting = result.get("greeting", "")

    # 确保 score 在有效范围
    try:
        score = int(score)
        score = max(0, min(100, score))
    except (ValueError, TypeError):
        score = 0

    return {"score": score, "reason": str(reason), "greeting": str(greeting)}


def generate_followup(job_title: str, company_name: str,
                      original_greeting: str, status: str) -> str:
    """生成跟进消息（v2：使用简历知识库）"""
    knowledge_base = get_resume_knowledge_base()
    status_text = "未读" if status == "unread" else "已读未回复"
    prompt = FOLLOWUP_PROMPT.format(
        resume_knowledge_base=knowledge_base,
        job_title=job_title,
        company_name=company_name,
        original_greeting=original_greeting,
        status_text=status_text,
    )

    result = call_ai(prompt, temperature=0.8)
    if result is None or "raw" in result:
        return ""
    return result.get("followup_message", "")


# ============================================================
# PDF 文本提取
# ============================================================

def extract_pdf_text(filepath: str) -> str:
    """使用 pdfplumber 提取 PDF 中的文本内容"""
    try:
        import pdfplumber
        text_parts = []
        with pdfplumber.open(filepath) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    text_parts.append(page_text)
        full_text = "\n".join(text_parts)
        # 清理多余空白
        full_text = re.sub(r'\n{3,}', '\n\n', full_text)
        full_text = re.sub(r' {2,}', ' ', full_text)
        return full_text.strip()
    except ImportError:
        logger.error("[PDF] pdfplumber 未安装，请执行: pip install pdfplumber")
        return ""
    except Exception as e:
        logger.error(f"[PDF] 提取文本失败: {e}")
        # 尝试用 PyPDF2 作为后备
        try:
            from PyPDF2 import PdfReader
            text_parts = []
            reader = PdfReader(filepath)
            for page in reader.pages:
                text_parts.append(page.extract_text() or "")
            return "\n".join(text_parts).strip()
        except Exception:
            return ""


# ============================================================
# API 路由：简历管理（母版知识库）
# ============================================================

@app.route("/api/resumes", methods=["GET", "POST"])
def api_resumes():
    """
    GET:  获取已上传的简历列表
    POST: 上传新的 PDF 简历（multipart/form-data, field: file）
    """
    if request.method == "GET":
        settings = load_settings()
        resume_files = settings.get("resume_files", [])
        # 隐藏敏感路径，只返回摘要
        result = []
        for rf in resume_files:
            result.append({
                "id": rf.get("id"),
                "original_name": rf.get("original_name"),
                "size": rf.get("size"),
                "text_preview": rf.get("text", "")[:150] + ("..." if len(rf.get("text", "")) > 150 else ""),
                "text_length": len(rf.get("text", "")),
                "uploaded_at": rf.get("uploaded_at"),
            })
        return jsonify({"success": True, "resumes": result, "max_count": MAX_RESUME_COUNT})

    elif request.method == "POST":
        # 检查上限
        settings = load_settings()
        resume_files = settings.get("resume_files", [])
        if len(resume_files) >= MAX_RESUME_COUNT:
            return jsonify({
                "success": False,
                "message": f"最多保存 {MAX_RESUME_COUNT} 份简历，请先删除旧的再上传",
            }), 400

        if "file" not in request.files:
            return jsonify({"success": False, "message": "请上传 PDF 文件"}), 400

        file = request.files["file"]
        if not file.filename:
            return jsonify({"success": False, "message": "文件名为空"}), 400

        # 检查扩展名
        if not file.filename.lower().endswith(".pdf"):
            return jsonify({"success": False, "message": "仅支持 PDF 格式"}), 400

        # 读取文件内容
        file_data = file.read()
        if len(file_data) > MAX_RESUME_SIZE:
            return jsonify({
                "success": False,
                "message": f"文件不能超过 {MAX_RESUME_SIZE // 1024 // 1024}MB",
            }), 400

        # 保存到永久目录
        ensure_data_dir()
        resume_id = str(int(time.time() * 1000))
        safe_name = f"resume_{resume_id}.pdf"
        dest_path = os.path.join(RESUME_DIR, safe_name)

        try:
            with open(dest_path, "wb") as f:
                f.write(file_data)
        except IOError as e:
            logger.error(f"[Resume] 写入文件失败: {e}")
            return jsonify({"success": False, "message": "保存文件失败"}), 500

        # 提取文本
        logger.info(f"[Resume] 开始提取文本: {file.filename}")
        extracted_text = extract_pdf_text(dest_path)
        if not extracted_text:
            # 文件已保存但提取失败，不删除文件，但提醒用户
            logger.warning(f"[Resume] 文本提取为空: {file.filename}")

        # 更新设置
        resume_files.append({
            "id": resume_id,
            "filename": safe_name,
            "original_name": file.filename,
            "path": dest_path,
            "text": extracted_text,
            "size": len(file_data),
            "uploaded_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        })

        current_settings = load_settings()
        current_settings["resume_files"] = resume_files
        save_settings(current_settings)
        invalidate_cache()

        logger.info(f"[Resume] 上传成功: {file.filename} ({len(file_data)} bytes, {len(extracted_text)} chars text)")
        return jsonify({
            "success": True,
            "message": f"简历「{file.filename}」已上传并解析",
            "resume_id": resume_id,
            "text_length": len(extracted_text),
        })


@app.route("/api/resumes/<resume_id>", methods=["DELETE"])
def api_delete_resume(resume_id):
    """删除指定简历"""
    settings = load_settings()
    resume_files = settings.get("resume_files", [])

    target = None
    new_list = []
    for rf in resume_files:
        if rf.get("id") == resume_id:
            target = rf
        else:
            new_list.append(rf)

    if target is None:
        return jsonify({"success": False, "message": "未找到该简历"}), 404

    # 删除磁盘文件
    try:
        if os.path.exists(target.get("path", "")):
            os.remove(target["path"])
    except OSError as e:
        logger.warning(f"[Resume] 删除文件失败: {e}")

    # 更新设置
    current = load_settings()
    current["resume_files"] = new_list
    save_settings(current)
    invalidate_cache()

    logger.info(f"[Resume] 已删除: {target.get('original_name')}")
    return jsonify({"success": True, "message": f"简历「{target.get('original_name')}」已删除"})


# ============================================================
# API 路由：设置管理
# ============================================================

@app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    """获取或更新用户设置"""
    if request.method == "GET":
        settings = load_settings()
        # 不返回敏感 API Key 的完整内容，只返回前后几位
        safe = settings.copy()
        api_key = safe.get("api_key", "")
        if api_key and len(api_key) > 8:
            safe["api_key_masked"] = api_key[:4] + "****" + api_key[-4:]
        else:
            safe["api_key_masked"] = api_key
        safe["available_models"] = AVAILABLE_MODELS
        return jsonify({"success": True, "settings": safe})

    elif request.method == "POST":
        try:
            new_settings = request.get_json(force=True)
            if not new_settings:
                return jsonify({"success": False, "message": "请求体为空"}), 400

            # 合并现有设置
            current = load_settings()
            for key in DEFAULT_SETTINGS:
                if key in new_settings and new_settings[key] is not None:
                    # ★ api_key 单独处理，防止 masked 值覆盖真实 Key
                    if key == "api_key":
                        continue
                    current[key] = new_settings[key]

            # ★ api_key 单独保护：只有用户真正输入了新 Key 才覆盖
            if "api_key" in new_settings:
                val = new_settings["api_key"].strip()
                if val and "****" not in val:
                    current["api_key"] = val

            if save_settings(current):
                invalidate_cache()
                logger.info("[API] 设置已更新")
                return jsonify({"success": True, "message": "设置已保存"})
            else:
                return jsonify({"success": False, "message": "保存失败"}), 500
        except Exception as e:
            logger.error(f"[API] 更新设置异常: {e}")
            return jsonify({"success": False, "message": str(e)}), 500


@app.route("/api/models", methods=["GET"])
def api_models():
    """获取可用模型列表"""
    return jsonify({"success": True, "models": AVAILABLE_MODELS})


# ============================================================
# API 路由：打招呼记录
# ============================================================

@app.route("/api/log_send", methods=["POST"])
def api_log_send():
    """
    记录一次成功发送的招呼
    请求体：{
        job_url, job_title, company_name, send_time,
        match_score, greeting, status (默认 "unread")
    }
    """
    try:
        data = request.get_json(force=True)
        if not data:
            return jsonify({"success": False, "message": "请求体为空"}), 400

        required = ["job_url", "job_title", "company_name"]
        for field in required:
            if not data.get(field):
                return jsonify({"success": False, "message": f"缺少必填字段: {field}"}), 400

        record = {
            "id": str(int(time.time() * 1000)),
            "job_url": data["job_url"],
            "job_title": data["job_title"],
            "company_name": data["company_name"],
            "send_time": data.get("send_time", datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
            "match_score": data.get("match_score", 0),
            "greeting": data.get("greeting", ""),
            "status": data.get("status", "unread"),
            "status_updated_at": None,
            "followed_up": False,
            "followup_time": None,
            "followup_message": None,
            "section": data.get("section", "morning"),  # morning / afternoon
        }

        records = load_daily_data()
        # 去重：同一 URL 同一天只记一次
        urls = {r.get("job_url") for r in records}
        if record["job_url"] in urls:
            return jsonify({"success": False, "message": "该岗位今日已记录，跳过"}), 409

        records.append(record)
        save_daily_data(records)

        # 更新计数器缓存
        today = datetime.now().strftime("%Y-%m-%d")
        logger.info(f"[API] 记录发送: {record['company_name']} - {record['job_title']} (匹配度: {record['match_score']})")

        return jsonify({
            "success": True,
            "message": "记录成功",
            "today_count": len(records),
            "daily_limit": get_setting("daily_limit", 150),
        })

    except Exception as e:
        logger.error(f"[API] log_send 异常: {e}")
        return jsonify({"success": False, "message": str(e)}), 500


# ============================================================
# API 路由：状态更新
# ============================================================

@app.route("/api/update_status", methods=["POST"])
def api_update_status():
    """
    批量更新对话状态
    请求体：{
        updates: [
            {job_url: "...", status: "read"|"replied"|"interview", status_updated_at: "..."},
            ...
        ]
    }
    """
    try:
        data = request.get_json(force=True)
        if not data or "updates" not in data:
            return jsonify({"success": False, "message": "缺少 updates 字段"}), 400

        updates = data["updates"]
        today = datetime.now().strftime("%Y-%m-%d")
        records = load_daily_data(today)

        updated_count = 0
        for upd in updates:
            job_url = upd.get("job_url", "").strip()
            new_status = upd.get("status", "").strip()
            if not job_url or not new_status:
                continue
            for r in records:
                if r.get("job_url") == job_url:
                    r["status"] = new_status
                    r["status_updated_at"] = upd.get("status_updated_at") or datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    updated_count += 1
                    break

        if updated_count > 0:
            save_daily_data(records, today)
        logger.info(f"[API] 状态更新: {updated_count} 条记录")
        return jsonify({"success": True, "message": f"已更新 {updated_count} 条记录", "count": updated_count})

    except Exception as e:
        logger.error(f"[API] update_status 异常: {e}")
        return jsonify({"success": False, "message": str(e)}), 500


# ============================================================
# API 路由：沉默跟进
# ============================================================

@app.route("/api/get_silent_jobs", methods=["GET"])
def api_get_silent_jobs():
    """
    获取需要沉默跟进的岗位列表
    条件：发送于 N 天前，状态为 unread 或 read，且未跟进过，匹配度 ≥ 阈值
    """
    settings = load_settings()
    silent_days = settings.get("silent_days", 3)
    followup_threshold = settings.get("followup_match_threshold", 60)
    target_date = (datetime.now() - timedelta(days=silent_days)).strftime("%Y-%m-%d")

    records = load_daily_data(target_date)
    if not records:
        return jsonify({"success": True, "jobs": [], "target_date": target_date, "message": f"{target_date} 无发送记录"})

    silent_jobs = []
    for r in records:
        if r.get("followed_up"):
            continue
        if r.get("status") not in ("unread", "read"):
            continue
        if r.get("match_score", 0) < followup_threshold:
            continue
        silent_jobs.append(r)

    logger.info(f"[API] 沉默跟进: {len(silent_jobs)} 条来自 {target_date}")
    return jsonify({
        "success": True,
        "jobs": silent_jobs,
        "target_date": target_date,
        "count": len(silent_jobs),
    })


@app.route("/api/mark_followed_up", methods=["POST"])
def api_mark_followed_up():
    """
    标记某个岗位已跟进
    请求体：{job_url, followup_message, followup_time, date: "YYYY-MM-DD"（原始发送日期）}
    """
    try:
        data = request.get_json(force=True)
        job_url = data.get("job_url", "").strip()
        date_str = data.get("date", datetime.now().strftime("%Y-%m-%d"))

        if not job_url:
            return jsonify({"success": False, "message": "缺少 job_url"}), 400

        records = load_daily_data(date_str)
        found = False
        for r in records:
            if r.get("job_url") == job_url:
                r["followed_up"] = True
                r["followup_time"] = data.get("followup_time", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
                r["followup_message"] = data.get("followup_message", "")
                found = True
                break

        if found:
            save_daily_data(records, date_str)
            logger.info(f"[API] 已标记跟进: {job_url}")
            return jsonify({"success": True, "message": "跟进状态已更新"})
        else:
            return jsonify({"success": False, "message": "未找到对应记录"}), 404

    except Exception as e:
        logger.error(f"[API] mark_followed_up 异常: {e}")
        return jsonify({"success": False, "message": str(e)}), 500


# ============================================================
# API 路由：AI 评估（供 Tampermonkey 调用）
# ============================================================

@app.route("/api/evaluate_match", methods=["POST"])
def api_evaluate_match():
    """
    评估岗位匹配度
    请求体：{job_title, company_name, job_description}
    """
    try:
        data = request.get_json(force=True)
        job_title = data.get("job_title", "")
        company_name = data.get("company_name", "")
        job_description = data.get("job_description", "")

        if not job_title:
            return jsonify({"success": False, "message": "缺少 job_title"}), 400

        result = evaluate_match(job_title, company_name, job_description)
        return jsonify({"success": True, **result})

    except Exception as e:
        logger.error(f"[API] evaluate_match 异常: {e}")
        return jsonify({"success": False, "message": str(e)}), 500


@app.route("/api/generate_followup", methods=["POST"])
def api_generate_followup():
    """
    生成跟进消息
    请求体：{job_title, company_name, original_greeting, status}
    """
    try:
        data = request.get_json(force=True)
        job_title = data.get("job_title", "")
        company_name = data.get("company_name", "")
        original_greeting = data.get("original_greeting", "")
        status = data.get("status", "unread")

        if not job_title:
            return jsonify({"success": False, "message": "缺少 job_title"}), 400

        msg = generate_followup(job_title, company_name, original_greeting, status)
        return jsonify({"success": True, "followup_message": msg})

    except Exception as e:
        logger.error(f"[API] generate_followup 异常: {e}")
        return jsonify({"success": False, "message": str(e)}), 500


# ============================================================
# API 路由：今日统计
# ============================================================

@app.route("/api/today_stats", methods=["GET"])
def api_today_stats():
    """获取今日快速统计"""
    today = datetime.now().strftime("%Y-%m-%d")
    records = load_daily_data(today)
    settings = load_settings()

    total = len(records)
    read_count = sum(1 for r in records if r.get("status") == "read")
    replied_count = sum(1 for r in records if r.get("status") == "replied")
    interview_count = sum(1 for r in records if r.get("status") == "interview")
    unread_count = sum(1 for r in records if r.get("status") == "unread")

    morning_sent = sum(1 for r in records if r.get("section") == "morning")
    afternoon_sent = sum(1 for r in records if r.get("section") == "afternoon")

    avg_score = sum(r.get("match_score", 0) for r in records) / max(total, 1)

    return jsonify({
        "success": True,
        "date": today,
        "total_sent": total,
        "daily_limit": settings.get("daily_limit", 150),
        "morning_quota": settings.get("morning_quota", 75),
        "afternoon_quota": settings.get("afternoon_quota", 75),
        "morning_sent": morning_sent,
        "afternoon_sent": afternoon_sent,
        "read_count": read_count,
        "replied_count": replied_count,
        "interview_count": interview_count,
        "unread_count": unread_count,
        "read_rate": round(read_count / max(total, 1) * 100, 1),
        "reply_rate": round(replied_count / max(read_count, 1) * 100, 1),
        "avg_match_score": round(avg_score, 1),
    })


# ============================================================
# API 路由：历史日期列表
# ============================================================

@app.route("/api/history_dates", methods=["GET"])
def api_history_dates():
    """获取所有有数据的日期列表"""
    dates = []
    try:
        for fname in os.listdir(DATA_DIR):
            if fname.endswith(".json") and fname != "settings.json":
                date_part = fname.replace(".json", "")
                if re.match(r"^\d{4}-\d{2}-\d{2}$", date_part):
                    record_count = len(load_daily_data(date_part))
                    dates.append({"date": date_part, "count": record_count})
        dates.sort(key=lambda x: x["date"], reverse=True)
    except OSError as e:
        logger.error(f"列出历史数据失败: {e}")

    return jsonify({"success": True, "dates": dates})


# ============================================================
# API 路由：生成报告
# ============================================================

@app.route("/api/generate_report", methods=["GET"])
def api_generate_report():
    """
    生成指定日期的分析报告
    参数：?date=YYYY-MM-DD（可选，默认今天）
    """
    date_str = request.args.get("date") or datetime.now().strftime("%Y-%m-%d")
    records = load_daily_data(date_str)

    if not records:
        return jsonify({
            "success": True,
            "report": None,
            "message": f"{date_str} 暂无发送数据，请先运行自动打招呼脚本。",
        })

    settings = load_settings()
    total = len(records)

    # --- 基础统计 ---
    read_count = sum(1 for r in records if r.get("status") in ("read", "replied", "interview"))
    replied_count = sum(1 for r in records if r.get("status") in ("replied", "interview"))
    interview_count = sum(1 for r in records if r.get("status") == "interview")
    unread_count = sum(1 for r in records if r.get("status") == "unread")
    read_rate = round(read_count / max(total, 1) * 100, 1)
    reply_rate = round(replied_count / max(read_count, 1) * 100, 1)

    # --- 匹配度分布 ---
    match_buckets = defaultdict(lambda: {"sent": 0, "read": 0, "replied": 0})
    for r in records:
        score = r.get("match_score", 0)
        if 70 <= score < 80:
            bucket = "70-80"
        elif 80 <= score < 90:
            bucket = "80-90"
        elif score >= 90:
            bucket = "90+"
        else:
            bucket = "<70"
        match_buckets[bucket]["sent"] += 1
        if r.get("status") in ("read", "replied", "interview"):
            match_buckets[bucket]["read"] += 1
        if r.get("status") in ("replied", "interview"):
            match_buckets[bucket]["replied"] += 1

    # 每个区间的已读率、回复率
    match_analysis = {}
    for bucket, counts in sorted(match_buckets.items()):
        match_analysis[bucket] = {
            "sent": counts["sent"],
            "read_rate": round(counts["read"] / max(counts["sent"], 1) * 100, 1),
            "reply_rate": round(counts["replied"] / max(counts["read"], 1) * 100, 1),
        }

    avg_score = round(sum(r.get("match_score", 0) for r in records) / max(total, 1), 1)

    # --- 时段对比 ---
    morning = [r for r in records if r.get("section") == "morning"]
    afternoon = [r for r in records if r.get("section") == "afternoon"]

    def _section_stats(section_records):
        s_total = len(section_records)
        s_read = sum(1 for r in section_records if r.get("status") in ("read", "replied", "interview"))
        s_replied = sum(1 for r in section_records if r.get("status") in ("replied", "interview"))
        return {
            "sent": s_total,
            "read_rate": round(s_read / max(s_total, 1) * 100, 1),
            "reply_rate": round(s_replied / max(s_read, 1) * 100, 1),
            "avg_score": round(sum(r.get("match_score", 0) for r in section_records) / max(s_total, 1), 1),
        }

    morning_stats = _section_stats(morning)
    afternoon_stats = _section_stats(afternoon)

    # 时段结论
    if morning_stats["reply_rate"] > afternoon_stats["reply_rate"]:
        section_conclusion = "上午场回复率更高，建议将高匹配度岗位优先安排在上午发送。"
    elif afternoon_stats["reply_rate"] > morning_stats["reply_rate"]:
        section_conclusion = "下午场回复率更高，可适当增加下午配额。"
    else:
        section_conclusion = "上午场与下午场回复率相近，当前配额分配合理。"

    # --- 沉默跟进 ---
    silent_days = settings.get("silent_days", 3)
    silent_target_date = (datetime.strptime(date_str, "%Y-%m-%d") - timedelta(days=silent_days)).strftime("%Y-%m-%d")
    silent_records = load_daily_data(silent_target_date)
    followed_up_today = sum(1 for r in records if r.get("followed_up"))
    silent_total = sum(1 for r in silent_records
                       if r.get("status") in ("unread", "read")
                       and not r.get("followed_up")
                       and r.get("match_score", 0) >= settings.get("followup_match_threshold", 60))

    # --- 原因分析与建议 ---
    suggestions = []
    if avg_score < 75:
        suggestions.append("平均匹配度偏低（<75%），建议将匹配度阈值提升至75%以提高已读率和回复率。")
    if read_rate < 30 and total > 10:
        suggestions.append(f"已读率仅{read_rate}%，招呼语可能吸引力不足，建议优化招呼语模板或缩短内容，突出核心匹配点。")
    if morning_stats["sent"] > afternoon_stats["sent"] * 1.5:
        suggestions.append("上午发送量远高于下午，建议平衡时段分布，避免集中发送被系统限流。")
    if not suggestions:
        suggestions.append("当前数据表现正常，继续保持现有策略，关注后续回复转化。")
    if len(suggestions) < 3:
        suggestions.append("建议持续关注已读未回岗位，在24-48小时内手动追加个性化跟进消息。")

    # --- 待跟进事项 ---
    follow_up_items = []
    for r in records:
        if r.get("status") == "read" and r.get("match_score", 0) >= 85 and not r.get("followed_up"):
            follow_up_items.append({
                "job_title": r.get("job_title"),
                "company_name": r.get("company_name"),
                "match_score": r.get("match_score"),
                "send_time": r.get("send_time"),
            })

    # --- 组装报告 ---
    report = {
        "date": date_str,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),

        "funnel": {
            "total_sent": total,
            "read_count": read_count,
            "read_rate": read_rate,
            "replied_count": replied_count,
            "reply_rate": reply_rate,
            "interview_count": interview_count,
            "unread_count": unread_count,
            "avg_match_score": avg_score,
        },

        "match_analysis": match_analysis,
        "avg_match_score": avg_score,

        "section_comparison": {
            "morning": morning_stats,
            "afternoon": afternoon_stats,
            "conclusion": section_conclusion,
        },

        "silent_followup": {
            "followed_up_today": followed_up_today,
            "target_date": silent_target_date,
            "silent_count": silent_total,
            "note": f"检查 {silent_target_date} 的沉默岗位，共 {silent_total} 条待跟进" if silent_total > 0 else "无需跟进",
        },

        "suggestions": suggestions,

        "follow_up_items": follow_up_items,
    }

    logger.info(f"[Report] 生成 {date_str} 报告成功，{total} 条记录")
    return jsonify({"success": True, "report": report})


# ============================================================
# 仪表盘页面
# ============================================================

@app.route("/")
def index():
    """仪表盘首页"""
    return render_template("index.html")


@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory("static", filename)


# ============================================================
# 健康检查
# ============================================================

@app.route("/api/health", methods=["GET"])
def api_health():
    settings = load_settings()
    api_configured = bool(settings.get("api_key", "").strip())
    return jsonify({
        "success": True,
        "status": "running",
        "api_configured": api_configured,
        "model": settings.get("model_name"),
        "timestamp": datetime.now().isoformat(),
    })


# ============================================================
# 版本信息
# ============================================================

@app.route("/api/version", methods=["GET"])
def api_version():
    """获取当前系统版本"""
    return jsonify({
        "success": True,
        "version": get_version(),
        "update_check_url": load_settings().get("update_check_url", ""),
    })


# ============================================================
# 错误处理
# ============================================================

@app.errorhandler(404)
def not_found(e):
    return jsonify({"success": False, "message": "接口不存在"}), 404


@app.errorhandler(500)
def server_error(e):
    return jsonify({"success": False, "message": "服务器内部错误"}), 500


# ============================================================
# 启动入口
# ============================================================

def main():
    logger.info("=" * 60)
    logger.info("求职自动化与数据分析系统 启动中...")
    logger.info(f"数据目录: {DATA_DIR}")
    logger.info(f"访问地址: http://{FLASK_HOST}:{FLASK_PORT}")
    logger.info(f"调试模式: {'⚠️  开启（生产环境请关闭）' if FLASK_DEBUG else '关闭'}")
    logger.info(f"仪表盘认证: {'已启用' if DASHBOARD_PASSWORD else '⚠️  未启用（建议设置 DASHBOARD_PASSWORD 环境变量）'}")
    logger.info(f"当前模型: {load_settings().get('model_name', 'unknown')}")
    logger.info(f"系统版本: v{get_version()}")
    logger.info("=" * 60)

    # 安全检查提示
    if FLASK_DEBUG:
        logger.warning("⚠️  Flask Debug 模式已开启！生产环境请设置 FLASK_DEBUG=false")
    if FLASK_HOST != "127.0.0.1":
        logger.warning("⚠️  监听非本地地址，请确保已设置 DASHBOARD_PASSWORD 环境变量！")
    if not DASHBOARD_PASSWORD:
        logger.info("💡 提示：设置环境变量 DASHBOARD_PASSWORD=你的密码 可启用仪表盘访问保护")

    app.run(host=FLASK_HOST, port=FLASK_PORT, debug=FLASK_DEBUG)


if __name__ == "__main__":
    main()
