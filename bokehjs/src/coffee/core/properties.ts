import {Constructor} from "./common"
import {HasProps} from "./has_props"
import {Signal, Signalable} from "./signaling"
import * as enums from "./enums"
import * as svg_colors from "./util/svg_colors"
import {valid_rgb} from "./util/color"
import {copy, contains} from "./util/array"
import {isBoolean, isNumber, isString, isFunction, isArray, isObject} from "./util/types"

const valueToString = (value: any): string => {
  try {
    return JSON.stringify(value)
  } catch (error) {
    return value.toString()
  }
}

//
// Property base class
//

export /*abstract*/ class Property<T> extends Signalable(Object) {
  //this.prototype extends Signalable

  readonly name: string

  spec: any /*{value?: T, field?: string, units?: any, transform?: any}*/

  readonly change = new Signal<T, HasProps>(this.obj, "change")


  constructor(readonly obj: HasProps, readonly attr: string, readonly default_value: T) {
    super()
    this._init()
    this.connect(this.change, () => this._init())
  }

  update(): void {
    this._init()
  }

  // ----- customizable policies

  init(): void {}

  /*abstract*/ validate(_value: T): void {} // XXX

  transform(values: T[]): T[] {
    return values
  }

  // ----- property accessors

  value(do_spec_transform: boolean = true) {
    if (this.spec.value === undefined)
      throw new Error("attempted to retrieve property value for property without value specification")
    let ret = this.transform([this.spec.value])[0]
    if (this.spec.transform != null && do_spec_transform)
      ret = this.spec.transform.compute(ret)
    return ret
  }

  _init(): void {
    const obj = this.obj

    /*
    // instanceof was failing! circular import?
    if not obj.properties?
      throw new Error("property object must be a HasProps")
    */

    const attr = this.attr

    let attr_value: any = obj.getv(attr)

    if (attr_value === undefined) {
      const default_value = this.default_value

      if (default_value == undefined)
        attr_value = null
      else if (isArray(default_value))
        attr_value = copy(default_value)
      else if (isFunction(default_value))
        attr_value = default_value(obj)
      else
        attr_value = default_value

      obj.setv([attr, attr_value], {silent: true, defaults: true})
    }

    if (isArray(attr_value))
      this.spec = {value: attr_value}
    else if (isObject(attr_value) && ((attr_value.value === undefined) != (attr_value.field === undefined)))
      this.spec = attr_value
    else
      this.spec = {value: attr_value}

    if (this.spec.field != null && !isString(this.spec.field))
      throw new Error(`field value for property '${attr}' is not a string`)

    if (this.spec.value != null)
      this.validate(this.spec.value)

    this.init()
  }

  toString(): string {
    return `${this.name}(${this.obj}.${this.attr}, spec: ${valueToString(this.spec)})`
  }
}

export const Dataspec = <T, C extends Constructor<Property<T>>>(Base: C) => {
  return class extends Base {
    array(source: any /*DataSource*/) {
      const data = source.data
      let ret: any
      if (this.spec.field != null) {
        if (this.spec.field in data)
          ret = this.transform(source.get_column(this.spec.field))
        else
          throw new Error(`attempted to retrieve property array for nonexistent field '${this.spec.field}'`)
      } else {
        let length = source.get_length()
        if (length == null)
          length = 1
        const value = this.value(false) // don't apply any spec transform
        ret = []
        for (let i = 0; i < length; i++) {
          ret.push(value)
        }
      }

      if (this.spec.transform != null)
        ret = this.spec.transform.v_compute(ret)
      return ret
    }
  }
}

//
// Simple Properties
//

export const simple_prop = <T>(name: string, pred: (x: any) => boolean) => {
  return class Prop extends Property<T> {
    name = name
    validate(value: any) {
      if (!pred(value))
        throw new Error(`${name} property '${this.attr}' given invalid value: ${valueToString(value)}`)
    }
  }
}

export class Any extends simple_prop("Any", (_) => true) {}

export class Array extends simple_prop("Array", (x) => isArray(x) || x instanceof Float64Array) {}

export class Bool extends simple_prop("Bool", isBoolean) {}
//export Boolean = Bool

export class Color extends simple_prop("Color", (x) =>
  (svg_colors as any)[x.toLowerCase()] != null || x.substring(0, 1) === "#" || valid_rgb(x)
) {}

export class Instance extends simple_prop("Instance", (x) => x.properties != null) {}

// TODO (bev) separate booleans?
export class Number extends simple_prop("Number", (x) => isNumber(x) || isBoolean(x)) {}
//export Int = Number

// TODO extend Number instead of copying it's predicate
//class Percent extends Number("Percent", (x) -> 0 <= x <= 1.0)
export class Percent extends simple_prop("Number", (x) => (isNumber(x) || isBoolean(x)) && (0 <= x && x <= 1.0)) {}

export class String extends simple_prop("String", isString) {}

// TODO (bev) don't think this exists python side
export class Font extends String {}

//
// Enum properties
//

export const Enum = <T>(name: string, enum_values: T[]) => {
  return simple_prop(name, (x) => contains(enum_values, x))
}

export class Anchor extends Enum("Anchor", enums.LegendLocation) {}

export class AngleUnits extends Enum("AngleUnits", enums.AngleUnits) {}

export class Direction extends Enum("Direction", enums.Direction) {
  /*
  transform(values) {
    const result = new Uint8Array(values.length)
    for (let i = 0; i < values.length; i++) {
      if (values[i] === 'clock')
        result[i] = false
      else
        result[i] = true
    }
    return result
  }
  */
}

export class Dimension extends Enum("Dimension", enums.Dimension) {}

export class Dimensions extends Enum("Dimensions", enums.Dimensions) {}

export class FontStyle extends Enum("FontStyle", enums.FontStyle) {}

export class LatLon extends Enum("LatLon", enums.LatLon) {}

export class LineCap extends Enum("LineCap", enums.LineCap) {}

export class LineJoin extends Enum("LineJoin", enums.LineJoin) {}

export class LegendLocation extends Enum("LegendLocation", enums.LegendLocation) {}

export class Location extends Enum("Location", enums.Location) {}

export class OutputBackend extends Enum("OutputBackend", enums.OutputBackend) {}

export class Orientation extends Enum("Orientation", enums.Orientation) {}

export class TextAlign extends Enum("TextAlign", enums.TextAlign) {}

export class TextBaseline extends Enum("TextBaseline", enums.TextBaseline) {}

export class RenderLevel extends Enum("RenderLevel", enums.RenderLevel) {}

export class RenderMode extends Enum("RenderMode", enums.RenderMode) {}

export class SizingMode extends Enum("SizingMode", enums.SizingMode) {}

export class SpatialUnits extends Enum("SpatialUnits", enums.SpatialUnits) {}

export class Distribution extends Enum("Distribution", enums.DistributionTypes) {}

export class TransformStepMode extends Enum("TransformStepMode", enums.TransformStepModes) {}

export class PaddingUnits extends Enum("PaddingUnits", enums.PaddingUnits) {}

export class StartEnd extends Enum("StartEnd", enums.StartEnd) {}

//
// Units Properties
//
export const units_prop = <U>(name: string, valid_units: U[], default_units: U) => {
  return class extends Number {
    name = name
    init() {
      if (this.spec.units == null)
        this.spec.units = default_units

      const units = this.spec.units
      if (!contains(valid_units, units))
        throw new Error(`${name} units must be one of ${valid_units}, given invalid value: ${units}`)
    }
  }
}

export class Angle extends units_prop("Angle", enums.AngleUnits, "rad") {
  /*
  transform(values) {
    if (this.spec.units === "deg")
      values = (x * Math.PI/180.0 for x in values)
    values = (-x for x in values)
    return super(values)
  }
  */
}

export class Distance extends units_prop("Distance", enums.SpatialUnits, "data") {}

//
// DataSpec properties
//

export class AngleSpec extends Dataspec(Angle) {}

export class ColorSpec extends Dataspec(Color) {}

export class DirectionSpec extends Dataspec(Distance) {}

export class DistanceSpec extends Dataspec(Distance) {}

export class FontSizeSpec extends Dataspec(String) {}

export class NumberSpec extends Dataspec(Number) {}

export class StringSpec extends Dataspec(String) {}
