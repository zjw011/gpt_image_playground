import { describe, expect, it } from 'vitest'
import { matchRoutes } from 'react-router'
import { resolveRouterBasename } from './routerBasename'

describe('resolveRouterBasename', () => {
  it('把 vite 的相对 base 收敛成根路径', () => {
    // vite.config 的 base 就是 './'，直接用会让路由全表失配。
    expect(resolveRouterBasename('./')).toBe('/')
    expect(resolveRouterBasename('')).toBe('/')
    expect(resolveRouterBasename('relative/')).toBe('/')
  })

  it('保留绝对 base，供子路径部署使用', () => {
    expect(resolveRouterBasename('/')).toBe('/')
    expect(resolveRouterBasename('/preview/')).toBe('/preview/')
  })
})

describe('路由匹配回归', () => {
  const routes = [{ path: '/' }, { path: '/login' }, { path: '/studio' }]

  it('相对 basename 会失配（这正是「点按钮没反应」的成因）', () => {
    expect(matchRoutes(routes, { pathname: '/' }, './')).toBeNull()
  })

  it('收敛后的 basename 能正常匹配', () => {
    const basename = resolveRouterBasename('./')
    expect(matchRoutes(routes, { pathname: '/' }, basename)?.[0].route.path).toBe('/')
    expect(matchRoutes(routes, { pathname: '/login' }, basename)?.[0].route.path).toBe('/login')
  })
})
