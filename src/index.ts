import type { Awaitable, Context } from 'koishi'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { h, Random, Schema } from 'koishi'
import {} from 'koishi-plugin-ffmpeg'
import radars from './radars.json'

export const name = 'nmc-radar'
export const inject = {
  optional: ['ffmpeg'],
}

interface Product {
  url: string
  time: string
}

type Resolver = (products: Product[], id: string) => Awaitable<h>
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
    .option('reverse', '-r 反转顺序')
    .option('count', '-n <count:number> 最大输出数量')
    .option('type', '--type <type:string> 输出类型', { type: Object.keys(resolvers) })
    .option('type', '--img 输出图片', { value: 'img' })
    .option('type', '--url 输出 URL', { value: 'url' })
    .action(async ({ session, options }, name) => {
      if (!(name in radars))
        return void session?.send('雷达站不存在，可使用 radar.list 查看所有雷达站。')

      const type = options?.type || config.defaultResolver
      const count = options?.count ?? (type === 'img' ? 1 : undefined)

      const url = radars[name as keyof typeof radars]
      const { window: { document } } = new JSDOM(await ctx.http.get(url))
      const nodes = document.querySelectorAll<HTMLElement>('div[data-img]')
      const products = Array.from(nodes).slice(0, count).map(node => ({
        url: node.dataset.img!,
        time: node.dataset.time!, // MM/DD HH:mm
      }))
      if (!options?.reverse)
        products.reverse()
      return await resolvers[type](products, Random.id())
    })

  ctx.inject(['ffmpeg'], async (ctx) => {
    command.option('type', '--gif 输出 GIF 动画', { value: 'gif' })
    resolvers.gif = async (products, id) => {
      const baseDir = path.join(ctx.baseDir, 'temp', name, id)
      await mkdir(baseDir, { recursive: true })

      await Promise.all(products.map(async ({ url }, i) => {
        const response = await ctx.http.get(url, { responseType: 'stream' })
        const filename = `${String(i + 1).padStart(3, '0')}.png`
        const filePath = path.join(baseDir, filename)
        await writeFile(filePath, response)
      }))

      const outputPath = path.join(baseDir, '..', `${id}.gif`)
      await ctx.ffmpeg.builder()
        .input(path.join(baseDir, '%03d.png'))
        .run('file', outputPath)

      return h.img(`file://${outputPath}`)
    }
  })

  command.subcommand('.list', '查看所有雷达站')
    .action(() => Object.keys(radars).join(' '))
}
