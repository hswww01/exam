<?php
declare(strict_types=1);

function student_session(): ?array {
    static $loaded=false,$student=null;
    if ($loaded) return $student;
    $loaded=true; $token=$_COOKIE['exam_session'] ?? '';
    if (!is_string($token) || !preg_match('/^[a-f0-9]{64}$/D',$token)) return null;
    $row=sql('SELECT s.* FROM students s JOIN student_sessions t ON t.student_id=s.id WHERE t.token_hash=? AND t.expires>? AND s.enabled=1',[hash('sha256',$token),time()])->fetch();
    return $student=$row ?: null;
}
function student_public(array $s): array {
    return array_intersect_key($s,array_flip(['id','username','name','class_name','enabled','created_at']));
}
function student_cookie(string $token,int $expires): void {
    setcookie('exam_session',$token,['expires'=>$expires,'path'=>(config()['EXAM_BASE_PATH'] ?? '').'/','secure'=>!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS']!=='off','httponly'=>true,'samesite'=>'Strict']);
}
function student_password(mixed $v): string {
    $p=strval_checked($v,'密码',72,true);
    if (strlen($p)<8 || strlen($p)>72) throw new ApiError('密码需为8至72字节。');
    return password_hash($p,PASSWORD_DEFAULT);
}
function student_busy(array $s): bool {
    return (bool)sql("SELECT 1 FROM attempts WHERE owner_hash=? AND status='active' AND deadline>? LIMIT 1",[$s['owner_key'],stamp()])->fetchColumn();
}
function create_student(array $data): string {
    $username=trim(strval_checked($data['username'] ?? '', '学号',40,true));
    if (!preg_match('/^[0-9]{8}$/D',$username)) throw new ApiError('学号必须是8位数字，例如24021912。');
    $name=trim(strval_checked($data['name'] ?? '', '学生姓名',50,true));
    $hash=student_password($data['password'] ?? ''); $id=uid();
    $class=strval_checked($data['class_name'] ?? '', '班级',50);
    try { sql('INSERT INTO students(id,username,name,class_name,password_hash,owner_key,enabled,created_at) VALUES(?,?,?,?,?,?,1,?)',[$id,$username,$name,$class,$hash,bin2hex(random_bytes(32)),stamp()]); }
    catch (PDOException $e) { if (str_starts_with((string)$e->getCode(),'23')) throw new ApiError('该学号已注册，请登录；忘记密码请联系教师。',409); throw $e; }
    return $id;
}
function student_auth(string $method,string $path,array $data): array {
    $s=student_session();
    if ($method==='GET' && $path==='/api/student/status') return ['student'=>$s?student_public($s):null];
    if ($method!=='POST') throw new ApiError('接口不存在。',404);
    if ($s && student_busy($s)) throw new ApiError('考试期间不能退出登录或切换账号，请先交卷。',409);
    if ($path==='/api/student/logout') {
        sql('DELETE FROM student_sessions WHERE token_hash=?',[hash('sha256',$_COOKIE['exam_session'] ?? '')]);
        student_cookie('',time()-3600); return ['ok'=>true];
    }
    if ($path==='/api/student/register') {
        if ($s) throw new ApiError('请先退出当前账号。',409);
        $client=hash('sha256','register:'.($_SERVER['REMOTE_ADDR'] ?? 'local'));
        sql('DELETE FROM login_failures WHERE created<?',[time()-300]);
        if ((int)sql('SELECT COUNT(*) FROM login_failures WHERE client=?',[$client])->fetchColumn()>=8) throw new ApiError('注册操作过于频繁，请5分钟后重试。',429);
        sql('INSERT INTO login_failures(client,created) VALUES(?,?)',[$client,time()]);
        if (($data['password'] ?? null)!==($data['confirm_password'] ?? null)) throw new ApiError('两次密码不一致。');
        return ['id'=>create_student($data)];
    }
    if ($path==='/api/student/password') {
        if (!$s) throw new ApiError('请先登录。',401);
        $old=strval_checked($data['old_password'] ?? '', '原密码',72,true);
        $client=hash('sha256','password:'.$s['id']);
        sql('DELETE FROM login_failures WHERE created<?',[time()-300]);
        if ((int)sql('SELECT COUNT(*) FROM login_failures WHERE client=?',[$client])->fetchColumn()>=8) throw new ApiError('尝试次数过多，请5分钟后重试。',429);
        if (!password_verify($old,$s['password_hash'])) { sql('INSERT INTO login_failures(client,created) VALUES(?,?)',[$client,time()]); throw new ApiError('原密码不正确。'); }
        if (($data['password'] ?? null)!==($data['confirm_password'] ?? null)) throw new ApiError('两次密码不一致。');
        $hash=student_password($data['password'] ?? '');
        transaction(function() use($s,$hash) { sql('UPDATE students SET password_hash=? WHERE id=?',[$hash,$s['id']]); sql('DELETE FROM student_sessions WHERE student_id=?',[$s['id']]); });
        student_cookie('',time()-3600);return ['ok'=>true];
    }
    if ($path!=='/api/student/login') throw new ApiError('接口不存在。',404);
    $username=strtolower(trim(strval_checked($data['username'] ?? '', '账号',40,true)));
    $password=strval_checked($data['password'] ?? '', '密码',72,true);
    $client=hash('sha256','student:'.($_SERVER['REMOTE_ADDR'] ?? 'local'));
    sql('DELETE FROM login_failures WHERE created<?',[time()-300]);
    if ((int)sql('SELECT COUNT(*) FROM login_failures WHERE client=?',[$client])->fetchColumn()>=8) throw new ApiError('尝试次数过多，请5分钟后重试。',429);
    $row=sql('SELECT * FROM students WHERE username=?',[$username])->fetch();
    // Always perform password verification, including for nonexistent accounts.
    $valid=password_verify($password,$row['password_hash'] ?? '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.');
    if (!$row || !$row['enabled'] || !$valid) {
        sql('INSERT INTO login_failures(client,created) VALUES(?,?)',[$client,time()]);
        throw new ApiError('账号或密码不正确，或账号已停用。',401);
    }
    $token=bin2hex(random_bytes(32)); $expires=time()+7*86400;
    transaction(function() use($row,$token,$expires,$client) {
        sql('DELETE FROM student_sessions WHERE token_hash=? OR expires<=?',[hash('sha256',$_COOKIE['exam_session'] ?? ''),time()]);
        sql('INSERT INTO student_sessions(token_hash,student_id,expires) VALUES(?,?,?)',[hash('sha256',$token),$row['id'],$expires]);
        sql('DELETE FROM login_failures WHERE client=?',[$client]);
    });
    student_cookie($token,$expires); return ['student'=>student_public($row)];
}
function students_admin(string $method,string $path,array $data): array {
    if ($path==='/api/admin/students' && $method==='GET') {
        $rows=sql('SELECT id,username,name,class_name,enabled,created_at FROM students ORDER BY created_at DESC')->fetchAll();
        $legacy=sql("SELECT a.id,a.student_name,a.started_at,a.status FROM attempts a LEFT JOIN students s ON s.owner_key=a.owner_hash WHERE s.id IS NULL ORDER BY a.started_at DESC LIMIT 500")->fetchAll();
        return ['students'=>$rows,'unassigned'=>$legacy];
    }
    if ($path==='/api/admin/students' && $method==='POST') {
        return ['id'=>create_student($data)];
    }
    if (preg_match('~^/api/admin/students/([a-f0-9]+)(/assign)?$~D',$path,$m)) {
        $s=sql('SELECT * FROM students WHERE id=?',[$m[1]])->fetch(); if (!$s) throw new ApiError('学生不存在。',404);
        if ($method==='POST' && !empty($m[2])) {
            $attempt=strval_checked($data['attempt_id'] ?? '', '答卷',100,true);
            return transaction(function() use($s,$attempt) {
                $r=get_attempt($attempt);
                if ($r['status']==='active' && $r['deadline']>stamp()) throw new ApiError('正在考试的答卷请交卷后再归属。',409);
                if (sql('SELECT 1 FROM students WHERE owner_key=?',[$r['owner_hash']])->fetchColumn()) throw new ApiError('答卷已归属于学生，不允许重复分配。',409);
                sql('UPDATE attempts SET owner_hash=?,student_name=? WHERE id=?',[$s['owner_key'],$s['name'],$attempt]);return ['ok'=>true];
            });
        }
        if ($method==='PUT' && empty($m[2])) {
            $name=strval_checked($data['name'] ?? $s['name'],'姓名',50,true);$class=strval_checked($data['class_name'] ?? $s['class_name'],'班级',50);
            $enabled=$data['enabled'] ?? (bool)$s['enabled']; if (!is_bool($enabled)) throw new ApiError('启用状态无效。');
            $hash=isset($data['password']) && $data['password']!=='' ? student_password($data['password']) : $s['password_hash'];
            transaction(function() use($s,$name,$class,$enabled,$hash) {
                sql('UPDATE students SET name=?,class_name=?,enabled=?,password_hash=? WHERE id=?',[$name,$class,(int)$enabled,$hash,$s['id']]);
                if (!$enabled || $hash!==$s['password_hash']) sql('DELETE FROM student_sessions WHERE student_id=?',[$s['id']]);
            });return ['ok'=>true];
        }
    }
    throw new ApiError('接口不存在。',404);
}
