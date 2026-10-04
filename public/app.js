(function () {
  'use strict';
  const $ = function (s, el) { return (el || document).querySelector(s); };
  const $$ = function (s, el) { return Array.from((el || document).querySelectorAll(s)); };
  const main = $('#main');
  const sidebar = $('.sidebar');
  if (sidebar) {
    const navigation = sidebar.querySelector('nav');
    navigation.id = 'site-navigation';
    const menuButton = document.createElement('button');
    menuButton.type = 'button'; menuButton.className = 'mobile-menu-toggle';
    menuButton.textContent = '菜单'; menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-controls', navigation.id);
    sidebar.insertBefore(menuButton, navigation);
    function closeMenu() { sidebar.classList.remove('mobile-menu-open'); menuButton.setAttribute('aria-expanded', 'false'); menuButton.textContent = '菜单'; }
    menuButton.onclick = function () {
      const open = sidebar.classList.toggle('mobile-menu-open');
      menuButton.setAttribute('aria-expanded', String(open)); menuButton.textContent = open ? '收起菜单' : '菜单';
    };
    navigation.addEventListener('click', function(event) { if (event.target.closest('a,button')) closeMenu(); });
    sidebar.addEventListener('keydown', function(event) { if (event.key === 'Escape') { closeMenu(); menuButton.focus(); } });
    window.addEventListener('hashchange', closeMenu);
  }

  const BASE = document.body.dataset.base || '';
  const ADMIN = document.body.dataset.admin === 'true';
  let adminToken = ''; 
  const state = { overview: null, ai: { configured: false }, route: '', routeSerial: 0, exam: null, examTimer: null, editor: null, review: null, jobs: {}, toastTimer: null };
  let storagePrefix = 'yixue-exam-';
  let studentAccount = null;
  let saveTimer = null;
  let reviewFilter = 'all';
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (s) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]; }); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function dateLabel(s) { if (!s) return '—'; const d = new Date(s); return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); }
  function fullDate(s) { if (!s) return '—'; const d = new Date(s); return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleString('zh-CN', { hour12: false }); }
  function number(v) { if (v == null) return '待公布'; const n = Number(v); return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : '—'; }
  function active(a) { return a && !a.submitted_at && ['submitted', 'graded', 'completed'].indexOf(a.status) < 0; }
  function hasAnswer(v) { return Array.isArray(v) ? v.length > 0 : v != null && String(v).trim() !== ''; }
  function answerText(v) { return Array.isArray(v) ? v.join('、') : v == null || v === '' ? '未作答' : String(v); }
  function kindName(k) { return ({ choice: '单项选择', multi: '多项选择', number: '填空题', text: '简答题', essay: '写作题' })[k] || '简答题'; }
  function subjectName(code) { const s = (state.overview && state.overview.subjects || []).find(function (x) { return x.code === code; }); return s ? s.name : code; }
  function questionPoints(qs) { return qs.reduce(function (s, q) { return s + Number(q.points || 0); }, 0); }
  function badge(a) { if (!ADMIN && !active(a) && !a.released) return '<span class="pill pill-amber">待公布</span>'; if (active(a)) return '<span class="pill pill-amber">进行中</span>'; return a.pending_manual ? '<span class="pill pill-amber">待阅卷</span>' : '<span class="pill pill-green">已完成</span>'; }
  async function api(path, options) {
    const opts = options || {};
    const headers = { Accept: 'application/json' };
    if (ADMIN && adminToken) headers.Authorization = 'Bearer ' + adminToken;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try { res = await fetch(BASE + path, { method: opts.method || 'GET', headers: headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), cache: 'no-store' }); }
    catch (_) { throw new Error('无法连接本机服务。请确认考试服务器正在运行。'); }
    let data;
    try { data = await res.json(); } catch (_) { throw new Error('服务响应无法读取，请刷新后重试。'); }
    if (!res.ok) { if (res.status === 401 && !ADMIN && !path.startsWith('/api/student/')) { studentAccount = null; window.ExamAccounts.login(); } if (res.status === 401 && ADMIN && !path.startsWith('/api/auth/')) { adminToken = ''; renderLogin(); } const err = new Error(data.error || '请求未完成，请稍后重试。'); err.status = res.status; throw err; }
    return data;
  }
  function toast(message, error) {
    const el = $('#toast'); el.textContent = message; el.className = error ? 'show error' : 'show';
    clearTimeout(state.toastTimer); state.toastTimer = setTimeout(function () { el.className = ''; }, error ? 6500 : 3500);
  }
  function showError(err) { main.innerHTML = '<div class="error-panel"><div class="eyebrow">暂时无法打开</div><h2>请稍后再试</h2><p>' + esc(err.message || err) + '</p><button class="btn btn-primary" data-action="reload">重新加载</button></div>'; }
  function loading(message) { main.innerHTML = '<div class="loading"><span class="spinner"></span>' + esc(message || '正在加载…') + '</div>'; }
  async function overview(force) { if (!state.overview || force) { state.overview = await api('/api/overview'); state.ai = state.overview.ai || { configured: false }; } return state.overview; }
  function nav(path) { location.hash = path; }
  const privateDrafts = {};
  function localGet(key) { if (/^(editor-|grades-|jobs$)/.test(key)) return privateDrafts[key] || null; try { return JSON.parse(localStorage.getItem(storagePrefix + key)); } catch (_) { return null; } }
  function localSet(key, value) { if (/^(editor-|grades-|jobs$)/.test(key)) { privateDrafts[key] = value; return true; } try { localStorage.setItem(storagePrefix + key, JSON.stringify(value)); return true; } catch (_) { return false; } }
  function localRemove(key) { delete privateDrafts[key]; try { localStorage.removeItem(storagePrefix + key); } catch (_) {} }
  function modal(title, text, options) {
    return new Promise(function (resolve) {
      const opts = options || {}; const el = $('#modal');
      el.hidden = false; el.innerHTML = '<section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">' + esc(title) + '</h2><p>' + esc(text) + '</p>' + (opts.name ? '<label><span class="form-label">考生称呼（可选）</span><input id="student-name" maxlength="30" value="' + esc(localGet('student') || '') + '" placeholder="同学"></label>' : '') + '<div class="actions"><button class="btn" data-modal="cancel">' + esc(opts.cancel || '取消') + '</button><button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-modal="confirm">' + esc(opts.confirm || '确认') + '</button></div></section>';
      const focused = document.activeElement;
      function close(ok) {
        const name = opts.name ? $('#student-name').value.trim() || '同学' : undefined;
        el.hidden = true; el.innerHTML = ''; el.onclick = null; document.removeEventListener('keydown', key);
        if (focused && focused.focus) focused.focus();
        resolve(ok ? opts.name ? name : true : false);
      }
      function key(e) { if (e.key === 'Escape') close(false); }
      document.addEventListener('keydown', key);
      el.onclick = function (e) { const b = e.target.closest('[data-modal]'); if (b) close(b.dataset.modal === 'confirm'); };
      const first = opts.name ? $('#student-name') : $('[data-modal="confirm"]'); first.focus();
    });
  }
  function sourceNotice() {
    return '<div class="source-box"><strong>考试规则与练习范围</strong><br>采用北京中考书面考试的科目、时长与分值，题目按九年级上学期期中常见进度原创。语文 100 分、数学 100 分、英语笔试 60 分、物理笔试 70 分、道德与法治笔试 70 分，合计 400 分。英语听说 40 分、物理实验 10 分、道法综合素质 10 分单独考核，体育不纳入本练习。学校具体期中范围请以任课老师要求为准。<br><a href="https://jw.beijing.gov.cn/xxgk/2024zcwj/2024xzgfwj/202603/t20260327_4567670.html" target="_blank" rel="noopener">北京市教育委员会 · 2026 年中招工作规定</a></div>';
  }
  async function route() {
    if (!ADMIN && window.chrome && window.chrome.webview && state.exam && !state.exam.submitted && active(state.exam.data.attempt) && document.body.classList.contains('client-exam')) {
      const lockedHash = '#exam/' + state.exam.id;
      if (location.hash !== lockedHash) { history.replaceState(null, '', lockedHash); return; }
    }
    if (state.exam && state.exam.dirty && !state.exam.submitting) saveDraft(state.exam).catch(function () {});
    const serial = ++state.routeSerial; clearInterval(state.examTimer);
    const raw = location.hash.replace(/^#\/?/, '') || (ADMIN ? 'admin' : 'home');
    state.route = raw; const pieces = raw.split('/'); const page = pieces[0];
    const navPage = (page === 'scans' || page === 'scan') ? 'scans' : page === 'editor' ? 'admin' : page === 'review' || page === 'exam' ? 'history' : page === 'subject' || page === 'paper' ? 'home' : page;
    $$('[data-nav]').forEach(function (a) { a.classList.toggle('active', a.dataset.nav === navPage); });
    $('#breadcrumb').textContent = ({ home: '学习桌', subject: '学习桌 / 科目试卷', paper: '学习桌 / 试卷预览', exam: '考试记录 / 正在作答', review: '考试记录 / 答卷复盘', history: '考试记录', admin: '题库与出题', editor: '题库与出题 / 试卷编辑' })[page] || '学习桌';
    loading();
    try {
      if (ADMIN) { const auth = await api('/api/auth/status'); if (!auth.authenticated) { await renderLogin(auth); return; } }
      if (!ADMIN) {
        const auth = await api('/api/student/status');
        if (studentAccount && (!auth.student || auth.student.id !== studentAccount.id)) {
          state.overview = null; state.exam = null; state.history = null; state.review = null; clearTimeout(saveTimer);
        }
        studentAccount = auth.student;
        if (!studentAccount) { window.ExamAccounts.login(); return; }
        storagePrefix = 'yixue-exam-student-' + studentAccount.id + '-';
        window.ExamAccounts.identity(studentAccount);
      }
      if (!ADMIN && ['admin','editor','scans','scan','students'].includes(page)) { nav('home'); return; }
      await overview(page === 'home');
      if (serial !== state.routeSerial) return;
      if (page === 'home') await renderHome(serial);
      else if (page === 'subject') await renderSubject(pieces[1], serial);
      else if (page === 'paper') await renderPaper(pieces[1], serial);
      else if (page === 'exam') await renderExam(pieces[1], serial);
      else if (page === 'review') { reviewFilter = pieces[2] === 'wrong' ? 'wrong' : 'all'; await renderReview(pieces[1], serial); }
      else if (page === 'history') await renderHistory(serial);
      else if (page === 'admin') await renderAdmin(serial);
      else if (page === 'account' && !ADMIN) window.ExamAccounts.password();
      else if (page === 'students') await window.ExamAccounts.manage();
      else if (page === 'scans' || page === 'scan') await window.ExamScans.render(pieces[1], serial);
      else if (page === 'editor') await renderEditor(pieces[1], serial);
      else nav('home');
    } catch (err) { if (serial === state.routeSerial) { if (!ADMIN && err.status === 401) { window.ExamAccounts.login(); return; } showError(err); } }
    if (!ADMIN && window.chrome && window.chrome.webview) {
      if (serial !== state.routeSerial) return;
      const takingExam = page === 'exam' && state.exam && !state.exam.submitted && active(state.exam.data.attempt);
      document.body.classList.toggle('client-exam', !!takingExam);
      window.chrome.webview.postMessage(takingExam ? 'exam-active' : 'exam-idle');
    }
    window.scrollTo(0, 0);
  }
  async function renderLogin(auth) {
    const a = auth || await api('/api/auth/status');
    main.innerHTML = '<section class="card card-pad" style="max-width:480px;margin:60px auto"><div class="eyebrow">教师专用</div><h1>' + (a.configured ? '登录教师后台' : '设置教师密码') + '</h1><p>题库、参考答案、阅卷和成绩公布仅供教师管理。登录有效期30分钟。</p><form id="admin-login"><label class="form-label">教师密码<input name="password" type="password" required minlength="10" maxlength="128" autocomplete="' + (a.configured ? 'current-password' : 'new-password') + '"></label>' + (!a.configured ? '<label class="form-label">一次性设置码<input name="setup_code" required autocomplete="off" placeholder="填写安装时生成的设置码"></label><label class="form-label">再次输入密码<input name="confirm" type="password" required minlength="10" autocomplete="new-password"></label><p>请由教师完成首次设置，至少10个字符。</p>' : '') + '<button class="btn btn-primary" type="submit">' + (a.configured ? '登录' : '设置并登录') + '</button></form></section>';
    $('#admin-login').onsubmit = async function(event) { event.preventDefault(); event.stopPropagation(); const f = new FormData(event.target); if (!a.configured && f.get('password') !== f.get('confirm')) { toast('两次密码不一致。',true); return; } try { const d = await api('/api/auth/' + (a.configured ? 'login' : 'setup'), {method:'POST',body:{password:f.get('password'),setup_code:f.get('setup_code')}}); adminToken = d.token; state.overview = null; const tasks = await api('/api/jobs'); (tasks.jobs || []).forEach(function(j){watchJob(j.id,j.type,j.target_id);}); await route(); } catch(err) { toast(err.message,true); } };
  }
  async function renderHome(serial) {
    const d = await overview();
    if (serial !== state.routeSerial) return;
    const recent = (d.attempts || []).slice(0, 4); const ongoing = recent.find(active);
    const subjects = d.subjects || []; const stats = d.stats || {};
    main.innerHTML = '<div class="page-head"><div><div class="eyebrow">YOUR STUDY DESK</div><h1>今天，向前一步。</h1><p>从一份完整试卷开始，安静地作答，认真地复盘。这里记录你的每一次进步。</p></div></div>' +
      '<section class="card hero"><div class="hero-content"><div class="eyebrow">九上期中 · 模拟考试</div><h2>' + (ongoing ? '有一份试卷，等你继续完成。' : '准备好，给自己一次完整的练习。') + '</h2><p>' + (ongoing ? esc(ongoing.paper_title || subjectName(ongoing.subject_code)) + ' · 考试仍在计时，截止 ' + esc(dateLabel(ongoing.deadline)) : '按北京中考书面试卷结构设置，覆盖五门计分文化科目。') + '</p>' + (ongoing ? '<a class="btn btn-primary" href="#exam/' + esc(ongoing.id) + '">继续作答 <span aria-hidden="true">→</span></a>' : '<a class="btn btn-primary" href="#subject/' + esc(subjects[0] ? subjects[0].code : '') + '">开始一份试卷 <span aria-hidden="true">→</span></a>') + '</div><div class="hero-decoration" aria-hidden="true"><div class="hero-ring"></div><div class="hero-number">05<small>文化科目</small></div><div class="hero-leaf"></div></div></section>' +
      '<div class="stats-grid"><div class="card stat-card"><div><div class="stat-label">可用试卷</div><div class="stat-number">' + esc(stats.papers || (d.papers || []).length) + '<span>份</span></div></div><span class="stat-icon">I</span></div><div class="card stat-card"><div><div class="stat-label">题库题目</div><div class="stat-number">' + esc(stats.question_count || 0) + '<span>道</span></div></div><span class="stat-icon">II</span></div><div class="card stat-card"><div><div class="stat-label">已完成练习</div><div class="stat-number">' + esc(stats.completed || 0) + '<span>次</span></div></div><span class="stat-icon">III</span></div><div class="card stat-card"><div><div class="stat-label">书面考试总分</div><div class="stat-number">400<span>分</span></div></div><span class="stat-icon">IV</span></div></div>' +
      '<div class="section-heading"><h2>选择你的练习科目</h2><span>五门文化科目 · 一份一份认真完成</span></div><div class="subjects-grid">' + subjects.map(function (s, i) {
        const count = (d.papers || []).filter(function (p) { return p.subject_code === s.code; }).length;
        const symbol = s.name.indexOf('英语') >= 0 ? 'Aa' : s.name.substring(0, 1);
        return '<article class="card subject-card"><div class="subject-top"><span class="subject-symbol">' + esc(symbol) + '</span><span class="subject-index">' + String(i + 1).padStart(2, '0') + '</span></div><h3>' + esc(s.name) + '</h3><p>' + esc(s.scope || s.description) + '</p><div class="subject-meta"><span><strong>' + esc(s.full_score) + '</strong>分</span><span><strong>' + esc(s.minutes) + '</strong>分钟</span><span>' + count + ' 份试卷</span></div><a class="btn" href="#subject/' + esc(s.code) + '">查看试卷 <span aria-hidden="true">↗</span></a></article>';
      }).join('') + '</div><div class="dashboard-bottom"><section class="card card-pad"><div class="card-title-row"><h3>最近的练习</h3><a class="btn btn-ghost btn-small" href="#history">全部记录 →</a></div>' + (recent.length ? recent.map(function (a) { return '<div class="history-mini-row"><div><h3>' + esc(a.paper_title || a.subject_name || subjectName(a.subject_code)) + '</h3><p>' + esc(dateLabel(a.started_at)) + ' · ' + (active(a) ? '正在作答' : !ADMIN && !a.released ? '等待公布成绩' : a.pending_manual ? '等待主观题阅卷' : '已完成') + '</p></div><div>' + (active(a) ? '<a class="btn btn-small" href="#exam/' + esc(a.id) + '">继续</a>' : '<a class="mini-score" href="#review/' + esc(a.id) + '">' + esc(number(a.total_score)) + '<small>/ ' + esc(a.max_score) + '</small></a>') + '</div></div>'; }).join('') : '<div class="empty"><h3>从第一份试卷开始</h3>完成练习后，成绩和复盘会出现在这里。</div>') + '</section><section class="card card-pad"><h3>让每一次考试更有收获</h3><div class="method-step"><b>1</b><div><h3>完整作答</h3><p>按规定时间考试，遇到难题可以标记后回看。</p></div></div><div class="method-step"><b>2</b><div><h3>逐题复盘</h3><p>对照参考答案与评分标准，找到失分的原因。</p></div></div><div class="method-step"><b>3</b><div><h3>聚焦薄弱点</h3><p>请教师安排针对薄弱知识点的新练习。</p></div></div></section></div>' + sourceNotice();
  }
  async function renderSubject(code, serial) {
    const subject = (state.overview.subjects || []).find(function (s) { return s.code === code; });
    if (!subject) throw new Error('找不到这个科目。');
    const d = await api('/api/papers?subject=' + encodeURIComponent(code));
    if (serial !== state.routeSerial) return;
    main.innerHTML = '<div class="page-head"><div><div class="eyebrow">SUBJECT / ' + esc(code.toUpperCase()) + '</div><h1>' + esc(subject.name) + '练习</h1><p>' + esc(subject.description) + '</p></div><a class="btn" href="#home">返回学习桌</a></div>' +
      '<div class="notice"><strong>' + esc(subject.minutes) + ' 分钟 · ' + esc(subject.full_score) + ' 分</strong><br>练习范围：' + esc(subject.scope) + (subject.note ? '<br>' + esc(subject.note) : '') + (subject.external_score ? '<br>本科目另有 ' + esc(subject.external_score) + ' 分单独考核，不计入本次书面模拟成绩。' : '') + '</div>' +
      '<div class="paper-list">' + ((d.papers || []).length ? d.papers.map(function (p) { return '<article class="card paper-card"><div><h3>' + esc(p.title) + '</h3><p>' + esc(p.scope || p.description) + '</p><div class="paper-card-meta"><span>' + esc(p.minutes) + ' 分钟</span><span>满分 ' + esc(p.max_score) + ' 分</span><span>' + esc(p.question_count || '—') + ' 道题</span><span class="pill pill-green">原创模拟卷</span></div></div><div class="head-actions"><a class="btn" href="#paper/' + esc(p.id) + '">预览 / 打印</a><button class="btn btn-primary" data-action="start" data-id="' + esc(p.id) + '">开始考试 →</button></div></article>'; }).join('') : '<div class="card empty"><h3>暂时没有可用试卷</h3>可以在题库后台添加试卷或使用 AI 出题。</div>') + '</div>' + sourceNotice();
  }
  function printHeader(p, name) { return '<div class="print-header"><h1>' + esc(p.title) + '</h1><p>' + esc(subjectName(p.subject_code)) + ' · 考试时间 ' + esc(p.minutes) + ' 分钟 · 满分 ' + esc(p.max_score) + ' 分</p><p>' + (name ? '考生：' + esc(name) : '姓名：________________  日期：________________') + '</p></div>'; }
  function sectionBlocks(qs, renderer) {
    let last = null, html = '';
    const passageKey = q => String(q.passage || '').replace(/\r\n?/g, '\n').trim();
    for (let i = 0; i < qs.length;) {
      const q = qs[i], section = q.section || '试题';
      if (section !== last) {
        const sectionQs = qs.filter(x => (x.section || '试题') === section);
        html += '<div class="section-banner"><h2>' + esc(section) + '</h2><small>共 ' + esc(questionPoints(sectionQs)) + ' 分</small></div>';
        last = section;
      }
      const passage = passageKey(q); let end = i + 1;
      if (passage) while (end < qs.length && (qs[end].section || '试题') === section && passageKey(qs[end]) === passage) end++;
      if (end > i + 1) {
        const labels = qs.slice(i, end).map((item, offset) => item.label || i + offset + 1);
        html += '<section class="passage-group"><div class="card shared-passage"><div class="shared-passage-label">阅读材料 · 对应题号：' + esc(labels.join('、')) + '</div><div class="passage">' + esc(q.passage) + '</div></div>';
        for (let j = i; j < end; j++) html += renderer(Object.assign({}, qs[j], { passage: '' }), j);
        html += '</section>';
      } else html += renderer(q, i);
      i = end;
    }
    return html;
  }
  function figureHtml(q) { return q.figure && /^[A-Za-z0-9_.-]+$/.test(q.figure) ? '<img class="question-figure" src="' + BASE + '/figures/' + esc(q.figure) + '" alt="' + esc(q.figure_alt || '题目配图') + '" loading="lazy">' : ''; }
  function questionBody(q) { return (q.passage ? '<div class="passage">' + esc(q.passage) + '</div>' : '') + '<div class="stem">' + esc(q.stem) + '</div>' + figureHtml(q); }
  function blankQuestion(q, i) {
    const options = (q.options || []).map(function (o, j) { return '<div class="option"><span class="option-letter">' + String.fromCharCode(65 + j) + '</span><span>' + esc(o) + '</span></div>'; }).join('');
    return '<article class="card question-card print-question"><div class="question-heading"><div class="q-label"><span class="q-number">' + esc(q.label || i + 1) + '</span><span>' + esc(kindName(q.kind)) + '</span></div><span class="q-points">' + esc(q.points) + ' 分</span></div>' + questionBody(q) + (options ? '<div class="options-list">' + options + '</div>' : '<div class="print-only print-answer-lines ' + (q.kind === 'essay' ? 'essay-lines' : q.kind === 'number' ? 'short-lines' : '') + '"></div>') + '</article>';
  }
  async function renderPaper(id, serial) {
    const d = await api('/api/papers/' + encodeURIComponent(id)); if (serial !== state.routeSerial) return;
    const p = d.paper; const qs = d.questions || [];
    main.innerHTML = '<div class="page-head"><div><div class="eyebrow">PAPER PREVIEW</div><h1>' + esc(p.title) + '</h1><p>' + esc(p.scope) + '</p></div><div class="head-actions"><button class="btn" data-action="print">打印空白试卷</button><button class="btn btn-primary" data-action="start" data-id="' + esc(p.id) + '">开始考试 →</button></div></div><div class="notice">' + esc(p.minutes) + ' 分钟 · ' + esc(p.max_score) + ' 分 · ' + qs.length + ' 道题。预览不计时、不显示答案；开始考试后按服务端截止时间计时。</div>' + printHeader(p) + '<div class="paper-preview question-area">' + sectionBlocks(qs, blankQuestion) + '</div><div class="source-box">' + esc(p.source_note || '本卷为原创练习题。') + '</div>';
  }
  async function startExam(id) {
    const p = (state.overview.papers || []).find(function (x) { return x.id === id; });
    const name = await modal('准备开始考试', (p ? p.title + '\n' + p.minutes + ' 分钟，满分 ' + p.max_score + ' 分。\n' : '') + '点击开始后持续计时，关闭网页或离开页面也不会暂停。到时将自动交卷。', { confirm: '开始考试' });
    if (!name) return;
    const d = await api('/api/attempts', { method: 'POST', body: { paper_id: id, student_name: studentAccount ? studentAccount.name : '' } }); nav('exam/' + d.id);
  }
  function examDraft(e) { return { answers: e.answers, flags: Array.from(e.flags), updated_at: Date.now() }; }
  function persistExam(e) {
    if (!localSet('draft-' + e.id, examDraft(e))) {
      e.localFailure = true; updateSaveState(e);
    }
  }
  function responseAnswers(data) { const out = {}; Object.keys(data.responses || {}).forEach(function (id) { out[id] = data.responses[id].answer; }); return out; }
  async function renderExam(id, serial) {
    const d = await api('/api/attempts/' + encodeURIComponent(id)); if (serial !== state.routeSerial) return;
    if (!active(d.attempt)) { nav('review/' + id); return; }
    const old = state.exam && state.exam.id === id ? state.exam : null;
    const draft = localGet('draft-' + id);
    const serverAnswers = responseAnswers(d);
    const serverFlags = Object.keys(d.responses || {}).filter(function (q) { return d.responses[q].flagged; });
    const e = old || {
      id: id, data: d, answers: old ? old.answers : Object.assign(serverAnswers, draft && draft.answers || {}),
      flags: old ? old.flags : new Set(draft && draft.flags || serverFlags),
      dirty: old ? old.dirty : !!draft, version: old ? old.version : 0,
      savePromise: null, submitting: false, error: '', lastSaved: '', localFailure: false,
      offset: new Date(d.server_time).getTime() - Date.now()
    };
    e.data = d;
    e.offset = new Date(d.server_time).getTime() - Date.now();
    if (!Number.isFinite(e.offset)) e.offset = 0;
    state.exam = e;
    const p = d.paper; const qs = d.questions || [];
    main.innerHTML = '<div class="exam-top"><div><h2>' + esc(p.title) + '</h2><p>' + esc(d.attempt.student_name) + ' · 满分 ' + esc(p.max_score) + ' 分 · <span id="save-state" class="save-state">草稿已载入</span></p></div><div class="timer-block"><div><div class="timer-label">剩余时间</div><div class="timer" id="exam-timer">—</div></div><button class="btn btn-primary" data-action="submit">交卷</button></div></div>' + printHeader(p, d.attempt.student_name) +
      '<div class="exam-layout"><section class="question-area">' + sectionBlocks(qs, function (q, i) { return examQuestion(q, i, e); }) + '<div class="exam-footer-actions"><p>作答会自动保存。标记题目可在右侧答题卡快速定位。</p><button class="btn btn-primary" data-action="submit">完成作答，提交试卷 →</button></div></section><aside class="card exam-navigator"><h3>答题卡</h3><div id="answer-progress" class="progress-count"></div><div class="progress-bar"><span id="answer-progress-bar"></span></div><div id="question-navigation">' + navigationDots(qs, e) + '</div><div class="navigator-legend"><span></span>已作答<span class="legend-flag"></span>待回看<br>时间按考试开始时计算，不可暂停。</div></aside></div>';
    updateExamProgress(e); updateTimer(e); state.examTimer = setInterval(function () { updateTimer(e); }, 1000);
    if (e.dirty) scheduleSave(e);
  }
  function examQuestion(q, i, e) {
    const answer = e.answers[q.id]; let field = '';
    if (q.kind === 'choice' || q.kind === 'multi') {
      field = '<div class="options-list">' + (q.options || []).map(function (o, j) {
        const letter = String.fromCharCode(65 + j); const checked = q.kind === 'multi' ? Array.isArray(answer) && answer.indexOf(letter) >= 0 : String(answer || '').toUpperCase() === letter;
        return '<label class="option"><input type="' + (q.kind === 'multi' ? 'checkbox' : 'radio') + '" name="q-' + esc(q.id) + '" data-answer="' + esc(q.id) + '" data-kind="' + esc(q.kind) + '" value="' + letter + '"' + (checked ? ' checked' : '') + '><span class="option-letter">' + letter + '</span><span>' + esc(o) + '</span></label>';
      }).join('') + '</div>';
    } else if (q.kind === 'number') {
      field = '<input class="answer-input" type="text" autocomplete="off" data-answer="' + esc(q.id) + '" data-kind="number" aria-label="' + esc(q.label || i + 1) + ' 题答案" value="' + esc(answer == null ? '' : answer) + '" placeholder="输入答案"><div class="input-meta"><span>请按题目要求填写准确答案。</span></div><div class="print-answer-lines short-lines"></div>';
    } else {
      const text = answer == null ? '' : String(answer);
      field = '<textarea class="answer-textarea ' + (q.kind === 'essay' ? 'essay' : '') + '" data-answer="' + esc(q.id) + '" data-kind="' + esc(q.kind) + '" aria-label="' + esc(q.label || i + 1) + ' 题答案" placeholder="' + (q.kind === 'essay' ? '在这里完成你的作文…' : '写下完整的思路和答案…') + '">' + esc(text) + '</textarea><div class="input-meta"><span>可用文字、公式或计算过程作答。</span><span id="words-' + esc(q.id) + '">' + esc(text.replace(/\s/g, '').length) + ' 字符</span></div><div class="print-answer-lines ' + (q.kind === 'essay' ? 'essay-lines' : '') + '"></div>';
    }
    return '<article class="card question-card" id="question-' + esc(q.id) + '"><div class="question-heading"><div class="q-label"><span class="q-number">' + esc(q.label || i + 1) + '</span><span>' + esc(kindName(q.kind)) + '</span><span class="q-points">' + esc(q.points) + ' 分</span></div><button class="flag-btn' + (e.flags.has(q.id) ? ' flagged' : '') + '" data-action="flag" data-id="' + esc(q.id) + '" aria-pressed="' + e.flags.has(q.id) + '">' + (e.flags.has(q.id) ? '◆ 已标记' : '◇ 待回看') + '</button></div>' + questionBody(q) + field + '</article>';
  }
  function navigationDots(qs, e) {
    let last = null;
    return qs.map(function (q, i) { let h = ''; if ((q.section || '试题') !== last) { if (last !== null) h += '</div>'; last = q.section || '试题'; h += '<div class="nav-section">' + esc(last) + '</div><div class="question-dots">'; } return h + '<button class="question-dot' + (hasAnswer(e.answers[q.id]) ? ' answered' : '') + (e.flags.has(q.id) ? ' flagged' : '') + '" data-action="jump" data-id="' + esc(q.id) + '" aria-label="跳到第 ' + esc(q.label || i + 1) + ' 题">' + esc(q.label || i + 1) + '</button>'; }).join('') + '</div>';
  }
  function updateExamProgress(e) {
    if (!state.route.startsWith('exam/' + e.id)) return;
    const qs = e.data.questions || []; const count = qs.filter(function (q) { return hasAnswer(e.answers[q.id]); }).length;
    if ($('#answer-progress')) $('#answer-progress').textContent = count + ' / ' + qs.length + ' 道已作答';
    if ($('#answer-progress-bar')) $('#answer-progress-bar').style.width = (qs.length ? count / qs.length * 100 : 0) + '%';
    if ($('#question-navigation')) $('#question-navigation').innerHTML = navigationDots(qs, e);
  }
  function updateSaveState(e) {
    if (!state.route.startsWith('exam/' + e.id)) return;
    const el = $('#save-state'); if (!el) return;
    el.classList.toggle('failed', !!e.error || e.localFailure);
    el.textContent = e.error ? '保存失败，草稿在本机，正在重试' : e.localFailure ? '浏览器草稿不可用，请保持连接' : e.savePromise ? '正在保存…' : e.dirty ? '已写入本机草稿' : e.lastSaved ? '已保存 ' + e.lastSaved : '草稿已载入';
    el.title = e.error || '';
  }
  function scheduleSave(e) { clearTimeout(saveTimer); updateSaveState(e); saveTimer = setTimeout(function () { saveDraft(e).catch(function () {}); }, 700); }
  async function saveDraft(e) {
    clearTimeout(saveTimer);
    if (e.savePromise) return e.savePromise;
    e.savePromise = (async function () {
      while (e.dirty && !e.submitting) {
        const version = e.version; const snapshot = clone(e.answers); const flags = Array.from(e.flags);
        try {
          await api('/api/attempts/' + encodeURIComponent(e.id) + '/answers', { method: 'PUT', body: { answers: snapshot, flags: flags } });
          e.error = ''; e.lastSaved = new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
          if (version === e.version) e.dirty = false;
        } catch (err) {
          e.error = err.message;
          if (err.status === 409) { e.dirty = false; if (state.route.startsWith('exam/' + e.id)) nav('review/' + e.id); }
          else setTimeout(function () { if (!e.submitting && e.dirty) saveDraft(e).catch(function () {}); }, 5000);
          throw err;
        }
        updateSaveState(e);
      }
    })();
    updateSaveState(e);
    try { await e.savePromise; } finally { e.savePromise = null; updateSaveState(e); }
  }
  function changedAnswer(input) {
    const e = state.exam; if (!e || e.submitting || !state.route.startsWith('exam/' + e.id)) return;
    const id = input.dataset.answer;
    if (input.dataset.kind === 'multi') e.answers[id] = $$('[data-answer]').filter(function (x) { return x.dataset.answer === id && x.checked; }).map(function (x) { return x.value; });
    else e.answers[id] = input.value;
    const count = document.getElementById('words-' + id); if (count) count.textContent = String(input.value || '').replace(/\s/g, '').length + ' 字符';
    e.dirty = true; e.version++; persistExam(e); updateExamProgress(e); scheduleSave(e);
  }
  function updateTimer(e) {
    if (e.submitting || !state.route.startsWith('exam/' + e.id)) return;
    const left = Math.max(0, Math.ceil((new Date(e.data.attempt.deadline).getTime() - Date.now() - e.offset) / 1000));
    const el = $('#exam-timer'); if (el) { el.textContent = String(Math.floor(left / 3600)).padStart(2, '0') + ':' + String(Math.floor(left % 3600 / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0'); el.classList.toggle('urgent', left < 300); }
    if (!left) { clearInterval(state.examTimer); submitExam(true).catch(function (err) { toast(err.message, true); state.examTimer = setInterval(function () { updateTimer(e); }, 5000); }); }
  }
  async function submitExam(expired) {
    const e = state.exam; if (!e || e.submitting) return;
    const qs = e.data.questions || []; const unanswered = qs.filter(function (q) { return !hasAnswer(e.answers[q.id]); }).length;
    if (!expired && !await modal('提交这份试卷？', (unanswered ? '还有 ' + unanswered + ' 道题未作答。\n' : '所有题目已作答。\n') + '交卷后不能继续修改作答；成绩公布后可查看分数、参考答案和解析。', { confirm: '确认交卷' })) return;
    clearTimeout(saveTimer);
    if (e.savePromise) { try { await e.savePromise; } catch (_) {} }
    e.submitting = true; persistExam(e); $$('[data-answer], [data-action="submit"]').forEach(function (el) { el.disabled = true; });
    if ($('#save-state')) $('#save-state').textContent = '正在交卷…';
    try {
      const d = await api('/api/attempts/' + encodeURIComponent(e.id) + '/submit', { method: 'POST', body: { answers: clone(e.answers), flags: Array.from(e.flags), ai_grade: false } });
      e.submitted = true; localRemove('draft-' + e.id); e.dirty = false; state.overview = null;
      if (d.job_id) watchJob(d.job_id, 'grade', e.id);
      toast(expired ? '考试时间已到，试卷已自动提交。' : '交卷完成，可在答卷页面查看阅卷进度。'); nav('review/' + e.id);
    } catch (err) { e.submitting = false; e.error = err.message; $$('[data-answer], [data-action="submit"]').forEach(function (el) { el.disabled = false; }); updateSaveState(e); throw err; }
  }
  async function renderHistory(serial) {
    await overview();
    const d = await api('/api/attempts'); if (serial !== state.routeSerial) return;
    state.history = d.attempts || [];
    main.innerHTML = '<div class="page-head"><div><div class="eyebrow">YOUR PROGRESS</div><h1>每一步，都有记录。</h1><p>重新打开答卷，回顾解题过程，也看看那些需要再练一次的题。</p></div><a class="btn btn-primary" href="#home">开始新的练习 →</a></div><div class="filter-row"><select id="history-subject" aria-label="按科目筛选"><option value="">全部科目</option>' + (state.overview.subjects || []).map(function (s) { return '<option value="' + esc(s.code) + '">' + esc(s.name) + '</option>'; }).join('') + '</select><select id="history-status" aria-label="按状态筛选"><option value="">全部状态</option><option value="active">进行中</option><option value="pending">待阅卷 / 待公布</option><option value="done">已完成</option></select><span class="small muted">成绩由教师完成阅卷后公布。</span></div><div class="card table-wrap" id="history-table"></div>';
    renderHistoryTable();
  }
  function renderHistoryTable() {
    const subject = $('#history-subject').value; const status = $('#history-status').value;
    const list = (state.history || []).filter(function (a) { return (!subject || a.subject_code === subject) && (!status || status === 'active' && active(a) || status === 'pending' && !active(a) && (ADMIN ? a.pending_manual : !a.released) || status === 'done' && !active(a) && (ADMIN ? !a.pending_manual : a.released)); });
    $('#history-table').innerHTML = list.length ? '<table class="data-table"><thead><tr><th>试卷 / 科目</th><th>开始时间</th><th>状态</th><th>成绩</th><th>操作</th></tr></thead><tbody>' + list.map(function (a) {
      return '<tr><td class="title-cell">' + esc(a.paper_title || '模拟练习') + '<small>' + esc(a.subject_name || subjectName(a.subject_code)) + ' · ' + esc(a.student_name || '同学') + '</small></td><td>' + esc(dateLabel(a.started_at)) + '</td><td>' + badge(a) + '</td><td>' + (active(a) ? '<span class="muted">—</span>' : !ADMIN && !a.released ? '<span class="muted">待公布</span>' : '<span class="table-score">' + esc(number(a.total_score)) + '<small>/ ' + esc(a.max_score) + (a.pending_manual ? '（暂计）' : '') + '</small></span>') + '</td><td><div class="actions">' + (active(a) ? '<a class="btn btn-small" href="#exam/' + esc(a.id) + '">继续考试</a>' : '<a class="btn btn-small" href="#review/' + esc(a.id) + '">答卷复盘</a><a class="btn btn-ghost btn-small" href="#review/' + esc(a.id) + '/wrong">看错题</a>') + '</div></td></tr>';
    }).join('') + '</tbody></table>' : '<div class="empty"><h3>这里还没有符合条件的练习</h3>完成一份试卷后，就能在这里回看答卷。</div>';
  }
  function isManual(q) { return !!q.manual || q.kind === 'essay' || q.kind === 'text'; }
  function isWrong(q, r) { return r && r.score != null && Number(r.score) < Number(q.points); }
  async function renderReview(id, serial) {
    const d = await api('/api/attempts/' + encodeURIComponent(id)); if (serial !== state.routeSerial) return;
    if (active(d.attempt)) { nav('exam/' + id); return; }
    if (!ADMIN && !d.attempt.released) {
      const busy = ['queued','running'].includes(d.grading_status);
      const title = busy ? '正在自动阅卷' : d.grading_status === 'failed' ? '阅卷待处理' : '等待教师公布成绩';
      main.innerHTML = '<section class="card card-pad"><div class="eyebrow">已交卷</div><h1>' + title + '</h1><p>' + (busy ? '答案已保存，正在排队或评阅。启用自动公布时，评分完成后会自动显示成绩。此页会自动更新，也可以稍后在考试记录中查看。' : d.grading_status === 'failed' ? '答案已保存。自动阅卷暂未完成，请联系教师处理。' : '教师公布后即可查看分数、参考答案和解析。') + '</p><a class="btn btn-primary" href="#history">返回考试记录</a></section>';
      clearTimeout(state.examTimer);
      if (busy) state.examTimer = setTimeout(function () { if (serial === state.routeSerial) renderReview(id, serial).catch(function(err){ toast(err.message,true); }); }, 8000);
      return;
    }
    state.review = d; const a = d.attempt; const p = d.paper; const qs = d.questions || []; const responses = d.responses || {};
    state.gradeDrafts = localGet('grades-' + a.id) || {};
    const scored = qs.filter(function (q) { return responses[q.id] && responses[q.id].score != null; });
    const correct = scored.filter(function (q) { return Number(responses[q.id].score) >= Number(q.points); }).length;
    const wrong = scored.length - correct; const pending = qs.length - scored.length;
    const manualQs = qs.filter(isManual); const pendingManual = a.pending_manual == null ? pending : a.pending_manual;
    main.innerHTML = '<div class="page-head"><div><div class="eyebrow">REFLECT & IMPROVE</div><h1>完成了，现在认真复盘。</h1><p>' + esc(p.title) + ' · ' + esc(a.student_name || '同学') + ' · 交卷时间 ' + esc(fullDate(a.submitted_at)) + '</p></div><div class="head-actions"><button class="btn" data-action="print">打印答卷复盘</button><a class="btn" href="#history">考试记录</a></div></div>' +
      '<section class="card result-hero"><div><div class="eyebrow">' + (pendingManual ? '等待主观题阅卷' : '本次练习成绩') + '</div><h2>' + (pendingManual ? '客观题已判分，主观题等待评价。' : '每一道题，都是一次学习的机会。') + '</h2><p>' + (pendingManual ? '下面可按评分标准手动阅卷，也可以使用 AI 给出评分与改进建议。' : '对照参考答案和解析，回顾失分原因，再有针对性地练习。') + '</p><div class="actions">' + (ADMIN && manualQs.length ? '<button class="btn btn-primary" data-action="ai-grade" data-id="' + esc(a.id) + '"' + (!state.ai.configured || !pendingManual ? ' disabled' : '') + '>✧ AI 阅卷</button><button class="btn" data-action="jump-manual">手动阅卷 ↓</button>' : '<span class="pill pill-green">客观题已自动评分</span>') + '</div></div><div class="result-score"><strong>' + esc(number(a.total_score)) + '</strong><small> / ' + esc(a.max_score) + '</small><div class="score-caption">' + (pendingManual ? '暂计成绩 · 还有 ' + esc(pendingManual) + ' 道主观题' : '书面模拟成绩') + '</div></div></section>' +
      '<div class="result-stats"><div class="card"><span>客观题得分</span><strong>' + esc(number(a.auto_score)) + '<small>分</small></strong></div><div class="card"><span>主观题已评得分</span><strong>' + esc(number(a.manual_score)) + '<small>分</small></strong></div><div class="card"><span>已评分题目中满分</span><strong>' + correct + '<small>道</small></strong></div><div class="card"><span>已评分题目中失分</span><strong>' + wrong + '<small>道</small></strong></div></div>' +
      (!state.ai.configured && ADMIN && manualQs.length ? '<div class="notice warn">AI 阅卷尚未启用。教师可在项目的 .env.local 配置 API key 后刷新页面；现在仍可对照评分标准手动阅卷。</div>' : '<div class="notice">AI 评分会参考题目、参考答案和评分标准。主观题、作文和开放性答案请由教师复核；可以在下方修订评分。</div>') +
      '<div id="review-job-host"></div><div class="filter-row"><button class="btn btn-small ' + (reviewFilter === 'all' ? 'btn-primary' : '') + '" data-action="review-filter" data-filter="all">全部题目 ' + qs.length + '</button><button class="btn btn-small ' + (reviewFilter === 'wrong' ? 'btn-primary' : '') + '" data-action="review-filter" data-filter="wrong">失分题目 ' + wrong + '</button><button class="btn btn-small ' + (reviewFilter === 'pending' ? 'btn-primary' : '') + '" data-action="review-filter" data-filter="pending">待评分 ' + pending + '</button></div>' +
      printHeader(p, a.student_name) + '<div id="review-questions"></div>' + (ADMIN && manualQs.length ? '<div class="sticky-grade-actions"><span>修改主观题得分和评语后，点击保存。空白得分保持原评分。</span><button class="btn btn-primary" data-action="save-grades">保存手动评分</button></div>' : '') + '<div class="source-box">' + esc(p.source_note || '原创模拟题；评分仅作学习参考。') + '</div>';
    if (ADMIN && d.scan_id) main.insertAdjacentHTML('afterbegin','<div class="notice">纸质答卷 · <a class="btn" href="#scan/' + esc(d.scan_id) + '">查看照片与核对结果</a></div>');
    if (ADMIN) main.insertAdjacentHTML('afterbegin','<div class="notice"><strong>' + (a.released ? '成绩已公布，学生可以查看答案和解析。' : '成绩尚未公布，学生无法查看分数和答案。') + '</strong> <button class="btn" data-action="release" data-id="' + esc(a.id) + '">' + (a.released ? '撤回公布' : '公布成绩与解析') + '</button></div>');
    if (!ADMIN) { const n = $('.notice',main); if(n) n.textContent = '成绩已由教师公布，可对照参考答案复盘。'; }
    renderReviewQuestions(); renderJobHosts();
  }
  function renderReviewQuestions() {
    const d = state.review; if (!d || !$('#review-questions')) return;
    const qs = (d.questions || []).filter(function (q) { const r = (d.responses || {})[q.id]; return reviewFilter === 'all' || reviewFilter === 'wrong' && isWrong(q, r) || reviewFilter === 'pending' && (!r || r.score == null); });
    $('#review-questions').innerHTML = qs.length ? sectionBlocks(qs, function (q) {
      const originalIndex = d.questions.findIndex(function (x) { return x.id === q.id; });
      const r = (d.responses || {})[q.id] || {};
      const draft = (state.gradeDrafts || {})[q.id];
      const status = r.score == null ? '<span class="pill pill-amber">待评分</span>' : Number(r.score) >= Number(q.points) ? '<span class="pill pill-green">' + esc(number(r.score)) + ' / ' + esc(q.points) + ' 分</span>' : '<span class="pill pill-rose">' + esc(number(r.score)) + ' / ' + esc(q.points) + ' 分</span>';
      let result = '<article class="card question-card review-card" id="question-' + esc(q.id) + '"><div class="question-heading"><div class="q-label"><span class="q-number">' + esc(q.label || originalIndex + 1) + '</span><span>' + esc(kindName(q.kind)) + '</span></div>' + status + '</div>' + questionBody(q);
      if ((q.options || []).length) result += '<div class="options-list">' + q.options.map(function (o, i) { return '<div class="option"><span class="option-letter">' + String.fromCharCode(65 + i) + '</span><span>' + esc(o) + '</span></div>'; }).join('') + '</div>';
      result += '<div class="review-answer"><div class="answer-box student"><h4>你的作答</h4><p>' + esc(answerText(r.answer)) + '</p></div><div class="answer-box"><h4>参考答案</h4><p>' + esc(answerText(q.answer)) + '</p></div></div>';
      if (q.explanation) result += '<div class="rubric-box"><strong>解析与思路</strong>' + esc(q.explanation) + '</div>';
      if (q.rubric) result += '<div class="rubric-box"><strong>评分标准 · 满分 ' + esc(q.points) + ' 分</strong>' + esc(q.rubric) + '</div>';
      if (r.feedback) result += '<div class="feedback-box"><strong>' + (r.grader === 'ai' ? 'AI 评语' : r.grader === 'manual' ? '人工评语' : '评分反馈') + '</strong>\n' + esc(r.feedback) + '</div>';
      if (r.ai_feedback && r.ai_feedback !== r.feedback) result += '<div class="feedback-box ai-feedback"><strong>AI 评分建议' + (r.ai_score != null ? ' · ' + esc(number(r.ai_score)) + ' 分' : '') + '</strong>\n' + esc(r.ai_feedback) + '</div>';
      if (ADMIN && isManual(q)) result += '<div class="manual-grade" data-manual-question="' + esc(q.id) + '"><label><span class="form-label">得分 / ' + esc(q.points) + '</span><input type="number" min="0" max="' + esc(q.points) + '" step="0.5" data-grade-score="' + esc(q.id) + '" value="' + esc(draft ? draft.score : r.score == null ? '' : r.score) + '" placeholder="待评分" aria-label="第 ' + esc(q.label || originalIndex + 1) + ' 题得分"></label><label><span class="form-label">评语与改进建议</span><textarea data-grade-feedback="' + esc(q.id) + '" placeholder="写下具体的失分点或改进建议…">' + esc(draft ? draft.feedback : r.feedback || '') + '</textarea></label></div>';
      return result + '</article>';
    }) : '<div class="card empty"><h3>' + (reviewFilter === 'wrong' ? '暂时没有已评分的失分题' : '这里没有待评分的题目') + '</h3>可切换到全部题目查看完整答卷。</div>';
  }
  async function saveGrades() {
    const scores = {}; const d = state.review; if (!d) return;
    Object.keys(state.gradeDrafts || {}).forEach(function (id) {
      const draft = state.gradeDrafts[id];
      if (String(draft.score).trim() === '') return; const q = d.questions.find(function (x) { return x.id === id; }); if (!q) return; const score = Number(draft.score);
      if (!Number.isFinite(score) || score < 0 || score > Number(q.points)) throw new Error('第 ' + (q.label || '') + ' 题得分应在 0 与 ' + q.points + ' 分之间。');
      scores[id] = { score: score, feedback: draft.feedback || '' };
    });
    if (!Object.keys(scores).length) { toast('请先填写至少一道题的得分。', true); return; }
    await api('/api/attempts/' + encodeURIComponent(d.attempt.id) + '/grade', { method: 'POST', body: { scores: scores } }); localRemove('grades-' + d.attempt.id); state.gradeDrafts = {}; state.overview = null; toast('评分已保存。'); await renderReview(d.attempt.id, state.routeSerial);
  }
  async function aiGrade(id) {
    if (!state.ai.configured) { toast('请先在 .env.local 配置 API key 并刷新页面。', true); return; }
    if (!await modal('使用 AI 阅卷？', '本次答卷中的主观题、作答内容和评分标准将发送到配置的 AI 服务，用于生成评分与学习建议。评分结果请复核。', { confirm: '开始 AI 阅卷' })) return;
    const d = await api('/api/attempts/' + encodeURIComponent(id) + '/ai-grade', { method: 'POST', body: {} }); watchJob(d.job_id, 'grade', id); toast('AI 正在阅卷，完成后会显示评分与评语。');
  }
  function persistJobs() { localSet('jobs', Object.values(state.jobs).filter(function (j) { return j.status === 'queued' || j.status === 'running'; }).map(function (j) { return { id: j.id, localType: j.localType, target: j.target }; })); }
  function jobHtml(j) {
    const failed = j.status === 'failed'; const done = j.status === 'completed'; let action = '';
    if (done && j.result && j.result.scan_id) action = '<a class="btn btn-primary btn-small" href="#scan/' + esc(j.result.scan_id) + '">核对照片识别结果 →</a>';
    if (done && j.result && j.result.paper_id) action = '<a class="btn btn-primary btn-small" href="#editor/' + esc(j.result.paper_id) + '">查看并审核新试卷 →</a>';
    if (done && j.result && j.result.attempt_id) action = '<a class="btn btn-primary btn-small" href="#review/' + esc(j.result.attempt_id) + '">查看阅卷结果 →</a>';
    return '<section class="job-card"><div class="card-title-row"><h3>' + (j.localType === 'ocr' ? '答卷照片识别' : j.localType === 'grade' ? 'AI 阅卷' : 'AI 出题') + '</h3><span class="pill ' + (failed ? 'pill-rose' : done ? 'pill-green' : 'pill-amber') + '">' + (failed ? '未完成' : done ? '已完成' : '进行中') + '</span></div><p>' + esc(failed ? j.error || j.message || '任务失败，请检查 AI 配置后重试。' : j.message || '任务已加入队列…') + '</p>' + (!failed && !done ? '<div class="progress-bar"><span style="width:' + Math.min(100, Math.max(0, Number(j.progress) || 0)) + '%"></span></div>' : '') + action + '</section>';
  }
  function renderJobHosts() {
    const adminHost = $('#admin-job-host'); if (adminHost) adminHost.innerHTML = Object.values(state.jobs).filter(function (j) { return j.localType !== 'grade'; }).slice(-3).map(jobHtml).join('');
    const reviewHost = $('#review-job-host'); if (reviewHost && state.review) reviewHost.innerHTML = Object.values(state.jobs).filter(function (j) { return j.localType === 'grade' && j.target === state.review.attempt.id; }).slice(-2).map(jobHtml).join('');
  }
  function watchJob(id, type, target) {
    if (!id) return; if (state.jobs[id] && state.jobs[id].polling) return;
    state.jobs[id] = Object.assign(state.jobs[id] || {}, { id: id, localType: type, target: target, status: 'queued', polling: true, progress: 0 }); persistJobs(); renderJobHosts();
    async function poll() {
      const j = state.jobs[id]; if (!j) return;
      try {
        const data = await api('/api/jobs/' + encodeURIComponent(id)); const incoming = data.job || data;
        Object.assign(j, incoming); renderJobHosts(); persistJobs();
        if (j.status === 'completed' || j.status === 'failed') {
          j.polling = false; persistJobs(); state.overview = null;
          if (j.status === 'completed') {
            toast(type === 'ocr' ? '照片识别完成，请核对答案。' : type === 'grade' ? 'AI 阅卷完成，请查看并复核评分。' : '新试卷已生成草稿，请审核后发布。');
            if (type === 'grade' && state.route.startsWith('review/' + target)) await renderReview(target, state.routeSerial);
            else if (type !== 'grade' && state.route === 'admin') await renderAdmin(state.routeSerial);
          }
          return;
        }
        setTimeout(poll, 1800);
      } catch (err) {
        if (err.status === 401) { j.polling = false; return; }
        if (err.status === 404) { j.status = 'failed'; j.polling = false; j.error = '任务记录不存在，服务可能已重启。请重新提交任务。'; persistJobs(); renderJobHosts(); return; }
        j.message = err.message + ' 正在重试…'; renderJobHosts(); setTimeout(poll, 5000);
      }
    }
    poll();
  }
  function aiStatusHtml() {
    return '<div class="ai-status' + (state.ai.configured ? '' : ' off') + '"><span class="status-dot"></span>' + (state.ai.configured ? 'AI 已配置 · ' + esc(state.ai.model || '已配置模型') + ' · Flex' : '等待填写 key · ' + esc(state.ai.model || 'gpt-6-luna')) + '</div>';
  }
  async function renderAdmin(serial) {
    await overview();
    const results = await Promise.all([api('/api/papers?all=1'), api('/api/ai/status'), api('/api/admin/grading-settings')]); if (serial !== state.routeSerial) return;
    state.adminPapers = results[0].papers || []; state.ai = results[1];
    const papers = state.adminPapers; const templates = papers.filter(function (p) { return p.status !== 'archived'; });
    main.innerHTML = '<div class="page-head"><div><div class="eyebrow">TEACHER DESK</div><h1>给练习，添一点针对性。</h1><p>维护题目、调整知识范围，或用 AI 生成一套新题。生成的新卷先保存为草稿，审核后再给学生作答。</p></div><button class="btn btn-primary" data-action="new-paper">＋ 新建试卷</button></div><div class="admin-grid"><section class="card ai-card"><h2>✧ AI 一键出题</h2><p>以已有试卷为结构模板，保持科目、考试时间、题型和分值分布；按你填写的范围生成原创题目。</p>' + aiStatusHtml() +
      '<form id="generator-form" class="generator-form"><label><span class="form-label">结构模板</span><select name="template_id" id="generation-template" required>' + templates.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.title) + (p.status === 'draft' ? '（草稿）' : '') + '</option>'; }).join('') + '</select></label><label><span class="form-label">知识范围</span><textarea name="scope" id="generation-scope" required placeholder="例如：二次函数、圆的基本性质，侧重应用题…">' + esc(templates[0] ? templates[0].scope : '') + '</textarea></label><div class="two-columns"><label><span class="form-label">新卷标题</span><input name="title" placeholder="留空沿用模板标题" maxlength="120"></label><label><span class="form-label">难度</span><select name="difficulty"><option value="标准">标准 · 按中考梯度</option><option value="基础">基础 · 巩固知识</option><option value="提高">提高 · 综合应用</option></select></label></div><button class="btn btn-primary" type="submit"' + (!state.ai.configured || !templates.length ? ' disabled' : '') + '>生成新试卷草稿 →</button>' + (!state.ai.configured ? '<span class="form-help">请在服务器配置文件中填写 API key 后刷新页面。密钥只保存在服务器端。</span>' : '<span class="form-help">新题需检查题意、答案与评分标准，审核后再发布。</span>') + '</form></section>' +
      '<section class="card card-pad"><h2>从草稿，到一份好试卷</h2><div class="method-step"><b>1</b><div><h3>维护结构</h3><p>选择科目和分值结构，手动编辑题目、参考答案与评分标准。</p></div></div><div class="method-step"><b>2</b><div><h3>认真审核</h3><p>检查题意是否明确，知识范围是否合适，计算结果与参考答案是否正确。</p></div></div><div class="method-step"><b>3</b><div><h3>发布与阅卷</h3><p>发布后可开始考试；交卷后支持客观题自动判分、AI 阅卷与人工修订。</p></div></div><div class="notice small" style="margin-top:19px;margin-bottom:0">考试会保存试卷快照。之后修改题库，不会改变已经开始的考试和历史答卷。</div></section></div><div id="admin-job-host"></div>' +
      '<div class="section-heading"><h2>试卷与题库</h2><span>共 ' + papers.length + ' 份试卷</span></div><div class="filter-row"><select id="admin-subject" aria-label="按科目筛选"><option value="">全部科目</option>' + (state.overview.subjects || []).map(function (s) { return '<option value="' + esc(s.code) + '">' + esc(s.name) + '</option>'; }).join('') + '</select><select id="admin-status" aria-label="按发布状态筛选"><option value="">全部状态</option><option value="published">已发布</option><option value="draft">草稿</option></select></div><div class="card table-wrap" id="admin-paper-table"></div>' + sourceNotice();
    main.insertAdjacentHTML('afterbegin', '<section class="card grading-settings"><header class="grading-settings-heading"><h2>交卷后自动处理</h2><p>设置阅卷与成绩公布方式</p></header><form id="grading-settings-form"><label class="grading-setting-row"><span class="grading-setting-copy"><strong>自动 AI 阅卷</strong><small>学生交卷后，自动评阅尚未评分的主观题。</small></span><input class="grading-toggle" type="checkbox" role="switch" name="auto_grade" aria-label="交卷后自动 AI 阅卷"' + (results[2].auto_grade ? ' checked' : '') + '></label><label class="grading-setting-row"><span class="grading-setting-copy"><strong>自动公布成绩</strong><small>全部题目评分完成后，向学生开放成绩、答案和解析。</small></span><input class="grading-toggle" type="checkbox" role="switch" name="auto_release" aria-label="全部评分完成后自动公布成绩"' + (results[2].auto_release ? ' checked' : '') + '></label><div class="grading-settings-footer"><p>设置对之后交卷的试卷生效，已排队任务保留原设置。<br>AI 阅卷失败时不会公布不完整成绩，教师可复核或撤回成绩。</p><button class="btn btn-primary" type="submit">保存设置</button></div></form></section>');
    $('#grading-settings-form').onsubmit = async function(event) {
      event.preventDefault(); event.stopPropagation(); const form=event.target; const button=form.querySelector('button'); button.disabled=true;
      try { await api('/api/admin/grading-settings',{method:'PUT',body:{auto_grade:form.elements.auto_grade.checked,auto_release:form.elements.auto_release.checked}}); toast('自动阅卷设置已保存。'); }
      catch(err) { toast(err.message,true); } finally { button.disabled=false; }
    };
    renderAdminTable(); renderJobHosts();
  }
  function renderAdminTable() {
    const s = $('#admin-subject').value; const status = $('#admin-status').value;
    const papers = (state.adminPapers || []).filter(function (p) { return (!s || p.subject_code === s) && (!status || p.status === status); });
    $('#admin-paper-table').innerHTML = papers.length ? '<table class="data-table"><thead><tr><th>试卷</th><th>科目 / 时间</th><th>题目 / 分值</th><th>状态</th><th>操作</th></tr></thead><tbody>' + papers.map(function (p) {
      return '<tr><td class="title-cell">' + esc(p.title) + '<small>' + esc(p.scope) + '</small></td><td>' + esc(subjectName(p.subject_code)) + '<br><small class="muted">' + esc(p.minutes) + ' 分钟</small></td><td>' + esc(p.question_count || 0) + ' 道 · ' + esc(p.max_score) + ' 分</td><td><span class="pill ' + (p.status === 'published' ? 'pill-green' : 'pill-amber') + '">' + (p.status === 'published' ? '已发布' : '草稿') + '</span></td><td><div class="actions"><a class="btn btn-small" href="#editor/' + esc(p.id) + '">编辑 / 审核</a>' + (p.status === 'published' ? '<a class="btn btn-ghost btn-small" href="#paper/' + esc(p.id) + '">预览</a>' : '<button class="btn btn-ghost btn-small" data-action="publish" data-id="' + esc(p.id) + '">发布</button>') + '<button class="btn btn-ghost btn-danger btn-small" data-action="delete-paper" data-id="' + esc(p.id) + '">归档</button></div></td></tr>';
    }).join('') + '</tbody></table>' : '<div class="empty"><h3>没有符合条件的试卷</h3>新建一份试卷，或调整筛选条件。</div>';
  }
  async function generatePaper(form) {
    if (!state.ai.configured) throw new Error('请先配置 AI 的 API key。');
    const f = new FormData(form); const body = { template_id: f.get('template_id'), scope: String(f.get('scope') || '').trim(), title: String(f.get('title') || '').trim(), difficulty: f.get('difficulty') };
    if (!body.template_id || !body.scope) throw new Error('请选择模板并填写知识范围。');
    const button = $('button[type="submit"]', form); button.disabled = true; button.textContent = '正在提交…';
    try { const d = await api('/api/ai/generate', { method: 'POST', body: body }); watchJob(d.job_id, 'generate', body.template_id); toast('已开始出题，新试卷完成后会保存为草稿。'); }
    finally { button.disabled = false; button.textContent = '生成新试卷草稿 →'; }
  }
  async function publishPaper(id) {
    if (!await modal('发布这份试卷？', '请确认题目、参考答案和评分标准已经审核。发布后，试卷会出现在科目练习页面。系统会检查总分和各部分分值。', { confirm: '发布试卷' })) return;
    await api('/api/admin/papers/' + encodeURIComponent(id) + '/publish', { method: 'POST', body: {} }); state.overview = null; toast('试卷已发布。');
    if (state.route.startsWith('editor/')) await renderEditor(id, state.routeSerial); else await renderAdmin(state.routeSerial);
  }
  async function deletePaper(id) {
    if (!await modal('归档这份试卷？', '归档后不再出现在题库列表和考试入口。已经开始的考试与历史答卷会继续保留。', { confirm: '确认归档', danger: true })) return;
    await api('/api/admin/papers/' + encodeURIComponent(id), { method: 'DELETE' }); state.overview = null; toast('试卷已归档。'); await renderAdmin(state.routeSerial);
  }
  function newId() { return window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : 'q-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }
  function newQuestion() {
    const e = state.editor; const first = e && e.paper.blueprint && e.paper.blueprint[0];
    return { id: newId(), label: String(e ? e.questions.length + 1 : 1), section: first ? first.section : '试题', kind: 'text', stem: '', passage: '', options: [], answer: '', points: 2, manual: true, rubric: '', explanation: '', tolerance: 0 };
  }
  function editorField(label, field, value, type, extra) {
    return '<label><span class="form-label">' + esc(label) + '</span><input data-q-field="' + esc(field) + '" type="' + esc(type || 'text') + '" value="' + esc(value == null ? '' : value) + '"' + (extra || '') + '></label>';
  }
  function editorTextarea(label, field, value, cls, hint) {
    return '<label><span class="form-label">' + esc(label) + '</span><textarea data-q-field="' + esc(field) + '" class="' + esc(cls || '') + '">' + esc(value == null ? '' : value) + '</textarea>' + (hint ? '<span class="form-help">' + esc(hint) + '</span>' : '') + '</label>';
  }
  function editorQuestion(q, i) {
    return '<section class="editor-question" data-editor-question="' + esc(q.id) + '"><div class="question-heading"><div class="q-label"><span class="q-number">' + String(i + 1).padStart(2, '0') + '</span><span>题目编辑</span><span class="q-points">' + esc(q.points) + ' 分</span></div><div class="actions"><button type="button" class="btn btn-ghost btn-small" data-action="move-question" data-index="' + i + '" data-direction="-1"' + (i === 0 ? ' disabled' : '') + ' aria-label="上移这道题">↑</button><button type="button" class="btn btn-ghost btn-small" data-action="move-question" data-index="' + i + '" data-direction="1"' + (i === state.editor.questions.length - 1 ? ' disabled' : '') + ' aria-label="下移这道题">↓</button><button type="button" class="btn btn-ghost btn-danger btn-small" data-action="remove-question" data-index="' + i + '">删除</button></div></div>' +
      '<div class="form-grid">' + editorField('卷面题号', 'label', q.label || i + 1) + editorField('所属部分（须与试卷分值结构一致）', 'section', q.section || '') +
      '<label><span class="form-label">题型</span><select data-q-field="kind">' + ['choice', 'multi', 'number', 'text', 'essay'].map(function (k) { return '<option value="' + k + '"' + (q.kind === k ? ' selected' : '') + '>' + kindName(k) + '</option>'; }).join('') + '</select></label>' + editorField('分值', 'points', q.points, 'number', ' min="0.5" step="0.5"') +
      '<div class="span-two">' + editorTextarea('题干', 'stem', q.stem, 'stem-edit') + '</div>' +
      '<div class="span-two">' + editorTextarea('材料 / 阅读文章（可选）', 'passage', q.passage, 'passage-edit') + '</div>' +
      '<div class="span-two">' + editorTextarea('选择题选项（每行一个，不必添加 A / B / C / D）', 'options', (q.options || []).join('\n'), '', '非选择题可留空。选项按行依次标为 A、B、C、D。') + '</div>' +
      '<div class="span-two">' + editorTextarea('参考答案', 'answer', Array.isArray(q.answer) ? JSON.stringify(q.answer) : q.answer, '', '单选填写 A / B / C / D，多选填写 ["A","C"]；主观题填写完整参考答案。') + '</div>' +
      '<div class="span-two">' + editorTextarea('评分标准', 'rubric', q.rubric, '', '主观题请写清每个评分要点及对应分值，便于 AI 和人工阅卷。') + '</div>' +
      '<div class="span-two">' + editorTextarea('解析与解题思路', 'explanation', q.explanation) + '</div>' +
      '<label class="check-label span-two"><input type="checkbox" data-q-field="manual"' + (isManual(q) ? ' checked' : '') + '>主观题评分（AI 或手动阅卷）</label></div>' +
      '<details class="editor-details"><summary>更多设置 · 配图、数值容差、多选部分分</summary><div class="form-grid">' + editorField('本地配图文件名（figures 文件夹）', 'figure', q.figure || '', 'text') + editorField('配图说明', 'figure_alt', q.figure_alt || '', 'text') + editorField('数值判分容差', 'tolerance', q.tolerance || 0, 'number', ' min="0" step="any"') + editorField('多选部分分（可选）', 'partial_credit', q.partial_credit == null ? '' : q.partial_credit, 'number', ' min="0" step="0.5"') + '</div></details></section>';
  }
  async function renderEditor(id, serial) {
    await overview();
    const subjects = state.overview.subjects || []; let p, qs;
    if (id === 'new') {
      const s = subjects[0] || {};
      p = { id: null, subject_code: s.code || '', title: '', scope: s.scope || '', minutes: s.minutes || 90, max_score: s.full_score || 100, status: 'draft', description: '', source_note: '原创模拟题，按北京中考书面考试结构编写。', blueprint: clone(s.blueprint || []) }; qs = [];
    } else { const d = await api('/api/admin/papers/' + encodeURIComponent(id)); if (serial !== state.routeSerial) return; p = d.paper; qs = d.questions || []; }
    const unsaved = localGet('editor-' + id); if (unsaved && unsaved.paper && Array.isArray(unsaved.questions)) { p = Object.assign(p, unsaved.paper); qs = unsaved.questions; }
    state.editor = { id: id, paper: clone(p), questions: clone(qs), dirty: !!unsaved };
    main.innerHTML = '<div class="page-head"><div><div class="eyebrow">QUESTION EDITOR</div><h1>' + (id === 'new' ? '从一份新试卷开始。' : '让每一道题，都值得练。') + '</h1><p>先保存草稿，再审核题意、答案与评分标准。发布前会检查总分和分值结构。</p></div><a class="btn" href="#admin">返回题库</a></div>' +
      (unsaved ? '<div class="notice warn">已恢复这台浏览器中的未保存编辑草稿。请检查内容后保存到题库。<button class="btn btn-ghost btn-small" data-action="discard-editor">放弃本机草稿，重新载入</button></div>' : '') +
      '<div class="editor-toolbar"><div><strong>' + (p.status === 'published' ? '已发布试卷' : '草稿试卷') + '</strong><div class="muted" id="editor-save-state">' + (unsaved ? '已恢复本机编辑草稿' : '修改后请保存') + '</div></div><div class="actions"><button class="btn" data-action="save-editor">' + (p.status === 'published' ? '保存修改' : '保存草稿') + '</button><button class="btn btn-primary" data-action="save-publish-editor">保存并发布 →</button>' + (id !== 'new' && p.status === 'published' ? '<a class="btn" href="#paper/' + esc(id) + '">预览</a>' : '') + '</div></div>' +
      '<form id="paper-editor"><section class="card editor-section"><h2>试卷信息与结构</h2><div class="form-grid"><label><span class="form-label">试卷标题</span><input name="title" value="' + esc(p.title) + '" required maxlength="120" placeholder="例如：九年级语文期中模拟卷（二）"></label><label><span class="form-label">科目</span><select name="subject_code" id="editor-subject">' + subjects.map(function (s) { return '<option value="' + esc(s.code) + '"' + (s.code === p.subject_code ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') + '</select></label><label><span class="form-label">考试时间（分钟）</span><input name="minutes" type="number" min="1" max="300" value="' + esc(p.minutes) + '" required></label><label><span class="form-label">试卷满分</span><input name="max_score" type="number" min="1" max="300" step="0.5" value="' + esc(p.max_score) + '" required></label><label class="span-two"><span class="form-label">知识范围</span><textarea name="scope" required>' + esc(p.scope) + '</textarea></label><label class="span-two"><span class="form-label">试卷说明</span><textarea name="description">' + esc(p.description || '') + '</textarea></label><label class="span-two"><span class="form-label">出处与规则说明</span><textarea name="source_note">' + esc(p.source_note || '') + '</textarea></label><label class="span-two"><span class="form-label">各部分分值结构</span><textarea name="blueprint" class="json-editor">' + esc(JSON.stringify(p.blueprint || [], null, 2)) + '</textarea><span class="form-help">格式：[{"section":"基础·运用","points":14}]。题目的所属部分名称须与这里一致。</span></label></div></section>' +
      '<div class="section-heading"><h2>逐题编辑</h2><button type="button" class="btn" data-action="add-question">＋ 添加题目</button></div><div id="editor-summary" class="editor-summary"></div><div id="editor-questions"></div><div class="actions" style="justify-content:center;margin:24px 0"><button type="button" class="btn" data-action="add-question">＋ 再添加一道题</button></div>' +
      '<details class="card editor-section editor-details"><summary>批量编辑题目 JSON（高级）</summary><p class="small muted">可导出当前题目，再按完整格式批量修改。导入会替换当前编辑中的题目，保存后才写入题库。</p><textarea id="questions-json" class="json-editor" aria-label="题目 JSON">' + esc(JSON.stringify(qs, null, 2)) + '</textarea><div class="actions" style="margin-top:13px"><button type="button" class="btn btn-small" data-action="export-questions">从编辑器导出到此处</button><button type="button" class="btn btn-small" data-action="import-questions">应用此处 JSON</button></div></details></form>';
    renderEditorQuestions();
  }
  function renderEditorQuestions() {
    const e = state.editor; if (!e || !$('#editor-questions')) return;
    $('#editor-questions').innerHTML = e.questions.length ? e.questions.map(editorQuestion).join('') : '<div class="card empty"><h3>第一道题，从这里开始</h3>点击“添加题目”，填写题干、答案和评分标准。</div>';
    updateEditorSummary();
  }
  function updateEditorSummary() {
    const e = state.editor; const el = $('#editor-summary'); if (!e || !el) return;
    let total = 0; $$('[data-q-field="points"]').forEach(function (input) { total += Number(input.value) || 0; });
    const max = $('#paper-editor [name="max_score"]');
    el.innerHTML = '<span>共 ' + e.questions.length + ' 道题 · 当前题目总分 ' + number(total) + ' 分</span><span>' + (max && Math.abs(total - Number(max.value)) < 0.001 ? '✓ 题目总分与试卷满分一致' : '发布前请确保题目总分与试卷满分一致') + '</span>';
  }
  function readEditor() {
    const e = state.editor; if (!e || !$('#paper-editor')) throw new Error('编辑器尚未加载。');
    const form = $('#paper-editor'); const f = new FormData(form);
    const paper = Object.assign({}, e.paper, { title: String(f.get('title') || '').trim(), subject_code: f.get('subject_code'), scope: String(f.get('scope') || '').trim(), minutes: Number(f.get('minutes')), max_score: Number(f.get('max_score')), description: String(f.get('description') || ''), source_note: String(f.get('source_note') || '') });
    try { paper.blueprint = JSON.parse(f.get('blueprint') || '[]'); } catch (_) { throw new Error('分值结构 JSON 格式有误，请检查括号和引号。'); }
    if (!Array.isArray(paper.blueprint)) throw new Error('分值结构应为 JSON 数组。');
    const questions = $$('[data-editor-question]').map(function (box, i) {
      const base = e.questions.find(function (x) { return x.id === box.dataset.editorQuestion; }) || {};
      const q = Object.assign({}, base, { id: box.dataset.editorQuestion }); const fields = {};
      $$('[data-q-field]', box).forEach(function (input) { fields[input.dataset.qField] = input.type === 'checkbox' ? input.checked : input.value; });
      Object.assign(q, fields); q.points = Number(fields.points); q.tolerance = Number(fields.tolerance) || 0; q.manual = !!fields.manual || q.kind === 'text' || q.kind === 'essay';
      q.options = String(fields.options || '').split(/\r?\n/).filter(function (o) { return o.trim() !== ''; });
      if (q.kind === 'multi') {
        try { q.answer = fields.answer.trim().startsWith('[') ? JSON.parse(fields.answer) : fields.answer.split(/[,，;；、\s]+/).filter(Boolean).map(function (v) { return v.toUpperCase(); }); }
        catch (_) { throw new Error('第 ' + (q.label || i + 1) + ' 题多选答案格式有误。'); }
        if (!Array.isArray(q.answer)) throw new Error('多选答案应为数组，例如 ["A","C"]。');
      } else {
        q.answer = fields.answer;
        if (Array.isArray(base.answer) && fields.answer.trim().startsWith('[')) {
          try { const parsed = JSON.parse(fields.answer); if (Array.isArray(parsed)) q.answer = parsed; } catch (_) { throw new Error('第 ' + (q.label || i + 1) + ' 题答案数组格式有误。'); }
        }
        if (q.kind === 'choice') q.answer = String(q.answer).trim().toUpperCase();
      }
      if (fields.partial_credit !== '') q.partial_credit = Number(fields.partial_credit); else delete q.partial_credit;
      if (!q.figure) { delete q.figure; delete q.figure_alt; }
      return q;
    });
    return { paper: paper, questions: questions };
  }
  function updateEditorLocal() {
    if (!state.editor || !$('#paper-editor')) return; state.editor.dirty = true;
    const label = $('#editor-save-state');
    try {
      const current = readEditor(); state.editor.paper = current.paper;
      localSet('editor-' + state.editor.id, current);
      if (label) label.textContent = '编辑草稿暂存在当前页面，关闭或刷新前请保存到题库';
    } catch (_) { if (label) label.textContent = '有未保存修改，请检查 JSON 格式'; }
    updateEditorSummary();
  }
  async function saveEditor(publish) {
    const e = state.editor; const current = readEditor(); const p = current.paper;
    if (!p.title || !p.scope) throw new Error('请填写试卷标题和知识范围。');
    if (!Number.isFinite(p.minutes) || p.minutes <= 0 || !Number.isFinite(p.max_score) || p.max_score <= 0) throw new Error('请填写有效的考试时间和满分。');
    if (current.questions.some(function (q) { return !q.stem || !q.section || !Number.isFinite(q.points) || q.points <= 0; })) throw new Error('每道题都需要填写题干、所属部分和有效分值。');
    const buttons = $$('[data-action="save-editor"],[data-action="save-publish-editor"],#paper-editor input,#paper-editor textarea,#paper-editor select,#paper-editor button');
    buttons.forEach(function (b) { b.dataset.preSaveDisabled = b.disabled ? '1' : '0'; b.disabled = true; });
    let savedId = e.id;
    try {
      const body = Object.assign({}, p, { questions: current.questions }); delete body.id; delete body.question_count; delete body.created_at;
      if (e.id === 'new') { const d = await api('/api/admin/papers', { method: 'POST', body: body }); savedId = d.id; }
      else await api('/api/admin/papers/' + encodeURIComponent(e.id), { method: 'PUT', body: body });
      localRemove('editor-' + e.id); e.dirty = false; state.overview = null; toast('试卷已保存到题库。');
      if (publish) {
        await api('/api/admin/papers/' + encodeURIComponent(savedId) + '/publish', { method: 'POST', body: {} }); toast('保存完成，试卷已发布。');
      }
      if (e.id === 'new') nav('editor/' + savedId); else await renderEditor(savedId, state.routeSerial);
    } catch (err) {
      if (e.id === 'new' && savedId !== 'new') { nav('editor/' + savedId); toast('草稿已保存，发布未完成：' + err.message, true); return; }
      throw err;
    } finally { buttons.forEach(function (b) { b.disabled = b.dataset.preSaveDisabled === '1'; delete b.dataset.preSaveDisabled; }); }
  }
  async function mutateQuestions(action, index, direction) {
    const e = state.editor; const current = readEditor(); e.paper = current.paper; e.questions = current.questions;
    if (action === 'add-question') e.questions.push(newQuestion());
    else if (action === 'remove-question') {
      if (!await modal('删除这道题？', '此操作会从当前编辑草稿中移除第 ' + (e.questions[index].label || index + 1) + ' 题。保存后才会修改题库中的试卷。', { confirm: '删除题目', danger: true })) return;
      e.questions.splice(index, 1);
    } else if (action === 'move-question') {
      const other = index + direction; if (other < 0 || other >= e.questions.length) return;
      const q = e.questions[index]; e.questions[index] = e.questions[other]; e.questions[other] = q;
    }
    renderEditorQuestions(); e.dirty = true; localSet('editor-' + e.id, { paper: e.paper, questions: e.questions });
    if ($('#editor-save-state')) $('#editor-save-state').textContent = '有未保存修改，关闭或刷新前请保存';
    if (action === 'add-question') { const cards = $$('[data-editor-question]'); const last = cards[cards.length - 1]; last.scrollIntoView({ behavior: 'smooth', block: 'center' }); $('[data-q-field="stem"]', last).focus({ preventScroll: true }); }
  }
  function syncSubjectDefaults() {
    const s = (state.overview.subjects || []).find(function (x) { return x.code === $('#editor-subject').value; }); if (!s) return;
    const form = $('#paper-editor'); $('[name="minutes"]', form).value = s.minutes; $('[name="max_score"]', form).value = s.full_score; $('[name="scope"]', form).value = s.scope;
    if (s.blueprint) $('[name="blueprint"]', form).value = JSON.stringify(s.blueprint, null, 2);
    updateEditorLocal();
  }
  document.addEventListener('click', async function (event) {
    const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
    const action = button.dataset.action; const id = button.dataset.id;
    if (button.tagName === 'BUTTON') event.preventDefault();
    try {
      if (action === 'logout') { await api('/api/auth/logout',{method:'POST',body:{}}); adminToken = ''; state.overview = null; state.review = null; state.editor = null; Object.keys(privateDrafts).forEach(function(k){delete privateDrafts[k];}); state.jobs = {}; await route(); }
      else if (action === 'release') { await api('/api/attempts/' + id + '/release',{method:'POST',body:{released:!state.review.attempt.released}}); state.overview=null; await renderReview(id,state.routeSerial); }
      else if (action === 'reload') await route();
      else if (action === 'start') { button.disabled = true; try { await startExam(id); } finally { button.disabled = false; } }
      else if (action === 'print') window.print();
      else if (action === 'new-paper') nav('editor/new');
      else if (action === 'submit') await submitExam(false);
      else if (action === 'flag') {
        const e = state.exam; if (!e || e.submitting) return;
        if (e.flags.has(id)) e.flags.delete(id); else e.flags.add(id);
        button.classList.toggle('flagged', e.flags.has(id)); button.textContent = e.flags.has(id) ? '◆ 已标记' : '◇ 待回看'; button.setAttribute('aria-pressed', e.flags.has(id));
        e.dirty = true; e.version++; persistExam(e); updateExamProgress(e); scheduleSave(e);
      } else if (action === 'jump') { const q = document.getElementById('question-' + id); if (q) q.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      else if (action === 'review-filter') {
        reviewFilter = button.dataset.filter;
        $$('[data-action="review-filter"]').forEach(function (b) { b.classList.toggle('btn-primary', b.dataset.filter === reviewFilter); }); renderReviewQuestions();
      } else if (action === 'jump-manual') { const q = $('[data-manual-question]'); if (q) q.scrollIntoView({ behavior: 'smooth', block: 'center' }); else toast('当前筛选结果没有主观题，请切换到全部题目。'); }
      else if (action === 'save-grades') { button.disabled = true; try { await saveGrades(); } finally { button.disabled = false; } }
      else if (action === 'ai-grade') { button.disabled = true; try { await aiGrade(id); } finally { button.disabled = false; } }
      else if (action === 'publish') await publishPaper(id);
      else if (action === 'delete-paper') await deletePaper(id);
      else if (action === 'save-editor' || action === 'save-publish-editor') await saveEditor(action === 'save-publish-editor');
      else if (['add-question', 'remove-question', 'move-question'].indexOf(action) >= 0) await mutateQuestions(action, Number(button.dataset.index), Number(button.dataset.direction));
      else if (action === 'export-questions') { $('#questions-json').value = JSON.stringify(readEditor().questions, null, 2); toast('当前题目已导出到 JSON 编辑框。'); }
      else if (action === 'import-questions') {
        let qs; try { qs = JSON.parse($('#questions-json').value); } catch (_) { throw new Error('题目 JSON 格式有误。'); }
        if (!Array.isArray(qs) || qs.some(function (q) { return !q || typeof q !== 'object' || Array.isArray(q); })) throw new Error('题目 JSON 应为题目对象组成的数组。');
        const current = readEditor(); const imported = qs.map(function (q, i) { return Object.assign({ id: newId(), label: String(i + 1), section: '试题', kind: 'text', stem: '', answer: '', points: 2, manual: true, options: [], rubric: '', explanation: '' }, q); });
        if (new Set(imported.map(function (q) { return q.id; })).size !== imported.length) throw new Error('导入的题目 id 有重复。');
        state.editor.paper = current.paper; state.editor.questions = imported;
        renderEditorQuestions(); state.editor.dirty = true; localSet('editor-' + state.editor.id, { paper: state.editor.paper, questions: state.editor.questions }); toast('JSON 已应用到编辑器，保存后写入题库。');
      } else if (action === 'discard-editor') { localRemove('editor-' + state.editor.id); await renderEditor(state.editor.id, state.routeSerial); }
    } catch (err) { toast(err.message || String(err), true); }
  });
  document.addEventListener('input', function (event) {
    if (event.target.matches('[data-answer]') && event.target.type !== 'radio' && event.target.type !== 'checkbox') changedAnswer(event.target);
    if (event.target.closest('#paper-editor') && !event.target.matches('#questions-json')) updateEditorLocal();
    if (event.target.matches('[data-grade-score],[data-grade-feedback]') && state.review) {
      const id = event.target.dataset.gradeScore || event.target.dataset.gradeFeedback;
      const box = event.target.closest('[data-manual-question]');
      state.gradeDrafts[id] = { score: $('[data-grade-score]', box).value, feedback: $('[data-grade-feedback]', box).value };
      localSet('grades-' + state.review.attempt.id, state.gradeDrafts);
    }
  });
  document.addEventListener('change', function (event) {
    if (event.target.matches('[data-answer]') && (event.target.type === 'radio' || event.target.type === 'checkbox')) changedAnswer(event.target);
    if (event.target.id === 'history-subject' || event.target.id === 'history-status') renderHistoryTable();
    if (event.target.id === 'admin-subject' || event.target.id === 'admin-status') renderAdminTable();
    if (event.target.id === 'generation-template') {
      const p = (state.adminPapers || []).find(function (x) { return x.id === event.target.value; }); if (p) $('#generation-scope').value = p.scope || '';
    }
    if (event.target.id === 'editor-subject') syncSubjectDefaults();
    else if (event.target.closest('#paper-editor')) updateEditorLocal();
  });
  document.addEventListener('submit', async function (event) {
    event.preventDefault();
    try { if (event.target.id === 'generator-form') await generatePaper(event.target); else if (event.target.id === 'paper-editor') await saveEditor(false); }
    catch (err) { toast(err.message, true); }
  });
  window.addEventListener('beforeunload', function (event) {
    if (state.exam && active(state.exam.data.attempt) && state.exam.dirty && !state.exam.submitting) { persistExam(state.exam); event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('online', function () { if (state.exam && state.exam.dirty && !state.exam.submitting) saveDraft(state.exam).catch(function () {}); });
  window.addEventListener('hashchange', route);
  $('#today').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
  Object.keys(localStorage).filter(function(k){return /^yixue-exam-(editor-|grades-|jobs$)/.test(k);}).forEach(function(k){localStorage.removeItem(k);});
  (ADMIN && localGet('jobs') || []).forEach(function (j) { watchJob(j.id, j.localType, j.target); });
  window.ExamUI = { api: api, state: state, main: main, esc: esc, nav: nav, toast: toast, modal: modal };
  window.ExamAccountUI = { api, esc, main, modal, toast, state, route,
    setStudent: function(s) { studentAccount=s; state.overview=null; state.exam=null; state.history=null; state.review=null; clearInterval(state.examTimer); clearTimeout(saveTimer); storagePrefix=s?'yixue-exam-student-'+s.id+'-':'yixue-exam-'; },
    admin: ADMIN };
  route();
})();
