<?php
declare(strict_types=1);
if (PHP_SAPI!=='cli') exit;
require_once __DIR__.'/core.php';
$indexes=[
 ['attempts','idx_attempts_owner_time','owner_hash,started_at,id'],
 ['attempts','idx_attempts_time','started_at,id'],
 ['attempts','idx_attempts_deadline','status,deadline'],
 ['papers','idx_papers_status_time','status,created_at,id'],
 ['papers','idx_papers_subject_time','subject_code,status,created_at,id'],
 ['students','idx_students_time','created_at,id'],
 ['paper_scans','idx_scans_time','created_at,id'],
 ['jobs','idx_jobs_target_time','type,target_id,created_at,id']
];
foreach ($indexes as [$table,$name,$columns]) {
    if (mysql_mode()) {
        if (sql('SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name=?',[$table,$name])->fetchColumn()) continue;
        db()->exec("CREATE INDEX $name ON $table ($columns)");
    } else db()->exec("CREATE INDEX IF NOT EXISTS $name ON $table ($columns)");
}
echo "List indexes ready.\n";
