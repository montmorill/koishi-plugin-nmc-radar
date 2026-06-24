import type { Context, Dict } from 'koishi'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import GIFEncoder from 'gifencoder'
import { JSDOM } from 'jsdom'
import { h, Schema } from 'koishi'
import {} from 'koishi-plugin-canvas'
import probe from 'probe-image-size'
import radars from './radars.json'

export const name = 'nmc-radar'
export const inject = { optional: ['canvas'] }

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

type Resolver = (urls: string[]) => Promise<h>
const resolvers: Record<string, Resolver> = {
  default: async urls => h.img(urls[0]),
  urls: async urls => h.text(urls.join('\n')),
}

export function apply(ctx: Context) {
  const command = ctx.command('radar <name:string>', '查看雷达图')
    .alias('雷达')
    .option('urls', '显示所有图片 URL')
    .action(async ({ session, options = {} }, name) => {
      const url = (radars as Dict<string>)[name]
      if (!url)
        return void session?.send('雷达站不存在，可使用 radar.list 查看所有雷达站。')

      const { window: { document } } = new JSDOM(await ctx.http.get(url))
      const nodes = document.querySelectorAll<HTMLElement>('div[data-img]')
      const urls = Array.from(nodes).map(node => node.dataset.img || '')

      for (const [option, value] of Object.entries(options)) {
        if (value && resolvers[option])
          return await resolvers[option](urls)
      }
      return await resolvers.default(urls)
    })

  command.subcommand('.list', '查看所有雷达站')
    .action(() => Object.keys(radars).join(' '))

  ctx.inject(['canvas'], async (ctx) => {
    command.option('gif', '生成 GIF 动图')
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
      return h.img(`file:///${filePath}`, { width, height })
    }
  })
}
