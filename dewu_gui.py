# -*- coding: utf-8 -*-
"""
得物整点抢兑助手 - 桌面版 (PySide6 原生窗口)
风格: 浅色系 · 浅蓝 + 纯白 · 卡片式仪表盘
复用 dewu_sniper.py 中的核心逻辑(账号管理 / 任务调度 / 兑换请求 / 全链路诊断)
"""
import os
import sys
import html as _html
import threading
import datetime

from PySide6.QtCore import Qt, QTimer, QRect, QObject, Signal
from PySide6.QtGui import QColor, QFont, QIcon, QPixmap
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QGridLayout,
    QLabel, QLineEdit, QPushButton, QComboBox, QTableWidget, QTableWidgetItem,
    QCheckBox, QTextEdit, QHeaderView, QMessageBox, QAbstractItemView,
    QFrame, QSpinBox, QSizePolicy, QScrollArea, QDialog, QDialogButtonBox,
)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dewu_sniper import (  # noqa: E402
    M, ntp_offset, save_json, CONFIG_PATH,
)
import dewu_login as DL  # noqa: E402
import dewu_push as PUSH  # noqa: E402
import dewu_answer as ANS  # noqa: E402


class _LoginBridge(QObject):
    """把后台登录线程的结果安全地送回 Qt 主线程"""
    status = Signal(str)
    captured = Signal(str, dict)
    done = Signal(dict)


class _PushBridge(QObject):
    """推送测试是网络操作, 放到子线程; 结果用信号送回主线程刷新界面"""
    done = Signal(bool, str)


class _WatchBridge(QObject):
    """库存监听的「立即检查」也是网络操作 → 子线程跑, 信号回主线程。"""
    done = Signal(bool, str, dict)     # 成功?, 提示文本, 最新监听状态


class _AnswerBridge(QObject):
    """答题全是网络操作: 取题目 / 下图片 / 依次提交, 全部放子线程。"""
    qinfo = Signal(dict, str)      # 今日题目信息, 错误文本(空串=成功)
    image = Signal(bytes)          # 题目图片原始字节
    one = Signal(str, dict)        # 单个账号答完: 账号名, 结果
    log = Signal(str)
    done = Signal(list)
    status = Signal(str, str)      # 启动探状态: state(done/todo), 题目日期

# ---------------- 设计令牌: 浅蓝 + 纯白 ----------------
C_BG = "#eef3fa"        # 页面底色(浅蓝灰)
C_CARD = "#ffffff"      # 卡片
C_CARD_SOFT = "#f8fbff"
C_LINE = "#dbe6f3"
C_LINE_SOFT = "#eaf1fa"
C_TXT = "#1b2a41"
C_SUB = "#7a8ba3"
C_ACC = "#2b7cf0"       # 主强调(浅蓝)
C_ACC_DK = "#1a63d0"
C_ACC_LT = "#e8f1ff"
C_BRAND = "#e6243f"     # 得物红(仅品牌标记)
C_OK = "#12925a"
C_DIS = "#a9b8cc"       # 不可用(未解锁): 浅灰
C_OOS = "#8b99ab"       # 缺货行正文: 中性灰(比未解锁深一档, 仍然可读)
C_WARN = "#c98414"
C_ERR = "#d9464b"
C_RUN = "#2b7cf0"

# ---------------- 圆角体系: 全局统一, 不要在别处再写魔法数字 ----------------
# ⚠ Qt 陷阱: border-radius 一旦 > 控件高度/2, Qt 会【直接不画圆角】(退化成直角),
#   而不是自动收敛成胶囊。所以越矮的元素越要用小圆角, 绝不能图省事写 999px。
R_CARD = 18     # 外层卡片: header / card            (高 >= 60)
R_BLOCK = 14    # 内容块: 表格 / 日志 / 诊断条容器      (高 >= 40)
R_INNER = 13    # 圆角容器内部(表头首尾列), = R_BLOCK - 1(容器边框)
R_PILL = 12     # 小按钮 / 胶囊标签: chip / picked / mini  (高 26~30)
R_CTRL = 10     # 普通按钮 / 输入框                    (高 32~36)
R_BADGE = 8     # 小徽标: 序号 / PRO / 提示图标         (高 20~26)
R_TINY = 6      # 极矮元素: 声明条里的「完整声明」按钮   (高 19)
R_HANDLE = 5    # 滚动条滑块

STATUS_COLOR = {"等待": C_WARN, "兑换中": C_RUN, "成功": C_OK,
                "失败": C_ERR, "已删除": C_SUB}

GLOBAL_QSS = f"""
QMainWindow, QWidget {{
    background: {C_BG}; color: {C_TXT};
    font-family: "Microsoft YaHei"; font-size: 13px;
}}
QLabel {{ background: transparent; color: {C_TXT}; }}

/* ---- 卡片 ---- */
QFrame#card {{
    background: {C_CARD}; border: 1px solid {C_LINE}; border-radius: {R_CARD}px;
}}
QFrame#header {{
    background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
        stop:0 #ffffff, stop:0.55 #f4f9ff, stop:1 #e6f1ff);
    border: 1px solid {C_LINE}; border-radius: {R_CARD}px;
}}
QLabel#brand {{
    background: qlineargradient(x1:0, y1:0, x2:1, y2:1,
        stop:0 {C_BRAND}, stop:1 #ff5a4e);
    color: #ffffff; font-size: 18px; font-weight: bold;
    border-radius: {R_BLOCK}px;
}}
QLabel#apptitle {{ font-size: 17px; font-weight: bold; color: {C_TXT}; letter-spacing: 1px; }}
QLabel#appsub {{ font-size: 11px; color: {C_SUB}; }}
QLabel#pro {{
    background: {C_ACC}; color: #ffffff; font-size: 10px; font-weight: bold;
    border-radius: {R_BADGE}px; padding: 2px 7px;
}}
QLabel#clock {{
    font-family: Consolas; font-size: 27px; font-weight: bold; color: {C_ACC};
    letter-spacing: 1px;
}}
QLabel#chip {{
    background: {C_CARD_SOFT}; color: #45608a; border: 1px solid {C_LINE};
    border-radius: {R_PILL}px; padding: 4px 13px; font-size: 12px;
}}
QLabel#chipAccent {{
    background: {C_ACC_LT}; color: {C_ACC_DK}; border: 1px solid #cfe2ff;
    border-radius: {R_PILL}px; padding: 4px 13px; font-size: 12px; font-weight: bold;
}}
QLabel#secnum {{
    background: {C_ACC_LT}; color: {C_ACC}; border-radius: {R_BADGE}px;
    padding: 2px 8px; font-family: Consolas; font-size: 11px; font-weight: bold;
}}
QLabel#sectitle {{ font-size: 14px; font-weight: bold; color: {C_TXT}; }}
QLabel#sectip {{ font-size: 11px; color: {C_SUB}; }}
QLabel#fieldlbl {{ font-size: 11px; color: {C_SUB}; }}
/* ---- 每日答题 ---- */
QLabel#ansimg {{
    background: {C_CARD_SOFT}; border: 1px solid {C_LINE};
    border-radius: 14px; color: {C_SUB}; font-size: 12px;
}}
QLineEdit#ansbig {{
    font-size: 17px; font-weight: bold; padding: 10px 14px;
}}
QLabel#ansres {{
    background: {C_CARD_SOFT}; border: 1px solid {C_LINE};
    border-radius: 10px; padding: 11px 13px; font-size: 12px;
}}
QLabel#picked {{
    font-size: 12px; font-weight: bold; color: {C_ACC_DK};
    background: {C_ACC_LT}; border: 1px solid #cfe2ff; border-radius: {R_PILL}px;
    padding: 6px 14px;
}}
QLabel#picked[state="empty"] {{
    color: {C_SUB}; background: {C_CARD_SOFT}; border-color: {C_LINE};
}}

/* ---- 输入控件 ---- */
QLineEdit, QComboBox, QSpinBox {{
    background: #ffffff; color: {C_TXT}; border: 1px solid #cfe0f5;
    border-radius: {R_CTRL}px; padding: 7px 11px; selection-background-color: {C_ACC_LT};
    selection-color: {C_TXT};
}}
QLineEdit:focus, QComboBox:focus, QSpinBox:focus {{ border: 1px solid {C_ACC}; }}
QLineEdit:disabled, QComboBox:disabled, QSpinBox:disabled {{
    background: #f4f7fb; color: #a9b8cc;
}}
QComboBox::drop-down {{ border: none; width: 22px; }}
QComboBox QAbstractItemView {{
    background: #ffffff; color: {C_TXT}; border: 1px solid {C_LINE};
    border-radius: {R_CTRL}px; padding: 3px;
    selection-background-color: {C_ACC_LT}; selection-color: {C_ACC_DK};
    outline: none;
}}
QSpinBox::up-button, QSpinBox::down-button {{ width: 14px; border: none; background: transparent; }}

/* ---- 按钮 ---- */
QPushButton {{
    background: #ffffff; color: #33507a; border: 1px solid #cfe0f5;
    border-radius: {R_CTRL}px; padding: 8px 16px; font-weight: 600;
}}
QPushButton:hover {{ background: #f2f7ff; border-color: {C_ACC}; color: {C_ACC}; }}
QPushButton:pressed {{ background: #e2edff; }}
QPushButton:disabled {{ color: #a9b8cc; background: #f5f8fc; border-color: {C_LINE_SOFT}; }}
QPushButton#primary {{
    background: {C_ACC}; color: #ffffff; border: 1px solid {C_ACC};
}}
QPushButton#primary:hover {{ background: #4a90f5; border-color: #4a90f5; color: #ffffff; }}
QPushButton#primary:pressed {{ background: {C_ACC_DK}; border-color: {C_ACC_DK}; }}
QPushButton#primary:disabled {{ background: #bcd6f8; border-color: #bcd6f8; color: #ffffff; }}
QPushButton#danger {{ color: {C_ERR}; border-color: #f6cdd0; }}
QPushButton#danger:hover {{ background: #fff3f4; border-color: {C_ERR}; color: {C_ERR}; }}
QPushButton#mini {{ padding: 4px 12px; font-size: 12px; border-radius: {R_PILL}px; }}
QPushButton#minidanger {{ padding: 4px 12px; font-size: 12px; color: {C_ERR}; border-color: #f6cdd0; border-radius: {R_PILL}px; }}
QPushButton#minidanger:hover {{ background: #fff3f4; border-color: {C_ERR}; color: {C_ERR}; }}

QCheckBox {{ color: #45608a; font-size: 12px; background: transparent; }}
QCheckBox::indicator {{
    width: 15px; height: 15px; border: 1px solid #cfe0f5; border-radius: 5px; background: #ffffff;
}}
QCheckBox::indicator:checked {{ background: {C_ACC}; border-color: {C_ACC}; }}

/* ---- 表格 / 日志: 外层圆角容器 + 内部透明 ----
   Qt 的 border-radius 不会裁剪 QAbstractScrollArea 的 viewport,
   直接给 QTableWidget/QTextEdit 设圆角, 四角仍会被内容色块填成直角。
   所以统一套一层 QFrame#tableWrap / #logWrap 来出圆角。 */
QFrame#tableWrap, QFrame#logWrap {{
    background: {C_CARD}; border: 1px solid {C_LINE};
    border-radius: {R_BLOCK}px;
}}
QFrame#logWrap {{ background: #f8fbff; }}
QFrame#tableWrap QTableWidget, QFrame#logWrap QTextEdit {{
    background: transparent; border: none; border-radius: 0;
    alternate-background-color: {C_CARD_SOFT};
    selection-background-color: {C_ACC_LT}; selection-color: {C_ACC_DK};
}}
QFrame#tableWrap QTableWidget::item {{ padding: 7px 8px; border: none; }}
QFrame#tableWrap QTableWidget::item:selected {{ background: {C_ACC_LT}; color: {C_ACC_DK}; }}
QFrame#tableWrap QTableWidget::item:focus {{ outline: none; }}
QFrame#tableWrap QHeaderView::section {{
    background: #f4f8fd; color: #6b809c; border: none;
    border-bottom: 1px solid {C_LINE}; padding: 8px; font-size: 12px; font-weight: 600;
}}
/* 表头首尾列也要圆角, 否则浅灰表头会把容器上边两角顶成直角 */
QFrame#tableWrap QHeaderView::section:first {{ border-top-left-radius: {R_INNER}px; }}
QFrame#tableWrap QHeaderView::section:last {{ border-top-right-radius: {R_INNER}px; }}
QFrame#tableWrap QHeaderView::section:only-one {{
    border-top-left-radius: {R_INNER}px; border-top-right-radius: {R_INNER}px;
}}
QFrame#tableWrap QTableCornerButton::section {{
    background: #f4f8fd; border: none; border-top-left-radius: {R_INNER}px;
}}
QFrame#logWrap QTextEdit {{ color: #33507a; padding: 9px; }}

/* ---- 诊断结果条 ---- */
QFrame#diag {{ background: {C_CARD_SOFT}; border: 1px solid {C_LINE}; border-radius: {R_BLOCK}px; }}
QFrame#diag[state="ok"] {{ background: #eefaf3; border-color: #bfe6d0; }}
QFrame#diag[state="warn"] {{ background: #fff9ec; border-color: #f5e0b4; }}
QFrame#diag[state="error"] {{ background: #fff3f4; border-color: #f7ccd0; }}
QFrame#diag[state="run"] {{ background: {C_ACC_LT}; border-color: #cfe2ff; }}

/* ---- 滚动条 ---- */
QScrollBar:vertical {{ background: transparent; width: 9px; margin: 2px; }}
QScrollBar::handle:vertical {{ background: #cadbf0; border-radius: {R_HANDLE}px; min-height: 30px; }}
QScrollBar::handle:vertical:hover {{ background: #a9c8ea; }}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
QScrollBar:horizontal {{ background: transparent; height: 9px; margin: 2px; }}
QScrollBar::handle:horizontal {{ background: #cadbf0; border-radius: {R_HANDLE}px; min-width: 30px; }}
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {{ width: 0; }}

/* ---- 顶部声明条(极窄, 贴在窗口最上方) ---- */
QFrame#notice {{
    background: #fff8e8; border: 1px solid #f0e2bd; border-radius: {R_PILL}px;
}}
QLabel#noticeicon {{
    background: {C_WARN}; color: #ffffff; font-weight: bold; font-size: 10px;
    border-radius: {R_TINY}px;
}}
QLabel#notetext {{ font-size: 11px; color: #8a6d2f; }}
QPushButton#noticebtn {{ padding: 1px 10px; font-size: 11px; border-radius: {R_TINY}px; }}
QPushButton#mini:hover {{ background: #fff2d8; }}

/* ---- 滚动容器(小屏幕时兜底) ---- */
QScrollArea#shellScroll {{ background: {C_BG}; border: none; }}
QScrollArea#shellScroll > QWidget > QWidget {{ background: {C_BG}; }}

QToolTip {{
    background: #ffffff; color: {C_TXT}; border: 1px solid {C_LINE};
    padding: 5px 8px; border-radius: {R_BADGE}px;
}}
"""

LOG_CSS = (
    ".lg{color:#33507a;}"
    ".lg-hi{color:#2b7cf0;font-weight:bold;}"
    ".lg-ok{color:#12925a;font-weight:bold;}"
    ".lg-err{color:#d9464b;font-weight:bold;}"
    ".lg-warn{color:#c98414;font-weight:bold;}"
    "div{margin:1px 0;}"
)


def resource_path(name):
    """兼容 PyInstaller onefile 的资源定位。

    查找顺序: 打包内解包目录(_MEIPASS) -> exe 同目录 -> 源码同目录。
    注意 onefile 下 __file__ 也指向 _MEIPASS, 所以必须靠 sys.executable
    才能找到 "exe 旁边" 这个位置(方便用户直接替换图标, 不用重打包)。
    """
    dirs = []
    base = getattr(sys, "_MEIPASS", None)
    if base:
        dirs.append(base)
    exe = getattr(sys, "executable", None)
    if exe:
        dirs.append(os.path.dirname(os.path.abspath(exe)))
    dirs.append(os.path.dirname(os.path.abspath(__file__)))
    for d in dirs:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
    return os.path.join(dirs[-1], name)


def app_icon():
    for n in ("app.ico", "app.png"):
        p = resource_path(n)
        if os.path.exists(p):
            return QIcon(p)
    return QIcon()


def make_card(title_widget=None, spacing=10, margins=(15, 12, 15, 14)):
    """返回 (卡片 QFrame, 纵向布局)。圆角 + 柔和蓝色投影。"""
    f = QFrame()
    f.setObjectName("card")
    lay = QVBoxLayout(f)
    lay.setContentsMargins(*margins)
    lay.setSpacing(spacing)
    if title_widget is not None:
        lay.addWidget(title_widget)
    return f, lay


def add_shadow(w, blur=20, dy=3, alpha=26):
    """给控件加柔和蓝色投影，让卡片圆角更立体。"""
    from PySide6.QtWidgets import QGraphicsDropShadowEffect
    eff = QGraphicsDropShadowEffect(w)
    eff.setBlurRadius(blur)
    eff.setOffset(0, dy)
    eff.setColor(QColor(43, 124, 240, alpha))
    w.setGraphicsEffect(eff)


def round_wrap(inner, obj="tableWrap"):
    """把滚动类控件(表格 / 文本区)装进一个圆角容器。

    Qt 的 border-radius 不会裁剪 QAbstractScrollArea 的 viewport，
    直接给 QTableWidget / QTextEdit 设圆角，四角仍会被表头/内容的色块
    填成直角("上直下圆")。所以统一靠外层 QFrame 出圆角，内部控件背景透明。
    """
    box = QFrame()
    box.setObjectName(obj)
    lay = QVBoxLayout(box)
    lay.setContentsMargins(1, 1, 1, 1)
    lay.setSpacing(0)
    lay.addWidget(inner)
    return box


class ElideLabel(QLabel):
    """会自动省略号的标签。

    坑: QLabel 的 minimumSizeHint 等于整段文字的宽度, 所以同一行里的长文本
    会把布局撑爆 —— 右边的按钮被挤出可视区(出现水平滚动/箭头)。
    这里允许被压缩到 0 宽度, 空间不足时在末尾画「…」, 完整内容放进 tooltip。
    """

    def __init__(self, text="", parent=None, pad=0):
        super().__init__(text, parent)
        self._full = text or ""
        self._pad = pad            # QSS 左右 padding 总宽, 要减掉才准
        self.setMinimumWidth(0)
        self.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)

    def setElideText(self, text, tooltip=None):
        self._full = text or ""
        self.setToolTip(self._full if (tooltip is None and self._full) else (tooltip or ""))
        self._apply()

    # 对外仍返回完整文本, 便于断言/调试
    def fullText(self):
        return self._full

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self._apply()

    def _apply(self):
        avail = max(0, self.width() - self._pad)
        shown = (self.fontMetrics().elidedText(self._full, Qt.ElideRight, avail)
                 if avail > 0 else self._full)
        if shown != super().text():
            super().setText(shown)


class SectionTitle(QWidget):
    """分区标题: [01] 标题 ......... 右侧提示"""
    def __init__(self, num, text, tip=""):
        super().__init__()
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(8)
        n = QLabel(num)
        n.setObjectName("secnum")
        t = QLabel(text)
        t.setObjectName("sectitle")
        lay.addWidget(n)
        lay.addWidget(t)
        lay.addStretch(1)
        if tip:
            tip_lbl = QLabel(tip)
            tip_lbl.setObjectName("sectip")
            lay.addWidget(tip_lbl)


# ============================================================
# 使用声明(每次启动强制弹出)
# ============================================================
DISCLAIMER_HTML = """
<div style="font-family:'Microsoft YaHei'; font-size:13px; color:#1b2a41; line-height:1.75">
  <p style="font-size:15px; font-weight:bold; color:#d9464b; margin-bottom:10px;">
    使用声明与免责条款
  </p>

  <p><b>1. 用途限定</b><br>
  本软件仅供个人学习、技术研究与本地功能验证使用。<br>
  严禁用于任何商业用途，严禁以任何形式<b>售卖、转售、出租、分发、二次打包发布</b>，
  或用于任何直接、间接的盈利活动。</p>

  <p><b>2. 合规使用</b><br>
  请遵守得物 App 的用户协议及相关法律法规，请勿高频请求影响平台正常服务。<br>
  因违反平台规则导致的账号受限、封禁等后果，由使用者自行承担。</p>

  <p><b>3. 数据与风险</b><br>
  账号凭证仅保存在本机 <code>accounts.json</code>，不会上传至任何第三方服务器。<br>
  使用本软件产生的任何直接或间接损失，作者不承担任何责任。</p>

  <p><b>4. 接受条款</b><br>
  点击「我已阅读并同意」后方可使用本软件；若不同意，请关闭本软件并删除。</p>

  <p style="color:#c98414; font-weight:bold; margin-top:10px;">
    ※ 如果你是付费购买获得本软件的，说明你已被骗，请立即申请退款并向平台举报。
  </p>
</div>
"""


def show_disclaimer(parent=None):
    """每次启动强制弹出的使用声明。

    返回 True 表示用户点了「我已阅读并同意」；返回 False(点「不同意」或直接关窗)
    表示未同意，调用方应当直接退出程序。
    """
    box = QMessageBox(parent)
    box.setWindowTitle("使用声明与免责条款")
    box.setTextFormat(Qt.RichText)
    box.setText(DISCLAIMER_HTML)
    box.setIcon(QMessageBox.NoIcon)
    btn_ok = box.addButton("我已阅读并同意", QMessageBox.AcceptRole)
    btn_no = box.addButton("不同意并退出", QMessageBox.RejectRole)
    box.setDefaultButton(btn_ok)
    box.setEscapeButton(btn_no)
    box.raise_()
    box.activateWindow()
    box.exec()
    return box.clickedButton() is btn_ok


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("得物整点抢兑助手")
        self.setMinimumSize(1010, 520)
        self._restore_geometry()

        self.selected_prize = None
        self._cur_acc_id = None
        self._prizes_cache = {}
        self._acct_sig = None
        self._task_sig = None
        self._last_log_len = 0
        self._diag_seq = -1
        self._closing_confirmed = False
        self._acct_collapsed = False
        self._answer_state = None      # None=未知 / "done"=今日已答 / "todo"=待答
        self._answer_day = ""          # 记录状态对应的日期, 跨天自动失效
        self._answer_probe_day = ""    # 上次探状态时的本地日期
        self._answer_bridges = []      # 持有探状态用的信号桥, 防止被 GC
        self._last_answer = ""         # 最近一次输入的答案(仅本次运行内记忆)

        self._build_ui()
        self._set_acct_collapsed(bool(M.cfg.get("acct_collapsed", False)), persist=False)
        self._refresh_push_btn()
        self._refresh_answer_btn()
        self._refresh_watch_btn()
        self._refresh_fb_btn()
        QTimer.singleShot(1500, self._probe_answer_status)

        self.timer = QTimer(self)
        self.timer.timeout.connect(self._poll)
        self.timer.start(500)
        self._poll()

    # ============ 账号区 收起 / 展开 ============
    def toggle_acct_section(self):
        self._set_acct_collapsed(not self._acct_collapsed)

    def _set_acct_collapsed(self, collapsed, persist=True):
        """收起账号区, 把纵向空间让给商品列表; 状态记忆到 config.json。"""
        collapsed = bool(collapsed)
        changed = collapsed != self._acct_collapsed
        self._acct_collapsed = collapsed
        self.acct_body.setVisible(not collapsed)
        self.lbl_acct_folded.setVisible(collapsed)
        self.btn_acct_fold.setText("展开" if collapsed else "收起")
        self.btn_acct_fold.setToolTip(
            "展开账号区" if collapsed else "收起账号区，把空间让给商品列表"
        )
        if persist and changed:
            M.cfg["acct_collapsed"] = collapsed
            save_json(CONFIG_PATH, M.cfg)

    # ============ 窗口尺寸: 自适应屏幕 + 居中 + 记忆 ============
    def _avail(self):
        """当前(或主)屏幕的可用区域, 已扣除任务栏。"""
        scr = self.screen() or QApplication.primaryScreen()
        return scr.availableGeometry() if scr else QRect(0, 0, 1280, 720)

    @staticmethod
    def _fit_size(avail):
        """按屏幕算一个合适的默认尺寸: 不超出屏幕, 也不小于可用下限。"""
        w = int(avail.width() * 0.92)
        h = int(avail.height() * 0.92)
        w = max(1000, min(1400, w))
        h = max(600, min(940, h))
        # 最后再夹一次, 保证一定放得下(留出 16px 边距)
        w = min(w, max(820, avail.width() - 16))
        h = min(h, max(480, avail.height() - 16))
        return w, h

    def _center_on(self, avail, w, h):
        x = avail.x() + max(0, (avail.width() - w) // 2)
        y = avail.y() + max(0, (avail.height() - h) // 2)
        self.setGeometry(x, y, w, h)

    def _restore_geometry(self):
        """优先恢复上次的位置/尺寸; 尺寸超出当前屏幕或位置已离屏则回退到居中默认值。"""
        avail = self._avail()
        w, h = self._fit_size(avail)
        g = M.cfg.get("win") or {}
        sw, sh = int(g.get("w") or 0), int(g.get("h") or 0)
        if 400 <= sw <= avail.width() and 300 <= sh <= avail.height():
            w, h = sw, sh
            sx, sy = int(g.get("x") or -1), int(g.get("y") or -1)
            if sx > -32000 and sy > -32000:
                rect = QRect(sx, sy, w, h)
                # 必须和某块屏幕有实质重叠, 否则说明显示器被拔了
                for s in QApplication.screens():
                    a = s.availableGeometry()
                    if a.intersects(rect) and (a & rect).width() > 200:
                        self.setGeometry(sx, sy, w, h)
                        if M.cfg.get("win_max"):
                            self.setWindowState(Qt.WindowMaximized)
                        return
        self._center_on(avail, w, h)
        if M.cfg.get("win_max"):
            self.setWindowState(Qt.WindowMaximized)

    def fit_window(self):
        """把窗口拉回居中的合适尺寸(换显示器/分辨率后用)。"""
        self.showNormal()
        avail = self._avail()
        w, h = self._fit_size(avail)
        self._center_on(avail, w, h)

    def closeEvent(self, e):
        # 有未完成任务时拦一下: 关掉程序 = 到点不会自动兑换
        try:
            pending = [t for t in M.tasks if t.get("status") in ("等待", "兑换中")]
        except Exception:
            pending = []
        if pending and not self._closing_confirmed:
            box = QMessageBox(self)
            box.setWindowTitle("确认退出")
            box.setIcon(QMessageBox.Warning)
            box.setTextFormat(Qt.RichText)
            box.setText(
                "还有 <b>%d</b> 个任务未执行（等待中 / 兑换中）。<br><br>"
                "关闭程序会<b>立即终止</b>它们，到点不会自动兑换。<br>"
                "想让任务继续，就点「继续运行」，把窗口最小化即可。"
                % len(pending)
            )
            btn_stay = box.addButton("继续运行", QMessageBox.AcceptRole)
            btn_quit = box.addButton("仍要退出", QMessageBox.DestructiveRole)
            box.setDefaultButton(btn_stay)
            box.exec()
            if box.clickedButton() is not btn_quit:
                e.ignore()
                return
            self._closing_confirmed = True

        try:
            if not self.isMaximized() and not self.isFullScreen():
                g = self.geometry()
                M.cfg["win"] = {"x": g.x(), "y": g.y(), "w": g.width(), "h": g.height()}
            M.cfg["win_max"] = bool(self.isMaximized())
            save_json(CONFIG_PATH, M.cfg)
        except Exception:
            pass
        super().closeEvent(e)

    # ================= UI 构建 =================
    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        shell = QVBoxLayout(central)
        shell.setContentsMargins(0, 0, 0, 0)
        shell.setSpacing(0)

        # 声明条固定在最顶部(极窄的一条), 不随内容滚动, 也不会挡住下面的卡片
        notice_wrap = QWidget()
        nw = QVBoxLayout(notice_wrap)
        nw.setContentsMargins(18, 8, 18, 0)
        nw.setSpacing(0)
        nw.addWidget(self._build_notice())
        shell.addWidget(notice_wrap)

        # 小屏幕靠滚动条兜底, 而不是把窗口撑到超出屏幕
        self.scroll = QScrollArea()
        self.scroll.setObjectName("shellScroll")
        self.scroll.setWidgetResizable(True)
        self.scroll.setFrameShape(QFrame.NoFrame)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        inner = QWidget()
        inner.setObjectName("innerBody")
        self.scroll.setWidget(inner)
        shell.addWidget(self.scroll, 1)

        root = QVBoxLayout(inner)
        root.setContentsMargins(18, 10, 18, 14)
        root.setSpacing(12)

        root.addWidget(self._build_header())

        body = QHBoxLayout()
        body.setSpacing(12)
        body.addLayout(self._build_left(), 58)
        body.addLayout(self._build_right(), 42)
        root.addLayout(body, 1)

    # ---------- 顶部声明条 ----------
    def _build_notice(self):
        """极窄的常驻声明条, 贴在窗口最上方。"""
        f = QFrame()
        f.setObjectName("notice")
        lay = QHBoxLayout(f)
        lay.setContentsMargins(18, 3, 12, 3)
        lay.setSpacing(8)

        icon = QLabel("!")
        icon.setObjectName("noticeicon")
        icon.setFixedSize(14, 14)
        icon.setAlignment(Qt.AlignCenter)

        note = QLabel(
            "本软件仅供个人学习与技术研究，"
            "<b>严禁售卖、转售或用于商业盈利</b>，请勿传播。"
        )
        note.setObjectName("notetext")
        note.setTextFormat(Qt.RichText)

        btn = QPushButton("完整声明")
        btn.setObjectName("noticebtn")
        btn.clicked.connect(self._show_disclaimer)

        lay.addWidget(icon)
        lay.addWidget(note, 1)
        lay.addWidget(btn)
        return f

    def _show_disclaimer(self):
        """顶部「完整声明」按钮: 只读查看, 点任意按钮关闭即可。"""
        show_disclaimer(self)
        return True

    # ---------- 每日答题 ----------
    def _refresh_answer_btn(self):
        """顶部按钮直接显示今日答题状态，不用点进去才知道答没答。"""
        st = self._answer_state
        if st == "done":
            self.btn_answer.setText("每日答题 · 已答")
            self.btn_answer.setToolTip("今日已答对，明天再来（点开可回看今天的题目）")
        elif st == "todo":
            self.btn_answer.setText("每日答题 · 待答")
            self.btn_answer.setToolTip("今天还没答！点开看题目、填答案，一键答完所有账号")
        else:
            self.btn_answer.setText("每日答题")
            self.btn_answer.setToolTip("看题图填答案，所有账号一次性答完（每日可加金币）")

    def _probe_answer_status(self):
        """开机后探一次今日答题状态。只查第一个账号，失败就静默保持原状。

        坑：结果不能直接改控件、也不能在子线程里 QTimer.singleShot ——
        那个线程没有 Qt 事件循环，回调永远不会被触发，按钮就一直停在初始文案。
        必须用信号回主线程（这里的 bridge 建在主线程，emit 会走队列）。
        """
        self._answer_probe_day = datetime.date.today().isoformat()
        with M.lock:
            acc = dict(M.accounts[0]) if M.accounts else None
        if not acc:
            return

        bridge = _AnswerBridge()
        bridge.status.connect(self._on_answer_probe)
        self._answer_bridges.append(bridge)   # 持有引用, 防止被回收

        def work():
            info, err = ANS.today_info(acc)
            if err or not info:
                return
            bridge.status.emit("done" if info.get("answered") else "todo",
                               info.get("date") or "")

        threading.Thread(target=work, daemon=True).start()

    def _on_answer_probe(self, state, day):
        self._answer_state = state
        self._answer_day = day
        self._refresh_answer_btn()
        self._answer_bridges = self._answer_bridges[-2:]

    def daily_answer(self):
        """每日答题：显示今日题图 → 你填答案 → 所有账号依次作答。"""
        with M.lock:
            accs = [dict(a) for a in M.accounts]
        if not accs:
            QMessageBox.information(
                self, "每日答题",
                "还没有账号。\n先在「01 账号管理」里添加账号，再回来答题。")
            return

        dlg = QDialog(self)
        dlg.setWindowTitle("每日答题 · 一键答题")
        dlg.setMinimumWidth(566)
        v = QVBoxLayout(dlg)
        v.setContentsMargins(20, 18, 20, 14)
        v.setSpacing(10)

        head = QLabel("看今日题目图 → 填答案 → 所有账号依次作答")
        hf = QFont()
        hf.setPointSize(11)
        hf.setBold(True)
        head.setFont(hf)
        v.addWidget(head)

        # ---- 信息条 ----
        chip_day = QLabel("日期 —")
        chip_day.setObjectName("chip")
        chip_hint = QLabel("提示 —")
        chip_hint.setObjectName("chipAccent")
        chip_stat = QLabel("状态 —")
        chip_stat.setObjectName("chip")
        chip_n = QLabel("%d 个账号" % len(accs))
        chip_n.setObjectName("chip")
        irow = QHBoxLayout()
        irow.setSpacing(8)
        for w in (chip_day, chip_hint, chip_stat):
            irow.addWidget(w)
        irow.addStretch(1)
        irow.addWidget(chip_n)
        v.addLayout(irow)

        # ---- 题图 ----
        img = QLabel("正在加载今日题目…")
        img.setObjectName("ansimg")
        img.setAlignment(Qt.AlignCenter)
        img.setMinimumHeight(292)
        img.setWordWrap(True)
        v.addWidget(img)

        # ---- 答案输入 ----
        arow = QHBoxLayout()
        arow.setSpacing(9)
        lb_ans = QLabel("今日答案")
        lb_ans.setObjectName("fieldlbl")
        ed_ans = QLineEdit(self._last_answer)
        ed_ans.setObjectName("ansbig")
        ed_ans.setAlignment(Qt.AlignCenter)
        ed_ans.setPlaceholderText("看上面的图，把答案填在这里")
        ed_ans.setMaxLength(20)
        btn_clear = QPushButton("清空")
        btn_clear.setObjectName("mini")
        btn_clear.clicked.connect(lambda: ed_ans.clear())
        arow.addWidget(lb_ans)
        arow.addWidget(ed_ans, 1)
        arow.addWidget(btn_clear)
        v.addLayout(arow)

        # ---- 操作行 ----
        brow = QHBoxLayout()
        brow.setSpacing(9)
        btn_reload = QPushButton("刷新题目")
        btn_reload.setObjectName("mini")
        btn_reload.setToolTip("重新拉一次今日题目（图片没出来时点这个）")
        btn_go = QPushButton("一键答题")
        btn_go.setObjectName("primary")
        btn_go.setToolTip("用上面这个答案，依次给所有账号答题")
        brow.addWidget(btn_reload)
        brow.addStretch(1)
        brow.addWidget(btn_go)
        v.addLayout(brow)

        # ---- 结果表 ----
        tbl = QTableWidget(0, 3)
        tbl.setHorizontalHeaderLabels(["账号", "结果", "余额"])
        tbl.horizontalHeader().setSectionResizeMode(0, QHeaderView.Fixed)
        tbl.setColumnWidth(0, 118)
        tbl.horizontalHeader().setSectionResizeMode(1, QHeaderView.Stretch)
        tbl.horizontalHeader().setSectionResizeMode(2, QHeaderView.Fixed)
        tbl.setColumnWidth(2, 92)
        tbl.setSelectionBehavior(QAbstractItemView.SelectRows)
        tbl.setEditTriggers(QAbstractItemView.NoEditTriggers)
        tbl.verticalHeader().setVisible(False)
        tbl.setShowGrid(False)
        tbl.setWordWrap(False)
        tbl.setTextElideMode(Qt.ElideRight)
        tbl.setFixedHeight(118)
        v.addWidget(round_wrap(tbl))

        lbl = QLabel("")
        lbl.setObjectName("ansres")
        lbl.setWordWrap(True)
        lbl.setText("题号每天自动取，你只要看图填答案就行。")
        v.addWidget(lbl)

        bb = QDialogButtonBox(QDialogButtonBox.Close)
        bb.button(QDialogButtonBox.Close).setText("关闭")
        bb.rejected.connect(dlg.reject)
        v.addWidget(bb)

        st = {"wc": None, "rows": {}, "kinds": {}, "running": False}
        stop_ev = threading.Event()
        dlg.finished.connect(lambda _r: stop_ev.set())
        bridge = _AnswerBridge()

        def set_lbl(text, color=None):
            lbl.setStyleSheet("" if color is None else "color:%s;" % color)
            lbl.setText(text)

        def fit_table():
            """按行数自适应高度：全部放得下就不出现滚动条（避免第一行被裁一半）。"""
            n = tbl.rowCount()
            rows = min(n, 4)
            h = (tbl.horizontalHeader().height() or 34) if rows else 34
            for r in range(rows):
                h += tbl.rowHeight(r)
            tbl.setFixedHeight(max(112, h + 6))

        def row_of(name, text, bal, kind):
            st["kinds"][name] = kind
            r = st["rows"].get(name)
            if r is None:
                r = st["rows"][name] = tbl.rowCount()
                tbl.insertRow(r)
                it = QTableWidgetItem(name)
                it.setToolTip(name)
                tbl.setItem(r, 0, it)
                tbl.setItem(r, 1, QTableWidgetItem(""))
                b = QTableWidgetItem("")
                b.setTextAlignment(Qt.AlignCenter)
                tbl.setItem(r, 2, b)
            it1 = tbl.item(r, 1)
            it1.setText(text)
            it1.setToolTip(text)
            it1.setForeground(QColor({"ok": C_OK, "wrong": C_ERR,
                                      "err": C_ERR, "done": C_SUB}.get(kind, C_TXT)))
            f = it1.font()
            f.setBold(kind == "ok")
            it1.setFont(f)
            it2 = tbl.item(r, 2)
            it2.setText(bal)
            it2.setForeground(QColor(C_ACC_DK if kind in ("ok", "done") else C_SUB))
            fit_table()
            tbl.scrollToBottom()

        # ---- 取题目 ----
        def load_question():
            infos = []
            first = None
            for a in accs:
                info, err = ANS.today_info(a)
                if err or not info:
                    infos.append((a, info, err or "取题失败"))
                    continue
                if first is None:
                    first = info
                infos.append((a, info, None))
            if first is None:
                bridge.qinfo.emit({}, (infos[0][2] if infos else "取题失败"))
                return
            first["_answered"] = sum(1 for _a, i, _e in infos if i and i.get("answered"))
            first["_total"] = len(infos)
            first["_statuses"] = [(a.get("name") or a.get("id"),
                                   (i or {}).get("answered"), (i or {}).get("balance"))
                                  for a, i, _e in infos]
            bridge.qinfo.emit(first, "")
            b = ANS.fetch_image(first.get("image_url"))
            if b:
                bridge.image.emit(b)

        def on_qinfo(info, err):
            if err:
                chip_stat.setText("状态 取题失败")
                set_lbl("取今日题目失败：%s" % err, C_ERR)
                img.setText("题目没加载出来\n%s" % err)
                return
            st["wc"] = info.get("word_count")
            chip_day.setText("日期 %s" % (info.get("date") or "—"))
            chip_hint.setText("提示 %s" % (ANS.hint_text(info) or "—"))
            done, total = info.get("_answered") or 0, info.get("_total") or 0
            chip_stat.setText("已答 %d/%d" % (done, total))
            if done >= total:
                chip_stat.setStyleSheet(
                    "background:#e6f7ee;color:%s;border:1px solid #cbe9d9;"
                    "border-radius:14px;padding:4px 13px;font-size:12px;font-weight:bold;" % C_OK)
                set_lbl("今天所有账号都已经答过了 —— 明天题目会换，再来一次就行。", C_OK)
            elif done:
                set_lbl("今天已有 %d/%d 个账号答过，点「一键答题」会给剩下的账号答（已答的自动跳过）。"
                        % (done, total), C_SUB)
            else:
                set_lbl("题目已取到，看图填答案，然后点「一键答题」。", C_SUB)
            # 先把已有余额填进表格
            for nm, answered, bal in (info.get("_statuses") or []):
                if answered:
                    row_of(nm, "今日已答对", "—" if bal is None else str(bal), "done")

        def on_image(b):
            pm = QPixmap()
            if not pm.loadFromData(b):
                img.setText("图片解码失败（不影响答题，你在手机上看着填也行）")
                return
            img.setPixmap(pm.scaled(430, 286, Qt.KeepAspectRatio, Qt.SmoothTransformation))

        def on_one(name, res):
            kind = res.get("kind", "err")
            bb_ = res.get("balance_before")
            b_ = res.get("balance")
            if bb_ is not None and b_ is not None and bb_ != b_:
                bal = "%s → %s" % (bb_, b_)
            else:
                bal = "—" if b_ is None else str(b_)
            row_of(name, res.get("text", ""), bal, kind)
            if kind == "ok":
                # 让账号表格上的余额立刻跟着变
                aid = res.get("acc_id")
                if aid is not None and b_ is not None:
                    M.acct_state.setdefault(aid, {})["balance"] = b_
            chip_stat.setText("已答 %d/%d" % (
                sum(1 for k in st["kinds"].values() if k in ("ok", "done")), len(accs)))

        def on_done(results):
            st["running"] = False
            btn_go.setEnabled(True)
            btn_reload.setEnabled(True)
            btn_go.setText("一键答题")
            n_ok = sum(1 for r in results if r.get("kind") == "ok")
            n_done = sum(1 for r in results if r.get("kind") == "done")
            n_bad = len(results) - n_ok - n_done
            if n_ok:
                txt = "✓ 完成：%d 个答对" % n_ok
                if n_done:
                    txt += "、%d 个今天已答过" % n_done
                if n_bad:
                    txt += "、%d 个失败" % n_bad
                set_lbl(txt + "。金币到账看「余额」列。", C_OK if not n_bad else C_WARN)
            elif n_bad:
                set_lbl("完成：%d 个失败，原因见上表。" % n_bad, C_ERR)
            else:
                set_lbl("所有账号今天都已经答过了，明天再来。", C_SUB)
            answered = any(r.get("kind") in ("ok", "done") for r in results)
            self._answer_state = "done" if answered else "todo"
            self._refresh_answer_btn()
            self._acct_sig = None          # 让账号表格下一轮重画, 余额立刻更新

        bridge.qinfo.connect(on_qinfo)
        bridge.image.connect(on_image)
        bridge.one.connect(on_one)
        bridge.done.connect(on_done)
        bridge.log.connect(lambda s: set_lbl(s, C_SUB))

        def do_run(ans):
            try:
                results = ANS.answer_all(
                    accs, ans,
                    on_result=lambda a, r: bridge.one.emit(a.get("name") or a.get("id"), r),
                    on_log=lambda s: (M.log(s), bridge.log.emit(s)),
                    stop=stop_ev.is_set)
            except Exception as e:
                results = [{"acc_id": None, "name": "—", "kind": "err",
                            "text": "内部错误：%r" % (e,)}]
            bridge.done.emit(results)

        def start():
            if st["running"]:
                return
            ans = ed_ans.text().strip()
            if not ans:
                set_lbl("请先在「今日答案」里填上答案。", C_ERR)
                ed_ans.setFocus()
                return
            wc = st["wc"]
            if wc and len(ans) != int(wc):
                r = QMessageBox.question(
                    dlg, "确认答案",
                    "提示说答案是 %s 个字，你填的是 %d 个字。\n仍要按「%s」提交吗？"
                    % (wc, len(ans), ans),
                    QMessageBox.Yes | QMessageBox.No, QMessageBox.No)
                if r != QMessageBox.Yes:
                    return
            self._last_answer = ans
            st["running"] = True
            tbl.setRowCount(0)
            st["rows"].clear()
            st["kinds"].clear()
            fit_table()
            btn_go.setEnabled(False)
            btn_reload.setEnabled(False)
            btn_go.setText("答题中…")
            set_lbl("正在依次答题，共 %d 个账号…" % len(accs), C_SUB)
            M.log("[答题] 一键答题开始：答案「%s」，%d 个账号" % (ans, len(accs)))
            threading.Thread(target=do_run, args=(ans,), daemon=True).start()

        def reload_q():
            tbl.setRowCount(0)
            st["rows"].clear()
            st["kinds"].clear()
            fit_table()
            img.setText("正在加载今日题目…")
            set_lbl("正在取今日题目…", C_SUB)
            threading.Thread(target=load_question, daemon=True).start()

        btn_go.clicked.connect(start)
        btn_reload.clicked.connect(reload_q)
        ed_ans.returnPressed.connect(start)

        threading.Thread(target=load_question, daemon=True).start()
        dlg.exec()

    # ---------- 微信推送设置 (PushPlus) ----------
    def _refresh_push_btn(self):
        """顶部按钮直接显示推送状态，不用点进去才知道开没开。"""
        try:
            st = PUSH.status_text()
            gsum = PUSH.group_summary()
        except Exception:
            st, gsum = "未设置", ""
        self.btn_push.setText("推送设置 · %s" % st)
        base = {
            "已开启": "抢兑成功会自动推送到微信 · 点这里修改或发测试",
            "已关闭": "已填 token 但开关关着 · 点这里打开",
        }.get(st, "还没配 PushPlus token · 点这里填写，抢兑成功即可推送到微信")
        self.btn_push.setToolTip(base + ("\n" + gsum if gsum else ""))

    def push_settings(self):
        """弹窗：填 PushPlus token / 开关 / 发测试消息。"""
        import webbrowser
        cfg = PUSH.load()

        dlg = QDialog(self)
        dlg.setWindowTitle("微信推送设置 · PushPlus")
        dlg.setMinimumWidth(486)
        v = QVBoxLayout(dlg)
        v.setContentsMargins(20, 18, 20, 14)
        v.setSpacing(10)

        head = QLabel("抢兑成功后，自动推送到微信")
        hf = QFont()
        hf.setPointSize(11)
        hf.setBold(True)
        head.setFont(hf)
        v.addWidget(head)

        tip = QLabel(
            "· 通知内容：账号备注 · 商品名称 · 兑换结果 · 消耗金币 · 剩余金币 · 完成时间\n"
            "· token 只写在本机 config.json，除了 PushPlus 官方接口不会发给任何地方\n"
            "· 还没关注公众号？点「去获取」，微信扫码登录后复制「一对一推送」的 token\n"
            "· 想让别人也收到库存提醒？把「群组管理」里那个群组编码填到下面 —— "
            "群组只用于库存变化，抢兑结果不会发进群")
        tip.setWordWrap(True)
        tip.setObjectName("sectip")
        v.addWidget(tip)

        form = QGridLayout()
        form.setHorizontalSpacing(10)
        form.setVerticalSpacing(8)
        lb_key = QLabel("Token")
        lb_key.setObjectName("fieldlbl")
        ed_key = QLineEdit(cfg["key"])
        ed_key.setPlaceholderText("粘贴 PushPlus token（32 位字符）")
        btn_site = QPushButton("去获取")
        btn_site.setObjectName("mini")
        btn_site.setToolTip("打开 pushplus.plus，微信扫码登录后复制 token")
        btn_site.clicked.connect(lambda: webbrowser.open("https://www.pushplus.plus/"))
        form.addWidget(lb_key, 0, 0)
        form.addWidget(ed_key, 0, 1)
        form.addWidget(btn_site, 0, 2)

        # ---- 群组编码（一对多）----
        lb_grp = QLabel("群组编码")
        lb_grp.setObjectName("fieldlbl")
        ed_grp = QLineEdit(cfg["topic"])
        ed_grp.setPlaceholderText("留空 = 不群发（填你自己的群组编码，如 dewu）")
        ed_grp.setToolTip(
            "pushplus.plus → 个人中心 → 群组管理 里的「群组编码」。\n"
            "填了它，库存变化就会同时群发给群里的所有成员。")
        btn_grp = QPushButton("群组管理")
        btn_grp.setObjectName("mini")
        btn_grp.setToolTip("打开 pushplus.plus，去「群组管理」看群组编码 / 群成员二维码")
        btn_grp.clicked.connect(lambda: webbrowser.open("https://www.pushplus.plus/"))
        form.addWidget(lb_grp, 1, 0)
        form.addWidget(ed_grp, 1, 1)
        form.addWidget(btn_grp, 1, 2)
        form.setColumnStretch(1, 1)
        v.addLayout(form)

        chk_on = QCheckBox("开启抢兑成功推送")
        chk_on.setChecked(bool(cfg["enabled"]))
        chk_on.setToolTip("关掉后一条都不发（token 会保留）")
        chk_fail = QCheckBox("抢兑失败也推送")
        chk_fail.setChecked(bool(cfg["on_fail"]))
        chk_fail.setToolTip("默认只在抢到时推送；勾上后余额不足 / 没抢到也会发一条")
        row = QHBoxLayout()
        row.setSpacing(18)
        row.addWidget(chk_on)
        row.addWidget(chk_fail)
        row.addStretch(1)
        v.addLayout(row)

        chk_gstock = QCheckBox("库存变化也群发到群组")
        chk_gstock.setChecked(bool(cfg["group_stock"]))
        chk_gstock.setToolTip(
            "「库存监听」探到新品上架 / 补货时，除了推给你，也推给群里所有成员。\n"
            "★ 群组只发库存变化；抢兑成功/失败（含账号备注）永远只发给你自己。")
        chk_gself = QCheckBox("群发之外，也私发我一份")
        chk_gself.setChecked(bool(cfg["group_self_too"]))
        chk_gself.setToolTip(
            "勾上：你会收到两条（一条私发、一条群发）—— 保证不漏，"
            "也方便你确认群发到底通没通。\n"
            "取消：只发群里一条（前提是你自己也在那个群）。")
        grow = QHBoxLayout()
        grow.setSpacing(18)
        grow.addWidget(chk_gstock)
        grow.addWidget(chk_gself)
        grow.addStretch(1)
        v.addLayout(grow)

        lbl = QLabel("")
        lbl.setWordWrap(True)
        lbl.setObjectName("sectip")

        def summary():
            lbl.setStyleSheet("")
            tp = PUSH.clean_topic(ed_grp.text())
            if not tp:
                lbl.setText("当前：%s · token %s · 群发关着（群组编码留空）"
                            % (PUSH.status_text(), PUSH.mask_key(cfg["key"])))
                return
            if not chk_gstock.isChecked():
                lbl.setText("当前：群组编码「%s」填了，但没勾「库存变化也群发」，不会群发" % tp)
                return
            lbl.setText("当前：库存变化 → 群发到「%s」%s · 抢兑结果只私发给你"
                        % (tp, " + 私发我一份" if chk_gself.isChecked() else "（不再私发）"))

        for _w in (chk_gstock, chk_gself):
            _w.toggled.connect(lambda _=None: summary())
        ed_grp.textChanged.connect(lambda _=None: summary())
        summary()
        v.addWidget(lbl)

        bb = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        bb.button(QDialogButtonBox.Ok).setText("保存")
        bb.button(QDialogButtonBox.Ok).setObjectName("primary")
        bb.button(QDialogButtonBox.Cancel).setText("取消")
        btn_test = bb.addButton("发送测试", QDialogButtonBox.ActionRole)
        btn_test.setToolTip("用上面这个 token 立刻发一条测试消息，验证能不能收到")
        bb.rejected.connect(dlg.reject)
        v.addWidget(bb)

        bridge = _PushBridge()

        def on_test_done(ok, msg):
            btn_test.setEnabled(True)
            if ok:
                lbl.setStyleSheet("color:%s;" % C_OK)
                lbl.setText("✓ %s，去微信看一眼（一般 1~3 秒到）。" % msg)
            else:
                lbl.setStyleSheet("color:%s;" % C_ERR)
                lbl.setText("发送失败：%s" % msg)

        bridge.done.connect(on_test_done)

        def do_test():
            key = ed_key.text().strip()
            if not key:
                lbl.setStyleSheet("color:%s;" % C_ERR)
                lbl.setText("请先填入 PushPlus token 再测试")
                return
            btn_test.setEnabled(False)
            lbl.setStyleSheet("color:%s;" % C_SUB)
            tp = PUSH.clean_topic(ed_grp.text())
            lbl.setText("正在发送测试消息%s…" % ("（私发 + 群发各一条）" if tp else ""))

            def work():
                ok, msg = PUSH.notify_test(token=key, topic=tp)
                bridge.done.emit(ok, msg)

            threading.Thread(target=work, name="push-test", daemon=True).start()

        btn_test.clicked.connect(do_test)

        def _save_all(key="", enabled=None, **kw):
            return PUSH.save(key=key,
                             enabled=chk_on.isChecked() if enabled is None else enabled,
                             on_fail=chk_fail.isChecked(),
                             topic=ed_grp.text(),
                             group_stock=chk_gstock.isChecked(),
                             group_self_too=chk_gself.isChecked())

        def on_ok():
            key = ed_key.text().strip()
            if not key:
                if QMessageBox.question(
                        self, "关闭推送",
                        "Token 是空的，保存后会清空并关闭微信推送。确定吗？"
                ) != QMessageBox.Yes:
                    return
                _save_all(key="", enabled=False)
                self._refresh_push_btn()
                dlg.accept()
                return
            if len(key) < 16:
                lbl.setStyleSheet("color:%s;" % C_ERR)
                lbl.setText("token 看着不完整：PushPlus 的 token 是 32 位字符，请重新复制一次")
                return
            raw_topic = ed_grp.text().strip()
            tp = PUSH.clean_topic(raw_topic)
            if raw_topic and not tp:
                lbl.setStyleSheet("color:%s;" % C_ERR)
                lbl.setText("群组编码只能用字母 / 数字 / 下划线 / 短横线，请重新填")
                return
            c2 = _save_all(key=key)
            self._refresh_push_btn()
            dlg.accept()
            gline = ("群发到「%s」：%s" % (
                tp, "库存变化（+私发我一份）" if chk_gself.isChecked()
                else "库存变化（不再私发）")) if (tp and chk_gstock.isChecked()) else "群发：关"
            M.log("[推送] 设置已保存 · %s · 成功推送%s · 失败推送%s · %s"
                  % (PUSH.mask_key(key),
                     "开" if c2["enabled"] else "关",
                     "开" if c2["on_fail"] else "关",
                     gline))
            QMessageBox.information(
                self, "已保存",
                "微信推送已%s。\n\n成功推送：%s\n失败推送：%s\n%s\n\n"
                "抢兑成功后会自动发一条带商品名和剩余金币的微信通知。"
                % ("开启" if c2["enabled"] else "关闭",
                   "开" if c2["enabled"] else "关",
                   "开" if c2["on_fail"] else "关",
                   ("\n" + gline + "\n（群组只发库存变化，抢兑结果只发给你自己）")
                   if (tp and chk_gstock.isChecked()) else "\n群发：关"))

        bb.accepted.connect(on_ok)
        dlg.exec()

    # ---------- 库存监听（新品上架 / 补货 → 微信） ----------
    def _refresh_watch_btn(self):
        """顶部按钮直接显示监听状态，不用点进去才知道开没开。"""
        try:
            st = M.watch_status()
        except Exception:
            return
        if st.get("running"):
            text = "库存监听 · 运行中"
            tip = ("正在用「%s」每 %d 秒查一次商品列表 · 已监听 %d 个商品\n"
                   "发现新品上架 / 补货会立刻推微信 · 点这里改设置"
                   % (st.get("account_name") or "-", st.get("interval_sec") or 30,
                      st.get("tracked") or 0))
        elif st.get("enabled"):
            text = "库存监听 · 已开启"
            tip = "监听开关开着，但线程没在跑（重启程序会自动恢复）· 点这里看看"
        else:
            text = "库存监听"
            tip = "盯住商品列表：有新品上架 / 补货就推微信"
        if self.btn_watch.text() != text or self.btn_watch.toolTip() != tip:
            self.btn_watch.setText(text)
            self.btn_watch.setToolTip(tip)

    def stock_watch(self):
        """弹窗：库存监听 —— 开关 / 间隔 / 用哪个号监听 / 提醒类型 / 立即检查一次。"""
        import webbrowser
        st = M.watch_status()
        accounts = [dict(a) for a in M.accounts]

        dlg = QDialog(self)
        dlg.setWindowTitle("库存监听 · 新品上架 / 补货提醒")
        dlg.setMinimumWidth(524)
        v = QVBoxLayout(dlg)
        v.setContentsMargins(20, 18, 20, 14)
        v.setSpacing(10)

        head = QLabel("商品列表有新动静，第一时间推到你微信")
        hf = QFont()
        hf.setPointSize(11)
        hf.setBold(True)
        head.setFont(hf)
        v.addWidget(head)

        tip = QLabel(
            "· 只挑一个账号定时拉商品列表（就是下面「监听账号」那个），不占抢兑任务的额度\n"
            "· 「新品上架」= 列表里冒出新商品且有货；「补货」= 原来缺货/售罄的又有货了\n"
            "· 第一次开启只建立基线、不推送，之后每次发现变化才推，避免一开就推一整页\n"
            "· 商品列表跟着账号所属的活动走，同时开了多个活动就换个对应的号来监听")
        tip.setWordWrap(True)
        tip.setObjectName("sectip")
        v.addWidget(tip)

        # ---- 运行状态 ----
        box = QFrame()
        box.setObjectName("card")
        g = QGridLayout(box)
        g.setContentsMargins(14, 12, 14, 12)
        g.setHorizontalSpacing(10)
        g.setVerticalSpacing(6)

        def kv(row, key):
            lb = QLabel(key)
            lb.setObjectName("fieldlbl")
            val = QLabel("—")
            val.setWordWrap(True)
            g.addWidget(lb, row, 0, Qt.AlignTop)
            g.addWidget(val, row, 1)
            return val

        lb_state = kv(0, "监听状态")
        lb_acc = kv(1, "监听账号")
        lb_track = kv(2, "已监听商品")
        lb_check = kv(3, "上次检查")
        lb_pushn = kv(4, "已提醒商品")
        lb_err = kv(5, "最近错误")
        g.setColumnStretch(1, 1)
        v.addWidget(box)

        def render(s):
            running = bool(s.get("running"))
            lb_state.setText("● 正在监听 · 每 %d 秒一次" % (s.get("interval_sec") or 30)
                             if running else "○ 没在监听")
            lb_state.setStyleSheet("color:%s;" % (C_OK if running else C_SUB))
            lb_acc.setText(s.get("account_name") or "—")
            if s.get("baseline"):
                lb_track.setText("%d 个商品" % (s.get("tracked") or 0))
            else:
                lb_track.setText("还没建立基线（开启后第一次检查会建）")
            lb_check.setText(s.get("checked_at") or "还没检查过")
            lb_pushn.setText("%d 件" % (s.get("notified") or 0))
            err = s.get("last_error")
            lb_err.setText(err or "无")
            lb_err.setStyleSheet("color:%s;" % (C_ERR if err else C_SUB))

        render(st)

        # ---- 参数 ----
        form = QGridLayout()
        form.setHorizontalSpacing(10)
        form.setVerticalSpacing(8)
        lb_i = QLabel("检查间隔")
        lb_i.setObjectName("fieldlbl")
        sp_int = QSpinBox()
        sp_int.setRange(5, 3600)
        sp_int.setValue(int(st.get("interval_sec") or 30))
        sp_int.setSuffix(" 秒")
        sp_int.setFixedWidth(108)
        sp_int.setToolTip("多久查一次商品列表。太密容易触发风控，建议 30~60 秒")
        lb_a = QLabel("监听账号")
        lb_a.setObjectName("fieldlbl")
        cb_acc = QComboBox()
        for a in accounts:
            cb_acc.addItem(a.get("name") or ("账号 %s" % a.get("id")), a.get("id"))
        idx = cb_acc.findData(st.get("account_id"))
        if idx >= 0:
            cb_acc.setCurrentIndex(idx)
        cb_acc.setToolTip("只用一个号监听就够了，它看到的商品列表和别的号一样")
        cb_acc.setMinimumWidth(150)
        cb_acc.setMaximumWidth(220)
        form.addWidget(lb_i, 0, 0)
        form.addWidget(sp_int, 0, 1)
        form.addWidget(lb_a, 0, 2)
        form.addWidget(cb_acc, 0, 3)
        form.setColumnStretch(1, 0)
        form.setColumnStretch(4, 1)
        v.addLayout(form)

        chk_on = QCheckBox("开启库存监听")
        chk_on.setChecked(bool(st.get("enabled")))
        chk_on.setToolTip("关掉后不再定时拉列表；已记录的快照保留，下次开启接着比对")
        chk_new = QCheckBox("新品上架提醒")
        chk_new.setChecked(bool(st.get("notify_new", True)))
        chk_new.setToolTip("列表里冒出新商品且有货时推一条")
        chk_rest = QCheckBox("补货提醒")
        chk_rest.setChecked(bool(st.get("notify_restock", True)))
        chk_rest.setToolTip("原来缺货的商品又有货了，推一条")
        row = QHBoxLayout()
        row.setSpacing(18)
        row.addWidget(chk_on)
        row.addWidget(chk_new)
        row.addWidget(chk_rest)
        row.addStretch(1)
        v.addLayout(row)

        if not PUSH.is_ready():
            warn = QLabel("⚠ 还没配 PushPlus token：监听到变化只会写进本机日志，不会发微信。"
                          "先点顶部「推送设置」把 token 填上。")
            warn.setWordWrap(True)
            warn.setStyleSheet("color:%s;" % C_ERR)
            v.addWidget(warn)

        lbl = QLabel("")
        lbl.setWordWrap(True)
        lbl.setObjectName("sectip")
        v.addWidget(lbl)

        def hint():
            if not accounts:
                lbl.setStyleSheet("color:%s;" % C_SUB)
                lbl.setText("还没有账号 —— 先在「01 账号管理」里导入一个号，才能监听商品列表。")
                return
            lbl.setStyleSheet("color:%s;" % C_SUB)
            lbl.setText("当前用「%s」监听，每 %d 秒查一次；开关：%s"
                        % (cb_acc.currentText() or "—", sp_int.value(),
                           "开" if chk_on.isChecked() else "关"))

        bb = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        bb.button(QDialogButtonBox.Ok).setText("保存并应用")
        bb.button(QDialogButtonBox.Ok).setObjectName("primary")
        bb.button(QDialogButtonBox.Cancel).setText("取消")
        bb.rejected.connect(dlg.reject)
        btn_now = bb.addButton("立即检查一次", QDialogButtonBox.ActionRole)
        btn_now.setToolTip("不等定时器，马上拉一次列表做比对（用来验证配置对不对）")
        btn_pv = bb.addButton("样式预览", QDialogButtonBox.ActionRole)
        btn_pv.setToolTip("在浏览器里打开推送卡片的样式预览（含新品 / 补货两种）")
        v.addWidget(bb)

        bridge = _WatchBridge()

        def on_check_done(ok, msg, s):
            btn_now.setEnabled(True)
            if s:
                render(s)
            lbl.setStyleSheet("color:%s;" % (C_OK if ok else C_ERR))
            lbl.setText(("✓ " if ok else "✗ ") + msg)
            self._refresh_watch_btn()

        bridge.done.connect(on_check_done)

        def do_check():
            if not accounts:
                hint()
                return
            # 先把当前选择落盘，手动检查才会用你刚选的那个号
            M.watch_save_cfg(account_id=cb_acc.currentData(),
                             interval_sec=int(sp_int.value()),
                             notify_new=chk_new.isChecked(),
                             notify_restock=chk_rest.isChecked())
            btn_now.setEnabled(False)
            lbl.setStyleSheet("color:%s;" % C_SUB)
            lbl.setText("正在拉取商品列表并比对…")

            def work():
                ok, msg = M.watch_once()
                bridge.done.emit(ok, msg, M.watch_status())

            threading.Thread(target=work, name="watch-once", daemon=True).start()

        btn_now.clicked.connect(do_check)

        def do_preview():
            try:
                p = PUSH.preview_html()
                webbrowser.open("file:///" + p.replace("\\", "/"))
                lbl.setStyleSheet("color:%s;" % C_OK)
                lbl.setText("✓ 已用浏览器打开样式预览：%s" % p)
            except Exception as e:
                lbl.setStyleSheet("color:%s;" % C_ERR)
                lbl.setText("预览失败：%r" % (e,))

        btn_pv.clicked.connect(do_preview)
        chk_on.toggled.connect(lambda _=None: hint())
        cb_acc.currentIndexChanged.connect(lambda _=None: hint())
        sp_int.valueChanged.connect(lambda _=None: hint())
        hint()

        def on_ok():
            if chk_on.isChecked() and not accounts:
                QMessageBox.warning(
                    dlg, "还不能开启",
                    "还没有账号。\n先在「01 账号管理」里导入账号，才能监听商品列表。")
                return
            M.watch_save_cfg(enabled=chk_on.isChecked(),
                             account_id=cb_acc.currentData(),
                             interval_sec=int(sp_int.value()),
                             notify_new=chk_new.isChecked(),
                             notify_restock=chk_rest.isChecked())
            if chk_on.isChecked():
                r = M.watch_start()
                if not r.get("ok"):
                    QMessageBox.warning(dlg, "开启失败", r.get("msg", ""))
                    self._refresh_watch_btn()
                    return
            else:
                M.watch_stop()
            self._refresh_watch_btn()
            dlg.accept()
            if chk_on.isChecked():
                QMessageBox.information(
                    self, "已开启",
                    "库存监听已开启。\n\n"
                    "用「%s」每 %d 秒查一次商品列表\n"
                    "· 新品上架提醒：%s\n· 补货提醒：%s\n\n"
                    "第一次检查只建基线不推送，之后发现变化才会发微信。"
                    % (cb_acc.currentText() or "—", sp_int.value(),
                       "开" if chk_new.isChecked() else "关",
                       "开" if chk_rest.isChecked() else "关"))

        bb.accepted.connect(on_ok)
        dlg.exec()

    # ---------- 顶部状态栏 ----------
    def _build_header(self):
        f = QFrame()
        f.setObjectName("header")
        f.setFixedHeight(62)
        lay = QHBoxLayout(f)
        lay.setContentsMargins(18, 8, 20, 8)
        lay.setSpacing(14)

        brand = QLabel("得")
        brand.setObjectName("brand")
        brand.setFixedSize(38, 38)
        brand.setAlignment(Qt.AlignCenter)
        lay.addWidget(brand)

        tbox = QVBoxLayout()
        tbox.setSpacing(1)
        trow = QHBoxLayout()
        trow.setSpacing(8)
        t = QLabel("得物整点抢兑助手")
        t.setObjectName("apptitle")
        pro = QLabel("PRO")
        pro.setObjectName("pro")
        trow.addWidget(t)
        trow.addWidget(pro)
        trow.addStretch(1)
        s = QLabel("多账号 · 定时抢兑 · 全链路诊断")
        s.setObjectName("appsub")
        tbox.addLayout(trow)
        tbox.addWidget(s)
        lay.addLayout(tbox)

        lay.addStretch(1)

        self.chip_acc = QLabel("账号 0")
        self.chip_acc.setObjectName("chip")
        self.chip_task = QLabel("等待任务 0")
        self.chip_task.setObjectName("chip")
        self.chip_ntp = QLabel("NTP 未校时")
        self.chip_ntp.setObjectName("chip")
        btn_fit = QPushButton("适配窗口")
        btn_fit.setObjectName("mini")
        btn_fit.setToolTip("把窗口拉回居中的合适尺寸（换了显示器或分辨率后点这里）")
        btn_fit.clicked.connect(self.fit_window)
        btn_ntp = QPushButton("校时")
        btn_ntp.setObjectName("mini")
        btn_ntp.clicked.connect(self.do_ntp)
        self.btn_push = QPushButton("推送设置")
        self.btn_push.setObjectName("mini")
        self.btn_push.setToolTip("抢兑成功后推送到微信（PushPlus）：点这里填 token、发测试")
        self.btn_push.clicked.connect(self.push_settings)
        self.btn_answer = QPushButton("每日答题")
        self.btn_answer.setObjectName("mini")
        self.btn_answer.setToolTip("看题图填答案，所有账号一次性答完（每日可加金币）")
        self.btn_answer.clicked.connect(self.daily_answer)
        self.btn_watch = QPushButton("库存监听")
        self.btn_watch.setObjectName("mini")
        self.btn_watch.setToolTip("盯住商品列表：有新品上架 / 补货就推微信")
        self.btn_watch.clicked.connect(self.stock_watch)
        for w in (self.chip_acc, self.chip_task, btn_fit, self.chip_ntp,
                  btn_ntp, self.btn_answer, self.btn_watch, self.btn_push):
            lay.addWidget(w)

        sep = QFrame()
        sep.setFixedWidth(1)
        sep.setStyleSheet("background:%s;" % C_LINE)
        lay.addWidget(sep)

        clock_box = QVBoxLayout()
        clock_box.setSpacing(0)
        self.lbl_clock = QLabel("--:--:--")
        self.lbl_clock.setObjectName("clock")
        self.lbl_clock.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        self.lbl_date = QLabel("")
        self.lbl_date.setObjectName("appsub")
        self.lbl_date.setAlignment(Qt.AlignRight)
        clock_box.addWidget(self.lbl_clock)
        clock_box.addWidget(self.lbl_date)
        lay.addLayout(clock_box)
        add_shadow(f, blur=18, dy=3, alpha=22)
        return f

    # ---------- 左列 ----------
    def _build_left(self):
        left = QVBoxLayout()
        left.setSpacing(12)

        # ---- 01 账号管理 ----
        # 操作按钮全部提到标题栏, 纵向只保留「输入行 + 表格」, 把高度让给商品列表
        title1 = QWidget()
        tl1 = QHBoxLayout(title1)
        tl1.setContentsMargins(0, 0, 0, 0)
        tl1.setSpacing(6)
        n1 = QLabel("01")
        n1.setObjectName("secnum")
        t1 = QLabel("账号管理")
        t1.setObjectName("sectitle")
        tl1.addWidget(n1)
        tl1.addWidget(t1)
        tl1.addStretch(1)
        self.lbl_acct_err = QLabel("")
        self.lbl_acct_err.setObjectName("sectip")
        self.lbl_acct_err.setMaximumWidth(170)
        btn_r1 = QPushButton("刷新当前")
        btn_r1.setObjectName("mini")
        btn_r1.setToolTip("重新拉取当前选中账号的商品列表与金币余额")
        btn_r1.clicked.connect(self.refresh_current)
        btn_rall = QPushButton("刷新全部")
        btn_rall.setObjectName("mini")
        btn_rall.setToolTip("依次刷新所有账号")
        btn_rall.clicked.connect(self.refresh_all)
        btn_delacc = QPushButton("删除账号")
        btn_delacc.setObjectName("minidanger")
        btn_delacc.clicked.connect(self.del_account)
        self.btn_acct_fold = QPushButton("收起")
        self.btn_acct_fold.setObjectName("mini")
        self.btn_acct_fold.setToolTip("收起账号区，把空间让给商品列表")
        self.btn_acct_fold.clicked.connect(self.toggle_acct_section)
        for w in (self.lbl_acct_err, btn_r1, btn_rall, btn_delacc, self.btn_acct_fold):
            tl1.addWidget(w)
        card1, c1 = make_card(title1, spacing=8, margins=(15, 10, 15, 12))

        # 可折叠主体：输入行 + 账号表格
        self.acct_body = QWidget()
        ab = QVBoxLayout(self.acct_body)
        ab.setContentsMargins(0, 0, 0, 0)
        ab.setSpacing(8)

        row = QHBoxLayout()
        row.setSpacing(8)
        self.ed_name = QLineEdit()
        self.ed_name.setPlaceholderText("备注名(可留空)")
        self.ed_name.setFixedWidth(120)
        self.ed_curl = QLineEdit()
        self.ed_curl.setPlaceholderText("粘贴抓包 curl：需含 Cookie 与 x-auth-token 的「商品列表」请求")
        btn_ph = QPushButton("手机号登录 · 免抓包")
        btn_ph.setObjectName("mini")
        btn_ph.setToolTip(
            "直接输手机号 + 密码就能登录，不用抓包、不用复制长串 curl。\n"
            "登录接口的客户端加密已复现（userName=AES、password=md5加盐）")
        btn_ph.clicked.connect(self.phone_login)
        btn_add = QPushButton("导入账号")
        btn_add.setObjectName("primary")
        btn_add.clicked.connect(self.add_account)
        row.addWidget(self.ed_name)
        row.addWidget(self.ed_curl, 1)
        row.addWidget(btn_ph)
        row.addWidget(btn_add)
        ab.addLayout(row)

        self.tbl_acct = QTableWidget(0, 4)
        self.tbl_acct.setHorizontalHeaderLabels(["账号", "金币", "状态", "更新时间"])
        self.tbl_acct.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        for i, w in ((1, 80), (2, 132), (3, 90)):
            self.tbl_acct.horizontalHeader().setSectionResizeMode(i, QHeaderView.Fixed)
            self.tbl_acct.setColumnWidth(i, w)
        self.tbl_acct.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.tbl_acct.setSelectionMode(QAbstractItemView.SingleSelection)
        self.tbl_acct.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.tbl_acct.verticalHeader().setVisible(False)
        self.tbl_acct.setShowGrid(False)
        self.tbl_acct.setWordWrap(False)
        self.tbl_acct.setTextElideMode(Qt.ElideRight)
        self.tbl_acct.setMinimumHeight(102)
        self.tbl_acct.setMaximumHeight(196)
        self.tbl_acct.currentCellChanged.connect(self.on_account_change)
        ab.addWidget(round_wrap(self.tbl_acct))
        c1.addWidget(self.acct_body)

        self.lbl_acct_folded = QLabel("账号区已收起 · 点右侧「展开」查看账号与金币")
        self.lbl_acct_folded.setObjectName("sectip")
        self.lbl_acct_folded.hide()
        c1.addWidget(self.lbl_acct_folded)
        add_shadow(card1)
        left.addWidget(card1)

        # ---- 02 商品列表 ----
        title2 = QWidget()
        tl2 = QHBoxLayout(title2)
        tl2.setContentsMargins(0, 0, 0, 0)
        tl2.setSpacing(8)
        n2 = QLabel("02")
        n2.setObjectName("secnum")
        t2 = QLabel("商品列表")
        t2.setObjectName("sectitle")
        tl2.addWidget(n2)
        tl2.addWidget(t2)
        tl2.addStretch(1)
        self.chip_cur = QLabel("未选择账号")
        self.chip_cur.setObjectName("chipAccent")
        self.lbl_prize_stat = QLabel("")
        self.lbl_prize_stat.setObjectName("sectip")
        self.lbl_refreshed = QLabel("")
        self.lbl_refreshed.setObjectName("sectip")
        tl2.addWidget(self.lbl_prize_stat)
        tl2.addWidget(self.lbl_refreshed)
        tl2.addWidget(self.chip_cur)
        card2, c2 = make_card(title2)

        self.tbl_prize = QTableWidget(0, 5)
        self.tbl_prize.setHorizontalHeaderLabels(["等级", "商品名称", "所需金币", "库存", "状态"])
        self.tbl_prize.horizontalHeader().setSectionResizeMode(1, QHeaderView.Stretch)
        for i, w in ((0, 70), (2, 92), (3, 70), (4, 92)):
            self.tbl_prize.horizontalHeader().setSectionResizeMode(i, QHeaderView.Fixed)
            self.tbl_prize.setColumnWidth(i, w)
        self.tbl_prize.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.tbl_prize.setSelectionMode(QAbstractItemView.SingleSelection)
        self.tbl_prize.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.tbl_prize.verticalHeader().setVisible(False)
        self.tbl_prize.setAlternatingRowColors(True)
        self.tbl_prize.setShowGrid(False)
        self.tbl_prize.setWordWrap(False)
        self.tbl_prize.setTextElideMode(Qt.ElideRight)
        # 高度下限: 保证至少完整显示 5 个商品, 再多就表格内部滚动。
        # 有它在, 小屏幕下商品列表不会再被上面的卡片压成一条。
        self.tbl_prize.setMinimumHeight(196)
        self.tbl_prize.clicked.connect(self.on_pick_prize)
        c2.addWidget(round_wrap(self.tbl_prize), 1)

        row3 = QHBoxLayout()
        row3.setSpacing(8)
        # 用 ElideLabel: 商品名很长时不把右边的按钮挤出窗口(QSS 左右 padding 共 28px)
        self.lbl_pick = ElideLabel(pad=30)
        self.lbl_pick.setObjectName("picked")
        self.lbl_pick.setProperty("state", "empty")
        self.lbl_pick.setElideText("未选择商品 · 点击列表任意一行选中兑换目标", tooltip="")
        btn_test = QPushButton("测试兑换")
        btn_test.setObjectName("primary")
        btn_test.setToolTip("全链路诊断：先验登录态(token)，再用「余额买不起」的商品探测兑换接口。\n"
                            "收到「余额不足」即说明 token 与参数全部正确，且不会扣金币。")
        btn_test.clicked.connect(self.do_test_exchange)
        btn_clear_pick = QPushButton("取消选择")
        btn_clear_pick.clicked.connect(self.clear_pick)
        row3.addWidget(self.lbl_pick, 1)
        row3.addWidget(btn_clear_pick)
        row3.addWidget(btn_test)
        c2.addLayout(row3)

        self.diag_box = QFrame()
        self.diag_box.setObjectName("diag")
        self.diag_box.setProperty("state", "run")
        dv = QVBoxLayout(self.diag_box)
        dv.setContentsMargins(12, 9, 12, 9)
        dv.setSpacing(3)
        self.lbl_diag_title = QLabel("")
        self.lbl_diag_title.setStyleSheet("font-size:13px;font-weight:bold;")
        self.lbl_diag_detail = QLabel("")
        self.lbl_diag_detail.setStyleSheet("font-size:11px;color:%s;" % C_SUB)
        self.lbl_diag_detail.setWordWrap(True)
        dv.addWidget(self.lbl_diag_title)
        dv.addWidget(self.lbl_diag_detail)
        self.diag_box.hide()
        c2.addWidget(self.diag_box)
        add_shadow(card2)
        left.addWidget(card2, 1)

        # ---- 03 新建任务 ----
        title3 = QWidget()
        tl3 = QHBoxLayout(title3)
        tl3.setContentsMargins(0, 0, 0, 0)
        tl3.setSpacing(8)
        n3 = QLabel("03")
        n3.setObjectName("secnum")
        t3 = QLabel("新建定时任务")
        t3.setObjectName("sectitle")
        tl3.addWidget(n3)
        tl3.addWidget(t3)
        tl3.addStretch(1)
        self.btn_fb = QPushButton("降级设置")
        self.btn_fb.setObjectName("mini")
        self.btn_fb.clicked.connect(self.fallback_settings)
        tl3.addWidget(self.btn_fb)
        card3, c3 = make_card(title3, spacing=8, margins=(15, 10, 15, 12))
        g = QHBoxLayout()
        g.setSpacing(12)

        def field(label, widget):
            w = QWidget()
            v = QVBoxLayout(w)
            v.setContentsMargins(0, 0, 0, 0)
            v.setSpacing(3)
            lb = QLabel(label)
            lb.setObjectName("fieldlbl")
            v.addWidget(lb)
            v.addWidget(widget)
            return w

        self.ed_time = QLineEdit(M.cfg.get("target_time", "10:00:00"))
        self.ed_time.setFixedWidth(88)
        self.sp_lead = QSpinBox(); self.sp_lead.setRange(0, 5000)
        self.sp_lead.setValue(int(M.cfg.get("lead_ms", 300))); self.sp_lead.setFixedWidth(84)
        self.sp_interval = QSpinBox(); self.sp_interval.setRange(30, 5000)
        self.sp_interval.setValue(int(M.cfg.get("interval_ms", 200))); self.sp_interval.setFixedWidth(84)
        self.sp_max = QSpinBox(); self.sp_max.setRange(1, 100000)
        self.sp_max.setValue(int(M.cfg.get("max_attempts", 600))); self.sp_max.setFixedWidth(96)
        self.chk_repeat = QCheckBox("每日重复")
        self.chk_repeat.setChecked(bool(M.cfg.get("repeat_daily", False)))

        self.chk_fb = QCheckBox("失效自动降级")
        self.chk_fb.setChecked(bool(M.fb_cfg()["enabled"]))
        self.chk_fb.setToolTip(
            "商品下架 / 抢不到时，自动改抢一个「有货且买得起」的商品（买得起里挑最贵的）。\n"
            "★ 注意：这会把金币花掉，而不是留着 —— 不想要就取消勾选。\n"
            "触发条件和价格门槛点右边「降级设置」。")

        btn_task = QPushButton("创建任务")
        btn_task.setObjectName("primary")
        btn_task.setFixedHeight(36)
        btn_task.clicked.connect(self.add_task)

        g.addWidget(field("目标时间 (HH:MM:SS)", self.ed_time))
        g.addWidget(field("提前发起 (ms)", self.sp_lead))
        g.addWidget(field("重试间隔 (ms)", self.sp_interval))
        g.addWidget(field("最大尝试次数", self.sp_max))
        g.addStretch(1)
        g.addWidget(self.chk_fb, 0, Qt.AlignBottom)
        g.addWidget(self.chk_repeat, 0, Qt.AlignBottom)
        g.addWidget(btn_task, 0, Qt.AlignBottom)
        c3.addLayout(g)
        add_shadow(card3)
        left.addWidget(card3)
        return left

    # ---------- 右列 ----------
    def _build_right(self):
        right = QVBoxLayout()
        right.setSpacing(12)

        # ---- 04 任务监控 ----
        title4 = QWidget()
        tl4 = QHBoxLayout(title4)
        tl4.setContentsMargins(0, 0, 0, 0)
        tl4.setSpacing(8)
        n4 = QLabel("04")
        n4.setObjectName("secnum")
        t4 = QLabel("任务监控")
        t4.setObjectName("sectitle")
        tl4.addWidget(n4)
        tl4.addWidget(t4)
        tl4.addStretch(1)
        tip4 = QLabel("多账号多任务并行")
        tip4.setObjectName("sectip")
        tl4.addWidget(tip4)
        card4, c4 = make_card(title4, spacing=8, margins=(15, 10, 15, 12))

        self.tbl_task = QTableWidget(0, 6)
        self.tbl_task.setHorizontalHeaderLabels(["#", "账号", "商品", "时间", "状态", "详情"])
        self.tbl_task.horizontalHeader().setSectionResizeMode(5, QHeaderView.Stretch)
        for i, w in ((0, 36), (1, 72), (2, 142), (3, 74), (4, 64)):
            self.tbl_task.horizontalHeader().setSectionResizeMode(i, QHeaderView.Fixed)
            self.tbl_task.setColumnWidth(i, w)
        self.tbl_task.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.tbl_task.setSelectionMode(QAbstractItemView.SingleSelection)
        self.tbl_task.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.tbl_task.verticalHeader().setVisible(False)
        self.tbl_task.setAlternatingRowColors(True)
        self.tbl_task.setShowGrid(False)
        self.tbl_task.setWordWrap(False)
        self.tbl_task.setTextElideMode(Qt.ElideRight)
        self.tbl_task.setMinimumHeight(150)
        c4.addWidget(round_wrap(self.tbl_task), 1)

        row4 = QHBoxLayout()
        row4.setSpacing(8)
        self.lbl_task_summary = QLabel("暂无任务")
        self.lbl_task_summary.setObjectName("sectip")
        btn_delt = QPushButton("删除选中任务")
        btn_delt.setObjectName("danger")
        btn_delt.clicked.connect(self.del_task)
        btn_cleart = QPushButton("清除已结束")
        btn_cleart.clicked.connect(lambda: M.clear_done())
        row4.addWidget(self.lbl_task_summary, 1)
        row4.addWidget(btn_delt)
        row4.addWidget(btn_cleart)
        c4.addLayout(row4)
        add_shadow(card4)
        right.addWidget(card4, 5)

        # ---- 05 运行日志 ----
        title5 = QWidget()
        tl5 = QHBoxLayout(title5)
        tl5.setContentsMargins(0, 0, 0, 0)
        tl5.setSpacing(8)
        n5 = QLabel("05")
        n5.setObjectName("secnum")
        t5 = QLabel("运行日志")
        t5.setObjectName("sectitle")
        tl5.addWidget(n5)
        tl5.addWidget(t5)
        tl5.addStretch(1)
        btn_clr_log = QPushButton("清空显示")
        btn_clr_log.setObjectName("mini")
        btn_clr_log.clicked.connect(self.clear_log_view)
        tl5.addWidget(btn_clr_log)
        card5, c5 = make_card(title5, spacing=8, margins=(15, 10, 15, 12))

        self.txt_log = QTextEdit()
        self.txt_log.setObjectName("log")
        self.txt_log.setReadOnly(True)
        self.txt_log.setFont(QFont("Consolas", 9))
        self.txt_log.document().setDefaultStyleSheet(LOG_CSS)
        self.txt_log.setMinimumHeight(190)
        c5.addWidget(round_wrap(self.txt_log, "logWrap"), 1)
        add_shadow(card5)
        right.addWidget(card5, 4)
        return right

    # ================= 账号 =================
    def _acct_id(self):
        return self._cur_acc_id

    def _select_first_account(self):
        with M.lock:
            accounts = list(M.accounts)
        if accounts and self._cur_acc_id is None:
            self._cur_acc_id = accounts[0]["id"]

    def add_account(self):
        curl = self.ed_curl.text().strip()
        if not curl:
            QMessageBox.information(self, "提示", "请先粘贴手机抓包的商品列表 curl")
            return
        r = M.add_account(self.ed_name.text().strip(), curl)
        if not r.get("ok"):
            QMessageBox.warning(self, "导入失败", r.get("msg", ""))
            return
        self._cur_acc_id = r["account"]["id"]
        self.ed_curl.clear()
        self.ed_name.clear()
        if r.get("updated"):
            QMessageBox.information(self, "已更新账号", r.get("msg", "已用最新抓包更新该账号"))

    # ========== 手机号 + 密码 登录（免抓包，接口加密已复现） ==========
    def phone_login(self):
        """直接输手机号 + 密码登录得物，拿登录态当账号导入。
        底层用的是得物客户端自己的登录接口，两处客户端加密已在 dewu_login 里复现：
          userName = AES-128-ECB(手机号, "mobile0123456789") + "_1"
          password = md5(密码 + "du")
        """
        # 活动 ID 默认取已有账号用的那个，没有就用内置默认值
        acts = []
        for a in list(M.accounts):
            s = M._activity_for(a)
            if s and s not in acts:
                acts.append(s)
        default_act = acts[0] if acts else DL.DEFAULT_ACTIVITY

        dlg = QDialog(self)
        dlg.setWindowTitle("手机号登录 · 免抓包")
        dlg.setMinimumWidth(460)
        v = QVBoxLayout(dlg)
        v.setContentsMargins(20, 18, 20, 14)
        v.setSpacing(10)

        head = QLabel("输入得物账号的手机号与密码，直接登录")
        hf = QFont()
        hf.setPointSize(11)
        hf.setBold(True)
        head.setFont(hf)
        v.addWidget(head)

        tip = QLabel(
            "· 不用抓包、不用装工具，也不受输入法粘贴长度限制\n"
            "· 登录走的是得物客户端自己的接口（客户端加密已复现）\n"
            "· 密码只在本机做哈希后发出，工具不会保存你的密码\n"
            "· 登录态有效期约 365 天，登录一次能长期用")
        tip.setWordWrap(True)
        tip.setObjectName("sectip")
        v.addWidget(tip)

        form = QGridLayout()
        form.setHorizontalSpacing(10)
        form.setVerticalSpacing(8)
        ed_name = QLineEdit()
        ed_name.setPlaceholderText("可留空，默认用手机号")
        ed_phone = QLineEdit()
        ed_phone.setPlaceholderText("11 位手机号")
        ed_phone.setMaxLength(11)
        ed_pwd = QLineEdit()
        ed_pwd.setPlaceholderText("登录密码")
        ed_pwd.setEchoMode(QLineEdit.Password)
        ed_act = QLineEdit(default_act)
        ed_act.setPlaceholderText("活动 ID")
        for r, (lab, w) in enumerate((
                ("备注名", ed_name), ("手机号", ed_phone),
                ("密码", ed_pwd), ("活动 ID", ed_act))):
            lb = QLabel(lab)
            lb.setObjectName("fieldlbl")
            form.addWidget(lb, r, 0)
            form.addWidget(w, r, 1)
        form.setColumnStretch(1, 1)
        v.addLayout(form)

        lbl = QLabel("")
        lbl.setWordWrap(True)
        lbl.setObjectName("sectip")
        v.addWidget(lbl)

        bb = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        bb.button(QDialogButtonBox.Ok).setText("登录并添加")
        bb.button(QDialogButtonBox.Ok).setObjectName("primary")
        bb.button(QDialogButtonBox.Cancel).setText("取消")
        bb.rejected.connect(dlg.reject)
        v.addWidget(bb)
        ok_btn = bb.button(QDialogButtonBox.Ok)

        bridge = _LoginBridge()

        def on_done(res):
            ok_btn.setEnabled(True)
            if not res.get("ok"):
                lbl.setStyleSheet("color:%s;" % C_ERR)
                lbl.setText(res.get("msg", "登录失败"))
                return
            curl = DL.build_list_curl(res["token"], ed_act.text().strip() or default_act)
            nm = ed_name.text().strip() or ed_phone.text().strip()
            r = M.add_account(nm, curl)
            if not r.get("ok"):
                lbl.setStyleSheet("color:%s;" % C_ERR)
                lbl.setText("登录成功，但保存账号失败：%s" % r.get("msg", ""))
                return
            self._cur_acc_id = r["account"]["id"]
            dlg.accept()
            uid = res.get("user_id")
            QMessageBox.information(
                self, "登录成功",
                "已%s账号「%s」%s\n活动 ID：%s" % (
                    "更新" if r.get("updated") else "添加",
                    r["account"]["name"],
                    ("（用户ID %s）" % uid) if uid else "",
                    ed_act.text().strip() or default_act))

        bridge.done.connect(on_done)

        def do_login():
            bridge.done.emit(DL.login(ed_phone.text().strip(), ed_pwd.text(),
                                      activity=ed_act.text().strip() or default_act))

        def start():
            ph = ed_phone.text().strip()
            if not (ph.isdigit() and len(ph) == 11):
                lbl.setStyleSheet("color:%s;" % C_ERR)
                lbl.setText("请输入 11 位手机号")
                return
            if not ed_pwd.text():
                lbl.setStyleSheet("color:%s;" % C_ERR)
                lbl.setText("请输入密码")
                return
            ok_btn.setEnabled(False)
            lbl.setStyleSheet("color:%s;" % C_SUB)
            lbl.setText("正在登录…")
            threading.Thread(target=do_login, daemon=True).start()

        bb.accepted.connect(start)
        ed_pwd.returnPressed.connect(start)
        dlg.exec()

    def refresh_all(self):
        with M.lock:
            ids = [a["id"] for a in M.accounts]
        if not ids:
            QMessageBox.information(self, "提示", "还没有导入任何账号")
            return
        for i in ids:
            threading.Thread(target=M.refresh_account, args=(i,), daemon=True).start()

    def refresh_current(self):
        acc_id = self._acct_id()
        if acc_id is None:
            QMessageBox.information(self, "提示", "请先在账号列表中选择一个账号")
            return
        threading.Thread(target=M.refresh_account, args=(acc_id,), daemon=True).start()

    def del_account(self):
        acc_id = self._acct_id()
        if acc_id is None:
            QMessageBox.information(self, "提示", "请先在账号列表中选择一个账号")
            return
        acc = M.get_account(acc_id)
        if QMessageBox.question(self, "确认", "确定删除账号「%s」？" % acc["name"],
                                QMessageBox.Yes | QMessageBox.No) != QMessageBox.Yes:
            return
        r = M.delete_account(acc_id)
        if not r.get("ok"):
            QMessageBox.warning(self, "删除失败", r.get("msg", ""))
        else:
            self._cur_acc_id = None
            self.selected_prize = None
            self._refresh_pick_label()

    def on_account_change(self, row, _c, _pr, _pc):
        with M.lock:
            accounts = list(M.accounts)
        if 0 <= row < len(accounts):
            new_id = accounts[row]["id"]
            if new_id != self._cur_acc_id:
                self._cur_acc_id = new_id
                self.selected_prize = None
                self._refresh_pick_label()
                self._fill_prize_table()

    # ================= 商品 =================
    def on_pick_prize(self, index):
        row = index.row()
        prizes = self._cur_prizes
        if 0 <= row < len(prizes):
            self.selected_prize = prizes[row]
            self._refresh_pick_label()
            self._fill_prize_table()

    def clear_pick(self):
        self.selected_prize = None
        self._refresh_pick_label()
        self._fill_prize_table()

    def _refresh_pick_label(self):
        p = self.selected_prize
        if not p:
            self.lbl_pick.setElideText("未选择商品 · 点击列表任意一行选中兑换目标", tooltip="")
            self.lbl_pick.setProperty("state", "empty")
        else:
            if p["outOfStock"]:
                tail = "当前缺货 · 到点会自动刷新库存并抢兑"
            else:
                tail = "可兑换"
            cost = "-" if p["cost"] is None else p["cost"]
            # 只显示一行: 名字太长由 ElideLabel 自动省略, 完整内容进 tooltip
            self.lbl_pick.setElideText("已选：%s   ·   金币 %s   ·   %s" % (p["cName"], cost, tail))
            self.lbl_pick.setProperty("state", "picked")
        self.lbl_pick.style().unpolish(self.lbl_pick)
        self.lbl_pick.style().polish(self.lbl_pick)

    @property
    def _cur_prizes(self):
        acc_id = self._acct_id()
        if acc_id is None:
            return []
        return M.acct_state.get(acc_id, {}).get("prizes") or []

    def _fill_prize_table(self):
        prizes = self._cur_prizes
        # 标题栏报总数, 让人一眼确认「缺货的也全都列出来了」
        n_all = len(prizes)
        n_out = sum(1 for p in prizes if not p["isLock"] and p["outOfStock"])
        n_lock = sum(1 for p in prizes if p["isLock"])
        n_ok = n_all - n_out - n_lock
        stat = "共 %d 个 · 可兑换 %d" % (n_all, n_ok)
        if n_out:
            stat += " · <span style='color:%s;font-weight:bold'>缺货 %d</span>" % (C_ERR, n_out)
        else:
            stat += " · 缺货 0"
        if n_lock:
            stat += " · 未解锁 %d" % n_lock
        self.lbl_prize_stat.setTextFormat(Qt.RichText)
        self.lbl_prize_stat.setText(stat)
        self.tbl_prize.setRowCount(len(prizes))
        for r, p in enumerate(prizes):
            status = "未解锁" if p["isLock"] else ("缺货" if p["outOfStock"] else "可兑换")
            vals = [str(p["level"]), p["cName"],
                    "-" if p["cost"] is None else str(p["cost"]),
                    "-" if p["stock"] is None else str(p["stock"]),
                    status]
            picked = self.selected_prize and p["cId"] == self.selected_prize["cId"]
            for c, v in enumerate(vals):
                it = QTableWidgetItem(v)
                it.setToolTip(p["cName"] if c == 1 else v)
                if c in (0, 2, 3, 4):
                    it.setTextAlignment(Qt.AlignCenter)
                f = it.font()
                if p["isLock"]:
                    # 未解锁 = 等级不够, 完全不可用: 整行浅灰
                    it.setForeground(QColor(C_DIS))
                    if c == 4:
                        it.setToolTip("该商品有等级门槛，当前账号等级不足")
                elif p["outOfStock"]:
                    # 缺货行: 整行中性灰 + 「库存 0」「缺货」红色加粗, 与有货行一眼区分
                    if c in (3, 4):
                        it.setForeground(QColor(C_ERR)); f.setBold(True)
                    else:
                        it.setForeground(QColor(C_OOS))
                    if c == 3:
                        it.setToolTip("当前库存 0（缺货）· 10:00 补货后可抢")
                    elif c == 4:
                        it.setToolTip("当前缺货 · 到点会自动刷新库存并抢兑")
                else:
                    if c == 4:
                        it.setForeground(QColor(C_OK)); f.setBold(True)
                    elif c == 2:
                        it.setForeground(QColor(C_ACC_DK)); f.setBold(True)
                it.setFont(f)
                if picked:
                    it.setBackground(QColor(C_ACC_LT))
                self.tbl_prize.setItem(r, c, it)
            if picked:
                self.tbl_prize.selectRow(r)

    # ================= 诊断 / 测试兑换 =================
    def do_test_exchange(self):
        acc_id = self._acct_id()
        if acc_id is None:
            QMessageBox.information(self, "提示", "请先在账号列表中选择一个账号")
            return
        state = M.acct_state.get(acc_id, {})
        prizes = state.get("prizes") or []
        if not prizes:
            QMessageBox.information(self, "提示", "该账号还没有商品列表，请先点「刷新当前」")
            return
        try:
            bal = int(state.get("balance"))
        except Exception:
            bal = 0
        unaffordable = [p for p in prizes if (p["cost"] or 0) > bal]

        cId = None
        if not unaffordable:
            ans = QMessageBox.question(
                self, "余额充足，请确认",
                "当前余额 %s，列表中所有商品都买得起。\n\n"
                "安全模式下无法用「买不起」的商品做探测，\n"
                "继续将使用选中商品发起真实兑换请求，\n"
                "若库存充足会真的扣除金币并兑换成功。\n\n确定继续吗？" % bal,
                QMessageBox.Yes | QMessageBox.No)
            if ans != QMessageBox.Yes:
                return
            cId = self.selected_prize["cId"] if self.selected_prize else None

        self._set_diag_banner("run", "⏳ 正在诊断…",
                              "① 校验鉴权头 ② 验证登录态 ③ 探测兑换接口，结果会实时写入右侧日志")
        threading.Thread(target=M.diagnose, args=(acc_id, cId), daemon=True).start()

    def _set_diag_banner(self, state, title, detail):
        self.diag_box.setProperty("state", state)
        self.diag_box.style().unpolish(self.diag_box)
        self.diag_box.style().polish(self.diag_box)
        color = {"ok": C_OK, "warn": C_WARN, "error": C_ERR, "run": C_ACC}.get(state, C_TXT)
        self.lbl_diag_title.setText(title)
        self.lbl_diag_title.setStyleSheet("font-size:13px;font-weight:bold;color:%s;" % color)
        self.lbl_diag_detail.setText(detail)
        self.diag_box.show()

    # ================= 自动降级设置 =================
    def _refresh_fb_btn(self):
        """顶部折叠区那颗「降级设置」按状态改文案，不用点进去才知道开没开。"""
        c = M.fb_cfg()
        if c["enabled"]:
            n = sum(1 for k in ("on_gone", "on_soldout", "on_poor") if c[k])
            self.btn_fb.setText("降级设置 · 开")
            self.btn_fb.setToolTip(
                "商品失效时自动换商品：已开（%d 类触发）\n"
                "· 下架就换：%s\n· 抢不到也换：%s\n· 买不起也换：%s\n"
                "价格门槛：%s\n点这里改"
                % (n,
                   "开" if c["on_gone"] else "关",
                   "开" if c["on_soldout"] else "关",
                   "开" if c["on_poor"] else "关",
                   {0: "不设门槛", 0.5: "不低于原价一半", 0.8: "不低于原价 80%"}.get(
                       c["min_ratio"], "不低于原价 %d%%" % round(c["min_ratio"] * 100))))
        else:
            self.btn_fb.setText("降级设置 · 关")
            self.btn_fb.setToolTip("商品失效时不换商品，按失败停手（默认保留金币）\n点这里打开")

    def fallback_settings(self):
        """弹窗：自动降级的触发条件 + 价格门槛（全局默认，新建任务时套用）。"""
        c = M.fb_cfg()

        dlg = QDialog(self)
        dlg.setWindowTitle("自动降级设置 · 商品失效时自动换商品")
        dlg.setMinimumWidth(520)
        v = QVBoxLayout(dlg)
        v.setContentsMargins(20, 18, 20, 14)
        v.setSpacing(10)

        head = QLabel("配置的商品没了 / 抢不到，就自动换一个")
        hf = QFont()
        hf.setPointSize(11)
        hf.setBold(True)
        head.setFont(hf)
        v.addWidget(head)

        tip = QLabel(
            "· 挑替代品的规则（固定）：在「有货」且「价格 ≤ 金币余额」的商品里挑最贵的；\n"
            "  价格相同的取商品列表顺序第一个。例：余额 110 → 优先换 108 币那个。\n"
            "· ⚠ 这等于「尽量把金币花出去」，和「没抢到就留着金币」正相反 ——\n"
            "  每个任务最多降级一次，不会一路换到最便宜那个。\n"
            "· 这里设的是【新建任务】的默认值；已有任务可以在创建时取消勾选。")
        tip.setWordWrap(True)
        tip.setObjectName("sectip")
        v.addWidget(tip)

        chk_on = QCheckBox("启用自动降级（新建任务默认勾上）")
        chk_on.setChecked(bool(c["enabled"]))
        chk_on.setToolTip("关掉后，到点发现商品没了就直接按失败停手，不换商品")
        v.addWidget(chk_on)

        box = QFrame()
        box.setObjectName("card")
        g = QGridLayout(box)
        g.setContentsMargins(14, 12, 14, 12)
        g.setHorizontalSpacing(10)
        g.setVerticalSpacing(8)
        chk_gone = QCheckBox("商品下架就换")
        chk_gone.setChecked(bool(c["on_gone"]))
        chk_gone.setToolTip("配置的商品从列表里消失（下架 / 活动换批次）时立刻换")
        chk_sold = QCheckBox("抢不到也换")
        chk_sold.setChecked(bool(c["on_soldout"]))
        chk_sold.setToolTip("到点商品还在但一直售罄、刷满次数也没抢到 → 换。\n"
                            "注意：这会牺牲掉「继续等它补货」的机会")
        chk_poor = QCheckBox("余额买不起也换")
        chk_poor.setChecked(bool(c["on_poor"]))
        chk_poor.setToolTip("配置的商品价格超过余额 → 换成买得起的那个（默认关，免得不知情就把币花掉）")
        g.addWidget(chk_gone, 0, 0)
        g.addWidget(chk_sold, 0, 1)
        g.addWidget(chk_poor, 1, 0, 1, 2)
        lb_r = QLabel("最低价门槛")
        lb_r.setObjectName("fieldlbl")
        cb_r = QComboBox()
        for label, val in (("不设门槛（买得起里最贵的就是它）", 0.0),
                           ("不低于原价 50%", 0.5),
                           ("不低于原价 80%", 0.8)):
            cb_r.addItem(label, val)
        idx = cb_r.findData(round(float(c["min_ratio"]), 2))
        cb_r.setCurrentIndex(idx if idx >= 0 else 0)
        cb_r.setToolTip("防止活动末期只剩便宜货也被换掉。例：原价 108 币，\n"
                        "门槛 50% 时低于 54 币的替代品一律不要。")
        g.addWidget(lb_r, 2, 0)
        g.addWidget(cb_r, 2, 1)
        g.setColumnStretch(1, 1)
        v.addWidget(box)

        lbl = QLabel("")
        lbl.setWordWrap(True)
        lbl.setObjectName("sectip")
        v.addWidget(lbl)

        def summary():
            on = chk_on.isChecked()
            parts = [t for t, w in (("下架就换", chk_gone), ("抢不到也换", chk_sold),
                                    ("买不起也换", chk_poor)) if w.isChecked()]
            lbl.setText("自动降级：%s%s · 价格门槛：%s" % (
                "开" if on else "关",
                ("（" + " + ".join(parts) + "）") if (on and parts) else
                ("（一个触发条件都没勾，等于关着）" if on else ""),
                cb_r.currentText()))

        for w in (chk_on, chk_gone, chk_sold, chk_poor):
            w.toggled.connect(lambda _=None: summary())
        cb_r.currentIndexChanged.connect(lambda _=None: summary())
        summary()

        bb = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        bb.button(QDialogButtonBox.Ok).setText("保存")
        bb.button(QDialogButtonBox.Ok).setObjectName("primary")
        bb.button(QDialogButtonBox.Cancel).setText("取消")
        bb.rejected.connect(dlg.reject)
        v.addWidget(bb)

        def on_ok():
            M.fb_save_cfg(enabled=chk_on.isChecked(),
                          on_gone=chk_gone.isChecked(),
                          on_soldout=chk_sold.isChecked(),
                          on_poor=chk_poor.isChecked(),
                          min_ratio=cb_r.currentData())
            self.chk_fb.setChecked(chk_on.isChecked())
            self._refresh_fb_btn()
            M.log("[降级] 设置已保存 · %s · 价格门槛 %s"
                  % ("开" if chk_on.isChecked() else "关",
                     cb_r.currentText()))
            dlg.accept()

        bb.accepted.connect(on_ok)
        dlg.exec()

    # ================= 任务 =================
    def add_task(self):
        acc_id = self._acct_id()
        if acc_id is None:
            QMessageBox.information(self, "提示", "请先在账号列表中选择一个账号")
            return
        if not self.selected_prize:
            QMessageBox.information(self, "提示", "请先在商品列表中点击选择要兑换的商品")
            return
        r = M.add_task({
            "account_id": acc_id, "cId": self.selected_prize["cId"],
            "time": self.ed_time.text().strip(), "lead_ms": self.sp_lead.value(),
            "interval_ms": self.sp_interval.value(), "max_attempts": self.sp_max.value(),
            "repeat_daily": self.chk_repeat.isChecked(),
            "fallback": self.chk_fb.isChecked(),
        })
        if not r.get("ok"):
            QMessageBox.warning(self, "创建失败", r.get("msg", ""))

    def del_task(self):
        row = self.tbl_task.currentRow()
        if row < 0:
            QMessageBox.information(self, "提示", "请先在任务列表中选中一行")
            return
        with M.lock:
            tasks = list(M.tasks)
        if row < len(tasks):
            M.delete_task(tasks[row]["id"])

    def clear_log_view(self):
        self.txt_log.clear()
        self._last_log_len = len(M.logs)

    # ================= 杂项 =================
    def do_ntp(self):
        def _w():
            off = ntp_offset()
            if off is None:
                M.log("NTP 校时失败（网络问题），仍使用本机时间")
            else:
                ms = off * 1000
                M.log("NTP 校时: 服务器比本机 %+.0f ms%s" % (
                    ms, "（误差可忽略）" if abs(ms) < 200 else "（建议: Windows设置 → 时间和语言 → 立即同步）"))
        threading.Thread(target=_w, daemon=True).start()

    # ================= 轮询刷新 =================
    def _poll(self):
        now = datetime.datetime.now()
        self.lbl_clock.setText(now.strftime("%H:%M:%S"))
        self.lbl_date.setText(now.strftime("%Y-%m-%d  %A").replace(
            "Monday", "周一").replace("Tuesday", "周二").replace("Wednesday", "周三")
            .replace("Thursday", "周四").replace("Friday", "周五")
            .replace("Saturday", "周六").replace("Sunday", "周日"))

        # 跨天：题目每天换，按钮要从「已答」退回「待答」并重新探一次
        if self._answer_probe_day and self._answer_probe_day != now.date().isoformat():
            self._answer_state = None
            self._answer_day = ""
            self._refresh_answer_btn()
            self._probe_answer_status()

        with M.lock:
            accounts = [dict(a) for a in M.accounts]
            tasks = [dict(t) for t in M.tasks]
            logs = list(M.logs)
            diag, diag_seq = M.last_diag, M.diag_seq

        self._select_first_account()
        self._sync_account_table(accounts)
        self._sync_header(accounts, tasks)
        self._refresh_watch_btn()

        acc_id = self._acct_id()
        st = M.acct_state.get(acc_id, {}) if acc_id is not None else {}
        err = st.get("error")
        self.lbl_acct_err.setText(("⚠ " + err) if err else "")
        self.lbl_acct_err.setStyleSheet(
            "font-size:11px;color:%s;" % (C_ERR if err else C_SUB))
        self.chip_cur.setText("当前账号 %s · 金币 %s" % (
            next((a["name"] for a in accounts if a["id"] == acc_id), "—"), st.get("balance", "--")))
        self.lbl_refreshed.setText(("更新于 " + st["refreshed_at"]) if st.get("refreshed_at") else "")

        prizes = st.get("prizes") or []
        if prizes != self._prizes_cache.get(acc_id):
            self._prizes_cache[acc_id] = prizes
            self._fill_prize_table()

        self._sync_task_table(tasks)
        self._sync_log(logs)

        if diag and diag_seq != self._diag_seq:
            self._diag_seq = diag_seq
            self._set_diag_banner(diag.get("level", "warn"),
                                  diag.get("verdict", ""), diag.get("detail", ""))

    def _sync_header(self, accounts, tasks):
        self.chip_acc.setText("账号 %d" % len(accounts))
        waiting = sum(1 for t in tasks if t["status"] in ("等待", "兑换中"))
        self.chip_task.setText("等待任务 %d" % waiting)
        if not hasattr(self, "_ntp_set"):
            self.chip_ntp.setText("NTP 未校时")

    def _fit_acct_height(self, n):
        """账号表高度随账号数量自适应(2~5 行)+内部滚动，账号少时不吃多余高度。"""
        rows = max(2, min(5, int(n)))
        hdr = max(34, self.tbl_acct.horizontalHeader().height())
        rh = self.tbl_acct.verticalHeader().defaultSectionSize() or 30
        want = hdr + rows * rh + 2
        if self.tbl_acct.maximumHeight() != want:
            self.tbl_acct.setMinimumHeight(want)
            self.tbl_acct.setMaximumHeight(want)

    def _sync_account_table(self, accounts):
        sig = tuple((a["id"], a["name"], M.acct_state.get(a["id"], {}).get("balance"),
                     M.acct_state.get(a["id"], {}).get("error"),
                     M.acct_state.get(a["id"], {}).get("refreshed_at")) for a in accounts)
        if sig != self._acct_sig:
            self._acct_sig = sig
            self.tbl_acct.blockSignals(True)
            self.tbl_acct.setRowCount(len(accounts))
            for r, a in enumerate(accounts):
                st = M.acct_state.get(a["id"], {})
                err = st.get("error")
                vals = [a["name"], str(st.get("balance", "--")),
                        ("异常" if err else "正常"), st.get("refreshed_at", "—")]
                for c, v in enumerate(vals):
                    it = QTableWidgetItem(v)
                    it.setToolTip(err or v)
                    if c != 0:
                        it.setTextAlignment(Qt.AlignCenter)
                    if c == 2:
                        it.setForeground(QColor(C_ERR if err else C_OK))
                        f = it.font(); f.setBold(True); it.setFont(f)
                    if c == 1 and not err:
                        it.setForeground(QColor(C_ACC_DK))
                        f = it.font(); f.setBold(True); it.setFont(f)
                    self.tbl_acct.setItem(r, c, it)
            self.tbl_acct.blockSignals(False)
            self._fit_acct_height(len(accounts))
        # 同步高亮
        ids = [a["id"] for a in accounts]
        if self._cur_acc_id in ids:
            row = ids.index(self._cur_acc_id)
            if self.tbl_acct.currentRow() != row:
                self.tbl_acct.blockSignals(True)
                self.tbl_acct.selectRow(row)
                self.tbl_acct.blockSignals(False)
        elif self._cur_acc_id is not None:
            self._cur_acc_id = None

    def _sync_task_table(self, tasks):
        # 等待中的任务把倒计时也纳入指纹, 这样详情列的剩余时间每秒都会走字
        sig = tuple((t["id"], t["status"], t.get("detail", ""), t.get("attempts", 0),
                     t.get("_fell_back"), t["prize"]["cName"],
                     self._task_detail(t) if t.get("status") == "等待" else "")
                    for t in tasks)
        if sig == self._task_sig:
            return
        self._task_sig = sig
        keep_row = self.tbl_task.currentRow()
        self.tbl_task.setRowCount(len(tasks))
        for r, t in enumerate(tasks):
            pname = t["prize"]["cName"]
            if t.get("_fell_back"):
                # 已经自动降级换过商品 -> 加个【前缀】标记。
                # 故意用前缀不用后缀: 列宽有限会被省略号吃掉, 前缀永远看得见。
                pname = "降级·" + pname
            vals = [str(t["id"]), t["account_name"], pname,
                    t["time"], t["status"], self._task_detail(t)]
            for c, v in enumerate(vals):
                it = QTableWidgetItem(v)
                it.setToolTip(v)
                if c in (0, 3, 4):
                    it.setTextAlignment(Qt.AlignCenter)
                if c == 4:
                    it.setForeground(QColor(STATUS_COLOR.get(t["status"], C_TXT)))
                    f = it.font(); f.setBold(True); it.setFont(f)
                if c == 2:
                    it.setForeground(QColor(C_WARN if t.get("_fell_back") else C_ACC_DK))
                    if t.get("_fell_back"):
                        old = (t.get("_orig_prize") or {}).get("cName") or "—"
                        it.setToolTip("原配置：%s\n已自动降级为：%s"
                                      % (old, t["prize"]["cName"]))
                self.tbl_task.setItem(r, c, it)
        waiting = sum(1 for t in tasks if t["status"] in ("等待", "兑换中"))
        done = sum(1 for t in tasks if t["status"] == "成功")
        self.lbl_task_summary.setText(
            "共 %d 个任务 · 进行中 %d · 已成功 %d" % (len(tasks), waiting, done) if tasks else "暂无任务")
        # 倒计时每秒刷新会重建表格, 这里把选中行还原, 免得用户选不中要删的任务
        if 0 <= keep_row < len(tasks) and self.tbl_task.currentRow() != keep_row:
            self.tbl_task.selectRow(keep_row)

    @staticmethod
    def _task_detail(t):
        if t.get("status") == "等待":
            # 等待中的任务实时显示倒计时, 一眼看出还剩多久、有没有在正常倒数
            try:
                tgt = M._next_target(t["time"])
                remain = int((tgt - datetime.datetime.now()).total_seconds())
                remain = max(0, remain)
                h, r = divmod(remain, 3600)
                m, s = divmod(r, 60)
                if h:
                    left = "%d 时 %02d 分" % (h, m)
                elif m:
                    left = "%d 分 %02d 秒" % (m, s)
                else:
                    left = "%d 秒" % s
                return "倒计时 %s → %s" % (left, tgt.strftime("%H:%M:%S"))
            except Exception:
                pass
        d = t.get("detail") or ""
        if t.get("attempts"):
            d += " · 已尝试%d次" % t["attempts"]
        if t.get("_fell_back") and "降级" not in d:
            # 抢的过程中换过商品 —— 详情列补一句, 免得看着商品名对不上以为出错了
            d += " · 已降级换商品"
        return d

    def _sync_log(self, logs):
        if len(logs) < self._last_log_len:
            self.txt_log.clear()
            self._last_log_len = 0
        if len(logs) > self._last_log_len:
            for line in logs[self._last_log_len:]:
                self.txt_log.append(self._log_html(line))
            self._last_log_len = len(logs)
            sb = self.txt_log.verticalScrollBar()
            sb.setValue(sb.maximum())

    @staticmethod
    def _log_html(line):
        s = _html.escape(line)
        cls = "lg"
        if "=====" in line or "诊断" in line:
            cls = "lg-hi"
        elif "✓" in line or "成功" in line:
            cls = "lg-ok"
        elif "✗" in line or "失败" in line or "异常" in line:
            cls = "lg-err"
        elif "700" in line or "风控" in line or "余额不足" in line or "⚠" in line:
            cls = "lg-warn"
        return '<div class="%s">%s</div>' % (cls, s)


def main():
    app = QApplication(sys.argv)
    app.setApplicationName("得物整点抢兑助手")
    app.setApplicationDisplayName("得物整点抢兑助手")
    app.setStyle("Fusion")
    app.setStyleSheet(GLOBAL_QSS)
    ic = app_icon()
    if not ic.isNull():
        app.setWindowIcon(ic)

    # ===== 强制声明: 每次启动都必须先同意, 否则直接退出 =====
    # 注意: 必须在创建主窗口之前弹出, 避免主界面先闪一下、也避免未同意就开抢
    if not show_disclaimer(None):
        print("用户未同意使用声明，程序退出。")
        return

    w = MainWindow()
    if not ic.isNull():
        w.setWindowIcon(ic)
    w.show()
    M.log("桌面版已启动")
    for a in M.accounts:
        threading.Thread(target=M.refresh_account, args=(a["id"],), daemon=True).start()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
