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
  url: string
  slug: string
}

type Resolver = (products: Product[], options: Dict) => Awaitable<h>
const resolvers: Record<string, Resolver> = {
  img: products => h(h.Fragment, ...products.map(url => h.img(url.url))),
  url: products => h.text(products.map(url => url.url).join('\n')),
}

export interface Config {
  defaultResolver: keyof typeof resolvers
}

export const Config: Schema<Config> = Schema.object({
  defaultResolver: Schema.union(Object.keys(resolvers)).default('img').description('默认输出类型。'),
})

interface NestedMap { [key: string]: string | NestedMap }

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh-CN', zhCN)

  const radarMap = new Map<string, string>()
  const regionMap = new Map<string, NestedMap>()
  function traverse(radars: NestedMap) {
    for (const name in radars) {
      if (typeof radars[name] === 'string') {
        radarMap.set(name, radars[name])
      }
      else {
        regionMap.set(name, radars[name])
        traverse(radars[name])
      }
    }
  }
  traverse({ 全国: nestedRadars })

  const command = ctx.command('radar <name:string>')
    .option('name', '--name <name:string>')
    .option('count', '-n <count:number>')
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
      const nodes = document.querySelectorAll<HTMLElement>('div[data-img]')

      options.type ??= config.defaultResolver
      options.count ??= options.type === 'img' ? 1 : undefined
      const products = Array.from(nodes).slice(0, options.count).map(node => ({
        url: node.dataset.img!,
        slug: node.dataset.time!.replaceAll(/[/ :]/g, ''),
      }))
      options.reverse || products.reverse()
      return await resolvers[options.type](products, options)
    })

  ctx.inject(['ffmpeg'], async (ctx) => {
    command
      .option('type', '--gif', { value: 'gif' })
      .option('fps', '--fps <fps:number>', { fallback: 10 })
      .option('loop', '--loop <loop:number>', { fallback: -1 })

    resolvers.gif = async (products, options) => {
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
        const filePaths = await Promise.all(products.map(async ({ url, slug }) => {
          const filePath = path.join(baseDir, `${slug}.png`)
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
    .action(({ session }, name = '全国') => {
      const region = regionMap.get(name)
      if (!region)
        return session?.text('.unknown', [name])
      return `${name}: ${Object.entries(region)
        .map(([name, value]) => typeof value === 'string'
          ? h('inlinecmd', { text: `radar ${name}`, enter: true }, h.text(name))
          : h('inlinecmd', { text: `radar.list ${name}`, enter: true }, h('b', name)))
        .join(' ')}`
    })
}
