<?php
declare(strict_types=1);
if (PHP_SAPI!=='cli') { http_response_code(404); exit; }
require_once __DIR__.'/ai.php';
require_once __DIR__.'/scans.php';
// One worker per installation. A crashed process releases this OS lock automatically.
$lock=fopen(ROOT.'/.worker.lock','c');
if (!$lock || !flock($lock,LOCK_EX|LOCK_NB)) exit;
sql("UPDATE jobs SET status='failed',error='后台进程中断，未完成任务已停止，请手动重试。',updated_at=? WHERE status='running'",[stamp()]);
$once=in_array('--once',$argv,true);
do {
    transaction(fn()=>expire_attempts());
    $job=transaction(function() {
        $r=sql("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1".(mysql_mode()?' FOR UPDATE':''))->fetch();
        if ($r) job_update($r['id'],['status'=>'running','message'=>'任务开始…']); return $r;
    });
    if (!$job) { if ($once) break; sleep(2); continue; }
    try {
        $result=match($job['type']) { 'generate'=>generate_job($job), 'ocr'=>recognize_scan($job), default=>grade_job($job) };
        job_update($job['id'],['status'=>'completed','progress'=>100,'message'=>'已完成。','result'=>$result]);
    } catch (Throwable $e) {
        $safe=$e instanceof ApiError ? $e->getMessage() : '任务处理失败，请检查后台服务日志。';
        job_update($job['id'],['status'=>'failed','message'=>'任务未完成，可手动重试。','error'=>$safe]);
        if (!$e instanceof ApiError) error_log('Exam worker failure: '.get_class($e));
    }
} while (true);
