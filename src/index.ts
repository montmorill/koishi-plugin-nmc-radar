import type { Context, Dict } from 'koishi'
import { JSDOM } from 'jsdom'
import { h, Schema } from 'koishi'
import radars from './radars.json'

export const name = 'nmc-radar'

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

export function apply(ctx: Context) {
  ctx.command('radar <name:string>', '查看雷达图')
    .action(async ({ session }, name) => {
      const url = (radars as Dict<string>)[name]
      if (!url)
        return session?.send('该雷达图不存在。')
      const html: string = await ctx.http.get(url)
      const dom = new JSDOM(html)
      const image = dom.window.document.querySelector('div[data-img]')
      return h('img', { src: (image as HTMLElement)?.dataset.img || '' })
    })
}
