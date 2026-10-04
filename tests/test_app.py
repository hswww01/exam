import copy
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

import app
import ai_client


class ExamFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.old_db = app.DB_PATH
        app.DB_PATH = Path(cls.temp.name) / "exam.db"
        app.initialize()
        cls.server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join()
        app.DB_PATH = cls.old_db
        cls.temp.cleanup()

    def request(self, path, method="GET", data=None, expected=200):
        req = urllib.request.Request(self.url + path, method=method,
            data=None if data is None else json.dumps(data).encode(),
            headers={"Content-Type": "application/json"} if data is not None else {})
        try:
            with urllib.request.urlopen(req) as res:
                code, body = res.status, res.read()
        except urllib.error.HTTPError as exc:
            code, body = exc.code, exc.read()
        self.assertEqual(code, expected, body.decode()[:300])
        return json.loads(body)

    def start(self, paper_id="seed-physics"):
        return self.request("/api/attempts", "POST", {"paper_id": paper_id}, 201)["id"]

    def job(self, name):
        with app.db(True) as conn:
            conn.execute("INSERT OR REPLACE INTO jobs(id,type,target_id,status,created_at,updated_at) VALUES(?,'grade','x','running',?,?)", (name, app.now().isoformat(), app.now().isoformat()))

    def test_seed_blueprints_and_objective_keys(self):
        overview = self.request("/api/overview")
        self.assertEqual(len(overview["subjects"]), 5)
        seed_count = 0
        with app.db() as conn:
            for subject in app.SUBJECTS:
                p, qs = app.get_paper(conn, "seed-" + subject["code"])
                app.normalize_paper({**p, "questions": qs}, True)
                self.assertEqual(sum(q["points"] for q in qs), subject["full_score"])
                seed_count += len(qs)
                for q in qs:
                    if not q["manual"]:
                        self.assertEqual(app.objective_score(q, q["answer"]), q["points"], q["id"])
        self.assertEqual(seed_count, 144)
        q = {"kind": "multi", "points": 2, "answer": ["A", "C"], "partial_credit": 1}
        self.assertEqual(app.objective_score(q, ["C"]), 1)
        self.assertEqual(app.objective_score(q, ["A", "B"]), 0)
        self.assertEqual(app.objective_score({"kind": "number", "points": 2, "answer": "42"}, "42 or 9"), 0)

    def test_save_submit_and_manual_review(self):
        aid = self.start()
        active = self.request("/api/attempts/" + aid)
        self.assertTrue(all("answer" not in q and "rubric" not in q for q in active["questions"]))
        with app.db() as conn: _, qs = app.get_paper(conn, "seed-physics")
        objective = next(q for q in qs if not q["manual"])
        subjective = next(q for q in qs if q["manual"])
        answers = {objective["id"]: objective["answer"], subjective["id"]: "写出部分实验过程"}
        self.request(f"/api/attempts/{aid}/answers", "PUT", {"answers": answers, "flags": [subjective["id"]]})
        self.request(f"/api/attempts/{aid}/submit", "POST", {})
        result = self.request("/api/attempts/" + aid)
        self.assertEqual(result["attempt"]["auto_score"], objective["points"])
        self.assertEqual(result["attempt"]["pending_manual"], 1)
        self.assertEqual(result["responses"][subjective["id"]]["answer"], answers[subjective["id"]])
        self.request(f"/api/attempts/{aid}/grade", "POST", {"scores": {subjective["id"]: {"score": 999}}}, 400)
        self.request(f"/api/attempts/{aid}/grade", "POST", {"scores": {subjective["id"]: {"score": 1, "feedback": "过程部分正确"}}})
        self.request(f"/api/attempts/{aid}/submit", "POST", {"answers": {objective["id"]: "wrong"}})
        result = self.request("/api/attempts/" + aid)
        self.assertEqual(result["attempt"]["total_score"], objective["points"]+1)
        self.assertEqual(result["attempt"]["pending_manual"], 0)

    def test_deadline_locks_answers(self):
        aid = self.start()
        with app.db(True) as conn:
            conn.execute("UPDATE attempts SET deadline=? WHERE id=?", ((app.now()-timedelta(seconds=1)).isoformat(), aid))
        self.request(f"/api/attempts/{aid}/answers", "PUT", {"answers": {"physics-1": "A"}}, 409)
        result = self.request("/api/attempts/" + aid)
        self.assertEqual(result["attempt"]["status"], "submitted")
        self.assertEqual(result["attempt"]["total_score"], 0)

    def test_edit_publish_archive_and_immutable_snapshot(self):
        original = self.request("/api/admin/papers/seed-math")
        data = {**original["paper"], "questions": original["questions"]}
        pid = self.request("/api/admin/papers", "POST", data, 201)["id"]
        self.request("/api/papers/"+pid, expected=404)
        self.request(f"/api/admin/papers/{pid}/publish", "POST", {})
        aid = self.start(pid)
        data["title"] = "edited title"
        data["questions"][0]["stem"] = "edited question"
        self.request("/api/admin/papers/"+pid, "PUT", data)
        result = self.request("/api/attempts/"+aid)
        self.assertNotEqual(result["paper"]["title"], "edited title")
        self.assertNotEqual(result["questions"][0]["stem"], "edited question")
        bad = copy.deepcopy(data); bad["max_score"] = 99
        self.request("/api/admin/papers/"+pid, "PUT", bad, 400)
        self.request("/api/admin/papers/"+pid, "DELETE")
        self.request("/api/papers/"+pid, expected=404)
        self.request("/api/attempts/"+aid)

    def test_missing_key_and_invalid_json(self):
        with patch.object(ai_client, "settings", return_value={"key":"", "model":"gpt-6-luna", "base_url":"https://api.openai.com/v1"}):
            result = self.request("/api/ai/generate", "POST", {"template_id":"seed-math"}, 503)
            self.assertIn("OPENAI_API_KEY", result["error"])
        self.request("/api/attempts", "POST", [], 400)

    def test_mock_generation_is_draft_and_preserves_structure(self):
        self.job("generate-test")
        def fake(_instructions, payload, _schema, _name):
            return {"questions": [{"label":q["label"], **{k:q[k] for k in ("stem", "passage", "options", "rubric", "explanation")},
                "answer": ",".join(q["answer"]) if isinstance(q["answer"],list) else str(q["answer"])} for q in payload["slots_and_examples"]]}
        with patch.object(ai_client, "call_json", side_effect=fake):
            result = app.generate_worker("generate-test", "seed-english", {"title":"Test generated"})
        with app.db() as conn:
            p, qs = app.get_paper(conn, result["paper_id"])
            self.assertEqual(p["status"], "draft")
            self.assertEqual(sum(q["points"] for q in qs), 60)
            self.assertEqual(len(qs), 38)

    def test_mock_grading_rejects_invalid_and_keeps_parent_changes(self):
        aid = self.start("seed-chinese")
        with app.db() as conn: _, qs = app.get_paper(conn, "seed-chinese")
        q = next(q for q in qs if q["manual"])
        self.request(f"/api/attempts/{aid}/submit", "POST", {"answers": {q["id"]: "我的答案"}})
        self.job("grading-test")
        with patch.object(ai_client, "call_json", return_value={"grades":[{"question_id":q["id"], "score":999, "feedback":"bad"}]}):
            with self.assertRaises(app.APIError): app.grade_worker("grading-test", aid, {})
        self.assertEqual(self.request("/api/attempts/"+aid)["attempt"]["pending_manual"], 1)
        def fake(*_args):
            self.request(f"/api/attempts/{aid}/grade", "POST", {"scores": {q["id"]: {"score":1, "feedback":"家长修订"}}})
            return {"grades":[{"question_id":q["id"], "score":0, "feedback":"AI评分"}]}
        with patch.object(ai_client, "call_json", side_effect=fake): app.grade_worker("grading-test", aid, {})
        marked = self.request("/api/attempts/"+aid)["responses"][q["id"]]
        self.assertEqual((marked["score"],marked["grader"]),(1,"manual"))


class AIAdapterTests(unittest.TestCase):
    def test_response_contract_and_model(self):
        cfg = {"key":"test-only-not-a-real-key","model":"gpt-6-luna","base_url":"https://api.openai.com/v1","reasoning":"medium","timeout":180}
        class Response:
            def __enter__(self): return self
            def __exit__(self,*_): pass
            def read(self,*_): return json.dumps({"status":"completed","output":[{"type":"reasoning"},{"type":"message","content":[{"type":"output_text","text":"{\"grades\":[]}"}]}]}).encode()
        with patch.object(ai_client,"settings",return_value=cfg), patch.object(ai_client.urllib.request,"urlopen",return_value=Response()) as send:
            self.assertEqual(ai_client.call_json("grade",{},ai_client.GRADE_SCHEMA,"grading"),{"grades":[]})
            body = json.loads(send.call_args.args[0].data)
            self.assertEqual(body["model"],"gpt-6-luna")
            self.assertIs(body["store"],False)
            self.assertTrue(body["text"]["format"]["strict"])


if __name__ == "__main__": unittest.main()
