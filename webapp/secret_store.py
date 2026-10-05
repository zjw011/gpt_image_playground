# -*- coding: utf-8 -*-
"""用户得物密码的**可逆**加密存储。

为什么要存密码
--------------
抢兑流程是：

    用户提交账号密码 → 后台**不登录**，只把密码存下来
                    → 抢兑前 2 分钟提一个短效 IP → 用**那个 IP** 登录 → 到点兑换

所以密码必须留到抢兑那一刻 —— 这是 `security.hash_pw()` 那种单向哈希做不到的
（那是给管理员口令用的，验完就不需要原文了）。

密钥
----
来自 ``settings.secret_key``（环境变量 ``SECRET_KEY``，没给就在数据目录自动生成
``secret.key``）派生一把 Fernet key。**换掉或丢了它，已存的密码就解不开了** ——
那时用户重新提交一次账号密码即可（不影响其它数据）。

格式
----
密文统一带 ``enc:v1:`` 前缀，认不出来的值一律当「没存过」，不会把脏数据当密文解。
"""
import base64
import hashlib

from .config import settings

__all__ = ["encrypt", "decrypt", "available"]

_PREFIX = "enc:v1:"
try:
    from cryptography.fernet import Fernet, InvalidToken
    _IMPORT_ERR = None
except Exception as e:                     # noqa: BLE001
    Fernet = None                          # type: ignore[assignment]
    InvalidToken = Exception               # type: ignore[assignment,misc]
    _IMPORT_ERR = e

_FERNET = None


def available():
    """加密能不能用（缺 cryptography 时给界面一句人话，而不是 500）。"""
    return Fernet is not None


def _fernet():
    global _FERNET
    if Fernet is None:
        raise RuntimeError("缺少 cryptography 库，装一下：pip install cryptography（%r）"
                           % (_IMPORT_ERR,))
    if _FERNET is None:
        # 用 secret_key 派生，不直接拿它当 key（Fernet 要求 32 字节 urlsafe base64）
        raw = hashlib.sha256(("dewu-pw::" + settings.secret_key).encode("utf-8")).digest()
        _FERNET = Fernet(base64.urlsafe_b64encode(raw))
    return _FERNET


def encrypt(text):
    """明文 → ``enc:v1:...``。空串原样返回空串。"""
    if not text:
        return ""
    tok = _fernet().encrypt(str(text).encode("utf-8")).decode("ascii")
    return _PREFIX + tok


def decrypt(blob):
    """密文 → 明文。**解不开就返回空串**（当作没存过），绝不抛给上层。"""
    s = str(blob or "")
    if not s.startswith(_PREFIX):
        return ""
    try:
        return _fernet().decrypt(s[len(_PREFIX):].encode("ascii")).decode("utf-8")
    except Exception:                      # noqa: BLE001  InvalidToken / 换过密钥 / 脏数据
        return ""
