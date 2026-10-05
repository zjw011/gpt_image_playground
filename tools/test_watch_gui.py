# -*- coding: utf-8 -*-
"""库存监听 GUI 回归测试（离屏跑，不联网、不碰真的 config.json）。

盯住这几件事:
  1. 顶部按钮三态文案（未开 / 已开启未运行 / 运行中）
  2. 弹窗控件齐全: 开关 · 间隔 · 监听账号 · 两个提醒勾选 · 四个按钮
  3. 状态区按 watch_status() 渲染（监听账号 / 已监听数量 / 上次检查 / 已提醒 / 错误）
  4. 「立即检查一次」= 子线程跑网络 + 信号回主线程刷界面（不能卡住、不能直接改控件）
  5. 「保存并应用」把参数写回 config 并真的启停监听线程
  6. 没配 PushPlus token 时有醒目提示；没账号时拒绝开启而不是崩

跑法:
    python tools/test_watch_gui.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

OK, BAD = [], []


def chk(name, cond, extra=""):
    (OK if cond else BAD).append(name)
    print("  %s %s%s" % ("[PASS]" if cond else "[FAIL]", name,
                         ("  " + str(extra)) if extra else ""))


# ---------------- 假界面 / 假后端 ----------------
class FakeBtn(object):
    """只要 text/setText/toolTip/setToolTip 就够 _refresh_watch_btn 用。"""

    def __init__(self):
        self._t = ""
        self._tip = ""

    def text(self):
        return self._t

    def setText(self, s):
        self._t = s

    def toolTip(self):
        return self._tip

    def setToolTip(self, s):
        self._tip = s


class FakeM(object):
    """按 dewu_sniper.Manager 的真实语义打桩。"""

    def __init__(self):
        self.accounts = [{"id": 1, "name": "账号1"}, {"id": 2, "name": "小号备用"}]
        self.saved = []
        self.started = 0
        self.stopped = 0
        self.once = 0
        self.logs = []
        self._st = {
            "enabled": False, "running": False, "account_id": 2,
            "account_name": "小号备用", "interval_sec": 30,
            "notify_new": True, "notify_restock": True, "tracked": 0,
            "baseline": False, "checked_at": None, "notified": 0,
            "errors": 0, "last_error": None, "push_ready": True,
        }

    def watch_status(self):
        return dict(self._st)

    def watch_save_cfg(self, **kw):
        kw = {k: v for k, v in kw.items() if v is not None}   # 同生产代码
        self.saved.append(kw)
        self._st.update(kw)
        return dict(self._st)

    def watch_start(self, **kw):
        self.started += 1
        self._st.update({"running": True, "enabled": True})
        return {"ok": True}

    def watch_stop(self, **kw):
        self.stopped += 1
        self._st.update({"running": False, "enabled": False})
        return {"ok": True}

    def watch_once(self):
        self.once += 1
        self._st.update({"tracked": 7, "checked_at": "10-02 11:22:33",
                         "notified": 4, "last_error": None,
                         "baseline": True})
        return True, "检查完成 · 已监听 7 个商品"

    def log(self, s):
        self.logs.append(s)


class FakePush(object):
    def __init__(self, ready):
        self.ready = ready

    def is_ready(self):
        return self.ready

    def preview_html(self, path=None):
        return os.path.join(ROOT, "推送样式预览.html")


MSGLOG = []


class FakeMB(object):
    Yes, No = 1, 0

    @staticmethod
    def information(*a, **k):
        MSGLOG.append(("info", a[1] if len(a) > 1 else ""))

    @staticmethod
    def warning(*a, **k):
        MSGLOG.append(("warn", a[1] if len(a) > 1 else ""))

    @staticmethod
    def question(*a, **k):
        return 1


import dewu_gui as G  # noqa: E402
from PySide6.QtCore import QTimer  # noqa: E402
from PySide6.QtWidgets import (  # noqa: E402
    QApplication, QWidget, QDialog, QLabel, QCheckBox, QComboBox,
    QSpinBox, QPushButton,
)

app = QApplication.instance() or QApplication([])

real_M, real_PUSH, real_MB = G.M, G.PUSH, G.QMessageBox
fakeM = FakeM()
G.M = fakeM
G.QMessageBox = FakeMB


class StubWin(QWidget):
    """冒充 MainWindow: 直接挂上用待测的两个方法，绕开真实 __init__
    （真 __init__ 会读真配置、拉真线程、建整棵控件树）。"""

    def __init__(self):
        super().__init__()
        self.btn_watch = FakeBtn()


StubWin._refresh_watch_btn = G.MainWindow._refresh_watch_btn
StubWin.stock_watch = G.MainWindow.stock_watch

win = StubWin()


def labels_of(dlg):
    return [l.text() for l in dlg.findChildren(QLabel)]


def find_dlg():
    """只看「还在屏幕上」的那个 —— accept() 之后对象还活着，只是 isVisible 变 False。"""
    for w in QApplication.topLevelWidgets():
        if isinstance(w, QDialog) and "库存监听" in w.windowTitle() and w.isVisible():
            return w
    return None


def btn(dlg, text):
    return next((b for b in dlg.findChildren(QPushButton) if b.text() == text), None)


def chkbox(dlg, text):
    return next((c for c in dlg.findChildren(QCheckBox) if c.text() == text), None)


# ---------------- 1. 顶部按钮三态 ----------------
print("== 1. 顶部按钮三态 ==")
fakeM._st.update({"enabled": False, "running": False})
win._refresh_watch_btn()
chk("没开 -> 文案「库存监听」", win.btn_watch.text() == "库存监听", win.btn_watch.text())

fakeM._st.update({"enabled": True, "running": True, "tracked": 12,
                  "account_name": "小号备用", "interval_sec": 45})
win._refresh_watch_btn()
chk("线程在跑 -> 「库存监听 · 运行中」",
    win.btn_watch.text() == "库存监听 · 运行中", win.btn_watch.text())
chk("提示里带账号/间隔/数量",
    "小号备用" in win.btn_watch.toolTip() and "45" in win.btn_watch.toolTip()
    and "12" in win.btn_watch.toolTip(), win.btn_watch.toolTip()[:60])

fakeM._st.update({"enabled": True, "running": False})
win._refresh_watch_btn()
chk("开着但线程没跑 -> 「已开启」",
    win.btn_watch.text() == "库存监听 · 已开启", win.btn_watch.text())


class Boom(FakeM):
    def watch_status(self):
        raise RuntimeError("boom")


_save_M = G.M
G.M = Boom()
win._refresh_watch_btn()
G.M = _save_M
chk("watch_status 抛异常也不崩（_poll 每 500ms 都会调它）", True)

# ---------------- 2. 弹窗控件齐全 ----------------
print("\n== 2. 弹窗控件与状态渲染 ==")
res = {}
res["err"] = None
fakeM._st.update({"enabled": False, "running": False, "tracked": 3,
                  "baseline": False, "checked_at": "10-02 10:00:00",
                  "notified": 2, "last_error": "code=500 服务开小差",
                  "account_id": 2, "interval_sec": 30,
                  "notify_new": True, "notify_restock": False})
G.PUSH = FakePush(ready=False)          # 故意没配 token -> 应该有警告


def step2():
    d = find_dlg()
    if d is None:
        res["err"] = "弹窗没弹出来"
        return
    res["dlg"] = d
    res["labels"] = labels_of(d)
    res["chk"] = [c.text() for c in d.findChildren(QCheckBox)]
    res["checked"] = {c.text(): c.isChecked() for c in d.findChildren(QCheckBox)}
    res["spin"] = [s.value() for s in d.findChildren(QSpinBox)]
    res["spin_suffix"] = [s.suffix() for s in d.findChildren(QSpinBox)]
    res["spin_range"] = [(s.minimum(), s.maximum()) for s in d.findChildren(QSpinBox)]
    res["combo"] = [(c.currentText(), c.currentData()) for c in d.findChildren(QComboBox)]
    res["btns"] = [b.text() for b in d.findChildren(QPushButton)]
    # 挪到第一个账号，验证「保存用的是下拉里选的那个」
    if d.findChildren(QComboBox):
        d.findChildren(QComboBox)[0].setCurrentIndex(0)
    # 模拟后台线程正在跑，方便验证顶部按钮联动
    fakeM._st.update({"enabled": True, "running": True})
    QTimer.singleShot(60, step3)


def step3():
    d = res["dlg"]
    box = chkbox(d, "开启库存监听")
    if box is not None:
        box.setChecked(True)          # 走和真实点击一样的 toggled 路径
    b = btn(d, "立即检查一次")
    res["btn_now"] = b
    if b is not None:
        b.click()
    res["now_disabled"] = (b is not None and not b.isEnabled())
    QTimer.singleShot(800, step4)


def step4():
    d = res["dlg"]
    res["labels2"] = labels_of(d)
    res["now_reenabled"] = res["btn_now"] is not None and res["btn_now"].isEnabled()
    res["tip_after"] = win.btn_watch.toolTip()
    res["text_after"] = win.btn_watch.text()
    ok = btn(d, "保存并应用")
    res["btn_ok"] = ok is not None
    if ok is not None:
        ok.click()          # on_ok -> 写配置 + watch_start + accept
    else:
        d.reject()


QTimer.singleShot(320, step2)
win.stock_watch()          # 阻塞在这一层事件循环里，上面的定时器负责推进

chk("弹窗成功打开并走完", res.get("err") is None and res.get("dlg") is not None, res.get("err"))
txts = res.get("labels") or []
chk("有 3 个勾选: 开关/新品/补货",
    res.get("chk") == ["开启库存监听", "新品上架提醒", "补货提醒"], res.get("chk"))
chk("勾选状态跟着配置回显（补货=False）",
    res.get("checked", {}).get("补货提醒") is False
    and res.get("checked", {}).get("新品上架提醒") is True, res.get("checked"))
chk("间隔是 QSpinBox、带「 秒」、范围 5~3600",
    res.get("spin") == [30] and res.get("spin_suffix") == [" 秒"]
    and res.get("spin_range") == [(5, 3600)],
    "%s / %s / %s" % (res.get("spin"), res.get("spin_suffix"), res.get("spin_range")))
chk("监听账号下拉列出全部账号、默认选中配置里那个",
    res.get("combo") == [("小号备用", 2)], res.get("combo"))
for t in ("立即检查一次", "样式预览", "保存并应用", "取消"):
    chk("按钮存在: %s" % t, t in (res.get("btns") or []), res.get("btns"))

joined = " | ".join(txts)
chk("状态区显示监听账号", "小号备用" in joined)
chk("没建基线时状态区提示「还没建立基线」而不是「0 个商品」",
    "还没建立基线" in joined and "0 个商品" not in joined, joined[:80])
chk("状态区显示上次检查时间", "10-02 10:00:00" in joined)
chk("状态区显示已提醒 2 件", "2 件" in joined)
chk("状态区显示最近错误原文", "code=500" in joined)
chk("没配 token 时给出醒目警告", any("还没配 PushPlus token" in t for t in txts))

# ---------------- 3. 立即检查一次: 子线程 + 信号回主线程 ----------------
print("\n== 3. 「立即检查一次」走子线程 + 信号回主线程 ==")
chk("点了之后按钮先禁用（防连点）", res.get("now_disabled") is True)
chk("真的调用了 watch_once", fakeM.once == 1, fakeM.once)
chk("检查完按钮恢复可点", res.get("now_reenabled") is True)
after = " | ".join(res.get("labels2") or [])
chk("结果文案回填到弹窗（说明信号确实回到了主线程）",
    "检查完成 · 已监听 7 个商品" in after)
chk("状态区被刷新（已监听 7 个）", "7 个商品" in after)
chk("顶部按钮同步刷新 -> 运行中", res.get("text_after") == "库存监听 · 运行中",
    res.get("text_after"))
chk("顶部按钮提示也带上了最新监听数量", "7 个商品" in (res.get("tip_after") or ""),
    res.get("tip_after"))

# ---------------- 4. 保存并应用 ----------------
print("\n== 4. 保存并应用 ==")
saved = fakeM.saved[-1] if fakeM.saved else {}
chk("把 5 个参数一次性写回 config",
    set(saved) >= {"enabled", "account_id", "interval_sec", "notify_new",
                   "notify_restock"}, saved)
chk("勾了开关 -> enabled=True", saved.get("enabled") is True, saved.get("enabled"))
chk("account_id 用下拉里选的那个（不是配置里原来的 2）",
    saved.get("account_id") == 1, saved.get("account_id"))
chk("补货勾选回写为 False（跟着界面走）",
    saved.get("notify_restock") is False, saved.get("notify_restock"))
chk("真的启动了监听线程", fakeM.started == 1, fakeM.started)
chk("弹窗已关闭", find_dlg() is None)
chk("弹了「已开启」提示", any(k == "info" for k, _ in MSGLOG), MSGLOG)

# ---------------- 5. 关掉开关走 watch_stop ----------------
print("\n== 5. 关掉开关走 watch_stop ==")
stopped_before = fakeM.stopped
MSGLOG[:] = []
res2 = {}


def step_b():
    d = find_dlg()
    if d is None:
        res2["err"] = "第二次弹窗没弹出来"
        return
    res2["dlg"] = d
    res2["checked_on_open"] = chkbox(d, "开启库存监听").isChecked()
    chkbox(d, "开启库存监听").setChecked(False)
    ok = btn(d, "保存并应用")
    if ok is not None:
        ok.click()
    else:
        d.reject()


QTimer.singleShot(320, step_b)
win.stock_watch()
chk("第二次弹窗正常", res2.get("err") is None, res2.get("err"))
chk("重开时开关回显为「开」（上次保存生效了）", res2.get("checked_on_open") is True)
chk("关掉开关 -> 调用了 watch_stop", fakeM.stopped == stopped_before + 1, fakeM.stopped)
chk("enabled 写成 False", fakeM.saved[-1].get("enabled") is False, fakeM.saved[-1])
chk("关的时候不弹 info（安静地关掉）",
    all(k != "info" for k, _ in MSGLOG), MSGLOG)
chk("弹窗已关闭", find_dlg() is None)

# ---------------- 6. 没账号时的兜底 ----------------
print("\n== 6. 没账号的兜底 ==")
saved_started = fakeM.started
saved_accounts = fakeM.accounts
fakeM.accounts = []
MSGLOG[:] = []
res3 = {}


def step_c():
    d = find_dlg()
    if d is None:
        res3["err"] = "第三次弹窗没弹出来"
        return
    res3["dlg"] = d
    res3["labels"] = labels_of(d)
    chkbox(d, "开启库存监听").setChecked(True)
    ok = btn(d, "保存并应用")
    if ok is not None:
        ok.click()           # 应该被 warning 拦下、弹窗保持打开
    res3["still_open"] = d.isVisible()
    d.reject()


QTimer.singleShot(320, step_c)
win.stock_watch()
fakeM.accounts = saved_accounts
chk("第三次弹窗正常并关掉", res3.get("err") is None, res3.get("err"))
chk("提示还没有账号",
    any("还没有账号" in t for t in (res3.get("labels") or [])), res3.get("labels"))
chk("没账号时点保存 -> warning 拦下，不启动线程",
    any(k == "warn" for k, _ in MSGLOG) and fakeM.started == saved_started, MSGLOG)
chk("被拦下时弹窗保持打开（让人去加账号）", res3.get("still_open") is True)

# ---------------- 7. 源码守卫 ----------------
print("\n== 7. 接线守卫（防止以后被改断） ==")
src = open(os.path.join(ROOT, "dewu_gui.py"), encoding="utf-8").read()
chk("有 _WatchBridge 且是 3 参数信号",
    "class _WatchBridge" in src and "Signal(bool, str, dict)" in src)
chk("btn_watch 连到了 stock_watch",
    "self.btn_watch.clicked.connect(self.stock_watch)" in src)
chk("btn_watch 挂在顶部工具栏里",
    "btn_ntp, self.btn_answer, self.btn_watch, self.btn_push):" in src)
chk("__init__ 里调了 _refresh_watch_btn", "        self._refresh_watch_btn()\n" in src)
chk("_poll 里也会刷新按钮",
    "_sync_header(accounts, tasks)\n        self._refresh_watch_btn()" in src)
chk("立即检查放到了子线程里跑（网络操作别卡界面）",
    'target=work, name="watch-once"' in src)
chk("开启/关闭走的是后端 watch_start / watch_stop",
    "M.watch_start()" in src and "M.watch_stop()" in src)

G.M, G.PUSH, G.QMessageBox = real_M, real_PUSH, real_MB

print("\n" + "=" * 46)
print("通过 %d 项, 失败 %d 项" % (len(OK), len(BAD)))
if BAD:
    print("失败:")
    for b in BAD:
        print("  -", b)
sys.exit(1 if BAD else 0)
