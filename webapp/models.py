# -*- coding: utf-8 -*-
"""ORM 模型。

设计要点
--------
* 一个 web 用户 == 一个得物账号（用手机号+密码登录得到），
  所以 users 表里直接存 token，不另开 accounts 表。
* 所有「开关类」配置塞进 users.settings(JSON)，好处是加新功能不用改表结构；
  用 SQLAlchemy 的 JSON 类型，SQLite / PostgreSQL 都支持。
* 兑换码：一码一任务。redeem_codes.quota 默认 1，used 到 quota 就废。
"""
import datetime

from sqlalchemy import (JSON, Boolean, Column, DateTime, ForeignKey, Integer,
                        String, Text, UniqueConstraint)
from sqlalchemy.orm import DeclarativeBase, relationship


def now():
    return datetime.datetime.now()


class Base(DeclarativeBase):
    pass


# 新用户的默认设置（也是「配置缺项补齐」的模板）
DEFAULT_SETTINGS = {
    "push": {"token": "", "enabled": False, "on_fail": False,
             "topic": "", "group_stock": True, "group_self_too": True},
    "watch": {"enabled": False, "interval_sec": 30,
              "notify_new": True, "notify_restock": True},
    "fallback": {"enabled": True, "on_gone": True, "on_soldout": True,
                 "on_poor": False, "min_ratio": 0.0},
    "answer": {"biz_activity": 2, "sign": "", "skip_answered": True},
    "task_defaults": {"time": "10:00:00", "lead_ms": 300,
                      "interval_ms": 200, "max_attempts": 600},
}


def merge_defaults(settings_dict):
    """把用户设置与默认值深合并（只补缺的键，不动已有值）。"""
    out = {}
    src = settings_dict if isinstance(settings_dict, dict) else {}
    for sec, defaults in DEFAULT_SETTINGS.items():
        got = src.get(sec)
        got = got if isinstance(got, dict) else {}
        out[sec] = dict(defaults)
        out[sec].update({k: v for k, v in got.items() if k in defaults})
    # 保留任何额外的自定义键
    for k, v in src.items():
        if k not in out:
            out[k] = v
    return out


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    phone = Column(String(20), unique=True, nullable=False, index=True)
    dewu_user_id = Column(String(40))
    remark = Column(String(60), default="")
    token = Column(Text)                       # 得物 x-auth-token（含 Bearer 前缀）
    activity = Column(String(24))              # 该用户当前活动 id
    device = Column(JSON, default=dict)        # 设备指纹覆盖（一般不用）
    settings = Column(JSON, default=dict)
    watch_state = Column(JSON, default=dict)   # 库存快照 {seen:{...}, baseline:bool, ...}
    status = Column(String(16), default="active")   # active / banned
    created_at = Column(DateTime, default=now)
    last_login_at = Column(DateTime)
    last_sync_at = Column(DateTime)

    tasks = relationship("Task", back_populates="user", cascade="all, delete-orphan")

    def st(self):
        """安全地取设置（缺项自动补齐）。"""
        self.settings = merge_defaults(self.settings)
        return self.settings


class Session(Base):
    __tablename__ = "sessions"

    id = Column(String(64), primary_key=True)          # 随机 token，存 cookie
    kind = Column(String(8), default="user")           # user / admin
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"))
    admin_id = Column(Integer, ForeignKey("admins.id", ondelete="CASCADE"))
    created_at = Column(DateTime, default=now)
    expires_at = Column(DateTime)
    ip = Column(String(64), default="")
    ua = Column(String(200), default="")


class Admin(Base):
    __tablename__ = "admins"

    id = Column(Integer, primary_key=True)
    username = Column(String(40), unique=True, nullable=False)
    pwd_hash = Column(String(200), nullable=False)
    created_at = Column(DateTime, default=now)
    last_login_at = Column(DateTime)


class RedeemCode(Base):
    __tablename__ = "redeem_codes"
    __table_args__ = (UniqueConstraint("code", name="uq_redeem_code"),)

    id = Column(Integer, primary_key=True)
    code = Column(String(40), nullable=False, index=True)
    note = Column(String(120), default="")
    quota = Column(Integer, default=1)         # 这个码最多能建几个任务
    used = Column(Integer, default=0)
    status = Column(String(12), default="unused")   # unused / used / disabled
    bound_user_id = Column(Integer)
    bound_task_id = Column(Integer)
    created_by = Column(String(40), default="")
    created_at = Column(DateTime, default=now)
    used_at = Column(DateTime)


class Task(Base):
    __tablename__ = "tasks"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    code_id = Column(Integer)
    prize = Column(JSON, default=dict)         # {cId,pId,skuId,cName,cost,stock,picture,price}
    orig_prize = Column(JSON, default=dict)
    target_time = Column(String(12), default="10:00:00")
    lead_ms = Column(Integer, default=300)
    interval_ms = Column(Integer, default=200)
    max_attempts = Column(Integer, default=600)
    repeat_daily = Column(Boolean, default=False)
    fallback_enabled = Column(Boolean, default=True)
    status = Column(String(12), default="等待")   # 等待/兑换中/成功/失败/已删除
    detail = Column(Text, default="")
    attempts = Column(Integer, default=0)
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)
    last_run_at = Column(DateTime)
    finished_at = Column(DateTime)

    user = relationship("User", back_populates="tasks")

    def brief(self):
        p = self.prize or {}
        return {
            "id": self.id, "cName": p.get("cName"), "cost": p.get("cost"),
            "picture": p.get("picture"), "price": p.get("price"),
            "stock": p.get("stock"), "outOfStock": p.get("outOfStock"),
            "time": self.target_time, "status": self.status, "detail": self.detail,
            "attempts": self.attempts, "repeat_daily": bool(self.repeat_daily),
            "fallback": bool(self.fallback_enabled),
            "created": self.created_at.strftime("%m-%d %H:%M") if self.created_at else "",
            "last_run": self.last_run_at.strftime("%m-%d %H:%M") if self.last_run_at else "",
            "finished": self.finished_at.strftime("%m-%d %H:%M") if self.finished_at else "",
        }


class Log(Base):
    __tablename__ = "logs"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True)
    ts = Column(DateTime, default=now)
    level = Column(String(10), default="info")
    msg = Column(Text, default="")


class Setting(Base):
    """全局设置（管理员可改）：key -> value(JSON)"""
    __tablename__ = "settings"

    key = Column(String(40), primary_key=True)
    value = Column(JSON)
    updated_at = Column(DateTime, default=now, onupdate=now)
