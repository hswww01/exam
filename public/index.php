<?php
declare(strict_types=1);
ini_set('display_errors','0');
require_once __DIR__.'/../php/api.php';
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
header('Cache-Control: no-store');
try {
    $base=rtrim(config()['EXAM_BASE_PATH'] ?? '','/');
    $path=rawurldecode(parse_url($_SERVER['REQUEST_URI'],PHP_URL_PATH) ?: '/');
    if ($base && $path===$base) { header('Location: '.$base.'/'); exit; }
    if ($base && !str_starts_with($path,$base.'/')) throw new ApiError('页面不存在。',404);
    $path=substr($path,strlen($base));
    $method=$_SERVER['REQUEST_METHOD'];
    if (str_starts_with($path,'/api/')) {
        header('Content-Type: application/json; charset=utf-8');
        if (!in_array($method,['GET','POST','PUT','DELETE'],true)) throw new ApiError('方法不允许。',405);
        if (isset($_SERVER['HTTP_ORIGIN'])) {
            $scheme=(!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS']!=='off')?'https':'http';
            $expected=$scheme.'://'.($_SERVER['HTTP_HOST'] ?? '');
            if ($_SERVER['HTTP_ORIGIN']!==$expected) throw new ApiError('不接受跨站请求。',403);
        }
        if (($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '')==='cross-site') throw new ApiError('不接受跨站请求。',403);
        $data=[];
        if (in_array($method,['POST','PUT'])) {
            if (strtolower(explode(';',$_SERVER['CONTENT_TYPE'] ?? '')[0])!=='application/json') throw new ApiError('请求须使用 application/json。',415);
            if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0)>2000000) throw new ApiError('请求内容过大。',413);
            $raw=file_get_contents('php://input',false,null,0,2000001);
            if (strlen($raw)>2000000) throw new ApiError('请求内容过大。',413);
            try { $obj=json_decode($raw ?: '{}',false,512,JSON_THROW_ON_ERROR); if (!$obj instanceof stdClass) throw new Exception(); $data=decode($raw ?: '{}'); }
            catch(Throwable) { throw new ApiError('JSON格式无效。'); }
        }
        echo j(api($method,$path,$_GET,$data)); exit;
    }
    if ($method!=='GET') throw new ApiError('方法不允许。',405);
    if (in_array($path,['/','/index.php','/admin','/admin/'])) {
        $file=str_starts_with($path,'/admin')?'admin.html':'index.html';
        $html=file_get_contents(__DIR__.'/'.$file);
        $html=str_replace(['<body','href="/app.css"','src="/app.js"','src="/scans.js"','href="/"'],['<body data-base="'.htmlspecialchars($base,ENT_QUOTES).'"','href="'.$base.'/app.css"','src="'.$base.'/app.js"','src="'.$base.'/scans.js"','href="'.$base.'/"'],$html);
        header('Content-Type: text/html; charset=utf-8'); echo $html; exit;
    }
    $allowed=in_array($path,['/app.css','/app.js','/scans.js']) || preg_match('~^/figures/[a-zA-Z0-9_-]+\.(svg|png|jpe?g|webp)$~D',$path);
    if (!$allowed || !is_file(__DIR__.$path)) throw new ApiError('页面不存在。',404);
    $mime=['css'=>'text/css','js'=>'application/javascript','svg'=>'image/svg+xml','png'=>'image/png','jpg'=>'image/jpeg','jpeg'=>'image/jpeg','webp'=>'image/webp'];
    header('Content-Type: '.$mime[pathinfo($path,PATHINFO_EXTENSION)]); readfile(__DIR__.$path);
} catch (ApiError $e) { http_response_code($e->status); header('Content-Type: application/json; charset=utf-8'); echo j(['error'=>$e->getMessage()]); }
catch (Throwable $e) { http_response_code(500); header('Content-Type: application/json; charset=utf-8'); error_log('Exam request failure: '.get_class($e)); echo j(['error'=>'服务暂时不可用，请联系家长检查服务器配置。']); }
