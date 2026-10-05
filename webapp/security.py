# -*- coding: utf-8 -*-
"""口令哈希 / 会话令牌（纯标准库，不依赖任何三方库，也不 import db 以免循环依赖）。"""
import hashlib
import hmac
import secrets

ITER = 200_000
ALGO = "pbkdf2_sha256"

COOKIE_USER = "dw_sid"
COOKIE_ADMIN = "dw_admin"


def hash_pw(password):
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", str(password).encode("utf-8"),
                             salt.encode("ascii"), ITER)
    return "%s$%d$%s$%s" % (ALGO, ITER, salt, dk.hex())


def verify_pw(password, stored):
    try:
        algo, iters, salt, hexdigest = (stored or "").split("$")
        if algo != ALGO:
            return False
        dk = hashlib.pbkdf2_hmac("sha256", str(password).encode("utf-8"),
                                 salt.encode("ascii"), int(iters))
        return hmac.compare_digest(dk.hex(), hexdigest)
    except Exception:
        return False


def new_token(nbytes=32):
    return secrets.token_urlsafe(nbytes)
