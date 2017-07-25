import {HasProps, IHasProps} from "./core/has_props"
import * as p from "./core/properties"
import {isString} from "./core/util/types"
import {isEmpty} from "./core/util/object"
import {logger} from "./core/logging"
import {CustomJS} from "./models/callbacks/customjs"

export interface IModel extends IHasProps {
  tags:                  string[]
  name:                  string
  js_property_callbacks: {[key: string]: CustomJS}
  js_event_callbacks:    {[key: string]: CustomJS}
  subscribed_events:     string[]
}

/*
export class ModelMeta extends HasPropsMeta {
  tags                  = new p.Array([])
  name                  = new p.String()
  js_property_callbacks = new p.Dict({})
  js_event_callbacks    = new p.Dict({})
  subscribed_events     = new p.Array([])
}
*/

export class Model extends HasProps implements IModel {
  type = "Model"

  /*
  get tags(): string[] { return this.props.tags.getv() }
  set tags(value: string[]) { this.props.tags.setv(value) }
  */

  tags:                  [ p.Array, [] ]
  name:                  [ p.String    ]
  js_property_callbacks: [ p.Any,   {} ]
  js_event_callbacks:    [ p.Any,   {} ]
  subscribed_events:     [ p.Array, [] ]

  connect_signals() {
    super()

    for (const evt in this.js_property_callbacks) {
      const callbacks = this.js_property_callbacks[evt]
      const [name, attr] = evt.split(':')

      for (const cb of callbacks) {
        const ref = (attr != null) ? this.properties[attr] : this
        this.connect(ref[name], () => cb.execute(this))
      }
    }

    this.connect(this.properties.js_event_callbacks.change, () => this._update_event_callbacks())
    this.connect(this.properties.subscribed_events.change, () => this._update_event_callbacks())
  }

  private _process_event(event): void {
    if (event.is_applicable_to(this)) {
      const event = event._customize_event(this)

      for (const callback of this.js_event_callbacks[event.event_name] || []) {
        callback.execute(event, {})
      }

      if (this.subscribed_events.some((m) => m === event.event_name))
        this.document.event_manager.send_event(event)
    }
  }

  trigger_event(event): void {
    if (this.document != null)
      this.document.event_manager.trigger(event.set_model_id(this.id))
  }

  _update_event_callbacks(): void {
    if (this.document == null) {
      // File an issue: SidePanel in particular seems to have this issue
      logger.warn('WARNING: Document not defined for updating event callbacks')
    } else
      this.document.event_manager.subscribed_models.push(this.id)
  }

  _doc_attached() {
    if (!isEmpty(this.js_event_callbacks) || !isEmpty(this.subscribed_events))
      this._update_event_callbacks()
  }

  select(selector: Class<HasProps> | string): HasProps[] {
    if (selector.prototype instanceof HasProps)
      return this.references().filter((ref) => ref instanceof selector)
    else if (isString(selector))
      return this.references().filter((ref) => ref.name === selector)
    else
      throw new Error("invalid selector")
  }

  select_one(selector: Class<HasProps> | string): HasProps {
    const result = this.select(selector)
    switch (result.length) {
      case 0:
        return null
      case 1:
        return result[0]
      default:
        throw new Error("found more than one object matching given selector")
    }
  }
}
