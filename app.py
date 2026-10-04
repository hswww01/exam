"""Local Beijing exam practice with SQLite and optional OpenAI background jobs."""
from __future__ import annotations
import hashlib
import secrets
import time
import argparse
import copy
import json
import math
import mimetypes
import os
import re
import sqlite3
import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
import ai_client

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DB_PATH = Path(os.environ.get("EXAM_DB_PATH", str(ROOT / "exam.db")))
TZ = timezone(timedelta(hours=8))
POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="exam-ai")
JOB_LOCK = threading.Lock()
AUTH_LOCK = threading.Lock()
SESSIONS = {}
LOGIN_FAILURES = []
SUBJECTS = [
    {"code":"chinese", "name":"语文", "full_score":100, "minutes":150, "external_score":0},
    {"code":"math", "name":"数学", "full_score":100, "minutes":120, "external_score":0},
    {"code":"english", "name":"英语", "full_score":60, "minutes":90, "external_score":40, "note":"听说机考40分另行考核"},
    {"code":"physics", "name":"物理", "full_score":70, "minutes":70, "external_score":10, "note":"实验操作10分另行考核"},
    {"code":"daofa", "name":"道德与法治", "full_score":70, "minutes":70, "external_score":10, "note":"开卷；综合素质评价10分另行计入"},
]
SUBJECT_MAP = {s["code"]: s for s in SUBJECTS}

def now(): return datetime.now(TZ)
def dumps(value): return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))

class APIError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status

@contextmanager
def db(write=False):
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        if write: conn.execute("BEGIN IMMEDIATE")
        with conn: yield conn
    finally: conn.close()

def text(value, name, limit=40000, required=False):
    if not isinstance(value, str) or len(value)>limit or (required and not value.strip()):
        raise APIError(f"{name}不能为空或长度超出限制。")
    return value

def finite(value, name, low=0, high=1000):
    if isinstance(value, bool): raise APIError(f"{name}必须是有效数值。")
    try: result = float(value)
    except (ValueError, TypeError): raise APIError(f"{name}必须是有效数值。") from None
    if not math.isfinite(result) or not low<=result<=high:
        raise APIError(f"{name}必须介于 {low:g} 和 {high:g} 之间。")
    return result

def normalize_paper(data, publish=False):
    if not isinstance(data, dict): raise APIError("试卷必须为 JSON 对象。")
    source = dict(data.get("paper", data))
    qs = data.get("questions", source.pop("questions", []))
    code = source.get("subject_code")
    if code not in SUBJECT_MAP: raise APIError("科目不存在。")
    paper = {"subject_code":code}
    for name in ("title", "scope", "description", "source_note"):
        paper[name] = text(source.get(name,""), name, 10000, name in ("title","scope"))
    paper["minutes"] = finite(source.get("minutes"), "考试时间", 1, 300)
    paper["max_score"] = finite(source.get("max_score"), "卷面满分", 1, 300)
    blueprint = source.get("blueprint", [])
    if not isinstance(blueprint,list) or len(blueprint)>30: raise APIError("分值结构格式错误。")
    paper["blueprint"] = []
    for b in blueprint:
        if not isinstance(b,dict): raise APIError("分值结构须包含 section 和 points。")
        paper["blueprint"].append({"section":text(b.get("section"),"分节名称",100,True), "points":finite(b.get("points"),"分节分数",.5,300)})
    if len({b["section"] for b in paper["blueprint"]})!=len(blueprint): raise APIError("分节名称不能重复。")
    if not isinstance(qs,list) or len(qs)>200: raise APIError("题目须为数组且不超过200题。")
    questions, ids, labels = [], set(), set()
    for i,item in enumerate(qs,1):
        if not isinstance(item,dict): raise APIError(f"第{i}题格式错误。")
        q = {"id":str(item.get("id") or uuid.uuid4().hex), "label":str(item.get("label") or i)}
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}",q["id"]) or q["id"] in ids or q["label"] in labels:
            raise APIError(f"第{i}题ID或题号无效、重复。")
        ids.add(q["id"]); labels.add(q["label"])
        q["kind"] = item.get("kind","text")
        if q["kind"] not in ("choice","multi","number","text","essay"): raise APIError(f"第{i}题题型无效。")
        for name in ("stem","section","passage","rubric","explanation"):
            q[name] = text(item.get(name,""),f"第{i}题{name}",40000,name in ("stem","section"))
        q["points"] = finite(item.get("points"),f"第{i}题分值",.5,100)
        q["manual"] = bool(item.get("manual")) or q["kind"] in ("text","essay")
        q["tolerance"] = finite(item.get("tolerance",0),"容差",0,1e9)
        q["partial_credit"] = finite(item.get("partial_credit",0),"多选部分分",0,q["points"])
        q["options"] = item.get("options",[])
        if not isinstance(q["options"],list) or len(q["options"])>26 or any(not isinstance(x,str) or len(x)>5000 for x in q["options"]):
            raise APIError(f"第{i}题选项格式无效。")
        q["answer"] = item.get("answer","")
        if not isinstance(q["answer"],(str,int,float,list)) or len(dumps(q["answer"]))>40000:
            raise APIError(f"第{i}题答案格式无效。")
        if isinstance(q["answer"],list) and any(not isinstance(x,str) for x in q["answer"]): raise APIError("答案数组必须为文本。")
        if item.get("figure"):
            figure = text(item["figure"],"图文件名",120)
            if not re.fullmatch(r"[a-zA-Z0-9_-]+\.(svg|png|jpg|jpeg|webp)",figure): raise APIError("配图须为figures目录中的文件名。")
            q["figure"] = figure
            q["figure_alt"] = text(item.get("figure_alt","题目配图"),"配图说明",300)
        if publish:
            letters = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ"[:len(q["options"])])
            if q["kind"] in ("choice","multi") and len(letters)<2: raise APIError(f"第{i}题至少需要2个选项。")
            if q["kind"]=="choice" and q["answer"] not in list(letters): raise APIError(f"第{i}题单选答案无效。")
            if q["kind"]=="multi" and (not isinstance(q["answer"],list) or not q["answer"] or not set(q["answer"])<=letters or len(set(q["answer"]))!=len(q["answer"])):
                raise APIError(f"第{i}题多选答案无效。")
            if q["kind"]=="number": finite(q["answer"],f"第{i}题数值答案",-1e100,1e100)
            if q["manual"] and (not q["answer"] or not q["rubric"].strip()): raise APIError(f"第{i}题需要参考答案和评分标准。")
        questions.append(q)
    if publish:
        actual = sum(q["points"] for q in questions)
        if not questions or abs(actual-paper["max_score"])>1e-6:
            raise APIError(f"题目合计{actual:g}分，与卷面满分{paper['max_score']:g}分不一致。")
        totals = {}
        for q in questions: totals[q["section"]] = totals.get(q["section"],0)+q["points"]
        if totals!={b["section"]:b["points"] for b in paper["blueprint"]}: raise APIError("题目分节合计与分值结构不一致。")
    return paper,questions

def save_paper(conn,paper_id,data,status="draft"):
    paper,questions = normalize_paper(data,publish=status=="published")
    conn.execute("""INSERT INTO papers(id,subject_code,status,metadata_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET subject_code=excluded.subject_code,
      status=excluded.status,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at""",
      (paper_id,paper["subject_code"],status,dumps(paper),now().isoformat(),now().isoformat()))
    conn.execute("DELETE FROM questions WHERE paper_id=?",(paper_id,))
    conn.executemany("INSERT INTO questions(paper_id,id,seq,data_json) VALUES(?,?,?,?)",[(paper_id,q["id"],i,dumps(q)) for i,q in enumerate(questions)])
    return paper_id

def get_paper(conn,paper_id):
    row = conn.execute("SELECT * FROM papers WHERE id=?",(paper_id,)).fetchone()
    if not row: raise APIError("试卷不存在。",404)
    paper = json.loads(row["metadata_json"])
    paper.update({k:row[k] for k in ("id","status","created_at","updated_at")})
    qs = [json.loads(r[0]) for r in conn.execute("SELECT data_json FROM questions WHERE paper_id=? ORDER BY seq",(paper_id,))]
    paper["question_count"] = len(qs)
    return paper,qs

def list_papers(conn,all_papers=False,subject=None):
    rows = conn.execute("SELECT id FROM papers WHERE status!='archived'"+("" if all_papers else " AND status='published'")+" ORDER BY created_at DESC,id").fetchall()
    papers = [get_paper(conn,r[0])[0] for r in rows]
    return [p for p in papers if not subject or p["subject_code"]==subject]

def initialize():
    with db() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS papers(id TEXT PRIMARY KEY,subject_code TEXT NOT NULL,status TEXT NOT NULL,
          metadata_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS questions(paper_id TEXT NOT NULL REFERENCES papers(id),id TEXT NOT NULL,
          seq INTEGER NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(paper_id,id));
        CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,paper_id TEXT NOT NULL REFERENCES papers(id),
          student_name TEXT NOT NULL,started_at TEXT NOT NULL,deadline TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',
          submitted_at TEXT,snapshot_json TEXT NOT NULL,answers_json TEXT NOT NULL DEFAULT '{}',
          flags_json TEXT NOT NULL DEFAULT '[]',grades_json TEXT NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,type TEXT NOT NULL,target_id TEXT NOT NULL,status TEXT NOT NULL,
          progress INTEGER NOT NULL DEFAULT 0,message TEXT NOT NULL DEFAULT '',result_json TEXT NOT NULL DEFAULT '{}',
          error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS grade_history(id INTEGER PRIMARY KEY AUTOINCREMENT,attempt_id TEXT NOT NULL,
          question_id TEXT NOT NULL,grade_json TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_attempts_status ON attempts(status);
        """)
        conn.execute("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        if "released" not in {r[1] for r in conn.execute("PRAGMA table_info(attempts)")}:
            conn.execute("ALTER TABLE attempts ADD COLUMN released INTEGER NOT NULL DEFAULT 0")
        for filename in ("seed_language.json","seed_science.json"):
            for data in json.loads((ROOT/filename).read_text(encoding="utf-8-sig")):
                if not conn.execute("SELECT id FROM papers WHERE id=?",(data["id"],)).fetchone(): save_paper(conn,data["id"],data,"published")
        conn.execute("UPDATE jobs SET status='failed',error='服务已重启，未完成的任务已停止，可重新提交。',updated_at=? WHERE status IN ('queued','running')",(now().isoformat(),))

def public_question(q,reveal=False):
    return copy.deepcopy(q) if reveal else {k:copy.deepcopy(v) for k,v in q.items() if k not in ("answer","rubric","explanation","tolerance")}

def objective_score(q,answer):
    if answer is None or answer=="" or answer==[]: return 0
    if q["kind"]=="multi":
        if not isinstance(answer,list) or any(not isinstance(x,str) for x in answer): return 0
        given,key = set(answer),set(q["answer"])
        if len(given)!=len(answer): return 0
        return q["points"] if given==key else q.get("partial_credit",0) if given and given<key else 0
    if q["kind"]=="number":
        try:
            val,key = float(str(answer).strip()),float(q["answer"])
            return q["points"] if math.isfinite(val) and abs(val-key)<=q.get("tolerance",0)+1e-12 else 0
        except (ValueError,TypeError): return 0
    return q["points"] if str(answer).strip().upper()==str(q["answer"]).strip().upper() else 0

def get_attempt(conn,attempt_id):
    row = conn.execute("SELECT * FROM attempts WHERE id=?",(attempt_id,)).fetchone()
    if not row: raise APIError("考试记录不存在。",404)
    return row

def update_answers(conn,row,data):
    answers = json.loads(row["answers_json"])
    valid = {q["id"] for q in json.loads(row["snapshot_json"])["questions"]}
    incoming = data.get("answers",{})
    if not isinstance(incoming,dict): raise APIError("答案须为对象。")
    for qid,value in incoming.items():
        if qid not in valid: raise APIError("答案包含非本卷题目。")
        if value is not None and not isinstance(value,(str,int,float,list)): raise APIError("答案格式无效。")
        if isinstance(value,list) and (len(value)>26 or any(not isinstance(x,str) or len(x)>20 for x in value)): raise APIError("多选答案格式无效。")
        if len(dumps(value))>40000: raise APIError("单题答案过长。")
        answers[qid] = value
    flags = data.get("flags",json.loads(row["flags_json"]))
    if not isinstance(flags,list) or any(not isinstance(x,str) or x not in valid for x in flags): raise APIError("标记题目无效。")
    conn.execute("UPDATE attempts SET answers_json=?,flags_json=? WHERE id=?",(dumps(answers),dumps(list(dict.fromkeys(flags))),row["id"]))

def submit_attempt(conn,row):
    if row["status"]!="active": return
    answers = json.loads(row["answers_json"])
    grades = {}
    for q in json.loads(row["snapshot_json"])["questions"]:
        a = answers.get(q["id"])
        blank = a is None or a==[] or str(a).strip()==""
        if not q["manual"] or blank:
            grades[q["id"]] = {"score":0 if blank else objective_score(q,a),"feedback":"未作答。" if blank else "按参考答案自动评分。","grader":"auto"}
    conn.execute("UPDATE attempts SET status='submitted',submitted_at=?,grades_json=? WHERE id=?",(now().isoformat(),dumps(grades),row["id"]))

def expire_attempts(conn):
    for row in conn.execute("SELECT * FROM attempts WHERE status='active' AND deadline<=?",(now().isoformat(),)).fetchall(): submit_attempt(conn,row)

def attempt_result(row, admin=True):
    snapshot = json.loads(row["snapshot_json"])
    paper,qs = snapshot["paper"],snapshot["questions"]
    answers,flags,grades = json.loads(row["answers_json"]),json.loads(row["flags_json"]),json.loads(row["grades_json"])
    submitted = row["status"]!="active"
    reveal = submitted and (admin or bool(row["released"]))
    auto_score = sum((grades.get(q["id"],{}).get("score") or 0) for q in qs if not q["manual"])
    manual_score = sum((grades.get(q["id"],{}).get("score") or 0) for q in qs if q["manual"])
    a = {k:row[k] for k in ("id","paper_id","student_name","started_at","deadline","status","submitted_at")}
    a.update({"subject_code":paper["subject_code"],"subject_name":SUBJECT_MAP[paper["subject_code"]]["name"],
      "paper_title":paper["title"],"max_score":paper["max_score"],"minutes":paper["minutes"],
      "auto_score":auto_score,"manual_score":manual_score,"total_score":auto_score+manual_score,
      "pending_manual":sum(1 for q in qs if q["manual"] and grades.get(q["id"],{}).get("score") is None) if submitted else 0})
    a["released"] = bool(row["released"])
    if not admin and not reveal:
        for key in ("auto_score","manual_score","total_score","pending_manual"): a[key] = None
    responses = {q["id"]:{"answer":answers.get(q["id"]),"flagged":q["id"] in flags,**(grades.get(q["id"],{}) if reveal else {})} for q in qs}
    return {"attempt":a,"paper":paper,"questions":[public_question(q,reveal) for q in qs],"responses":responses,"server_time":now().isoformat()}

def list_attempts(conn,admin=True):
    return [attempt_result(row,admin)["attempt"] for row in conn.execute("SELECT * FROM attempts ORDER BY started_at DESC LIMIT 500")]

def job_update(job_id,**fields):
    if "result" in fields: fields["result_json"] = dumps(fields.pop("result"))
    fields["updated_at"] = now().isoformat()
    with db(True) as conn: conn.execute("UPDATE jobs SET "+",".join(k+"=?" for k in fields)+" WHERE id=?",[*fields.values(),job_id])

def generate_worker(job_id,template_id,data):
    with db() as conn: paper,questions = get_paper(conn,template_id)
    batches = []
    for q in questions:
        if batches and q.get("passage") and q.get("passage")==batches[-1][-1].get("passage"): batches[-1].append(q)
        elif batches and not q.get("passage") and not batches[-1][-1].get("passage") and q["section"]==batches[-1][-1]["section"] and len(batches[-1])<4: batches[-1].append(q)
        else: batches.append([q])
    generated = []
    for index,batch in enumerate(batches):
        job_update(job_id,progress=int(index/len(batches)*90),message=f"正在编写第{index+1}/{len(batches)}组题目…")
        value = ai_client.call_json(ai_client.GENERATE_INSTRUCTIONS,{"subject":SUBJECT_MAP[paper["subject_code"]]["name"],
          "scope":data.get("scope") or paper["scope"],"difficulty":data.get("difficulty","标准"),"blueprint":paper["blueprint"],"slots_and_examples":batch},ai_client.QUESTION_SCHEMA,"exam_questions")
        items = value.get("questions")
        if not isinstance(items,list) or len(items)!=len(batch): raise ai_client.AIError("AI返回题数不匹配，未生成不完整试卷。")
        for slot,item in zip(batch,items):
            if not isinstance(item,dict) or item.get("label")!=slot["label"]: raise ai_client.AIError("AI返回题号不匹配，未保存。")
            q = {**slot,**{k:item.get(k) for k in ("stem","passage","options","answer","rubric","explanation")},"id":uuid.uuid4().hex}
            q.pop("figure",None); q.pop("figure_alt",None)
            if q["kind"]=="multi" and isinstance(q["answer"],str): q["answer"] = [x for x in re.split(r"[,，\s]+",q["answer"]) if x]
            generated.append(q)
    new = {**paper,"title":data.get("title") or paper["title"]+" · AI新卷","scope":data.get("scope") or paper["scope"],
      "description":"AI原创练习草稿；请审核题意、答案与评分标准后发布。",
      "source_note":f"AI生成，模型 {ai_client.settings()['model']}。沿用模板的题型、分值和时长；尚未经人工审题。","questions":generated}
    normalize_paper(new,True)
    paper_id = uuid.uuid4().hex
    with db(True) as conn: save_paper(conn,paper_id,new)
    return {"paper_id":paper_id}

def grade_worker(job_id,attempt_id,data):
    with db() as conn: row = get_attempt(conn,attempt_id)
    snapshot,answers,old = json.loads(row["snapshot_json"]),json.loads(row["answers_json"]),json.loads(row["grades_json"])
    pending = [q for q in snapshot["questions"] if q["manual"] and old.get(q["id"],{}).get("score") is None]
    result = {}
    for offset in range(0,len(pending),4):
        batch = pending[offset:offset+4]
        job_update(job_id,progress=int(offset/len(pending)*95),message=f"正在评阅第{offset+1}—{offset+len(batch)}道主观题，共{len(pending)}道…")
        value = ai_client.call_json(ai_client.GRADE_INSTRUCTIONS,{"subject":SUBJECT_MAP[snapshot["paper"]["subject_code"]]["name"],
          "questions":[{**q,"question_id":q["id"],"student_answer":answers.get(q["id"],"")} for q in batch]},ai_client.GRADE_SCHEMA,"exam_grades")
        marks = value.get("grades",[])
        valid = {q["id"]:q for q in batch}
        if not isinstance(marks,list) or len(marks)!=len(batch): raise ai_client.AIError("AI评分数量不完整，未写入分数。")
        seen = set()
        for mark in marks:
            if not isinstance(mark,dict) or mark.get("question_id") not in valid or mark["question_id"] in seen: raise ai_client.AIError("AI返回重复或无效题号，未写入分数。")
            qid = mark["question_id"]; seen.add(qid)
            score = finite(mark.get("score"),"AI分数",0,valid[qid]["points"])
            if abs(score*2-round(score*2))>1e-6: raise ai_client.AIError("AI分数不是0.5分的整数倍，未写入分数。")
            feedback = text(mark.get("feedback"),"AI评语",10000,True)
            result[qid] = {"score":score,"feedback":feedback,"grader":"ai","ai_score":score,"ai_feedback":feedback}
    with db(True) as conn:
        grades = json.loads(get_attempt(conn,attempt_id)["grades_json"])
        for qid,mark in result.items():
            if grades.get(qid,{}).get("score") is None:
                grades[qid] = mark
                conn.execute("INSERT INTO grade_history(attempt_id,question_id,grade_json,created_at) VALUES(?,?,?,?)",(attempt_id,qid,dumps(mark),now().isoformat()))
        conn.execute("UPDATE attempts SET grades_json=? WHERE id=?",(dumps(grades),attempt_id))
    return {"attempt_id":attempt_id}

def run_job(job_id,kind,target,data):
    try:
        job_update(job_id,status="running",message="任务开始…")
        result = (generate_worker if kind=="generate" else grade_worker)(job_id,target,data)
        job_update(job_id,status="completed",progress=100,message="已完成。",result=result)
    except (ai_client.AIError,APIError) as exc:
        job_update(job_id,status="failed",error=str(exc),message="任务未完成，可检查配置后重试。")
    except Exception:
        traceback.print_exc()
        job_update(job_id,status="failed",error="处理AI结果时发生异常，未保存不完整结果。",message="任务失败。")

def create_job(kind,target,data):
    ai_client.require_key()
    with JOB_LOCK:
        with db(True) as conn:
            existing = conn.execute("SELECT id FROM jobs WHERE type=? AND target_id=? AND status IN ('queued','running')",(kind,target)).fetchone()
            if existing: return existing["id"]
            if conn.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]>=4: raise APIError("已有4个AI任务，请等待完成。",429)
            job_id = uuid.uuid4().hex
            conn.execute("INSERT INTO jobs(id,type,target_id,status,created_at,updated_at) VALUES(?,?,?,'queued',?,?)",(job_id,kind,target,now().isoformat(),now().isoformat()))
        POOL.submit(run_job,job_id,kind,target,copy.deepcopy(data))
    return job_id

class Handler(BaseHTTPRequestHandler):
    server_version = "ExamPractice/2.0"
    def log_message(self,fmt,*args): print(f"[{now():%H:%M:%S}] {fmt % args}")
    def send_json(self,value,status=200):
        body = dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Content-Length",str(len(body)))
        self.send_header("Cache-Control","no-store")
        self.send_header("X-Content-Type-Options","nosniff")
        self.end_headers(); self.wfile.write(body)
    def read_json(self):
        if self.headers.get_content_type()!="application/json": raise APIError("请求须使用 application/json。",415)
        try: size = int(self.headers.get("Content-Length","0"))
        except ValueError: raise APIError("请求长度无效。") from None
        if size<0 or size>2_000_000: raise APIError("请求内容过大。",413)
        try: value = json.loads(self.rfile.read(size) or b"{}",parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
        except (ValueError,UnicodeDecodeError): raise APIError("JSON格式无效。") from None
        if not isinstance(value,dict): raise APIError("请求须为JSON对象。")
        return value
    def dispatch(self,method):
        try:
            host = self.headers.get("Host","")
            if host not in {f"127.0.0.1:{self.server.server_port}",f"localhost:{self.server.server_port}"}: raise APIError("仅允许本机访问。",403)
            origin = self.headers.get("Origin")
            if origin and origin!="http://"+host: raise APIError("不接受跨站请求。",403)
            parsed = urlparse(self.path); path = unquote(parsed.path)
            data = self.read_json() if method in ("POST","PUT") else {}
            if method=="DELETE" and self.headers.get("Sec-Fetch-Site")=="cross-site": raise APIError("不接受跨站请求。",403)
            if not path.startswith("/api/"):
                if method!="GET": raise APIError("方法不允许。",405)
                return self.static_file(path)
            value,status = self.api(method,path,parse_qs(parsed.query),data)
            self.send_json(value,status)
        except APIError as exc: self.send_json({"error":str(exc)},exc.status)
        except ai_client.AIError as exc: self.send_json({"error":str(exc)},503)
        except (BrokenPipeError,ConnectionResetError): pass
        except Exception:
            traceback.print_exc()
            self.send_json({"error":"服务器处理失败，请查看本机日志后重试。"},500)
    def static_file(self,path):
        if path in ("/admin","/admin/"): path = "/admin.html"
        target = (STATIC/(path.lstrip("/") or "index.html")).resolve()
        if STATIC.resolve() not in target.parents or not target.is_file(): raise APIError("页面不存在。",404)
        body = target.read_bytes(); mime = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type",mime+("; charset=utf-8" if target.suffix in (".html",".css",".js") else ""))
        self.send_header("Content-Length",str(len(body)))
        self.send_header("Cache-Control","no-cache")
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("Referrer-Policy","same-origin")
        self.send_header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
        self.end_headers(); self.wfile.write(body)
    def api(self,method,path,query,data):
        token = self.headers.get("Authorization", "").removeprefix("Bearer ")
        with AUTH_LOCK:
            for expired in [k for k,v in SESSIONS.items() if v <= time.time()]: SESSIONS.pop(expired,None)
            admin = token in SESSIONS
        if path == "/api/auth/status" and method == "GET":
            with db() as conn: configured = bool(conn.execute("SELECT 1 FROM settings WHERE key='admin_password'").fetchone())
            return {"configured":configured,"authenticated":admin},200
        if path == "/api/auth/logout" and method == "POST":
            with AUTH_LOCK: SESSIONS.pop(token,None)
            return {"ok":True},200
        if path in ("/api/auth/setup","/api/auth/login") and method == "POST":
            password = text(data.get("password"),"家长密码",128,True)
            with AUTH_LOCK:
                LOGIN_FAILURES[:] = [v for v in LOGIN_FAILURES if v > time.time()-300]
                if len(LOGIN_FAILURES)>=8: raise APIError("尝试次数过多，请5分钟后再试。",429)
                with db(True) as conn:
                    row = conn.execute("SELECT value FROM settings WHERE key='admin_password'").fetchone()
                    if path.endswith("setup"):
                        if row: raise APIError("家长密码已经设置，请登录。",409)
                        if len(password)<10: raise APIError("家长密码至少10个字符。")
                        salt = secrets.token_hex(16)
                        digest = hashlib.scrypt(password.encode(),salt=bytes.fromhex(salt),n=16384,r=8,p=1).hex()
                        conn.execute("INSERT INTO settings(key,value) VALUES('admin_password',?)",(salt+":"+digest,))
                    else:
                        if not row: raise APIError("请先设置家长密码。",409)
                        salt,digest = row[0].split(":")
                        actual = hashlib.scrypt(password.encode(),salt=bytes.fromhex(salt),n=16384,r=8,p=1).hex()
                        if not secrets.compare_digest(actual,digest):
                            LOGIN_FAILURES.append(time.time())
                            raise APIError("密码不正确。",401)
                token = secrets.token_urlsafe(32)
                SESSIONS[token] = time.time()+1800
                LOGIN_FAILURES.clear()
            return {"token":token,"expires_in":1800},200
        privileged = path.startswith(("/api/admin/","/api/ai/","/api/jobs/")) or bool(re.fullmatch(r"/api/attempts/[\w-]+/(grade|ai-grade|release)",path)) or query.get("all")==["1"]
        if privileged and not admin: raise APIError("请先登录家长后台。",401)
        if method=="GET" and path=="/api/ai/status": return ai_client.status(),200
        if method=="GET" and path.startswith("/api/jobs/"):
            with db() as conn:
                row = conn.execute("SELECT * FROM jobs WHERE id=?",(path.split("/")[-1],)).fetchone()
                if not row: raise APIError("任务不存在。",404)
                job = dict(row); job["result"] = json.loads(job.pop("result_json"))
                return {"job":job},200
        if method=="GET" and path in ("/api/overview","/api/subjects","/api/papers","/api/attempts"):
            with db(True) as conn:
                expire_attempts(conn)
                papers = list_papers(conn,query.get("all")==["1"],query.get("subject",[None])[0])
                if path=="/api/papers": return {"papers":papers},200
                attempts = list_attempts(conn,admin)
                if path=="/api/attempts": return {"attempts":attempts},200
                subjects = []
                for i,s in enumerate(SUBJECTS):
                    seed,_ = get_paper(conn,"seed-"+s["code"])
                    subjects.append({**s,"sort_order":i,**{k:seed[k] for k in ("scope","description","blueprint")}})
                return {"subjects":subjects,"papers":papers,"attempts":attempts,"stats":{"papers":len(papers),"attempts":len(attempts),"completed":sum(a["status"]!="active" for a in attempts),"question_count":sum(p["question_count"] for p in papers)},"ai":ai_client.status() if admin else {"configured":False}},200
        match = re.fullmatch(r"/api/(admin/)?papers/([\w-]+)(/publish)?",path)
        if match:
            admin_route,paper_id,publish = match.groups()
            with db(method!="GET") as conn:
                paper,qs = get_paper(conn,paper_id)
                if method=="GET" and not publish:
                    if not admin_route and paper["status"]!="published": raise APIError("试卷尚未发布或已归档。",404)
                    return {"paper":paper,"questions":[public_question(q,bool(admin_route)) for q in qs]},200
                if not admin_route: raise APIError("接口不存在。",404)
                if method=="POST" and publish:
                    normalize_paper({**paper,"questions":qs},True)
                    conn.execute("UPDATE papers SET status='published',updated_at=? WHERE id=?",(now().isoformat(),paper_id))
                    return {"id":paper_id,"status":"published"},200
                if method=="PUT" and not publish:
                    save_paper(conn,paper_id,data,"published" if paper["status"]=="published" else "draft")
                    return {"id":paper_id},200
                if method=="DELETE" and not publish:
                    conn.execute("UPDATE papers SET status='archived',updated_at=? WHERE id=?",(now().isoformat(),paper_id))
                    return {"id":paper_id,"status":"archived"},200
        if method=="POST" and path=="/api/admin/papers":
            paper_id = uuid.uuid4().hex
            with db(True) as conn: save_paper(conn,paper_id,data)
            return {"id":paper_id},201
        if method=="POST" and path=="/api/attempts":
            with db(True) as conn:
                paper,qs = get_paper(conn,data.get("paper_id",""))
                if paper["status"]!="published": raise APIError("请先发布试卷。")
                name = text(data.get("student_name","同学"),"考生称呼",50) or "同学"
                start = now(); attempt_id = uuid.uuid4().hex
                conn.execute("INSERT INTO attempts(id,paper_id,student_name,started_at,deadline,snapshot_json) VALUES(?,?,?,?,?,?)",(attempt_id,paper["id"],name,start.isoformat(),(start+timedelta(minutes=paper["minutes"])).isoformat(),dumps({"paper":paper,"questions":qs})))
            return {"id":attempt_id},201
        match = re.fullmatch(r"/api/attempts/([\w-]+)(?:/(answers|submit|grade|ai-grade|release))?",path)
        if match:
            attempt_id,action = match.groups(); expired_save = False
            with db(True) as conn:
                expire_attempts(conn)
                row = get_attempt(conn,attempt_id)
                if method=="GET" and action is None: return attempt_result(row,admin),200
                if method=="PUT" and action=="answers":
                    if row["status"]!="active": expired_save = True
                    else: update_answers(conn,row,data)
                elif method=="POST" and action=="submit":
                    if row["status"]=="active":
                        update_answers(conn,row,data); submit_attempt(conn,get_attempt(conn,attempt_id))
                elif method=="POST" and action=="release":
                    if row["status"]=="active": raise APIError("请先交卷。",409)
                    release = data.get("released")
                    if not isinstance(release,bool): raise APIError("公布状态无效。")
                    if release and attempt_result(row)["attempt"]["pending_manual"]: raise APIError("请完成所有主观题评分后再公布。",409)
                    conn.execute("UPDATE attempts SET released=? WHERE id=?",(int(release),attempt_id))
                    return {"released":release},200
                elif method=="POST" and action=="grade":
                    if row["status"]=="active": raise APIError("请先交卷再评分。",409)
                    valid = {q["id"]:q for q in json.loads(row["snapshot_json"])["questions"]}
                    grades = json.loads(row["grades_json"]); scores = data.get("scores",{})
                    if not isinstance(scores,dict): raise APIError("分数格式无效。")
                    for qid,mark in scores.items():
                        if qid not in valid or not isinstance(mark,dict): raise APIError("评分题号或格式无效。")
                        score = finite(mark.get("score"),"题目得分",0,valid[qid]["points"])
                        feedback = text(mark.get("feedback",""),"评语",10000)
                        grades[qid] = {**grades.get(qid,{}),"score":score,"feedback":feedback,"grader":"manual"}
                        conn.execute("INSERT INTO grade_history(attempt_id,question_id,grade_json,created_at) VALUES(?,?,?,?)",(attempt_id,qid,dumps(grades[qid]),now().isoformat()))
                    conn.execute("UPDATE attempts SET grades_json=? WHERE id=?",(dumps(grades),attempt_id))
                    return attempt_result(get_attempt(conn,attempt_id)),200
                elif method=="POST" and action=="ai-grade":
                    if row["status"]=="active": raise APIError("请先交卷。",409)
                    if not attempt_result(row)["attempt"]["pending_manual"]: raise APIError("所有题目均已评分，无需重复AI阅卷。")
                else: raise APIError("接口不存在。",404)
            if expired_save: raise APIError("考试已交卷或时间已到，最后保存的答案已用于评分。",409)
            if action=="ai-grade": return {"job_id":create_job("grade",attempt_id,{})},202
            if action=="submit" and data.get("ai_grade") and admin: return {"id":attempt_id,"job_id":create_job("grade",attempt_id,{})},200
            return {"id":attempt_id,"saved":True},200
        if method=="POST" and path=="/api/ai/generate":
            target = data.get("template_id","")
            with db() as conn:
                paper,qs = get_paper(conn,target); normalize_paper({**paper,"questions":qs},True)
            for field in ("scope","title","difficulty"):
                if field in data: text(data[field],field,5000)
            return {"job_id":create_job("generate",target,data)},202
        raise APIError("接口不存在。",404)
    def do_GET(self): self.dispatch("GET")
    def do_POST(self): self.dispatch("POST")
    def do_PUT(self): self.dispatch("PUT")
    def do_DELETE(self): self.dispatch("DELETE")

def main():
    parser = argparse.ArgumentParser(description="北京九上期中模拟考试")
    parser.add_argument("port",nargs="?",type=int,default=8033)
    args = parser.parse_args()
    initialize()
    server = ThreadingHTTPServer(("127.0.0.1",args.port),Handler)
    print(f"考试网页：http://127.0.0.1:{args.port} （仅本机）",flush=True)
    print(f"题库后台：http://127.0.0.1:{args.port}/admin",flush=True)
    print(f"SQLite：{DB_PATH}",flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: print("服务已停止。")
    finally:
        server.server_close(); POOL.shutdown(wait=False,cancel_futures=True)

if __name__=="__main__": main()
