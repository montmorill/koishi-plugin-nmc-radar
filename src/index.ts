import type { Context, Dict } from 'koishi'
import { JSDOM } from 'jsdom'
import { h, Schema } from 'koishi'
import radars from './radars.json'

export const name = 'nmc-radar'

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

export function apply(ctx: Context) {
  ctx.command('radar <name:string>', '查看雷达图')
    .alias('雷达')
    .action(async ({ session }, name) => {
      const url = (radars as Dict<string>)[name]
      if (!url)
        return void session?.send('雷达站不存在，可使用 radar.list 查看所有雷达站。')
      const dom = new JSDOM(await ctx.http.get(url))
      const image = dom.window.document.querySelector('div[data-img]')
      return h('img', { src: (image as HTMLElement)?.dataset.img || '' })
    })
    .subcommand('.list', '查看所有雷达站')
    .action(() => Object.keys(radars).join(' '))
}
