# -*- coding: utf-8 -*-
"""Web 版端到端接口测试（对着真实运行的服务打）。

    python run_web.py            # 另开一个窗口先把服务跑起来
    python tools/test_web_api.py [base_url]

用真实的得物账号 curl（dist/accounts.json 里的第一条）走「粘贴 curl 登录」这条路，
避免测试依赖测试账号的密码。会真的拉一次商品列表（只读，不花金币）。
"""
import json
import os
import sys

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8123"
PASS = FAIL = 0
FAILED = []


def ck(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ✓ %s" % name)
    else:
        FAIL += 1
        FAILED.append(name)
        print("  ✗ %s   %s" % (name, extra))


def sec(t):
    print("\n" + "=" * 68 + "\n" + t + "\n" + "=" * 68)


def main():
    s = requests.Session()
    admin = requests.Session()

    # ---------------------------------------------------------------- 静态页
    sec("① 静态页面")
    r = s.get(BASE + "/")
    ck("GET / 返回 200", r.status_code == 200, r.status_code)
    ck("首页含 app.js", "app.js" in r.text)
    r = s.get(BASE + "/admin")
    ck("GET /admin 也返回同一个 SPA", r.status_code == 200 and "app.js" in r.text)
    r = s.get(BASE + "/style.css")
    ck("GET /style.css 200", r.status_code == 200)
    ck("未登录访问 /api/state → 401", s.get(BASE + "/api/state").status_code == 401)

    # ---------------------------------------------------------------- 管理员
    sec("② 管理员：登录 / 生成兑换码 / 概览")
    r = admin.post(BASE + "/api/admin/login", json={"username": "admin", "password": "bad"})
    ck("错误密码被拒", r.json().get("ok") is False)
    pw = os.environ.get("ADMIN_PW") or (open(os.path.join(ROOT, "webdata", "ADMIN_PASSWORD.txt"),
                                             encoding="utf-8").read().strip()
                                        if os.path.exists(os.path.join(ROOT, "webdata",
                                                                       "ADMIN_PASSWORD.txt"))
                                        else "")
    if not pw:
        print("  ! 拿不到管理员密码（设 ADMIN_PW 环境变量），跳过管理端用例")
        return report()
    r = admin.post(BASE + "/api/admin/login", json={"username": "admin", "password": pw})
    ck("管理员登录成功", r.json().get("ok") is True, r.text[:120])
    ck("管理 cookie 已下发", "dw_admin" in admin.cookies)

    r = admin.post(BASE + "/api/admin/codes/generate",
                   json={"count": 3, "quota": 1, "prefix": "TEST", "note": "自动测试"})
    j = r.json()
    ck("批量生成 3 个兑换码", j.get("ok") and len(j.get("codes", [])) == 3, r.text[:150])
    code1 = (j.get("codes") or ["", "", ""])[0]
    ck("兑换码格式像 TEST-XXXX-XXXX", code1.startswith("TEST-") and len(code1) == 14, code1)

    r = admin.get(BASE + "/api/admin/codes")
    ck("兑换码列表能查到", r.json().get("ok") and r.json().get("total", 0) >= 3)

    r = admin.get(BASE + "/api/admin/overview")
    ck("概览返回统计字段", set(["users", "tasks", "codes"]).issubset(r.json().get("stats", {}).keys()))

    r = admin.get(BASE + "/api/admin/settings")
    ck("全局设置含活动 id", "dewu_activity" in r.json().get("settings", {}))

    # ---------------------------------------------------------------- 用户登录
    sec("③ 用户登录（粘贴 curl 兜底通道）")
    accs = json.load(open(os.path.join(ROOT, "dist", "accounts.json"), encoding="utf-8"))
    curl = accs[0]["list_curl"]
    r = s.post(BASE + "/api/login", json={"curl": "curl 'https://x.com/' -H 'a: b'"})
    ck("无效 curl 被拒", r.json().get("ok") is False, r.text[:110])

    r = s.post(BASE + "/api/login", json={"curl": curl})
    j = r.json()
    ck("curl 登录成功", j.get("ok") is True, r.text[:200])
    ck("用户 cookie 已下发", "dw_sid" in s.cookies)

    r = s.get(BASE + "/api/me")
    j = r.json()
    ck("/api/me 返回用户信息", j.get("ok") and "phone" in j.get("user", {}))
    ck("/api/me 带 settings", isinstance(j.get("settings"), dict))
    ck("/api/me 带 global.require_code", "require_code" in j.get("global", {}))

    # ---------------------------------------------------------------- 商品
    sec("④ 商品列表（图片/价格/库存/金币四个字段必须齐全）")
    r = s.post(BASE + "/api/products/refresh", json={})
    j = r.json()
    ck("刷新列表成功", j.get("ok") is True, r.text[:200])
    st = s.get(BASE + "/api/state").json()
    ps = st.get("products") or []
    ck("拿到商品（>0）", len(ps) > 0, "数量 %s" % len(ps))
    if ps:
        p = ps[0]
        ck("字段 picture", "picture" in p and isinstance(p["picture"], str))
        ck("字段 price（分）", p.get("price") is not None)
        ck("字段 priceYuan", p.get("priceYuan") is not None)
        ck("字段 stock", "stock" in p)
        ck("字段 cost（金币）", p.get("cost") is not None)
        ck("字段 cName", bool(p.get("cName")))
        with_img = [x for x in ps if x.get("picture")]
        ck("大部分商品有图片", len(with_img) >= len(ps) * 0.8,
           "%d/%d" % (len(with_img), len(ps)))
        print("     样例：%s | %s | 库存 %s | %s 金币"
              % (p["cName"][:22], "¥%.2f" % (p["priceYuan"] or 0), p.get("stock"), p.get("cost")))

    # ---------------------------------------------------------------- 兑换码
    sec("⑤ 兑换码：一码一任务")
    ck("不填兑换码被拒", s.post(BASE + "/api/tasks", json={"cId": ps[0]["cId"]}).json().get("ok") is False)
    ck("瞎编兑换码被拒", s.post(BASE + "/api/tasks",
                              json={"cId": ps[0]["cId"], "code": "NOPE-0000-0000"}).json().get("ok") is False)
    ck("不存在的商品被拒", s.post(BASE + "/api/tasks",
                               json={"cId": 99999999, "code": code1}).json().get("ok") is False)

    r = s.post(BASE + "/api/tasks", json={"cId": ps[0]["cId"], "code": code1,
                                          "time": "23:59:59", "fallback": True})
    j = r.json()
    ck("用合法兑换码建任务成功", j.get("ok") is True, r.text[:200])
    task_id = j.get("task_id")

    r = s.post(BASE + "/api/tasks", json={"cId": ps[0]["cId"], "code": code1, "time": "23:59:58"})
    ck("同一个码第二次被拒（一码一任务）", r.json().get("ok") is False, r.text[:160])

    codes = admin.get(BASE + "/api/admin/codes?q=" + code1).json().get("codes") or []
    ck("后台看到该码已 used", codes and codes[0].get("status") == "used", str(codes[:1]))
    ck("后台看到该码绑定了用户", codes and codes[0].get("bound_user_id") is not None)

    # ---------------------------------------------------------------- 任务
    sec("⑥ 任务列表 / 操作")
    st = s.get(BASE + "/api/state").json()
    ts = st.get("tasks") or []
    ck("任务出现在列表里", any(t["id"] == task_id for t in ts), str([t["id"] for t in ts]))
    t = next((x for x in ts if x["id"] == task_id), {})
    ck("任务含商品图片字段", "picture" in t)
    ck("任务状态是等待", t.get("status") == "等待", t.get("status"))
    ck("任务带自动降级标记", t.get("fallback") is True)

    r = s.post(BASE + "/api/tasks/%d/stop" % task_id, json={})
    ck("停止任务接口可用", r.json().get("ok") is True, r.text[:120])
    r = s.post(BASE + "/api/tasks/%d/delete" % task_id, json={})
    ck("删除任务接口可用", r.json().get("ok") is True)
    st = s.get(BASE + "/api/state").json()
    ck("删除后任务不再出现", not any(x["id"] == task_id for x in st.get("tasks", [])))

    # ---------------------------------------------------------------- 隔离
    sec("⑦ 多用户隔离（换个浏览器 = 换个用户，不能串）")
    other = requests.Session()
    r = other.get(BASE + "/api/state")
    ck("未登录的第二个会话拿不到状态", r.status_code == 401)
    r = other.post(BASE + "/api/login", json={"curl": accs[1]["list_curl"] if len(accs) > 1 else curl})
    j = r.json()
    if len(accs) > 1 and j.get("ok"):
        st2 = other.get(BASE + "/api/state").json()
        ck("用户2 的任务列表是空的（没有看到用户1 的）",
           len(st2.get("tasks") or []) == 0, "用户2 看到 %d 条" % len(st2.get("tasks") or []))
        ck("用户2 的 phone 与用户1 不同",
           st2.get("logs") is not None and s.get(BASE + "/api/me").json()["user"]["phone"]
           != other.get(BASE + "/api/me").json()["user"]["phone"])
    else:
        print("  ! 只有一个可用账号，跳过跨用户隔离用例")

    # ---------------------------------------------------------------- 设置
    sec("⑧ 设置 / 推送 / 库存监听 / 答题")
    r = s.post(BASE + "/api/settings", json={"watch": {"interval_sec": 45, "notify_new": True,
                                                       "notify_restock": False},
                                             "fallback": {"enabled": True, "min_ratio": 0.2}})
    j = r.json()
    ck("保存设置成功", j.get("ok") is True)
    ck("库存间隔已落库", (j.get("settings", {}).get("watch") or {}).get("interval_sec") == 45)
    ck("降级比例已落库", (j.get("settings", {}).get("fallback") or {}).get("min_ratio") == 0.2)

    r = s.post(BASE + "/api/settings", json={"push": {"topic": "dewu!!中文"}})
    ck("群组编码被清洗（只留 ASCII）",
       (r.json().get("settings", {}).get("push") or {}).get("topic") == "dewu", r.text[:160])

    r = s.post(BASE + "/api/push/test", json={})
    ck("没填 token 时测试推送给出提示", r.json().get("ok") is False)

    r = s.get(BASE + "/api/answer/today")
    j = r.json()
    ck("答题接口可访问（ok 或给出可读原因）", "ok" in j, r.text[:160])

    r = s.post(BASE + "/api/watch/start", json={"interval_sec": 300})
    ck("开启库存监听", r.json().get("ok") is True, r.text[:120])
    st = s.get(BASE + "/api/state").json()
    ck("监听状态 running=True", (st.get("watch") or {}).get("running") is True)
    r = s.post(BASE + "/api/watch/stop", json={})
    ck("关闭库存监听", r.json().get("ok") is True)

    # ---------------------------------------------------------------- 登出
    sec("⑨ 登出")
    s.post(BASE + "/api/logout", json={})
    ck("登出后 /api/state 401", s.get(BASE + "/api/state").status_code == 401)

    return report()


def report():
    print("\n" + "=" * 68)
    print("  通过 %d 项 / 失败 %d 项" % (PASS, FAIL))
    if FAILED:
        print("  失败清单：")
        for f in FAILED:
            print("    · %s" % f)
    print("=" * 68)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
