// A book's highlights and notes, as pages (server/src/notes/typeset.ts).
//
// Everything this prints arrives as data (`sys.inputs.data`), already in the
// reader's language and already chosen and ordered by the app; the template
// only lays it out. Nothing a book or a note says is ever read as markup: a
// string shown as content is shown as it is.
//
// The document is a small book of its own. A title page - the cover (or the
// quill, when there is none) with a soft shadow, the title, the author, a
// fleuron, what the export holds and the colours its bars mean, and at the
// foot the harbour, printed faintly across the whole width. Then, for a long
// export by chapter, the contents. Then the passages: each highlight in the
// reading face with its colour as a bar down its starting edge, a note under
// it in italic, and a quiet line saying where in the book it came from and
// when; each chapter opened by a fleuron and its name. Paper is ink on a
// warm white; Night is the same page with the lamp off, dark to every edge.

#let d = json(bytes(sys.inputs.data))
#let night = d.look == "night"
#let phone = d.page == "phone"

/* ------------------------------------------------------------- palette */

#let paper = if night { rgb("#15120f") } else { rgb("#fbf8f2") }
#let ink = if night { rgb("#ebe3d5") } else { rgb("#211b16") }
#let soft = if night { rgb("#aaa093") } else { rgb("#6c6257") }
#let faint = if night { rgb("#7d7468") } else { rgb("#9d9386") }
#let rule = if night { rgb("#352d26") } else { rgb("#e3d9ca") }
#let accent = if night { rgb("#e69c74") } else { rgb("#a4471f") }
// The reader's own highlight hues, lifted on the dark page so each holds.
#let hues = if night {
  (amber: rgb("#d9a53c"), rose: rgb("#dc8157"), plum: rgb("#a38fd4"), sky: rgb("#7fabd6"), sand: rgb("#b9a78d"))
} else {
  (amber: rgb("#c28a1c"), rose: rgb("#b4532a"), plum: rgb("#5e4a8a"), sky: rgb("#3f6c98"), sand: rgb("#8a7457"))
}
#let art(name) = "/art/" + name + "-" + d.look + ".png"

/* ---------------------------------------------------------------- type */

#let scale = (compact: 0.9, comfortable: 1.0, large: 1.15).at(d.text)
#let sz(n) = n * scale * 1pt
// Han characters look different in Japanese, Chinese and Korean: the
// language asked for goes first, so its forms win.
#let cjk(lang) = if lang == "ja" {
  ("Noto Sans JP", "Noto Sans SC", "Noto Sans KR")
} else if lang == "ko" {
  ("Noto Sans KR", "Noto Sans JP", "Noto Sans SC")
} else {
  ("Noto Sans SC", "Noto Sans JP", "Noto Sans KR")
}
// Emoji last of all, in outline: a heart in a note prints as a heart, in ink.
#let serif(lang) = ("Literata", "Frank Ruhl Libre", "Noto Naskh Arabic") + cjk(lang) + ("Noto Emoji",)
#let display(lang) = ("Literata Display", "Frank Ruhl Libre", "Noto Naskh Arabic") + cjk(lang) + ("Noto Emoji",)
#let sans(lang) = ("Inter", "Noto Sans Hebrew", "Noto Sans Arabic") + cjk(lang) + ("Noto Emoji",)
#let ui = d.lang
#let bk = if d.bookLang != none { d.bookLang } else { d.lang }

/// Whether the interface's script has capitals to space out. Spacing Hebrew
/// splays it, spacing Arabic breaks its joins, and CJK has no case at all.
#let cased = ui not in ("he", "ar", "fa", "ur", "ja", "ko", "zh")

/// A label: small, spaced capitals in the interface face.
#let label(body, size: 7, fill: soft, tracking: 0.14em, weight: "medium") = text(
  font: sans(ui),
  lang: ui,
  size: sz(if cased { size } else { size * 1.12 }),
  fill: fill,
  tracking: if cased { tracking } else { 0em },
  weight: weight,
  upper(body),
)

/// A direction as the data spells it ("ltr" or "rtl"), as Typst's own value.
#let way(dir) = if dir == "rtl" { rtl } else { ltr }
/// A padding or a stroke on the edge a block written in `dir` starts from.
#let on-start(dir, value) = if dir == "rtl" { (right: value) } else { (left: value) }

/* ---------------------------------------------------------------- page */

#let dims = if d.page == "a4" {
  (width: 210mm, height: 297mm)
} else if d.page == "letter" {
  (width: 8.5in, height: 11in)
} else {
  (width: 105mm, height: 186mm)
}
// A book's measure, not a letter's: about seventy-five characters a line.
#let margin = if phone {
  (x: 9mm, top: 16mm, bottom: 15mm)
} else {
  (x: 31mm, top: 31mm, bottom: 28mm)
}

#set document(title: d.title + " \u{2014} " + d.labels.heading, author: if d.reader != none { d.reader } else { () })
#set page(width: dims.width, height: dims.height, fill: paper, margin: margin)
#set text(font: serif(ui), lang: ui, dir: way(d.dir), size: sz(if phone { 10.5 } else { 10.6 }), fill: ink)
#set par(leading: 0.7em, spacing: 0.9em)

/// The ReadPort mark, a bookmark with a play button cut out of it.
#let brand(fill, size) = box(baseline: 12%, image(
  bytes(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='"
      + fill.to-hex()
      + "' fill-rule='evenodd' d='M5.6 4.1 a2.3 2.3 0 0 1 2.3 -2.3 h8.2 a2.3 2.3 0 0 1 2.3 2.3 V22.2 L12 17.9 L5.6 22.2 Z M9.7 6.8 L15.7 10.775 L9.7 14.75 Z'/></svg>",
  ),
  format: "svg",
  width: size,
))

/// A soft shadow under a picture: rounded layers, each a little wider and a
/// little fainter, which is what a blur looks like from far enough away.
#let shadowed(body) = context {
  let size = measure(body)
  let layers = 12
  box(width: size.width, height: size.height, {
    for i in range(layers, 0, step: -1) {
      let grow = i * 0.8pt
      // Wider and lower as it spreads: light falls from above the page.
      place(dx: -grow, dy: -grow * 0.55 + 3pt, rect(
        width: size.width + 2 * grow,
        height: size.height + 2 * grow,
        radius: 2pt + grow,
        fill: black.transparentize(if night { 92% } else { 97.6% }),
        stroke: none,
      ))
    }
    place(box(radius: 2pt, clip: true, stroke: 0.5pt + (if night { rgb("#4a4037") } else { rgb("#d6ccbd") }), body))
  })
}

/* ---------------------------------------------------------- title page */

#let figures = if d.figures.len() == 0 { none } else {
  let cells = d.figures.map(f => stack(
    dir: ttb,
    spacing: sz(4),
    align(center, text(font: display(ui), size: sz(if phone { 14 } else { 20 }), fill: ink, f.n)),
    align(center, label(f.label, size: 6.3, fill: soft)),
  ))
  let parts = ()
  for (i, cell) in cells.enumerate() {
    if i > 0 { parts.push(line(angle: 90deg, length: sz(22), stroke: 0.5pt + rule)) }
    parts.push(cell)
  }
  stack(dir: if d.dir == "rtl" { rtl } else { ltr }, spacing: if phone { 5mm } else { 8mm }, ..parts.map(p => align(horizon, p)))
}

#let legend = if d.legend.len() == 0 { none } else {
  let items = d.legend.map(l => box(inset: (x: 2.5mm), stack(
    dir: if d.dir == "rtl" { rtl } else { ltr },
    spacing: 1.6mm,
    align(horizon, circle(radius: sz(2.6), fill: hues.at(l.color), stroke: none)),
    align(horizon, label(l.label, size: 6.2, fill: soft, tracking: 0.1em)),
  )))
  align(center, items.join(h(0.5mm)))
}

/// The title's size: a long title steps down rather than taking the page.
#let title-size = {
  let n = d.title.clusters().len()
  if phone {
    if n > 48 { 13 } else if n > 28 { 14.5 } else { 16.5 }
  } else {
    if n > 70 { 21 } else if n > 40 { 25 } else { 31 }
  }
}

/// Everything under the cover: the title, the author, a fleuron, and what
/// the export holds.
#let particulars = {
  set align(center)
  block(width: 88%)[
    #set par(leading: 0.42em, justify: false)
    #text(font: display(bk), lang: bk, dir: way(d.titleDir), size: sz(title-size), fill: ink, d.title)
  ]
  if d.author != none {
    v(if phone { 2.5mm } else { 4mm })
    block(text(font: display(bk), lang: bk, style: "italic", size: sz(if phone { 11 } else { 14 }), fill: soft, d.author))
  }
  v(if phone { 3.5mm } else { 8mm })
  image(art("fleuron"), width: if phone { 16mm } else { 27mm })
  v(if phone { 3.5mm } else { 8mm })
  figures
  if legend != none {
    v(if phone { 3mm } else { 6mm })
    legend
  }
  for line in d.scope {
    v(1.5mm)
    block(text(font: sans(ui), size: sz(7.4), fill: faint, line))
  }
}

#page(margin: if phone { (x: 9mm, top: 12mm, bottom: 10mm) } else { (x: 22mm, top: 20mm, bottom: 16mm) })[
  // The harbour, across the whole foot of the page, faint as a watermark.
  #place(bottom + center, dy: if phone { 10mm } else { 16mm }, image(art("harbour"), width: dims.width))
  #set align(center)
  #grid(
    rows: (auto, 1fr, auto),
    // The masthead.
    {
      stack(dir: ltr, spacing: 2.2mm, brand(accent, sz(9)), align(horizon, label(d.labels.app, size: 7, fill: soft, tracking: 0.2em)))
      v(if phone { 2.5mm } else { 3.5mm })
      label(d.labels.heading, size: if phone { 7.4 } else { 8 }, fill: accent, tracking: 0.26em, weight: "semibold")
    },
    // The book, as large as the room the rest of the page leaves it: a
    // long title, or a Letter page, takes it out of the cover, never out
    // of the words. Too little room for any cover at all, and there is none.
    layout(room => {
      let gap = if phone { 5mm } else { 11mm }
      let air = if phone { 5mm } else { 12mm }
      let widest = if d.cover { if phone { 31mm } else { 58mm } } else { if phone { 32mm } else { 54mm } }
      let picture(w) = if d.cover { image(d.coverPath, format: d.coverFormat, width: w) } else { image(art("quill"), width: w) }
      let rest = measure(block(width: room.width, particulars)).height
      let natural = measure(picture(widest)).height
      let spare = room.height - rest - gap - 2 * air
      let w = if natural <= spare { widest } else { widest * calc.max(spare / natural, 0) }
      let shown = if w < widest * 0.45 { none } else if d.cover { shadowed(picture(w)) } else { picture(w) }
      block(width: 100%, height: room.height, align(center + horizon, if shown == none { particulars } else {
        stack(dir: ttb, spacing: gap, shown, particulars)
      }))
    }),
    // Who marked it and when, above the harbour's rooftops and clear of
    // its lighthouse.
    {
      if d.labels.reader != none {
        block(text(font: serif(ui), style: "italic", size: sz(9.5), fill: soft, d.labels.reader))
        v(1.8mm, weak: true)
      }
      label(d.labels.stamp, size: 6.3, fill: faint, tracking: 0.12em)
      v(if phone { 25mm } else { 58mm })
    },
  )
]

/* ------------------------------------------------------------ contents */

#show heading.where(level: 1): it => it.body

#if d.contents {
  page(numbering: none, header: none, footer: none)[
    #v(if phone { 4mm } else { 12mm })
    #align(center)[
      #label(d.labels.contents, size: 8, fill: accent, tracking: 0.26em, weight: "semibold")
      #v(3mm)
      #image(art("fleuron"), width: if phone { 16mm } else { 20mm })
    ]
    #v(if phone { 6mm } else { 12mm })
    #show outline.entry: it => {
      set text(font: serif(bk), size: sz(10.5), fill: ink)
      block(above: sz(8), below: sz(8), link(it.element.location(), grid(
        columns: (auto, 1fr, auto),
        column-gutter: 2mm,
        align: (start + bottom, bottom, end + bottom),
        it.element.body,
        box(width: 1fr, repeat(text(fill: rule, size: sz(8))[.#h(2.4pt)])),
        text(font: serif(ui), size: sz(9.5), fill: soft, it.page()),
      )))
    }
    #outline(title: none, target: heading.where(level: 1), depth: 1)
  ]
}

/* --------------------------------------------------------------- pages */

/// The chapter the page is in: the first to begin on it, or the last one before it.
#let chapter-here() = {
  let n = here().page()
  let all = query(heading.where(level: 1))
  let on-page = all.filter(h => h.location().page() == n)
  if on-page.len() > 0 { return on-page.first().body }
  let before = all.filter(h => h.location().page() < n)
  if before.len() > 0 { before.last().body } else { none }
}

#set page(
  numbering: "1",
  header: context {
    set text(size: sz(7))
    let section = chapter-here()
    grid(
      columns: (1fr, auto),
      column-gutter: 6mm,
      align: (start + bottom, end + bottom),
      text(font: serif(bk), lang: bk, style: "italic", size: sz(8), fill: faint, d.title),
      if section != none { label(section, size: 6.2, fill: faint, tracking: 0.12em) },
    )
    v(-1.5mm)
    line(length: 100%, stroke: 0.4pt + rule)
  },
  footer: context align(center, text(font: serif(ui), size: sz(8), fill: faint, counter(page).display())),
)
#counter(page).update(1)

/// What opens a section: a chapter's fleuron and name, a colour, or a kind of mark.
#let opening(s) = {
  if s.kind == "chapter" {
    block(sticky: true, breakable: false, width: 100%, above: sz(34), below: sz(18))[
      #set align(center)
      #image(art("fleuron"), width: if phone { 15mm } else { 19mm })
      #v(sz(9))
      #block(width: 86%)[
        #set par(leading: 0.45em)
        #set text(font: display(bk), lang: bk, dir: way(s.dir), size: sz(if phone { 16 } else { 19.5 }), fill: ink)
        #heading(level: 1, s.head)
      ]
      #if s.count != none {
        v(sz(5))
        label(s.count, size: 6.2, fill: faint)
      }
    ]
  } else if s.kind == "color" or s.kind == "kind" {
    block(sticky: true, breakable: false, width: 100%, above: sz(30), below: sz(14))[
      #stack(
        dir: if d.dir == "rtl" { rtl } else { ltr },
        spacing: 2.4mm,
        if s.color != none { align(horizon, circle(radius: sz(3.4), fill: hues.at(s.color), stroke: none)) },
        align(horizon, heading(level: 1, label(s.head, size: 7.6, fill: ink, tracking: 0.2em, weight: "semibold"))),
        align(horizon, label(if s.count != none { s.count } else { "" }, size: 6.2, fill: faint)),
      )
      #v(sz(4))
      #line(length: 100%, stroke: 0.4pt + rule)
    ]
  }
}

#let bar = 2.2pt
#let gutter = if phone { 3.6mm } else { 5mm }

/// One mark. A highlight is its passage with its colour down the starting
/// edge; a note is the reader's words; a bookmark is a ribbon and a place.
#let mark(m) = {
  let hue = if m.color != none { hues.at(m.color) } else { faint }
  let lead = gutter + bar
  block(width: 100%, above: 0pt, below: sz(if phone { 13 } else { 16 }), breakable: true)[
    #if m.kind == "bookmark" {
      grid(
        columns: (auto, 1fr),
        column-gutter: 2.6mm,
        align: horizon,
        brand(accent, sz(10)),
        label(if m.where != none { m.where } else { d.labels.bookmark }, size: 6.6, fill: soft, tracking: 0.1em),
      )
      if m.note != none {
        v(sz(4))
        pad(..on-start(d.dir, sz(10) + 2.6mm), text(font: serif(ui), style: "italic", size: sz(9.8), fill: soft, dir: way(m.noteDir), m.note))
      }
    } else {
      if m.text != none {
        block(width: 100%, inset: on-start(m.dir, gutter), stroke: on-start(m.dir, bar + hue))[
          #set text(font: serif(bk), lang: bk, dir: way(m.dir), size: sz(if phone { 11 } else { 11.7 }), hyphenate: true)
          // Justified on a book's measure; ragged on a phone's, where a
          // justified line of six words opens rivers between them.
          #set par(justify: not phone, leading: 0.72em)
          #m.text
        ]
      }
      if m.note != none {
        let only = m.text == none
        block(width: 100%, above: if only { 0pt } else { sz(10) }, inset: on-start(m.noteDir, if only { gutter } else { lead }), stroke: if only { on-start(m.noteDir, (thickness: bar, paint: faint, dash: "dotted")) } else { none })[
          #label(d.labels.note, size: 5.8, fill: accent, tracking: 0.2em, weight: "semibold")
          #v(sz(1.5))
          #set text(font: serif(ui), lang: ui, dir: way(m.noteDir), size: sz(if only { 10.8 } else { 10 }), fill: if only { ink } else { soft }, style: if only { "normal" } else { "italic" })
          #set par(justify: false, leading: 0.68em)
          #m.note
        ]
      }
      if m.text == none and m.note == none {
        pad(..on-start(d.dir, lead), text(style: "italic", fill: soft, d.labels.marked))
      }
      if m.where != none {
        v(sz(5.5))
        pad(..on-start(d.dir, lead), label(m.where, size: 6.1, fill: faint, tracking: 0.1em))
      }
    }
  ]
}

#if d.sections.len() == 0 {
  align(center + horizon, text(style: "italic", fill: soft, d.labels.empty))
}
#for (i, s) in d.sections.enumerate() {
  if s.kind != none and s.head != none { opening(s) } else if i == 0 { v(sz(6)) }
  for m in s.marks { mark(m) }
}

// The last word: a fleuron, where the book came from, and when.
#block(breakable: false, width: 100%, above: sz(30))[
  #set align(center)
  #image(art("fleuron"), width: if phone { 13mm } else { 16mm })
  #v(sz(6))
  #text(font: serif(ui), style: "italic", size: sz(9.2), fill: soft, d.labels.closing)
  #v(sz(2.5))
  #label(d.labels.stamp, size: 6, fill: faint, tracking: 0.12em)
]
