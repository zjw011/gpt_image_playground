import { useEffect, useRef } from 'react'
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Clock,
  Color,
  Group,
  PerspectiveCamera,
  Plane,
  Points,
  Raycaster,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'

/**
 * 门禁页的 3D 背景：一片会自转的粒子星云，鼠标扫过去粒子会被推开。
 *
 * 为什么自己写 shader 而不用 PointsMaterial：
 * 每颗粒子要按半径做差速自转、按自己的相位上下浮动、再叠加鼠标斥力，
 * 这些都是逐顶点的运算。放在 CPU 上每帧重算 4000 个位置再上传 buffer，
 * 在核显笔记本上会明显掉帧；丢给顶点着色器就几乎不花钱。
 */

const VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform vec3  uPointer;
  uniform float uPointerForce;

  attribute float aSize;
  attribute float aSeed;
  attribute vec3  aColor;

  varying vec3  vColor;
  varying float vFade;

  void main() {
    vec3 pos = position;

    // 差速自转：越靠外圈转得越慢，看起来才像有质量的盘面而不是一张贴图。
    float radius = length(pos.xz);
    float spin = uTime * (0.17 - radius * 0.0016);
    float c = cos(spin);
    float s = sin(spin);
    pos.xz = vec2(pos.x * c - pos.z * s, pos.x * s + pos.z * c);

    // 每颗粒子按自己的种子错开相位上下呼吸，避免整体像一块板在平移。
    pos.y += sin(uTime * 0.62 + aSeed * 6.283) * 0.3;

    // 鼠标斥力：距离越近推得越狠，松开鼠标后 uPointerForce 归零，粒子自己弹回去。
    vec3 delta = pos - uPointer;
    float dist = length(delta);
    float push = uPointerForce * 11.0 / (dist * dist + 1.1);
    pos += normalize(delta + vec3(0.0001)) * push;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    // 尺寸随距离衰减；远处压暗一点，省得边角一堆亮点抢视线。
    gl_PointSize = aSize * uPixelRatio * (52.0 / max(-mv.z, 0.001));
    vFade = smoothstep(34.0, 8.0, -mv.z);

    vColor = aColor;
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  varying vec3  vColor;
  varying float vFade;

  void main() {
    // 把方块点裁成柔和的圆：中心亮、边缘渐隐。
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float alpha = pow(smoothstep(0.5, 0.0, d), 1.7) * vFade;
    gl_FragColor = vec4(vColor, alpha);
  }
`

/** 中心靛蓝 → 中段紫罗兰 → 外圈青。外圈再掺一点点粉，纯冷色会显得寡淡。 */
const RAMP = ['#5b62f4', '#a855f7', '#22d3ee'].map((hex) => new Color(hex))
const SPARK = new Color('#f472b6')

const DISK_RADIUS = 13.5

/** Box–Muller。中心密、边缘疏，比均匀分布更像星云而不是撒盐。 */
function gaussian() {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function colorAt(ratio: number, target: Color) {
  if (ratio < 0.5) {
    target.copy(RAMP[0]).lerp(RAMP[1], ratio * 2)
  } else {
    target.copy(RAMP[1]).lerp(RAMP[2], (ratio - 0.5) * 2)
  }
  return target
}

/**
 * 摊出一条三臂旋涡。半径用 pow 偏置把粒子往中心堆，外圈留得疏一些，
 * 这样中间有个自然的"核"，鼠标在中心附近推粒子时反馈也最明显。
 */
function buildGeometry(count: number) {
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const sizes = new Float32Array(count)
  const seeds = new Float32Array(count)

  const color = new Color()
  const arms = 3

  for (let i = 0; i < count; i += 1) {
    const radius = Math.pow(Math.random(), 0.62) * DISK_RADIUS
    const arm = Math.floor(Math.random() * arms)
    const angle = radius * 1.55 + (arm / arms) * Math.PI * 2 + gaussian() * 0.3

    positions[i * 3] = Math.cos(angle) * radius
    positions[i * 3 + 1] = gaussian() * (0.42 + radius * 0.075)
    positions[i * 3 + 2] = Math.sin(angle) * radius

    const ratio = radius / DISK_RADIUS
    // 约 4% 的粒子换成粉色，像散落的暖色星点，给冷色盘一点呼吸。
    if (Math.random() < 0.04) {
      color.copy(SPARK)
    } else {
      colorAt(ratio, color)
    }
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b

    // 少量"大颗粒"制造景深，其余压小，整体才细腻。
    sizes[i] = Math.random() < 0.03 ? 3.4 + Math.random() * 3.2 : 0.55 + Math.random() * 1.5
    seeds[i] = Math.random()
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('aColor', new BufferAttribute(colors, 3))
  geometry.setAttribute('aSize', new BufferAttribute(sizes, 1))
  geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1))
  return geometry
}

export default function GateScene() {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let renderer: WebGLRenderer
    try {
      renderer = new WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'high-performance' })
    } catch {
      // 没有 WebGL 就直接不画。底下那层 CSS 渐变本身就是完整可用的背景。
      return
    }

    const width = host.clientWidth || window.innerWidth
    const height = host.clientHeight || window.innerHeight
    // 高分屏上 2 倍像素已经足够细腻，再往上只是白烧显卡。
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)

    renderer.setPixelRatio(pixelRatio)
    renderer.setSize(width, height, false)
    renderer.domElement.style.display = 'block'
    host.appendChild(renderer.domElement)

    const scene = new Scene()
    const camera = new PerspectiveCamera(50, width / height, 0.1, 120)
    camera.position.set(0, 5.4, 10.4)
    camera.lookAt(0, 0, 0)

    // 触摸设备/小屏减半，省电更重要——这个背景再好看也只是背景。
    const coarse = window.matchMedia('(pointer: coarse)').matches
    const count = coarse || width < 900 ? 1800 : 4200

    const geometry = buildGeometry(count)
    const uniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uPointer: { value: new Vector3(999, 999, 999) },
      uPointerForce: { value: 0 },
    }
    const material = new ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    })

    const points = new Points(geometry, material)
    points.rotation.x = -0.12
    const group = new Group()
    group.add(points)
    scene.add(group)

    // 鼠标 → 星云所在平面的交点。用射线求交而不是手算，相机怎么摆都不会算错。
    const raycaster = new Raycaster()
    const pointerNdc = new Vector2(0, 0)
    const diskPlane = new Plane(new Vector3(0, 1, 0), 0)
    const hit = new Vector3()
    const target = new Vector3(999, 999, 999)
    let pointerActive = false
    let pointerForce = 0

    const onPointerMove = (event: PointerEvent) => {
      const bounds = host.getBoundingClientRect()
      pointerNdc.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1
      pointerNdc.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1
      pointerActive = true
    }
    const onPointerLeave = () => {
      pointerActive = false
      pointerNdc.set(0, 0)
    }

    if (!reducedMotion) {
      window.addEventListener('pointermove', onPointerMove, { passive: true })
      window.addEventListener('pointerleave', onPointerLeave, { passive: true })
    }

    const clock = new Clock()
    let frame = 0
    let disposed = false

    const paint = () => {
      const elapsed = reducedMotion ? 6 : clock.getElapsedTime()
      uniforms.uTime.value = elapsed

      if (!reducedMotion) {
        // 整盘缓慢公转，抵消 shader 里那点自转带来的"贴死"感。
        group.rotation.y = elapsed * 0.045

        raycaster.setFromCamera(pointerNdc, camera)
        if (raycaster.ray.intersectPlane(diskPlane, hit)) {
          target.lerp(hit, 0.12)
        }
        // 松开鼠标后缓缓卸力，粒子是"弹回去"而不是"跳回去"。
        const wanted = pointerActive ? 1 : 0
        pointerForce += (wanted - pointerForce) * (wanted > pointerForce ? 0.08 : 0.03)
        uniforms.uPointer.value.copy(target)
        uniforms.uPointerForce.value = pointerForce
      }

      renderer.render(scene, camera)
      if (!reducedMotion && !disposed) frame = requestAnimationFrame(paint)
    }

    paint()

    const resize = () => {
      const nextWidth = host.clientWidth
      const nextHeight = host.clientHeight
      if (!nextWidth || !nextHeight) return
      camera.aspect = nextWidth / nextHeight
      camera.updateProjectionMatrix()
      renderer.setSize(nextWidth, nextHeight, false)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)

    // 切到后台就停，别让一个看不见的标签页一直占着 GPU。
    const onVisibility = () => {
      if (reducedMotion) return
      if (document.hidden) {
        cancelAnimationFrame(frame)
        frame = 0
      } else if (!frame) {
        clock.getDelta()
        frame = requestAnimationFrame(paint)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerleave', onPointerLeave)
      geometry.dispose()
      material.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return <div ref={hostRef} className="pointer-events-none absolute inset-0" aria-hidden="true" />
}
