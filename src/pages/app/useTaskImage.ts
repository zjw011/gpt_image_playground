// 任务图片加载 hook：缩略图走 thumbnail 缓存（小图快），大图走完整缓存。
import { useEffect, useState } from 'react'
import { ensureImageCached, ensureImageThumbnailCached, subscribeImageThumbnail } from '../../lib/imageCache'

/** 缩略图 dataUrl，未就绪时为 '' */
export function useThumbnail(imageId: string | null | undefined) {
  const [src, setSrc] = useState('')

  useEffect(() => {
    setSrc('')
    if (!imageId) return
    let alive = true
    void ensureImageThumbnailCached(imageId).then((thumbnail) => {
      if (alive && thumbnail) setSrc(thumbnail.dataUrl)
    })
    const unsubscribe = subscribeImageThumbnail(imageId, (thumbnail) => {
      if (alive) setSrc(thumbnail.dataUrl)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [imageId])

  return src
}

/** 完整图 dataUrl，未就绪时为 '' */
export function useFullImage(imageId: string | null | undefined) {
  const [src, setSrc] = useState('')

  useEffect(() => {
    setSrc('')
    if (!imageId) return
    let alive = true
    void ensureImageCached(imageId).then((dataUrl) => {
      if (alive && dataUrl) setSrc(dataUrl)
    })
    return () => { alive = false }
  }, [imageId])

  return src
}
