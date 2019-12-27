import { contain, union, intersection, difference, noop } from 'koishi-utils'
import { Command, CommandConfig, ParsedCommandLine } from './command'
import { MessageMeta, Meta, contextTypes } from './meta'
import { EventEmitter } from 'events'
import { Sender } from './sender'
import { App } from './app'
import { Database } from './database'
import { messages, errors } from './messages'

export type NextFunction = (next?: NextFunction) => any
export type Middleware = (meta: MessageMeta, next: NextFunction) => any

type PluginFunction <T extends Context, U> = (ctx: T, options: U) => void
type PluginObject <T extends Context, U> = { name?: string, apply: PluginFunction<T, U> }
export type Plugin <T extends Context = Context, U = any> = PluginFunction<T, U> | PluginObject<T, U>

type Subscope = [number[], number[]]
export type ContextScope = Subscope[]

export namespace ContextScope {
  export function stringify (scope: ContextScope) {
    return scope.map(([include, exclude], index) => {
      const type = contextTypes[index]
      const sign = include ? '+' : '-'
      const idList = include || exclude
      return `${sign}${type}:${idList.join(',')}`
    }).filter(a => a).join(';')
  }

  export function parse (identifier: string) {
    const scope = noopScope.slice()
    identifier.split(';').forEach((segment) => {
      const capture = /^([+-])(user|group|discuss):(.+)$/.exec(segment)
      if (!capture) throw new Error(errors.INVALID_IDENTIFIER)
      const [_, sign, type, list] = capture
      const idList = list.split(',').map(n => +n)
      scope[contextTypes[type]] = sign === '+' ? [idList, null] : [null, idList]
    })
    return scope
  }
}

const noopScope: ContextScope = [[[], null], [[], null], [[], null]]
const noopIdentifier = ContextScope.stringify(noopScope)

export class Context {
  public app: App
  public sender: Sender
  public database: Database
  public receiver: Receiver = new EventEmitter()

  constructor (public readonly identifier: string, private readonly _scope: ContextScope) {
    // prevent event emitter from crashing
    // https://nodejs.org/api/events.html#events_error_events
    this.receiver.on('error', noop)
  }

  inverse () {
    return this.app._createContext(this._scope.map(([include, exclude]) => {
      return include ? [null, include.slice()] : [exclude.slice(), []]
    }))
  }

  plus (ctx: Context) {
    return this.app._createContext(this._scope.map(([include1, exclude1], index) => {
      const [include2, exclude2] = ctx._scope[index]
      return include1
        ? include2 ? [union(include1, include2), null] : [null, difference(exclude2, include1)]
        : [null, include2 ? difference(exclude1, include2) : intersection(exclude1, exclude2)]
    }))
  }

  minus (ctx: Context) {
    return this.app._createContext(this._scope.map(([include1, exclude1], index) => {
      const [include2, exclude2] = ctx._scope[index]
      return include1
        ? [include2 ? difference(include1, include2) : intersection(include1, exclude2), null]
        : include2 ? [null, union(include2, exclude1)] : [difference(exclude2, exclude1), null]
    }))
  }

  intersect (ctx: Context) {
    return this.app._createContext(this._scope.map(([include1, exclude1], index) => {
      const [include2, exclude2] = ctx._scope[index]
      return include1
        ? [include2 ? intersection(include1, include2) : difference(include1, exclude2), null]
        : include2 ? [difference(include2, exclude1), null] : [null, union(exclude1, exclude2)]
    }))
  }

  match (meta: Meta) {
    const [include, exclude] = this._scope[contextTypes[meta.$ctxType]]
    return include ? include.includes(meta.$ctxId) : !exclude.includes(meta.$ctxId)
  }

  contain (ctx: Context) {
    return this._scope.every(([include1, exclude1], index) => {
      const [include2, exclude2] = ctx._scope[index]
      return include1
        ? include2 && contain(include1, include2)
        : include2 ? !intersection(include2, exclude1).length : contain(exclude2, exclude1)
    })
  }

  plugin <U> (plugin: PluginFunction<this, U>, options?: U): this
  plugin <U> (plugin: PluginObject<this, U>, options?: U): this
  plugin <U> (plugin: Plugin<this, U>, options: any) {
    if (options === false) return
    const app = Object.create(this)
    if (typeof plugin === 'function') {
      plugin(app, options)
    } else if (plugin && typeof plugin === 'object' && typeof plugin.apply === 'function') {
      plugin.apply(app, options)
    }
    return this
  }

  middleware (middleware: Middleware) {
    this.app._middlewares.push([this, middleware])
    return this
  }

  prependMiddleware (middleware: Middleware) {
    this.app._middlewares.unshift([this, middleware])
    return this
  }

  removeMiddleware (middleware: Middleware) {
    const index = this.app._middlewares.findIndex(([c, m]) => c === this && m === middleware)
    if (index >= 0) {
      this.app._middlewares.splice(index, 1)
      return true
    }
  }

  command (rawName: string, config?: CommandConfig): Command
  command (rawName: string, description: string, config?: CommandConfig): Command
  command (rawName: string, ...args: [CommandConfig?] | [string, CommandConfig?]) {
    const description = typeof args[0] === 'string' ? args.shift() as string : undefined
    const config = { description, ...args[0] as CommandConfig }
    const [path] = rawName.split(' ', 1)
    const declaration = rawName.slice(path.length)

    let parent: Command = null
    path.toLowerCase().split(/(?=[\\./])/).forEach((segment) => {
      const code = segment.charCodeAt(0)
      const name = code === 46 ? parent.name + segment : code === 47 ? segment.slice(1) : segment
      let command = this.app._commandMap[name]
      if (command) {
        if (parent) {
          if (command === parent) {
            throw new Error(errors.INVALID_SUBCOMMAND)
          }
          if (command.parent) {
            if (command.parent !== parent) {
              throw new Error(errors.INVALID_SUBCOMMAND)
            }
          } else if (parent.context.contain(command.context)) {
            command.parent = parent
            parent.children.push(command)
          } else {
            throw new Error(errors.INVALID_CONTEXT)
          }
        }
        return parent = command
      }
      const context = parent ? this.intersect(parent.context) : this
      if (context.identifier === noopIdentifier) {
        throw new Error(errors.INVALID_CONTEXT)
      }
      command = new Command(name, declaration, context)
      if (parent) {
        command.parent = parent
        parent.children.push(command)
      }
      parent = command
    })

    Object.assign(parent.config, config)
    return parent
  }

  private _getCommandByRawName (name: string) {
    name = name.split(' ', 1)[0]
    const index = name.lastIndexOf('/')
    return this.app._commandMap[name.slice(index + 1).toLowerCase()]
  }

  getCommand (name: string, meta: MessageMeta) {
    const command = this._getCommandByRawName(name)
    if (!command || !command.context.match(meta) || command.getConfig('disable', meta)) return
    return command
  }

  runCommand (name: string, meta: MessageMeta, args: string[] = [], options: Record<string, any> = {}, rest = '') {
    const command = this._getCommandByRawName(name)
    if (!command || !command.context.match(meta) || command.getConfig('disable', meta)) {
      return meta.$send(messages.COMMAND_NOT_FOUND)
    }
    const unknown = Object.keys(options).filter(key => !command._optsDef[key])
    return command.execute({ meta, command, args, options, rest, unknown })
  }

  end () {
    return this.app
  }
}

export interface EventMap {
  'message' (meta: Meta<'message'>): any
  'message/normal' (meta: Meta<'message'>): any
  'message/notice' (meta: Meta<'message'>): any
  'message/anonymous' (meta: Meta<'message'>): any
  'message/friend' (meta: Meta<'message'>): any
  'message/group' (meta: Meta<'message'>): any
  'message/discuss' (meta: Meta<'message'>): any
  'message/other' (meta: Meta<'message'>): any
  'friend-add' (meta: Meta<'notice'>): any
  'group-increase' (meta: Meta<'notice'>): any
  'group-increase/invite' (meta: Meta<'notice'>): any
  'group-increase/approve' (meta: Meta<'notice'>): any
  'group-decrease' (meta: Meta<'notice'>): any
  'group-decrease/leave' (meta: Meta<'notice'>): any
  'group-decrease/kick' (meta: Meta<'notice'>): any
  'group-decrease/kick-me' (meta: Meta<'notice'>): any
  'group-upload' (meta: Meta<'notice'>): any
  'group-admin' (meta: Meta<'notice'>): any
  'group-admin/set' (meta: Meta<'notice'>): any
  'group-admin/unset' (meta: Meta<'notice'>): any
  'group-ban' (meta: Meta<'notice'>): any
  'group-ban/ban' (meta: Meta<'notice'>): any
  'group-ban/lift-ban' (meta: Meta<'notice'>): any
  'request/friend' (meta: Meta<'request'>): any
  'request/group/add' (meta: Meta<'request'>): any
  'request/group/invite' (meta: Meta<'request'>): any
  'heartbeat' (meta: Meta<'meta_event'>): any
  'lifecycle' (meta: Meta<'meta_event'>): any
  'lifecycle/enable' (meta: Meta<'meta_event'>): any
  'lifecycle/disable' (meta: Meta<'meta_event'>): any
  'send' (meta: Meta<'send'>): any
  'before-send' (meta: Meta<'send'>): any
  'before-command' (argv: ParsedCommandLine): any
  'command' (argv: ParsedCommandLine): any
  'after-command' (argv: ParsedCommandLine): any
  'error' (error: Error): any
  'error/command' (error: Error): any
  'error/middleware' (error: Error): any
  'ready' (): any
  'before-connect' (): any
  'connect' (): any
  'before-disconnect' (): any
  'disconnect' (): any
}

export type Events = keyof EventMap

export interface Receiver extends EventEmitter {
  on <K extends Events> (event: K, listener: EventMap[K]): this
  once <K extends Events> (event: K, listener: EventMap[K]): this
  off <K extends Events> (event: K, listener: EventMap[K]): this
  addListener <K extends Events> (event: K, listener: EventMap[K]): this
  removeListener <K extends Events> (event: K, listener: EventMap[K]): this
  emit <K extends Events> (event: K, ...args: Parameters<EventMap[K]>): boolean
}
