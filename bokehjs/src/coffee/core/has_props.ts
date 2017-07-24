import {logger} from "./logging"
import {Signal, Signalable} from "./signaling"
import * as property_mixins from "./property_mixins"
import {Ref, is_ref, create_ref} from "./util/refs"
import * as p from "./properties"
import {uniqueId} from "./util/string"
import {max} from "./util/array"
import {extend, values, clone, isEmpty} from "./util/object"
import {isString, isObject, isArray} from "./util/types"
import {isEqual} from './util/eq'

export type RefMap = {[key: string]: HasProps}

export interface SetvOpts {
  silent?: boolean
  defaults?: boolean
  no_change?: boolean
  setter_id?: string
}

export interface HasPropsOpts {
  defer_initialization?: boolean
}

export interface IHasProps {
  //static _value_record_references(value: any, value_refs: any, recursive: boolean): void

  id: string

  set_subtype(subtype: string): void

  setv(attrs: {[key: string]: any}, options?: SetvOpts): void
  finalize(attrs: {[key: string]: any}): void

  ref(): Ref
  references(): HasProps[]

  attributes_as_json(include_defaults: boolean): {[key: string]: any}

  document: Document
  attach_document(document: Document): void
  detach_document(): void
}

export class HasProps extends Signalable(Object) implements IHasProps {

  static getters(specs: any): void {
    for (const name in specs) {
      const fn = specs[name]
      Object.defineProperty(this.prototype, name, { get: fn })
    }
  }

  /*
  props: {}
  mixins: []

  @define: (object) ->
    for name, prop of object
      do (name, prop) =>
        if this.prototype.props[name]?
          throw new Error(`attempted to redefine property '${this.name}.${name}'`)

        if this.prototype[name]?
          throw new Error(`attempted to redefine attribute '${this.name}.${name}'`)

        Object.defineProperty(this.prototype, name, {
          // XXX: don't use tail calls in getters/setters due to https://bugs.webkit.org/show_bug.cgi?id=164306
          get: ()      -> value = this.getv(name); return value
          set: (value) -> this.setv(name, value); return this
        }, {
          configurable: false
          enumerable: true
        })

        [type, default_value, internal] = prop
        refined_prop = {
          type: type
          default_value: default_value
          internal: internal ? false
        }

        props = clone(this.prototype.props)
        props[name] = refined_prop
        this.prototype.props = props

  @internal: (object) ->
    _object = {}
    for name, prop of object
      do (name, prop) =>
        [type, default_value] = prop
        _object[name] = [type, default_value, true]
    @define(_object)

  @mixin: (names...) ->
    @define(property_mixins.create(names))
    mixins = this.prototype.mixins.concat(names)
    this.prototype.mixins = mixins

  @mixins: (names) -> @mixin(names...)

  @override: (name_or_object, default_value) ->
    if isString(name_or_object)
      object = {}
      object[name] = default_value
    else
      object = name_or_object

    for name, default_value of object
      do (name, default_value) =>
        value = this.prototype.props[name]
        if not value?
          throw new Error(`attempted to override nonexistent '${this.name}.${name}'`)
        props = clone(this.prototype.props)
        props[name] = extend({}, value, { default_value: default_value })
        this.prototype.props = props

  @define {
    id: [ p.Any ]
  }
  */

  toString(): string {
    return `${this.type}(${this.id})`
  }

  props: {[key: string]: any}
  properties: {[key: string]: any} = {}

  _subtype: string | null = null

  type: string

  id: string

  document: Document | null = null

  readonly destroyed = new Signal<void, HasProps>(this, "destroyed")
  readonly change = new Signal<void, HasProps>(this, "change")
  readonly transformchange = new Signal<void, HasProps>(this, "transformchange")

  attributes: {[key: string]: any} = {}
  //properties: any = {}

  _set_after_defaults: {[key: string]: boolean} = {}

  constructor(attributes: any = {}, options: HasPropsOpts = {}) {
    super()

    for (const name in this.props) {
      const {type, default_value} = this.props[name]
      if (type == null)
        throw new Error(`undefined property type for ${this.type}.${name}`)
      this.properties[name] = new type({obj: this, attr: name, default_value: default_value})
    }

    // auto generating ID
    if (attributes.id == null)
      this.setv(["id", uniqueId()], {silent: true})

    this.setv(attributes, extend({silent: true}, options))

    // allowing us to defer initialization when loading many models
    // when loading a bunch of models, we want to do initialization as a second pass
    // because other objects that this one depends on might not be loaded yet

    if (!options.defer_initialization)
      this.finalize(attributes, options)
  }

  finalize(attributes: any, options: HasPropsOpts) {
    // This is necessary because the initial creation of properties relies on
    // model.get which is not usable at that point yet in the constructor. This
    // initializer is called when deferred initialization happens for all models
    // and insures that the Bokeh properties are initialized from Backbone
    // attributes in a consistent way.
    //
    // TODO (bev) split property creation up into two parts so that only the
    // portion of init that can be done happens in HasProps constructor and so
    // that subsequent updates do not duplicate that setup work.
    for (const name in this.properties) {
      const prop = this.properties[name]
      prop.update()
      if (prop.spec.transform)
        this.connect(prop.spec.transform.change, () => this.transformchange.emit(undefined))
    }

    this.initialize(attributes, options)
    this.connect_signals()
  }

  initialize(_attributes: object, _options: HasPropsOpts): void {}

  connect_signals(): void {}

  disconnect_signals(): void {
    Signal.disconnectReceiver(this)
  }

  destroy(): void {
    this.disconnect_signals()
    this.destroyed.emit(undefined)
  }

  // Create a new model with identical attributes to this one.
  clone(): this {
    return new (this.constructor as any)(this.attributes)
  }

  private _changing = false
  private _pending = false

  // Set a hash of model attributes on the object, firing `"change"`. This is
  // the core primitive operation of a model, updating the data and notifying
  // anyone who needs to know about the change in state. The heart of the beast.
  protected _setv(attrs: {[key: string]: any}, options: SetvOpts): this {
    // Extract attributes and options.
    const silent = options.silent
    const changes: string[] = []
    const changing = this._changing
    this._changing = true

    const current = this.attributes

    // For each `set` attribute, update or delete the current value.
    for (const attr in attrs) {
      const val = attrs[attr]
      if (!isEqual(current[attr], val))
        changes.push(attr)
      current[attr] = val
    }

    // Trigger all relevant attribute changes.
    if (!silent) {
      if (changes.length > 0)
        this._pending = true
      for (const attr of changes) {
        this.properties[attr].change.emit(current[attr])
      }
    }

    // You might be wondering why there's a `while` loop here. Changes can
    // be recursively nested within `"change"` events.
    if (changing)
      return this
    if (!silent && !options.no_change) {
      while (this._pending) {
        this._pending = false
        this.change.emit(undefined)
      }
    }

    this._pending = false
    this._changing = false
    return this
  }

  setv(attrs: {[key: string]: any} | [string, any], options: SetvOpts = {}): void {
    if (isArray(attrs)) {
      const [key, value] = attrs
      attrs = {}
      attrs[key] = value
    }

    for (const prop_name in attrs) {
      if (!attrs.hasOwnProperty(prop_name))
        continue

      if (this.props[prop_name] == null)
        throw new Error(`property ${this.type}.${prop_name} wasn't declared`)

      if (!options.defaults)
        this._set_after_defaults[prop_name] = true
    }

    if (!isEmpty(attrs)) {
      const old: {[key: string]: any} = {}
      for (const key in attrs) {
        old[key] = this.getv(key)
      }
      this._setv(attrs, options)

      if (options.silent !== true) {
        for (const key in attrs) {
          this._tell_document_about_change(key, old[key], this.getv(key), options)
        }
      }
    }
  }

  set(key, value, options): this {
    logger.warn("HasProps.set('prop_name', value) is deprecated, use HasProps.prop_name = value instead")
    return this.setv(key, value, options)
  }

  get(prop_name: string): any {
    logger.warn("HasProps.get('prop_name') is deprecated, use HasProps.prop_name instead")
    return this.getv(prop_name)
  }

  getv(prop_name: string): any {
    if (this.props[prop_name] == null)
      throw new Error(`property ${this.type}.${prop_name} wasn't declared`)
    else
      return this.attributes[prop_name]
  }

  ref(): Ref {
    return create_ref(this)
  }

  // we only keep the subtype so we match Python;
  // only Python cares about this
  set_subtype(subtype): void {
    this._subtype = subtype
  }

  attribute_is_serializable(attr: string): boolean {
    const prop = this.props[attr]
    if (prop == null)
      throw new Error(`${this.type}.attribute_is_serializable('${attr}'): ${attr} wasn't declared`)
    else
      return !prop.internal
  }

  // dict of attributes that should be serialized to the server. We
  // sometimes stick things in attributes that aren't part of the
  // Document's models, subtypes that do that have to remove their
  // extra attributes here.
  serializable_attributes(): {[key: string]: any} {
    const attrs = {}
    for (const name in this.attributes) {
      if (this.attribute_is_serializable(name))
        attrs[name] = this.attributes[name]
    }
    return attrs
  }

  static _value_to_json(_key: string, value: any, _optional_parent_object: any): any {
    if (value instanceof HasProps)
      return value.ref()
    else if (isArray(value)) {
      const ref_array: any[] = []
      for (let i = 0; i < value.length; i++) {
        const v = value[i]
        ref_array.push(HasProps._value_to_json(i, v, value))
      }
      return ref_array
    } else if (isObject(value)) {
      const ref_obj: {[key: string]: any} = {}
      for (const subkey in value) {
        if (value.hasOwnProperty(subkey))
          ref_obj[subkey] = HasProps._value_to_json(subkey, value[subkey], value)
      }
      return ref_obj
    } else
      return value
  }

  // Convert attributes to "shallow" JSON (values which are themselves models
  // are included as just references)
  // TODO (havocp) can this just be toJSON (from Backbone / JSON.stingify?)
  // backbone will have implemented a toJSON already that we may need to override
  // optional value_to_json is for test to override with a "deep" version to replace the
  // standard "shallow" HasProps._value_to_json
  attributes_as_json(include_defaults: boolean = true, value_to_json=HasProps._value_to_json): any {
    const serializable_attrs = this.serializable_attributes()
    const attrs = {}
    for (const key in serializable_attrs) {
      if (!serializable_attrs.hasOwnProperty(key))
        continue
      const value = serializable_attrs[key]
      if (include_defaults)
        attrs[key] = value
      else if (key in this._set_after_defaults)
        attrs[key] = value
    }
    return value_to_json("attributes", attrs, this)
  }

  // this is like _value_record_references but expects to find refs
  // instead of models, and takes a doc to look up the refs in
  static _json_record_references(doc: Document, v: any, result: RefMap, recurse: boolean): void {
    if (v == null) {
      //
    } else if (is_ref(v)) {
      if (!(v.id in result)) {
        const model = doc.get_model_by_id(v.id)
        HasProps._value_record_references(model, result, recurse)
      }
    } else if (isArray(v)) {
      for (const elem of v) {
        HasProps._json_record_references(doc, elem, result, recurse)
      }
    } else if (isObject(v)) {
      for (const k in v) {
        if (v.hasOwnProperty(k)) {
          const elem = v[k]
          HasProps._json_record_references(doc, elem, result, recurse)
        }
      }
    }
  }

  // add all references from 'v' to 'result', if recurse
  // is true then descend into refs, if false only
  // descend into non-refs
  static _value_record_references(v: any, result: RefMap, recurse: boolean): void {
    if (v == null) {
      //
    } else if (v instanceof HasProps) {
      if (!(v.id in result)) {
        result[v.id] = v
        if (recurse) {
          const immediate = v._immediate_references()
          for (const obj of immediate) {
            HasProps._value_record_references(obj, result, true) // true=recurse
          }
        }
      }
    } else if (v.buffer instanceof ArrayBuffer) {
      //
    } else if (isArray(v)) {
      for (const elem of v) {
        HasProps._value_record_references(elem, result, recurse)
      }
    } else if (isObject(v)) {
      for (const k in v) {
        if (v.hasOwnProperty(k)) {
          const elem = v[k]
          HasProps._value_record_references(elem, result, recurse)
        }
      }
    }
  }

  // Get models that are immediately referenced by our properties
  // (do not recurse, do not include ourselves)
  _immediate_references(): HasProps[] {
    const result: RefMap = {}
    const attrs = this.serializable_attributes()
    for (const key in attrs) {
      const value = attrs[key]
      HasProps._value_record_references(value, result, false) // false = no recurse
    }
    return values(result)
  }

  references(): HasProps[] {
    const references: RefMap = {}
    HasProps._value_record_references(this, references, true)
    return values(references)
  }

  _doc_attached(): void {}

  attach_document(doc: Document): void {
    // This should only be called by the Document implementation to set the document field
    if (this.document != null && this.document !== doc)
      throw new Error("models must be owned by only a single document")

    this.document = doc
    this._doc_attached()
  }

  detach_document(): void {
    // This should only be called by the Document implementation to unset the document field
    this.document = null
  }

  _tell_document_about_change(attr: string, old: any, new_: any, options: object): void {
    if (!this.attribute_is_serializable(attr))
      return

    if (this.document != null) {
      const new_refs: RefMap = {}
      HasProps._value_record_references(new_, new_refs, false)

      const old_refs: RefMap = {}
      HasProps._value_record_references(old, old_refs, false)

      let need_invalidate = false
      for (const new_id in new_refs) {
        if (!(new_id in old_refs)) {
          need_invalidate = true
          break
        }
      }

      if (!need_invalidate) {
        for (const old_id in old_refs) {
          if (!(old_id in new_refs)) {
            need_invalidate = true
            break
          }
        }
      }

      if (need_invalidate)
        this.document._invalidate_all_models()

      this.document._notify_change(this, attr, old, new_, options)
    }
  }

  materialize_dataspecs(source: any /*DataSource*/): any {
    // Note: this should be moved to a function separate from HasProps
    const data: {[key: string]: any} = {}
    for (const name in this.properties) {
      const prop = this.properties[name]
      if (!prop.dataspec)
        continue
      // this skips optional properties like radius for circles
      if ((prop.optional || false) && prop.spec.value == null && !(name in this._set_after_defaults))
        continue

      data[`_${name}`] = prop.array(source)
      // the shapes are indexed by the column name, but when we materialize the dataspec, we should
      // store under the canonical field name, e.g. _image_shape, even if the column name is "foo"
      if (prop.spec.field != null && prop.spec.field in source._shapes)
        data[`_${name}_shape`] = source._shapes[prop.spec.field]
      if (prop instanceof p.Distance)
        data[`max_${name}`] = max(data[`_${name}`])
    }
    return data
  }
}
