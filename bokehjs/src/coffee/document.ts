import {Models} from "./base"
import {version as js_version} from "./version"
import {logger} from "./core/logging"
import {HasProps} from "./core/has_props"
import {Signal} from "./core/signaling"
import {is_ref, Ref} from "./core/util/refs"
import {decode_column_data} from "./core/util/serialization"
import {MultiDict, Set} from "./core/util/data_structures"
import {difference, intersection, copy, contains} from "./core/util/array"
import {extend, values} from "./core/util/object"
import {isEqual} from "./core/util/eq"
import {isArray, isObject} from "./core/util/types"
import {LayoutDOM} from "./models/layouts/layout_dom"
import {ColumnDataSource} from "./models/sources/column_data_source"

export interface Model extends HasProps {
  name: string
  tags: any[]

  _process_event(event: any): void
}

export interface ClientSession {
  send_event(event: any): void
}

export class EventManager {
  // Dispatches events to the subscribed models

  session: ClientSession | null = null
  subscribed_models = new Set<string>()

  constructor(readonly document: Document) {}

  send_event(event: any): void {
    // Send message to Python via session
    if (this.session != null) {
      this.session.send_event(event)
    }
  }

  trigger(event: any) {
    for (const model_id of this.subscribed_models.values) {
      if (event.model_id != null && event.model_id != model_id) {
        continue
      }
      const model = this.document._all_models[model_id]
      if (model != null) {
        model._process_event(event)
      }
    }
  }
}

export class DocumentChangedEvent {
  constructor(readonly document: Document) {}
}

export class ModelChangedEvent extends DocumentChangedEvent {
  constructor(document: Document, readonly model: Model, readonly attr: string,
      readonly old: any, readonly new_: any, readonly setter_id: string) {
    super(document)
  }

  json(references: any): object {
    if (this.attr == 'id') {
      logger.warn("'id' field is immutable and should never be in a ModelChangedEvent ", this)
      throw new Error("'id' field should never change, whatever code just set it is wrong")
    }

    const value = this.new_
    const value_json = this.model.constructor._value_to_json(this.attr, value, this.model)

    const value_refs: {[key: string]: any} = {}
    HasProps._value_record_references(value, value_refs, true) // true = recurse

    if (this.model.id in value_refs && this.model != value) {
      // we know we don't want a whole new copy of the obj we're
      // patching unless it's also the value itself
      delete value_refs[this.model.id]
    }

    for (const id in value_refs) {
      references[id] = value_refs[id]
    }

    return {
      kind: 'ModelChanged',
      model: this.model.ref(),
      attr:  this.attr,
      new:   value_json,
    }
  }
}

export class TitleChangedEvent extends DocumentChangedEvent {
  constructor(document: Document, readonly title: string, readonly setter_id?: string) {
    super(document)
  }

  json(_references: any): object {
    return {
      kind:  'TitleChanged',
      title: this.title,
    }
  }
}

export class RootAddedEvent extends DocumentChangedEvent {
  constructor(document: Document, readonly model: Model, readonly setter_id?: string) {
    super(document)
  }

  json(references: any): object {
    HasProps._value_record_references(this.model, references, true)
    return {
      kind:  'RootAdded',
      model: this.model.ref(),
    }
  }
}

export class RootRemovedEvent extends DocumentChangedEvent {
  constructor(document: Document, readonly model: Model, readonly setter_id?: string) {
    super(document)
  }

  json(_references: any): object {
    return {
      kind: 'RootRemoved',
      model: this.model.ref(),
    }
  }
}

export const DEFAULT_TITLE = "Bokeh Application"

export const documents: Document[] = []

// This class should match the API of the Python Document class
// as much as possible.
export class Document {

  _title: string = DEFAULT_TITLE
  _roots: Model[] = []
  _all_models: {[key: string]: HasProps} = {}
  _all_models_by_name = new MultiDict<Model>()
  _all_models_freeze_count = 0
  _callbacks: ((event: any) => void)[] = []
  event_manager = new EventManager(this)
  idle = new Signal<void, this>(this, "idle")
  protected _idle_roots = new WeakMap() // TODO: WeakSet would be better

  constructor() {
    documents.push(this)
  }

  get layoutables(): LayoutDOM[] {
    return this._roots.filter((root) => root instanceof LayoutDOM)
  }

  get is_idle(): boolean {
    for (const root of this.layoutables) {
      if (!this._idle_roots.has(root))
        return false
    }

    return true
  }

  notify_idle(model: Model): void {
    this._idle_roots.set(model, true)

    if (this.is_idle)
      this.idle.emit(undefined)
  }

  clear(): void {
    this._push_all_models_freeze()
    try {
      while (this._roots.length > 0) {
        this.remove_root(this._roots[0])
      }
    } finally {
      this._pop_all_models_freeze()
    }
  }

  destructively_move(dest_doc: Document): void {
    if (dest_doc === this)
      throw new Error("Attempted to overwrite a document with itself")

    dest_doc.clear()
    // we have to remove ALL roots before adding any
    // to the new doc or else models referenced from multiple
    // roots could be in both docs at once, which isn't allowed.
    const roots = copy(this._roots)
    this.clear()

    for (const root of roots) {
      if (root.document != null) {
        throw new Error(`Somehow we didn't detach ${root}`)
      }
    }
    if (Object.keys(this._all_models).length !== 0)
      throw new Error(`this._all_models still had stuff in it: ${ this._all_models }`)

    for (const root of roots) {
      dest_doc.add_root(root)
    }
    dest_doc.set_title(this._title)
    // TODO other fields of doc
  }

  protected _push_all_models_freeze(): void {
    this._all_models_freeze_count += 1
  }

  protected _pop_all_models_freeze(): void {
    this._all_models_freeze_count -= 1
    if (this._all_models_freeze_count === 0)
      this._recompute_all_models()
  }

  protected _invalidate_all_models(): void {
    logger.debug("invalidating document models")
    // if freeze count is > 0, we'll recompute on unfreeze
    if (this._all_models_freeze_count == 0)
      this._recompute_all_models()
  }

  protected _recompute_all_models(): void {
    let new_all_models_set = new Set<HasProps>()

    for (const root of this._roots) {
      new_all_models_set = new_all_models_set.union(root.references())
    }

    const old_all_models_set = new Set(values(this._all_models))
    const to_detach = old_all_models_set.diff(new_all_models_set)
    const to_attach = new_all_models_set.diff(old_all_models_set)

    const recomputed: {[key: string]: HasProps} = {}

    for (const m of new_all_models_set.values) {
      recomputed[m.id] = m
    }

    for (const d of to_detach.values) {
      d.detach_document()
      const name = d.name
      if (name != null)
        this._all_models_by_name.remove_value(name, d)
    }

    for (const a of to_attach.values) {
      a.attach_document(this)
      const name = a.name
      if (name != null)
        this._all_models_by_name.add_value(name, a)
    }

    this._all_models = recomputed
  }

  roots() {
    return this._roots
  }

  add_root(model: Model, setter_id?: string): void {
    logger.debug(`Adding root: ${model}`)

    if (contains(this._roots, model))
      return

    this._push_all_models_freeze()
    try {
      this._roots.push(model)
    } finally {
      this._pop_all_models_freeze()
    }

    this._trigger_on_change(new RootAddedEvent(this, model, setter_id))
  }

  remove_root(model: Model, setter_id?: string): void {
    const i = this._roots.indexOf(model)
    if (i < 0)
      return

    this._push_all_models_freeze()
    try {
      this._roots.splice(i, 1)
    } finally {
      this._pop_all_models_freeze()
    }

    this._trigger_on_change(new RootRemovedEvent(this, model, setter_id))
  }

  title(): string {
    return this._title
  }

  set_title(title: string, setter_id?: string): void {
    if (title !== this._title) {
      this._title = title
      this._trigger_on_change(new TitleChangedEvent(this, title, setter_id))
    }
  }

  get_model_by_id(model_id: string): Model | null {
    return this._all_models[model_id] || null
  }

  get_model_by_name(name: string): Model | null {
    return this._all_models_by_name.get_one(name, `Multiple models are named '${name}'`)
  }

  on_change(callback): void {
    if (contains(this._callbacks, callback))
      return
    this._callbacks.push(callback)
  }

  remove_on_change(callback): void {
    const i = this._callbacks.indexOf(callback)
    if (i >= 0)
      this._callbacks.splice(i, 1)
  }

  _trigger_on_change(event: any): void {
    for (const cb of this._callbacks) {
      cb(event)
    }
  }

  // called by the model
  _notify_change(model: Model, attr: string, old: any, new_: any, options: object = {}): void {
    if (attr === "name") {
      this._all_models_by_name.remove_value(old, model)
      if (new_ != null)
        this._all_models_by_name.add_value(new_, model)
    }
    this._trigger_on_change(new ModelChangedEvent(this, model, attr, old, new_, options.setter_id))
  }

  static _references_json(references: HasProps, include_defaults: boolean = true): Ref[] {
    const references_json: Ref[] = []
    for (const r in references) {
      const ref = r.ref()
      ref.attributes = r.attributes_as_json(include_defaults)
      // server doesn't want id in here since it's already in ref above
      delete ref.attributes.id
      references_json.push(ref)
    }

    return references_json
  }

  static _instantiate_object(obj_id, obj_type, obj_attrs) {
    const full_attrs = extend({}, obj_attrs, {id: obj_id})
    const model = Models(obj_type)
    new model(full_attrs, {silent: true, defer_initialization: true})
  }

  // given a JSON representation of all models in a graph, return a
  // dict of new model objects
  static _instantiate_references_json(references_json, existing_models) {
    // Create all instances, but without setting their props
    const references = {}
    for (const obj of references_json) {
      const obj_id = obj.id
      const obj_type = obj.type
      const obj_attrs = obj.attributes

      if (obj_id in existing_models)
        instance = existing_models[obj_id]
      else {
        const instance = Document._instantiate_object(obj_id, obj_type, obj_attrs)
        if ('subtype' in obj)
          instance.set_subtype(obj.subtype)
      }
      references[instance.id] = instance
    }

    return references
  }

  // if v looks like a ref, or a collection, resolve it, otherwise return it unchanged
  // recurse into collections but not into HasProps
  static _resolve_refs(value, old_references, new_references) {

    const resolve_ref = (v) => {
      if (is_ref(v)) {
        if (v.id in old_references)
          return old_references[v.id]
        else if (v.id in new_references)
          return new_references[v.id]
        else
          throw new Error(`reference ${JSON.stringify(v)} isn't known (not in Document?)`)
      } else if (isArray(v))
        return resolve_array(v)
      else if (isObject(v))
        return resolve_dict(v)
      else
        return v
    }

    const resolve_dict = (dict) => {
      const resolved = {}
      for (const k in dict) {
        const v = dict[k]
        resolved[k] = resolve_ref(v)
      }
      return resolved
    }

    const resolve_array = (array) => {
      const resolved = []
      for (const v of array) {
        resolved.push(resolve_ref(v))
      }
      return resolved
    }

    resolve_ref(value)
  }

  // given a JSON representation of all models in a graph and new
  // model instances, set the properties on the models from the
  // JSON
  static _initialize_references_json(references_json, old_references, new_references) {
    const to_update = {}
    for (const obj of references_json) {
      const obj_id = obj.id
      const obj_attrs = obj.attributes

      let was_new: boolean
      let instance: HasProps

      if (obj_id in old_references) {
        was_new = false
        instance = old_references[obj_id]
      } else {
        was_new = true
        instance = new_references[obj_id]
      }

      // replace references with actual instances in obj_attrs
      const obj_attrs = Document._resolve_refs(obj_attrs, old_references, new_references)

      to_update[instance.id] = [instance, obj_attrs, was_new]
    }

    // this is so that, barring cycles, when an instance gets its
    // refs resolved, the values for those refs also have their
    // refs resolved.
    const foreach_depth_first = (items, f) => {
      const already_started = {}

      const foreach_value = (v, f) => {
        if (v instanceof HasProps) {
          // note that we ignore instances that aren't updated (not in to_update)
          if (!(v.id in already_started) && v.id in items) {
            already_started[v.id] = true
            const [same_as_v, attrs, was_new] = items[v.id]
            for (const a in attrs) {
              const f = attrs[a]
              foreach_value(e, f)
            }
            f(v, attrs, was_new)
          }
        } else if (isArray(v)) {
          for (const e of v)
            foreach_value(e, f)
        } else if (isObject(v)) {
          for (const k in v) {
            const e = v[k]
            foreach_value(e, f)
          }
        }
      }

      for (const k in items) {
        const v = items[k]
        foreach_value(v[0], f)
      }
    }

    // this first pass removes all 'refs' replacing them with real instances
    foreach_depth_first(to_update, (instance, attrs, was_new) => {
      if (was_new)
        instance.setv(attrs, {silent: true})
    })

    // after removing all the refs, we can run the initialize code safely
    foreach_depth_first(to_update, (instance, attrs, was_new) => {
      if (was_new)
        instance.finalize(attrs)
    })
  }

  static _event_for_attribute_change(changed_obj, key, new_value, doc, value_refs) {
    const changed_model = doc.get_model_by_id(changed_obj.id)
    if (!changed_model.attribute_is_serializable(key))
      return null

    const event = {
      kind: 'ModelChanged',
      model: { id: changed_obj.id, type: changed_obj.type },
      attr: key,
      new: new_value,
    }
    HasProps._json_record_references(doc, new_value, value_refs, true) // true = recurse
    return event
  }

  static _events_to_sync_objects(from_obj, to_obj, to_doc, value_refs) {
    const from_keys = Object.keys(from_obj.attributes)
    const to_keys = Object.keys(to_obj.attributes)
    const removed = difference(from_keys, to_keys)
    const added = difference(to_keys, from_keys)
    const shared = intersection(from_keys, to_keys)

    const events = []
    for (const key of removed) {
      // we don't really have a "remove" event - not sure this ever
      // happens even. One way this could happen is if the server
      // does include_defaults=True and we do
      // include_defaults=false ... in that case it'd be best to
      // just ignore this probably. Warn about it, could mean
      // there's a bug if we don't have a key that the server sent.
      logger.warn(`Server sent key ${key} but we don't seem to have it in our JSON`)
    }
    for (const key of added) {
      new_value = to_obj.attributes[key]
      events.push(Document._event_for_attribute_change(from_obj, key, new_value, to_doc, value_refs))
    }
    for (const key of shared) {
      const old_value = from_obj.attributes[key]
      const new_value = to_obj.attributes[key]
      if (old_value == null && new_value == null)
        ; // do nothing
      else if (old_value == null || new_value == null)
        events.push(Document._event_for_attribute_change(from_obj, key, new_value, to_doc, value_refs))
      else {
        if (!isEqual(old_value, new_value))
          events.push(Document._event_for_attribute_change(from_obj, key, new_value, to_doc, value_refs))
      }
    }

    return events.filter((e) => e != null)
  }

  // we use this to detect changes during document deserialization
  // (in model constructors and initializers)
  static _compute_patch_since_json(from_json, to_doc) {
    const to_json = to_doc.to_json(include_defaults=false)

    const refs = (json) => {
      const result = {}
      for (const obj of json.roots.references) {
        result[obj.id] = obj
      }
      return result
    }

    const from_references = refs(from_json)
    const from_roots = {}
    const from_root_ids = []
    for (const r of from_json.roots.root_ids) {
      from_roots[r] = from_references[r]
      from_root_ids.push(r)
    }

    const to_references = refs(to_json)
    const to_roots = {}
    const to_root_ids = []
    for (const r of to_json.roots.root_ids) {
      to_roots[r] = to_references[r]
      to_root_ids.push(r)
    }

    from_root_ids.sort()
    to_root_ids.sort()

    if (difference(from_root_ids, to_root_ids).length > 0 ||
        difference(to_root_ids, from_root_ids).length > 0) {
      // this would arise if someone does add_root/remove_root during
      // document deserialization, hopefully they won't ever do so.
      throw new Error("Not implemented: computing add/remove of document roots")
    }

    const value_refs = {}
    let events = []

    for (const id in to_doc._all_models) {
      const model = to_doc._all_models[id]
      if (id in from_references) {
        const update_model_events = Document._events_to_sync_objects(
          from_references[id],
          to_references[id],
          to_doc,
          value_refs)
        events = events.concat(update_model_events)
      }
    }

    return {
      events: events,
      references: Document._references_json(values(value_refs), include_defaults=false)
    }
  }

  to_json_string(include_defaults: boolean = true) {
    return JSON.stringify(this.to_json(include_defaults))
  }

  to_json(include_defaults=true) {
    const root_ids = []
    for (const r of this._roots) {
      root_ids.push(r.id)
    }

    const root_references = values(this._all_models)

    return {
      title: this._title,
      roots: {
        root_ids: root_ids,
        references: Document._references_json(root_references, include_defaults),
      }
    }
  }

  static from_json_string(s) {
    if (s == null)
      throw new Error(`JSON string is ${typeof s}`)
    const json = JSON.parse(s)
    return Document.from_json(json)
  }

  static from_json(json) {
    logger.debug("Creating Document from JSON")
    if (typeof json !== 'object')
      throw new Error(`JSON object has wrong type ${typeof json}`)

    const py_version = json.version
    const is_dev = py_version.indexOf('+') !== -1 || py_version.indexOf('-') !== -1

    const versions_string = `Library versions: JS (${js_version})  /  Python (${py_version})`

    if (!is_dev && js_version !== py_version) {
      logger.warn("JS/Python version mismatch")
      logger.warn(versions_string)
    } else
      logger.debug(versions_string)

    const roots_json = json.roots
    const root_ids = roots_json.root_ids
    const references_json = roots_json.references

    const references = Document._instantiate_references_json(references_json, {})
    Document._initialize_references_json(references_json, {}, references)

    const doc = new Document()
    for (const r of root_ids) {
      doc.add_root(references[r])
    }

    doc.set_title(json.title)
    return doc
  }

  replace_with_json(json) {
    const replacement = Document.from_json(json)
    replacement.destructively_move(this)
  }

  create_json_patch_string(events) {
    return JSON.stringify(this.create_json_patch(events))
  }

  create_json_patch(events) {
    const references = {}
    const json_events = []
    for (const event of events) {
      if (event.document !== this) {
        logger.warn("Cannot create a patch using events from a different document, event had ", event.document, " we are ", this)
        throw new Error("Cannot create a patch using events from a different document")
      }

      json_events.push(event.json(references))
    }

    return {
      events: json_events,
      references: Document._references_json(values(references))
    }
  }

  apply_json_patch_string(patch) {
    this.apply_json_patch(JSON.parse(patch))
  }

  apply_json_patch(patch, setter_id?: string) {
    const references_json = patch.references
    const events_json = patch.events
    const references = Document._instantiate_references_json(references_json, this._all_models)

    // The model being changed isn't always in references so add it in
    for (const event_json of events_json) {
      if ('model' in event_json) {
        const model_id = event_json.model.id
        if (model_id in this._all_models) {
          references[model_id] = this._all_models[model_id]
        } else {
          if (!(model_id in references)) {
            logger.warn("Got an event for unknown model ", event_json.model)
            throw new Error("event model wasn't known")
          }
        }
      }
    }

    // split references into old and new so we know whether to initialize or update
    const old_references = {}
    const new_references = {}
    for (const id in references) {
      const value = references[id]
      if (id in this._all_models)
        old_references[id] = value
      else
        new_references[id] = value
    }

    Document._initialize_references_json(references_json, old_references, new_references)

    for (const event_json of events_json) {
      switch (event_json.kind) {
        case 'ModelChanged':
          const patched_id = event_json.model.id
          if (!(patched_id in this._all_models))
            throw new Error(`Cannot apply patch to ${patched_id} which is not in the document`)
          const patched_obj = this._all_models[patched_id]
          const attr = event_json.attr
          const model_type = event_json.model.type
          if (attr === 'data' && model_type === 'ColumnDataSource') {
            const [data, shapes] = decode_column_data(event_json['new'])
            patched_obj.setv({_shapes: shapes, data: data}, {setter_id: setter_id})
          } else {
            const value = Document._resolve_refs(event_json['new'], old_references, new_references)
            //XXXpatched_obj.setv({ `${attr}` : value }, {setter_id: setter_id})
          }
          break

        case 'ColumnsStreamed':
          const column_source_id = event_json.column_source.id
          if (!(column_source_id in this._all_models))
            throw new Error(`Cannot stream to ${column_source_id} which is not in the document`)
          const column_source = this._all_models[column_source_id]
          if (!(column_source instanceof ColumnDataSource))
            throw new Error("Cannot stream to non-ColumnDataSource")
          const data = event_json.data
          const rollover = event_json.rollover
          column_source.stream(data, rollover)
          break

        case 'ColumnsPatched':
          const column_source_id = event_json.column_source.id
          if (!(column_source_id in this._all_models))
            throw new Error(`Cannot patch ${column_source_id} which is not in the document`)
          const column_source = this._all_models[column_source_id]
          if (!(column_source instanceof ColumnDataSource))
            throw new Error("Cannot patch non-ColumnDataSource")
          const patches = event_json.patches
          column_source.patch(patches)
          break

        case 'RootAdded':
          const root_id = event_json.model.id
          const root_obj = references[root_id]
          this.add_root(root_obj, setter_id)
          break

        case 'RootRemoved':
          const root_id = event_json.model.id
          const root_obj = references[root_id]
          this.remove_root(root_obj, setter_id)
          break

        case 'TitleChanged':
          this.set_title(event_json.title, setter_id)
          break

        default:
          throw new Error("Unknown patch event " + JSON.stringify(event_json))
      }
    }
  }
}
