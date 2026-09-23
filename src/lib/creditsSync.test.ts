// @vitest-environment jsdom
//
// 这里守着一条真实踩过的坑：Number(null) 是 0 而不是 NaN。
// 一旦把"没有 x-credits-balance 头"读成"余额是 0"，页面上任何一个无关请求
// （版本检查、图片、静态资源）都会把刚拿到的余额清零——
// 表现就是"登录后余额显示 0，刷新一下又有了"，极难从现象反推原因。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { installCreditsSync, parseCreditsHeaders } from './creditsSync'
import { useCreditsStore } from './creditsStore'

function headers(pairs: Record<string, string>) {
  return new Headers(pairs)
}

describe('parseCreditsHeaders', () => {
  it('两个头都在时读出扣费与余额', () => {
    expect(parseCreditsHeaders(headers({ 'x-credits-balance': '94', 'x-credits-charged': '6' })))
      .toEqual({ balance: 94, charged: 6, lucky: false })
  })

  it('没有余额头就返回 null —— 这是最要命的一条', () => {
    expect(parseCreditsHeaders(headers({}))).toBeNull()
    expect(parseCreditsHeaders(headers({ 'content-type': 'application/json' }))).toBeNull()
    // 只有扣费头没有余额头也不认：单凭它推不出新余额。
    expect(parseCreditsHeaders(headers({ 'x-credits-charged': '6' }))).toBeNull()
  })

  it('空串与非数字当作没有头', () => {
    expect(parseCreditsHeaders(headers({ 'x-credits-balance': '' }))).toBeNull()
    expect(parseCreditsHeaders(headers({ 'x-credits-balance': 'abc' }))).toBeNull()
  })

  it('扣费头缺失时按 0 计，不会污染累计消耗', () => {
    expect(parseCreditsHeaders(headers({ 'x-credits-balance': '10' }))).toEqual({ balance: 10, charged: 0, lucky: false })
  })

  it('余额可以是 0 —— 真的花光了和"没有头"是两回事', () => {
    expect(parseCreditsHeaders(headers({ 'x-credits-balance': '0' }))).toEqual({ balance: 0, charged: 0, lucky: false })
  })
})

describe('installCreditsSync 包装的 fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    useCreditsStore.setState({ view: null })
  })

  function seedView(balance: number) {
    useCreditsStore.setState({
      view: { balance, reserved: 0, available: balance, totalIn: balance, totalOut: 0, ledger: [] },
    })
  }

  it('把响应原样交回调用方，不改状态码与 body', async () => {
    seedView(50)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    })))
    installCreditsSync()

    const response = await fetch('/api/anything')
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ ok: true })
    // 没有余额头的响应不该动余额。
    expect(useCreditsStore.getState().view?.balance).toBe(50)
  })

  it('带余额头的响应会更新余额，并累加本次消耗', async () => {
    seedView(50)
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1
      return call === 1
        ? new Response('{}', { headers: { 'x-credits-balance': '44', 'x-credits-charged': '6' } })
        : new Response('{}')
    }))
    installCreditsSync()

    await fetch('/api/relay/ch-1/images/generations')
    expect(useCreditsStore.getState().view).toMatchObject({ balance: 44, available: 44, reserved: 0, totalOut: 6 })

    // 后续一个无关请求不该把它翻回去。
    await fetch('/api/version-check')
    expect(useCreditsStore.getState().view).toMatchObject({ balance: 44, totalOut: 6 })
  })
})
