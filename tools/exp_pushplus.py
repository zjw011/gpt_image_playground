# -*- coding: utf-8 -*-
"""验证 pushplus 的 html 模板能否渲染出漂亮的卡片（一次性实验脚本）"""
import json
import urllib.request
import urllib.error

TOKEN = "70ef6097215e4551aa59a44f9b31062e"
URL = "https://www.pushplus.plus/send"


def send(payload):
    req = urllib.request.Request(
        URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return None, "ERR " + repr(e)


def row(label, value, color="#1b2a41", bold=False):
    return (
        '<tr>'
        '<td style="padding:9px 0;font-size:13px;color:#7a8ba3;width:76px;'
        'vertical-align:top;white-space:nowrap">%s</td>'
        '<td style="padding:9px 0;font-size:14px;color:%s;%s'
        'word-break:break-all">%s</td>'
        '</tr>' % (label, color, "font-weight:700;" if bold else "", value)
    )


def build_html(account, prize, cost, balance, ts, attempts, task_id, status="兑换成功"):
    return """<div style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;\
background:#eef3fa;padding:14px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;\
box-shadow:0 3px 16px rgba(20,40,80,.10)">

  <div style="background:linear-gradient(135deg,#2b7cf0 0%%,#1a63d0 100%%);padding:20px 22px">
    <div style="font-size:22px;font-weight:700;color:#fff;letter-spacing:.5px">🎉 抢兑成功</div>
    <div style="font-size:12px;color:#d5e6ff;margin-top:5px">得物整点抢兑助手 · 自动通知</div>
  </div>

  <div style="padding:16px 22px 4px">
    <div style="display:inline-block;background:#e6f7ee;color:#12925a;font-size:12px;
    font-weight:700;padding:4px 12px;border-radius:999px">✓ %s</div>
  </div>

  <table style="width:100%%;border-collapse:collapse;padding:0 22px">
    <tbody>
%s
    </tbody>
  </table>

  <div style="padding:4px 22px 18px">
    <div style="background:#f8fbff;border-left:3px solid #2b7cf0;border-radius:0 8px 8px 0;
    padding:10px 13px;font-size:12px;color:#5b6b83;line-height:1.7">
      %s
    </div>
  </div>

  <div style="background:#fafcff;border-top:1px solid #eef3fa;padding:11px 22px;
  font-size:11px;color:#93a3bb">
    由「得物整点抢兑助手」自动发出 · 请勿回复
  </div>
</div>
</div>""" % (
        status,
        row("账号", account)
        + row("商品", prize, "#1b2a41", True)
        + row("结果", '<span style="color:#12925a;font-weight:700">%s</span>' % status)
        + row("消耗金币", str(cost))
        + row("剩余金币", '<span style="color:#e6243f;font-weight:700;font-size:16px">%s</span>' % balance)
        + row("完成时间", ts)
        + row("任务", "任务 #%d · 第 %d 次尝试成功" % (task_id, attempts)),
        "该商品已进入你的得物账户，可在 App「我的 → 兑换记录」中查看。",
    )


if __name__ == "__main__":
    import datetime
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    content = build_html("账号1", "星巴克中杯拿铁券", 300, 1234, ts, 3, 7)
    print("=== 发送 html 模板（长卡片）===")
    print(send({"token": TOKEN, "title": "🎉 抢兑成功 | 星巴克中杯拿铁券",
                "content": content, "template": "html"}))
    print()
    print("content 长度:", len(content))
