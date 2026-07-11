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

interface Product {
  img: string
  slug: string
}

function makeProduct(name: string, { img, time }: Dict<string>) {
  img = img.replace('/medium/', '/')
  const slug = time.replaceAll(/[/ :]/g, '')
  return { img, slug }
}

type Resolver = (products: Product[], options: Dict) => Awaitable<h>
const resolvers: Record<string, Resolver> = {
  img: products => h(h.Fragment, ...products.map(({ img }) => h.img(img))),
  url: products => h.text(products.map(({ img }) => img).join('\n')),
}

export interface Config {
  root: string
  nodata: string
  default: keyof typeof resolvers
}

export const Config: Schema<Config> = Schema.object({
  root: Schema.string().default('中央气象台').description('根区域。'),
  nodata: Schema.string().role('link').default('https://image.nmc.cn/assets/img/nodata.jpg').description('无数据图片。'),
  default: Schema.union(Object.keys(resolvers)).default('img').description('默认输出类型。'),
})

interface StringTree { [key: string]: string | StringTree }

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh-CN', zhCN)

  const radarMap = new Map<string, string>()
  const regionMap = new Map<string, StringTree>()
  function traverse(tree: StringTree) {
    for (const key in tree) {
      if (key.startsWith('~'))
        continue
      const name = key.startsWith('$')
        ? key.slice(1)
        : key

      const value = tree[key]
      if (typeof value === 'string') {
        radarMap.set(name, value)
      }
      else {
        regionMap.set(name, value)
        traverse(value)
      }
    }
  }
  traverse({ [config.root]: nestedRadars })

  const command = ctx.command('radar <name:string>')
    .option('name', '--name <name:string>')
    .option('count', '-n <count:posint>')
    .option('reverse', '-R')
    .option('type', '--type <type:string>', { type: Object.keys(resolvers) })
    .option('type', '--img', { value: 'img' })
    .option('type', '--url', { value: 'url' })
    .action(async ({ session, options = {} as Dict }, name) => {
      options.name ??= name
      const url = radarMap.get(options.name)
      if (!url)
        return void await session?.send(session.text('.unknown', [options.name]))
      const { window: { document } } = new JSDOM(await ctx.http.get(url))
      let products = Array.from(document.querySelectorAll<HTMLElement>('div[data-img]'))
        .map(({ dataset }) => makeProduct(options.name, dataset as Dict))
      if (products.length === 0)
        products.push({ img: config.nodata, slug: 'nodata' })

      options.type ??= config.default
      options.count ??= options.type === 'img' ? 1 : undefined
      products = Array.from(products).slice(0, options.count)
      options.reverse || products.reverse()
      return await resolvers[options.type](products, options)
    })

  ctx.inject(['ffmpeg'], async (ctx) => {
    command
      .option('type', '--gif', { value: 'gif' })
      .option('fps', '--fps <fps:number>', { fallback: 10 })
      .option('loop', '--loop <loop:number>', { fallback: -1 })

    resolvers.gif = async (products, options) => {
      if (products.length === 1)
        return h.img(products[0].img)

      const baseDir = path.join(ctx.baseDir, 'cache', name, options.name)
      const outputPath = path.join(baseDir, [
        `${products[0].slug}+${products[products.length - 1].slug}`,
        `#${options.fps}@${options.loop}.gif`,
      ].join(''))

      try {
        await access(outputPath)
      }
      catch {
        await mkdir(baseDir, { recursive: true })
        const filePaths = await Promise.all(products.map(async ({ img, slug }) => {
          const filePath = path.join(baseDir, `${slug}.png`)
          // eslint-disable-next-line style/max-statements-per-line, style/brace-style
          try { await access(filePath) } catch {
            try {
              const response = await ctx.http.get(img, { responseType: 'stream' })
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

        await ctx.ffmpeg.builder()
          .input(Buffer.from(buffer))
          .inputOption('-f', 'concat')
          .inputOption('-safe', '0')
          .inputOption('-protocol_whitelist', 'file,fd')
          .inputOption('-r', options.fps)
          .outputOption('-loop', options.loop)
          .outputOption('-filter_complex', [
            '[0:v]split[out1][out2]',
            '[out1]palettegen[p]',
            '[out2][p]paletteuse',
          ].join(';'))
          .run('file', outputPath)
      }

      return h.img(pathToFileURL(outputPath).href)
    }
  })

  command.subcommand('.list [name:string]')
    .action(({ session }, name = config.root) => {
      const region = regionMap.get(name)
      if (!region)
        return session?.text('.unknown', [name])
      const values = Object.entries(region).flatMap(formatEntry)
      return `${name}: ${values.join(' ')}`
    })

  function formatEntry([name, value]: [string, string | StringTree]): h[] {
    if (name.startsWith('~'))
      return []
    const isRadar = typeof value === 'string'
    if (!isRadar && name.startsWith('$'))
      return Object.entries(value).flatMap(formatEntry)
    return [h('inlinecmd', {
      text: `${isRadar ? 'radar' : 'radar.list'} ${name}`,
      enter: true,
    }, isRadar ? h.text(name) : h('b', name))]
  }
}
