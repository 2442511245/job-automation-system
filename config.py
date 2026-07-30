"""
求职自动化与数据分析系统 - 全局配置
=====================================
默认配置 + 用户设置管理。
用户可通过仪表盘修改简历、岗位、API Key、模型等，
所有修改持久化到 settings.json

注意：所有个人信息通过 settings.json 注入，不要在此文件中硬编码。
"""

import os
import json
import threading

# ============================================================
# 数据存储路径
# ============================================================
DATA_DIR = os.path.join(os.path.expanduser("~"), "JobReports")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
RESUME_DIR = os.path.join(DATA_DIR, "resumes")  # 母版简历知识库目录（永久存储）

# ============================================================
# 版本信息
# ============================================================
def get_version() -> str:
    """读取当前版本号"""
    version_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "VERSION")
    try:
        with open(version_file, "r", encoding="utf-8") as f:
            return f.read().strip()
    except (IOError, FileNotFoundError):
        return "unknown"

# 确保目录存在
def ensure_data_dir():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(RESUME_DIR, exist_ok=True)

# ============================================================
# 默认设置（当 settings.json 不存在时使用）
# ============================================================
DEFAULT_SETTINGS = {
    # --- 母版简历知识库 ---
    # resume_files: [{id, filename, original_name, path, text, size, uploaded_at}, ...]
    # 最多 3 份 PDF 简历，永久存储在 RESUME_DIR
    "resume_files": [],

    # 手动补充的简历文本（可选，会合并到 AI 评估上下文中）
    "resume_text": "",

    # --- 智能匹配配置 ---
    # target_roles: 对目标岗位的语义描述（不是固定职位名）
    # 例如: "Java后端开发，微服务架构方向，偏高性能服务端"
    "target_roles": "Java后端开发",

    # core_skills: 核心技能关键词，用于辅助 AI 理解你的能力边界
    "core_skills": "",

    # --- 候选人档案（用于 AI 匹配评估，请在仪表盘中填写） ---
    "candidate_name": "",                    # 姓名
    "candidate_education": "",               # 学历/学校/毕业年份
    "candidate_highlights": "",              # 量化亮点（每行一条，用于招呼语引用）
    "candidate_github": "",                  # GitHub 主页或项目链接

    # 招呼语模板（三选一，AI 会自动选择最匹配的微调）
    "greeting_template_a": "",               # 模板A：偏技术/Agent开发岗
    "greeting_template_b": "",               # 模板B：偏产品/AI解决方案岗
    "greeting_template_c": "",               # 模板C：通用版

    # --- AI 模型配置 ---
    "api_key": "",                          # 阿里云百炼 API Key（用户自行填写）
    "model_name": "kimi-k2.7",             # 模型 ID，可在仪表盘切换
    "api_url": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",

    # --- 打招呼策略 ---
    "match_threshold": 70,                  # 匹配度阈值（0-100）
    "daily_limit": 150,                     # 每日发送上限
    "morning_quota": 75,                    # 上午配额
    "afternoon_quota": 75,                  # 下午配额
    "morning_start": 9,                     # 上午开始（时）
    "morning_end": 11,                      # 上午结束（时）
    "afternoon_start": 14,                  # 下午开始（时）
    "afternoon_end": 16,                    # 下午结束（时）

    # --- 沉默跟进 ---
    "silent_days": 3,                       # 沉默多少天后跟进
    "followup_match_threshold": 60,         # 跟进最低匹配度
    "followup_check_hour": 17,              # 每天检查跟进的时间（时）

    # --- 状态采集 ---
    "collection_reminder_time": "19:50",    # 每日提醒时间

    # --- 更新检查 ---
    "update_check_url": "",                 # 检查更新的远程地址（由卖家提供）
}

# ============================================================
# 可用模型列表（供仪表盘下拉选择）
# ============================================================
AVAILABLE_MODELS = [
    {"id": "kimi-k2.7",       "name": "Kimi K2.7（月之暗面）",       "provider": "阿里云百炼"},
    {"id": "qwen3.7-max",     "name": "通义千问 3.7 Max",            "provider": "阿里云百炼"},
    {"id": "qwen3.5-max",     "name": "通义千问 3.5 Max",            "provider": "阿里云百炼"},
    {"id": "qwen-plus",       "name": "通义千问 Plus",               "provider": "阿里云百炼"},
    {"id": "deepseek-v3",     "name": "DeepSeek V3",                 "provider": "阿里云百炼"},
    {"id": "deepseek-r1",     "name": "DeepSeek R1",                 "provider": "阿里云百炼"},
]

# 最大简历文件大小（10MB）
MAX_RESUME_SIZE = 10 * 1024 * 1024
# 最大简历数量
MAX_RESUME_COUNT = 3


def get_resume_knowledge_base() -> str:
    """
    构建完整的简历知识库文本（合并所有已上传简历 + 手动补充文本）。
    AI 匹配评估时使用此文本作为候选人的完整画像。
    """
    settings = load_settings()
    parts = []

    # 1. 已上传的 PDF 简历
    resume_files = settings.get("resume_files", [])
    for i, rf in enumerate(resume_files, 1):
        text = rf.get("text", "").strip()
        if text:
            parts.append(f"【简历 {i}：{rf.get('original_name', '')}】\n{text}")

    # 2. 手动补充的简历文本
    manual = settings.get("resume_text", "").strip()
    if manual:
        parts.append(f"【补充信息】\n{manual}")

    return "\n\n".join(parts) if parts else "（尚未上传简历或填写简历信息）"


# ============================================================
# 设置读写（线程安全）
# ============================================================
_settings_lock = threading.Lock()
_cached_settings: dict | None = None


def load_settings() -> dict:
    """加载用户设置，如果文件不存在则返回默认设置"""
    global _cached_settings
    with _settings_lock:
        if _cached_settings is not None:
            return _cached_settings.copy()

        ensure_data_dir()
        if os.path.exists(SETTINGS_FILE):
            try:
                with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                    saved = json.load(f)
                merged = DEFAULT_SETTINGS.copy()
                merged.update(saved)
                _cached_settings = merged
                return merged.copy()
            except (json.JSONDecodeError, IOError) as e:
                print(f"[Config] 读取 settings.json 失败: {e}，使用默认设置")
                _cached_settings = DEFAULT_SETTINGS.copy()
                return DEFAULT_SETTINGS.copy()
        else:
            _cached_settings = DEFAULT_SETTINGS.copy()
            return DEFAULT_SETTINGS.copy()


def save_settings(settings: dict) -> bool:
    """保存用户设置到磁盘"""
    global _cached_settings
    with _settings_lock:
        try:
            ensure_data_dir()
            with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
                json.dump(settings, f, ensure_ascii=False, indent=2)
            _cached_settings = settings.copy()
            return True
        except IOError as e:
            print(f"[Config] 保存 settings.json 失败: {e}")
            return False


def get_setting(key: str, default=None):
    """获取单个配置项"""
    settings = load_settings()
    return settings.get(key, default)


def invalidate_cache():
    """使缓存失效（手动编辑文件后调用）"""
    global _cached_settings
    with _settings_lock:
        _cached_settings = None


def get_model_presets():
    """返回可用模型预设列表"""
    return AVAILABLE_MODELS


# ============================================================
# Flask 服务配置
# ============================================================
FLASK_HOST = os.environ.get("FLASK_HOST", "127.0.0.1")
FLASK_PORT = int(os.environ.get("FLASK_PORT", "5000"))
FLASK_DEBUG = os.environ.get("FLASK_DEBUG", "false").lower() == "true"

# 仪表盘访问密码（可选保护，留空则不启用认证）
DASHBOARD_PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "")

# ============================================================
# AI 系统提示词（v2：基于技能/职责的语义匹配）
# 个人信息从 settings.json 动态注入，不要硬编码在此文件中。
# ============================================================

def build_match_evaluation_prompt(settings: dict) -> str:
    """
    根据用户设置动态构建 AI 匹配评估提示词。
    所有个人信息从 settings.json 读取，不硬编码。
    """
    candidate_name = settings.get("candidate_name", "").strip()
    candidate_education = settings.get("candidate_education", "").strip()
    candidate_highlights = settings.get("candidate_highlights", "").strip()
    candidate_github = settings.get("candidate_github", "").strip()

    # 构建候选人档案行
    profile_parts = []
    if candidate_name:
        profile_parts.append(f"姓名：{candidate_name}")
    if candidate_education:
        profile_parts.append(candidate_education)
    candidate_info = " | ".join(profile_parts) if profile_parts else "（请在仪表盘「系统设置」中填写姓名和学历信息）"

    # 量化亮点
    if candidate_highlights:
        highlights_text = candidate_highlights
    else:
        highlights_text = "- （请在仪表盘「系统设置」中填写个人量化亮点）"

    # GitHub 引用
    github_ref = f"\n- GitHub: {candidate_github}" if candidate_github else ""

    # 招呼语模板
    template_a = settings.get("greeting_template_a", "").strip()
    template_b = settings.get("greeting_template_b", "").strip()
    template_c = settings.get("greeting_template_c", "").strip()

    if not template_a:
        template_a = "（请在仪表盘「系统设置」中填写招呼语模板A — 偏技术开发岗）"
    if not template_b:
        template_b = "（请在仪表盘「系统设置」中填写招呼语模板B — 偏产品方案岗）"
    if not template_c:
        template_c = "（请在仪表盘「系统设置」中填写招呼语模板C — 通用版）"

    prompt = f"""你是一位专业的招聘匹配度评估专家。请基于候选人完整画像与目标岗位进行**关键词驱动的语义匹配评估**。

【候选人核心档案】
{candidate_info}
求职方向：{{target_roles}}
核心技能：{{core_skills}}

简历详情：
{{resume_knowledge_base}}

【候选人量化亮点（招呼语中可引用的硬证据）】
{highlights_text}{github_ref}

【匹配度关键词速查表】
对照JD，每命中一个关键词类别 +15~20分。根据候选人档案中体现的技能领域自动判断。

命中3个以上关键词 → 80-95分；命中1-2个 → 60-75分；完全不沾边 → 30-50分。
在此基础上，根据JD具体要求的匹配精度和候选人经验深度±5分微调。

【目标岗位】
- 岗位名称：{{job_title}}
- 公司名称：{{company_name}}
- 岗位描述：{{job_description}}

【匹配原则】
1. 不要被岗位名称限制——聚焦JD中的实际职责和技术栈
2. 技能覆盖60%以上即为良好匹配
3. 经验可迁移，不受行业/业务场景限制
4. 求职意向为软偏好，不是硬性过滤

【招呼语模板库——必须从以下三选一，仅做微调，不超过80字】

模板A（偏技术/Agent开发岗）：
{template_a}

模板B（偏产品/AI解决方案岗）：
{template_b}

模板C（通用版）：
{template_c}

【输出要求】
1. 用关键词速查表打分，给出0-100的匹配度
2. 用1-2句话说明命中了哪些关键词
3. 从模板A/B/C中选最匹配的一个，微调前三句使其更贴合JD（但保留量化数据），不超80字
4. 匹配度<70时greeting留空

严格按JSON格式返回，不要其他内容：
{{{{"score": 85, "reason": "命中Agent开发+RAG+API后端3个关键词，JD要求LangChain与FastAPI高度吻合...", "greeting": "您好，我有AI Agent全栈开发..."}}}}
匹配度<70时greeting设为""。"""

    return prompt


FOLLOWUP_PROMPT = """你是一位求职者，需要跟进之前发送的招呼消息。

【你的背景】
{resume_knowledge_base}

【目标岗位】
岗位名称：{job_title}
公司名称：{company_name}

【之前的招呼语】
{original_greeting}

【当前状态】
{status_text}

【跟进要求】
- 状态为"未读"：礼貌地再次表达诚意，提及一个核心匹配点，30-50字
- 状态为"已读未回"：简短补充一个亮点或询问，20-40字，语气轻松不催促
- 不要重复原招呼语的内容

只返回 JSON：{{"followup_message": "..."}}"""


# ============================================================
# 启动时初始化
# ============================================================
if __name__ == "__main__":
    ensure_data_dir()
    settings = load_settings()
    print(f"[Config] 数据目录: {DATA_DIR}")
    print(f"[Config] 简历目录: {RESUME_DIR}")
    print(f"[Config] 已上传简历: {len(settings.get('resume_files', []))} 份")
    print(f"[Config] 当前模型: {settings['model_name']}")
    print(f"[Config] 匹配度阈值: {settings['match_threshold']}")
