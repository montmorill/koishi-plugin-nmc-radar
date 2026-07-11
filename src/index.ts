import type { Awaitable, Context, Dict } from 'koishi'
import { Buffer } from 'node:buffer'
import { createWriteStream } from 'node:fs'
import { access, mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { h, Schema } from 'koishi'
import {} from 'koishi-plugin-ffmpeg'
import zhCN from '../locales/zh-CN.yml'
import nestedRadars from './radars.yml'

export const name = 'nmc-radar'
export const inject = {
  optional: ['ffmpeg'],
}

export interface Config {
  default: keyof typeof composers
  root: string
  nodata: string
}

export const Config: Schema<Config> = Schema.object({
  default: Schema.string().default('img').description('默认输出类型。'),
  root: Schema.string().default('中央气象台').description('根区域。'),
  nodata: Schema.string().role('link').default('https://image.nmc.cn/assets/img/nodata.jpg').description('无数据图片。'),
})

interface StringTree { [key: string]: string | StringTree }

interface Product {
  url: string
  slug: string
}

function makeProduct(url: string, time: string) {
  url = url.replace('/medium/', '/')
  if (time.length < 10 && time.endsWith('小时'))
    time = `${url.slice(29, 39)}+${time}` // YYYY/MM/DD
  const slug = time
    .replace(/ (\d+)小时/, '+$1')
    .replaceAll(/[/ :]|小时/g, '')
  return { url, slug }
}

type Composer = (products: Product[], options: Dict) => Awaitable<h>

const composers: Record<string, Composer> = {
  img: products => h(h.Fragment, ...products.map(({ url }) => h.img(url))),
  url: products => h.text(products.map(({ url }) => url).join('\n')),
}

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh-CN', zhCN)

  const radarMap = new Map<string, { url: string, reverse: boolean }>()
  const regionMap = new Map<string, StringTree>()
  function traverse(tree: StringTree, reverse = false) {
    for (const key in tree) {
      const value = tree[key]
      if (key.startsWith('^'))
        reverse = !reverse
      const name = /^[$^]/.test(key) ? key.slice(1) : key
      if (typeof value !== 'string') {
        regionMap.set(name, value)
        traverse(value, reverse)
        continue
      }
      radarMap.set(name, { url: value, reverse })
    }
  }
  traverse({ [config.root]: nestedRadars })

  const command = ctx.command('radar <name:string>')
    .option('name', '--name <name:string>')
    .option('count', '-n <count:posint>')
    .option('reverse', '-R')
    .option('type', '--type <type:string>', { type: Object.keys(composers) })
    .option('type', '--img', { value: 'img' })
    .option('type', '--url', { value: 'url' })
    .action(async ({ session, options = {} as Dict }, name) => {
      options.name ??= name
      const radar = radarMap.get(options.name)
      if (!radar)
        return void await session?.send(session.text('.unknown', [options.name]))
      const { window: { document } } = new JSDOM(await ctx.http.get(radar.url))
      const nodes = document.querySelectorAll<HTMLElement>('div[data-img]')
      let products = Array.from(nodes).map(({ dataset }) =>
        makeProduct(dataset.img!, dataset.time!))
      if (products.length === 0)
        products.push({ url: config.nodata, slug: 'nodata' })

      options.type ??= config.default
      options.count ??= options.type === 'img' ? 1 : undefined
      products = products.slice(0, options.count)
      if (radar.reverse === !!options.reverse)
        products.reverse()

      const composer = composers[options.type]
      Object.assign(options, { session })
      return await composer(products, options)
    })

  ctx.inject(['ffmpeg'], async (ctx) => {
    command
      .option('type', '--gif', { value: 'gif' })
      .option('type', '--mp4', { value: 'mp4' })
      .option('type', '--apng', { value: 'apng' })
      .option('fps', '--fps <fps:posint>')
      .option('plays', '--plays <plays:natural>', { fallback: 1 })
      .option('plays', '--loop', { value: 0 })
    composers.gif = video(ctx, 'gif', h.img)
    composers.apng = video(ctx, 'apng', h.img)
    composers.mp4 = video(ctx, 'mp4', h.video)
  })

  command.subcommand('.list [name:string]')
    .action(({ session }, name = config.root) => {
      const region = regionMap.get(name)
      if (!region)
        return session?.text('.unknown', [name])
      const values = Object.entries(region).flatMap(formatEntry)
      return `${name}: ${values.join(' ')}`
    })
}

function formatEntry([name, value]: [string, string | StringTree]): h[] {
  const isRadar = typeof value === 'string'
  if (!isRadar && name.startsWith('$'))
    return Object.entries(value).flatMap(formatEntry)
  if (name.startsWith('^'))
    name = name.slice(1)
  return [h('inlinecmd', {
    text: `${isRadar ? 'radar' : 'radar.list'} ${name}`,
    enter: true,
  }, isRadar ? h.text(name) : h('b', name))]
}

function video(ctx: Context, format: string, video: (url: string) => h): Composer {
  return async (products, options) => {
    if (products.length === 1)
      return h.img(products[0].url)

    options.fps ??= products.length > 10 ? 8 : 2

    const baseDir = path.join(ctx.baseDir, 'cache', name, options.name)
    const outputPath = path.join(baseDir, [
      `${products[0].slug}...${products[products.length - 1].slug}`,
      `#${options.fps}@${options.plays}.${format}`,
    ].join(''))

    try {
      await access(outputPath)
    }
    catch {
      await mkdir(baseDir, { recursive: true })
      const filePaths = await Promise.all(products.map(async ({ url, slug }) => {
        const extension = url.match(/\.(jpg|png)/)?.[0] || ''
        const filePath = path.join(baseDir, `${slug}${extension}`)
        // eslint-disable-next-line style/max-statements-per-line, style/brace-style
        try { await access(filePath) } catch {
          try {
            const response = await ctx.http.get(url, { responseType: 'stream' })
            await pipeline(response, createWriteStream(filePath))
          }
          catch {
            // eslint-disable-next-line style/max-statements-per-line, style/brace-style
            try { await unlink(filePath) } catch {}
            return
          }
        }
        return filePath
      }))

      const buffer = filePaths.filter(Boolean).flatMap(filePath =>
        `file 'file:${filePath!.replaceAll('\\', '/')}'`).join('\n')

      // eslint-disable-next-line style/multiline-ternary
      options.loop = options.plays === 0 ? 0
        : options.plays === 1 ? -1 : options.plays - 1

      await ctx.ffmpeg.builder()
        .input(Buffer.from(buffer))
        .inputOption('-f', 'concat')
        .inputOption('-safe', '0')
        .inputOption('-protocol_whitelist', 'file,fd')
        .inputOption('-r', options.fps)
        .outputOption('-loop', options.loop)
        .outputOption('-plays', options.plays)
        .outputOption('-filter_complex', [
          '[0:v]split[out1][out2]',
          '[out1]palettegen[p]',
          '[out2][p]paletteuse',
        ].join(';'))
        .run('file', outputPath)
    }

    return video(pathToFileURL(outputPath).href)
  }
}
