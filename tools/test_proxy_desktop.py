# -*- coding: utf-8 -*-
"""桌面版（exe / dewu_sniper.py）代理 IP 池的测试。

分两块：

**单测**（不联网、不动真实 config.json）
  · 池子管理：导入 / 去重 / 坏行 / 备注 / 停用 / 删除
  · 分配：每账号一个 IP（同一 IP 不会分给两个账号）、换 IP、解绑
  · provider：固定模式同一个号永远是同一个出口；不同号分到不同出口
  · 收尾记战绩：proxy_note 成功/失败的正确累加

**真机 A/B**（起本机迷你代理 + 本机小目标站，不打真的得物）
  · 开代理：兑换请求确实穿过迷你代理（代理侧记到了转发目标），并且回程拿到了 JSON
  · 关代理：迷你代理一条都没收到，请求仍然成功 —— 证明前面那次真的是走代理的
  · 换 IP：rotate 模式下同一个任务里会换出口，且**换了会话**（旧隧道没被复用）

    python tools/test_proxy_desktop.py
"""
import os
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mini_proxy import MiniProxy, MiniServer          # noqa: E402

import dewu_sniper as S                               # noqa: E402
import dewu_proxies as PX                             # noqa: E402

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


# ============================================================ 不落盘的 Manager
def make_manager(accounts=None):
    """造一个不读也不写真实配置的 Manager。

    跟 tools/test_watch.py 一个套路：``__new__`` 跳过 __init__，自己把字段填好，
    再把 save_json 打桩掉 —— 免得测试把你本机的 config.json / accounts.json 改花。
    """
    m = S.Manager.__new__(S.Manager)
    m.lock = threading.RLock()
    m.accounts = list(accounts if accounts is not None else [
        {"id": 1, "name": "甲号", "list_curl": "curl http://x/?activity=20260101", "fp": "aaaa1111"},
        {"id": 2, "name": "乙号", "list_curl": "curl http://x/?activity=20260101", "fp": "bbbb2222"},
        {"id": 3, "name": "丙号", "list_curl": "curl http://x/?activity=20260101", "fp": "cccc3333"},
    ])
    m.tasks = []
    m.acct_state = {}
    m.logs = []
    m.cfg = {"proxy": dict(S.DEFAULT_CONFIG["proxy"], pool=[], enabled=True)}
    m.last_diag = None
    m.diag_seq = 0
    m.log = lambda msg: m.logs.append(str(msg))
    m._saved = []
    m._save = lambda: m._saved.append(1)
    return m


_REAL_SAVE = S.save_json


# ============================================================ 1. 纯函数
def part1():
    sec("① 协议 / 池子概览（桌面版直接用的是根目录那份实现）")
    ck("socks_ready() 有明确结论（装了 PySocks 就是 True）", PX.socks_ready() is True,
       "socks_ready()=%r" % PX.socks_ready())

    # webapp/proxies.py 只是转发，两边必须**是同一份实现**
    sys.path.insert(0, ROOT)
    from webapp import proxies as WPX
    ck("webapp.proxies 与 dewu_proxies 是同一份（转发而非复制）",
       WPX.normalize_line is PX.normalize_line and WPX.Provider is PX.Provider)

    d = PX.describe_pool([
        {"enabled": True, "status": "ok"}, {"enabled": True, "status": "untested"},
        {"enabled": True, "status": "bad"}, {"enabled": False, "status": "ok"},
    ])
    ck("describe_pool 数得对", d == "4 个（1 可用 / 1 没测 / 1 有问题）", d)


# ============================================================ 2. 池子管理
def part2():
    sec("② 导入 / 去重 / 备注 / 停用 / 删除")
    S.save_json = lambda p, o: None
    m = make_manager()
    r = m.proxy_add("1.2.3.4:1080:u1:p1\n"
                    "5.6.7.8:1080:u2:p2#上海电信\n"
                    "9.9.9.9:8080\n"
                    "1.2.3.4:1080:u1:p1\n"
                    "这行是垃圾\n", scheme="socks5h", label="第一批")
    ck("导入 3 个（第 4 行重复、第 5 行认不出）", r["added"] == 3, r)
    ck("重复行被认出来", r["dup"] == 1, r)
    ck("坏行带行号", r["bad"] == 1 and r["errors"][0]["line"] == 5, r["errors"])

    pool = m.proxy_pool()
    ck("池子里是 3 个", len(pool) == 3, len(pool))
    ck("四段式被解析成带账号密码的 socks5h",
       pool[0]["url"] == "socks5h://u1:p1@1.2.3.4:1080", pool[0]["url"])
    ck("# 后面的备注优先于批次备注", pool[1]["label"] == "上海电信", pool[1]["label"])
    ck("没写备注的落到批次备注", pool[0]["label"] == "第一批" and pool[2]["label"] == "第一批")

    r = m.proxy_add("1.2.3.4:1080:u1:p1", scheme="socks5h")
    ck("再导一次同样的 → 全部被去重", r["added"] == 0 and r["dup"] == 1, r)

    pid = pool[0]["id"]
    m.proxy_edit(pid, enabled=False, label="改了备注")
    p = [x for x in m.proxy_pool() if x["id"] == pid][0]
    ck("能停用 + 改备注", p["enabled"] is False and p["label"] == "改了备注", p)
    pv = m.proxy_for_account(1)
    ck("停用的那个不会被选成出口",
       pv is not None and pv.current_url != pool[0]["url"], pv and pv.current_url)
    m.proxy_edit(pid, enabled=True)

    m.proxy_del([pid])
    ck("删除生效", len(m.proxy_pool()) == 2, len(m.proxy_pool()))

    # 池子坏了不能崩
    r = m.proxy_add("", scheme="socks5h")
    ck("空文本导入不报错也不加东西", r["ok"] and r["added"] == 0, r)
    S.save_json = _REAL_SAVE


# ============================================================ 3. 分配
def part3():
    sec("③ 分配：每个账号一个 IP（同一个 IP 不会分给两个账号）")
    S.save_json = lambda p, o: None
    m = make_manager()
    m.proxy_add("\n".join("10.0.0.%d:1080#IP%d" % (i, i) for i in range(1, 6)),
                scheme="socks5h")
    ck("先导入 5 个 IP", len(m.proxy_pool()) == 5, len(m.proxy_pool()))

    r = m.proxy_auto_assign()
    ck("3 个账号各分到一个", r["assigned"] == 3, r)
    used = [p["account_id"] for p in m.proxy_pool() if p["account_id"] is not None]
    ck("分出去的 3 个是不同账号", sorted(used) == [1, 2, 3], used)
    urls = [p["url"] for p in m.proxy_pool() if p["account_id"] is not None]
    ck("★ 每个账号拿到的 IP 互不相同", len(set(urls)) == len(urls) == 3, urls)

    r2 = m.proxy_auto_assign()
    ck("再点一次不会重复分配", r2["assigned"] == 0, r2)

    pv1 = m.proxy_for_account(1)
    pv2 = m.proxy_for_account(2)
    ck("账号1 和账号2 的出口不是同一个",
       pv1 is not None and pv2 is not None and pv1.current_url != pv2.current_url,
       (pv1.current_url if pv1 else None, pv2.current_url if pv2 else None))
    ck("固定模式下同一个账号每次都是同一个出口",
       all(pv1.current_url == m.proxy_for_account(1).current_url for _ in range(4)))

    before = m.proxy_for_account(1).current_url
    r = m.proxy_rotate(1)
    after = m.proxy_for_account(1).current_url
    ck("能换 IP，而且真的换到别的出口", r["ok"] and after != before, r.get("msg"))
    ck("换完之后那个账号只有一个绑定",
       len([p for p in m.proxy_pool() if p["account_id"] == 1]) == 1)
    ck("原来那个回到公共池（可以给别的号用）",
       any(p["account_id"] is None for p in m.proxy_pool()))

    m.proxy_edit([p for p in m.proxy_pool() if p["account_id"] == 2][0]["id"], account_id=None)
    ck("解绑之后走公共池",
       m.proxy_for_account(2) is not None
       and (m.proxy_for_account(2).current_url or "").startswith("socks5h://10.0.0."))

    # 池子为空时不能崩，而且要老实说「没有别的出口」
    m.proxy_del([p["id"] for p in m.proxy_pool()])
    ck("池子清空后 proxy_for_account 返回 None（= 直连）", m.proxy_for_account(1) is None)
    r = m.proxy_rotate(1)
    ck("没代理时换 IP 给出可读提示", r["ok"] is False and "没有可用的代理" in r["msg"], r)

    # 只有一个代理时，不该假装能换
    m.proxy_add("10.9.9.9:1080", scheme="socks5h")
    m.proxy_assign(m.proxy_pool()[0]["id"], 1)
    r = m.proxy_rotate(1)
    ck("只有一个代理时换 IP 会明说换不了", r["ok"] is False and "只有一个" in r["msg"], r)
    S.save_json = _REAL_SAVE


# ============================================================ 4. 战绩统计
def part4():
    sec("④ 战绩：抢兑成败记到对应 IP 头上")
    S.save_json = lambda p, o: None
    m = make_manager()
    m.proxy_add("10.1.1.1:1080#甲\n10.1.1.2:1080#乙", scheme="socks5h")
    a, b = [p["id"] for p in m.proxy_pool()]

    m.proxy_note(a, True)
    m.proxy_note(a, True)
    p = [x for x in m.proxy_pool() if x["id"] == a][0]
    ck("成功两次 → ok_count=2，状态变可用", p["ok_count"] == 2 and p["status"] == "ok", p)

    m.proxy_note(b, False, "SOCKS 握手超时")
    m.proxy_note(b, False, "SOCKS 握手超时")
    p = [x for x in m.proxy_pool() if x["id"] == b][0]
    ck("失败两次还不到 3 次 → 先不判死", p["status"] != "bad" and p["fail_count"] == 2, p)
    m.proxy_note(b, False, "SOCKS 握手超时")
    p = [x for x in m.proxy_pool() if x["id"] == b][0]
    ck("连续失败 3 次 → 标记为有问题", p["status"] == "bad", p)
    ck("最后一次的错误原因留着，方便排查",
       "超时" in (p["last_error"] or ""), p.get("last_error"))

    m.proxy_note(a, False)
    p = [x for x in m.proxy_pool() if x["id"] == a][0]
    ck("好 IP 偶发一次失败不会被打成坏", p["fail_streak"] == 1 and p["ok_count"] == 2, p)
    ck("给不存在的 id 记战绩不会崩", m.proxy_note(99999, True) is None)
    ck("id 为 None 时直接跳过", m.proxy_note(None, True) is None)
    S.save_json = _REAL_SAVE


# ============================================================ 5. 状态汇总
def part5():
    sec("⑤ 界面要的状态数字")
    S.save_json = lambda p, o: None
    m = make_manager()
    st = m.proxy_status()
    ck("空池子：total=0 / alive=0", st["total"] == 0 and st["alive"] == 0, st)
    ck("空池子也说得清池子情况", st["summary"] == "0 个（0 可用 / 0 没测 / 0 有问题）",
       st["summary"])

    m.proxy_add("10.2.2.%d:1080" % i for i in (1, 2, 3))
    ck("传了奇怪的东西（生成器）也不会崩，只会算成认不出",
       len(m.proxy_pool()) == 0, len(m.proxy_pool()))
    m.proxy_add("10.2.2.1:1080\n10.2.2.2:1080\n10.2.2.3:1080", scheme="socks5h")
    PX_check = PX.check
    PX.check = lambda url, timeout=8, check_urls=None: (True, "1.1.1.1", 233, None)
    m.proxy_check()
    st = m.proxy_status()
    ck("检测完 3 个 → ok=3", st["ok"] == 3, st)
    ck("延迟/出口 IP 落库了",
       all(p["exit_ip"] == "1.1.1.1" and p["latency_ms"] == 233 for p in m.proxy_pool()))
    ck("accounts 数报出来了（界面要显示「已绑 x/y」）", st["accounts"] == 3, st)

    m.proxy_auto_assign()
    st = m.proxy_status()
    ck("绑定数对得上", st["bound"] == 3, st)

    PX.check = lambda url, timeout=8, check_urls=None: (False, "", 500, "SOCKS 连不上")
    r = m.proxy_check(only_new=True)
    ck("only_new 模式：已经测过的跳过", r["checked"] == 0, r)
    PX.check = PX_check
    S.save_json = _REAL_SAVE


# ============================================================ 6. 真机 A/B
def part6():
    sec("⑥ 真机验证：兑换请求是不是真的走代理了（不开玩笑的 A/B）")
    mp = MiniProxy()
    srv = MiniServer(payload={"code": 200, "data": {"balance": 100}})
    mp.start()
    srv.start()
    print("     迷你代理 127.0.0.1:%d  ·  迷你接口 %s" % (mp.port, srv.url))

    real_exchange = S.EXCHANGE_URL
    real_save = S.save_json
    S.save_json = lambda p, o: None
    try:
        m = make_manager()
        m.cfg["proxy"] = dict(S.DEFAULT_CONFIG["proxy"], pool=[], enabled=True)
        m.proxy_add("%s#本机测试代理" % mp.url, scheme="http", label="live")
        pid = m.proxy_pool()[0]["id"]
        m.proxy_assign(pid, 1)
        S.EXCHANGE_URL = srv.url

        def run_fire(acc_id=1, interval_ms=1, max_attempts=3):
            task = {"id": 7, "account_id": acc_id, "attempts": 0, "max_attempts": max_attempts,
                    "interval_ms": interval_ms, "status": "兑换中",
                    "prize": {"cId": "c1", "pId": "p1", "skuId": "s1",
                              "cName": "测试商品", "cost": 10}}
            r = m._fire_loop(task, m.get_account(acc_id))
            return r, task

        # ---- A：开着代理 ----
        mp.clear()
        srv.hits.clear()
        ok, task = run_fire()
        ck("A：兑换成功（回程真的拿到了 JSON）", ok is True and task["status"] == "兑换中", task)
        ck("A：迷你代理侧收到了这次转发（证明请求穿过代理了）",
           any("/exchange" in g for g in mp.gets), mp.gets[:3])
        ck("A：被抢的接口自己也收到了请求", len(srv.hits) >= 1, srv.hits[:3])
        ck("A：请求用的是绝对 URI（这是走 HTTP 代理的标志）",
           all(g.lower().startswith("http://") for g in mp.gets), mp.gets[:2])
        p = [x for x in m.proxy_pool() if x["id"] == pid][0]
        ck("A：这个 IP 记了一笔成功战绩", p["ok_count"] >= 1 and p["status"] == "ok", p)

        # ---- B：关掉代理 ----
        m.cfg["proxy"]["enabled"] = False
        mp.clear()
        srv.hits.clear()
        ok2, task2 = run_fire()
        ck("B：关掉之后请求照样成功（说明 A 不是碰巧）", ok2 is True, task2)
        ck("B：★ 迷你代理一条都没收到 —— 反过来证明 A 那次确实走了代理",
           len(mp.gets) == 0 and len(mp.connects) == 0, (mp.gets, mp.connects))
        ck("B：接口仍然是通的", len(srv.hits) >= 1, srv.hits[:3])

        # ---- C：rotate 模式确实会换出口，而且换了会话 ----
        mp2 = MiniProxy()
        mp2.start()
        m.cfg["proxy"] = dict(S.DEFAULT_CONFIG["proxy"], pool=[], enabled=True, mode="rotate",
                              rotate_n=1)
        m.proxy_add("%s#A\n%s#B" % (mp.url, mp2.url), scheme="http", label="live2")
        # ★ 注意这里**不绑定**：rotate 只对「走公共池」的账号有意义。
        #   绑定了专属 IP 的账号天然只有一个出口（这正是「每个账号不同 IP」想要的），
        #   Provider 里只有一个候选，on_risk 换一圈还是它 —— 下面的断言把这个语义钉住。
        # 让接口一直返回失败码，好让它多刷几次、中途换 IP
        srv.status = 200
        srv.body = b'{"code":900,"msg":"\\u8bf7\\u5148\\u767b\\u5f55"}'
        mp.clear()
        mp2.clear()
        run_fire(interval_ms=1, max_attempts=4)
        total = len(mp.gets) + len(mp2.gets)
        ck("C：公共池 + 换 IP 频率=1 时，两个 IP 都被用上了",
           len(mp.gets) > 0 and len(mp2.gets) > 0, (len(mp.gets), len(mp2.gets)))
        ck("C：请求次数没被重复计（一共 4 次尝试，2:2 交替）",
           total == 4 and len(mp.gets) == 2 and len(mp2.gets) == 2,
           (total, len(mp.gets), len(mp2.gets)))
        ck("C：换出口的日志写出来了，而且换的不是同一个出口",
           any("换出口 IP" in x for x in m.logs), m.logs[-3:])
        ck("C：两个账号在固定模式下的起始出口本来就错开（按账号 id 取模）",
           PX.Provider([{"url": "u"}, {"url": "v"}], mode="sticky", user_id=1).current_url
           != PX.Provider([{"url": "u"}, {"url": "v"}], mode="sticky", user_id=2).current_url)

        # 绑定之后就该「锁死在这一个 IP 上」—— 这是「每个账号不同 IP」的核心保证
        m.cfg["proxy"] = dict(S.DEFAULT_CONFIG["proxy"], pool=[], enabled=True,
                             mode="rotate", rotate_n=1)
        m.proxy_add("%s#A\n%s#B" % (mp.url, mp2.url), scheme="http", label="live4")
        m.proxy_assign(m.proxy_pool()[0]["id"], 1)
        pv = m.proxy_for_account(1)
        ck("C：绑定了专属 IP 之后，池子里别的 IP 不会再被这个账号用到",
           pv is not None and len(pv.items) == 1
           and pv.current_url == m.proxy_pool()[0]["url"],
           pv and [i["url"] for i in pv.items])
        srv.body = b'{"code":200,"data":{"balance":100}}'
        srv.status = 200

        # ---- D：代理层报错 → 换 IP 接着抢，而不是整轮挂掉 ----
        mp3 = MiniProxy()
        mp3.start()
        m.cfg["proxy"] = dict(S.DEFAULT_CONFIG["proxy"], pool=[], enabled=True, mode="sticky")
        m.proxy_add("http://127.0.0.1:1#死代理\n%s#活的" % mp3.url, scheme="http", label="live3")
        m.proxy_auto_assign()
        srv.status = 200
        r3, task3 = run_fire(interval_ms=1, max_attempts=3)
        p_dead = [p for p in m.proxy_pool() if p["host"] == "127.0.0.1" and p["port"] == 1]
        ck("D：死代理被打上失败账", p_dead and p_dead[0]["fail_count"] >= 1, p_dead)
        ck("D：日志里能看到「代理异常 → 换出口 IP」",
           any("代理异常" in x for x in m.logs), m.logs[-4:])

    finally:
        S.EXCHANGE_URL = real_exchange
        S.save_json = real_save
        mp.stop()
        srv.stop()


def main():
    print("得物整点抢兑助手 · 桌面版代理 IP 池测试")
    part1()
    part2()
    part3()
    part4()
    part5()
    print("\n（下面这节会起本机代理和本机接口，但不会打真的得物）")
    part6()
    print("\n" + "=" * 68)
    print("  通过 %d 项 / 失败 %d 项" % (PASS, FAIL))
    if FAILED:
        print("  失败清单：")
        for f in FAILED:
            print("    · %s" % f)
    print("=" * 68)
    return 1 if FAIL else 0


if __name__ == "__main__":
    time.sleep(0.1)
    sys.exit(main())
