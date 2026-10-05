"""本地合成样本验证，不下载或修改用户图片。"""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import sys
import numpy as np
from PIL import Image, PngImagePlugin
from remove_ai_watermarks.gemini_engine import GeminiEngine

spec = importlib.util.spec_from_file_location('worker', Path(__file__).with_name('worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
  def test_no_mark_returns_exact_original(self):
    with tempfile.TemporaryDirectory() as folder:
      source, output = Path(folder) / 'source.png', Path(folder) / 'output.png'
      Image.new('RGBA', (256, 256), (80, 100, 120, 180)).save(source)
      result = worker.process_image(source, output)
      self.assertEqual(result['status'], 'no_watermark')
      self.assertEqual(source.read_bytes(), output.read_bytes())

  def test_known_sparkle_preserves_alpha_and_metadata(self):
    with tempfile.TemporaryDirectory() as folder:
      source, output = Path(folder) / 'source.png', Path(folder) / 'output.png'
      pixels = np.full((1024, 1024, 4), (70, 90, 110, 200), dtype=np.uint8)
      alpha = GeminiEngine().get_interpolated_alpha(48)[:, :, None]
      region = pixels[944:992, 944:992, :3]
      pixels[944:992, 944:992, :3] = (region * (1 - alpha) + 255 * alpha).astype(np.uint8)
      info = PngImagePlugin.PngInfo()
      info.add_itxt('Software', 'AI test generator')
      info.add_itxt('parameters', 'original prompt')
      Image.fromarray(pixels).save(source, pnginfo=info)
      result = worker.process_image(source, output)
      self.assertEqual(result['status'], 'cleaned')
      with Image.open(output) as image:
        self.assertEqual(image.info['parameters'], 'original prompt')
        self.assertEqual(image.info['Software'], 'AI test generator')
        self.assertEqual(image.size, (1024, 1024))
        cleaned = np.array(image)
        self.assertTrue(np.array_equal(cleaned[:, :, 3], pixels[:, :, 3]))
        self.assertTrue(np.array_equal(cleaned[:800, :, :], pixels[:800, :, :]))
        self.assertFalse(np.array_equal(cleaned, pixels))

  def test_rejects_signed_provenance_animation_and_invalid_input(self):
    with tempfile.TemporaryDirectory() as folder:
      source, output = Path(folder) / 'source.png', Path(folder) / 'output.png'
      info = PngImagePlugin.PngInfo()
      info.add_text('c2pa', 'test credential')
      Image.new('RGB', (256, 256)).save(source, pnginfo=info)
      with self.assertRaises(ValueError):
        worker.process_image(source, output)
      Image.new('RGB', (256, 256)).save(source, format='GIF')
      with self.assertRaises(ValueError):
        worker.process_image(source, output)
      source.write_bytes(b'not an image')
      with self.assertRaises(Exception):
        worker.process_image(source, output)
      self.assertFalse(output.exists())


if __name__ == '__main__':
  if len(sys.argv) == 3 and sys.argv[1] == '--fixture':
    pixels = np.full((1024, 1024, 4), (70, 90, 110, 200), dtype=np.uint8)
    alpha = GeminiEngine().get_interpolated_alpha(48)[:, :, None]
    region = pixels[944:992, 944:992, :3]
    pixels[944:992, 944:992, :3] = (region * (1 - alpha) + 255 * alpha).astype(np.uint8)
    Image.fromarray(pixels).save(sys.argv[2])
  else:
    unittest.main()
