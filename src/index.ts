import type { Awaitable, Context } from 'koishi'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import {} from '@koishijs/canvas'
import GIFEncoder from '@zorner/gifencoder'
import { JSDOM } from 'jsdom'
import { h, Schema } from 'koishi'
import probe from 'probe-image-size'
import radars from './radars.json'

export const name = 'nmc-radar'
export const inject = { optional: ['canvas'] }

type Resolver = (urls: string[]) => Awaitable<h>
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

      return await resolvers[options?.type || config.defaultResolver](urls)
    })

  ctx.inject(['canvas'], async (ctx) => {
    command.option('type', '--gif 输出 GIF 动画', { value: 'gif' })
    resolvers.gif = async (urls) => {
      const promises = urls.map(url => ctx.canvas.loadImage(url))
      const results = await Promise.allSettled(promises)
      const images = results.flatMap(result =>
        result.status === 'fulfilled' ? [result.value] : [])

      const tempDir = path.join(ctx.baseDir, 'temp', name)
      await mkdir(tempDir, { recursive: true })
      const filePath = path.join(tempDir, `${Date.now()}.gif`)

      const { width, height } = await probe(urls[0])
      const encoder = new GIFEncoder(width, height)
      const writeStream = createWriteStream(filePath)
      encoder.createReadStream().pipe(writeStream)

      encoder.start()
      for (const image of images.reverse()) {
        const canvas = await ctx.canvas.createCanvas(width, height)
        const surface = canvas.getContext('2d')
        surface.drawImage(image, 0, 0, width, height)
        encoder.addFrame(surface as any)
      }
      encoder.finish()

      await new Promise<void>(resolve => writeStream.on('finish', resolve))
      return h.img(`file://${filePath}`, { width, height })
    }
  })

  command.subcommand('.list', '查看所有雷达站')
    .action(() => Object.keys(radars).join(' '))
}
