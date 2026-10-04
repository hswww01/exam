<?php
declare(strict_types=1);
require_once __DIR__.'/core.php';
function ai_status(): array {
    $c=config(); return ['configured'=>!empty($c['OPENAI_API_KEY']),'model'=>$c['OPENAI_MODEL'] ?? 'gpt-6-luna','service_tier'=>'flex','base_url'=>$c['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1'];
}
function object_schema(array $props): array { return ['type'=>'object','properties'=>$props,'required'=>array_keys($props),'additionalProperties'=>false]; }
function ai_call(string $kind,array $payload,?array $vision=null): array {
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
    $ch=curl_init($base.'/responses'); $raw='';
    curl_setopt_array($ch,[CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>j($body),CURLOPT_HTTPHEADER=>['Content-Type: application/json','Authorization: Bearer '.$c['OPENAI_API_KEY']],CURLOPT_CONNECTTIMEOUT=>15,CURLOPT_TIMEOUT=>max(900,min(1800,(int)($c['OPENAI_TIMEOUT'] ?? 900))),CURLOPT_FOLLOWLOCATION=>false,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_WRITEFUNCTION=>function($ch,$chunk)use(&$raw){ if (strlen($raw)+strlen($chunk)>8000000) return 0; $raw.=$chunk; return strlen($chunk); }]);
    $ok=curl_exec($ch); $code=curl_getinfo($ch,CURLINFO_RESPONSE_CODE); curl_close($ch);
    if ($ok===false) throw new ApiError('AI 请求超时、连接失败或响应过大，请检查网络后重试。',503);
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
function generate_job(array $job): array {
    [$p,$qs]=get_paper($job['target_id']); $data=decode($job['payload_json']); $batches=[];
    foreach ($qs as $q) {
        $last=count($batches)-1; $prev=$last>=0 ? end($batches[$last]) : null;
        if ($prev && ((!empty($q['passage']) && $q['passage']===$prev['passage']) || (empty($q['passage']) && empty($prev['passage']) && $q['section']===$prev['section'] && count($batches[$last])<4))) $batches[$last][]=$q;
        else $batches[]=[$q];
    }
    $generated=[];
    foreach ($batches as $i=>$batch) {
        job_update($job['id'],['progress'=>(int)($i/count($batches)*90),'message'=>'正在编写第'.($i+1).'/'.count($batches).'组题目…']);
        $r=ai_call('generate',['subject'=>array_column(subjects(),'name','code')[$p['subject_code']],'scope'=>($data['scope'] ?? '') ?: $p['scope'],'difficulty'=>$data['difficulty'] ?? '标准','blueprint'=>$p['blueprint'],'slots_and_examples'=>$batch]);
        $items=$r['questions'] ?? [];
        if (!is_array($items) || count($items)!==count($batch)) throw new ApiError('AI 返回题数不匹配，未保存。');
        foreach ($batch as $n=>$slot) {
            $item=$items[$n]; if (!is_array($item) || ($item['label'] ?? null)!==$slot['label']) throw new ApiError('AI 返回题号不匹配，未保存。');
            foreach (['stem','passage','options','answer','rubric','explanation'] as $k) $slot[$k]=$item[$k] ?? null;
            $slot['id']=uid(); unset($slot['figure'],$slot['figure_alt']);
            if ($slot['kind']==='multi' && is_string($slot['answer'])) $slot['answer']=preg_split('/[,，\s]+/u',$slot['answer'],-1,PREG_SPLIT_NO_EMPTY);
            $generated[]=$slot;
        }
    }
    $p['title']=($data['title'] ?? '') ?: $p['title'].' · AI新卷'; $p['scope']=($data['scope'] ?? '') ?: $p['scope'];
    $p['description']='AI原创练习草稿；请审核题意、答案与评分标准后发布。'; $p['source_note']='AI生成，模型 '.ai_status()['model'].'。沿用模板结构，尚未经人工审题。'; $p['questions']=$generated;
    normalize_paper($p,true); $id=uid(); transaction(fn()=>save_paper($id,$p)); return ['paper_id'=>$id];
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
    });
    return ['attempt_id'=>$r['id']];
}
