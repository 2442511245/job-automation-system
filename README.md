# 🤖 求职自动化与数据分析系统

BOSS直聘全自动打招呼 + 数据分析仪表盘，帮你高效求职。

## 📁 项目结构

```
job-automation-system/
├── app.py                          # Flask 后端（API + 报告生成 + AI 转发）
├── config.py                       # 全局配置与设置持久化
├── requirements.txt                # Python 依赖
├── README.md                       # 本文件
├── templates/
│   └── index.html                  # 仪表盘前端页面
├── static/
│   ├── style.css                   # 仪表盘样式
│   └── dashboard.js                # 仪表盘交互逻辑
└── tampermonkey/
    └── boss-automation.user.js     # Tampermonkey 浏览器自动化脚本
```

## 🚀 快速启动

### 1. 安装 Python 依赖

```bash
pip install -r requirements.txt
```

### 2. 启动 Flask 后端

```bash
python app.py
```

启动后访问：**http://localhost:5000**

### 3. 配置系统

打开仪表盘 → 点击左侧 **「系统设置」**：

| 配置项 | 说明 |
|--------|------|
| **API Key** | 阿里云百炼 DashScope 的 API Key（[获取地址](https://dashscope.console.aliyun.com/apiKey)） |
| **AI 模型** | 选择模型，默认 `kimi-k2.7`，可在下拉列表中切换 |
| **简历文本** | 你的个人优势、技术栈、项目经验 |
| **期望岗位** | 最多 3 个，AI 匹配评估时参考 |
| **匹配度阈值** | 低于此分数的岗位不发送招呼 |
| **每日上限** | 每天最多发送数（默认 150） |

所有设置自动保存到 `~/JobReports/settings.json`。

### 4. 安装 Tampermonkey 脚本

1. 浏览器安装 [Tampermonkey 扩展](https://www.tampermonkey.net/)
2. 打开 Tampermonkey 管理面板 → **新建脚本**
3. 将 `tampermonkey/boss-automation.user.js` 的内容完整粘贴进去
4. 保存（Ctrl+S）

### 5. 开始使用

1. 打开 [BOSS直聘搜索页](https://www.zhipin.com/web/geek/) 并搜索岗位
2. 页面右下角会出现 **JobBot 控制面板**
3. 点击 **「▶ 启动」** 按钮，脚本自动开始工作

## 📊 功能一览

### 自动打招呼
- ✅ 仅在搜索结果页生效
- ✅ 分时段：上午 9:00-11:00（75个）、下午 14:00-16:00（75个）
- ✅ AI 匹配评估，匹配度 ≥ 阈值才发送
- ✅ 真人模拟：随机 20-60 秒间隔 + 每 10 个长停顿
- ✅ 自动跳过「已沟通」岗位，URL 去重
- ✅ 发送数据实时同步到后端

### 状态采集
- ✅ 每天 19:50 弹窗提醒切换到消息页
- ✅ 自动解析对话状态（已读/未读/回复）
- ✅ 与发送记录匹配并更新

### 沉默跟进
- ✅ 每日 17:00 自动检查 3 天前的沉默岗位
- ✅ AI 生成跟进话术（区分未读/已读未回）
- ✅ 消耗每日配额，每岗最多跟进 1 次

### 数据分析报告
- ✅ 仪表盘点击「生成今日报告」
- ✅ 核心漏斗：发送→已读→回复→面试
- ✅ 匹配度分析：按区间统计
- ✅ 时段对比：上午 vs 下午
- ✅ 沉默跟进追踪
- ✅ AI 优化建议
- ✅ 待跟进事项清单
- ✅ 一键复制报告全文
- ✅ 历史记录查询（日期选择器）

## 🔧 数据存储

所有数据存储在 `~/JobReports/`：

```
~/JobReports/
├── settings.json        # 系统设置
├── 2026-07-28.json      # 每日发送记录
├── 2026-07-29.json
├── ...
└── server.log           # 后端日志
```

## 🧠 AI 模型支持

通过阿里云百炼 DashScope 兼容接口（OpenAI 格式），支持以下模型：

| 模型 ID | 名称 |
|---------|------|
| `kimi-k2.7` | Kimi K2.7（月之暗面） |
| `qwen3.7-max` | 通义千问 3.7 Max |
| `qwen3.5-max` | 通义千问 3.5 Max |
| `qwen-plus` | 通义千问 Plus |
| `deepseek-v3` | DeepSeek V3 |
| `deepseek-r1` | DeepSeek R1 |

也可以在设置中手动输入自定义模型 ID。

## ⚠️ 注意事项

1. **不要关闭浏览器标签页** — 脚本需要页面保持打开
2. **礼貌使用** — 每日上限 150 是 BOSS直聘的限制，建议遵守
3. **API Key 安全** — 密钥仅存在本地 `~/JobReports/settings.json`，不会上传
4. **页面改版** — BOSS直聘页面结构可能变化，如脚本无法识别元素，需更新选择器
5. **双页面协同模式** — 脚本已预留接口，目前暂未启用（见脚本注释）

## 🛠 故障排查

| 问题 | 解决方法 |
|------|----------|
| 仪表盘无法访问 | 确认 `python app.py` 已启动，访问 http://localhost:5000 |
| AI 调用失败 | 检查 API Key 是否配置正确，模型名称是否有效 |
| 脚本不工作 | 检查 Tampermonkey 脚本是否正确安装，是否在 BOSS直聘页面 |
| 找不到岗位卡片 | BOSS直聘可能改版了页面结构，需更新脚本中的选择器 |
| 数据不保存 | 确认 `~/JobReports/` 目录是否存在并有写入权限 |

## 📝 License

MIT — 仅供个人求职使用，请勿用于商业用途。
