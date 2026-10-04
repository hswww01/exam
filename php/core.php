<?php
declare(strict_types=1);
const ROOT = __DIR__ . '/..';
date_default_timezone_set('Asia/Shanghai');
class ApiError extends RuntimeException {
    public function __construct(string $message, public int $status = 400) { parent::__construct($message); }
}
function j(mixed $v): string { return json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR); }
function decode(string $v): array { return json_decode($v, true, 512, JSON_THROW_ON_ERROR); }
function uid(): string { return bin2hex(random_bytes(16)); }
function stamp(): string { return date('Y-m-d\TH:i:s.uP'); }
function config(): array {
    $v=[];
    if (is_readable('/etc/environment')) {
        $system = parse_ini_file('/etc/environment',false,INI_SCANNER_RAW) ?: [];
        foreach (['MYSQL_HOST','MYSQL_USER','MYSQL_PASS','MYSQL_PORT'] as $key) if (isset($system[$key])) $v[$key]=$system[$key];
    }
    foreach (['.env','.env.local'] as $f) {
        if (!is_file(ROOT.'/'.$f)) continue;
        foreach (file(ROOT.'/'.$f, FILE_IGNORE_NEW_LINES) as $line) {
            $line=trim($line,"\xEF\xBB\xBF \t\r\n");
            if (!$line || str_starts_with($line,'#') || !str_contains($line,'=')) continue;
            [$key,$value]=explode('=',$line,2); $v[trim($key)]=trim(trim($value),"\"'");
        }
    }
    foreach (['OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_MODEL','OPENAI_REASONING_EFFORT','OPENAI_TIMEOUT','EXAM_DB_PATH','EXAM_SETUP_CODE','EXAM_SITE_URL','EXAM_BASE_PATH','MYSQL_HOST','MYSQL_USER','MYSQL_PASS','MYSQL_PORT','MYSQL_DATABASE'] as $key) {
        if (getenv($key)!==false) $v[$key]=getenv($key);
    }
    return $v;
}
function mysql_mode(): bool { return !empty(config()['MYSQL_HOST']); }
function db(): PDO {
    static $db;
    if (!$db) {
        $c=config();
        $dsn=mysql_mode() ? 'mysql:host='.$c['MYSQL_HOST'].';port='.($c['MYSQL_PORT'] ?? '3306').';dbname='.($c['MYSQL_DATABASE'] ?? 'exam_practice').';charset=utf8mb4' : 'sqlite:'.($c['EXAM_DB_PATH'] ?? ROOT.'/exam.db');
        $db = new PDO($dsn,$c['MYSQL_USER'] ?? null,$c['MYSQL_PASS'] ?? null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC,PDO::ATTR_EMULATE_PREPARES=>false]);
        if (!mysql_mode()) $db->exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=15000;');
    }
    return $db;
}
function sql(string $query,array $args=[]): PDOStatement { $s=db()->prepare($query); $s->execute($args); return $s; }
function transaction(callable $fn): mixed {
    if (mysql_mode()) db()->beginTransaction(); else db()->exec('BEGIN IMMEDIATE');
    try { $v=$fn(); if (mysql_mode()) db()->commit(); else db()->exec('COMMIT'); return $v; }
    catch (Throwable $e) { if (mysql_mode()) db()->rollBack(); else db()->exec('ROLLBACK'); throw $e; }
}
function subjects(): array {
    return [
        ['code'=>'chinese','name'=>'语文','full_score'=>100,'minutes'=>150,'external_score'=>0],
        ['code'=>'math','name'=>'数学','full_score'=>100,'minutes'=>120,'external_score'=>0],
        ['code'=>'english','name'=>'英语','full_score'=>60,'minutes'=>90,'external_score'=>40,'note'=>'听说机考40分另行考核'],
        ['code'=>'physics','name'=>'物理','full_score'=>70,'minutes'=>70,'external_score'=>10,'note'=>'实验操作10分另行考核'],
        ['code'=>'daofa','name'=>'道德与法治','full_score'=>70,'minutes'=>70,'external_score'=>10,'note'=>'开卷；综合素质评价10分另行计入']
    ];
}
function strval_checked(mixed $v,string $label,int $limit=40000,bool $required=false): string {
    if (!is_string($v) || strlen($v)>$limit*4 || ($required && trim($v)==='')) throw new ApiError($label.'不能为空或长度超出限制。');
    return $v;
}
function finite(mixed $v,string $label,float $low=0,float $high=1000): float {
    if (is_bool($v) || !is_numeric($v) || !is_finite((float)$v) || (float)$v<$low || (float)$v>$high) throw new ApiError("{$label}必须介于 {$low} 和 {$high} 之间。");
    return (float)$v;
}
function normalize_paper(array $data,bool $publish=false): array {
    $src=$data['paper'] ?? $data; $qs=$data['questions'] ?? ($src['questions'] ?? []);
    $code=$src['subject_code'] ?? '';
    if (!in_array($code,array_column(subjects(),'code'),true)) throw new ApiError('科目不存在。');
    $p=['subject_code'=>$code];
    foreach (['title','scope','description','source_note'] as $k) $p[$k]=strval_checked($src[$k] ?? '',$k,10000,in_array($k,['title','scope']));
    $p['minutes']=finite($src['minutes'] ?? null,'考试时间',1,300); $p['max_score']=finite($src['max_score'] ?? null,'满分',1,300);
    $bp=$src['blueprint'] ?? [];
    if (!is_array($bp) || !array_is_list($bp) || count($bp)>30 || !is_array($qs) || !array_is_list($qs) || count($qs)>200) throw new ApiError('题目或分值结构格式无效。');
    $p['blueprint']=[]; $sections=[];
    foreach ($bp as $b) {
        $section=strval_checked($b['section'] ?? null,'分节名称',100,true);
        if (isset($sections[$section])) throw new ApiError('分节名称重复。');
        $points=finite($b['points'] ?? null,'分节分数',0.5,300); $sections[$section]=$points;
        $p['blueprint'][]=['section'=>$section,'points'=>$points];
    }
    $out=[]; $ids=[]; $labels=[]; $totals=[];
    foreach ($qs as $i=>$item) {
        if (!is_array($item)) throw new ApiError('题目格式错误。');
        $q=['id'=>(string)($item['id'] ?? uid()),'label'=>(string)($item['label'] ?? ($i+1))];
        if (!preg_match('/^[a-zA-Z0-9_-]{1,100}$/D',$q['id']) || isset($ids[$q['id']]) || isset($labels[$q['label']])) throw new ApiError('题号或ID无效、重复。');
        $ids[$q['id']]=true; $labels[$q['label']]=true;
        $q['kind']=$item['kind'] ?? 'text';
        if (!in_array($q['kind'],['choice','multi','number','text','essay'],true)) throw new ApiError('题型无效。');
        foreach (['stem','section','passage','rubric','explanation'] as $k) $q[$k]=strval_checked($item[$k] ?? '',$k,40000,in_array($k,['stem','section']));
        $q['points']=finite($item['points'] ?? null,'题目分值',0.5,100);
        $q['manual']=!empty($item['manual']) || in_array($q['kind'],['text','essay']);
        $q['tolerance']=finite($item['tolerance'] ?? 0,'容差',0,1e9);
        $q['partial_credit']=finite($item['partial_credit'] ?? 0,'多选部分分',0,$q['points']);
        $q['options']=$item['options'] ?? [];
        if (!is_array($q['options']) || !array_is_list($q['options']) || count($q['options'])>26) throw new ApiError('选项格式无效。');
        foreach ($q['options'] as $o) strval_checked($o,'选项',5000);
        $q['answer']=$item['answer'] ?? '';
        if (!(is_string($q['answer']) || is_numeric($q['answer']) || is_array($q['answer'])) || strlen(j($q['answer']))>160000) throw new ApiError('答案格式无效。');
        if (is_array($q['answer'])) { if (!array_is_list($q['answer'])) throw new ApiError('答案数组无效。'); foreach ($q['answer'] as $a) strval_checked($a,'答案'); }
        if (!empty($item['figure'])) {
            if (!is_string($item['figure']) || !preg_match('/^[a-zA-Z0-9_-]+\.(svg|png|jpg|jpeg|webp)$/D',$item['figure'])) throw new ApiError('配图文件名无效。');
            $q['figure']=$item['figure']; $q['figure_alt']=strval_checked($item['figure_alt'] ?? '题目配图','配图说明',300);
        }
        if ($publish) {
            $letters=array_slice(range('A','Z'),0,count($q['options']));
            if (in_array($q['kind'],['choice','multi']) && count($letters)<2) throw new ApiError('选择题至少需要两个选项。');
            if ($q['kind']==='choice' && !in_array($q['answer'],$letters,true)) throw new ApiError('单选答案无效。');
            if ($q['kind']==='multi' && (!is_array($q['answer']) || !$q['answer'] || array_diff($q['answer'],$letters) || count(array_unique($q['answer']))!==count($q['answer']))) throw new ApiError('多选答案无效。');
            if ($q['kind']==='number') finite($q['answer'],'数值答案',-1e100,1e100);
            if ($q['manual'] && (trim((string)$q['rubric'])==='' || $q['answer']==='')) throw new ApiError('主观题须包含答案和评分标准。');
        }
        $totals[$q['section']]=($totals[$q['section']] ?? 0)+$q['points']; $out[]=$q;
    }
    if ($publish && (!$out || abs(array_sum(array_column($out,'points'))-$p['max_score'])>1e-6 || $totals!=$sections)) throw new ApiError('题目总分或各部分分值与试卷结构不一致。');
    return [$p,$out];
}
function save_paper(string $id,array $data,string $status='draft'): void {
    [$p,$qs]=normalize_paper($data,$status==='published');
    $upsert=mysql_mode() ? ' ON DUPLICATE KEY UPDATE subject_code=VALUES(subject_code),status=VALUES(status),metadata_json=VALUES(metadata_json),updated_at=VALUES(updated_at)' : ' ON CONFLICT(id) DO UPDATE SET subject_code=excluded.subject_code,status=excluded.status,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at';
    sql('INSERT INTO papers(id,subject_code,status,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?)'.$upsert,[$id,$p['subject_code'],$status,j($p),stamp(),stamp()]);
    sql('DELETE FROM questions WHERE paper_id=?',[$id]);
    foreach ($qs as $i=>$q) sql('INSERT INTO questions(paper_id,id,seq,data_json) VALUES(?,?,?,?)',[$id,$q['id'],$i,j($q)]);
}
function get_paper(string $id): array {
    $row=sql('SELECT * FROM papers WHERE id=?',[$id])->fetch(); if (!$row) throw new ApiError('试卷不存在。',404);
    $p=decode($row['metadata_json']); foreach (['id','status','created_at','updated_at'] as $k) $p[$k]=$row[$k];
    $qs=array_map(fn($r)=>decode($r['data_json']),sql('SELECT data_json FROM questions WHERE paper_id=? ORDER BY seq',[$id])->fetchAll());
    $p['question_count']=count($qs); return [$p,$qs];
}
function list_papers(bool $all=false,?string $subject=null): array {
    $out=[]; foreach (sql("SELECT id FROM papers WHERE status!='archived'".($all?'':" AND status='published'").' ORDER BY created_at DESC,id')->fetchAll() as $r) {
        [$p]=get_paper($r['id']); if (!$subject || $p['subject_code']===$subject) $out[]=$p;
    } return $out;
}
function public_question(array $q,bool $reveal=false): array { if (!$reveal) foreach (['answer','rubric','explanation','tolerance'] as $k) unset($q[$k]); return $q; }
function get_attempt(string $id): array {
    $r=sql('SELECT * FROM attempts WHERE id=?'.(mysql_mode() && db()->inTransaction()?' FOR UPDATE':''),[$id])->fetch(); if (!$r) throw new ApiError('考试记录不存在。',404); return $r;
}
function blank(mixed $a): bool { return $a===null || $a===[] || (is_string($a) && trim($a)===''); }
function objective_score(array $q,mixed $a): float {
    if (blank($a)) return 0;
    if ($q['kind']==='multi') {
        if (!is_array($a) || count(array_unique($a))!==count($a)) return 0;
        $key=$q['answer']; if (array_diff($a,$key)) return 0;
        return count($a)===count($key) ? $q['points'] : ($q['partial_credit'] ?? 0);
    }
    if ($q['kind']==='number') return is_numeric($a) && is_finite((float)$a) && abs((float)$a-(float)$q['answer'])<=($q['tolerance'] ?? 0)+1e-12 ? $q['points'] : 0;
    return is_scalar($a) && strtoupper(trim((string)$a))===strtoupper(trim((string)$q['answer'])) ? $q['points'] : 0;
}
function update_answers(array $r,array $data): void {
    $answers=decode($r['answers_json']); $valid=array_column(decode($r['snapshot_json'])['questions'],'id'); $incoming=$data['answers'] ?? [];
    if (!is_array($incoming)) throw new ApiError('答案格式无效。');
    foreach ($incoming as $id=>$a) {
        if (!in_array($id,$valid,true) || !(is_null($a) || is_string($a) || is_numeric($a) || is_array($a)) || strlen(j($a))>160000) throw new ApiError('答案题号或内容无效。');
        if (is_array($a)) { if (!array_is_list($a) || count($a)>26) throw new ApiError('多选答案无效。'); foreach ($a as $v) strval_checked($v,'多选答案',20); }
        $answers[$id]=$a;
    }
    $flags=$data['flags'] ?? decode($r['flags_json']);
    if (!is_array($flags) || !array_is_list($flags)) throw new ApiError('标记格式无效。');
    foreach ($flags as $id) if (!is_string($id) || !in_array($id,$valid,true)) throw new ApiError('标记题号无效。');
    sql('UPDATE attempts SET answers_json=?,flags_json=? WHERE id=?',[j((object)$answers),j(array_values(array_unique($flags))),$r['id']]);
}
function submit_attempt(array $r): void {
    if ($r['status']!=='active') return; $answers=decode($r['answers_json']); $grades=[];
    foreach (decode($r['snapshot_json'])['questions'] as $q) {
        $a=$answers[$q['id']] ?? null;
        if (!$q['manual'] || blank($a)) $grades[$q['id']]=['score'=>blank($a)?0:objective_score($q,$a),'feedback'=>blank($a)?'未作答。':'按参考答案自动评分。','grader'=>'auto'];
    }
    sql("UPDATE attempts SET status='submitted',submitted_at=?,grades_json=? WHERE id=?",[stamp(),j((object)$grades),$r['id']]);
}
function expire_attempts(): void {
    foreach (sql("SELECT * FROM attempts WHERE status='active' AND deadline<=?".(mysql_mode() && db()->inTransaction()?' FOR UPDATE':''),[stamp()])->fetchAll() as $r) submit_attempt($r);
}
function attempt_result(array $r,bool $admin=false): array {
    $snap=decode($r['snapshot_json']); $p=$snap['paper']; $qs=$snap['questions'];
    $answers=decode($r['answers_json']); $flags=decode($r['flags_json']); $grades=decode($r['grades_json']);
    $submitted=$r['status']!=='active'; $reveal=$submitted && ($admin || $r['released']);
    $a=[]; foreach (['id','paper_id','student_name','started_at','deadline','status','submitted_at'] as $k) $a[$k]=$r[$k];
    $a+=['subject_code'=>$p['subject_code'],'subject_name'=>array_column(subjects(),'name','code')[$p['subject_code']],'paper_title'=>$p['title'],'max_score'=>$p['max_score'],'minutes'=>$p['minutes'],'auto_score'=>0,'manual_score'=>0,'total_score'=>0,'pending_manual'=>0,'released'=>(bool)$r['released']];
    $responses=[];
    foreach ($qs as $q) {
        $g=$grades[$q['id']] ?? []; $a[$q['manual']?'manual_score':'auto_score']+=$g['score'] ?? 0;
        if ($submitted && $q['manual'] && !isset($g['score'])) $a['pending_manual']++;
        $responses[$q['id']]=['answer'=>$answers[$q['id']] ?? null,'flagged'=>in_array($q['id'],$flags,true)]+($reveal?$g:[]);
    }
    $a['total_score']=$a['auto_score']+$a['manual_score'];
    if (!$admin && !$reveal) foreach (['auto_score','manual_score','total_score','pending_manual'] as $k) $a[$k]=null;
    return ['attempt'=>$a,'paper'=>$p,'questions'=>array_map(fn($q)=>public_question($q,$reveal),$qs),'responses'=>(object)$responses,'server_time'=>stamp()];
}
function initialize(): void {
    if (mysql_mode()) {
        foreach (explode(';',file_get_contents(__DIR__.'/schema.mysql.sql')) as $statement) if (trim($statement)) db()->exec($statement);
    } else {
    db()->exec('PRAGMA journal_mode=WAL');
    db()->exec(file_get_contents(__DIR__.'/schema.sql'));
    $cols=array_column(sql('PRAGMA table_info(attempts)')->fetchAll(),'name');
    if (!in_array('released',$cols)) db()->exec('ALTER TABLE attempts ADD COLUMN released INTEGER NOT NULL DEFAULT 0');
    if (!in_array('owner_hash',$cols)) db()->exec("ALTER TABLE attempts ADD COLUMN owner_hash TEXT NOT NULL DEFAULT ''");
    if (!in_array('payload_json',array_column(sql('PRAGMA table_info(jobs)')->fetchAll(),'name'))) db()->exec("ALTER TABLE jobs ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'");
    }
    transaction(function() {
        foreach (['seed_language.json','seed_science.json'] as $f) foreach (decode(file_get_contents(ROOT.'/'.$f)) as $p) {
            if (!sql('SELECT id FROM papers WHERE id=?',[$p['id']])->fetch()) save_paper($p['id'],$p,'published');
        }
    });
}
