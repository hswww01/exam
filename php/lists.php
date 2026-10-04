<?php
declare(strict_types=1);
function page_query(string $from,string $fields,string $where,array $args,string $order,array $query): array {
    $size=(int)($query['page_size'] ?? 20); if (!in_array($size,[20,50,100])) $size=20;
    $total=(int)sql('SELECT COUNT(*) FROM '.$from.' WHERE '.$where,$args)->fetchColumn();
    $pages=max(1,(int)ceil($total/$size)); $page=max(1,min($pages,(int)($query['page'] ?? 1))); $offset=($page-1)*$size;
    $rows=sql('SELECT '.$fields.' FROM '.$from.' WHERE '.$where.' ORDER BY '.$order." LIMIT $size OFFSET $offset",$args)->fetchAll();
    return ['items'=>$rows,'pagination'=>['page'=>$page,'page_size'=>$size,'total'=>$total,'pages'=>$pages]];
}
function json_text(string $column,string $path): string { return mysql_mode()?"JSON_UNQUOTE(JSON_EXTRACT($column,'$.$path'))":"json_extract($column,'$.$path')"; }
function list_api(string $kind,array $query,bool $admin,string $owner): array {
    $where=['1=1']; $args=[]; $search=trim(strval_checked($query['search'] ?? '', '搜索',100));
    if ($kind==='papers') {
        $from='papers p';$fields="p.*, (SELECT COUNT(*) FROM questions q WHERE q.paper_id=p.id) AS question_count";$order='p.created_at DESC,p.id DESC';
        $where[]=$admin?"p.status!='archived'":"p.status='published'";
        if (!empty($query['subject'])) {$where[]='p.subject_code=?';$args[]=$query['subject'];}
        if ($admin && !empty($query['status'])) {$where[]='p.status=?';$args[]=$query['status'];}
        if ($search!=='') {$where[]=json_text('p.metadata_json','title').' LIKE ?';$args[]='%'.$search.'%';}
    } elseif ($kind==='attempts' || $kind==='unassigned') {
        if ($kind==='unassigned' && !$admin) throw new ApiError('请登录教师后台。',401);
        $from='attempts a';$fields='a.*';$order='a.started_at DESC,a.id DESC';
        if (!$admin) {$where[]='a.owner_hash=?';$args[]=$owner;}
        if ($kind==='unassigned') $where[]='NOT EXISTS (SELECT 1 FROM students s WHERE s.owner_key=a.owner_hash)';
        if (!empty($query['subject'])) {$where[]=json_text('a.snapshot_json','paper.subject_code').'=?';$args[]=$query['subject'];}
        $status=$query['status'] ?? '';
        if ($status==='active') $where[]="a.status='active'";
        if ($status==='pending') $where[]="a.status!='active' AND a.released=0";
        if ($status==='done') $where[]="a.status!='active' AND a.released=1";
        if ($search!=='') {$where[]='(a.student_name LIKE ? OR '.json_text('a.snapshot_json','paper.title').' LIKE ? OR EXISTS (SELECT 1 FROM students s WHERE s.owner_key=a.owner_hash AND s.username LIKE ?))';array_push($args,...array_fill(0,3,'%'.$search.'%'));}
    } elseif ($kind==='students') {
        if (!$admin) throw new ApiError('请登录教师后台。',401);
        $from='students';$fields='id,username,name,class_name,enabled,created_at';$order='created_at DESC,id DESC';
        if ($search!=='') {$where[]='(username LIKE ? OR name LIKE ? OR class_name LIKE ?)';array_push($args,...array_fill(0,3,'%'.$search.'%'));}
        if (isset($query['enabled']) && $query['enabled']!=='') {$where[]='enabled=?';$args[]=(int)$query['enabled'];}
    } elseif ($kind==='scans') {
        if (!$admin) throw new ApiError('请登录教师后台。',401);
        $from='paper_scans';$fields='id,paper_title,student_name,status,attempt_id,created_at';$order='created_at DESC,id DESC';
        if ($search!=='') {$where[]='(student_name LIKE ? OR paper_title LIKE ?)';array_push($args,...array_fill(0,2,'%'.$search.'%'));}
        if (!empty($query['status'])) {$where[]='status=?';$args[]=$query['status'];}
    } else throw new ApiError('列表不存在。',404);
    $out=page_query($from,$fields,implode(' AND ',$where),$args,$order,$query);
    if ($kind==='papers') $out['items']=array_map(function($r){$p=decode($r['metadata_json']);foreach(['id','status','created_at','updated_at','question_count'] as $k)$p[$k]=$r[$k];return $p;},$out['items']);
    if ($kind==='attempts' || $kind==='unassigned') $out['items']=array_map(fn($r)=>attempt_result($r,$admin)['attempt'],$out['items']);
    return $out;
}
