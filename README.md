# pt — path-traversal payload generator

`pt` builds path-traversal / LFI wordlists for Caido, Burp Intruder, ffuf or
anything else that reads a file top to bottom.

It separates two questions that most wordlists tangle together:

| | decides | comes from |
| --- | --- | --- |
| **Slots** | *which path* you are asking for | an ordered list of named positions, each with its own files |
| **Strategies** | *how that path is spelled on the wire* | an ordered union of named rewrites |

**No strategy ever reads a file.** A strategy is a rewrite applied after
assembly. If you want a new file to reach for, add a line to the target slot's
file — or let `pt add` do it. If you want a new way to smuggle it past a filter,
add a strategy.

```
pt --generate-basic-config ./pt.yml   # starter config + seeded ./templates
pt --config ./pt.yml --dry-run        # what each strategy and each input LINE earns
pt --config ./pt.yml                  # write the wordlist
pt add --config ./pt.yml --slot traversal --value '..%c0%af'
pt --version    pt --help
```

## Install

```bash
npm i -g 0xspryon/pt
```

```sh
pt --version
```

`0xspryon/pt` is a GitHub shorthand, and GitHub 301-redirects it to
`0xspryon/path-traversal`, which npm follows. If you would rather not rely on that
redirect, the explicit form is the same install:

```bash
npm i -g 0xspryon/path-traversal
```

> **On the npm registry name.** The registry name `pt` is squatted (published at
> `0.0.0`), so the package's `name` field is **`pathtraversal`** while the
> installed **binary is `pt`**. Installing from GitHub sidesteps the question
> entirely. To publish to the registry under a name you control, change `name` in
> `package.json` (e.g. `@you/pt`); nothing else needs to change, because `bin`
> already maps `pt` to `dist/pt.js`.

`dist/pt.js` is a single self-contained bundle with a `#!/usr/bin/env node`
shebang, so installing pulls no runtime dependencies and Bun is needed only to
*build* it.

---

## The workflow: recon the stack, then build the template

This is the idea the whole tool is shaped around, and it is worth stating before
any of the schema:

> Once you have understood the stack of the app from the devops infra to the tech
> stack, you can construct a template suited to the target and then properly
> attack it.

`pt` is **not** a fire-a-giant-wordlist tool. Three steps, in order:

```
recon the stack  ->  assemble a template matching it  ->  generate a focused list
```

Skipping the first step gets you 300,000 requests for files the target does not
have, which is how you get rate-limited, blocked, or simply lose the signal in the
response distribution. Doing it first gets you a few thousand that are all
plausible.

So `./templates` is split by **stack dimension**, and that split is the interface
for the choice:

```
templates/
  windows/     win.ini, boot.ini, C:\ paths, UNC, registry hives, IIS/inetpub,
               backslash traversal primitives, Win32 prefixes and suffixes
  macos/       /System, /Library, /Users, /private, .DS_Store, keychains,
               launchd plists, the Homebrew prefix
  linux/       /etc/*, /proc/*, /var/log, /root, /home, shells, SSH, POSIX
               traversal primitives
  language/    one file per runtime -- target-php, target-java, target-dotnet,
               target-python, target-node, target-ruby, target-perl -- plus the
               runtime-level suffixes and the ';' servlet traversal primitive
  devops/      nginx, apache, tomcat, kubernetes, docker, terraform, CI/CD,
               cloud and agent credentials, vault, systemd, document roots

  target-core.txt  target-hot.txt  target-encoded.txt  target-padding.txt
  traversal-core.txt  traversal-min.txt  empty.txt
               cross-category sizing files, which is why they are not in a folder
```

Each folder carries only the slot dimensions that genuinely differ for it. Every
folder has a target file; only `windows/` and `linux/` have a `traversal.txt`,
because separator identity is the only dimension a traversal primitive differs in;
`devops/` has no traversal at all.

Two rules put every path in exactly one folder, so the five are a partition and
nothing is duplicated:

1. **An OS-rooted path beats a stack marker.** `C:\xampp\php\php.ini` is in
   `windows/`, not `language/`, because the path only resolves on Windows.
   `/Volumes/Macintosh_HD1/usr/local/php/lib/php.ini` is `macos/` for the same
   reason. Recon establishes the OS before the runtime, and the OS is the half
   that makes a path syntactically impossible anywhere else.
2. **Otherwise the most specific stack component wins**, where specific means
   runtime, then infrastructure, then distro. `/etc/php/8.3/cli/php.ini` is PHP,
   `/etc/nginx/nginx.conf` is nginx, and `/etc/passwd` is just Linux.

Rule 2 is why `linux/target.txt` is deliberately the **residue**: it holds
`/etc/passwd`, not `/etc/nginx/nginx.conf`. If you want nginx's config you read
`devops/`, on every OS. The classifier is `scripts/categorize.ts` and the harvest
runs it over all 15,913 target lines, so the split is a measurement rather than an
opinion.

Choosing folders is ordinary slot editing, because files in one slot are
**unioned**:

```yml
slots:
  - name: target
    files:
      - ./templates/linux/target.txt
      - ./templates/language/target-php.txt
      - ./templates/devops/target.txt
```

Delete a line and the wordlist loses exactly that category; add one and it gains
exactly that category. Adding a category as a per-strategy override instead is
cheaper, because it does not multiply the rest of the matrix:

```yml
- "plain | target=./templates/windows/target.txt, traversal=./templates/windows/traversal.txt"
```

**`pt --generate-basic-config` scaffolds all five folders and reads three of
them** — `linux`, `language` and `devops`, the common stack. `windows` and `macos`
are written next to them and left out of the config, with the switch spelled out
in the config's own comments, because which folders you read is exactly the
decision recon makes for you.

[**skills/path-traversal/SKILL.md**](./skills/path-traversal/SKILL.md) is the
whole workflow written for an agent: what to fingerprint, which folder each answer
picks, how to order strategies as hypotheses, how to read `--dry-run`, and three
worked targets (PHP/nginx/Linux, Java/Tomcat, containerised).

> Authorised testing, CTFs and security research only.

---

## Quick start

```sh
pt --generate-basic-config ./pt.yml
pt --config ./pt.yml --dry-run
```

```
strategies -- what each hypothesis is worth
  strategy                              payloads         new    unique
  --------------------------------------------------------------------
  raw_file (verbatim)                          1        (+1)         1  ·
  plain                                   19,425   (+19,425)    18,785  ████████████████████████████████
  dot_noise                               19,425   (+18,785)    18,785  ████████████████████████████████
  url_encode:1                            19,425   (+15,225)    15,225  █████████████████████████▉
  url_encode:1 > hex_case_upper           19,425   (+15,225)    15,225  █████████████████████████▉
  url_encode:2                            19,425   (+15,225)    15,225  █████████████████████████▉
  overlong_utf8                           19,425   (+16,685)    16,685  ████████████████████████████▍
  fullwidth                               19,425   (+17,325)    17,325  █████████████████████████████▌
  selective_last                          19,425   (+18,785)    18,785  ████████████████████████████████
  base64                                  19,425   (+19,425)    12,945  ██████████████████████
  base64 > url_encode:1(charset="+/=")    19,425   (+12,945)    12,945  ██████████████████████
  total unique                           169,051

inputs -- what each line of each slot file is worth
  file:line                  value              payloads    unique
  ------------------------------------------------------------------
  devops/target.txt:17       /.env                 4,645     4,645  ██▋
  language/target-php.txt:7  /wp-config.php        4,645     4,645  ██▋
  linux/traversal.txt:20     ../                  20,140     9,800  █████▌
  linux/traversal.txt:21     ..%2f                13,520    13,520  ███████▋
  language/suffix.txt:20     %00.png              33,810    33,810  ███████████████████
  linux/prefix.txt:6         /var/www/html/       57,120    57,120  ████████████████████████████████
  ... and 34 more lines that earn at least as much

raw ratio  0.0006%  -- 1 verbatim entry against 169,050 generated payloads
```

The `file:line` column carries the stack category, because the split means
`target.txt` on its own no longer identifies a file.

Then delete what is not earning its keep — strategies *and* input lines — and run
it for real. Bars and colour appear only on a terminal; piped, the same numbers
come out as plain aligned text. The report goes to **stderr**; the wordlist is the
only thing that touches `output_file`.

---

## Why strategies are a union and not a product

This is the central design decision, and it is worth being explicit about.

Each technique is a **hypothesis** about where the filter sits and what it does:

| strategy | hypothesis |
| --- | --- |
| `url_encode:1` | the filter checks the value before exactly one decode |
| `url_encode:2` | two decodes happen after the check |
| `overlong_utf8` | the filter's UTF-8 decoder is strict, a downstream one is lax |
| `dot_noise` | the filter pattern-matches sequences a normalizer later collapses |
| `base64` | the app base64-decodes the parameter before using it as a path |

These are **mutually exclusive explanations of one unknown**. Cross-producting
them yields payloads that only work if several independent unlikely things are
true at the same time — strictly less probable than either hypothesis alone. If
plain `/etc/./passwd` beats the filter, double-encoding it tests a conjunction
nobody needs.

The arithmetic is just as decisive. Cross-producting the techniques in this
catalog gives `4 × 2 × 2 × 2 × 2 × 3 × 4 = 1,536` combinations — about 19.2M
payloads. A union of ten named strategies gives ten — about 186k. Same technique
coverage, 100× smaller, and **linear** growth: an eleventh technique costs one
line, not a doubling.

So `strategies:` is an **ordered union**. Order is priority, because a fuzzer
fires top-down: put the likely ones first. Composition is available through `>`
when you genuinely want it, but it is never automatic.

---

## Config file

Every relative path resolves against **the directory the config file lives in**,
so a config plus its `templates/` directory is portable and
`pt --config /somewhere/else/pt.yml` behaves the way you expect.

### Top-level keys

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `slots` | list of slots | **required** | The ordered positions a payload is built from. See below. |
| `output_file` | path | **required** | Where the wordlist goes. Parent directories are created. |
| `raw_file` | list of paths | `[]` | Payloads emitted **verbatim** — never decomposed, rewritten or repeat-multiplied. |
| `strategies` | list of strings | `[plain]` | The ordered union. Always scalar strings. |
| `url_encode_charset` | string | `./\` | Default for `url_encode` stages that set no `charset=` of their own. |
| `overwrite_output_file` | bool | `false` | When `false` and the output exists, `pt` refuses to run. |
| `limits.warn_above` | int ≥ 0 | — | Print the contribution report and a warning past this many payloads. |
| `limits.max_payloads` | int ≥ 1 | — | Hard stop with a clear message; nothing is written. |

### Slots

A payload is **one member of each slot, in slot order, concatenated**. Slots are
yours to name, order and extend.

```yml
slots:
  - name: prefix
    files: [./templates/linux/prefix.txt]
    optional: true
  - name: traversal
    files: [./templates/linux/traversal.txt]
    optional: true
    repeat: [3, 6, 10, 16]
  - name: target
    files:
      - ./templates/linux/target.txt
      - ./templates/language/target-php.txt
      - ./templates/devops/target.txt
    strip_leading_separator: when_same_separator
  - name: suffix
    files: [./templates/language/suffix.txt]
    optional: true
    transform: false
```

| Slot property | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | **required** | Lowercase, digits and `_`, starting with a letter. Unique. `synthetic` is reserved. |
| `files` | path or list | `[]` | UNIONed, not cross-producted. A required slot must name at least one. |
| `optional` | bool | `false` | Give this slot an **empty member**, so payloads without it are generated too. |
| `repeat` | list of ints ≥ 1 | `[1]` | Repeat this slot's text that many times, one payload per rung. |
| `transform` | bool | `true` | `false` means no strategy may rewrite these bytes. Per **segment**, not per payload. |
| `strip_leading_separator` | `never` \| `when_same_separator` \| `when_preceded` | `when_same_separator` | See below. |

At least one slot must be **required** (no `optional: true`), because a config in
which every slot can be empty guarantees nothing. That required slot is also where
`trailing_dot` and `trailing_space` land — see *the anchor slot* below.

Things this expresses that a fixed `prefix × traversal × target × suffix` model
cannot:

```yml
slots:
  # two traversal positions: '../' x 3 then '..\' x 2, for a stack that
  # normalises one separator and not the other
  - { name: traversal_posix, files: [./posix.txt],  optional: true, repeat: [3] }
  - { name: traversal_win32, files: [./win32.txt],  optional: true, repeat: [2] }
  - { name: target,          files: [./target.txt] }
  # a slot BETWEEN target and suffix, for extension games
  - { name: extension,       files: [./ext.txt],    optional: true }
  - { name: suffix,          files: [./suffix.txt], optional: true, transform: false }
```

### Input file syntax

* Lines are trimmed; blank lines are dropped.
* A line is a **comment** when it starts with `#` followed by whitespace, by
  another `#`, or by nothing: `# note`, `## banner`, `#`.
* `#` followed by anything else is a payload. That matters: `#.png` is a real
  suffix (it truncates the URL at a fragment), and a naive "starts with `#`" rule
  would silently eat it.
* A leading **`!`** flips that one line's `transform`. In a `transform: true`
  slot, `!/etc/pre%2fencoded` stays literal; in a `transform: false` slot,
  `!?.png` is rewritten. `!!` is a literal leading `!`.

### Strategy entries

Every entry is a **scalar string**. Two pieces of syntax ride inside it:

```yml
strategies:
  - plain
  - url_encode:1 > hex_case_upper
  - 'base64 > url_encode:1(charset="+/=")'                   # per-STAGE argument
  - "plain | target=./templates/windows/target.txt, traversal=" # per-slot overrides
  - "padding:2048 | target=./templates/target-padding.txt, traversal.repeat=3"
```

**Stage arguments** go in `(...)` after the stage: `charset="..."` on any
`url_encode`, and the bare flag `+dots` on `overlong_utf8`. Charset is per *stage*,
which is what makes `url_encode:1(charset="./\\") > base64 >
url_encode:1(charset="+/=")` expressible at all.

**Slot overrides** follow a `|` and are comma-separated:

| Override | Effect |
| --- | --- |
| `<slot>=<path>` | Use this file for that slot, for this strategy only. Repeat the slot name to union several files. |
| `<slot>=` (nothing after it) | Turn that slot off. Legal only for an `optional` slot. |
| `<slot>.repeat=3 6` | Repeat ladder for that slot, for this strategy only. |

Overrides exist so an expensive strategy need not inherit the whole matrix.
`padding:2048` multiplies the length of every payload it touches, so it is worth
running against three targets at one rung, not twenty-four targets at four.

Pipeline syntax is `stage > stage > stage`. Whitespace around `>` is optional, and
reports always print the canonical spaced form.

### Migrating from pt v1

v1's config is rejected with a sentence naming the replacement for every removed
key:

| v1 | v2 |
| --- | --- |
| `prefix_file` / `traversal_file` / `target_file` / `suffix_file` | one `slots:` entry each, in order |
| `traversal_depth: [3, 6]` | `repeat: [3, 6]` on the slot that repeats — any slot can now |
| `include_payloads_without_{prefix,traversal,suffix}` | `optional: true` on that slot |
| `do_not_transform: [./x.txt]` | `transform: false` on the slot, or `!` on one line |
| `{ pipeline: p, charset: c }` | `"p(charset=\"c\")"` |
| `{ pipeline: p, targets: f }` | `"p \| target=f"` |
| `{ pipeline: p, depths: [3] }` | `"p \| <slot>.repeat=3"` |
| `noise:dot` / `noise:double_slash` / `noise:backtrack` / `noise:matrix_param` | `dot_noise` / `double_slash` / `backtrack` / `matrix_param` |
| `selective:first` / `:last` / `:alternating` | `selective_first` / `selective_last` / `selective_alternating` |
| `hex_case:upper` / `:lower` | `hex_case_upper` / `hex_case_lower` |
| `path_case:upper` | `path_case_upper` |
| `url_encode:1` / `:2` / `:3`, `padding:N` | unchanged — those genuinely are intensities |

---

## Strategy catalog

Every name below is validated at config load. A typo fails with the full list and
each stage's signature.

**`:` always means intensity.** `url_encode:1|2|3` and `padding:N` are one
technique turned up or down. Everything that is a genuinely different technique has
its own name, so two catalog entries look like siblings exactly when they are.

### Identity

| Strategy | Rewrites | Hypothesis |
| --- | --- | --- |
| `plain` | nothing | the path is not filtered at all |

Always put `plain` first. It is the single most likely thing to work, and it
costs one block.

### Percent-encoding

Acts on the characters in the charset (default `./\`, per stage via
`(charset="…")`).

| Strategy | `../../../etc/passwd` becomes | Hypothesis |
| --- | --- | --- |
| `url_encode:1` | `%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd` | the filter checks before one decode |
| `url_encode:2` | `%252e%252e%252f…` | two decodes happen after the check |
| `url_encode:3` | `%25252e…` | layered gateways; rare |
| `hex_case_upper` | `%2E%2E%2F…` | the blocklist matches lowercase escapes only |
| `hex_case_lower` | `%2e%2e%2f…` | …or uppercase only |

Pass 1 percent-encodes each charset member; every later pass turns `%` into
`%25`. A charset that differs from `url_encode_charset` becomes part of the
stage's name, so a report never prints two different `url_encode:1` entries as if
they were the same hypothesis.

`hex_case_*` only rewrites escapes an earlier stage produced, so on its own it
does nothing — and that is a config error, not a silent no-op. It is rejected by
the stage signature, not by a special case:

```yml
- hex_case_upper                   # error: needs 'escapes', the payload produced 'path'
- url_encode:1 > hex_case_upper    # correct
```

### Separator respellings

| Strategy | Mapping | Hypothesis |
| --- | --- | --- |
| `overlong_utf8` | `/`→`%c0%af`, `\`→`%c1%9c` | strict filter decoder, lax downstream decoder |
| `overlong_utf8(+dots)` | additionally `.`→`%c0%ae` | so even `..` never appears on the wire |
| `fullwidth` | `/`→`%ef%bc%8f`, `\`→`%ef%bc%bc`, `.`→`%ef%bc%8e` | NFKC folds it back to `/` after the check |
| `utf16_escape` | `/`→`%u2215`, `\`→`%u005c` | the server resolves the non-standard `%uXXXX` form the filter has no rule for |
| `utf16_escape(codepoint="2044")` | `/`→`%u2044` | the same bet on U+2044 FRACTION SLASH instead of U+2215 DIVISION SLASH |
| `double_percent` | `/`→`%%32%66`, `\`→`%%35%63` | two decodes happen after the check, and `%25` never reaches the wire |

```
overlong_utf8          ..%c0%af..%c0%af..%c0%afetc%c0%afpasswd
overlong_utf8(+dots)   %c0%ae%c0%ae%c0%af…etc%c0%afpasswd
fullwidth              %ef%bc%8e%ef%bc%8e%ef%bc%8f…etc%ef%bc%8fpasswd
utf16_escape           ..%u2215..%u2215..%u2215etc%u2215passwd
double_percent         ..%%32%66..%%32%66..%%32%66etc%%32%66passwd
```

`utf16_escape` spells `/` as a **lookalike** codepoint rather than as `/` itself:
a stack that resolves `%uXXXX` at all tends to fold U+2215 and U+2044 onto the
ASCII character, while a filter that only knows `%XY` has no rule for the sequence
whatsoever. The codepoint is an *argument* and not a second catalog entry because
it is the same hypothesis at a different codepoint — and because it names the
stage, a report cannot print two of them as though they were one. `\` has no
lookalike worth the trouble, so it is spelled `%u005c`.

`double_percent` is a double encoding with **no `%25` in it**. It keeps a literal
`%` and percent-encodes the *hex digits* instead: `%32` is `2` and `%66` is `f`, so
one decode of `%%32%66` is the literal text `%2f` and a second is `/`. A filter
watching for `%25` — the obvious signature of double encoding — sees nothing.

### Structural noise

Inserts fixed characters. The path still resolves to the same place.

| Strategy | `/` becomes | `../../../etc/passwd` becomes | Hypothesis |
| --- | --- | --- | --- |
| `dot_noise` | `/./` | `.././.././.././etc/./passwd` | the filter matches sequences a normalizer collapses |
| `double_slash` | `//` | `..//..//..//etc//passwd` | the filter counts separators |
| `backtrack` | `/zz/../` | `../zz/../../zz/../../zz/../etc/zz/../passwd` | a decoy directory breaks a pattern |
| `matrix_param` | `;a=b/` | `..;a=b/..;a=b/..;a=b/etc;a=b/passwd` | Tomcat strips matrix parameters after the check |

### Positional encoding

Percent-encodes only *some* separators. These are **payload-positional**:
`first` means the first separator in the whole payload, not the first in each
segment.

| Strategy | `../../../etc/passwd` becomes |
| --- | --- |
| `selective_first` | `..%2f../../etc/passwd` |
| `selective_last` | `../../../etc%2fpasswd` |
| `selective_alternating` | `..%2f../..%2fetc/passwd` |

Hypothesis: the stack decodes once and then checks, so exactly one surviving
escape slips through. Separators inside a protected segment are invisible to both
the index and the rewrite.

### Block

| Strategy | Effect | Hypothesis |
| --- | --- | --- |
| `base64` | `Li4vLi4vLi4vZXRjL3Bhc3N3ZA==` | the app base64-decodes the parameter |

base64 encodes each **maximal contiguous run** of rewritable segments as a single
blob, with protected segments as run boundaries — so you get `literal prefix +
base64(traversal + target) + literal suffix`.

### Length and platform

| Strategy | Effect | Hypothesis |
| --- | --- | --- |
| `path_case_upper` | `../../../ETC/PASSWD` | case-insensitive filesystem, case-sensitive filter |
| `padding:N` | prepends `./` × N | a path-length limit truncates an extension the app appends |
| `trailing_dot` | appends `.` to the **anchor slot** | Win32 strips a trailing `.` from the resolved name |
| `trailing_space` | appends ` ` to the anchor slot | Win32 strips a trailing space |

`trailing_dot` lands on the target, not at the end of the payload:
`../../../etc/passwd.%00.png`, not `…%00.png.`. A protected anchor is left alone,
because `transform: false` means untouched and appending is a modification.
`padding:N` is the one stage that *adds* material rather than rewriting it, so it
applies even to a fully protected payload.

### Stage signatures

Every stage declares what it consumes and what it leaves behind, and the parser
type-checks the whole pipeline against those signatures. The payload starts life
as a `path`.

| kind | meaning |
| --- | --- |
| `path` | real filesystem syntax: literal `/` and `\` a stage can find, count and respell |
| `escapes` | text carrying `%XY` escapes — the only thing `hex_case_*` has anything to do |
| `opaque` | a blob with no path structure left; what `base64` produces |
| `text` | anything at all. `path`, `escapes` and `opaque` are all `text`; nothing else subsumes anything |

```
url_encode:N      text    -> escapes
hex_case_*        escapes -> escapes
overlong_utf8     path    -> escapes
fullwidth         path    -> escapes          (and utf16_escape, double_percent)
selective_*       path    -> escapes
dot_noise         path    -> path          (and double_slash, backtrack, matrix_param)
path_case_upper   path    -> path
base64            text    -> opaque
padding:N         any     -> same          (and trailing_dot, trailing_space)
```

One rule, and it catches a whole class:

```
hex_case_upper             escapes required, got path      rejected
base64 > dot_noise         path required, got opaque       rejected
base64 > overlong_utf8     path required, got opaque       rejected
base64 > utf16_escape      path required, got opaque       rejected
base64 > double_percent    path required, got opaque       rejected
base64 > path_case_upper   path required, got opaque       rejected
base64 > url_encode:1      text accepts opaque             allowed
```

`base64 > dot_noise` inserting `/./` into a base64 blob is meaningless. pt v1
parsed and ran it happily; the signatures are what noticed. Two stages added after
the rule landed were rejected in the same compositions on the day they were
written, with no new code: a signature is a declaration, not a check.

---

## How payloads are built

### Assembly

```
slot[0] + slot[1] × repeat + slot[2] + …
```

A payload is carried through the pipeline as an **array of segments**, each tagged
with its slot name, with whether it may be rewritten, and with its provenance
(the file and line it was read from), and joined into a string only at the very
end. Flattening early would make it impossible to tell which bytes came from
where.

### `strip_leading_separator`

The strip exists for exactly one reason: to avoid emitting a **doubled
separator**. Two separators are only doubled if they spell the **same** separator,
and `/` and `\` do not.

```
../     + /etc/passwd   ->  ../../../etc/passwd       same sep      -> strip
..%2f   + /etc/passwd   ->  ..%2f..%2fetc/passwd      same sep      -> strip
..\     + /etc/passwd   ->  ..\..\..\/etc/passwd      DIFFERENT     -> keep
(none)  + /etc/passwd   ->  /etc/passwd               nothing       -> keep
```

Equivalence is decode-aware, so the encoded spellings collapse onto their literal
while the two separator identities stay apart:

```
"/"  ==  %2f  ==  %252f  ==  %25252f  ==  %25%2f  ==  %c0%af  ==  %ef%bc%8f
"\"  ==  %5c  ==  %255c  ==  %25255c  ==  %25%5c  ==  %c1%9c  ==  %ef%bc%bc
```

Both halves of that table are load-bearing, measured against the reference corpus
(11,536 decomposed entries in which something precedes a separator-initial
target):

| case | entries | without the rule |
| --- | --- | --- |
| literal `/` before `/` | 10,666 | fine either way |
| **encoded** `/`-class before `/` | **524** | regress: `..%2f..%2f/etc/passwd` |
| `\`-class before `/` | **294** | v1 destroyed these: `..\..\..\etc/passwd` |
| no separator before `/` | **52** | v1 destroyed these: `%00etc/passwd` |

Collapse the table to one class and the 294 + 52 break; drop the encoded rows and
the 524 break. The rule recovered **310 of the 708** entries that v1's harvest had
to route to the verbatim passthrough.

**The strip takes exactly one separator.** The preceding slot supplies one, so the
target gives up one; anything beyond that is the author's deliberate choice and
survives. That is what makes the **doubled junction** expressible, and it needs no
schema change — the extra separator rides in the target's own text:

```
target '/etc/passwd'    + '../' x3  ->  ../../../etc/passwd
target '//etc/passwd'   + '../' x3  ->  ../../..//etc/passwd
target '///etc/passwd'  + '../' x3  ->  ../../..///etc/passwd
target '/etc/passwd'    + nothing   ->  /etc/passwd
```

A greedy strip collapses the first three onto one payload, which is why the
doubled junction was unreachable at *any* target spelling and why **251 of the 398
entries** in the verbatim passthrough were the shape `../../..//etc/passwd` — a doubled
junction and nothing else wrong with them. The passthrough is now **147 lines**.

Recovering them took a matching change in the decomposer, and that is the half
worth reading. Its step matcher is greedy too, so `../../..//etc/passwd` parsed as
`../ | ../ | ..//`: a clean repetition that breaks at its last step, which is the
signature that routes an entry to `raw_file` — *before* the round-trip check ever
runs. So the decomposer now hands those trailing separators back to the target
when, and only when, the tail is the established step plus **nothing but
separator tokens** and every step before it is the same step. `..%25%5c` ×12
followed by `..%255c` is a genuinely different token and still goes to `raw_file`;
a chain whose head has period 2 and odd length would reflow into a monolithic
depth-1 primitive and also still goes to `raw_file`.

`never` turns the rule off for a slot. `when_preceded` is v1's rule — strip
whenever anything at all precedes — kept only so a v1 config can be reproduced
byte for byte. It strips one separator too, because two rules that disagree about
what a second separator means would be worse than either.

### The anchor slot

`trailing_dot` and `trailing_space` are positional with respect to the *path*, not
to the payload string: the dot has to land on the target, not after a `%00.png`.
The **anchor slot** is the last **required** slot — the one slot every payload is
guaranteed to contain — so this stays derived from the slot list rather than
hard-coded to a role. When an earlier `base64` has collapsed the slots away, the
stage falls back to the last rewritable segment.

### Four application modes

A stage is `Segment[] -> Segment[]`. How it walks the list is part of its
definition, and all four modes are first-class:

| Mode | Walk | Used by |
| --- | --- | --- |
| `segment` | each rewritable segment independently | `url_encode`, `hex_case_*`, the noise stages, `overlong_utf8`, `fullwidth`, `path_case_upper` |
| `positional` | candidate characters indexed across the whole rewritable view | `selective_*` |
| `run` | each maximal contiguous run collapses into one segment | `base64` |
| `structural` | inserts segments, or extends the anchor slot's | `padding:N`, `trailing_*` |

The modes are not cosmetic. Per-segment is sound only for rewrites that are
homomorphic over concatenation. URL encoding is (`enc(a) + enc(b) == enc(a+b)`),
so it runs per segment. base64 is **not**: `b64(a) + b64(b) != b64(a+b)` whenever
`a`'s byte length is not a multiple of 3, because the `=` padding terminates the
decode and everything after it is silently dropped. And `selective_first` applied
per segment fires once inside *every* segment, producing two encodings instead of
one.

### Per-stage charsets

```
base64                                   Li4vLi4vLi4vZXRjL3Bhc3N3ZA==
base64 > url_encode:1                    Li4vLi4vLi4vZXRjL3Bhc3N3ZA==   <- ./\ finds nothing
base64 > url_encode:1(charset="+/=")     Li4vLi4vLi4vZXRjL3Bhc3N3ZA%3d%3d
```

The base64 alphabet contains none of `.`, `/` or `\` in this blob, so the default
charset has nothing to escape. Carrying the charset per *stage* rather than per
pipeline is what makes a two-ended composition possible:

```yml
- 'url_encode:1(charset="./\\") > base64 > url_encode:1(charset="+/=")'
```

### `transform: false` is per segment

It protects the lines of a *slot*, not the payloads that contain them. A payload
holding a literal suffix still gets its traversal and target rewritten — which is
the entire point:

```
%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd%00.png
|-------- traversal + target rewritten -----|--- literal
```

A per-payload rule would invert the feature: nearly every payload contains a
traversal, so nothing would ever be rewritten.

For a single line rather than a whole slot, use the `!` escape in the file itself.
It is co-located with the content it protects, needs no path resolution, and has
no name to misspell — which is three problems v1's `do_not_transform` list had.

### Output order

1. all `raw_file` entries (verbatim, and unrewritten by definition)
2. then one contiguous block per strategy, **in config order**

Within a block, slots are walked in config order, outermost first. Results
accumulate in insertion order, so runs are deterministic, output files diff
cleanly, and a payload two strategies both emit appears once — at its earliest,
cheapest position. An empty slot member skips the repeat ladder, since `'' × 22`
is still `''`.

### Memory

The generator never reads a payload back after adding it, so the accumulated set
is only ever asked *"have I seen this one?"*. It therefore keeps a 128-bit
fingerprint per payload in a flat `Uint32Array` and streams each freshly-seen
payload straight to the output file through a 256 KB buffer. Peak RSS for the same
default config, measured with `/usr/bin/time -v`:

| payloads | pt v1 | pt v2 |
| --- | --- | --- |
| 185,786 | 353 MB | 164 MB |
| 501,968 | 585 MB | 219 MB |
| 1,220,599 | 1,191 MB | 323 MB |

The slope is the part that matters: v1 grew at ~0.81 KB per payload because it
retained every payload string, copied them into an array and then joined the whole
file into one more string. v2 grows at ~0.15 KB, and 20 bytes of that is the
fingerprint table. (`--dry-run` additionally builds a payloads × slots `Int32Array`
for per-input attribution, which is why that is opt-in.)

---

## `pt add`

Grow a corpus without hand-editing files.

```sh
# append to one slot's file
pt add --config ./pt.yml --slot traversal --value '..%c0%af'

# several slots in one call
pt add --config ./pt.yml --slot target --value /etc/krb5.keytab --slot suffix --value '%00.gif'

# append verbatim to the raw_file
pt add --config ./pt.yml --raw '..%25%5c..%25%5c..%255cboot.ini'

# split a whole payload into slots, falling back to raw_file
pt add --config ./pt.yml --decompose '/var/www/html/../../../etc/shadow%00.png'
```

```
added     traversal  "..%c0%ae%c0%af"  -> ./templates/linux/traversal.txt:25
added     target     "/etc/krb5.keytab"  -> ./templates/linux/target.txt:26
2 lines appended. Re-run 'pt --config ./pt.yml --dry-run' to see what they earn.
```

Three guarantees, because an append-only tool that gets any of them wrong is worse
than editing by hand:

* **Idempotent.** A value already in the file is reported and not written again,
  so re-running a command is free.
  ```
  already present in target  "/etc/krb5.keytab"  (./templates/linux/target.txt)
  nothing written: every value was already present.
  ```
* **Append-only.** Existing lines are never reordered or rewritten, and the comment
  header at the top of every slot file survives untouched. A `diff` against a fresh
  scaffold shows nothing but added lines.
* **Honest about failure.** `--decompose` reassembles its candidate through the
  *real* `assemble` and accepts the split only if it rebuilds the payload byte for
  byte. Anything else goes to `raw_file` with the reason printed:
  ```
  raw       raw_file   "..%25%5c..%25%5c..%25%5c..%255cwin.ini"  -> ./templates/raw.txt:17
             because a clean repetition that breaks at the last step: ..%25%5c | ..%25%5c | ..%25%5c | ..%255c
  ```

`--decompose` fills slots named `prefix`, `traversal`, `target` and `suffix`; a
config without those names gets the payload in `raw_file` and a sentence saying
why. It reuses exactly the decomposer the harvest script uses, so what `pt add`
accepts and what `scripts/harvest-wordlists.ts` accepts cannot drift.

---

## `--dry-run`

Counts without writing, and answers three questions.

**What is each strategy worth?** Two numbers, not one.

```
  strategy                          payloads         new    unique
  plain                               19,425   (+19,425)    18,785
  dot_noise                           19,425   (+18,785)    18,785
  url_encode:1 > hex_case_lower       19,425        (+0)         0   <- every payload also comes from elsewhere
```

`new` is marginal **given everything above it**, so it is order-dependent: move a
strategy up and it earns more. That makes it good for pruning the bottom of the
list and misleading for comparing two in the middle. `unique` is computed against
the union of **all the others**, so it does not depend on order, and it is the
number that answers *"can I delete this?"*. A zero there means yes.

**What is each input LINE worth?** Provenance travels on every segment, so the
same two numbers are available per line of per file:

```
  file:line              value               payloads    unique
  target-encoded.txt:46  /etc/passwd                0         0    <- 'dot_noise' already covers it (from '/etc/passwd')
```

Redundant lines are listed first and in full, with — where pt can name one — the
other route to the same bytes. With nothing redundant, the cheapest few lines from
each slot are shown instead. This is the half that is hard to get any other way:
before it, the only way to find out whether a seed was earning its keep was to
delete it and diff the counts.

**How much of the real world is the generator missing?** The raw ratio, as a
headline rather than a table row:

```
raw ratio  0.15%  -- 147 verbatim entries against 98,964 generated payloads
  147 of them (100.00%) are reachable ONLY verbatim, which is a raw ratio of 0.15% …
```

The second figure used to be `386 of 398 (96.98%)`. It is 100% now, and that is the
non-greedy strip: the entries the passthrough carried for shape reasons alone are
generated, and what is left is irreducible.

`raw_file` bypasses assembly and every strategy. That is correct — real wordlists
contain internally inconsistent lines that cannot be generated — but it makes the
passthrough the escape hatch that proves the generative model is incomplete. pt is
a generator **with a passthrough**, and the passthrough's size relative to the
generated part is the measurement of how much of the real world the model does not
capture.

Bars and colour are drawn only when both stdout and stderr are terminals. Piped —
`2>report.txt`, `| less` — the same numbers come out as plain aligned text.

`limits.warn_above` prints the same report plus a warning on a real run.
`limits.max_payloads` is a hard stop: generation halts, the partial output is
removed, and the error carries the strategy table up to the stop point.

---

## Failure modes

`pt` stops with a single `pt: …` line on stderr and exit status 1 for:

* a config file that is missing, is not valid YAML, or is not a mapping
* an unknown config key, or any value of the wrong type or out of range
* a **removed** v1 key — with the migration spelled out
* a v1 mapping-shaped strategy entry — with the scalar replacement spelled out
* a **renamed** strategy (`noise:dot`, `selective:last`, …) — naming the new name
* an unknown strategy name — with the full catalog and every signature
* a pipeline the stage signatures forbid (`hex_case_upper` alone, `base64 > dot_noise`)
* a bad stage intensity or an unknown stage argument
* an empty `strategies` list, or an empty `slots` list
* a slot with a duplicate, reserved or unusable name
* a required slot with no files, or whose files hold only comments
* a config in which every slot is `optional`
* a strategy override naming a slot that does not exist, or turning a required slot off
* any slot or override file that cannot be read
* `limits.max_payloads` exceeded
* an existing `output_file` while `overwrite_output_file` is `false`
* `--config` and `--generate-basic-config` given together
* `pt add` with mismatched `--slot`/`--value` counts, an unknown slot, a slot with
  no files, or `--raw` with no `raw_file` configured

---

## The harvested corpus (`pt-full.yml`)

Alongside the starter config, the repo ships a **real** one: `pt-full.yml`, built
from 20 public LFI wordlists and verified to cover them.

```sh
bun run scripts/harvest-wordlists.ts    # fetch 20 lists -> templates/<category>/
pt --config ./pt-full.yml --dry-run     # 99,111 payloads
pt --config ./pt-full.yml
bun run scripts/coverage-check.ts       # prove it covers the reference lists
```

[COVERAGE.md](./COVERAGE.md) is the full report: per-source counts, the gap table,
and the two pairs that are still open. The short version is **21,130 of 21,132
`(target, class)` pairs**.

### `scripts/harvest-wordlists.ts`

Downloads each source (cached in `.cache/wordlists/`), decomposes every entry into
`prefix + traversal × repeat + target + suffix`, and writes deduplicated template
files with a source header. Each entry ends up in one of three places, and all
three are counted:

* **decomposed** into the four slots — 34,323 of 34,674;
* **routed verbatim to the passthrough** — 202, every one a traversal that is a
  clean repetition breaking at its last step in a way no `traversal × repeat`
  produces: 96 of the 147 deduplicated lines are a chain whose last step drops
  the `/.` noise the others carry (`.././ | .././ | ../`), 31 a last step whose
  separator run is a different token, and 20 a chain whose head has period 2 and
  odd length;
* **discarded** — 139 corrupt or unparameterisable lines.

Correctness is checked, not asserted: every candidate decomposition is reassembled
by **calling `assemble` itself**, and anything that does not rebuild
byte-identically goes to `raw` instead of into a slot file. No template line is a
guess, and the round-trip check cannot drift from what the generator emits.

Every value then goes through `scripts/categorize.ts`, which puts it in exactly
one of the five stack folders by the two rules in *The workflow* above. The split
is checked rather than asserted: the harvest prints a **dimension accounting**
table comparing each dimension's deduplicated value count against the lines
actually written, and exits non-zero if they disagree — so a classifier change
cannot silently drop or duplicate a line.

```
dimension accounting (deduplicated values vs lines written):
  dimension   expected  written  files
  target      15913     15913     devops/target.txt(843) … windows/target.txt(5961)
  traversal   185       185       language/traversal-java.txt(1) linux(93) windows(91)
  prefix      52        52        devops(7) linux(15) windows(30)
  suffix      12        12        language/suffix.txt(10) windows/suffix.txt(2)
  raw         147       147       linux/raw.txt(52) windows/raw.txt(95)
```

| file | entries | what it is |
| --- | --- | --- |
| `windows/target.txt` | 5,961 | drive-letter and UNC paths, registry hives, IIS, Program Files |
| `linux/target.txt` | 8,476 | the residue: `/etc`, `/proc`, `/var/log`, shells, SSH |
| `devops/target.txt` | 843 | stack components — web/app servers, k8s, docker, IaC, CI/CD, cloud, AI agents |
| `language/target-php.txt` | 444 | `php.ini`, `.htaccess`, wrappers, app configs |
| `language/target-{java,dotnet,perl,python,node,ruby}.txt` | 22 / 14 / 41 / 19 / 20 / 12 | one file per runtime |
| `macos/target.txt` | 61 | `/System`, `/Library`, `/Users`, `/private`, keychains, Homebrew |
| `windows/traversal.txt` / `linux/traversal.txt` | 91 / 93 | harvested primitives, split by separator identity |
| `language/traversal-java.txt` | 1 | `..;/` — the matrix-parameter primitive |
| `windows/prefix.txt` / `linux/prefix.txt` / `devops/prefix.txt` | 30 / 15 / 7 | Win32 device and UNC preludes; POSIX padding and roots; served document roots |
| `language/suffix.txt` / `windows/suffix.txt` | 10 / 2 | null bytes, fake extensions, `?`/`#`/`;` truncators; Win32 dot runs |
| `windows/raw.txt` / `linux/raw.txt` | 95 / 52 | the verbatim passthrough |
| `target-hot.txt` | 873 | targets the corpus pairs with more than a bare path — *derived* |
| `target-encoded.txt` | 94 | targets the corpus writes with a respelled separator — *derived* |
| `target-core.txt` | 39 | the files worth spelling in every encoding |
| `traversal-core.txt` / `-min.txt` | 8 / 2 | what the big files get paired with |
| `target-padding.txt` | 3 | the handful worth padding past a length limit |
| `empty.txt` | 0 | a real empty file, kept for compatibility — `slot=` in an override now says the same thing |

The last six stay at the `templates/` **root** rather than in a folder, because
they are cross-category by construction: `target-core.txt` holds Windows, Linux,
PHP and devops paths at once, and `target-hot.txt` is a measurement over the whole
corpus.

`target-hot.txt` and `target-encoded.txt` are **measurements**, not opinions:
`classesOf()` classifies every reference entry and the files are the targets that
fall out. That is what sizes the config — see §7 of COVERAGE.md.

Two things to know about the layout:

* The **curated** 2026-era sections are routed by the section rather than by the
  classifier, because somebody grouped those lines by technology on purpose and
  splitting one across folders by machine would destroy the only thing it had.
  Each keeps its header and lands in exactly one file. A curated value the harvest
  already found is skipped rather than written twice — 16 of them are.
* `--generate-basic-config` scaffolds the **same paths** with small hand-written
  seeds, so point it at a fresh directory rather than at this repo. (Before the
  split, a `-full` suffix on every harvested file kept the two apart. The harvest
  is now one cached command that restores everything, so a suffix on all seventeen
  files was not worth the noise.) If you do clobber it,
  `bun run scripts/harvest-wordlists.ts` rebuilds from `.cache/wordlists/` without
  touching the network.

### `scripts/coverage-check.ts`

```sh
bun run scripts/coverage-check.ts [--wordlist <path>] [--reference <path>] [--strict]
```

Reduces the reference corpus and a generated wordlist to canonical keys and
reports which keys the reference has that pt does not produce. `--strict` exits 1
on any gap, for CI.

**The canonical key is a pair: `(resolved target, technique class)`.** Both halves
are load-bearing in opposite directions.

*Depth collapses into the target.* `..` in the root directory is the root itself,
so `../../../../../../etc/passwd` and `../../../etc/passwd` are the same request —
`readlink -m /../../../../etc/passwd` is `/etc/passwd`, and Windows clamps
identically. Overshooting is free, so any depth covers any shallower one and depth
must not be in the key. (This is also why `pt-full.yml` ships one repeat rung.)

*Encoding completeness does not collapse, and this is the trap.* A checker that
fully decodes each payload maps every variant onto `/etc/passwd` and then "proves"
total coverage while hiding every real gap. Partial and full encoding are
**siblings**, not a subset relation, because they trip different filter signatures:

| payload | literal `..` | `%2e` | `%2e%2e` | `%2f` |
| --- | --- | --- | --- | --- |
| `../../../etc/passwd` | MATCH | – | – | – |
| `..%2f..%2f..%2fetc%2fpasswd` | MATCH | – | – | MATCH |
| `%2e%2e/%2e%2e/%2e%2e/etc/passwd` | – | YES | YES | – |
| `%2e%2e%2f%2e%2e%2fetc%2fpasswd` | – | YES | YES | MATCH |

Full encoding trips every signature; each partial form trips a strict subset. So
emitting the fully-encoded form does **not** cover a partially-encoded reference
entry. Classification therefore reads literal bytes and never decodes; only the
*target* half of the key is decoded.

Classes are one **primary** spelling (`plain`, `partial-dots`, `partial-sep`,
`full-url`, `double-url`, `triple-url`, `overlong`, `fullwidth`, `percent-u`,
`nested-percent`, `base64`, `absolute-no-traversal`) plus any number of
**orthogonal features** (`backslash`, `noise-dot`, `noise-slash`, `semicolon`,
`null-byte`, `trailing-ext`, `trailing-dot-space`).

The report also prints two things the gap table cannot say:

* **the inverse** — classes pt produces that no reference list contains.
  `triple-url` is the only wholly new one; everywhere else pt is simply wider,
  because a strategy is orthogonal to the target list while a wordlist line is not.
* **how loose `raw_file` is.** The passthrough is the escape hatch that measures
  what the generative model cannot express, but it over-counts: all 147 of its
  entries have every one of their `(target, class)` pairs produced by the
  *generator* too, because `dot_noise` and `selective_first` reach shapes no
  `traversal × repeat` does. (`--dry-run`'s stricter raw ratio counts exact
  payloads rather than pairs, and now says all 147 arrive only verbatim: the 12
  that used to be derivable by exact payload are among the 251 doubled junctions
  the harvest now decomposes, so the passthrough is tighter as well as smaller.)

### What the checker found

Two things worth knowing, both in COVERAGE.md §5:

1. **`partial-dots` has no strategy in the catalog.** `selective_*` only treats
   separators as candidates, so nothing named in the catalog encodes a dot while
   leaving the separator literal. With the pre-encoded primitives in
   the per-category traversal files also removed, `partial-dots` coverage falls from 100% to
   33%. The fix needs no new code — `url_encode:1(charset=".")` is exactly that
   technique, and `pt-full.yml` enables it alongside `url_encode:1(charset="/\\")`.
2. **`selective_last` alone is enough for `partial-sep`.** The family *is* a
   partial-separator family, so pt's default is not short there.

---

## Development

```sh
bun install
bun test              # unit + end-to-end
bun run typecheck     # tsc --noEmit
bun run build         # bundle to dist/pt.js for plain Node
bun run check         # typecheck + test + build + packaged-artifact check
```

`bun run check` runs `scripts/check-package.ts`, which does `npm pack`, installs
the tarball globally into a throwaway prefix with plain npm, and drives the
installed `pt` binary through a real dry-run, a generation and a `pt add`.

### Layout

```
src/core/      pure generator: no Effect, no IO, no Node imports
  segment.ts     Segment model, separator identity, primitive rewrites
  strategy.ts    stage kinds and signatures, the catalog, pipeline parsing
  assemble.ts    slot order, repeat, strip_leading_separator
  generate.ts    the strategy union, dedupe, per-strategy and per-input counts
  store.ts       the fingerprint set that replaces holding the payload list
  lines.ts       input-file line parsing, provenance, the '!' escape
  payloads.ts    decomposition, classification, the clamping resolver
src/config.ts  YAML + schema validation -> a resolved config
src/report.ts  the contribution report, TTY and piped
src/seed.ts    what --generate-basic-config writes: the config and the five folders
src/program.ts the Effect shell: read inputs, generate, stream, report, write
src/cli.ts     effect/cli commands (`pt`, `pt add`) and entry point

scripts/categorize.ts         the five-category classifier, pure
scripts/harvest-wordlists.ts  20 public lists -> templates/<category>/
scripts/coverage-check.ts     (resolved target, technique class) coverage
scripts/check-package.ts      npm pack, global install, drive the real binary

skills/path-traversal/SKILL.md  the recon-first workflow, for an agent
templates/<category>/           the corpus, split by stack dimension
```

The core is dependency-free so it stays testable and portable; the Effect CLI is
a thin shell over it. `src/core/payloads.ts` is shared with both scripts in
`scripts/`, which is what keeps `pt add --decompose` and the harvest in lockstep.

See [NOTES.md](./NOTES.md) for the architecture retrospective — what is now built,
what the retrospective got wrong, and what remains open.

## License

MIT
