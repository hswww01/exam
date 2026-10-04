(function () {
  'use strict';
  let current = null, pollTimer = null;
  const U = () => window.ExamUI;
  const esc = v => U().esc(v);
  const endpoint = id => '/api/admin/scans/' + encodeURIComponent(id);
  const busy = s => s.job && ['queued','running'].includes(s.job.status);
  async function render(id, serial) {
    clearTimeout(pollTimer);
    const u = U();
    if (!id) {
      const [papers, scans] = await Promise.all([u.api('/api/papers?all=1'), u.api('/api/admin/scans')]);
      if (serial !== u.state.routeSerial) return;
      u.main.innerHTML = '<div class="page-head"><div><div class="eyebrow">PAPER EXAM</div><h1>上传答卷，认真批阅。</h1><p>选择打印时使用的试卷版本，上传照片，核对识别结果后评分。</p></div></div><section class="card card-pad"><form id="scan-create" class="generator-form"><label><span class="form-label">对应试卷</span><select name="paper_id" required>' + papers.papers.map(p => '<option value="'+esc(p.id)+'">'+esc(p.title)+'</option>').join('') + '</select></label><label><span class="form-label">考生称呼</span><input name="student_name" required maxlength="50" placeholder="同学"></label><p class="small muted">每份最多12页，支持 JPG、PNG、WebP。手机照片会压缩后上传，请确保题号和手写过程清晰。暂不支持 PDF、HEIC。建立答卷时保存所选试卷快照。</p><button class="btn btn-primary">建立纸质答卷 →</button></form></section><div class="section-heading"><h2>纸质答卷记录</h2></div><div class="card table-wrap"><table class="data-table"><thead><tr><th>试卷</th><th>考生</th><th>状态</th><th>操作</th></tr></thead><tbody>' + scans.scans.map(s => '<tr><td>'+esc(s.paper_title)+'</td><td>'+esc(s.student_name)+'</td><td>'+({draft:'待上传 / 待识别',ready:'待核对',confirmed:'已建立阅卷记录'}[s.status] || esc(s.status))+'</td><td><a class="btn btn-small" href="#scan/'+esc(s.id)+'">打开照片与答卷</a>'+(s.attempt_id?' <a class="btn btn-small" href="#review/'+esc(s.attempt_id)+'">查看评分</a>':'')+'</td></tr>').join('')+'</tbody></table></div>';
      document.querySelector('#scan-create').onsubmit = async e => {
        e.preventDefault(); e.stopPropagation(); const b=e.target.querySelector('button'); b.disabled=true;
        try { const f=new FormData(e.target); const r=await u.api('/api/admin/scans',{method:'POST',body:{paper_id:f.get('paper_id'),student_name:f.get('student_name')}}); u.nav('scan/'+r.id); }
        catch(err) { u.toast(err.message,true); } finally { b.disabled=false; }
      };
      return;
    }
    const d = await u.api(endpoint(id)); if (serial !== u.state.routeSerial) return;
    current=d.scan; const s=current; const locked=busy(s)||!!s.attempt_id;
    const answers=s.recognized.answers || {}; const edits=s.recognized.edits || {};
    const photoOptions=s.pages.map((p,i)=>'<option value="'+esc(p.id)+'">第'+(i+1)+'页 · '+esc(p.name)+'</option>').join('');
    u.main.innerHTML='<div class="page-head"><div><div class="eyebrow">纸质答卷</div><h1>'+esc(s.student_name)+' · 答卷照片</h1><p>'+esc(s.paper_title)+'</p></div><a class="btn" href="#scans">所有纸质答卷</a></div>'+ (s.attempt_id ? '<div class="notice">答案已确认并建立阅卷记录。<a class="btn btn-primary" href="#review/'+esc(s.attempt_id)+'">打开评分与评语 →</a></div>' : '') +
      '<section class="card card-pad scan-upload"><label><span class="form-label">添加答卷照片（'+s.pages.length+'/12）</span><input id="scan-files" type="file" accept="image/jpeg,image/png,image/webp" multiple '+(locked?'disabled':'')+'></label><p class="small muted">请按页序上传整页照片，拍正、避免阴影；点击页序按钮调整。照片保存在家长后台，识别时发送至配置的 AI 服务。</p><div id="scan-upload-state" role="status"></div><div class="scan-pages">'+s.pages.map((p,i)=>'<div class="scan-page-row"><span>第'+(i+1)+'页 · '+esc(p.name)+'</span>'+(!locked?'<button class="btn btn-small" data-scan="up" data-id="'+esc(p.id)+'" '+(!i?'disabled':'')+'>上移</button><button class="btn btn-small" data-scan="down" data-id="'+esc(p.id)+'" '+(i===s.pages.length-1?'disabled':'')+'>下移</button><button class="btn btn-small" data-scan="remove" data-id="'+esc(p.id)+'">移除</button>':'')+'</div>').join('')+'</div>'+(!s.attempt_id?'<button class="btn btn-primary" data-scan="recognize" '+(locked||!s.pages.length?'disabled':'')+'>'+(s.status==='ready'?'重新识别照片':'开始识别照片')+'</button>':'')+'</section>'+
      (s.job?'<div class="notice '+(s.job.status==='failed'?'warn':'')+'">'+esc(s.job.status==='failed'?s.job.error:s.job.message)+' '+(busy(s)?esc(s.job.progress)+'% · Flex 可能需要较长等待，离开页面不影响后台处理。':'')+'</div>':'')+
      '<div class="scan-workspace"><section class="card card-pad scan-photo"><h2>答卷照片</h2>'+(s.pages.length?'<select id="scan-photo-page" aria-label="查看答卷页">'+photoOptions+'</select><div class="actions"><button class="btn btn-small" data-scan="zoom">放大 / 适应宽度</button><button class="btn btn-small" data-scan="rotate">旋转查看</button></div><div class="scan-image-scroll"><img id="scan-image" alt="所选答卷照片"></div>':'<p>上传后在这里查看照片。</p>')+'</section><section class="card card-pad"><h2>核对识别结果</h2>'+ (s.status==='ready'||s.attempt_id ? '<p>请逐题对照照片。未识别到的题目不一定未作答；补齐遗漏后再确认。图形或公式无法完整转录时，请人工复核评分。</p>'+ (s.recognized.notes||[]).map(n=>'<p class="small muted">'+esc(n)+'</p>').join('')+'<form id="scan-confirm">'+s.snapshot.questions.map(q=>{const a=answers[q.id];const missing=!a; const v=Object.prototype.hasOwnProperty.call(edits,q.id)?edits[q.id]:a?a.answer:'';return '<div class="scan-answer"><label class="form-label">第 '+esc(q.label)+' 题 · '+esc(q.points)+' 分</label><details><summary>查看题干</summary><p class="scan-stem">'+esc(q.stem)+'</p></details>'+((missing||a.uncertain)?'<div class="notice warn">'+(missing?'未识别到作答，请检查是否漏页或漏题。':esc(a.note||'识别存在不确定内容或跨页合并，请核对。'))+'</div>':'')+(a&&a.pages?'<p class="small muted">位于第 '+esc(a.pages.join('、'))+' 页</p>':'')+'<textarea data-scan-answer="'+esc(q.id)+'" aria-label="第 '+esc(q.label)+' 题识别答案" '+(locked?'readonly':'')+'>'+esc(v)+'</textarea></div>';}).join('')+(!s.attempt_id?'<label class="check-label"><input id="scan-checked" type="checkbox" required>已逐题核对；留空的题目确实未作答，按0分处理。</label><div class="actions"><button type="button" class="btn" data-scan="save">保存核对草稿</button><button class="btn btn-primary" '+(locked?'disabled':'')+'>确认答案并进入阅卷 →</button></div>':'')+'</form>' : '<p>上传所有页面并开始识别，完成后在这里核对答案。</p>')+'</section></div>';
    const pageSelect=document.querySelector('#scan-photo-page');
    if (pageSelect) { pageSelect.onchange=()=>loadPhoto(s.id,pageSelect.value).catch(err=>u.toast(err.message,true)); await loadPhoto(s.id,pageSelect.value); }
    if (serial !== u.state.routeSerial) return;
    document.querySelector('#scan-files').onchange=upload;
    const form=document.querySelector('#scan-confirm');
    if(form) form.onsubmit=confirm;
    u.main.querySelectorAll('[data-scan]').forEach(b=>b.onclick=()=>act(b).catch(err=>u.toast(err.message,true)));
    if(busy(s)) pollTimer=setTimeout(()=>{ if(u.state.route==='scan/'+id) render(id,serial).catch(err=>u.toast(err.message,true)); },5000);
  }
  async function loadPhoto(id,pid) {
    const image=document.querySelector('#scan-image'); if(!image) return;
    image.removeAttribute('src'); image.style.transform=''; image.dataset.rotation='0';
    const d=await U().api(endpoint(id)+'/pages/'+pid);
    if(document.contains(image) && document.querySelector('#scan-photo-page').value===pid) image.src=d.data_url;
  }
  async function prepare(file) {
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size>20000000) throw new Error(file.name+'：请使用20MB以内的 JPG、PNG 或 WebP。');
    const bmp=await createImageBitmap(file); const scale=Math.min(1,2800/Math.max(bmp.width,bmp.height));
    const canvas=document.createElement('canvas'); canvas.width=Math.round(bmp.width*scale); canvas.height=Math.round(bmp.height*scale);
    const ctx=canvas.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.drawImage(bmp,0,0,canvas.width,canvas.height); bmp.close();
    let result=''; for (const quality of [.9,.8,.7,.6]) { result=canvas.toDataURL('image/jpeg',quality); if(result.length<=1750000) return result; }
    throw new Error(file.name+'：压缩后仍过大，请裁去空白或分成两张上传。');
  }
  async function upload(e) {
    const u=U(), id=current.id, files=Array.from(e.target.files); if(!files.length)return;
    if(files.length+current.pages.length>12){u.toast('每份答卷最多12页。',true);return;}
    if(current.status==='ready' && !await u.modal('添加照片？','添加照片后需要重新识别，现有核对草稿会清除。',{confirm:'继续添加'}))return;
    const controls=Array.from(u.main.querySelectorAll('button,input')); controls.forEach(b=>b.disabled=true);
    let completed=0;
    try { for(const file of files){const msg=document.querySelector('#scan-upload-state'); if(msg)msg.textContent='正在上传 '+(completed+1)+'/'+files.length+'：'+file.name; const image=await prepare(file); await u.api(endpoint(id)+'/pages',{method:'POST',body:{name:file.name,data_url:image}});completed++;} u.toast('照片已上传，请核对页序并开始识别。'); }
    catch(err){u.toast('已上传'+completed+'张。'+err.message,true);}
    finally { if(u.state.route==='scan/'+id)await render(id,u.state.routeSerial); }
  }
  function readEdits(){const out={}; document.querySelectorAll('[data-scan-answer]').forEach(t=>out[t.dataset.scanAnswer]=t.value);return out;}
  async function act(b){
    const u=U(),s=current,action=b.dataset.scan; b.disabled=true;
    try {
      if(action==='zoom'){document.querySelector('#scan-image').classList.toggle('scan-full');return;}
      if(action==='rotate'){const i=document.querySelector('#scan-image');i.dataset.rotation=String((Number(i.dataset.rotation||0)+90)%360);i.style.transform='rotate('+i.dataset.rotation+'deg)';return;}
      if(action==='save'){await u.api(endpoint(s.id)+'/draft',{method:'PUT',body:{edits:readEdits()}});u.toast('核对草稿已保存。');return;}
      if(action==='recognize'){
        if(!await u.modal('开始识别答卷照片？','照片将发送到配置的 AI 服务进行手写识别，使用 Flex 模式。请不要上传与考试无关的个人资料。重新识别会替换此前识别和核对草稿。',{confirm:'开始识别'}))return;
        await u.api(endpoint(s.id)+'/recognize',{method:'POST',body:{}});
      } else {
        if(s.status==='ready'&&!await u.modal('修改照片？','修改或调整页序后，需要重新识别，已有核对草稿将清除。',{confirm:'继续修改'}))return;
        if(action==='remove') await u.api(endpoint(s.id)+'/pages/'+b.dataset.id,{method:'DELETE'});
        else {const order=s.pages.map(p=>p.id),i=order.indexOf(b.dataset.id),other=i+(action==='up'?-1:1);[order[i],order[other]]=[order[other],order[i]];await u.api(endpoint(s.id)+'/pages',{method:'PUT',body:{order}});}
      }
      await render(s.id,u.state.routeSerial);
    } finally {b.disabled=false;}
  }
  async function confirm(e){
    e.preventDefault();e.stopPropagation();const u=U(),s=current,b=e.target.querySelector('button.btn-primary');b.disabled=true;
    try{
      const edits=readEdits(),answers={};
      for(const q of s.snapshot.questions){let a=(edits[q.id]||'').trim();if(q.kind==='choice')a=a.toUpperCase();if(q.kind==='multi')a=a.toUpperCase().split(/[,，、\s]+/).filter(Boolean);answers[q.id]=a;}
      await u.api(endpoint(s.id)+'/draft',{method:'PUT',body:{edits}});
      const d=await u.api(endpoint(s.id)+'/confirm',{method:'POST',body:{answers,checked:document.querySelector('#scan-checked').checked}});
      u.state.overview=null;u.toast('答案已确认。客观题已评分，可在答卷页面开始 AI 阅卷。');u.nav('review/'+d.attempt_id);
    }catch(err){u.toast(err.message,true);}finally{b.disabled=false;}
  }
  window.ExamScans={render};
})();
