<?php
declare(strict_types=1);
require_once __DIR__.'/core.php';
function ai_status(): array {
    $c=config(); return ['configured'=>!empty($c['OPENAI_API_KEY']),'model'=>$c['OPENAI_MODEL'] ?? 'gpt-6-luna','service_tier'=>'flex','base_url'=>$c['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1'];
}
function object_schema(array $props): array { return ['type'=>'object','properties'=>$props,'required'=>array_keys($props),'additionalProperties'=>false]; }
function ai_request(string $kind,array $payload,?array $vision=null): object {
    $c=config(); if (empty($c['OPENAI_API_KEY'])) throw new ApiError('尚未配置 API key。',503);
    $base=rtrim($c['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1','/');
    if (!str_starts_with($base,'https://')) throw new ApiError('AI 服务地址须使用 HTTPS。');
    $string=['type'=>'string'];
    $schema=$kind==='generate' ? object_schema(['questions'=>['type'=>'array','items'=>object_schema(['label'=>$string,'stem'=>$string,'passage'=>$string,'options'=>['type'=>'array','items'=>$string],'answer'=>$string,'rubric'=>$string,'explanation'=>$string])]]) : object_schema(['grades'=>['type'=>'array','items'=>object_schema(['question_id'=>$string,'score'=>['type'=>'number'],'feedback'=>$string])]]);
    $prompts=decode(file_get_contents(__DIR__.'/prompts.json'));
    $body=['model'=>$c['OPENAI_MODEL'] ?? 'gpt-6-luna','instructions'=>$prompts[$kind==='generate'?'GENERATE_INSTRUCTIONS':'GRADE_INSTRUCTIONS'],'input'=>j($payload),'store'=>false,'service_tier'=>'flex','max_output_tokens'=>16000,'text'=>['format'=>['type'=>'json_schema','name'=>$kind==='generate'?'exam_questions':'exam_grades','strict'=>true,'schema'=>$schema]]];
    if ($vision) {
        $body['instructions']=$vision['instructions'];
        $body['text']['format']['schema']=$vision['schema'];
        $body['text']['format']['name']='paper_transcription';
        $body['input']=[['role'=>'user','content'=>[['type'=>'input_text','text'=>j($payload)],['type'=>'input_image','image_url'=>$vision['image'],'detail'=>'high']]]];
    }
    if (preg_match('/^(gpt-[56]|o[34])/',$body['model'])) $body['reasoning']=['effort'=>$c['OPENAI_REASONING_EFFORT'] ?? 'medium'];
    $ch=curl_init($base.'/responses'); $request=(object)['handle'=>$ch,'raw'=>'','tooLarge'=>false];
    curl_setopt_array($ch,[CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>j($body),CURLOPT_HTTPHEADER=>['Content-Type: application/json','Authorization: Bearer '.$c['OPENAI_API_KEY']],CURLOPT_CONNECTTIMEOUT=>15,CURLOPT_TIMEOUT=>max(900,min(1800,(int)($c['OPENAI_TIMEOUT'] ?? 900))),CURLOPT_FOLLOWLOCATION=>false,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_WRITEFUNCTION=>function($ch,$chunk)use($request){ if (strlen($request->raw)+strlen($chunk)>8000000) { $request->tooLarge=true; return 0; } $request->raw.=$chunk; return strlen($chunk); }]);
    if (!empty($c['OPENAI_PROXY'])) curl_setopt($ch,CURLOPT_PROXY,$c['OPENAI_PROXY']);
    return $request;
}
function ai_call(string $kind,array $payload,?array $vision=null): array {
    $request=ai_request($kind,$payload,$vision);
    return ai_finish($request,curl_exec($request->handle)!==false);
}
function ai_finish(object $request,bool $ok): array {
    $ch=$request->handle; $raw=$request->raw; $tooLarge=$request->tooLarge;
    $code=curl_getinfo($ch,CURLINFO_RESPONSE_CODE);
    $errno=curl_errno($ch); $elapsed=curl_getinfo($ch,CURLINFO_TOTAL_TIME); $connected=curl_getinfo($ch,CURLINFO_CONNECT_TIME); $tls=curl_getinfo($ch,CURLINFO_APPCONNECT_TIME);
    curl_close($ch);
    if ($ok===false) {
        error_log('Exam AI transport '.j(['errno'=>$errno,'http'=>$code,'seconds'=>round($elapsed,2),'connect_seconds'=>$connected,'tls_seconds'=>$tls,'bytes'=>strlen($raw),'size_limit'=>$tooLarge]));
        $message=$tooLarge?'AI 响应超过8MB限制，已停止接收。':match($errno) {
            5,6=>'AI 服务或代理域名解析失败，请检查服务器 DNS。',
            7=>'服务器无法连接 AI 服务或代理，请检查网络出口。',
            28=>$connected<=0?'连接 AI 服务超时（尚未建立连接），请检查服务器网络出口或代理。':'AI 请求等待超时，请稍后手动重试。',
            35,60=>'AI 连接的 TLS 握手或证书校验失败，请检查服务器证书与代理配置。',
            default=>'AI 网络传输失败（错误码 '.$errno.'），请检查后台日志。'
        };
        throw new ApiError($message,503);
    }
    if ($code>=400) throw new ApiError([401=>'API key 无效或失效。',403=>'当前 key 没有模型权限。',404=>'模型或 API 地址不存在。',429=>'Flex 资源暂不可用、额度不足或请求过于频繁；请稍后手动重试。'][$code] ?? "AI 服务返回 HTTP {$code}，请稍后重试。",503);
    try { $r=decode($raw); } catch(Throwable) { throw new ApiError('AI 响应无法解析。',503); }
    if (isset($r['status']) && $r['status']!=='completed') throw new ApiError('AI 响应未完成，未保存不完整结果。',503);
    $text=''; foreach ($r['output'] ?? [] as $item) if (($item['type'] ?? '')==='message') foreach ($item['content'] ?? [] as $content) {
        if (($content['type'] ?? '')==='refusal') throw new ApiError('AI 拒绝处理本次请求，请调整内容。',503);
        if (($content['type'] ?? '')==='output_text') $text.=$content['text'] ?? '';
    }
    try { return decode($text); } catch(Throwable) { throw new ApiError('AI 未返回有效结构化结果。',503); }
}
function job_update(string $id,array $fields): void {
    if (isset($fields['result'])) { $fields['result_json']=j($fields['result']); unset($fields['result']); }
    $fields['updated_at']=stamp();
    $allowed=['status','progress','message','result_json','error','updated_at'];
    foreach (array_keys($fields) as $key) if (!in_array($key,$allowed,true)) throw new LogicException('Invalid job field');
    sql('UPDATE jobs SET '.implode(',',array_map(fn($k)=>$k.'=?',array_keys($fields))).' WHERE id=?',[...array_values($fields),$id]);
}
function create_job(string $kind,string $target,array $data): string {
    if (!ai_status()['configured']) throw new ApiError('请先配置 API key。',503);
    return transaction(function()use($kind,$target,$data) {
        // Serialize enqueue operations using a shared row, including empty queues.
        sql("SELECT value FROM settings WHERE `key`='queue_lock'".(mysql_mode()?' FOR UPDATE':''))->fetch();
        if ($kind==='ocr') {
            $scan=sql('SELECT attempt_id FROM paper_scans WHERE id=?'.(mysql_mode()?' FOR UPDATE':''),[$target])->fetch();
            if (!$scan || $scan['attempt_id']) throw new ApiError('答卷不存在或已经确认。',409);
        }
        $existing=sql("SELECT id FROM jobs WHERE type=? AND target_id=? AND status IN ('queued','running')",[$kind,$target])->fetchColumn();
        if ($existing) return $existing;
        if ((int)sql("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')")->fetchColumn()>=4) throw new ApiError('已有4个 AI 任务，请等待完成。',429);
        $id=uid();
        sql("INSERT INTO jobs(id,type,target_id,status,progress,message,result_json,error,created_at,updated_at,payload_json) VALUES(?,?,?,'queued',0,?,'{}','',?,?,?)",[$id,$kind,$target,'已加入队列，等待后台处理。',stamp(),stamp(),j((object)$data)]);
        return $id;
    });
}
function generation_checkpoint(string $id,array $checkpoint): void {
    $upsert=mysql_mode()?' ON DUPLICATE KEY UPDATE value=VALUES(value)':' ON CONFLICT(`key`) DO UPDATE SET value=excluded.value';
    sql("INSERT INTO settings(`key`,value) VALUES(?,?)".$upsert,['generation_'.$id,j($checkpoint)]);
}
function generation_items(array $batch,array $response): array {
    $items=$response['questions'] ?? []; $generated=[];
    if (!is_array($items) || count($items)!==count($batch)) throw new ApiError('AI 返回题数不匹配，该批未保存。');
    foreach ($batch as $n=>$slot) {
        $item=$items[$n]; if (!is_array($item) || ($item['label'] ?? null)!==$slot['label']) throw new ApiError('AI 返回题号不匹配，该批未保存。');
        foreach (['stem','passage','options','answer','rubric','explanation'] as $k) {
            if (!array_key_exists($k,$item)) throw new ApiError('AI 返回字段不完整。');
            $slot[$k]=$item[$k];
        }
        if (!is_string($slot['stem']) || !trim($slot['stem']) || !is_array($slot['options'])) throw new ApiError('AI 题目格式无效。');
        $slot['id']=uid(); unset($slot['figure'],$slot['figure_alt']);
        if ($slot['kind']==='multi' && is_string($slot['answer'])) $slot['answer']=preg_split('/[,，\s]+/u',$slot['answer'],-1,PREG_SPLIT_NO_EMPTY);
        $generated[]=$slot;
    }
    return $generated;
}
function generate_job(array $job): array {
    $stored=sql("SELECT value FROM settings WHERE `key`=?",['generation_'.$job['id']])->fetchColumn();
    if ($stored) $cp=decode($stored);
    else {
        [$p,$qs]=get_paper($job['target_id']); $batches=[];
        foreach ($qs as $q) {
            $last=count($batches)-1; $prev=$last>=0?end($batches[$last]):null;
            $short=in_array($q['kind'],['choice','multi','number']);
            $limit=$short && $last>=0 && !array_filter($batches[$last],fn($x)=>!in_array($x['kind'],['choice','multi','number']))?6:4;
            if ($prev && $q['section']===$prev['section'] && ((!empty($q['passage']) && $q['passage']===$prev['passage']) || (empty($q['passage']) && empty($prev['passage']) && count($batches[$last])<$limit))) $batches[$last][]=$q;
            else $batches[]=[$q];
        }
        $cp=['paper'=>$p,'batches'=>$batches,'done'=>[],'paper_id'=>uid()]; generation_checkpoint($job['id'],$cp);
    }
    if (sql('SELECT 1 FROM papers WHERE id=?',[$cp['paper_id']])->fetchColumn()) return ['paper_id'=>$cp['paper_id']];
    $p=$cp['paper']; $data=decode($job['payload_json']);$total=count($cp['batches']);
    $todo=[];foreach($cp['batches'] as $i=>$batch)if(!isset($cp['done'][$i]))$todo[]=$i;
    $multi=curl_multi_init();$running=[];$errors=[];
    try {
        while ($todo || $running) {
            while (!$errors && $todo && count($running)<3) {
                $i=array_shift($todo);
                $r=ai_request('generate',['subject'=>array_column(subjects(),'name','code')[$p['subject_code']],'scope'=>($data['scope'] ?? '')?:$p['scope'],'difficulty'=>$data['difficulty'] ?? '标准','blueprint'=>$p['blueprint'],'slots_and_examples'=>$cp['batches'][$i]]);
                curl_multi_add_handle($multi,$r->handle);$running[spl_object_id($r->handle)]=[$i,$r];
            }
            if(!$running)break;
            job_update($job['id'],['progress'=>(int)(count($cp['done'])/max(1,$total)*95),'message'=>'本套试卷已完成 '.count($cp['done']).'/'.$total.' 批，'.count($running).' 批生成中（Flex）。']);
            do {$rc=curl_multi_exec($multi,$active);}while($rc===CURLM_CALL_MULTI_PERFORM);
            if($rc!==CURLM_OK)throw new ApiError('并行请求调度失败，已完成批次已保存。');
            while($info=curl_multi_info_read($multi)) {
                $key=spl_object_id($info['handle']);[$i,$r]=$running[$key];
                curl_multi_remove_handle($multi,$r->handle);unset($running[$key]);
                try {
                    $items=generation_items($cp['batches'][$i],ai_finish($r,$info['result']===CURLE_OK));
                    // Validate this batch against its own point totals before checkpointing.
                    $batchPaper=$p; $sections=[];foreach($items as $q)$sections[$q['section']]=($sections[$q['section']] ?? 0)+$q['points'];
                    $batchPaper['max_score']=array_sum($sections);$batchPaper['blueprint']=array_map(fn($section,$points)=>['section'=>$section,'points'=>$points],array_keys($sections),array_values($sections));
                    $batchPaper['questions']=$items;normalize_paper($batchPaper,true);
                    $cp['done'][$i]=$items; generation_checkpoint($job['id'],$cp);
                }catch(ApiError $e){$errors[]='第'.($i+1).'批：'.$e->getMessage();}
            }
            if($running && curl_multi_select($multi,1.0)===-1)usleep(10000);
        }
    } finally {foreach($running as [$i,$r]){curl_multi_remove_handle($multi,$r->handle);curl_close($r->handle);}curl_multi_close($multi);}
    if($errors)throw new ApiError('已保存 '.count($cp['done']).'/'.$total.' 批。'.implode('；',$errors).' 可继续未完成批次。',503);
    $generated=[];foreach($cp['batches'] as $i=>$batch)array_push($generated,...$cp['done'][$i]);
    $p['title']=($data['title'] ?? '')?:$p['title'].' · AI新卷';$p['scope']=($data['scope'] ?? '')?:$p['scope'];
    $p['description']='AI原创练习草稿；请审核后发布。';$p['source_note']='AI生成，模型 '.ai_status()['model'].'。';$p['questions']=$generated;
    normalize_paper($p,true);transaction(fn()=>save_paper($cp['paper_id'],$p));return ['paper_id'=>$cp['paper_id']];
}
function grade_job(array $job): array {
    $r=get_attempt($job['target_id']); $snap=decode($r['snapshot_json']); $answers=decode($r['answers_json']); $old=decode($r['grades_json']);
    $pending=array_values(array_filter($snap['questions'],fn($q)=>$q['manual'] && !isset($old[$q['id']]['score']))); $result=[];
    foreach (array_chunk($pending,4) as $i=>$batch) {
        job_update($job['id'],['progress'=>(int)($i*4/max(1,count($pending))*95),'message'=>'正在评阅第'.($i*4+1).'组主观题…']);
        $input=array_map(fn($q)=>$q+['question_id'=>$q['id'],'student_answer'=>$answers[$q['id']] ?? ''],$batch);
        $v=ai_call('grade',['subject'=>array_column(subjects(),'name','code')[$snap['paper']['subject_code']],'questions'=>$input]);
        $marks=$v['grades'] ?? []; $valid=array_column($batch,null,'id'); $seen=[];
        if (!is_array($marks) || count($marks)!==count($batch)) throw new ApiError('AI 评分数量不完整，未写入分数。');
        foreach ($marks as $mark) {
            $id=$mark['question_id'] ?? ''; if (!isset($valid[$id]) || isset($seen[$id])) throw new ApiError('AI 返回重复或无效题号。'); $seen[$id]=true;
            $score=finite($mark['score'] ?? null,'AI分数',0,$valid[$id]['points']); if (abs($score*2-round($score*2))>1e-6) throw new ApiError('AI 分数不是0.5分的整数倍。');
            $feedback=strval_checked($mark['feedback'] ?? null,'AI评语',10000,true);
            $result[$id]=['score'=>$score,'feedback'=>$feedback,'grader'=>'ai','ai_score'=>$score,'ai_feedback'=>$feedback];
        }
    }
    transaction(function()use($job,$result) {
        $row=get_attempt($job['target_id']); $grades=decode($row['grades_json']);
        foreach ($result as $qid=>$mark) if (!isset($grades[$qid]['score'])) {
            $grades[$qid]=$mark; sql('INSERT INTO grade_history(attempt_id,question_id,grade_json,created_at) VALUES(?,?,?,?)',[$row['id'],$qid,j($mark),stamp()]);
        }
        sql('UPDATE attempts SET grades_json=? WHERE id=?',[j((object)$grades),$row['id']]);
        $options=decode($job['payload_json']);
        if ($options['auto_release'] ?? grading_settings()['auto_release']) release_if_complete($row['id']);
    });
    return ['attempt_id'=>$r['id']];
}
