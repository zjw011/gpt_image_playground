# -*- coding: utf-8 -*-
"""数据库连接与建表。"""
import contextlib
import logging

from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker

from .config import settings
from .models import Admin, Base, Setting
from .security import hash_pw

log = logging.getLogger("dewu.db")

if settings.is_sqlite:
    engine = create_engine(
        settings.database_url, future=True,
        connect_args={"check_same_thread": False, "timeout": 20},
        pool_pre_ping=True,
    )

    @event.listens_for(engine, "connect")
    def _sqlite_pragma(dbapi_conn, _rec):        # noqa: ANN001
        """WAL + 宽松同步：多个任务线程并发写也不容易 database is locked。"""
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA busy_timeout=20000")
        cur.close()
else:
    engine = create_engine(settings.database_url, future=True, pool_pre_ping=True,
                           pool_size=10, max_overflow=20)

SessionLocal = sessionmaker(bind=engine, future=True, expire_on_commit=False)


@contextlib.contextmanager
def db_session():
    s = SessionLocal()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def get_setting(key, default=None):
    with db_session() as s:
        row = s.get(Setting, key)
        return default if row is None or row.value is None else row.value


def put_setting(key, value):
    with db_session() as s:
        row = s.get(Setting, key)
        if row is None:
            s.add(Setting(key=key, value=value))
        else:
            row.value = value


def init_db():
    Base.metadata.create_all(engine)

    # 管理员：不存在才建（密码取环境变量，没有就随机生成一份写文件）
    with db_session() as s:
        if not s.scalars(select(Admin).limit(1)).first():
            pw = settings.ensure_admin_password()
            s.add(Admin(username=settings.admin_user, pwd_hash=hash_pw(pw)))
            log.warning("已创建管理员账号：%s / %s", settings.admin_user, pw)
            print("\n" + "=" * 58)
            print("  管理员账号已创建")
            print("  用户名: %s" % settings.admin_user)
            print("  密码  : %s" % pw)
            print("  （可用 ADMIN_PASSWORD 环境变量指定；别用默认的太久）")
            print("=" * 58 + "\n")

    # 全局默认设置
    defaults = {
        "dewu_activity": settings.dewu_activity,
        "dewu_sign": settings.dewu_sign,
        "dewu_answer_sign": settings.dewu_answer_sign,
        "allow_new_user": settings.allow_new_user,
        "max_users": settings.max_users,
        "require_code_for_task": settings.require_code_for_task,
    }
    with db_session() as s:
        for k, v in defaults.items():
            if s.get(Setting, k) is None:
                s.add(Setting(key=k, value=v))


def global_cfg():
    """读全局设置，缺项用 env/默认兜底。"""
    keys = {
        "dewu_activity": settings.dewu_activity,
        "dewu_sign": settings.dewu_sign,
        "dewu_answer_sign": settings.dewu_answer_sign,
        "allow_new_user": settings.allow_new_user,
        "max_users": settings.max_users,
        "require_code_for_task": settings.require_code_for_task,
    }
    out = {}
    with db_session() as s:
        for k, dv in keys.items():
            row = s.get(Setting, k)
            out[k] = dv if (row is None or row.value is None) else row.value
    return out
