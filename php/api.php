<?php
declare(strict_types=1);
require_once __DIR__.'/core.php';
require_once __DIR__.'/ai.php';
require_once __DIR__.'/scans.php';

function is_admin(): bool {
    $token=$_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (!str_starts_with($token,'Bearer ')) return false;
    return (bool)sql('SELECT token_hash FROM admin_sessions WHERE token_hash=? AND expires>?',[hash('sha256',substr($token,7)),time()])->fetch();
}
function owner_hash(): string {
    $value=$_COOKIE['exam_student'] ?? '';
    if (!preg_match('/^[a-f0-9]{64}$/D',$value)) {
        $value=bin2hex(random_bytes(32));
        setcookie('exam_student',$value,['expires'=>time()+86400*365,'path'=>(config()['EXAM_BASE_PATH'] ?? '').'/','secure'=>!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS']!=='off','httponly'=>true,'samesite'=>'Strict']);
    }
    return hash('sha256',$value);
}
function require_owner(array $r,bool $admin,string $owner): void {
    if (!$admin && (!$r['owner_hash'] || !hash_equals($r['owner_hash'],$owner))) throw new ApiError('考试记录不存在。',404);
}
function auth_api(string $method,string $path,array $data,bool $admin): array {
    $row=sql("SELECT value FROM settings WHERE `key`='php_admin_password'")->fetch();
    if ($path==='/api/auth/status' && $method==='GET') return ['configured'=>(bool)$row,'authenticated'=>$admin];
    if ($path==='/api/auth/logout' && $method==='POST') {
        sql('DELETE FROM admin_sessions WHERE token_hash=?',[hash('sha256',substr($_SERVER['HTTP_AUTHORIZATION'] ?? '',7))]); return ['ok'=>true];
    }
    if ($method!=='POST' || !in_array($path,['/api/auth/login','/api/auth/setup'])) throw new ApiError('接口不存在。',404);
    $password=strval_checked($data['password'] ?? null,'家长密码',128,true);
    $client=hash('sha256',$_SERVER['REMOTE_ADDR'] ?? 'local');
    sql('DELETE FROM login_failures WHERE created<?',[time()-300]);
    if ((int)sql('SELECT COUNT(*) FROM login_failures WHERE client=?',[$client])->fetchColumn()>=8) throw new ApiError('尝试次数过多，请5分钟后重试。',429);
    if ($path==='/api/auth/setup') {
        if ($row) throw new ApiError('密码已经设置，请登录。',409);
        $expected=sql("SELECT value FROM settings WHERE `key`='setup_code_hash'")->fetchColumn();
        $code=$data['setup_code'] ?? '';
        if (!$expected || !is_string($code) || !hash_equals($expected,hash('sha256',trim($code)))) {
            sql('INSERT INTO login_failures(client,created) VALUES(?,?)',[$client,time()]); throw new ApiError('首次设置码不正确，请查看安装时生成的设置码。',403);
        }
        if (strlen($password)<10 || strlen($password)>72) throw new ApiError('密码需为10至72字节（中文占多个字节）。');
        transaction(function() use($password) {
            // A one-time setup row is locked; concurrent initial setup cannot replace a password.
            sql("SELECT value FROM settings WHERE `key`='setup_code_hash'".(mysql_mode()?' FOR UPDATE':''))->fetch();
            if (sql("SELECT 1 FROM settings WHERE `key`='php_admin_password'")->fetch()) throw new ApiError('密码已设置，请登录。',409);
            sql("INSERT INTO settings(`key`,value) VALUES('php_admin_password',?)",[password_hash($password,PASSWORD_DEFAULT)]);
            sql("DELETE FROM settings WHERE `key`='setup_code_hash'");
        });
    } elseif (!$row || !password_verify($password,$row['value'])) {
        sql('INSERT INTO login_failures(client,created) VALUES(?,?)',[$client,time()]); throw new ApiError('密码不正确或尚未设置。',401);
    }
    sql('DELETE FROM login_failures WHERE client=?',[$client]);
    sql('DELETE FROM admin_sessions WHERE expires<=?',[time()]);
    $token=bin2hex(random_bytes(32)); sql('INSERT INTO admin_sessions(token_hash,expires) VALUES(?,?)',[hash('sha256',$token),time()+1800]);
    return ['token'=>$token,'expires_in'=>1800];
}
function api(string $method,string $path,array $query,array $data): array {
    $admin=is_admin();
    if (str_starts_with($path,'/api/auth/')) return auth_api($method,$path,$data,$admin);
    $privileged=preg_match('~^/api/(admin/|ai/|jobs/)|^/api/attempts/[\w-]+/(grade|ai-grade|release)$~',$path) || ($query['all'] ?? '')==='1';
    if ($privileged && !$admin) throw new ApiError('请先登录家长后台。',401);
    if (str_starts_with($path,'/api/admin/scans')) return scans_api($method,$path,$data);
    $owner=owner_hash();
    if ($path==='/api/ai/status' && $method==='GET') return ai_status();
    if ($path==='/api/jobs' && $method==='GET') {
        $jobs=sql("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at DESC LIMIT 20")->fetchAll();
        foreach ($jobs as &$job) { unset($job['payload_json']); $job['result']=decode($job['result_json']); unset($job['result_json']); }
        return ['jobs'=>$jobs];
    }
    if ($method==='GET' && preg_match('~^/api/jobs/([\w-]+)$~',$path,$m)) {
        $job=sql('SELECT * FROM jobs WHERE id=?',[$m[1]])->fetch(); if (!$job) throw new ApiError('任务不存在。',404);
        $job['result']=decode($job['result_json']); unset($job['result_json'],$job['payload_json']); return ['job'=>$job];
    }
    if ($method==='GET' && in_array($path,['/api/overview','/api/subjects','/api/papers','/api/attempts'])) {
        transaction(fn()=>expire_attempts());
        $papers=list_papers(($query['all'] ?? '')==='1',$query['subject'] ?? null);
        if ($path==='/api/papers') return ['papers'=>$papers];
        $rows=sql('SELECT * FROM attempts'.($admin?'':' WHERE owner_hash=?').' ORDER BY started_at DESC LIMIT 500',$admin?[]:[$owner])->fetchAll();
        $attempts=array_map(fn($r)=>attempt_result($r,$admin)['attempt'],$rows);
        if ($path==='/api/attempts') return ['attempts'=>$attempts];
        $subjects=subjects();
        $seedIds=array_map(fn($s)=>'seed-'.$s['code'],$subjects);
        $seedRows=sql('SELECT id,metadata_json FROM papers WHERE id IN ('.implode(',',array_fill(0,count($seedIds),'?')).')',$seedIds)->fetchAll();
        $seeds=[]; foreach ($seedRows as $row) $seeds[$row['id']]=decode($row['metadata_json']);
        foreach ($subjects as $i=>&$s) { $seed=$seeds['seed-'.$s['code']] ?? []; $s['sort_order']=$i; foreach (['scope','description','blueprint'] as $k) $s[$k]=$seed[$k] ?? null; }
        unset($s);
        return ['subjects'=>$subjects,'papers'=>$papers,'attempts'=>$attempts,'stats'=>['papers'=>count($papers),'attempts'=>count($attempts),'completed'=>count(array_filter($attempts,fn($a)=>$a['status']!=='active')),'question_count'=>array_sum(array_column($papers,'question_count'))],'ai'=>$admin?ai_status():['configured'=>false]];
    }
    if ($method==='POST' && $path==='/api/admin/papers') { $id=uid(); transaction(fn()=>save_paper($id,$data)); return ['id'=>$id]; }
    if (preg_match('~^/api/(admin/)?papers/([\w-]+)(/publish)?$~',$path,$m)) {
        $manage=!empty($m[1]); $id=$m[2]; $publish=!empty($m[3]);
        [$p,$qs]=get_paper($id);
        if ($method==='GET' && !$publish) {
            if (!$manage && $p['status']!=='published') throw new ApiError('试卷尚未发布或已归档。',404);
            return ['paper'=>$p,'questions'=>array_map(fn($q)=>public_question($q,$manage),$qs)];
        }
        if (!$manage) throw new ApiError('接口不存在。',404);
        if ($method==='POST' && $publish) { normalize_paper($p+['questions'=>$qs],true); sql("UPDATE papers SET status='published',updated_at=? WHERE id=?",[stamp(),$id]); return ['id'=>$id,'status'=>'published']; }
        if ($method==='PUT' && !$publish) { transaction(fn()=>save_paper($id,$data,$p['status']==='published'?'published':'draft')); return ['id'=>$id]; }
        if ($method==='DELETE' && !$publish) { sql("UPDATE papers SET status='archived',updated_at=? WHERE id=?",[stamp(),$id]); return ['id'=>$id,'status'=>'archived']; }
    }
    if ($method==='POST' && $path==='/api/attempts') {
        return transaction(function() use($data,$owner) {
            [$p,$qs]=get_paper((string)($data['paper_id'] ?? '')); if ($p['status']!=='published') throw new ApiError('请先发布试卷。');
            if ((int)sql("SELECT COUNT(*) FROM attempts WHERE owner_hash=? AND status='active'",[$owner])->fetchColumn()>=5) throw new ApiError('请先完成正在进行的考试。',409);
            $id=uid(); $name=strval_checked($data['student_name'] ?? '同学','考生称呼',50) ?: '同学';
            sql('INSERT INTO attempts(id,paper_id,student_name,started_at,deadline,snapshot_json,answers_json,flags_json,grades_json,owner_hash) VALUES(?,?,?,?,?,?,?,?,?,?)',[$id,$p['id'],$name,stamp(),date('Y-m-d\TH:i:s.uP',time()+(int)($p['minutes']*60)),j(['paper'=>$p,'questions'=>$qs]),'{}','[]','{}',$owner]);
            return ['id'=>$id];
        });
    }
    if (preg_match('~^/api/attempts/([\w-]+)(?:/(answers|submit|grade|ai-grade|release))?$~',$path,$m)) {
        $id=$m[1]; $action=$m[2] ?? '';
        transaction(fn()=>expire_attempts());
        $result=transaction(function() use($id,$action,$method,$data,$admin,$owner) {
            $r=get_attempt($id); require_owner($r,$admin,$owner);
            if ($method==='GET' && !$action) {
                $out=attempt_result($r,$admin);
                if ($admin) $out['scan_id']=sql('SELECT id FROM paper_scans WHERE attempt_id=?',[$id])->fetchColumn() ?: null;
                return $out;
            }
            if ($method==='PUT' && $action==='answers') { if ($r['status']!=='active') throw new ApiError('考试已经交卷或时间已到。',409); update_answers($r,$data); return ['id'=>$id,'saved'=>true]; }
            if ($method==='POST' && $action==='submit') { if ($r['status']==='active') { update_answers($r,$data); submit_attempt(get_attempt($id)); } return ['id'=>$id]; }
            if ($method==='POST' && in_array($action,['grade','ai-grade','release'])) {
                if (!$admin) throw new ApiError('请登录家长后台。',401);
                if ($r['status']==='active') throw new ApiError('请先交卷。',409);
                if ($action==='release') {
                    $release=$data['released'] ?? null; if (!is_bool($release)) throw new ApiError('公布状态无效。');
                    if ($release && attempt_result($r,true)['attempt']['pending_manual']) throw new ApiError('请完成所有主观题评分后再公布。',409);
                    sql('UPDATE attempts SET released=? WHERE id=?',[(int)$release,$id]); return ['released'=>$release];
                }
                if ($action==='ai-grade') {
                    if (!attempt_result($r,true)['attempt']['pending_manual']) throw new ApiError('所有题目已评分。');
                    return ['enqueue'=>true];
                }
                $scores=$data['scores'] ?? []; if (!is_array($scores)) throw new ApiError('评分格式无效。');
                $valid=array_column(decode($r['snapshot_json'])['questions'],null,'id'); $grades=decode($r['grades_json']);
                foreach ($scores as $qid=>$mark) {
                    if (!isset($valid[$qid]) || !is_array($mark)) throw new ApiError('评分题号或格式无效。');
                    $score=finite($mark['score'] ?? null,'题目得分',0,$valid[$qid]['points']); $feedback=strval_checked($mark['feedback'] ?? '','评语',10000);
                    $grades[$qid]=array_merge($grades[$qid] ?? [],['score'=>$score,'feedback'=>$feedback,'grader'=>'manual']);
                    sql('INSERT INTO grade_history(attempt_id,question_id,grade_json,created_at) VALUES(?,?,?,?)',[$id,$qid,j($grades[$qid]),stamp()]);
                }
                sql('UPDATE attempts SET grades_json=? WHERE id=?',[j((object)$grades),$id]); return attempt_result(get_attempt($id),true);
            }
            throw new ApiError('接口不存在。',404);
        });
        if (isset($result['enqueue'])) return ['job_id'=>create_job('grade',$id,[])];
        return $result;
    }
    if ($method==='POST' && $path==='/api/ai/generate') {
        $id=(string)($data['template_id'] ?? ''); [$p,$qs]=get_paper($id); normalize_paper($p+['questions'=>$qs],true);
        foreach (['scope','title','difficulty'] as $k) if (isset($data[$k])) strval_checked($data[$k],$k,5000);
        return ['job_id'=>create_job('generate',$id,$data)];
    }
    throw new ApiError('接口不存在。',404);
}
