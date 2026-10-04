<?php
declare(strict_types=1);
if (PHP_SAPI!=='cli') exit;
$v=parse_ini_file('/etc/environment',false,INI_SCANNER_RAW);
try {
    $db=new PDO('mysql:host='.$v['MYSQL_HOST'].';charset=utf8mb4',$v['MYSQL_USER'],$v['MYSQL_PASS'],[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
    $db->exec('CREATE DATABASE IF NOT EXISTS exam_practice CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
    echo "Database prepared.\n";
} catch(Throwable) { fwrite(STDERR,"Could not prepare database; details withheld to protect credentials.\n"); exit(1); }
