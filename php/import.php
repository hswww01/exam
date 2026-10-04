<?php
declare(strict_types=1);
if (PHP_SAPI!=='cli') exit;
require_once __DIR__.'/core.php';
$file=$argv[1] ?? ROOT.'/.migration.json';
$data=decode(file_get_contents($file));
transaction(function()use($data) {
    if (sql("SELECT 1 FROM settings WHERE `key`='imported_python'")->fetch()) { echo "Already imported.\n"; return; }
    if ((int)sql('SELECT COUNT(*) FROM attempts')->fetchColumn()>0) throw new ApiError('目标数据库已有考试记录，停止导入以避免覆盖。');
    foreach ($data['papers'] as $p) {
        $qs=[]; foreach ($data['questions'] as $q) if ($q['paper_id']===$p['id']) $qs[]=decode($q['data_json']);
        save_paper($p['id'],decode($p['metadata_json'])+['questions'=>$qs],$p['status']);
    }
    foreach ($data['attempts'] as $r) {
        // Legacy attempts have no browser owner; retain them for parent review only.
        $keys=['id','paper_id','student_name','started_at','deadline','status','submitted_at','snapshot_json','answers_json','flags_json','grades_json'];
        sql('INSERT INTO attempts('.implode(',',$keys).') VALUES('.implode(',',array_fill(0,count($keys),'?')).')',array_map(fn($k)=>$r[$k],$keys));
    }
    foreach ($data['grade_history'] as $r) sql('INSERT INTO grade_history(attempt_id,question_id,grade_json,created_at) VALUES(?,?,?,?)',[$r['attempt_id'],$r['question_id'],$r['grade_json'],$r['created_at']]);
    sql("INSERT INTO settings(`key`,value) VALUES('imported_python','1')");
});
echo "Import finished.\n";
