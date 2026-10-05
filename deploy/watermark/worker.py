"""仅接受内部图片字节，不接受 URL，不持久化用户文件。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BYTES = 16 * 1024 * 1024
slots = threading.BoundedSemaphore(1)


def process_image(source, target):
  import warnings
  import numpy as np
  import cv2
  from PIL import Image, PngImagePlugin
  import remove_ai_watermarks as raiw
  cv2.setNumThreads(1)
  Image.MAX_IMAGE_PIXELS = 8_000_000
  warnings.simplefilter('error', Image.DecompressionBombWarning)
  with Image.open(source) as image:
    if image.format not in ('PNG', 'JPEG', 'WEBP') or getattr(image, 'n_frames', 1) != 1:
      raise ValueError('仅支持静态图片')
    if image.width * image.height > 8_000_000:
      raise ValueError('图片像素过大')
    # 带签名来源声明的文件不重编码，避免破坏签名或误称保留了有效凭证。
    raw = Path(source).read_bytes()
    if b'c2pa' in raw.lower() or b'jumb' in raw.lower():
      raise ValueError('签名来源凭证图片不处理')
    rgba = np.array(image.convert('RGBA'))
    report = raiw.remove_visible_detailed(rgba[:, :, :3][:, :, ::-1].copy(), backend='cv2', sensitivity='strict', strip_metadata=False)
    if report.status == 'no_watermark':
      Path(target).write_bytes(raw)
      return {'status': report.status, 'type': Image.MIME[image.format]}
    # 非确认成功不交付修补图，前端仍可以下载原图。
    if report.status != 'cleaned':
      Path(target).write_bytes(raw)
      return {'status': report.status, 'type': Image.MIME[image.format]}
    rgba[:, :, :3] = report.image[:, :, ::-1]
    output = Image.fromarray(rgba)
    info = PngImagePlugin.PngInfo()
    for key, value in image.info.items():
      if isinstance(value, str):
        info.add_itxt(key, value)
    xmp = image.info.get('xmp')
    if isinstance(xmp, bytes):
      info.add_itxt('XML:com.adobe.xmp', xmp.decode('utf-8'))
    opts = {'pnginfo': info}
    for key in ('exif', 'icc_profile', 'dpi'):
      if image.info.get(key):
        opts[key] = image.info[key]
    output.save(target, format='PNG', **opts)
    if Path(target).stat().st_size > 24 * 1024 * 1024:
      raise ValueError('处理输出过大')
    return {'status': report.status, 'type': 'image/png'}


class Handler(BaseHTTPRequestHandler):
  def do_GET(self):
    self.send_response(200 if self.path == '/health' else 404)
    self.end_headers()

  def do_POST(self):
    if self.path != '/clean':
      self.send_error(404)
      return
    try:
      length = int(self.headers.get('Content-Length', '0'))
    except ValueError:
      length = 0
    if not 0 < length <= MAX_BYTES:
      self.send_error(413)
      return
    if not slots.acquire(blocking=False):
      self.send_error(429)
      return
    try:
      self.connection.settimeout(15)
      data = self.rfile.read(length)
      if len(data) != length:
        self.send_error(400)
        return
      with tempfile.TemporaryDirectory(prefix='huixiang-watermark-') as folder:
        source = Path(folder) / 'source'
        target = Path(folder) / 'output'
        source.write_bytes(data)
        # 每张图独立子进程，超时强制结束并回收内存，而非只断开网页连接。
        result = subprocess.run([sys.executable, __file__, '--process', str(source), str(target)], capture_output=True, timeout=45, check=False)
        if result.returncode:
          self.send_error(422)
          return
        meta = json.loads(result.stdout)
        output = target.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', meta['type'])
        self.send_header('X-Cleanup-Status', meta['status'])
        self.send_header('Content-Length', str(len(output)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(output)
    except subprocess.TimeoutExpired:
      self.send_error(503)
    except (BrokenPipeError, ConnectionResetError):
      pass
    except Exception as err:
      print(f'水印处理失败: {type(err).__name__}', file=sys.stderr)
      self.send_error(503)
    finally:
      slots.release()

  def log_message(self, *_args):
    pass


if __name__ == '__main__':
  if len(sys.argv) == 4 and sys.argv[1] == '--process':
    print(json.dumps(process_image(sys.argv[2], sys.argv[3])))
  else:
    ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', '8090'))), Handler).serve_forever()
