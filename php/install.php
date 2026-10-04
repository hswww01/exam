<?php
declare(strict_types=1);
if (PHP_SAPI!=='cli') { http_response_code(404); exit; }
require_once __DIR__.'/core.php';
initialize();
require_once __DIR__.'/list_indexes.php';
if (!sql("SELECT 1 FROM settings WHERE `key`='queue_lock'")->fetch()) sql("INSERT INTO settings(`key`,value) VALUES('queue_lock','1')");
if (!sql("SELECT 1 FROM settings WHERE `key`='php_admin_password'")->fetch() && !sql("SELECT 1 FROM settings WHERE `key`='setup_code_hash'")->fetch()) {
    $code=bin2hex(random_bytes(16));
    sql("INSERT INTO settings(`key`,value) VALUES('setup_code_hash',?)",[hash('sha256',$code)]);
    file_put_contents(ROOT.'/.setup-code',$code.PHP_EOL); chmod(ROOT.'/.setup-code',0600);
}
echo "Installation ready. First-use setup code is in .setup-code (never under public/).\n";
