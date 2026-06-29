import type { Awaitable, Context, Dict } from 'koishi'
import { Buffer } from 'node:buffer'
import { access, mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { h, Schema } from 'koishi'
import {} from 'koishi-plugin-ffmpeg'
import radars from './radars.json'

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

export function apply(ctx: Context, config: Config) {
  const command = ctx.command('radar <name:string>', '查看雷达图', { checkUnknown: true })
    .alias('雷达')
    .option('name', '--name <name:string> 雷达站名称')
    .option('count', '-n <count:number> 最大输出数量')
    .option('reverse', '-R 反转顺序')
    .option('type', '--type <type:string> 输出类型', { type: Object.keys(resolvers) })
    .option('type', '--img 输出图片', { value: 'img' })
    .option('type', '--url 输出 URL', { value: 'url' })
    .action(async ({ session, options = {} as Dict }, name) => {
      options.name ??= name
      if (!(name in radars))
        return void session?.send('雷达站不存在，可使用 radar.list 查看所有雷达站。')
      const url = radars[options.name as keyof typeof radars]
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
      .option('type', '--gif 输出 GIF 动画', { value: 'gif' })
      .option('fps', '--fps <fps:number> 帧率', { fallback: 10 })
      .option('loop', '--loop <loop:number> 循环次数', { fallback: -1 })

    resolvers.gif = async (products, options) => {
      const baseDir = path.join(ctx.baseDir, 'cache', name, options.name)
      const outputPath = path.join(baseDir, [
        `${products[0].slug}+${products[products.length - 1].slug}`,
        `-${options.fps}@${options.loop}.gif`,
      ].join(''))

      try {
        await access(outputPath)
      }
      catch {
        await mkdir(baseDir, { recursive: true })
        const filePaths = await Promise.all(products.map(async ({ url, slug }) => {
          const filePath = path.join(baseDir, `${slug}.png`)
          try {
            await access(filePath)
          }
          catch {
            try {
              const response = await ctx.http.get(url, { responseType: 'stream' })
              await writeFile(filePath, response)
            }
            catch {
              return void await unlink(filePath)
            }
          }
          return filePath
        }))

        const buffer = [
          ...filePaths.filter(Boolean).flatMap(filePath =>
            `file '${filePath!.replaceAll('\\', '/')}'`),
        ].join('\n')

        await ctx.ffmpeg.builder()
          .input(Buffer.from(buffer))
          .inputOption('-f', 'concat')
          .inputOption('-safe', '0')
          .inputOption('-protocol_whitelist', 'file,fd')
          .inputOption('-r', options.fps)
          .outputOption('-loop', options.loop)
          .run('file', outputPath)
      }

      return h.img(`file://${outputPath}`)
    }
  })

  command.subcommand('.list', '查看所有雷达站')
    .action(() => Object.keys(radars).join(' '))
}
