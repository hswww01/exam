(function () {
  'use strict';
  const ui = () => window.ExamAccountUI;
  const field = (label, name, type, extra) => '<label class="form-label">' + label + '<input name="' + name + '" type="' + type + '" ' + (extra || '') + '></label>';
  const numberField = () => field('学号（8位数字）', 'username', 'text', 'required pattern="[0-9]{8}" minlength="8" maxlength="8" inputmode="numeric" autocomplete="username" placeholder="例如 24021912"');
  const passwordField = (label, name) => field(label, name, 'password', 'required minlength="8" maxlength="72" autocomplete="new-password"');
  function bindForm(id, fn) {
    const form = document.getElementById(id);
    form.onsubmit = async function (e) {
      e.preventDefault(); e.stopPropagation(); const button = form.querySelector('button[type="submit"]'); button.disabled = true;
      try { await fn(Object.fromEntries(new FormData(form))); }
      catch (err) { ui().toast(err.message, true); }
      finally { button.disabled = false; }
    };
  }
  function login(register) {
    const U = ui();
    const identity = document.getElementById('student-identity'); if (identity) identity.innerHTML = '';
    U.main.innerHTML = '<section class="card card-pad account-panel"><div class="eyebrow">学生账号</div><h1>' + (register ? '注册学生账号' : '欢迎回来') + '</h1><p>' + (register ? '填写学号和姓名，设置本考试系统的独立密码。' : '使用学号和你设置的考试密码登录。') + '</p><form id="student-login-form">' + numberField() + (register ? field('学生姓名', 'name', 'text', 'required maxlength="50" autocomplete="name"') : '') + field('密码', 'password', 'password', 'required minlength="8" maxlength="72" autocomplete="' + (register ? 'new-password' : 'current-password') + '"') + (register ? passwordField('确认密码', 'confirm_password') : '') + '<p class="small muted">密码至少8位。忘记密码请联系家长在后台重置。</p><button class="btn btn-primary" type="submit">' + (register ? '注册账号' : '登录') + '</button></form><button class="btn btn-ghost" id="account-switch" style="margin-top:16px">' + (register ? '已有账号，去登录' : '首次使用，注册账号') + '</button></section>';
    document.getElementById('account-switch').onclick = () => login(!register);
    bindForm('student-login-form', async data => {
      if (register) {
        await U.api('/api/student/register', { method: 'POST', body: data });
        U.toast('注册成功，请用学号和密码登录。'); login(false); return;
      }
      const result = await U.api('/api/student/login', { method: 'POST', body: data });
      U.setStudent(result.student); history.replaceState(null, '', '#home'); await U.route();
    });
  }
  function identity(s) {
    const U = ui(), el = document.getElementById('student-identity'); if (!el) return;
    el.innerHTML = '<div style="padding:16px 8px"><strong>' + U.esc(s.name) + '</strong><div class="small">学号：' + U.esc(s.username) + '</div><a href="#account">修改密码</a><button class="btn btn-small" id="student-logout">退出登录</button></div>';
    document.getElementById('student-logout').onclick = async () => {
      try {
        if (!await U.modal('退出学生账号？', '下次使用时需要重新登录。考试期间不能退出。')) return;
        await U.api('/api/student/logout', { method: 'POST', body: {} }); U.setStudent(null);
        history.replaceState(null, '', '#home'); await U.route();
      } catch (err) { U.toast(err.message, true); }
    };
  }
  function password() {
    const U = ui();
    U.main.innerHTML = '<section class="card card-pad account-panel"><h1>修改密码</h1><form id="student-password-form">' + field('原密码', 'old_password', 'password', 'required maxlength="72" autocomplete="current-password"') + passwordField('新密码', 'password') + passwordField('确认新密码', 'confirm_password') + '<button class="btn btn-primary" type="submit">保存新密码</button></form></section>';
    bindForm('student-password-form', async data => {
      await U.api('/api/student/password', { method: 'POST', body: data }); U.setStudent(null);
      U.toast('密码已修改，请重新登录。'); history.replaceState(null, '', '#home'); await U.route();
    });
  }
  async function manage() {
    const U = ui(), serial = U.state.routeSerial, result = await U.api('/api/admin/students');
    if (serial !== U.state.routeSerial) return;
    document.getElementById('breadcrumb').textContent = '学生账号';
    U.main.innerHTML = '<div class="page-head"><div><h1>学生账号</h1><p>学生在考试首页自行注册：8位学号、姓名和自设密码。此处可修改姓名、重置密码、停用账号，并归属历史答卷。</p></div></div><div class="card table-wrap"><table class="data-table"><thead><tr><th>学号 / 姓名</th><th>班级</th><th>状态</th><th>操作</th></tr></thead><tbody>' + result.students.map(s => '<tr><td>' + U.esc(s.username) + '<br>' + U.esc(s.name) + '</td><td>' + U.esc(s.class_name) + '</td><td>' + (Number(s.enabled) ? '启用' : '停用') + '</td><td><button class="btn btn-small" data-student-edit="' + U.esc(s.id) + '">管理</button></td></tr>').join('') + '</tbody></table>' + (!result.students.length ? '<p class="card-pad">还没有学生注册。</p>' : '') + '</div><div id="student-edit-panel"></div><section class="card card-pad" style="margin-top:24px"><h2>历史答卷归属</h2><p>旧浏览器身份的答卷和上传图片生成的答卷，可由家长明确分配给学生；已归属的答卷不会重复分配。</p>' + (result.unassigned.length && result.students.length ? '<form id="assign-attempt"><label class="form-label">答卷<select name="attempt_id" required>' + result.unassigned.map(a => '<option value="' + U.esc(a.id) + '">' + U.esc(a.student_name + ' · ' + a.started_at + ' · ' + a.id.slice(0, 8)) + '</option>').join('') + '</select></label><label class="form-label">归属学生<select name="student_id" required>' + result.students.map(s => '<option value="' + U.esc(s.id) + '">' + U.esc(s.username + ' · ' + s.name) + '</option>').join('') + '</select></label><button class="btn" type="submit">确认归属</button></form>' : '<p>暂无可分配的答卷，或尚未创建学生账号。</p>') + '</section>';
    U.main.querySelectorAll('[data-student-edit]').forEach(b => b.onclick = () => {
      const s = result.students.find(x => x.id === b.dataset.studentEdit), panel = document.getElementById('student-edit-panel');
      panel.innerHTML = '<section class="card card-pad" style="margin-top:24px"><h2>管理学号 ' + U.esc(s.username) + '</h2><form id="student-edit-form">' + field('姓名', 'name', 'text', 'required maxlength="50" value="' + U.esc(s.name) + '"') + field('班级（选填）', 'class_name', 'text', 'maxlength="50" value="' + U.esc(s.class_name) + '"') + field('重置密码（留空保持原密码）', 'password', 'password', 'minlength="8" maxlength="72" autocomplete="new-password"') + '<label class="form-label">状态<select name="enabled"><option value="1"' + (Number(s.enabled) ? ' selected' : '') + '>启用</option><option value="0"' + (!Number(s.enabled) ? ' selected' : '') + '>停用</option></select></label><p class="small muted">停用或重置密码会撤销该学生所有设备的登录。请避免在其考试期间操作。</p><button class="btn btn-primary" type="submit">保存</button></form></section>';
      bindForm('student-edit-form', async data => {
        if (!await U.modal('保存学生账号修改？', '重置密码或停用账号后，该学生需要重新登录。')) return;
        data.enabled = data.enabled === '1'; await U.api('/api/admin/students/' + s.id, { method: 'PUT', body: data }); U.toast('已保存。'); await manage();
      }); panel.scrollIntoView({ behavior: 'smooth' });
    });
    if (document.getElementById('assign-attempt')) bindForm('assign-attempt', async data => {
      if (!await U.modal('确认答卷归属？', '请核对学生和答卷，分配后该学生可访问这份答卷，成绩仍由家长控制公布。')) return;
      await U.api('/api/admin/students/' + data.student_id + '/assign', { method: 'POST', body: { attempt_id: data.attempt_id } }); U.toast('答卷已归属。'); U.state.overview = null; await manage();
    });
  }
  window.ExamAccounts = { login, identity, password, manage };
})();
