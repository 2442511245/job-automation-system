// ==UserScript==
// @name         BOSS直聘 求职自动化助手
// @namespace    https://github.com/job-automation
// @version      1.1.0
// @description  自动打招呼、AI匹配评估、状态采集、沉默跟进 | 配合 Flask 后端使用
// @author       JobBot
// @match        https://www.zhipin.com/web/geek/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @run-at       document-end
// @connect      localhost
// @connect      127.0.0.1
// @noframes
// ==/UserScript==

/**
 * ============================================================
 *  BOSS直聘 求职自动化助手 - Tampermonkey 脚本
 * ============================================================
 *
 * 【功能模块】
 *   1. 分时段自动打招呼（搜索结果页）
 *   2. 半自动状态采集（消息页）
 *   3. 沉默跟进（每日 17:00）
 *   4. 控制面板 UI
 *
 * 【依赖】
 *   - Flask 后端运行在 http://localhost:5000
 *   - 阿里云百炼 DashScope API（通过后端转发）
 *
 * 【使用说明】
 *   1. 确保 Flask 后端已启动
 *   2. 在仪表盘（http://localhost:5000）配置 API Key、简历等
 *   3. 安装此脚本到 Tampermonkey
 *   4. 打开 BOSS直聘搜索结果页，脚本自动开始工作
 * ============================================================
 */

(function () {
    'use strict';

    // ============================================================
    //  配置项（可通过后端 API 动态获取，以下为默认值）
    // ============================================================
    const CONFIG = {
        // 后端地址
        API_BASE: 'http://127.0.0.1:5000',

        // 默认策略（会被后端设置覆盖）
        DAILY_LIMIT: 150,
        MORNING_QUOTA: 75,
        AFTERNOON_QUOTA: 75,
        MORNING_START: 9,
        MORNING_END: 11,
        AFTERNOON_START: 14,
        AFTERNOON_END: 16,
        MATCH_THRESHOLD: 70,
        FOLLOWUP_THRESHOLD: 60,
        QUIET_DAYS: 3,
        FOLLOWUP_CHECK_HOUR: 17,
        COLLECTION_REMINDER_TIME: '19:50',

        // 发送节奏（秒）
        MIN_INTERVAL: 20,
        MAX_INTERVAL: 60,
        LONG_PAUSE_MIN: 120,
        LONG_PAUSE_MAX: 300,
        LONG_PAUSE_EVERY: 10,

        // 最大连续失败次数
        MAX_CONSECUTIVE_FAILURES: 5,
    };

    // ============================================================
    //  运行时状态
    // ============================================================
    const STATE = {
        running: false,            // 是否正在运行
        currentPage: null,         // 'search' | 'chat' | 'other'
        todaySent: 0,             // 今日已发送计数
        morningSent: 0,
        afternoonSent: 0,
        processedUrls: new Set(), // 已处理的岗位 URL（本会话去重）
        consecutiveFailures: 0,
        version: '1.0.0',

        // 从后端同步的配置
        remoteConfig: null,
        configLoaded: false,

        // 当前处理的岗位（供面板按钮使用）
        currentJobUrl: null,
        currentGreeting: '',
    };

    // ============================================================
    //  工具函数
    // ============================================================

    /** 日志输出（带时间戳） */
    function log(msg, level = 'info') {
        const prefix = `[JobBot ${new Date().toLocaleTimeString()}]`;
        const fullMsg = `${prefix} ${msg}`;
        switch (level) {
            case 'error': console.error(fullMsg); break;
            case 'warn':  console.warn(fullMsg); break;
            default:      console.log(fullMsg); break;
        }
    }

    /** 随机延迟（毫秒） */
    function randomDelay(minSec, maxSec) {
        const ms = (Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec) * 1000;
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /** 检测当前所处页面类型 */
    function detectPageType() {
        const url = window.location.href;
        if (/zhipin\.com\/web\/geek\/chat/.test(url)) return 'chat';
        // 搜索结果页：/web/geek/job 或 /web/geek/jobs 或 /web/geek/?query=
        if (/zhipin\.com\/web\/geek\/job[s]?(\?|$)/.test(url)) return 'search';
        if (/zhipin\.com\/web\/geek\/\?/.test(url)) return 'search';
        if (/zhipin\.com\/web\/geek\/job\/\d+/.test(url)) return 'job-detail';
        // 兜底：页面含 job 相关关键词也视为搜索页
        if (/zhipin\.com\/web\/geek\//.test(url) && document.querySelector('a[href*="job_detail"]')) return 'search';
        return 'other';
    }

    /** 获取今日日期字符串 */
    function todayStr() {
        return new Date().toISOString().slice(0, 10);
    }

    /** 判断当前是否在发送时段内 */
    function isInTimeWindow() {
        const hour = new Date().getHours();
        const isMorning = hour >= CONFIG.MORNING_START && hour < CONFIG.MORNING_END;
        const isAfternoon = hour >= CONFIG.AFTERNOON_START && hour < CONFIG.AFTERNOON_END;
        return { isMorning, isAfternoon, inWindow: isMorning || isAfternoon };
    }

    /** 获取当前时段名称 */
    function getCurrentSection() {
        const hour = new Date().getHours();
        if (hour >= CONFIG.MORNING_START && hour < CONFIG.MORNING_END) return 'morning';
        if (hour >= CONFIG.AFTERNOON_START && hour < CONFIG.AFTERNOON_END) return 'afternoon';
        return null;
    }

    /** 当前时段剩余配额 */
    function getRemainingQuota() {
        const section = getCurrentSection();
        if (section === 'morning') return Math.max(0, CONFIG.MORNING_QUOTA - STATE.morningSent);
        if (section === 'afternoon') return Math.max(0, CONFIG.AFTERNOON_QUOTA - STATE.afternoonSent);
        return 0;
    }

    // ============================================================
    //  GM_xmlhttpRequest 封装
    // ============================================================

    /** 通用 GET 请求 */
    function apiGet(path) {
        return new Promise((resolve, reject) => {
            const url = CONFIG.API_BASE + path;
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                timeout: 15000,
                onload: (resp) => {
                    try {
                        resolve(JSON.parse(resp.responseText));
                    } catch (e) {
                        reject(new Error('JSON 解析失败: ' + resp.responseText.slice(0, 200)));
                    }
                },
                onerror: (e) => reject(new Error('网络请求失败')),
                ontimeout: () => reject(new Error('请求超时')),
            });
        });
    }

    /** 通用 POST 请求 */
    function apiPost(path, data) {
        return new Promise((resolve, reject) => {
            const url = CONFIG.API_BASE + path;
            // AI评估可能很慢（qwen3.7-max 需25秒+），超时设90秒
            const timeoutMs = path.includes('evaluate') ? 90000 : 30000;
            GM_xmlhttpRequest({
                method: 'POST',
                url: url,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify(data),
                timeout: timeoutMs,
                onload: (resp) => {
                    try {
                        resolve(JSON.parse(resp.responseText));
                    } catch (e) {
                        reject(new Error('JSON 解析失败'));
                    }
                },
                onerror: (e) => reject(new Error('网络请求失败')),
                ontimeout: () => reject(new Error('请求超时(' + (timeoutMs/1000) + '秒)')),
            });
        });
    }

    // ============================================================
    //  远程配置同步
    // ============================================================

    /** 从后端拉取最新配置 */
    async function syncRemoteConfig() {
        try {
            setDebugInfo('正在连接后端...');
            const data = await apiGet('/api/settings');
            if (data.success && data.settings) {
                STATE.remoteConfig = data.settings;
                const s = data.settings;
                if (s.daily_limit != null) CONFIG.DAILY_LIMIT = s.daily_limit;
                if (s.morning_quota != null) CONFIG.MORNING_QUOTA = s.morning_quota;
                if (s.afternoon_quota != null) CONFIG.AFTERNOON_QUOTA = s.afternoon_quota;
                if (s.morning_start != null) CONFIG.MORNING_START = s.morning_start;
                if (s.morning_end != null) CONFIG.MORNING_END = s.morning_end;
                if (s.afternoon_start != null) CONFIG.AFTERNOON_START = s.afternoon_start;
                if (s.afternoon_end != null) CONFIG.AFTERNOON_END = s.afternoon_end;
                if (s.match_threshold != null) CONFIG.MATCH_THRESHOLD = s.match_threshold;
                if (s.followup_match_threshold != null) CONFIG.FOLLOWUP_THRESHOLD = s.followup_match_threshold;
                if (s.silent_days != null) CONFIG.QUIET_DAYS = s.silent_days;

                STATE.configLoaded = true;
                log('远程配置已同步 | 模型: ' + (s.model_name || '?')
                    + ' | 阈值: ' + CONFIG.MATCH_THRESHOLD
                    + ' | 日上限: ' + CONFIG.DAILY_LIMIT);
                setDebugInfo(
                    '✅ 后端连接成功',
                    '模型: ' + (s.model_name || '?'),
                    '匹配阈值: ' + CONFIG.MATCH_THRESHOLD + '%',
                    '日上限: ' + CONFIG.DAILY_LIMIT,
                    'API Key: ' + (s.api_key_masked || (s.api_key ? '已配置' : '❌ 未配置'))
                );
                updatePanel();
            }
        } catch (e) {
            STATE.configLoaded = false;
            log('远程配置同步失败，使用本地默认值: ' + e.message, 'warn');
            setDebugInfo('❌ 无法连接后端: ' + e.message, '请确认 Flask 后端已启动在 http://127.0.0.1:5000');
            updatePanel();
        }
    }

    /** 获取今日已发送数量（从后端） */
    async function syncTodayCount() {
        try {
            const data = await apiGet('/api/today_stats');
            if (data.success) {
                STATE.todaySent = data.total_sent;
                STATE.morningSent = data.morning_sent;
                STATE.afternoonSent = data.afternoon_sent;
                appendDebug('今日已发送: ' + STATE.todaySent + ' 条');
            }
        } catch (e) {
            log('同步今日计数失败: ' + e.message, 'warn');
        }
    }

    // ============================================================
    //  AI 匹配评估（通过后端转发）
    // ============================================================

    /** 评估岗位匹配度 */
    async function evaluateMatch(jobTitle, companyName, jobDescription) {
        try {
            const data = await apiPost('/api/evaluate_match', {
                job_title: jobTitle,
                company_name: companyName,
                job_description: jobDescription || '',
            });
            if (data.success) {
                const score = data.score || 0;
                if (score > 0) {
                    lastEvalReason = data.reason || '';
                }
                return {
                    score: score,
                    reason: data.reason || '',
                    greeting: data.greeting || '',
                };
            }
            lastEvalError = 'API返回失败: ' + (data.message || 'unknown');
            log('AI 评估失败: ' + lastEvalError, 'warn');
            return null;
        } catch (e) {
            lastEvalError = '异常: ' + (e.message || e.toString());
            log('AI 评估请求异常: ' + e.message, 'error');
            return null;
        }
    }
    let lastEvalError = '';
    let lastEvalReason = '';

    /** 生成跟进消息 */
    async function generateFollowupMsg(jobTitle, companyName, originalGreeting, status) {
        try {
            const data = await apiPost('/api/generate_followup', {
                job_title: jobTitle,
                company_name: companyName,
                original_greeting: originalGreeting,
                status: status,
            });
            if (data.success && data.followup_message) {
                return data.followup_message;
            }
            return '';
        } catch (e) {
            log('跟进消息生成失败: ' + e.message, 'error');
            return '';
        }
    }

    // ============================================================
    //  模块一：自动打招呼（搜索结果页）
    // ============================================================

    /** 解析搜索结果页中的岗位列表 */
    function parseJobList() {
        const jobs = [];
        // 全局诊断收集器
        if (!parseJobList._diag) parseJobList._diag = { samples: [], totalBtns: 0, globalBtns: [] };
        parseJobList._diag.samples = [];
        parseJobList._diag.totalBtns = 0;
        parseJobList._diag.globalBtns = [];

        // ★ 全局扫描：找到页面上所有"沟通"按钮（用于诊断）
        const allClickables = document.querySelectorAll('button, a, span, div, [role="button"]');
        allClickables.forEach(el => {
            const text = (el.innerText || el.textContent || '').trim();
            if (text === '立即沟通' || text === '沟通' || text === '联系TA' || text === '立即联系' || text === '立即') {
                const parent = el.parentElement;
                parseJobList._diag.globalBtns.push({
                    tag: el.tagName,
                    text: text,
                    cls: (el.className || '').toString().substring(0, 80),
                    parentTag: parent ? parent.tagName : '',
                    parentCls: parent ? (parent.className || '').toString().substring(0, 80) : '',
                });
            }
        });

        // ★ 使用已验证的卡片选择器：LI.job-card-box
        const cards = document.querySelectorAll('li.job-card-box');
        log(`[parseJobList] 找到 ${cards.length} 个卡片 (li.job-card-box)，全局沟通按钮: ${parseJobList._diag.globalBtns.length}`);

        cards.forEach((card, cardIdx) => {
            try {
                // 提取岗位链接
                const linkEl = card.querySelector('a[href*="job_detail"]');
                if (!linkEl) return;

                const jobUrl = linkEl.href || linkEl.getAttribute('href');
                if (!jobUrl || !/job_detail/i.test(jobUrl)) return;

                // 岗位名称 (.job-name 已验证)
                const titleEl = card.querySelector('.job-name');
                const jobTitle = titleEl ? titleEl.innerText.trim() : (linkEl.innerText || '').trim();

                // 公司名称（已验证：在 boss-info 类中）
                const companyEl = card.querySelector('.boss-info')
                               || card.querySelector('[class*="boss-info"]')
                               || card.querySelector('.company-name')
                               || card.querySelector('[class*="company"]');
                const companyName = companyEl ? companyEl.innerText.trim() : '';

                // 岗位描述（标签等）
                const descEl = card.querySelector('.tag-list')
                            || card.querySelector('[class*="tag"]')
                            || card.querySelector('[class*="info"]');
                const jobDescription = descEl ? descEl.innerText.trim() : '';

                // 检查是否已沟通
                let isCommunicated = false;
                const allTextEls = card.querySelectorAll('span, div');
                for (const el of allTextEls) {
                    const t = (el.innerText || el.textContent || '').trim();
                    if (t === '已沟通' || t === '沟通中' || t === '继续沟通') { isCommunicated = true; break; }
                }

                // ★ 沟通按钮不在卡片内！它在右侧详情面板 .job-detail-op .op-btn-chat 中
                // 所以 hasChatBtn 设为 true（只要页面存在这个按钮类就说明有沟通功能）
                // 实际点击时需要先在页面上找到它
                const hasChatBtn = true;  // BOSS直聘搜索页始终有沟通按钮（在详情面板中）

                // 诊断（前3个）
                if (cardIdx < 3) {
                    const cardClickables = [];
                    card.querySelectorAll('a').forEach(a => {
                        const t = (a.innerText || '').trim();
                        if (t && t.length < 30) cardClickables.push({ tag: a.tagName, text: t, cls: (a.className||'').toString().substring(0,40) });
                    });
                    parseJobList._diag.samples.push({
                        title: jobTitle.substring(0, 30),
                        company: companyName.substring(0, 20),
                        cardTag: card.tagName,
                        cardCls: (card.className || '').toString().substring(0, 60),
                        hasChatBtn: true,
                        isCommunicated,
                        clickables: cardClickables,
                    });
                }
                parseJobList._diag.totalBtns++;

                jobs.push({
                    jobUrl,
                    jobTitle,
                    companyName,
                    jobDescription,
                    isCommunicated,
                    hasChatBtn: true,  // 按钮在详情面板，始终为true
                    cardElement: card,
                    chatBtnElement: null,  // 运行时从详情面板获取
                });
            } catch (e) {
                // 跳过解析失败
            }
        });

        window.__JOBOT_DIAG__ = parseJobList._diag;
        return jobs;
    }

    /** 获取 DOM 诊断信息（供面板显示） */
    function getDomDiagString() {
        const diag = window.__JOBOT_DIAG__;
        if (!diag) return '暂无诊断数据';

        const lines = [];

        // 全局按钮扫描结果
        if (diag.globalBtns && diag.globalBtns.length > 0) {
            lines.push('=== 全局"沟通"按钮 (' + diag.globalBtns.length + '个) ===');
            diag.globalBtns.slice(0, 10).forEach((b, i) => {
                lines.push(`#${i+1} <${b.tag}>${b.text} class="${b.cls}" parent:<${b.parentTag} class="${b.parentCls}">`);
            });
            if (diag.globalBtns.length > 10) lines.push('... 还有 ' + (diag.globalBtns.length - 10) + ' 个');
            lines.push('');
        }

        // 卡片诊断
        if (diag.samples && diag.samples.length > 0) {
            lines.push('=== 前3个卡片 ===');
            diag.samples.forEach((s, i) => {
                const btns = s.clickables.map(b => `[${b.tag}]${b.text}(${b.cls})`).join('; ') || '无';
                lines.push(`#${i+1} ${s.title}|${s.company}`);
                lines.push(`  card:<${s.cardTag} class="${s.cardCls}">`);
                lines.push(`  沟通btn:${s.hasChatBtn?'✅':'❌'} 已沟通:${s.isCommunicated?'Y':'N'}`);
                lines.push(`  可点击: [${btns}]`);
            });
        }
        lines.push('总计 job_detail: ' + diag.totalBtns);
        return lines.join('\n');
    }

    /** 通过 jobUrl 查找对应的岗位数据（用于重新扫描页面时匹配） */
    function findJobByUrl(jobUrl) {
        const allJobs = parseJobList();
        return allJobs.find(j => j.jobUrl === jobUrl) || null;
    }

    /** 在详情面板中找到沟通按钮 */
    function findChatButtonInDetail() {
        // 已验证：按钮是 A.op-btn.op-btn-chat 在 DIV.job-detail-op 中
        return document.querySelector('.op-btn-chat')
            || document.querySelector('.op-btn.op-btn-chat')
            || document.querySelector('.job-detail-op .op-btn-chat')
            || document.querySelector('.job-detail-op a[class*="chat"]');
    }

    /** 点击打招呼按钮 */
    function clickChatButton(chatBtnEl) {
        if (!chatBtnEl) return false;
        try {
            chatBtnEl.click();
            return true;
        } catch (e) {
            return false;
        }
    }

    /** 注入脚本到页面主上下文（绕过沙箱，可访问Vue实例） */
    function injectPageScript(code) {
        const script = document.createElement('script');
        script.textContent = '(' + code.toString() + ')();';
        document.documentElement.appendChild(script);
        script.remove();
    }

    /** 模拟键盘事件 */
    function simKey(el, key, opts = {}) {
        const defaults = { key, code: key, keyCode: key.charCodeAt(0), which: key.charCodeAt(0), bubbles: true, cancelable: true };
        ['keydown', 'keypress', 'keyup'].forEach(type => {
            el.dispatchEvent(new KeyboardEvent(type, { ...defaults, ...opts, ...(type === 'keypress' ? {} : {}) }));
        });
    }

    /** 在聊天弹窗中填入招呼语并发送（剪贴板方案） */
    async function sendGreetingInDialog(greeting) {
        appendDebug('⏳ 等对话框...');

        // 等对话框出现
        await new Promise(r => setTimeout(r, 2000));

        // 查找可见的 textarea
        let inputEl = null;
        for (let i = 0; i < 15; i++) {
            const tas = document.querySelectorAll('textarea');
            for (const ta of tas) {
                if (ta.offsetParent !== null) { inputEl = ta; break; }
            }
            if (!inputEl) {
                const eds = document.querySelectorAll('[contenteditable="true"]');
                for (const el of eds) {
                    if (el.offsetParent !== null) { inputEl = el; break; }
                }
            }
            if (inputEl) break;
            await new Promise(r => setTimeout(r, 500));
        }

        if (!inputEl) {
            appendDebug('⚠ 无输入框，直接发送');
            // 尝试找发送按钮直接点
            const btns = document.querySelectorAll('button');
            for (const b of btns) {
                if ((b.innerText||'').includes('发送')) { b.click(); return true; }
            }
            return true;
        }

        appendDebug('📋 剪贴板写入...');

        // ★ 核心：用 GM_setClipboard 写剪贴板，然后 Ctrl+A Ctrl+V 粘贴
        try {
            GM_setClipboard(greeting, 'text');
        } catch(e) {
            // 降级：传统方式
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (nativeSetter) { nativeSetter.call(inputEl, greeting); }
            else { inputEl.value = greeting; }
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: greeting }));
        }

        await new Promise(r => setTimeout(r, 300));

        // 聚焦并全选
        inputEl.focus();
        inputEl.click();
        await new Promise(r => setTimeout(r, 200));

        // Ctrl+A 全选默认文本
        inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, metaKey: true, bubbles: true }));
        await new Promise(r => setTimeout(r, 100));

        // Ctrl+V 粘贴我们的招呼语
        inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, metaKey: true, bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
        inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'v', code: 'KeyV', ctrlKey: true, metaKey: true, bubbles: true }));

        // 等粘贴生效
        await new Promise(r => setTimeout(r, 500));

        // 验证
        const val = inputEl.value || inputEl.textContent || inputEl.innerText || '';
        if (val.includes(greeting.substring(0, 15))) {
            appendDebug('✅ 招呼已填入');
        } else {
            appendDebug('⚠ 填入可能失败，继续发送...');
            // 最后兜底：直接设置 value 再试
            try {
                const ns = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                if (ns) ns.call(inputEl, greeting);
                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                inputEl.dispatchEvent(new Event('change', { bubbles: true }));
            } catch(e) {}
        }

        await new Promise(r => setTimeout(r, 200));

        // 找发送按钮
        let sendBtn = document.querySelector('.btn-send')
            || document.querySelector('button[class*="send"]')
            || document.querySelector('.send-btn');
        if (!sendBtn) {
            const allBtns = document.querySelectorAll('button');
            for (const b of allBtns) {
                if ((b.innerText||'').trim() === '发送' && b.offsetParent) { sendBtn = b; break; }
            }
        }

        if (sendBtn) {
            appendDebug('📤 发送');
            sendBtn.click();
        } else {
            appendDebug('📤 Enter');
            inputEl.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                bubbles: true, cancelable: true,
            }));
        }

        return true;
    }

    /** 关闭聊天弹窗 */
    function closeChatDialog() {
        const closeSelectors = [
            '.dialog-close',
            '.chat-dialog .close',
            '[class*="close"]',
            '.boss-dialog .icon-close',
        ];
        for (const sel of closeSelectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) {
                el.click();
                return true;
            }
        }
        return false;
    }

    /** 记录一次成功发送到后端 */
    async function recordSend(jobUrl, jobTitle, companyName, score, greeting) {
        try {
            const section = getCurrentSection() || 'unknown';
            const data = await apiPost('/api/log_send', {
                job_url: jobUrl,
                job_title: jobTitle,
                company_name: companyName,
                send_time: new Date().toLocaleString('zh-CN'),
                match_score: score,
                greeting: greeting,
                status: 'unread',
                section: section,
            });
            if (data.success) {
                STATE.todaySent = data.today_count || (STATE.todaySent + 1);
                if (section === 'morning') STATE.morningSent++;
                else if (section === 'afternoon') STATE.afternoonSent++;
                STATE.processedUrls.add(jobUrl);
                log(`✅ 发送成功: ${companyName} - ${jobTitle} (${score}分) | 今日: ${STATE.todaySent}/${CONFIG.DAILY_LIMIT}`);
                updatePanel();
                return true;
            } else {
                log('后端记录失败: ' + (data.message || 'unknown'), 'warn');
                return false;
            }
        } catch (e) {
            log('记录发送异常: ' + e.message, 'error');
            return false;
        }
    }

    /** 从右侧详情面板提取 JD 文本 */
    function extractJobDetail() {
        const parts = [];
        // BOSS直聘详情面板常见选择器
        const sel = document.querySelector('.job-sec-text')
            || document.querySelector('.job-detail-section')
            || document.querySelector('.detail-content')
            || document.querySelector('[class*="job-detail"]')
            || document.querySelector('[class*="job-sec"]');
        if (sel) parts.push(sel.innerText);

        // 也尝试从 job-detail-op 附近提取
        const detailOp = document.querySelector('.job-detail-op');
        if (detailOp && detailOp.parentElement) {
            const allText = detailOp.parentElement.innerText || '';
            if (allText.length > 50) parts.push(allText);
        }

        return parts.join('\n').substring(0, 1500);
    }

    /** 在面板显示招呼语预览 */
    function showGreetingPreview(score, greeting, jobUrl) {
        const box = document.getElementById('jp-greeting-box');
        const scoreEl = document.getElementById('jp-match-score');
        const textEl = document.getElementById('jp-greeting-text');
        if (box) box.style.display = 'block';
        if (scoreEl) { scoreEl.textContent = score + '%'; scoreEl.className = 'panel-value ' + (score >= 80 ? 'good' : 'warn'); }
        if (textEl) textEl.value = greeting;
        STATE.currentJobUrl = jobUrl;
        STATE.currentGreeting = greeting;
    }

    /** 处理单个岗位：提取JD → AI评估 → 存储招呼语 → 点击沟通跳转消息页 */
    async function processSingleJob(job) {
        log(`处理: ${job.companyName} - ${job.jobTitle}`);

        if (getRemainingQuota() <= 0) return 'quota_exhausted';

        // ★ 步骤1：点击卡片，激活右侧详情面板
        const cardLink = job.cardElement.querySelector('a[href*="job_detail"]') || job.cardElement;
        cardLink.click();
        await new Promise(r => setTimeout(r, 1500));

        // 等待详情面板
        let chatBtn = null;
        for (let i = 0; i < 10; i++) {
            chatBtn = findChatButtonInDetail();
            if (chatBtn) break;
            await new Promise(r => setTimeout(r, 500));
        }

        // ★ 步骤2：提取 JD
        const jdText = extractJobDetail();
        appendDebug('📄 ' + (job.companyName||job.jobTitle).substring(0,12) + ' JD:' + (jdText ? jdText.length + '字' : '无'));

        // ★ 步骤3：AI 评估
        const evalJobDesc = jdText || job.jobDescription || '';
        const result = await evaluateMatch(job.jobTitle, job.companyName, evalJobDesc);
        if (!result) {
            STATE.consecutiveFailures++;
            STATE.processedUrls.add(job.jobUrl);  // 标记已处理，避免重复
            appendDebug('❌ AI失败 #' + STATE.consecutiveFailures);
            return 'eval_failed';
        }
        STATE.consecutiveFailures = 0;

        const { score, reason, greeting } = result;
        appendDebug('🔍 ' + (job.companyName||job.jobTitle).substring(0,12) + ' ' + score + '% ' + (score >= CONFIG.MATCH_THRESHOLD ? '✅' : '⏭'));

        if (score < CONFIG.MATCH_THRESHOLD) {
            STATE.processedUrls.add(job.jobUrl);  // 标记已处理
            return 'below_threshold';
        }
        if (!greeting) {
            STATE.processedUrls.add(job.jobUrl);  // 标记已处理
            return 'no_greeting';
        }

        // ★ 步骤4：存招呼语到 GM_setValue（消息页会读取）
        GM_setValue('pending_greeting', JSON.stringify({
            greeting: greeting,
            jobUrl: job.jobUrl,
            jobTitle: job.jobTitle,
            companyName: job.companyName,
            score: score,
            timestamp: Date.now(),
        }));
        log('招呼语已存储，准备跳转消息页...');

        // 面板预览
        showGreetingPreview(score, greeting, job.jobUrl);

        // ★ 步骤5：优先用API直接发送（不跳页面），失败再跳消息页
        appendDebug('📡 尝试API发送...');

        const apiResult = await sendGreetingViaAPI(job.jobUrl, job.jobTitle, job.companyName, greeting);

        if (apiResult) {
            // ★ API发送成功！记录，继续下一个（全程不离开搜索页）
            await recordSend(job.jobUrl, job.jobTitle, job.companyName, score, greeting);
            appendDebug('✅ API发送成功！');
            STATE.processedUrls.add(job.jobUrl);
            return 'api_success';
        }

        appendDebug('⚠ API不可用，跳消息页...');

        // 回退：点击"立即沟通"跳消息页
        if (chatBtn) {
            chatBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await new Promise(r => setTimeout(r, 300));
            chatBtn.click();

            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 1000));
                if (window.location.href.includes('/web/geek/chat')) {
                    updatePanel();
                    return 'redirected_to_chat';
                }
            }
        }

        appendDebug('⚠ 跳转失败');
        STATE.processedUrls.add(job.jobUrl);
        return 'manual_required';
    }

    /** 自动打招呼主循环 */
    async function autoGreetingLoop() {
        log('========== 自动打招呼循环启动 ==========');

        let sendCountThisSession = 0;

        while (STATE.running) {
            // ★ 如果不是搜索页（可能在消息页），等待
            const pageType = detectPageType();
            if (pageType !== 'search') {
                updatePanel();
                await new Promise(resolve => setTimeout(resolve, 2000));
                continue;
            }

            // 检查时间窗口
            const timeInfo = isInTimeWindow();
            if (!timeInfo.inWindow) {
                log('不在发送时段，暂停...');
                updatePanel();
                await new Promise(resolve => setTimeout(resolve, 60000)); // 每分钟检查一次
                continue;
            }

            // 检查配额
            const quota = getRemainingQuota();
            if (quota <= 0) {
                log(`${getCurrentSection() === 'morning' ? '上午' : '下午'}配额已用完`);
                updatePanel();
                // 等待到下一时段
                await new Promise(resolve => setTimeout(resolve, 120000));
                continue;
            }

            // 检查日总上限
            if (STATE.todaySent >= CONFIG.DAILY_LIMIT) {
                log('今日总配额已用完，等待明天');
                updatePanel();
                await new Promise(resolve => setTimeout(resolve, 300000));
                continue;
            }

            // 检查连续失败
            if (STATE.consecutiveFailures >= CONFIG.MAX_CONSECUTIVE_FAILURES) {
                log(`连续 ${STATE.consecutiveFailures} 次失败，暂停 5 分钟`, 'warn');
                await new Promise(resolve => setTimeout(resolve, 300000));
                STATE.consecutiveFailures = 0;
                continue;
            }

            // 同步今日计数
            await syncTodayCount();

            // 解析页面岗位
            const jobs = parseJobList();
            log(`扫描到 ${jobs.length} 个岗位`);

            // 分析过滤原因
            let filterStats = { communicated: 0, noChatBtn: 0, alreadyProcessed: 0, candidate: 0 };
            const candidates = jobs.filter(j => {
                if (j.isCommunicated) { filterStats.communicated++; return false; }
                if (STATE.processedUrls.has(j.jobUrl)) { filterStats.alreadyProcessed++; return false; }
                if (!j.hasChatBtn) { filterStats.noChatBtn++; return false; }
                filterStats.candidate++;
                return true;
            });

            log(`候选岗位: ${candidates.length} 个 | 剩余配额: ${quota}`);

            // 显示过滤详情 + DOM诊断
            const diagStr = getDomDiagString();
            const diagShort = diagStr.split('\n').slice(0, 5).join('\n');
            setDebugInfo(
                '📋 扫描: ' + jobs.length + ' | 无按钮: ' + filterStats.noChatBtn + ' | 候选: ' + filterStats.candidate,
                '🔇 已沟通: ' + filterStats.communicated + ' | 已处理: ' + filterStats.alreadyProcessed,
                '配额: ' + quota + ' | 已发: ' + STATE.todaySent + '/' + CONFIG.DAILY_LIMIT,
                '--- DOM结构(前3个) ---',
                diagShort
            );

            if (candidates.length === 0) {
                log('当前页面无可用岗位，3秒后尝试翻页或刷新...');
                updatePanel();
                // 尝试点击下一页
                const nextBtn = document.querySelector('.page .next')
                             || document.querySelector('[class*="pagination"] .next')
                             || document.querySelector('.options-pages .next');
                if (nextBtn && !nextBtn.classList.contains('disabled')) {
                    nextBtn.click();
                    await new Promise(resolve => setTimeout(resolve, 3000));
                } else {
                    // 没有下一页，滚动到底部再回顶部（模拟浏览行为）
                    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
                continue;
            }

            // 取第一个候选人处理
            const job = candidates[0];
            const result = await processSingleJob(job);

            if (result === 'quota_exhausted') break;

            // 发送节奏：随机间隔
            sendCountThisSession++;
            if (sendCountThisSession > 0 && sendCountThisSession % CONFIG.LONG_PAUSE_EVERY === 0) {
                const pauseSec = Math.floor(Math.random() * (CONFIG.LONG_PAUSE_MAX - CONFIG.LONG_PAUSE_MIN + 1)) + CONFIG.LONG_PAUSE_MIN;
                log(`长停顿 ${pauseSec} 秒（模拟离开）...`);
                updatePanel();
                await new Promise(resolve => setTimeout(resolve, pauseSec * 1000));
            } else {
                const intervalSec = Math.floor(Math.random() * (CONFIG.MAX_INTERVAL - CONFIG.MIN_INTERVAL + 1)) + CONFIG.MIN_INTERVAL;
                log(`等待 ${intervalSec} 秒...`);
                updatePanel();
                await new Promise(resolve => setTimeout(resolve, intervalSec * 1000));
            }
        }

        log('========== 自动打招呼循环结束 ==========');
    }

    // ============================================================
    //  模块二A：截获BOSS直聘发送消息的API
    // ============================================================

    let capturedGreetingAPI = null; // {url, method, headers, bodyTemplate, jobIdField}

    /** Monkey-patch fetch/XHR 来截获发送招呼的API调用 */
    function installAPICapture() {
        // 只安装一次
        if (installAPICapture._installed) return;
        installAPICapture._installed = true;

        // Hook fetch
        const origFetch = window.fetch;
        window.fetch = function(url, options) {
            const urlStr = typeof url === 'string' ? url : (url.url || '');
            const body = options && options.body;

            if (typeof body === 'string' && body.length < 2000) {
                try {
                    const json = JSON.parse(body);
                    // 检测打招呼API：包含招呼文本字段
                    if (json.greeting || json.content || json.message || json.text) {
                        const greetingField = json.greeting ? 'greeting' :
                                             json.content ? 'content' :
                                             json.message ? 'message' : 'text';
                        log('[API截获] 打招呼API: ' + urlStr.substring(0, 80));
                        log('[API截获] 字段: ' + greetingField + ', 示例: ' + json[greetingField].substring(0, 50));

                        capturedGreetingAPI = {
                            url: urlStr,
                            method: (options && options.method) || 'POST',
                            headers: options && options.headers ? {...options.headers} : {},
                            greetingField: greetingField,
                            bodyTemplate: {...json},
                            captured: true,
                        };

                        // 存到 GM_setValue 持久化
                        GM_setValue('captured_api', JSON.stringify({
                            url: urlStr,
                            method: capturedGreetingAPI.method,
                            greetingField: greetingField,
                            sampleBody: json,
                        }));
                    }
                } catch(e) {}
            }

            return origFetch.apply(this, arguments);
        };

        // Hook XMLHttpRequest
        const OrigXHR = window.XMLHttpRequest;
        window.XMLHttpRequest = function() {
            const xhr = new OrigXHR();
            const origSend = xhr.send;
            const origOpen = xhr.open;
            let reqMethod, reqUrl;

            xhr.open = function(method, url) {
                reqMethod = method;
                reqUrl = typeof url === 'string' ? url : (url.toString ? url.toString() : '');
                return origOpen.apply(this, arguments);
            };

            xhr.send = function(body) {
                if (typeof body === 'string' && body.length < 2000 && reqUrl) {
                    try {
                        const json = JSON.parse(body);
                        if (json.greeting || json.content || json.message || json.text) {
                            const greetingField = json.greeting ? 'greeting' :
                                                 json.content ? 'content' :
                                                 json.message ? 'message' : 'text';
                            log('[XHR截获] 打招呼API: ' + reqUrl.substring(0, 80));
                            capturedGreetingAPI = {
                                url: reqUrl,
                                method: reqMethod || 'POST',
                                headers: {},
                                greetingField: greetingField,
                                bodyTemplate: {...json},
                                captured: true,
                            };
                            GM_setValue('captured_api', JSON.stringify({
                                url: reqUrl,
                                method: capturedGreetingAPI.method,
                                greetingField: greetingField,
                                sampleBody: json,
                            }));
                        }
                    } catch(e) {}
                }
                return origSend.apply(this, arguments);
            };
            return xhr;
        };
        window.XMLHttpRequest.prototype = OrigXHR.prototype;

        // 尝试读取之前捕获的API
        try {
            const saved = GM_getValue('captured_api', '');
            if (saved) {
                const api = JSON.parse(saved);
                capturedGreetingAPI = {
                    ...api,
                    bodyTemplate: api.sampleBody || {},
                    captured: true,
                };
                log('[API] 从缓存加载打招呼API: ' + api.url.substring(0, 80));
            }
        } catch(e) {}

        log('[API截获] 已安装fetch/XHR钩子');
    }

    /** 使用截获的API直接发送招呼语（不经过聊天页面UI） */
    async function sendGreetingViaAPI(jobUrl, jobTitle, companyName, greeting) {
        if (!capturedGreetingAPI || !capturedGreetingAPI.captured) {
            return false;
        }

        const api = capturedGreetingAPI;
        log('[API发送] 使用 ' + api.method + ' ' + api.url.substring(0, 80));

        try {
            // 复制 body 模板，替换招呼语
            const body = JSON.parse(JSON.stringify(api.bodyTemplate));
            body[api.greetingField] = greeting;

            const resp = await fetch(api.url, {
                method: api.method,
                headers: {
                    'Content-Type': 'application/json',
                    ...api.headers,
                },
                body: JSON.stringify(body),
                credentials: 'include',
            });

            if (resp.ok) {
                log('[API发送] 成功！状态码: ' + resp.status);
                return true;
            } else {
                log('[API发送] 失败: ' + resp.status + ' ' + (await resp.text()).substring(0, 100));
                return false;
            }
        } catch(e) {
            log('[API发送] 异常: ' + e.message);
            return false;
        }
    }

    // ============================================================
    //  模块二：消息页自动发送招呼语
    // ============================================================

    /** 在消息页读取存储的招呼语，填入并发送，然后返回搜索页 */
    async function handleChatPage() {
        log('========== 消息页：注入式自动发送 ==========');

        let pendingData = null;
        try {
            const raw = GM_getValue('pending_greeting', '');
            if (raw) pendingData = JSON.parse(raw);
        } catch(e) {}

        if (!pendingData || !pendingData.greeting) {
            setDebugInfo('无待发送招呼语');
            return false;
        }
        if (Date.now() - pendingData.timestamp > 300000) {
            GM_setValue('pending_greeting', '');
            return false;
        }

        const { greeting, jobUrl, jobTitle, companyName, score } = pendingData;
        GM_setValue('pending_greeting', '');
        GM_setValue('auto_resume', '1');

        setDebugInfo('💬 注入模式', '岗位: ' + (companyName||jobTitle).substring(0,15), '等待渲染+操作...');

        await new Promise(r => setTimeout(r, 4000));
        try { GM_setClipboard(greeting, 'text'); } catch(e) {}

        // 注入脚本到页面主上下文，直接操作DOM和Vue/React组件
        const injected = await new Promise(resolve => {
            const msgId = 'jobbot_resp_' + Date.now();
            const handler = e => { window.removeEventListener(msgId, handler); resolve(e.detail); };
            window.addEventListener(msgId, handler);
            // 超时保护
            setTimeout(() => resolve({ found: false, filled: false, sent: false, timedOut: true }), 10000);

            const code = `(function(){
                var greet = ${JSON.stringify(greeting)};
                var evtName = '${msgId}';
                var result = { found: false, filled: false, sent: false };

                // 点击页面底部激活聊天区
                try {
                    var el = document.elementFromPoint(window.innerWidth/2, window.innerHeight-100);
                    if(el){el.click();el.focus();}
                }catch(e){}

                setTimeout(function(){
                    // 找所有可能的输入，过滤搜索栏
                    var inputs = [];
                    document.querySelectorAll('textarea,[contenteditable=true],div[contenteditable],input[type=text]').forEach(function(e){
                        if(!e.offsetParent) return;
                        var ph = (e.placeholder||'').toLowerCase();
                        var cls = (e.className||'').toString().toLowerCase();
                        var aria = (e.getAttribute('aria-label')||'').toLowerCase();
                        // 过滤搜索框
                        if(ph.includes('搜索')||ph.includes('search')||cls.includes('search')||aria.includes('search')) return;
                        // 优先选底部位置的（聊天框在底部）
                        var rect = e.getBoundingClientRect();
                        if(rect.top > window.innerHeight * 0.4) {
                            inputs.unshift(e);  // 底部元素优先
                        } else {
                            inputs.push(e);
                        }
                    });

                    if(inputs.length>0){
                        var inp = inputs[0];
                        result.found = true;
                        result.tag = inp.tagName;
                        inp.focus(); inp.click();

                        // Vue/React setter
                        try {
                            var d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value');
                            if(d&&d.set) d.set.call(inp,greet);
                            else inp.value = greet;
                            inp.dispatchEvent(new Event('input',{bubbles:true}));
                            inp.dispatchEvent(new Event('change',{bubbles:true}));
                            inp.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:greet}));
                        }catch(e){}

                        setTimeout(function(){
                            var v = inp.value||inp.textContent||'';
                            if(v.indexOf(greet.substring(0,10))>=0){
                                result.filled = true;
                                var sb = document.querySelector('.btn-send,button[class*=send],.send-btn');
                                if(!sb){document.querySelectorAll('button').forEach(function(b){if(!sb&&(b.innerText||'').trim()==='发送'&&b.offsetParent)sb=b;});}
                                if(sb){sb.click();result.sent=true;}
                                else{inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));result.sent=true;}
                            }
                            window.dispatchEvent(new CustomEvent(evtName,{detail:result}));
                        },600);
                    } else {
                        window.dispatchEvent(new CustomEvent(evtName,{detail:result}));
                    }
                },800);
            })();`;
            const s = document.createElement('script');
            s.textContent = code;
            document.documentElement.appendChild(s);
            s.remove();
        });

        setDebugInfo(
            '注入结果: ' + (injected.found ? '找到('+injected.tag+')' : '未找到'),
            '填入: ' + (injected.filled ? '✅' : '❌'),
            '发送: ' + (injected.sent ? '✅' : '❌')
        );

        if (injected.sent) {
            await new Promise(r => setTimeout(r, 2000));
            try { await recordSend(jobUrl, jobTitle, companyName, score, greeting); } catch(e) {}
            setDebugInfo('✅ 自动发送成功！', '返回搜索页...');
            await new Promise(r => setTimeout(r, 2000));
            window.history.back();
            setTimeout(() => {
                if (!window.location.href.includes('geek/job')) {
                    window.location.href = 'https://www.zhipin.com/web/geek/jobs?city=101280600&position=110110&query=AI%E4%BA%A7%E5%93%81';
                }
            }, 2000);
            return true;
        }

        // 回退手动
        setDebugInfo('🔄 尝试execCommand方案...');
        // 最后尝试：execCommand 直接在页面光标处插入文本
        try {
            // 点击聊天区
            const cx = window.innerWidth / 2;
            const cy = window.innerHeight - 120;
            const tgt = document.elementFromPoint(cx, cy);
            if (tgt) { tgt.click(); tgt.focus(); }
            await new Promise(r => setTimeout(r, 1000));

            // execCommand 尝试
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, greeting);
            await new Promise(r => setTimeout(r, 500));

            // 检查有没有成功
            const activeEl = document.activeElement;
            const val = (activeEl && (activeEl.value || activeEl.textContent || activeEl.innerText)) || '';
            if (val.includes(greeting.substring(0, 10))) {
                setDebugInfo('✅ execCommand成功！', '发送中...');
                activeEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                await new Promise(r => setTimeout(r, 2000));
                try { await recordSend(jobUrl, jobTitle, companyName, score, greeting); } catch(e) {}
                setDebugInfo('✅ 发送完成！', '返回...');
                await new Promise(r => setTimeout(r, 2000));
                window.history.back();
                setTimeout(() => {
                    if (!window.location.href.includes('geek/job')) {
                        window.location.href = 'https://www.zhipin.com/web/geek/jobs?city=101280600&position=110110&query=AI%E4%BA%A7%E5%93%81';
                    }
                }, 2000);
                return true;
            }
        } catch(e) {}

        // 全失败，回退手动
        setDebugInfo('📋 自动发送失败', '请 Ctrl+V 粘贴→发送', '发送后自动检测返回');
        const initialCount = document.querySelectorAll('[class*="message"],[class*="msg"],[class*="bubble"]').length;
        for (let i = 1; i <= 60; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const c = document.querySelectorAll('[class*="message"],[class*="msg"],[class*="bubble"]').length;
            if (c > initialCount + 1) {
                setDebugInfo('✅ 检测到发送！', '返回...');
                try { await recordSend(jobUrl, jobTitle, companyName, score, greeting); } catch(e) {}
                await new Promise(r => setTimeout(r, 2000));
                window.history.back();
                return true;
            }
            if (i % 10 === 0) setDebugInfo('⏳ 等待...(' + i + '秒)');
        }
        return false;
    }

    // ============================================================
    //  模块三：状态采集（消息页）
    // ============================================================

    /** 解析消息页中的对话列表，提取每条对话的状态 */
    function parseChatList() {
        const chats = [];

        // 消息列表选择器（可能随页面改版调整）
        const selectors = [
            '.chat-list .chat-item',
            '.user-list .user-item',
            '[class*="chat-item"]',
            '.conversation-item',
        ];

        let items = [];
        for (const sel of selectors) {
            items = document.querySelectorAll(sel);
            if (items.length > 0) break;
        }

        items.forEach(item => {
            try {
                // 公司名 / 岗位名
                const nameEl = item.querySelector('.name')
                            || item.querySelector('[class*="title"]')
                            || item.querySelector('h3');
                const nameText = nameEl ? nameEl.innerText.trim() : '';

                // 最后一条消息
                const msgEl = item.querySelector('.msg-text')
                           || item.querySelector('[class*="last-msg"]')
                           || item.querySelector('.last-message');
                const msgText = msgEl ? msgEl.innerText.trim() : '';

                // 判断状态
                let status = 'unread';
                // 有"未读"标记
                const unreadEl = item.querySelector('.unread-count')
                              || item.querySelector('[class*="unread"]')
                              || item.querySelector('.badge');
                if (unreadEl && unreadEl.innerText.trim()) {
                    status = 'unread';
                } else if (msgText && msgText.length > 0) {
                    // 检查是否有对方的回复（通常非绿色气泡或非"已发送"标签）
                    const sentTag = item.querySelector('[class*="send-status"]')
                                 || item.querySelector('.status-sent');
                    if (!sentTag && msgText.length > 3) {
                        status = 'replied';
                    } else {
                        status = 'read';
                    }
                }

                // 提取链接
                const linkEl = item.querySelector('a[href*="job_detail"]');
                const jobUrl = linkEl ? linkEl.href : '';

                chats.push({
                    name: nameText,
                    status: status,
                    jobUrl: jobUrl,
                    lastMessage: msgText,
                });
            } catch (e) {
                // 跳过解析失败的
            }
        });

        return chats;
    }

    /** 将采集的状态发送到后端 */
    async function sendStatusToBackend(updates) {
        try {
            const data = await apiPost('/api/update_status', {
                updates: updates,
            });
            if (data.success) {
                log(`✅ 状态更新成功: ${data.count} 条`);
                return data.count;
            }
            log('状态更新失败: ' + (data.message || ''), 'warn');
            return 0;
        } catch (e) {
            log('状态更新异常: ' + e.message, 'error');
            return 0;
        }
    }

    /** 执行状态采集 */
    async function collectStatuses() {
        log('开始采集对话状态...');
        const chats = parseChatList();

        if (chats.length === 0) {
            log('未检测到对话列表，请确认在消息页面', 'warn');
            showPanelNotification('⚠️ 未检测到对话，请确认在 BOSS直聘消息页');
            return;
        }

        log(`检测到 ${chats.length} 条对话`);

        const updates = chats
            .filter(c => c.jobUrl)
            .map(c => ({
                job_url: c.jobUrl,
                status: c.status,
                status_updated_at: new Date().toLocaleString('zh-CN'),
            }));

        const count = await sendStatusToBackend(updates);
        showPanelNotification(`✅ 状态采集完毕：${count} 条已更新`);
        log(`状态采集完毕: ${count} 条更新`);
    }

    // ============================================================
    //  模块三：检查是否需要采集提醒（19:50）
    // ============================================================

    let collectionReminderShown = false;
    let collectionReminderDate = '';

    function checkCollectionReminder() {
        const now = new Date();
        const currentDate = todayStr();

        // 重置每日状态
        if (currentDate !== collectionReminderDate) {
            collectionReminderShown = false;
            collectionReminderDate = currentDate;
        }

        if (collectionReminderShown) return;

        const hour = now.getHours();
        const minute = now.getMinutes();
        const [reminderH, reminderM] = CONFIG.COLLECTION_REMINDER_TIME.split(':').map(Number);

        if (hour === reminderH && minute >= reminderM && minute < reminderM + 5) {
            collectionReminderShown = true;
            showPanelNotification(
                '📊 即将生成报告！请手动切换到 BOSS直聘的「消息」页面，脚本将自动采集状态。',
                15000
            );
            log('触发状态采集提醒 (19:50)');

            // 如果在消息页，直接开始采集
            if (STATE.currentPage === 'chat') {
                setTimeout(() => collectStatuses(), 3000);
            }
        }
    }

    // ============================================================
    //  模块四：沉默跟进（每日 17:00）
    // ============================================================

    let followupCheckedToday = false;
    let followupCheckDate = '';

    /** 在聊天框发送跟进消息 */
    async function sendFollowupInDialog(message) {
        // 复用打招呼的发送逻辑
        return await sendGreetingInDialog(message);
    }

    /** 执行沉默跟进 */
    async function runFollowupCheck() {
        if (followupCheckedToday && followupCheckDate === todayStr()) {
            return;
        }

        const hour = new Date().getHours();
        if (hour < CONFIG.FOLLOWUP_CHECK_HOUR) return;

        log('========== 执行沉默跟进检查 ==========');

        try {
            const data = await apiGet('/api/get_silent_jobs');
            if (!data.success || !data.jobs || data.jobs.length === 0) {
                log('无沉默岗位需跟进');
                followupCheckedToday = true;
                followupCheckDate = todayStr();
                return;
            }

            log(`发现 ${data.jobs.length} 个沉默岗位需跟进`);

            for (const job of data.jobs) {
                if (!STATE.running) break;

                // 检查每日配额（跟进也消耗配额）
                if (STATE.todaySent >= CONFIG.DAILY_LIMIT) {
                    log('今日配额已用完，剩余跟进顺延至明日', 'warn');
                    break;
                }

                // 生成跟进消息
                const followupMsg = await generateFollowupMsg(
                    job.job_title,
                    job.company_name,
                    job.greeting || '',
                    job.status
                );

                if (!followupMsg) {
                    log(`跟进消息生成失败: ${job.company_name} - ${job.job_title}`, 'warn');
                    continue;
                }

                log(`跟进: ${job.company_name} - ${job.job_title} | ${followupMsg}`);

                // 在搜索结果页找到该岗位
                const foundJob = findJobByUrl(job.job_url);
                if (!foundJob || !foundJob.chatBtnElement) {
                    log('无法在当前页面找到该岗位，跳过', 'warn');
                    continue;
                }

                // 点击沟通
                foundJob.cardElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await new Promise(r => setTimeout(r, 600));
                clickChatButton(foundJob.chatBtnElement);

                // 发送
                await sendFollowupInDialog(followupMsg);
                await new Promise(r => setTimeout(r, 400));
                closeChatDialog();

                // 标记已跟进
                await apiPost('/api/mark_followed_up', {
                    job_url: job.job_url,
                    followup_message: followupMsg,
                    followup_time: new Date().toLocaleString('zh-CN'),
                    date: data.target_date,
                });

                STATE.todaySent++;
                STATE.processedUrls.add(job.job_url);
                updatePanel();

                // 间隔
                const intervalSec = Math.floor(Math.random() * 30) + 20;
                await new Promise(resolve => setTimeout(resolve, intervalSec * 1000));
            }

            followupCheckedToday = true;
            followupCheckDate = todayStr();
            log('========== 沉默跟进检查完成 ==========');
        } catch (e) {
            log('沉默跟进异常: ' + e.message, 'error');
        }
    }

    // ============================================================
    //  模块五：控制面板 UI
    // ============================================================

    function createControlPanel() {
        // 移除旧面板
        const old = document.getElementById('jobbot-panel');
        if (old) old.remove();

        const panel = document.createElement('div');
        panel.id = 'jobbot-panel';
        panel.innerHTML = `
            <style>
                #jobbot-panel {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    z-index: 99999;
                    background: linear-gradient(135deg, #1e293b, #334155);
                    color: #f1f5f9;
                    border-radius: 14px;
                    padding: 18px 20px;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
                    font-size: 13px;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.25);
                    min-width: 280px;
                    max-width: 340px;
                    user-select: none;
                    transition: opacity 0.3s;
                }
                #jobbot-panel .panel-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 12px;
                    padding-bottom: 10px;
                    border-bottom: 1px solid rgba(255,255,255,0.1);
                }
                #jobbot-panel .panel-title {
                    font-size: 15px;
                    font-weight: 700;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                #jobbot-panel .panel-row {
                    display: flex;
                    justify-content: space-between;
                    margin-bottom: 8px;
                }
                #jobbot-panel .panel-label { color: #94a3b8; }
                #jobbot-panel .panel-value { font-weight: 700; }
                #jobbot-panel .panel-value.warn { color: #fbbf24; }
                #jobbot-panel .panel-value.good { color: #34d399; }
                #jobbot-panel .panel-value.info { color: #60a5fa; }
                #jobbot-panel .panel-value.danger { color: #ef4444; }
                #jobbot-panel .panel-progress {
                    height: 6px;
                    background: rgba(255,255,255,0.1);
                    border-radius: 3px;
                    margin: 10px 0;
                    overflow: hidden;
                }
                #jobbot-panel .panel-progress-fill {
                    height: 100%;
                    background: linear-gradient(90deg, #3b82f6, #6366f1);
                    border-radius: 3px;
                    transition: width 0.4s;
                }
                #jobbot-panel .panel-btn {
                    width: 100%;
                    padding: 10px;
                    border: none;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: 700;
                    margin-top: 10px;
                    transition: all 0.2s;
                }
                #jobbot-panel .panel-btn.start { background: #10b981; color: #fff; }
                #jobbot-panel .panel-btn.start:hover { background: #059669; }
                #jobbot-panel .panel-btn.stop { background: #ef4444; color: #fff; }
                #jobbot-panel .panel-btn.stop:hover { background: #dc2626; }
                #jobbot-panel .panel-btn:disabled { opacity: 0.4; cursor: not-allowed; }
                #jobbot-panel .panel-status {
                    font-size: 11px;
                    color: #94a3b8;
                    text-align: center;
                    margin-top: 8px;
                }
                #jobbot-panel .panel-notification {
                    background: rgba(251,191,36,0.15);
                    border: 1px solid rgba(251,191,36,0.3);
                    border-radius: 6px;
                    padding: 8px 10px;
                    margin-top: 8px;
                    font-size: 12px;
                    color: #fbbf24;
                    display: none;
                }
                #jobbot-panel .panel-debug {
                    margin-top: 8px;
                    padding: 6px 8px;
                    background: rgba(0,0,0,0.3);
                    border-radius: 6px;
                    font-size: 11px;
                    color: #94a3b8;
                    max-height: 100px;
                    overflow-y: auto;
                    line-height: 1.5;
                }
            </style>
            <div class="panel-header">
                <span class="panel-title">🤖 JobBot v1.1</span>
                <span style="font-size:11px;color:#94a3b8;">@90s超时</span>
            </div>
            <div class="panel-row">
                <span class="panel-label">页面类型</span>
                <span class="panel-value info" id="jp-page">${STATE.currentPage || '检测中...'}</span>
            </div>
            <div class="panel-row">
                <span class="panel-label">今日发送</span>
                <span class="panel-value info" id="jp-sent">${STATE.todaySent} / ${CONFIG.DAILY_LIMIT}</span>
            </div>
            <div class="panel-progress">
                <div class="panel-progress-fill" id="jp-progress" style="width: ${Math.min(100, STATE.todaySent / CONFIG.DAILY_LIMIT * 100)}%"></div>
            </div>
            <div class="panel-row">
                <span class="panel-label">当前时段</span>
                <span class="panel-value" id="jp-section">${getCurrentSection() ? (getCurrentSection() === 'morning' ? '🌅 上午场' : '🌆 下午场') : '⏸ 非发送时段'}</span>
            </div>
            <div class="panel-row">
                <span class="panel-label">配置状态</span>
                <span class="panel-value warn" id="jp-config">加载中...</span>
            </div>
            <div class="panel-row">
                <span class="panel-label">状态</span>
                <span class="panel-value" id="jp-state">${STATE.running ? '🟢 运行中' : '⏸ 已停止'}</span>
            </div>
            <button class="panel-btn ${STATE.running ? 'stop' : 'start'}" id="jp-toggle">
                ${STATE.running ? '⏹ 停止' : '▶ 启动'}
            </button>
            <!-- 招呼语预览区 -->
            <div id="jp-greeting-box" style="display:none; margin:8px 0; padding:6px; background:rgba(255,255,255,0.03); border-radius:6px;">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:11px;">
                    <span style="color:#94a3b8;">匹配度</span><span class="panel-value good" id="jp-match-score">--</span>
                </div>
                <textarea id="jp-greeting-text" style="width:100%;height:56px;padding:4px;border-radius:4px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.3);color:#f1f5f9;font-size:11px;resize:none;box-sizing:border-box;"></textarea>
                <div style="display:flex;gap:4px;margin-top:4px;">
                    <button class="panel-btn start" id="jp-copy-greeting" style="flex:1;font-size:10px;padding:4px;">📋 复制</button>
                    <button class="panel-btn start" id="jp-open-detail" style="flex:1;font-size:10px;padding:4px;">🔗 打开详情</button>
                </div>
            </div>
            <div class="panel-status" id="jp-status">等待指令...</div>
            <div class="panel-debug" id="jp-debug">初始化中...</div>
            <button class="panel-btn start" id="jp-copy-diag" style="margin-top:4px; font-size:11px; padding:6px;">📋 复制诊断信息</button>
            <div class="panel-notification" id="jp-notif"></div>
        `;

        document.body.appendChild(panel);

        // 绑定事件
        const btnToggle = document.getElementById('jp-toggle');
        btnToggle.addEventListener('click', toggleRunning);

        // 招呼复制按钮
        const btnCopyGreeting = document.getElementById('jp-copy-greeting');
        if (btnCopyGreeting) {
            btnCopyGreeting.addEventListener('click', () => {
                const text = document.getElementById('jp-greeting-text')?.value;
                if (text) {
                    GM_setClipboard(text, 'text');
                    showPanelNotification('✅ 招呼语已复制！', 2000);
                }
            });
        }

        // 打开详情按钮
        const btnOpenDetail = document.getElementById('jp-open-detail');
        if (btnOpenDetail) {
            btnOpenDetail.addEventListener('click', () => {
                if (STATE.currentJobUrl) {
                    window.open(STATE.currentJobUrl, '_blank');
                }
            });
        }

        // 复制诊断按钮
        const btnCopy = document.getElementById('jp-copy-diag');
        if (btnCopy) {
            btnCopy.addEventListener('click', () => {
                const diag = window.__JOBOT_DIAG__;
                const debugEl = document.getElementById('jp-debug');
                let text = debugEl ? debugEl.innerText : '';
                if (diag) {
                    text += '\n\n--- 详细诊断 ---\n';
                    text += getDomDiagString();
                }
                navigator.clipboard.writeText(text).then(() => {
                    showPanelNotification('✅ 诊断信息已复制到剪贴板！发给开发者', 3000);
                }).catch(() => {
                    // fallback: 选中文本让用户手动复制
                    showPanelNotification('⚠ 自动复制失败，请查看面板中的诊断信息', 5000);
                });
            });
        }

        // 可拖动
        makeDraggable(panel);
    }

    /** 使面板可拖动 */
    function makeDraggable(el) {
        const header = el.querySelector('.panel-header');
        if (!header) return;

        let offsetX, offsetY, isDragging = false;

        header.style.cursor = 'move';
        header.addEventListener('mousedown', (e) => {
            isDragging = true;
            offsetX = e.clientX - el.getBoundingClientRect().left;
            offsetY = e.clientY - el.getBoundingClientRect().top;
            el.style.transition = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            el.style.left = (e.clientX - offsetX) + 'px';
            el.style.top = (e.clientY - offsetY) + 'px';
            el.style.bottom = 'auto';
            el.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
            el.style.transition = 'opacity 0.3s';
        });
    }

    /** 更新面板数据 */
    function updatePanel() {
        const sentEl = document.getElementById('jp-sent');
        const progressEl = document.getElementById('jp-progress');
        const sectionEl = document.getElementById('jp-section');
        const stateEl = document.getElementById('jp-state');
        const statusEl = document.getElementById('jp-status');
        const pageEl = document.getElementById('jp-page');
        const configEl = document.getElementById('jp-config');

        if (sentEl) sentEl.textContent = `${STATE.todaySent} / ${CONFIG.DAILY_LIMIT}`;
        if (progressEl) progressEl.style.width = Math.min(100, STATE.todaySent / CONFIG.DAILY_LIMIT * 100) + '%';

        const section = getCurrentSection();
        if (sectionEl) {
            sectionEl.textContent = section === 'morning' ? '🌅 上午场'
                                  : section === 'afternoon' ? '🌆 下午场'
                                  : '⏸ 非发送时段';
        }

        if (stateEl) {
            stateEl.textContent = STATE.running ? '🟢 运行中' : '⏸ 已停止';
        }

        if (pageEl) {
            pageEl.textContent = STATE.currentPage || '?';
            pageEl.className = 'panel-value ' + (STATE.currentPage === 'search' ? 'good' : STATE.currentPage === 'other' ? 'danger' : 'info');
        }

        if (configEl) {
            if (STATE.configLoaded) {
                configEl.textContent = '✅ 已同步';
                configEl.className = 'panel-value good';
            } else {
                configEl.textContent = '⚠ 未同步';
                configEl.className = 'panel-value warn';
            }
        }
    }

    /** 更新调试面板 */
    function setDebugInfo(...msgs) {
        const el = document.getElementById('jp-debug');
        if (el) {
            el.innerHTML = msgs.map(m => `• ${m}`).join('<br>');
        }
    }

    /** 追加调试信息 */
    function appendDebug(msg) {
        const el = document.getElementById('jp-debug');
        if (el) {
            const current = el.innerHTML;
            el.innerHTML = current + '<br>• ' + msg;
            el.scrollTop = el.scrollHeight;
        }
    }

    /** 设置面板状态文本 */
    function setPanelStatus(text) {
        const el = document.getElementById('jp-status');
        if (el) el.textContent = text;
    }

    /** 显示面板通知 */
    function showPanelNotification(msg, duration = 8000) {
        const el = document.getElementById('jp-notif');
        if (!el) return;
        el.textContent = msg;
        el.style.display = 'block';
        clearTimeout(el._timer);
        el._timer = setTimeout(() => { el.style.display = 'none'; }, duration);
    }

    /** 启动/停止切换 */
    async function toggleRunning() {
        if (STATE.running) {
            STATE.running = false;
            setPanelStatus('已手动停止');
            updateButtonState();
            setDebugInfo('⏸ 已停止');
            log('用户手动停止');
        } else {
            STATE.running = true;
            setPanelStatus('启动中...');
            updateButtonState();

            // 重新检测页面类型（可能在页面切换后）
            const pageType = detectPageType();
            STATE.currentPage = pageType;
            setDebugInfo('🔍 检测页面: ' + pageType);

            // 同步配置和计数
            await syncRemoteConfig();
            await syncTodayCount();
            updatePanel();

            // 检查时间窗口
            const timeInfo = isInTimeWindow();
            if (!timeInfo.inWindow) {
                setDebugInfo(
                    '⏰ 非发送时段',
                    '上午: ' + CONFIG.MORNING_START + ':00-' + CONFIG.MORNING_END + ':00',
                    '下午: ' + CONFIG.AFTERNOON_START + ':00-' + CONFIG.AFTERNOON_END + ':00',
                    '当前: ' + new Date().getHours() + ':' + String(new Date().getMinutes()).padStart(2, '0')
                );
                setPanelStatus('非发送时段，等待中...');
            }

            // 处理当前页面
            if (STATE.currentPage === 'search') {
                setPanelStatus('自动打招呼运行中...');
                autoGreetingLoop().catch(e => {
                    log('打招呼循环异常: ' + e.message, 'error');
                    setDebugInfo('❌ 错误: ' + e.message);
                    STATE.running = false;
                    updateButtonState();
                });
            } else {
                setPanelStatus('❌ 请在BOSS直聘搜索结果页使用');
                showPanelNotification('⚠ 当前页面不是搜索结果页，请打开 https://www.zhipin.com/web/geek/jobs?...');
                setDebugInfo(
                    '❌ 页面类型: ' + STATE.currentPage,
                    '需要: search (搜索结果页)',
                    '当前URL: ' + window.location.href.substring(0, 60) + '...'
                );
            }
        }
    }

    /** 更新按钮状态 */
    function updateButtonState() {
        const btn = document.getElementById('jp-toggle');
        if (!btn) return;
        if (STATE.running) {
            btn.textContent = '⏹ 停止';
            btn.className = 'panel-btn stop';
        } else {
            btn.textContent = '▶ 启动';
            btn.className = 'panel-btn start';
        }
    }

    // ============================================================
    //  模块六：定时检查
    // ============================================================

    let lastFollowupCheckMinute = -1;

    function periodicChecks() {
        // 每分钟执行一次
        const now = new Date();
        const currentMinute = now.getHours() * 60 + now.getMinutes();

        // 检查状态采集提醒
        checkCollectionReminder();

        // 检查沉默跟进 (17:00 整点附近，每分钟检查一次)
        if (now.getHours() === CONFIG.FOLLOWUP_CHECK_HOUR && currentMinute !== lastFollowupCheckMinute) {
            lastFollowupCheckMinute = currentMinute;
            if (!followupCheckedToday || followupCheckDate !== todayStr()) {
                log('触发沉默跟进定时任务');
                runFollowupCheck().catch(e => log('跟进异常: ' + e.message, 'error'));
            }
        }
    }

    // ============================================================
    //  主入口
    // ============================================================

    async function main() {
        log('========================================');
        log('  BOSS直聘 求职自动化助手 v' + STATE.version);
        log('========================================');

        // 检测页面类型
        STATE.currentPage = detectPageType();
        log('当前页面类型: ' + STATE.currentPage);

        // 安装API截获钩子（捕获BOSS打招呼API）
        installAPICapture();

        // 同步远程配置
        await syncRemoteConfig();
        await syncTodayCount();

        // 创建控制面板
        createControlPanel();
        updatePanel();

        // 根据页面类型决定行为
        if (STATE.currentPage === 'search') {
            setPanelStatus('就绪 — 搜索结果页');
            setDebugInfo(
                '✅ 页面类型: 搜索结果页',
                '📍 URL匹配成功',
                '⏳ 等待点击「启动」...'
            );
            log('在搜索结果页，可启动自动打招呼');

            // 如果当前在发送时段内，提示可启动
            const timeInfo = isInTimeWindow();
            if (timeInfo.inWindow) {
                showPanelNotification('⏰ 当前在发送时段内，点击「启动」开始自动打招呼');
            }

            // ★ 检查是否从消息页回来，自动恢复
            try {
                const autoResume = GM_getValue('auto_resume', '');
                if (autoResume === '1') {
                    GM_setValue('auto_resume', '');
                    log('检测到自动恢复标记，自动启动循环');
                    setTimeout(async () => {
                        STATE.running = true;
                        updateButtonState();
                        updatePanel();
                        await syncTodayCount();
                        setPanelStatus('自动恢复运行中...');
                        autoGreetingLoop().catch(e => {
                            log('循环异常: ' + e.message, 'error');
                            STATE.running = false;
                            updateButtonState();
                        });
                    }, 2000);
                }
            } catch(e) {}
        } else if (STATE.currentPage === 'chat') {
            // ★ 检查是否有待发送的招呼语（从搜索页跳过来的）
            let hasPending = false;
            try {
                const raw = GM_getValue('pending_greeting', '');
                if (raw) {
                    const pd = JSON.parse(raw);
                    if (pd.greeting && (Date.now() - pd.timestamp < 300000)) {
                        hasPending = true;
                    }
                }
            } catch(e) {}

            if (hasPending) {
                setPanelStatus('消息页 — 自动发送中...');
                log('检测到待发送招呼语，自动处理...');
                // 自动发送招呼语，然后返回搜索页
                handleChatPage().catch(e => {
                    log('消息页处理异常: ' + e.message, 'error');
                });
            } else {
                setPanelStatus('就绪 — 消息页');
                setDebugInfo('💬 页面类型: 消息页');
                log('在消息页，可进行状态采集');
            }

            // 如果是 19:50 提醒触发的，自动采集
            const now = new Date();
            const [rh, rm] = CONFIG.COLLECTION_REMINDER_TIME.split(':').map(Number);
            if (now.getHours() === rh && now.getMinutes() >= rm) {
                log('检测到关注时间，自动采集状态...');
                setTimeout(() => collectStatuses(), 2000);
            }
        } else {
            setPanelStatus('请打开 BOSS直聘搜索结果页');
            setDebugInfo(
                '⚠ 页面类型: ' + STATE.currentPage,
                '需要: search (搜索结果页)',
                'URL: ' + window.location.pathname
            );
        }

        // 定时检查（每分钟）
        setInterval(periodicChecks, 60000);

        // 页面切换检测（监听 URL 变化）
        let lastUrl = window.location.href;
        new MutationObserver(() => {
            if (window.location.href !== lastUrl) {
                lastUrl = window.location.href;
                const newPage = detectPageType();
                const oldPage = STATE.currentPage;
                STATE.currentPage = newPage;
                log('页面切换: ' + oldPage + ' -> ' + newPage);

                // 从搜索页切换到消息页 → 延迟触发自动发送（等DOM渲染）
                if (newPage === 'chat' && STATE.running) {
                    log('检测到跳转消息页，2秒后触发发送...');
                    setTimeout(() => {
                        handleChatPage().catch(e => log('消息页异常: ' + e, 'error'));
                    }, 2000);
                }
            }
        }).observe(document, { subtree: true, childList: true });

        log('初始化完成，等待用户操作');
    }

    // 启动
    main().catch(e => {
        log('初始化失败: ' + e.message, 'error');
        console.error(e);
    });

})();
