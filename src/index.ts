import { Context, Dict, Logger, Quester, Schema, Service, Session, Time } from 'koishi'
import {} from '@koishijs/assets'
import {} from 'koishi-plugin-puppeteer'
import { EventData, ReplyPayloads } from './reply'
import events, { CommonPayload, EmitterWebhookEventName, EventFilter, EventHandler } from './events'
import command from './command'

declare module 'koishi' {
  interface Context {
    github?: GitHub
  }

  interface Events {
    'github/webhook'(event: string, payload: CommonPayload): void
  }

  interface User {
    github: {
      accessToken: string
      refreshToken: string
    }
  }

  interface Channel {
    github: {
      webhooks: Dict<EventFilter>
    }
  }

  interface Tables {
    github: Repository
  }
}

interface Repository {
  name: string
  secret: string
  id: number
}

export interface OAuth {
  access_token: string
  expires_in: string
  refresh_token: string
  refresh_token_expires_in: string
  token_type: string
  scope: string
}

export type ReplySession = Session<'github'>

const logger = new Logger('github')

class GitHub extends Service {
  static inject = {
    required: ['database', 'server'],
    optional: ['assets', 'puppeteer'],
  }

  private http: Quester
  public history: Dict<ReplyPayloads> = Object.create(null)

  constructor(public ctx: Context, public config: GitHub.Config) {
    super(ctx, 'github', true)

    this.http = ctx.http.extend({})

    ctx.model.extend('user', {
      'github.accessToken': 'string(50)',
      'github.refreshToken': 'string(50)',
    })

    ctx.model.extend('channel', {
      'github.webhooks': 'json',
    })

    ctx.model.extend('github', {
      id: 'integer',
      name: 'string(50)',
      secret: 'string(50)',
    }, {
      primary: 'id',
    })

    ctx.plugin(events, this)
    ctx.plugin(command, this)
  }

  async emit<T extends EmitterWebhookEventName, P = {}>(event: T, payload: CommonPayload) {
    let result: any
    if (payload.action) {
      result = await this.ctx.serial(`github/event/${event}/${payload.action}` as any, payload)
    }
    if (!result) {
      result = await this.ctx.serial(`github/event/${event}` as any, payload)
    }
    return result as EventData<P>
  }

  on<T extends EmitterWebhookEventName>(event: T, listener: EventHandler<T>, prepend = false) {
    return this.ctx.on('github/event/' + event as any, listener, prepend)
  }

  async getTokens(params: any) {
    return this.http.post<OAuth>('https://github.com/login/oauth/access_token', {}, {
      params: {
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        ...params,
      },
      headers: { Accept: 'application/json' },
      timeout: this.config.requestTimeout,
    })
  }

  private async _request(method: Quester.Method, url: string, session: ReplySession, data?: any, headers?: Dict) {
    logger.debug(method, url, data)
    return this.http(method, url, {
      data,
      headers: {
        accept: 'application/vnd.github.v3+json',
        authorization: `token ${session.user.github.accessToken}`,
        ...headers,
      },
      timeout: this.config.requestTimeout,
    })
  }

  async authorize(session: Session, message: string) {
    await session.send(message)
    await session.execute({ name: 'github.authorize' })
  }

  async request(method: Quester.Method, url: string, session: ReplySession, body?: any, headers?: Dict) {
    if (!session.user.github.accessToken) {
      return this.authorize(session, session.text('github.require-auth'))
    }

    try {
      return await this._request(method, url, session, body, headers)
    } catch (error) {
      if (!Quester.isAxiosError(error) || error.response?.status !== 401) throw error
    }

    try {
      const data = await this.getTokens({
        refresh_token: session.user.github.refreshToken,
        grant_type: 'refresh_token',
      })
      session.user.github.accessToken = data.access_token
      session.user.github.refreshToken = data.refresh_token
    } catch {
      return this.authorize(session, session.text('github.auth-expired'))
    }

    return await this._request(method, url, session, body, headers)
  }
}

namespace GitHub {
  export interface Config {
    path?: string
    appId?: string
    appSecret?: string
    messagePrefix?: string
    replyFooter?: string
    redirect?: string
    replyTimeout?: number
    requestTimeout?: number
  }

  export const Config: Schema<Config> = Schema.object({
    path: Schema.string().description('GitHub 服务的路径。').default('/github'),
    appId: Schema.string().description('GitHub OAuth App ID.'),
    appSecret: Schema.string().description('GitHub OAuth App Secret.'),
    redirect: Schema.string().description('授权成功后的跳转链接。'),
    messagePrefix: Schema.string().description('推送消息的前缀。').default('[GitHub] '),
    replyFooter: Schema.string().description('显示在回复消息尾部的固定文字。').role('textarea'),
    replyTimeout: Schema.natural().role('ms').description('等待用户回复消息进行快捷操作的时间。').default(Time.hour),
    requestTimeout: Schema.natural().role('ms').description('等待请求 GitHub 的时间，超时将提示操作失败。缺省时会使用全局设置。'),
  })
}

export default GitHub
