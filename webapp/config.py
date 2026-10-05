# -*- coding: utf-8 -*-
"""Web 版配置：全部走环境变量，本地直接跑时有合理默认值。

环境变量一览见项目根目录 .env.example
"""
import os
import secrets

# 项目根目录（dewu/），web 版代码在 webapp/ 下
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _flag(name, default="0"):
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


def _int(name, default):
    try:
        return int(os.environ.get(name, "").strip() or default)
    except Exception:
        return default


class Settings:
    def __init__(self):
        # ---- 数据目录 ----
        self.data_dir = os.environ.get("DEWU_DATA_DIR") or os.path.join(ROOT_DIR, "webdata")
        os.makedirs(self.data_dir, exist_ok=True)

        # ---- 数据库：本地默认 SQLite；docker 里用 PostgreSQL ----
        self.database_url = (os.environ.get("DATABASE_URL") or "").strip()
        if not self.database_url:
            self.database_url = "sqlite:///" + os.path.join(self.data_dir, "dewu.db")
            self.is_sqlite = True
        else:
            self.is_sqlite = self.database_url.startswith("sqlite")

        # ---- 会话签名密钥：不提供就本地生成一份并持久化（重启不掉线） ----
        self.secret_key = (os.environ.get("SECRET_KEY") or "").strip()
        if not self.secret_key:
            p = os.path.join(self.data_dir, "secret.key")
            if os.path.exists(p):
                self.secret_key = open(p, encoding="utf-8").read().strip()
            if not self.secret_key:
                self.secret_key = secrets.token_urlsafe(48)
                try:
                    with open(p, "w", encoding="utf-8") as f:
                        f.write(self.secret_key)
                except Exception:
                    pass

        # ---- 会话有效期 ----
        self.session_days = _int("SESSION_DAYS", 14)

        # ---- 管理员（首次启动时按这两个值建号） ----
        self.admin_user = os.environ.get("ADMIN_USER", "admin").strip() or "admin"
        self.admin_password = (os.environ.get("ADMIN_PASSWORD") or "").strip()
        # 没给密码 → 首次启动随机生成并写到 data_dir/ADMIN_PASSWORD.txt
        self._generated_admin_pw = ""

        # ---- 得物接口默认值（活动 id 换批次时要改） ----
        self.dewu_activity = os.environ.get("DEWU_ACTIVITY", "20260917").strip() or "20260917"
        self.dewu_sign = (os.environ.get("DEWU_SIGN")
                          or "a442082446d3167a557bb01e06012ee4").strip()
        self.dewu_answer_sign = (os.environ.get("DEWU_ANSWER_SIGN")
                                 or "77af3e1a2c42f341d8f69d8661a39768").strip()

        # ---- 开放策略 ----
        self.allow_new_user = _flag("ALLOW_NEW_USER", "1")     # 允许新得物账号首次登录
        self.max_users = _int("MAX_USERS", 0)                  # 0 = 不限
        self.require_code_for_task = _flag("REQUIRE_CODE_FOR_TASK", "1")

        # ---- 监听端口 ----
        self.host = os.environ.get("HOST", "0.0.0.0")
        self.port = _int("PORT", 8000)

        # ---- 请求超时 ----
        self.http_timeout = _int("HTTP_TIMEOUT", 12)

    def ensure_admin_password(self):
        """返回管理员初始密码；没配就随机生成一次并存文件。"""
        if self.admin_password:
            return self.admin_password
        if not self._generated_admin_pw:
            p = os.path.join(self.data_dir, "ADMIN_PASSWORD.txt")
            if os.path.exists(p):
                self._generated_admin_pw = open(p, encoding="utf-8").read().strip()
            if not self._generated_admin_pw:
                self._generated_admin_pw = secrets.token_urlsafe(9)
                try:
                    with open(p, "w", encoding="utf-8") as f:
                        f.write(self._generated_admin_pw)
                except Exception:
                    pass
        return self._generated_admin_pw


settings = Settings()
