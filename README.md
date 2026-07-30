# 🤖 求职自动化与数据分析系统

BOSS直聘全自动打招呼 + AI 匹配评估 + 数据分析仪表盘。

> **适用对象**：需要在 BOSS直聘上高效求职的个人用户。
> 整个系统在本地运行，你的 API Key 和个人数据不会上传到任何第三方。

## 📁 项目结构

```
job-automation-system/
├── app.py                          # Flask 后端（API + 报告生成 + AI 转发）
├── config.py                       # 全局配置与设置管理
├── requirements.txt                # Python 依赖
├── .env.example                    # 环境变量模板
├── README.md                       # 本文件
├── LICENSE                         # MIT 许可证
├── templates/
│   └── index.html                  # 仪表盘前端页面
├── static/
│   ├── style.css                   # 仪表盘样式
│   └── dashboard.js                # 仪表盘交互逻辑
└── tampermonkey/
    └── boss-automation.user.js     # Tampermonkey 浏览器自动化脚本
```

## 🚀 快速启动

### 前置条件

- **Python 3.10+**
- **Chrome / Edge 浏览器** + [Tampermonkey 扩展](https://www.tampermonkey.net/)
- **阿里云百炼 API Key**（[免费注册获取](https://dashscope.console.aliyun.com/apiKey)，新用户有免费额度）

### 1. 安装 Python 依赖

```bash
pip install -r requirements.txt
```

### 2. 配置环境变量（可选但推荐）

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env，设置你需要的配置（所有变量都有默认值，不设置也能运行）
```

可配置的环境变量见 [配置参考](#-配置参考)。

### 3. 启动 Flask 后端

```bash
python app.py
```

启动后访问：**http://localhost:5000**

### 4. 配置系统

打开浏览器访问 `http://localhost:5000`，在左侧「系统设置」中填写：

| 配置项 | 说明 | 必填 |
|--------|------|------|
| **API Key** | 阿里云百炼 DashScope API Key | ✅ |
| **候选人档案** | 姓名、学历、毕业年份 | ✅ |
| **量化亮点** | 个人项目经验、技能亮点 | ✅ |
| **招呼语模板** | 3 个版本的个性化招呼语 | ✅ |
| **简历文本** | 或上传 PDF 简历自动解析 | 推荐 |
| **期望岗位** | AI 匹配时的目标方向 | ✅ |
| **AI 模型** | 默认 `kimi-k2.7`，可按需切换 | - |

所有设置自动保存到 `~/JobReports/settings.json`，不会上传到任何服务器。

### 5. 安装 Tampermonkey 脚本

1. 浏览器安装 [Tampermonkey 扩展](https://www.tampermonkey.net/)
2. 打开 Tampermonkey 管理面板 → **新建脚本**
3. 复制 `tampermonkey/boss-automation.user.js` 的**全部内容**粘贴进去
4. **⚠️ 重要**：找到脚本顶部的 `CONFIG.API_BASE`，确认后端地址正确：
   ```javascript
   const CONFIG = {
       API_BASE: 'http://127.0.0.1:5000',  // 修改为你的后端地址
   ```
5. 保存（Ctrl+S）

### 6. 开始使用

1. 打开 [BOSS直聘搜索页](https://www.zhipin.com/web/geek/) 并搜索目标岗位
2. 页面右下角会出现 **JobBot 控制面板**
3. 点击 **「▶ 启动」**，脚本自动开始工作

## 📊 功能一览

### 🤖 自动打招呼
- 仅在 BOSS直聘搜索结果页生效
- 分时段发送：上午/下午各一个窗口，可自定义配额
- AI 语义匹配评估，匹配度 ≥ 阈值才发送（避免无效投递）
- 真人行为模拟：随机间隔 + 间歇长停顿
- 自动跳过「已沟通」岗位，URL 级别去重

### 📋 状态采集
- 每日定时弹窗提醒采集消息状态
- 自动解析对话状态（未读/已读/已回复/面试）
- 与发送记录自动匹配更新

### 🔔 沉默跟进
- 自动检测 N 天前发出但未回复的岗位
- AI 生成个性化跟进话术（区分未读/已读未回）
- 每岗仅跟进一次，不重复打扰

### 📈 数据分析报告
- 核心漏斗：发送 → 已读 → 回复 → 面试
- 匹配度区间分析
- 上午 vs 下午时段对比
- 沉默跟进追踪
- AI 生成的优化建议
- 一键复制报告全文

## 🔧 数据存储

所有数据本地存储，路径：`~/JobReports/`

```
~/JobReports/
├── settings.json        # 系统设置（API Key、候选人档案、策略等）
├── resumes/             # 上传的 PDF 简历
├── 2026-07-28.json      # 每日发送记录
├── ...
└── server.log           # 后端运行日志
```

## 🔒 安全说明

- **API Key**：仅存储在本地 `~/JobReports/settings.json`，不会上传到任何服务器
- **候选人数据**：简历、个人信息等全部本地存储
- **网络请求**：后端仅向阿里云百炼 API 发送 AI 评估请求；Tampermonkey 脚本向本地后端发请求
- **仪表盘保护**：可设置 `DASHBOARD_PASSWORD` 环境变量启用访问密码
- **生产部署**：如需暴露到公网，务必设置强密码并关闭 Debug 模式

## 🧠 AI 模型支持

通过阿里云百炼 DashScope 兼容接口（OpenAI 格式），支持以下模型：

| 模型 ID | 名称 | 特点 |
|---------|------|------|
| `kimi-k2.7` | Kimi K2.7 | 月之暗面，综合能力强 |
| `qwen3.7-max` | 通义千问 3.7 Max | 阿里自研，中文理解好 |
| `qwen3.5-max` | 通义千问 3.5 Max | 平衡速度与效果 |
| `qwen-plus` | 通义千问 Plus | 性价比高 |
| `deepseek-v3` | DeepSeek V3 | 开源模型，逻辑严谨 |
| `deepseek-r1` | DeepSeek R1 | 推理增强 |

也可在设置中手动输入任意兼容 OpenAI 格式的模型 ID。

## ⚙️ 配置参考

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `FLASK_HOST` | `127.0.0.1` | 监听地址（局域网分享可改为 `0.0.0.0`） |
| `FLASK_PORT` | `5000` | 监听端口 |
| `FLASK_DEBUG` | `false` | Debug 模式（**生产环境务必关闭**） |
| `FLASK_SECRET_KEY` | 随机生成 | Flask session 加密密钥 |
| `DASHBOARD_PASSWORD` | （空=不启用） | 仪表盘访问密码（Bearer token） |

### 仪表盘设置

所有可调参数（匹配度阈值、发送配额、时段、跟进策略等）都在仪表盘「系统设置」中可视化配置，无需手动编辑文件。

## 🛠 故障排查

| 问题 | 解决方法 |
|------|----------|
| 仪表盘无法访问 | 确认 `python app.py` 正常启动，检查端口是否被占用 |
| AI 调用失败 | 检查 API Key 是否已配置、是否过期、模型名称是否正确 |
| 脚本不工作 | 检查 Tampermonkey 是否启用、脚本 API_BASE 地址是否正确 |
| 扫描到岗位但不发送 | 查看控制面板日志，检查匹配度是否低于阈值 |
| 找不到岗位卡片 | BOSS直聘可能改版了页面结构，需更新脚本选择器 |
| 数据不保存 | 确认 `~/JobReports/` 目录有写入权限 |

## 📝 License

MIT — 详见 [LICENSE](LICENSE) 文件。
