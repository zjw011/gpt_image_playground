"""Web 回归测试：隔离数据库、模拟所有外部请求，不提取付费 IP。"""
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
_data = tempfile.TemporaryDirectory(prefix="dewu-web-test-")
os.environ["DEWU_DATA_DIR"] = _data.name
os.environ["ADMIN_PASSWORD"] = "offline-test-admin"
from fastapi.testclient import TestClient
from webapp import api_user, dewu_client, tianqi
from webapp.db import init_db, db_session, put_setting, engine
from webapp.models import User, RedeemCode, Task, merge_defaults
from webapp.main import app, _login_attempts
from webapp.runtime import UserRuntime, runtime_for
from webapp.secret_store import encrypt
from webapp.auth import create_session
from webapp.security import COOKIE_USER


class WebRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()

    def setUp(self):
        self.client = TestClient(app)
        _login_attempts.clear()
        tianqi._WHITE_CACHE.clear()
        tianqi._ACTIVE_IPS.clear()
        put_setting("public_account", {})
        put_setting("tianqi", {})

    def user(self, phone="13912345678", password="secret"):
        with db_session() as s:
            from sqlalchemy import select
            u = s.scalars(select(User).where(User.phone == phone)).first()
            if u is None:
                u = User(phone=phone, settings=merge_defaults({}))
                s.add(u)
                s.flush()
            u.pw_enc = encrypt(password)
            u.token = ""
            uid = u.id
        runtime_for(uid).login_lease = None
        return uid

    def test_password_login_and_refresh_never_call_platform(self):
        with patch.object(dewu_client, "login") as login, patch.object(tianqi, "one_proxy") as extract:
            r = self.client.post("/api/login", json={"phone": "13923456789", "password": "secret"}).json()
            self.assertTrue(r["ok"])
            r = self.client.post("/api/products/refresh", json={}).json()
            self.assertFalse(r["ok"])
            r = self.client.post("/api/probe", json={}).json()
            self.assertFalse(r["ok"])
            login.assert_not_called()
            extract.assert_not_called()

    def test_existing_user_wrong_password_cannot_overwrite_credentials(self):
        uid = self.user()
        r = self.client.post("/api/login", json={"phone": "13912345678", "password": "wrong"}).json()
        self.assertFalse(r["ok"])
        self.assertNotIn(COOKIE_USER, self.client.cookies)
        self.assertEqual(UserRuntime(uid).creds()[1], "secret")

    def test_same_account_parallel_tasks_extract_and_login_once(self):
        uid = self.user()
        rt = UserRuntime(uid)
        proxy = {"url": "socks5h://1.2.3.4:1080", "ip": "1.2.3.4", "where": "测试", "expire_at": time.time() + 180}
        results = []
        with patch.object(tianqi, "ready", return_value=True), patch.object(tianqi, "one_proxy", return_value=(proxy, "")) as extract, patch.object(dewu_client, "login", return_value={"ok": True, "token": "test-token"}) as login:
            threads = [threading.Thread(target=lambda: results.append(rt.do_login(use_ip=True))) for _ in range(6)]
            for th in threads: th.start()
            for th in threads: th.join()
            self.assertTrue(all(r[0] for r in results))
            self.assertEqual(extract.call_count, 1)
            self.assertEqual(login.call_count, 1)
            self.assertEqual(login.call_args.kwargs["proxies"]["https"], proxy["url"])

    def test_prepared_session_keeps_matching_login_token(self):
        uid = self.user()
        with db_session() as s:
            s.get(User, uid).token = "newer-task-token"
        session = UserRuntime(uid).session(proxy_url="socks5h://1.2.3.4:1080", token="prepared-task-token")
        self.assertIn("prepared-task-token", session.token)
        self.assertNotIn("newer-task-token", session.token)

    def test_proxy_failure_never_falls_back_to_direct_login(self):
        rt = UserRuntime(self.user())
        with patch.object(tianqi, "ready", return_value=True), patch.object(tianqi, "one_proxy", return_value=(None, "暂无可用IP")), patch.object(dewu_client, "login") as login:
            ok, msg, _ = rt.do_login(use_ip=True)
            self.assertFalse(ok)
            self.assertIn("IP", msg)
            login.assert_not_called()

    def test_white_failure_does_not_purchase_proxy(self):
        fake = Mock(auth_user="", auth_pass="", key="test-key", sign="test-sign")
        fake.ensure_white.return_value = (False, "白名单满了")
        with patch.object(tianqi, "client", return_value=(fake, "")):
            result, msg = tianqi.one_proxy()
        self.assertIsNone(result)
        self.assertIn("白名单", msg)
        fake.extract_lease.assert_not_called()

    def test_provider_duplicate_exit_is_not_shared_between_accounts(self):
        fake = Mock(auth_user="user", auth_pass="pass", life=3)
        lease = Mock()
        lease.as_proxy.return_value = {"ip": "1.2.3.4", "url": "socks5h://1.2.3.4:1000", "expire_at": time.time() + 180}
        fake.extract_lease.return_value = (lease, "")
        with patch.object(tianqi, "client", return_value=(fake, "")):
            first, _ = tianqi.one_proxy()
            second, msg = tianqi.one_proxy()
        self.assertIsNotNone(first)
        self.assertIsNone(second)
        self.assertIn("已占用", msg)
        self.assertEqual(fake.extract_lease.call_count, 2)

    def test_expired_deadline_sends_no_exchange_request(self):
        session = dewu_client.DewuSession("test-token")
        with patch("requests.Session.post") as post:
            r = session._fire({"cName": "测试"}, {"deadline": time.time() - 1, "max_attempts": 20}, 0, None, None)
        self.assertFalse(r["ok"])
        post.assert_not_called()

    def test_prepared_list_does_not_refresh_at_start(self):
        session = dewu_client.DewuSession("test-token")
        result = {"ok": True, "attempts": 1, "detail": "成功"}
        with patch.object(session, "fetch_list") as fetch, patch.object(session, "_fire", return_value=result):
            r = session.run_task({"cName": "商品", "cId": 1}, {"prepared_list": (True, {"prizes": [{"cName": "商品", "cId": 1}], "balance": 50})})
        self.assertTrue(r["ok"])
        fetch.assert_not_called()

    def test_task_push_uses_users_token_and_private_delivery(self):
        uid = self.user()
        with db_session() as s:
            u = s.get(User, uid)
            st = merge_defaults({})
            st["push"].update(enabled=True, token="user-push-token", topic="group")
            u.settings = st
        rt = UserRuntime(uid)
        done = threading.Event()
        calls = []
        def send(*args, **kwargs):
            calls.append(kwargs)
            done.set()
            return True, "ok"
        with patch("dewu_push.send", side_effect=send):
            rt.push_task("success", "商品", 10, 20, 1, 1)
            self.assertTrue(done.wait(3))
        self.assertEqual(calls[0]["token"], "user-push-token")
        self.assertIsNone(calls[0]["topic"])

    def test_authorization_code_cannot_be_reused(self):
        uid = self.user()
        with db_session() as s:
            s.add(RedeemCode(code="REGRESSION-CODE", quota=1, used=0, status="active"))
        with db_session() as s:
            self.assertTrue(api_user._consume_code(s, "REGRESSION-CODE", uid, None)[0])
        with db_session() as s:
            self.assertFalse(api_user._consume_code(s, "REGRESSION-CODE", uid, None)[0])

    def test_parallel_authorization_code_claims_only_once(self):
        uid = self.user()
        with db_session() as s:
            s.add(RedeemCode(code="PARALLEL-CODE", quota=1, used=0, status="active"))
        barrier = threading.Barrier(6)
        results = []
        errors = []
        def consume():
            try:
                barrier.wait(timeout=3)
                with db_session() as s:
                    results.append(api_user._consume_code(s, "PARALLEL-CODE", uid, None)[0])
            except Exception as exc:
                errors.append(str(exc))
        threads = [threading.Thread(target=consume) for _ in range(6)]
        for th in threads: th.start()
        for th in threads: th.join()
        self.assertFalse(errors, errors)
        self.assertEqual(sum(results), 1)

    def test_zero_lead_and_code_link_are_preserved(self):
        uid = self.user()
        self.client.cookies.set(COOKIE_USER, create_session("user", user_id=uid))
        with db_session() as s:
            s.add(RedeemCode(code="TASK-CODE", quota=1, used=0, status="active"))
        rt = runtime_for(uid)
        with patch.object(tianqi, "ready", return_value=True), patch.object(api_user, "_apply_public_list", return_value={"products": [{"cId": 123, "cName": "测试商品"}]}), patch.object(rt, "schedule"):
            r = self.client.post("/api/tasks", json={"cId": 123, "code": "TASK-CODE", "lead_ms": 0, "interval_ms": 1, "max_attempts": 99999}).json()
        self.assertTrue(r["ok"], r)
        with db_session() as s:
            task = s.get(Task, r["task_id"])
            self.assertEqual(task.lead_ms, 0)
            self.assertEqual(task.interval_ms, 200)
            self.assertEqual(task.max_attempts, 600)
            self.assertIsNotNone(task.code_id)

    def test_sensitive_urls_are_redacted_in_user_logs(self):
        rt = UserRuntime(self.user())
        rt.log("failed http://api.example/getip?secret=private&sign=signature socks5h://user:password@1.2.3.4:1080")
        message = rt.logs_snapshot()[-1]["msg"]
        for value in ("private", "signature", "password"):
            self.assertNotIn(value, message)

    def test_cross_site_login_is_rejected(self):
        r = self.client.post("/api/login", json={}, headers={"Origin": "https://evil.example"})
        self.assertEqual(r.status_code, 403)

    def test_login_rate_limit(self):
        for _ in range(20):
            self.client.post("/api/login", json={})
        r = self.client.post("/api/login", json={})
        self.assertEqual(r.status_code, 429)


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        engine.dispose()
        _data.cleanup()
