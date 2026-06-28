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

type Resolver = (urls: string[], id: string) => Awaitable<h>
const resolvers: Record<string, Resolver> = {
  img: urls => h.img(urls[0]),
  imgs: urls => h(h.Fragment, ...urls.map(url => h.img(url))),
  url: urls => h.text(urls[0]),
  urls: urls => h.text(urls.join('\n')),
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
    .option('type', '--type <type:string> 输出类型', { type: Object.keys(resolvers) })
    .option('type', '--img 输出单张图片', { value: 'img' })
    .option('type', '--imgs 输出多张图片', { value: 'imgs' })
    .option('type', '--url 输出 URL', { value: 'url' })
    .option('type', '--urls 输出 URL 列表', { value: 'urls' })
    .action(async ({ session, options }, name) => {
      if (!(name in radars))
        return void session?.send('雷达站不存在，可使用 radar.list 查看所有雷达站。')

      const url = radars[name as keyof typeof radars]
      const { window: { document } } = new JSDOM(await ctx.http.get(url))
      const nodes = document.querySelectorAll<HTMLElement>('div[data-img]')
      const urls = Array.from(nodes).map(node => node.dataset.img || '')
      const resolver = resolvers[options?.type || config.defaultResolver]
      return await resolver(urls, Random.id())
    })

  ctx.inject(['ffmpeg'], async (ctx) => {
    command.option('type', '--gif 输出 GIF 动画', { value: 'gif' })
    resolvers.gif = async (urls, id) => {
      const baseDir = path.join(ctx.baseDir, 'temp', name, id)
      await mkdir(baseDir, { recursive: true })

      await Promise.all(urls.map(async (url, i) => {
        const response = await ctx.http.get(url, { responseType: 'stream' })
        const filename = `${String(i + 1).padStart(3, '0')}.png`
        const filePath = path.join(baseDir, filename)
        await writeFile(filePath, response)
      }))

      const outputPath = path.join(baseDir, '..', `${id}.gif`)
      await ctx.ffmpeg.builder()
        .input(path.join(baseDir, '%03d.png'))
        .run('file', outputPath)

      return h.img(`file:///${outputPath}`)
    }
  })

  command.subcommand('.list', '查看所有雷达站')
    .action(() => Object.keys(radars).join(' '))
}
