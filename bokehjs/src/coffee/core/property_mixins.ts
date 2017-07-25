import * as p from "./properties"
import {extend} from "./util/object"

const _gen_mixin = (mixin: any, prefix: string = "") => {
  const result: any = {}
  for (const name in mixin) {
    result[prefix + name] = mixin[name]
  }
  return result
}

const _line_mixin = {
  line_color:       [ p.ColorSpec,  'black'   ],
  line_width:       [ p.NumberSpec, 1         ],
  line_alpha:       [ p.NumberSpec, 1.0       ],
  line_join:        [ p.LineJoin,   'miter'   ],
  line_cap:         [ p.LineCap,    'butt'    ],
  line_dash:        [ p.Array,      []        ],
  line_dash_offset: [ p.Number,     0         ],
}

export const line = (prefix?: string) => _gen_mixin(_line_mixin, prefix)

const _fill_mixin = {
  fill_color: [ p.ColorSpec,  'gray' ],
  fill_alpha: [ p.NumberSpec, 1.0    ],
}

export const fill = (prefix?: string) => _gen_mixin(_fill_mixin, prefix)

const _text_mixin = {
  text_font:       [ p.Font,         'helvetica' ],
  text_font_size:  [ p.FontSizeSpec, '12pt'      ],
  text_font_style: [ p.FontStyle,    'normal'    ],
  text_color:      [ p.ColorSpec,    '#444444'   ],
  text_alpha:      [ p.NumberSpec,   1.0         ],
  text_align:      [ p.TextAlign,    'left'      ],
  text_baseline:   [ p.TextBaseline, 'bottom'    ],
}

export const text = (prefix?: string) => _gen_mixin(_text_mixin, prefix)

export const create = (configs: string[]): any => {
  let result: any = {}
  for (const config of configs) {
    const [kind, prefix] = config.split(":")
    if (this[kind] == null)
      throw new Error(`Unknown property mixin kind '${kind}'`)
    result = extend(result, this[kind](prefix))
  }
  return result
}
