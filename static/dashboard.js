/**
 * 求职自动化仪表盘 - 前端逻辑 v2
 * 新增：简历上传/删除/拖拽、智能匹配配置
 */

const API_BASE = '';
const MAX_RESUMES = 3;

// ============================================================
// 工具函数
// ============================================================

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function showToast(msg, type = 'success') {
    const toast = $('#toast');
    toast.textContent = msg;
    toast.className = 'toast ' + type + ' show';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function formatPercent(v) {
    if (v == null || isNaN(v)) return '--';
    return v + '%';
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// ============================================================
// 页面导航
// ============================================================

function initNavigation() {
    $$('.nav-item').forEach(item => {
        item.addEventListener('click', function(e) {
            e.preventDefault();
            const page = this.dataset.page;
            $$('.nav-item').forEach(n => n.classList.remove('active'));
            this.classList.add('active');
            $$('.page').forEach(p => p.classList.remove('active'));
            $(`#page-${page}`).classList.add('active');
            if (page === 'dashboard') loadDashboard();
            if (page === 'settings') { loadSettings(); loadResumeList(); }
            if (page === 'history')  loadHistoryDates();
        });
    });
}

// ============================================================
// 仪表盘数据
// ============================================================

function updateHeader() {
    const now = new Date();
    $('#currentDate').textContent =
        now.toLocaleDateString('zh-CN', { year:'numeric', month:'long', day:'numeric', weekday:'long' });
}

async function loadDashboard() {
    updateHeader();
    try {
        const resp = await fetch(API_BASE + '/api/today_stats');
        const data = await resp.json();
        if (!data.success) return;
        const s = data;
        $('#kpiSent').textContent = s.total_sent;
        $('#kpiLimit').textContent = s.daily_limit;
        $('#kpiRead').textContent = s.read_count;
        $('#kpiReadRate').textContent = formatPercent(s.read_rate);
        $('#kpiReplied').textContent = s.replied_count;
        $('#kpiReplyRate').textContent = formatPercent(s.reply_rate);
        $('#kpiAvgScore').textContent = s.avg_match_score;
        const morningPct = Math.min(100, (s.morning_sent / Math.max(s.morning_quota, 1)) * 100);
        const afternoonPct = Math.min(100, (s.afternoon_sent / Math.max(s.afternoon_quota, 1)) * 100);
        $('#morningBar').style.width = morningPct + '%';
        $('#morningText').textContent = `${s.morning_sent}/${s.morning_quota}`;
        $('#afternoonBar').style.width = afternoonPct + '%';
        $('#afternoonText').textContent = `${s.afternoon_sent}/${s.afternoon_quota}`;
    } catch (e) {
        console.error('加载仪表盘失败:', e);
    }
}

// ============================================================
// 报告
// ============================================================

async function generateReport(date) {
    const btn = $('#btnGenerateReport');
    btn.textContent = '⏳ 生成中...';
    btn.disabled = true;
    try {
        const url = date ? `${API_BASE}/api/generate_report?date=${date}` : `${API_BASE}/api/generate_report`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (!data.success || !data.report) {
            $('#reportContainer').style.display = 'block';
            $('#reportContent').innerHTML = `<div class="card" style="text-align:center;padding:40px;color:var(--text-secondary);">⚠️ ${data.message || '报告生成失败'}</div>`;
            return;
        }
        renderReport(data.report);
        $('#reportContainer').style.display = 'block';
        $('#reportContainer').scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
        console.error('生成报告失败:', e);
        showToast('报告生成失败', 'error');
    } finally {
        btn.textContent = '📄 生成今日报告';
        btn.disabled = false;
    }
}

function renderReport(r) {
    const html = `
    <div class="report-wrapper">
        <div class="report-header"><h2>📊 求职数据分析报告</h2><div class="report-meta">${r.date} | 生成时间：${r.generated_at}</div></div>
        <div class="report-body">
            <div class="report-section"><h3>一、核心漏斗</h3>
                <table class="funnel-table">${[
                    ['📤 今日发送数', r.funnel.total_sent], ['👁️ 已读数', r.funnel.read_count], ['📈 已读率', formatPercent(r.funnel.read_rate)],
                    ['💬 回复数', r.funnel.replied_count], ['📊 回复率（分母=已读）', formatPercent(r.funnel.reply_rate)],
                    ['🎤 面试邀约', r.funnel.interview_count], ['⏳ 待沟通', r.funnel.unread_count], ['⭐ 平均匹配度', r.avg_match_score + ' / 100']
                ].map(([k,v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table></div>
            <div class="report-section"><h3>二、匹配度分析</h3>
                <div class="match-buckets">${Object.entries(r.match_analysis).map(([bucket, v]) => `
                    <div class="match-bucket"><div class="bucket-label">${bucket} 分</div><div class="bucket-count">${v.sent}</div>
                    <div class="bucket-detail">已读率 ${formatPercent(v.read_rate)}</div><div class="bucket-detail">回复率 ${formatPercent(v.reply_rate)}</div></div>`).join('')}</div>
                <p style="color:var(--text-secondary);font-size:13px;">平均匹配度：<strong style="color:var(--primary);font-size:16px;">${r.avg_match_score}</strong> / 100</p></div>
            <div class="report-section"><h3>三、时段对比</h3>
                <div class="section-compare">
                    <div class="compare-card"><h4>🌅 上午场</h4>${['发送量','已读率','回复率','平均匹配度'].map((k,i) => `<div class="stat-row"><span>${k}</span><span>${[r.section_comparison.morning.sent, formatPercent(r.section_comparison.morning.read_rate), formatPercent(r.section_comparison.morning.reply_rate), r.section_comparison.morning.avg_score][i]}</span></div>`).join('')}</div>
                    <div class="compare-card"><h4>🌆 下午场</h4>${['发送量','已读率','回复率','平均匹配度'].map((k,i) => `<div class="stat-row"><span>${k}</span><span>${[r.section_comparison.afternoon.sent, formatPercent(r.section_comparison.afternoon.read_rate), formatPercent(r.section_comparison.afternoon.reply_rate), r.section_comparison.afternoon.avg_score][i]}</span></div>`).join('')}</div>
                </div><div class="section-conclusion">💡 ${r.section_comparison.conclusion}</div></div>
            <div class="report-section"><h3>四、沉默跟进</h3><p style="font-size:14px;">今日触发跟进：<strong>${r.silent_followup.followed_up_today}</strong> 条</p><p style="font-size:14px;margin-top:4px;">检查日期 <strong>${r.silent_followup.target_date}</strong>：待跟进 <strong>${r.silent_followup.silent_count}</strong> 条</p><p style="color:var(--text-secondary);font-size:12px;margin-top:8px;">${r.silent_followup.note}</p></div>
            <div class="report-section"><h3>五、优化建议</h3><ul class="suggestion-list">${r.suggestions.map(s => `<li>🔹 ${s}</li>`).join('')}</ul></div>
            <div class="report-section"><h3>六、待跟进</h3>${r.follow_up_items.length === 0 ? '<p style="color:var(--text-secondary);">✅ 暂无</p>' : r.follow_up_items.map(item => `<div class="followup-item"><span><strong>${item.company_name}</strong> - ${item.job_title}</span><span>匹配: <strong>${item.match_score}%</strong> | ${item.send_time}</span></div>`).join('')}</div>
        </div></div>`;
    $('#reportContent').innerHTML = html;
}

function copyReport() {
    const content = $('#reportContent').innerText;
    if (!content) return;
    navigator.clipboard.writeText(content).then(() => showToast('✅ 已复制')).catch(() => {
        const ta = document.createElement('textarea'); ta.value = content;
        document.body.appendChild(ta); ta.select(); document.execCommand('copy');
        document.body.removeChild(ta); showToast('✅ 已复制');
    });
}

// ============================================================
// 简历管理（母版知识库）
// ============================================================

async function loadResumeList() {
    try {
        const resp = await fetch(API_BASE + '/api/resumes');
        const data = await resp.json();
        if (!data.success) return;

        const grid = $('#resumeGrid');
        const resumes = data.resumes || [];
        const remaining = data.max_count - resumes.length;

        $('#resumeRemaining').textContent = remaining;
        $('#btnUploadResume').disabled = remaining <= 0;

        if (resumes.length === 0) {
            grid.innerHTML = '<div class="resume-empty">暂无简历，请上传 PDF</div>';
        } else {
            grid.innerHTML = resumes.map(r => `
                <div class="resume-card">
                    <div class="resume-icon">📄</div>
                    <div class="resume-info">
                        <div class="resume-name" title="${r.original_name}">${r.original_name}</div>
                        <div class="resume-meta">${formatSize(r.size)} · ${r.text_length} 字 · ${r.uploaded_at}</div>
                        ${r.text_length === 0 ? '<div class="resume-meta" style="color:#ef4444;">⚠️ 文本提取失败，请检查 PDF 是否为扫描件</div>' : ''}
                    </div>
                    <button class="resume-delete" onclick="deleteResume('${r.id}')" title="删除">✕</button>
                </div>
            `).join('');
        }
    } catch (e) {
        console.error('加载简历列表失败:', e);
    }
}

async function uploadResume(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
        showToast('仅支持 PDF 格式', 'error'); return;
    }
    if (file.size > 10 * 1024 * 1024) {
        showToast('文件不能超过 10MB', 'error'); return;
    }

    const btn = $('#btnUploadResume');
    btn.textContent = '⏳ 上传解析中...';
    btn.disabled = true;

    try {
        const formData = new FormData();
        formData.append('file', file);
        const resp = await fetch(API_BASE + '/api/resumes', { method: 'POST', body: formData });
        const data = await resp.json();
        if (data.success) {
            showToast(`✅ ${data.message}（${data.text_length} 字）`);
            await loadResumeList();
        } else {
            showToast(data.message || '上传失败', 'error');
            btn.disabled = false;
        }
    } catch (e) {
        console.error('上传简历失败:', e);
        showToast('上传失败，请检查网络', 'error');
        btn.disabled = false;
    }
    btn.textContent = '📎 上传 PDF 简历';
}

async function deleteResume(id) {
    if (!confirm('确定删除这份简历？删除后无法恢复。')) return;
    try {
        const resp = await fetch(`${API_BASE}/api/resumes/${id}`, { method: 'DELETE' });
        const data = await resp.json();
        if (data.success) {
            showToast('✅ 已删除');
            await loadResumeList();
        } else {
            showToast(data.message || '删除失败', 'error');
        }
    } catch (e) {
        console.error('删除简历失败:', e);
        showToast('删除失败', 'error');
    }
}

// ============================================================
// 设置管理
// ============================================================

async function loadSettings() {
    try {
        const resp = await fetch(API_BASE + '/api/settings');
        const data = await resp.json();
        if (!data.success) return;
        const s = data.settings;

        $('#setApiKey').value = s.api_key_masked || '';
        $('#setTargetRoles').value = s.target_roles || '';
        $('#setCoreSkills').value = s.core_skills || '';
        $('#setResumeText').value = s.resume_text || '';
        $('#setMatchThreshold').value = s.match_threshold;
        $('#setDailyLimit').value = s.daily_limit;
        $('#setMorningQuota').value = s.morning_quota;
        $('#setAfternoonQuota').value = s.afternoon_quota;
        $('#setMorningStart').value = s.morning_start;
        $('#setMorningEnd').value = s.morning_end;
        $('#setAfternoonStart').value = s.afternoon_start;
        $('#setAfternoonEnd').value = s.afternoon_end;
        $('#setSilentDays').value = s.silent_days;
        $('#setFollowupThreshold').value = s.followup_match_threshold;

        const models = s.available_models || [];
        const sel = $('#setModelName');
        sel.innerHTML = '';
        models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = `${m.name} (${m.provider})`;
            if (m.id === s.model_name) opt.selected = true;
            sel.appendChild(opt);
        });
        const isInList = models.some(m => m.id === s.model_name);
        $('#setCustomModel').value = isInList ? '' : (s.model_name || '');
    } catch (e) {
        console.error('加载设置失败:', e);
    }
}

async function saveSettings() {
    const btn = $('#btnSaveSettings');
    const status = $('#saveStatus');
    btn.textContent = '⏳ 保存中...';
    btn.disabled = true;

    const modelSelect = $('#setModelName').value;
    const customModel = $('#setCustomModel').value.trim();

    const payload = {
        api_key: $('#setApiKey').value.trim(),
        model_name: customModel || modelSelect,
        target_roles: $('#setTargetRoles').value.trim(),
        core_skills: $('#setCoreSkills').value.trim(),
        resume_text: $('#setResumeText').value.trim(),
        match_threshold: parseInt($('#setMatchThreshold').value) || 70,
        daily_limit: parseInt($('#setDailyLimit').value) || 150,
        morning_quota: parseInt($('#setMorningQuota').value) || 75,
        afternoon_quota: parseInt($('#setAfternoonQuota').value) || 75,
        morning_start: parseInt($('#setMorningStart').value) || 9,
        morning_end: parseInt($('#setMorningEnd').value) || 11,
        afternoon_start: parseInt($('#setAfternoonStart').value) || 14,
        afternoon_end: parseInt($('#setAfternoonEnd').value) || 16,
        silent_days: parseInt($('#setSilentDays').value) || 3,
        followup_match_threshold: parseInt($('#setFollowupThreshold').value) || 60,
    };

    try {
        const resp = await fetch(API_BASE + '/api/settings', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await resp.json();
        if (data.success) {
            status.textContent = '✅ 设置已保存';
            status.className = 'save-status visible';
            showToast('设置已保存，所有模块即刻生效');
        } else {
            status.textContent = '❌ ' + (data.message || '保存失败');
            status.className = 'save-status visible error';
        }
    } catch (e) {
        console.error('保存设置失败:', e);
        status.textContent = '❌ 网络错误';
        status.className = 'save-status visible error';
    } finally {
        btn.textContent = '💾 保存设置';
        btn.disabled = false;
        setTimeout(() => { status.classList.remove('visible', 'error'); }, 3000);
    }
}

// ============================================================
// 历史记录
// ============================================================

async function loadHistoryDates() {
    try {
        const resp = await fetch(API_BASE + '/api/history_dates');
        const data = await resp.json();
        if (!data.success) return;
        const sel = $('#historyDateSelect');
        sel.innerHTML = '';
        if (data.dates.length === 0) { sel.innerHTML = '<option value="">暂无历史数据</option>'; return; }
        data.dates.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.date;
            opt.textContent = `${d.date}（${d.count} 条记录）`;
            sel.appendChild(opt);
        });
    } catch (e) { console.error('加载历史日期失败:', e); }
}

async function loadHistoryReport() {
    const date = $('#historyDateSelect').value;
    if (!date) { showToast('请先选择日期', 'error'); return; }
    const container = $('#historyReportContainer');
    container.innerHTML = '<p style="text-align:center;padding:20px;">⏳ 加载中...</p>';
    try {
        const resp = await fetch(`${API_BASE}/api/generate_report?date=${date}`);
        const data = await resp.json();
        if (!data.success || !data.report) {
            container.innerHTML = `<p style="text-align:center;padding:20px;color:var(--text-secondary);">⚠️ ${data.message || '暂无数据'}</p>`;
            return;
        }
        const tempDiv = document.createElement('div'); tempDiv.id = 'reportContent';
        document.body.appendChild(tempDiv);
        renderReport(data.report);
        container.innerHTML = tempDiv.innerHTML;
        document.body.removeChild(tempDiv);
    } catch (e) {
        container.innerHTML = '<p style="text-align:center;padding:20px;color:red;">加载失败</p>';
    }
}

// ============================================================
// 健康检查
// ============================================================

async function healthCheck() {
    try {
        const resp = await fetch(API_BASE + '/api/health');
        const data = await resp.json();
        const dot = $('#serverStatus');
        const text = $('#serverStatusText');
        if (data.status === 'running') {
            dot.className = 'status-dot online';
            text.textContent = '服务运行中';
        } else {
            dot.className = 'status-dot offline';
            text.textContent = '服务异常';
        }
    } catch (e) {
        $('#serverStatus').className = 'status-dot offline';
        $('#serverStatusText').textContent = '无法连接';
    }

    // 获取版本信息
    try {
        const vResp = await fetch(API_BASE + '/api/version');
        const vData = await vResp.json();
        if (vData.version) {
            const vEl = $('#versionDisplay');
            if (vEl) vEl.textContent = 'v' + vData.version;
        }
    } catch (e) {
        // 静默忽略版本检查失败
    }
}

// ============================================================
// 初始化
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    updateHeader();
    loadDashboard();
    healthCheck();

    // 保存按钮
    const btnSave = $('#btnSaveSettings');
    if (btnSave) btnSave.addEventListener('click', saveSettings);

    // 简历上传按钮
    const btnUpload = $('#btnUploadResume');
    const fileInput = $('#resumeFileInput');
    if (btnUpload && fileInput) {
        btnUpload.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            if (fileInput.files.length > 0) uploadResume(fileInput.files[0]);
        });
    }

    // 拖拽上传
    const dropArea = $('#resumeUploadArea');
    if (dropArea) {
        ['dragenter', 'dragover'].forEach(evt => {
            dropArea.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); dropArea.classList.add('drag-over'); });
        });
        ['dragleave', 'drop'].forEach(evt => {
            dropArea.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); dropArea.classList.remove('drag-over'); });
        });
        dropArea.addEventListener('drop', e => {
            const files = e.dataTransfer.files;
            if (files.length > 0) uploadResume(files[0]);
        });
    }

    // 定时刷新
    setInterval(() => {
        if ($('#page-dashboard').classList.contains('active')) loadDashboard();
    }, 30000);
    setInterval(healthCheck, 60000);
});
