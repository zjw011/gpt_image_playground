# -*- coding: utf-8 -*-
"""
得物整点抢兑助手 · 微信推送（PushPlus）

设计要点
--------
1. **零第三方依赖**：只用标准库 urllib，不给 exe 增加体积，也不用改 spec 的 hiddenimports。
2. **配置跟着 config.json 走**：存在 config.json 的 "pushplus" 段，
   并且会同步回 M.cfg（dewu_sniper 里那份内存配置），
   这样 GUI 关闭时 `save_json(CONFIG_PATH, M.cfg)` 不会把推送设置覆盖掉。
3. **发送永不阻塞抢兑**：`send_async()` 丢到守护线程里发，失败只写日志，绝不抛给调用方。

   ⚠ 这一点很关键：抢兑是在时间窗内连发的，任何网络等待都不能插到连发循环里。
   所以 notify_* 一律异步。

4. **token 不回显全文**：界面/日志里只显示 mask_key() 的结果。

5. **群发（一对多）**：PushPlus 的一对多不是另一个接口，就是同一个 /send
   多带一个 `topic=群组编码`，一次请求推给群里所有成员。
   本模块只把**库存通知**走上群发（用户明确要求：群组只发库存变化），
   抢兑成功/失败始终只私发。
   额度提醒：微信渠道实名用户 200 次/天，且**相同内容 1 小时最多 3 条** ——
   所以卡片里带了「发现时间」，内容天然不会重复。
"""
import json
import os
import sys
import threading
import datetime
import urllib.error
import urllib.request

APP_DIR = (os.path.dirname(os.path.abspath(sys.argv[0]))
           if getattr(sys, "frozen", False)
           else os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(APP_DIR, "config.json")

API_URL = "https://www.pushplus.plus/send"
TIMEOUT = 15
CFG_KEY = "pushplus"

DEFAULT_PUSH = {
    "key": "", "enabled": False, "on_fail": False, "sent": 0,
    # ---- 群发（PushPlus 一对多）----
    # 同一套 /send 接口多带一个 topic=群组编码，一次请求推给群里所有成员。
    # ★ 群组【只用于库存变化】，抢兑成功/失败一律不群发（账号备注不适合发群里）。
    # topic 为空 = 群发功能整体关闭。
    "topic": "",
    "group_stock": True,      # 库存监听到新品/补货 → 也群发到群组
    "group_self_too": True,   # 群发之外，照旧私发我一份（"也推送下"）
}


# ------------------------------------------------------------------ 配置读写
def _read_file():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _write_file(d):
    try:
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
        os.replace(tmp, CONFIG_PATH)
        return True
    except Exception:
        return False


def _sync_to_memory(cfg):
    """把配置写回 dewu_sniper 的内存配置，避免稍后保存窗口尺寸时被旧值覆盖。"""
    try:
        import dewu_sniper
        if isinstance(getattr(dewu_sniper, "M", None), object) and hasattr(dewu_sniper.M, "cfg"):
            dewu_sniper.M.cfg[CFG_KEY] = dict(cfg)
    except Exception:
        pass


def load():
    """读取推送配置（缺字段用默认值补齐）。"""
    raw = _read_file().get(CFG_KEY)
    cfg = dict(DEFAULT_PUSH)
    if isinstance(raw, dict):
        for k in DEFAULT_PUSH:
            if k in raw:
                cfg[k] = raw[k]
    cfg["key"] = (cfg.get("key") or "").strip()
    cfg["enabled"] = bool(cfg.get("enabled"))
    cfg["on_fail"] = bool(cfg.get("on_fail"))
    cfg["topic"] = clean_topic(cfg.get("topic"))
    for k in ("group_stock", "group_self_too"):
        cfg[k] = bool(cfg.get(k))
    return cfg


_TOPIC_CHARS = set("abcdefghijklmnopqrstuvwxyz"
                   "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")


def clean_topic(t):
    """规整群组编码：去空格、只留 PushPlus 允许的字符（ASCII 字母/数字/_/-）。

    用户从网页复制时容易带上空格、全角字符。注意**不能用 str.isalnum()** ——
    它对中文也返回 True，而 PushPlus 的群组编码只接受 ASCII。
    """
    t = (t or "").strip().replace("　", "").replace(" ", "")
    return "".join(ch for ch in t if ch in _TOPIC_CHARS)[:32]


def save(key=None, enabled=None, on_fail=None, topic=None,
         group_stock=None, group_self_too=None):
    """保存推送配置（只改传入的字段），返回保存后的配置。"""
    cfg = load()
    if key is not None:
        cfg["key"] = (key or "").strip()
    if enabled is not None:
        cfg["enabled"] = bool(enabled)
    if on_fail is not None:
        cfg["on_fail"] = bool(on_fail)
    if topic is not None:
        cfg["topic"] = clean_topic(topic)
    if group_stock is not None:
        cfg["group_stock"] = bool(group_stock)
    if group_self_too is not None:
        cfg["group_self_too"] = bool(group_self_too)
    full = _read_file()
    full[CFG_KEY] = cfg
    _write_file(full)
    _sync_to_memory(cfg)
    return cfg


def mask_key(k):
    """把 token 打码成 70ef…062e 的形式，用于界面与日志。"""
    k = (k or "").strip()
    if not k:
        return "（未设置）"
    if len(k) <= 10:
        return k[:2] + "…" + k[-2:]
    return "%s…%s" % (k[:4], k[-4:])


def is_ready():
    """已配置 key 且开关打开 —— 才允许真发。"""
    c = load()
    return bool(c["key"]) and bool(c["enabled"])


def status_text():
    """按钮/界面上的三态文案。

    刻意**只反映 key + 总开关**，不掺群发状态 ——
    群发是附加能力，别让它把「推送开没开」这件事搅浑（也免得耦合测试）。
    群发状态单独用 group_summary() 展示。
    """
    c = load()
    if not c["key"]:
        return "未设置"
    if not c["enabled"]:
        return "已关闭"
    return "已开启"


def group_on():
    """库存变化要不要群发到群组（群组只用于库存，抢兑结果永不群发）。"""
    c = load()
    return bool(c["topic"]) and bool(c["group_stock"])


def group_summary():
    """给界面用的一句话：当前群发配置是什么样。"""
    c = load()
    if not c["topic"]:
        return "群发：未设置 —— 库存通知只有你自己收得到"
    if not c["group_stock"]:
        return "群发：已填「%s」但没勾「库存变化也群发」，实际不会群发" % c["topic"]
    if c["group_self_too"]:
        return "群发到「%s」：库存变化发给群成员 + 你自己私发一份" % c["topic"]
    return "群发到「%s」：库存变化只发群（你自己也在这个群里才会收到）" % c["topic"]


# ------------------------------------------------------------------ 发送
def _log(msg):
    try:
        import dewu_sniper
        dewu_sniper.M.log("[推送] %s" % msg)
        return
    except Exception:
        pass
    try:
        import dewu_sniper
        dewu_sniper.flog("[推送] %s" % msg)
    except Exception:
        pass


def send(title, content, token=None, template="html", timeout=TIMEOUT, topic=None):
    """同步发送。返回 (ok: bool, msg: str)。不会抛异常。

    topic 非空 = 一对多（群发）：消息发给「群组编码 = topic」里的全体成员。
    ★ PushPlus 规定 topic（群组）和 to（好友）不能同时填，这里只填 topic。
    """
    tok = (token or "").strip() or load()["key"]
    if not tok:
        return False, "还没填 PushPlus token"
    payload = {
        "token": tok,
        "title": title[:100],
        "content": content,
        "template": template,
    }
    tp = clean_topic(topic)
    if tp:
        payload["topic"] = tp
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        API_URL, data=body,
        headers={"Content-Type": "application/json; charset=utf-8"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            txt = r.read().decode("utf-8", "replace")
        j = json.loads(txt)
    except urllib.error.HTTPError as e:
        return False, "HTTP %s %s" % (e.code, e.read().decode("utf-8", "replace")[:120])
    except Exception as e:
        return False, "网络异常：%r" % (e,)

    if j.get("code") == 200:
        return True, "发送成功"
    m = j.get("msg") or txt[:120]
    # 实测：群组编码不存在 / 群组还没审核通过时，PushPlus 回的是「服务端验证错误」，
    # 这句话对用户毫无信息量，这里补一句人话。
    if tp and ("验证" in m or "不存在" in m):
        m += "（多半是群组编码「%s」填错了，或这个群组还在审核中）" % tp
    return False, "接口返回：%s" % m


def send_async(title, content, token=None, template="html", on_done=None,
               topic=None, tag=""):
    """异步发送，抢兑/监听流程里一律用这个。

    tag 只影响日志前缀（"群发「dewu」" / "私发"），方便事后分辨发给了谁。
    """
    def _run():
        ok, msg = send(title, content, token=token, template=template, topic=topic)
        _log(("✓ " if ok else "✗ ") + msg
             + (" · " + tag if tag else "") + " · " + title)
        if on_done:
            try:
                on_done(ok, msg)
            except Exception:
                pass
    t = threading.Thread(target=_run, name="pushplus-send", daemon=True)
    t.start()
    return t


def send_stock(title, content):
    """库存通知专用出口：私发一份 +（若配了）群发一份。

    为什么要「私发 + 群发」两份：用户要的是「群里**也**推送下」。
    私发那份保证无论群组配置怎么变，你自己一定收得到；
    群发那份让群成员也看到。收两条是刻意的，嫌重复就把
    「也私发我一份」取消掉。
    """
    c = load()
    topic = c["topic"] if (c["topic"] and c["group_stock"]) else ""
    if topic:
        send_async(title, content, topic=topic, tag="群发「%s」" % topic)
    if c["group_self_too"] or not topic:
        send_async(title, content, tag="私发")
    return bool(topic)


# ------------------------------------------------------------------ 卡片渲染
def _row(label, value, value_style=""):
    return (
        '<tr>'
        '<td style="padding:9px 0;font-size:13px;color:#7a8ba3;width:74px;'
        'vertical-align:top;white-space:nowrap">%s</td>'
        '<td style="padding:9px 0;font-size:14px;color:#1b2a41;line-height:1.5;'
        'word-break:break-all;%s">%s</td>'
        '</tr>' % (label, value_style, value)
    )


def build_card(kind, account, prize, cost, balance, ts, task_id=None,
               attempts=None, note=""):
    """拼一张卡片式 HTML（PushPlus 的 html 模板，在微信里直接渲染）。

    kind: "success" 抢兑成功 / "fail" 抢兑失败
    """
    ok = (kind == "success")
    if ok:
        grad = "linear-gradient(135deg,#2b7cf0 0%,#1a63d0 100%)"
        head_icon, head_title = "🎉", "抢兑成功"
        badge_bg, badge_fg, badge_txt = "#e6f7ee", "#12925a", "✓ 兑换成功"
        bar, sub_fg = "#2b7cf0", "#dce9fb"
    else:
        grad = "linear-gradient(135deg,#f0a53a 0%,#d9821f 100%)"
        head_icon, head_title = "⚠️", "抢兑失败"
        badge_bg, badge_fg, badge_txt = "#fff4e3", "#c98414", "× 兑换失败"
        bar, sub_fg = "#e8a33d", "#fdeed8"

    # 余额是成功卡片的主角(得物红加粗突出); 失败卡片上再标红只会显得像报错, 用中性色
    try:
        bal_txt = str(int(balance))
    except Exception:
        bal_txt = str(balance) if balance not in (None, "") else "—"
    if ok:
        bal_html = '<span style="color:#e6243f;font-weight:700;font-size:17px">%s</span>' % bal_txt
    else:
        bal_html = '<span style="color:#41506b;font-weight:700">%s</span>' % bal_txt

    rows = _row("账号", account or "—")
    rows += _row("商品", prize or "—",
                 "font-weight:700;font-size:15px;color:#1b2a41")
    if cost not in (None, ""):
        rows += _row("消耗金币", "%s" % cost)
    rows += _row("剩余金币", bal_html)
    rows += _row("完成时间", ts)
    if task_id is not None:
        rows += _row("任务", "任务 #%s%s" % (
            task_id,
            (" · 第 %s 次尝试成功" % attempts) if attempts else ""))

    if not note:
        note = ("该商品已进入你的得物账户，可在 App「我的 → 兑换记录」中查看。"
                if ok else "本次未抢到，可在「日志」页查看服务端返回的具体原因。")

    return """<div style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;\
background:#eef3fa;padding:14px">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;\
box-shadow:0 3px 16px rgba(20,40,80,.10)">

  <div style="background:%s;padding:20px 22px">
    <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:.5px">%s %s</div>
    <div style="font-size:12px;color:%s;margin-top:5px">得物整点抢兑助手 · 自动通知</div>
  </div>

  <div style="padding:16px 22px 2px">
    <span style="display:inline-block;background:%s;color:%s;font-size:12px;font-weight:700;\
padding:4px 12px;border-radius:999px">%s</span>
  </div>

  <div style="padding:0 22px">
    <table style="width:100%%;border-collapse:collapse;table-layout:fixed">
      <tbody>
%s
      </tbody>
    </table>
  </div>

  <div style="padding:6px 22px 18px">
    <div style="background:#f8fbff;border-left:3px solid %s;border-radius:0 8px 8px 0;\
padding:10px 13px;font-size:12px;color:#5b6b83;line-height:1.7">%s</div>
  </div>

  <div style="background:#fafcff;border-top:1px solid #eef3fa;padding:11px 22px;\
font-size:11px;color:#93a3bb">由「得物整点抢兑助手」自动发出 · 请勿回复</div>
</div>
</div>""" % (grad, head_icon, head_title, sub_fg, badge_bg, badge_fg, badge_txt,
             rows, bar, note)


def _now():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ------------------------------------------------------------------ 对外的通知入口
# ★ 群发只管「库存通知」这一条线：notify_stock → send_stock（私发 + 群发）。
#   notify_success / notify_fail（抢兑结果）**永远只私发** ——
#   卡片里有账号备注和剩余金币，不该发到群里。
def notify_success(account, prize, cost=None, balance=None, attempts=None, task_id=None,
                   note=""):
    """抢兑成功 → 推送。异步，不阻塞抢兑线程。

    note 非空时覆盖卡片底部的默认说明（自动降级抢到的会在这里写清原委）。
    """
    if not is_ready():
        return False
    title = "🎉 抢兑成功 | %s" % (prize or "商品")
    card = build_card("success", account, prize, cost, balance, _now(),
                      task_id=task_id, attempts=attempts, note=note)
    send_async(title, card)
    return True


def notify_fail(account, prize, reason="", cost=None, balance=None, task_id=None):
    """抢兑失败 → 推送（需在设置里勾选「失败也推送」）。"""
    c = load()
    if not (c["key"] and c["enabled"] and c["on_fail"]):
        return False
    title = "⚠️ 抢兑失败 | %s" % (prize or "商品")
    card = build_card("fail", account, prize, cost, balance, _now(),
                      task_id=task_id,
                      note=reason or "本次未抢到，可在「日志」页查看服务端返回的具体原因。")
    send_async(title, card)
    return True


def build_stock_card(items, account, ts, interval_sec=None):
    """库存监听的卡片：新品上架 / 补货。

    items: [{"cName":..., "cost":..., "stock":..., "kind": "new"|"restock"}]
    """
    items = list(items or [])
    kinds = set(i.get("kind") for i in items)
    if kinds == {"restock"}:
        head_icon, head_title = "🔔", "有货了"
        badge_bg, badge_fg, badge_txt = "#e6f7ee", "#12925a", "✓ 补货"
        grad, bar = "linear-gradient(135deg,#1d9e75 0%,#0f6e56 100%)", "#1d9e75"
    elif kinds == {"new"}:
        head_icon, head_title = "🆕", "新品上架"
        badge_bg, badge_fg, badge_txt = "#e6f1fb", "#185fa5", "＋ 新品"
        grad, bar = "linear-gradient(135deg,#3b82d6 0%,#1a63d0 100%)", "#3b82d6"
    else:
        head_icon, head_title = "🔔", "库存变化"
        badge_bg, badge_fg, badge_txt = "#eef3fa", "#41506b", "库存更新"
        grad, bar = "linear-gradient(135deg,#5b7fb8 0%,#3a5c92 100%)", "#5b7fb8"

    MAXN = 12
    shown = items[:MAXN]
    rows = ""
    for it in shown:
        kind = it.get("kind")
        if kind == "new":
            tag = ('<span style="display:inline-block;background:#e6f1fb;color:#185fa5;'
                   'padding:2px 8px;border-radius:999px;font-weight:700">新品</span>')
        else:
            tag = ('<span style="display:inline-block;background:#e6f7ee;color:#12925a;'
                   'padding:2px 8px;border-radius:999px;font-weight:700">补货</span>')
        cost = it.get("cost")
        cost_html = ("<b style=\"color:#e6243f;font-size:14px\">%s</b>" % cost
                     if cost not in (None, "") else "—")
        stk = it.get("stock")
        stk_html = ("<b style=\"color:#1b2a41\">%s</b>" % stk
                    if stk not in (None, "") else "—")
        rows += (
            '<div style="padding:11px 0;border-bottom:1px solid #eef3fa">'
            '<div style="font-size:14px;font-weight:700;color:#1b2a41;line-height:1.45;'
            'word-break:break-all">%s</div>'
            '<div style="margin-top:6px;font-size:12px;color:#7a8ba3">%s'
            '<span style="margin-left:9px">金币 %s</span>'
            '<span style="margin-left:9px">库存 %s</span>'
            '</div></div>' % (it.get("cName") or "（无名称）", tag, cost_html, stk_html))
    if len(items) > MAXN:
        rows += ('<div style="padding:10px 0;font-size:12px;color:#93a3bb">'
                 '…本次还有 %d 件，请到软件里查看完整列表</div>' % (len(items) - MAXN))

    meta = _row("监听账号", account or "—")
    meta += _row("发现时间", ts)
    meta += _row("变化数量", "%d 件" % len(items))
    if interval_sec:
        meta += _row("检查频率", "每 %s 秒一次" % interval_sec)

    note = ("这是「库存监听」探到的变化。打开软件 →「02 商品列表」刷新后，"
            "就能对这些商品建抢兑任务。")

    return """<div style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;\
background:#eef3fa;padding:14px">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;\
box-shadow:0 3px 16px rgba(20,40,80,.10)">

  <div style="background:%s;padding:20px 22px">
    <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:.5px">%s %s</div>
    <div style="font-size:12px;color:#dcefe8;margin-top:5px">得物整点抢兑助手 · 库存监听</div>
  </div>

  <div style="padding:16px 22px 2px">
    <span style="display:inline-block;background:%s;color:%s;font-size:12px;font-weight:700;\
padding:4px 12px;border-radius:999px">%s</span>
  </div>

  <div style="padding:0 22px">%s</div>

  <div style="padding:2px 22px 0">
    <table style="width:100%%;border-collapse:collapse;table-layout:fixed">
      <tbody>%s</tbody>
    </table>
  </div>

  <div style="padding:6px 22px 18px">
    <div style="background:#f8fbff;border-left:3px solid %s;border-radius:0 8px 8px 0;\
padding:10px 13px;font-size:12px;color:#5b6b83;line-height:1.7">%s</div>
  </div>

  <div style="background:#fafcff;border-top:1px solid #eef3fa;padding:11px 22px;\
font-size:11px;color:#93a3bb">由「得物整点抢兑助手」自动发出 · 请勿回复</div>
</div>
</div>""" % (grad, head_icon, head_title, badge_bg, badge_fg, badge_txt,
             rows, meta, bar, note)


def notify_stock(items, account=None, interval_sec=None):
    """库存监听发现新品/补货 → 推送。异步。

    走 send_stock：私发一份 +（若配了群组）群发一份。
    """
    items = list(items or [])
    if not items or not is_ready():
        return False
    kinds = set(i.get("kind") for i in items)
    if kinds == {"restock"}:
        head = "🔔 有货了"
    elif kinds == {"new"}:
        head = "🆕 新品上架"
    else:
        head = "🔔 库存变化"
    names = [i.get("cName") or "商品" for i in items]
    if len(names) == 1:
        title = "%s | %s" % (head, names[0][:40])
    else:
        title = "%s | %d 件（%s 等）" % (head, len(items), names[0][:24])
    card = build_stock_card(items, account, _now(), interval_sec=interval_sec)
    send_stock(title, card)
    return True


def notify_test(token=None, topic=None):
    """设置弹窗里的「发送测试」按钮 —— 同步返回结果，方便界面提示。

    topic=None 表示按当前输入框/配置来判断：
      · 填了群组编码 → 私发 + 群发各发一条，两条都报结果
        （这样用户一眼就知道「我到底在不在群里、群发通不通」）
      · 没填 → 只私发一条，和以前一样
    """
    c = load()
    tp = clean_topic(c["topic"] if topic is None else topic)
    card = build_card(
        "success", "测试账号（仅演示）", "示例商品 · 星巴克中杯拿铁券",
        cost=300, balance=1234, ts=_now(), task_id=1, attempts=3,
        note="这是一条测试推送。如果你看到了它，说明 token 填对了，"
             "真实抢兑成功时也会收到同样样式的通知。")
    if not tp:
        return send("🎉 抢兑成功 | 这是一条测试推送", card, token=token)
    ok_g, msg_g = send("📢 库存群发测试 | 群里所有人都该收到这条",
                       card, token=token, topic=tp)
    ok_s, msg_s = send("🎉 抢兑成功 | 这是一条测试推送（私发）",
                       card, token=token)
    if ok_g and ok_s:
        return True, "私发 + 群发「%s」都发出去了（群里那条标题带 📢）" % tp
    if ok_g and not ok_s:
        return False, "群发成功，但私发失败：%s" % msg_s
    if ok_s and not ok_g:
        return False, "私发成功，但群发失败：%s" % msg_g
    return False, "私发:%s / 群发:%s" % (msg_s, msg_g)


def preview_html(path=None):
    """把卡片渲染成一份本地 HTML，方便不开微信也能预览样式。"""
    path = path or os.path.join(APP_DIR, "推送样式预览.html")
    body = build_card("success", "账号1", "星巴克中杯拿铁券", 300, 1234,
                      _now(), task_id=7, attempts=3)
    body2 = build_card(
        "success", "小号·备用账号",
        "宝可梦集换式卡牌游戏 简体中文版 强化扩充包 剑盾系列 整箱 20 盒",
        12500, 860, _now(), task_id=12, attempts=1)
    body3 = build_card("fail", "账号1", "AirPods Pro 3", None, 1234, _now(),
                       task_id=8, note="余额不足：需要 12000 金币，当前只有 1234。")
    body4 = build_stock_card(
        [{"cName": "AirPods Pro 3", "cost": 12000, "stock": 3, "kind": "restock"}],
        "账号1", _now(), interval_sec=30)
    body5 = build_stock_card(
        [{"cName": "星巴克中杯拿铁券", "cost": 300, "stock": 20, "kind": "new"},
         {"cName": "OU 男士心动护手霜礼盒装 抗皱芳香补水滋润保湿舒缓清爽防干裂"
                  "不油腻高级香氛 木质调 柑橘调 60g+30g", "cost": 150, "stock": 8,
          "kind": "restock"},
         {"cName": "宝可梦集换式卡牌游戏 简体中文版 强化扩充包", "cost": 12500,
          "stock": 1, "kind": "new"}],
        "小号·备用账号", _now(), interval_sec=30)
    body6 = build_card(
        "success", "账号1", "AirPods Pro 3", 108, 2, _now(), task_id=15, attempts=1,
        note="⚠ 原配置的「任天堂 Switch 2 主机」已失效或抢不到，本单是【自动降级】后"
             "换商品抢到的。如果这不是你想要的，去任务列表关掉「自动降级」。")

    def cap(t):
        return ("<div style=\"padding:18px 14px 0;text-align:center;font-family:'Microsoft YaHei';"
                "font-size:13px;color:#7a8ba3\">%s</div>" % t)

    doc = ("<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
           "<title>推送样式预览</title></head><body style=\"margin:0;background:#eef3fa\">"
           + cap("① 抢兑成功")
           + body
           + cap("② 抢兑成功（超长商品名换行测试）")
           + body2
           + cap("③ 抢兑失败（开了「失败也推送」才发）")
           + body3
           + cap("④ 库存监听 · 补货（单件）")
           + body4
           + cap("⑤ 库存监听 · 一次多件（含超长商品名换行）")
           + body5
           + cap("⑥ 自动降级换商品抢到的（底部会写清原配置是哪个）")
           + body6
           + "<div style=\"height:20px\"></div></body></html>")
    with open(path, "w", encoding="utf-8") as f:
        f.write(doc)
    return path
