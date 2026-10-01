# Coverage report

> **Measured against the pre-split flat template layout.** The corpus has since
> been reorganised into `templates/{linux,windows,macos,language,devops}/`, so the
> `*-full.txt` filenames below name files that no longer exist. The *analysis* is
> unaffected -- nothing was lost or duplicated in the split -- but these figures
> move:
>
> | figure | in this document | after the split |
> | --- | --- | --- |
> | target lines | 15,796 (`target-full.txt`) | **15,913** across 11 files (+117 curated for `macos/` and `language/`) |
> | prefix lines | 42 (`prefix-full.txt`) | **52** (+10 curated) |
> | traversal / suffix / raw | 185 / 12 / 147 | **unchanged**, split by platform |
> | `pt-full.yml` payloads | 95,484 | **99,111** |
> | default config payloads | — | **169,051** (now linux + language + devops) |
> | tests | 310 | **351** |
>
> Coverage itself is unmoved at **21,130 / 21,132** pairs. File-name mapping:
> `target-full.txt` -> `{linux,windows,macos,devops}/target.txt` +
> `language/target-{php,java,python,node,ruby,perl,dotnet}.txt`;
> `traversal-full.txt` -> `{linux,windows}/traversal.txt` +
> `language/traversal-java.txt`; likewise for prefix, suffix and raw.
>
> Regenerate with `bun run scripts/harvest-wordlists.ts && bun run scripts/coverage-check.ts`.

Does `pt-full.yml` semantically cover the public LFI corpus?

**21,130 of 21,132 `(resolved target, technique class)` pairs. Two gaps, both the
same eccentric source line counted under two classes.**

The wordlist is **95,484 payloads**, of which **147 (0.15%)** are the verbatim
passthrough — the measure of how much of the real world the generative model
cannot express.

## What this document is measured against

Every figure below comes from a run on **2026-10-01** against the repository as it
stands: `templates/*-full.txt` as `scripts/harvest-wordlists.ts` writes them,
`pt-full.yml` as it ships, and the 20 cached sources in `.cache/wordlists/`.

Re-running the harvest on that date produced **byte-identical** template files, so
the templates and the sources agree.

This is a dated artifact in one specific sense: the numbers are a function of the
template files and the strategy list, and **any change to either invalidates them**
— a new harvested source, a new curated target, a new or removed strategy entry.
That is not a licence to leave figures wrong. The three commands under *Reproduce
it* regenerate everything in this document in about a minute, and a figure here
that disagrees with them is a bug in this file, not a caveat.

### Reproduce it

```sh
bun run scripts/harvest-wordlists.ts      # fetch + decompose 20 public lists
pt --config ./pt-full.yml --dry-run       # 95,484 payloads
pt --config ./pt-full.yml                 # write wordlist/pt_full_wordlist.txt
bun run scripts/coverage-check.ts         # the coverage table and the gaps
```

`coverage-check.ts` takes `--wordlist`, `--reference`, `--raw` and `--strict`
(which exits 1 on any gap, for CI). The variant configurations in §6 and §7 were
measured by pointing `--wordlist` at a separately generated file.

---

## 1. Sources

Twenty lists from two actively maintained corpora. Every URL is in
`SOURCES` in `scripts/harvest-wordlists.ts`, was fetched, and is cached under
`.cache/wordlists/`.

```
source                                          lines   cmt    dec   raw  drop
LFI-Jhaddix.txt                                   930     0    844     0    86
LFI-LFISuite-pathtotest-huge.txt                 9551     0   9551     0     0
LFI-LFISuite-pathtotest.txt                       569     0    569     0     0
LFI-linux-and-windows_by-1N3@CrowdShield.txt     1156     0   1152     0     4
LFI-etc-files-of-all-linux-packages.txt          8315     0   8315     0     0
LFI-gracefulsecurity-linux.txt                    881     0    877     0     4
Windows-LFI-Payloads_by-adeadfed.txt              215     0    187     4    24
Windows-Paths.txt                                5270     0   5259     0    11
patt-Linux-files.txt                               62     0     62     0     0
patt-Windows-files.txt                            212     0    212     0     0
patt-BSD-files.txt                                 13     0     13     0     0
patt-Mac-files.txt                                  8     0      8     0     0
patt-Web-files.txt                                 14     0     14     0     0
patt-LFI-FD-check.txt                              39     0     39     0     0
patt-LFI-WindowsFileCheck.txt                      69     0     69     0     0
patt-List_Of_File_To_Include.txt                  911     0    909     0     2
patt-Traversal.txt                               4520    10   4370   135     5
patt-directory_traversal.txt                      140     0    130     7     3
patt-deep_traversal.txt                           912     0    884    28     0
patt-traversals-8-deep-exotic-encoding.txt        887     0    859    28     0
TOTAL                                           34674    10  34323   202   139
```

Every line lands in exactly one of four places and all four are counted:
**34,323 decomposed** into the four slots, **202 routed verbatim** to
`raw-full.txt` (147 after deduplication), **139 discarded** as corrupt or
unparameterisable, and **10 comment lines** skipped. Nothing is dropped silently.

Correctness is checked rather than asserted: every candidate decomposition is
reassembled by **calling `assemble` itself**, and anything that does not rebuild
byte-identically is routed to `raw` instead of into a slot file. No template line
is a guess, and the round-trip check cannot drift from what the generator emits.

The `patt-` prefix marks **PayloadsAllTheThings**, the one source beyond SecLists.
It earns its place by adding material SecLists has none of: BSD and macOS targets
(`/usr/pkg/etc/httpd/httpd.conf`, `/Library/WebServer/Documents/`,
`/private/var/log/appstore.log`) and the exotic traversal encodings — of
`traversal-full.txt`'s 185 primitives, **18 carry a `%uXXXX` escape** and **16 a
`%%NN` nested percent**, and all 34 come from this repository.

### Source selection, recorded from the selection pass

The two notes below are about which URLs are in `SOURCES`, not about pt's state.
They were established when the source list was chosen and have **not** been
re-fetched for this run; what is re-verified is only that the list in
`scripts/harvest-wordlists.ts` matches them.

* **`php-filter-iconv.txt` is deliberately excluded.** It is cached (49 lines) and
  absent from `SOURCES`. Its lines are `convert.iconv.CP1390.CSIBM932` filter-chain
  components, not paths, and they cannot stand in any slot.
* **Assetnote has no LFI or traversal list.** Its CDN's 522s are an origin failure
  affecting the whole CDN, including the directory root from Assetnote's own `wget`
  instructions — not a signal about guessed paths. The authoritative index
  (`data/{automated,manual,kiterunner,technologies}.json`, all HTTP 200) lists 74
  files, none matching `lfi|traversal|dotdot|passwd|path.?to|include|dirtrav`.
  Their README confirms the scope: content and subdomain discovery. Nothing was
  substituted for it.

---

## 2. Data quality

```
discarded by reason:
  corrupt:stripped-percent             75
  unusable:placeholder                 38
  corrupt:space-in-token               14
  corrupt:markup                       10
  corrupt:truncated-escape              2
```

* **75 `corrupt:stripped-percent`**, all in `LFI-Jhaddix.txt`.
  `..2f..2f..2fusr2flocal2fapache2flogs2faccess_log` is not a traversal in any
  encoding; it is a filename containing the characters `2f`.
* **14 `corrupt:space-in-token`.** Separating these from real filenames took care:
  3,842 lines of `Windows-Paths.txt` contain a space and almost all are `Program
  Files` or `Documents and Settings`. Three narrow rules do it, each anchored on a
  character that cannot legally neighbour a space — a space next to `_`
  (`access_ log`), a space inside a percent escape (`…%  25%5c..`), and a space
  right after a dot (`access. log%00`).
* **38 `unusable:placeholder`** — `{IPDELHOST}`, `{DOMAIN}`, `{HOST}` and the bare
  `RANDOMDIR` convention.
* **10 `corrupt:markup`** — `=3D`, `&apos;`, smart quotes, U+2026. Publishing
  artefacts, e.g. Jhaddix line 25: `=3D "/.." . "%2f..`.
* **2 `corrupt:truncated-escape`** — lines cut off mid-escape (`…%25%5c..%`).

`{FILE}` is **not** discarded. Those 1,799 lines are traversal templates and are
the richest source of primitives in the corpus; the decomposer takes their
traversal and drops the placeholder rather than filing it as a target. One
consequence is worth stating plainly, because it is visible in the output: a line
that goes to the **passthrough** keeps its placeholder, so **56 of
`raw-full.txt`'s 147 lines contain a literal `{FILE}`** and 56 payloads in the
generated wordlist therefore carry that text. They are in the file for their
traversal shape, and as payloads they are inert.

### The template files

| file | entries | what it is |
| --- | --- | --- |
| `target-full.txt` | 15,796 | every harvested target (15,670) plus 126 curated 2026-era targets in 13 headed sections |
| `target-hot.txt` | 873 | targets the corpus pairs with more than a bare path — *derived* |
| `target-encoded.txt` | 94 | targets the corpus writes with a respelled separator, stored in literal spelling — *derived* |
| `target-core.txt` | 39 | the files worth spelling in every encoding |
| `target-padding.txt` | 3 | what `padding:2048` runs against |
| `traversal-full.txt` | 185 | every harvested primitive, trailing-separator form |
| `traversal-core.txt` / `-min.txt` | 8 / 2 | what the big files get paired with |
| `prefix-full.txt` | 42 | document roots, padding, leading null bytes, Win32 device/UNC preludes |
| `suffix-full.txt` | 12 | null bytes, fake extensions, `?` and `#` truncators |
| `raw-full.txt` | 147 | the verbatim passthrough (§7) |
| `empty.txt` | 0 | a real empty file, kept for compatibility — `slot=` in an override now says the same thing |

Two cautions when counting these yourself, both of which bit this report's own
cross-checks:

* **`target-encoded.txt` is binary to `grep`.** 28 of its 94 lines contain a
  literal NUL byte, so GNU grep classifies the file as data, suppresses output and
  exits 1 — a plain `grep -c` returns *nothing*, not a count. Use `grep -a`.
* **`#.png` is a payload, not a comment.** pt treats `#` as a comment only when it
  is followed by whitespace, by another `#`, or by nothing. A naive `^#` filter
  silently eats that line and reports `suffix-full.txt` as 11 entries. It is 12.

---

## 3. The canonical key

The key is **`(resolved target, technique class)`**. A pair, because the two halves
behave in opposite directions, and getting either one wrong destroys the
measurement.

### Depth collapses into the class

`..` in the root directory is the root itself, so overshooting is free and any
depth covers every shallower one:

```
$ readlink -m /../../../../../../etc/passwd
/etc/passwd
$ readlink -m /var/www/html/../../../../../../etc/passwd
/etc/passwd
```

`resolveClamped()` pops `..` against an empty stack as a no-op — that pop *is* the
clamp. Windows clamps identically. So `../../../etc/passwd` and
`../../../../../../../../etc/passwd` are the same request, depth must not appear in
the key, and `pt-full.yml` ships **one repeat rung** instead of four. This is a
4× saving that costs nothing.

### Encoding completeness does NOT collapse, and this is the trap

A checker that fully decodes each payload maps every variant onto `/etc/passwd`
and then "proves" total coverage while hiding every real gap. Partial and full
encoding are **siblings**, not a subset relation, because they trip different
filter signatures:

| payload | literal `..` | `%2e` | `%2e%2e` | `%2f` |
| --- | --- | --- | --- | --- |
| `../../../etc/passwd` | MATCH | – | – | – |
| `..%2f..%2f..%2fetc%2fpasswd` | MATCH | – | – | MATCH |
| `%2e%2e/%2e%2e/%2e%2e/etc/passwd` | – | YES | YES | – |
| `%2e%2e%2f%2e%2e%2fetc%2fpasswd` | – | YES | YES | MATCH |

Full encoding trips every signature; each partial form trips a strict subset. So
emitting the fully-encoded form does **not** cover a reference entry written in a
partial one. `primaryClass()` therefore inspects literal bytes and never decodes.
Only the *target* half of the key is decoded, by `canonicalTarget()`.

**This is not a theoretical worry — §6 measures it.** Strip the `charset`
strategies and the pre-encoded primitives and `partial-dots` coverage falls to
**0 of 3**. All three of those reference entries resolve to `/boot.ini`,
`/etc/passwd` and `/etc/shadow`, every one of which the same wordlist covers under
`plain`. A checker that decoded before classifying would therefore report all three
as covered, and the `partial-dots` technique — with no coverage whatsoever — would
not appear in its output at all. The non-decoding key is the only reason the gap is
visible.

### The classes

One **primary** spelling, mutually exclusive: `plain`, `partial-dots`,
`partial-sep`, `full-url`, `double-url`, `triple-url`, `overlong`, `fullwidth`,
`percent-u`, `nested-percent`, `base64`, `absolute-no-traversal`.

Plus any number of **orthogonal features**: `backslash`, `noise-dot`,
`noise-slash`, `semicolon`, `null-byte`, `trailing-ext`, `trailing-dot-space`.

---

## 4. Coverage table

```
reference corpus   .cache/wordlists/reference-corpus.txt
                   34664 lines, 34525 usable (corrupt lines skipped)
pt wordlist        wordlist/pt_full_wordlist.txt
                   95484 payloads, of which 147 verbatim from raw_file

canonical key      (resolved target, technique class)
                   depth COLLAPSES into the target -- '..' at '/' is '/'
                   encoding does NOT collapse -- partial and full are siblings

reference pairs     21132
pt pairs            29081
```

| class | ref | covered | gap | pct |
| --- | --- | --- | --- | --- |
| **primary spelling (mutually exclusive)** | | | | |
| `plain` | 283 | 283 | 0 | 100.0% |
| `partial-dots` | 3 | 3 | 0 | 100.0% |
| `partial-sep` | 5 | 5 | 0 | 100.0% |
| `full-url` | 5 | 5 | 0 | 100.0% |
| `double-url` | 7 | 7 | 0 | 100.0% |
| `triple-url` | 0 | 0 | 0 | – |
| `overlong` | 3 | 3 | 0 | 100.0% |
| `fullwidth` | 3 | 3 | 0 | 100.0% |
| `percent-u` | 2 | 2 | 0 | 100.0% |
| `nested-percent` | 4 | 4 | 0 | 100.0% |
| `base64` | 5 | 5 | 0 | 100.0% |
| `absolute-no-traversal` | 14,587 | 14,587 | 0 | 100.0% |
| **orthogonal features** | | | | |
| `backslash` | 5,145 | 5,145 | 0 | 100.0% |
| `noise-dot` | 5 | 5 | 0 | 100.0% |
| `noise-slash` | 13 | 13 | 0 | 100.0% |
| `semicolon` | 2 | 2 | 0 | 100.0% |
| `null-byte` | 324 | 323 | **1** | 99.7% |
| `trailing-ext` | 263 | 262 | **1** | 99.6% |
| `trailing-dot-space` | 473 | 473 | 0 | 100.0% |
| **TOTAL** | **21,132** | **21,130** | **2** | **100.0%** |

The shape of that table is the shape of the corpus: `absolute-no-traversal`
accounts for 14,587 of the 21,132 pairs, and the nine respelling classes together
account for 32. The corpus is overwhelmingly a list of **filenames**, with a thin
layer of encoding tricks on top. That asymmetry is what sizes `pt-full.yml`
(§9).

---

## 5. The two gaps

```
null-byte  (1 of 324 targets uncovered)
    c:/etc/hosts
        reference: C:\WINDOWS\win.ini../../../../../../../../../../../../etc/hosts%00

trailing-ext  (1 of 263 targets uncovered)
    c:/etc/hosts
        reference: C:\WINDOWS\win.ini../../../../../../../../../../../../etc/hosts%00
```

One payload, counted under two classes. Both halves of it are in the templates —
the prefix `C:\WINDOWS\win.ini../` is in `prefix-full.txt` and `%00` is in
`suffix-full.txt` — but **no block crosses the prefix slot with the suffix slot**.
That is a sizing choice, and the price of reversing it was measured two ways:

| change | payloads | coverage |
| --- | --- | --- |
| as shipped | 95,484 | 21,130 / 21,132 |
| add `suffix=suffix-full.txt` to the prefix block | 275,604 | **21,132 / 21,132** |
| add a *separate* prefix × suffix block at `traversal-min` | 154,860 | **21,132 / 21,132** |

So the naive fix is **+180,120 payloads — 2.9× the wordlist** — because it
multiplies the prefix block's full 39-target, 8-rung matrix by 13 suffixes. The
cheap fix is a dedicated block that holds the traversal down to two spellings:
**+59,376, 62% larger**, and it also crosses `warn_above: 250000` only in the
first case. Either way it is one line, and either way it is a lot of wordlist for
one eccentric corpus entry. Left open, documented, measured.

---

## 6. Partial encoding: the hypothesis, tested

The original expectation was that pt would show partial-encoding gaps, on the
grounds that `selective_*` is its only partial-encoding family and only
`selective_last` is enabled by default.

**Refuted as stated, and confirmed in a sharper form.** Three configurations:

| configuration | `partial-dots` | `partial-sep` | payloads |
| --- | --- | --- | --- |
| **A.** `pt-full.yml` as shipped | 3/3 (100%) | 5/5 (100%) | 95,484 |
| **B.** only `selective_last`, no `charset` strategies | 3/3 (100%) | 5/5 (100%) | 91,966 |
| **C.** B, and no pre-encoded traversal primitives | **0/3 (0%)** | 5/5 (100%) | 80,602 |

Configuration B keeps full coverage, so the premise does not hold as written.
Configuration C isolates why, and the answer is more interesting than the
hypothesis.

**`partial-sep` was never at risk, because `selective_*` IS that family.**
`selective_last` produces `../../../etc%2fpasswd` — literal `..` present, `%2f`
present — which is exactly the class. It holds at 5/5 in every configuration, and
it holds even with the passthrough removed as well (80,455 payloads, still 5/5),
so this is the strategy layer and nothing else.

**`partial-dots` had no strategy in the catalog at all.** `selective_*` only
treats separators as candidates — `isCandidate: isSeparator` in
`src/core/strategy.ts` — so nothing in the named catalog encoded a dot while
leaving the separator literal. Configuration C shows the result:

```
partial-dots  (3 of 3 targets uncovered)
    /boot.ini
        reference: /%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/boot.ini
    /etc/passwd
        reference: /%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd
    /etc/shadow
        reference: /%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/shadow
```

**The dimension route was masking a missing strategy.** Runs A and B close that
class only because `%2e%2e/`, `%252e%252e/` and `%c0%ae%c0%ae/` happen to ship as
pre-encoded primitives in `traversal-full.txt` — 11 of the 185 are `partial-dots`.
That is the "slot files supply content, strategies supply spelling" duality doing
real work, but relying on it alone means the class reaches only the targets a
harvested primitive is paired with. In configuration B that is **41 targets**;
with the strategy it is **52**.

**The fix needed no new code,** only the per-stage charset argument, and
`pt-full.yml` ships both halves:

```yml
- 'url_encode:1(charset=".")   | target=…'   # %2e%2e/%2e%2e/etc/passwd
- 'url_encode:1(charset="/\\") | target=…'   # ..%2f..%2fetc%2fpasswd
```

Measured, those two lines raise `partial-dots` from 41 to 52 targets and close the
one `full-url` pair that configuration B misses
(`%2e%2e%2f…%77%69%6e%6e%74%2f…`), an 80% → 100% move in that class as a side
effect. They cost about 1,197 payloads each.

Note that `url_encode:1(charset="/\\")` and `selective_last` are both
`partial-sep` and are **different payloads** — the first encodes every separator,
the second encodes exactly one. Keeping both is the point, and their `unique`
columns (700 and 954) say neither is redundant.

---

## 7. The passthrough: two closures and what is left

`raw_file` bypasses assembly and every strategy. That is correct — real wordlists
contain internally inconsistent lines no generator reaches — but it makes the
passthrough the escape hatch that measures how incomplete the generative model is.
Its size relative to the generated part is the honest number:

```
raw ratio  0.15%  -- 147 verbatim entries against 95,337 generated payloads
  147 of them (100.00%) are reachable ONLY verbatim, which is a raw ratio of
  0.15% against the generated part; the rest some strategy also derives.
```

Those two figures have converged, and that convergence is the most useful thing
the headline has done. They used to read `0.42% -- 398 entries` and `386 of 398
(96.98%)`: the gap between them was lines the passthrough carried for *shape*
reasons alone. There is no such gap now. The passthrough is smaller **and** every
line in it is irreducible.

### Closure 1: the non-greedy leading-separator strip

**The technique.** A **doubled junction** — `../../..//etc/passwd` — is a filter
hypothesis in its own right: the stack either counts separators or collapses runs
of them only *after* checking, so a second separator at the junction survives the
check and is normalised away before the open.

**What was wrong.** `strip_leading_separator` looped, removing *every* equivalent
leading separator the target had. So `/etc/passwd`, `//etc/passwd` and
`///etc/passwd` all collapsed onto one payload after a `../`, and the doubled
junction was unreachable at **any** target spelling whatsoever. It was the largest
single expressive gap in the model: 251 of `raw-full.txt`'s then 398 lines were
that shape and nothing else wrong with them.

**The fix.** The strip now takes **exactly one** separator: the preceding slot
supplies one, the target gives up one, and the rest is the author's. No schema
change was needed — the extra separator was always sitting in the target's own
text, which is why `//etc/passwd` and `//etc/passwd%00index.html` are now ordinary
lines of `target-full.txt`.

It needed a matching narrowing of the **decomposer**, and that is the half worth
reading. Its step matcher is greedy in exactly the same way, so
`../../..//etc/passwd` parsed as `../ | ../ | ..//` — a clean repetition that
breaks at its last step, which is the signature that routes an entry to the
passthrough *before* any round-trip check runs. A self-check cannot rescue a parse
that was never offered to it. `reflowTail` now hands trailing separators back to
the target when the tail is the established step plus nothing but separator
tokens, and every earlier step is identical.

Measured, across the change:

| figure | before | after |
| --- | --- | --- |
| `raw-full.txt` | 398 | **147** |
| entries routed to raw | 459 | **202** |
| decomposed | 34,066 | **34,323** |
| `target-full.txt` | 15,794 | **15,796** |
| `traversal-full.txt` | 185 | 185 (no new monolithic primitives) |
| `(target, class)` coverage | 21,130 / 21,132 | 21,130 / 21,132 (unchanged) |

The two new target lines are the doubled junctions. Coverage did not move, which
is the expected result: the shapes were already *counted* as covered through the
passthrough, and what changed is that the generator now expresses them.

One side effect worth recording because the risk assessment for the change had
missed it: the four UNC targets (`//localhost/C$/…`, `\\::1\C$\…`) are in
`target-hot.txt`, which two blocks pair with a traversal, so 72 payloads changed
shape — for the better. `../../../localhost/C$/…` had been quietly destroying the
`//` that makes a UNC path a UNC path, and it now survives as
`../../..//localhost/C$/…`. Payload count was identical and coverage did not move.

### Closure 2: `utf16_escape` and `double_percent`

Two technique classes fell out of the corpus that the catalog could not spell, and
that pt reached only because `traversal-full.txt` happened to contain primitives
already written that way:

| strategy | mapping | hypothesis |
| --- | --- | --- |
| `utf16_escape` | `/`→`%u2215`, `\`→`%u005c` | the server resolves the non-standard `%uXXXX` form, and the filter has no rule for it at all |
| `utf16_escape(codepoint="2044")` | `/`→`%u2044` | the same bet on U+2044 FRACTION SLASH instead of U+2215 DIVISION SLASH |
| `double_percent` | `/`→`%%32%66`, `\`→`%%35%63` | two decodes happen after the check, and `%25` — the obvious double-encoding signature — never reaches the wire |

`utf16_escape` spells `/` as a **lookalike codepoint** rather than as `/` itself: a
stack that resolves `%uXXXX` at all tends to fold U+2215 and U+2044 onto the ASCII
character, while a filter that only knows `%XY` sees an unparseable sequence. The
codepoint is a stage *argument* rather than a second catalog entry because it is
the same hypothesis at a different codepoint — and because it rides in the stage's
name, a report cannot print two of them as though they were one.

`double_percent` is a double encoding with **no `%25` in it**. It keeps a literal
`%` and percent-encodes the *hex digits* instead: `%32` is `2` and `%66` is `f`, so
one decode of `%%32%66` is the text `%2f` and a second is `/`.

Both are `path -> escapes`, like `overlong_utf8` and `fullwidth`, so
`base64 > utf16_escape` was rejected by the stage-signature system on the day they
were written, with no new code in the parser. That is the strongest argument the
signature lattice has produced: the rule was written for stages that did not exist
yet, and it held.

**Both ship commented out** — in `src/seed.ts`'s starter config, and absent from
`pt-full.yml` entirely. So they contribute **zero** payloads to the numbers in this
report, and the 100% coverage of `percent-u` (2/2) and `nested-percent` (4/4) comes
from the pre-encoded primitives. What the stages buy, measured by enabling all
three entries against `target-core ∪ target-encoded`:

| | as shipped | with the three entries |
| --- | --- | --- |
| payloads | 95,484 | 98,518 (+3,034) |
| `percent-u` targets pt reaches | 41 | **57** |
| `nested-percent` targets pt reaches | 45 | **57** |
| reference coverage | 21,130 / 21,132 | 21,130 / 21,132 |

That is the right shape for the result. A pre-encoded primitive respells its own
separator and nothing else; the stages respell the separators **inside the target**
too, for any target in the file. They are width, not a closed gap — which is why
they are worth a line in the catalog and not a block of everyone's wordlist.

The two findings are independent, and the interaction is worth one sentence: 36 of
the passthrough's former 398 lines were in these two classes, 18 each, and all 36
turned out to be doubled junctions
(`..%u2215..%u2215..%u2215/etc/passwd`). The non-greedy strip decomposed every one
of them into a pre-encoded primitive plus a `//`-target **before** these stages
existed, which is why `raw-full.txt` now contains no `%uXXXX` or `%%NN` line at
all.

### What remains in the passthrough: 147 lines, three shapes

Replaying `decompose()` over the 147 lines: **all 147** are routed by the
*breaks-at-the-last-step* rule, and **none** by the round-trip self-check. The
check is still the guarantee that no slot file holds a guess, but it currently
catches nothing — the parse rules are doing the whole job.

| n | shape | step chain | class |
| --- | --- | --- | --- |
| 24 | A. last step drops the noise the others carry | `.././ \| .././ \| ../` | `plain` |
| 24 | A. | `..\.\ \| ..\.\ \| ..\` | `plain` |
| 24 | A. | `..//.// \| ..//.// \| ..//` | `plain` |
| 24 | A. | `..\\.\\ \| ..\\.\\ \| ..\\` | `plain` |
| 7 | B. last step's separator run is a different token | `..%5c \| ..%5c \| ../` | `partial-sep` |
| 6 | B. | `.././ \| .././ \| ..//` | `plain` |
| 6 | B. | `..\.\ \| ..\.\ \| ..\/` | `plain` |
| 6 | B. | `..//.// \| ..//.// \| ..///` | `plain` |
| 6 | B. | `..\\.\\ \| ..\\.\\ \| ..\\/` | `plain` |
| 8 | C. head of period 2, escalating separator run | `../ \| ..// \| ../ \| ..// \| ..///` | `plain` |
| 8 | C. | `..\ \| ..\\ \| ..\ \| ..\\ \| ..\\\` | `plain` |
| 4 | C. head of period 2, alternating separator identity | `../ \| ..\ \| ../ \| ..\ \| ..\` | `plain` |

Rolled up: **96 shape A, 31 shape B, 20 shape C**, and by primary class **140
`plain`, 7 `partial-sep`** — the seven being the whole of the `..%5c` family. The
orthogonal features are `noise-dot` on 120 of them, `noise-slash` on 88 and
`backslash` on 79.

**Shape A (96) is the exact mirror image of what closure 1 fixed.** `reflowTail`
hands back separators the greedy tail *swallowed*; these need the chain allowed to
stop one step **early**, with the dropped noise moving into the target
(`../etc/passwd`). Four distinct step/tail pairs account for all 96:
`.././ → ../`, `..\.\ → ..\`, `..//.// → ..//`, `..\\.\\ → ..\\`.

**Shape B (31)** is four of the same pairs with a separator *gained* rather than
lost (`.././ → ..//`), plus the seven genuinely-inconsistent `..%5c` then `../`
lines, where a single-encoded separator and a literal one disagree. Those seven are
the canonical case for the passthrough existing at all.

**Shape C (20) should stay.** Each has a head that repeats with period 2 —
`../ | ..// | ../ | ..//`, or `../ | ..\` alternating — so reflowing the tail would
produce a chain of odd length with no proper period, i.e. a monolithic depth-1
primitive that reproduces exactly one string and nothing else. That is the
opposite of generative, and `raw_file` is the honest place for it.

So roughly **127 of 147 look recoverable** by a change of the same kind as closure
1, and the measured risk of that kind of change — 72 payloads changed shape, zero
coverage movement — is the argument for trying it rather than assuming it is safe.

### The passthrough over-counts, and the checker says by how much

```
raw_file entries                                    147
  whose (target, class) pairs the GENERATOR also makes  147  100.0%
  genuinely only reachable verbatim                   0
```

Every one of the 147 has all of its `(target, class)` pairs produced by the
generator as well, because `dot_noise` and `selective_first` reach shapes no
`traversal × repeat` does. The two numbers answer different questions and both are
worth having: by *pair*, `raw-full.txt` adds nothing, and by *exact payload* it
adds 147 strings no strategy emits.

---

## 8. The inverse: what pt adds

| class | pt | ref | verdict |
| --- | --- | --- | --- |
| `triple-url` | 57 | **0** | **NEW — no reference list contains this technique** |
| `semicolon` | 1,240 | 2 | +1,238 targets |
| `noise-slash` | 864 | 13 | +851 |
| `partial-sep` | 783 | 5 | +778 |
| `plain` | 1,044 | 283 | +761 |
| `noise-dot` | 723 | 5 | +718 |
| `absolute-no-traversal` | 15,323 | 14,587 | +736 |
| `backslash` | 5,954 | 5,145 | +809 |
| `trailing-ext` | 870 | 263 | +607 |
| `null-byte` | 891 | 324 | +567 |
| `trailing-dot-space` | 870 | 473 | +397 |
| `base64` | 100 | 5 | +95 |
| `overlong` / `fullwidth` | 57 / 57 | 3 / 3 | +54 each |
| `double-url` | 57 | 7 | +50 |
| `full-url` | 53 | 5 | +48 |
| `partial-dots` | 52 | 3 | +49 |
| `nested-percent` | 45 | 4 | +41 |
| `percent-u` | 41 | 2 | +39 |

`triple-url` is the only class pt produces that no reference list contains at all.
The rest is the generative model doing what a wordlist cannot: the corpus pairs
`overlong` with three targets because somebody typed three lines, while pt pairs it
with 57 because **a strategy is orthogonal to the target list and a wordlist line
is not**.

The larger addition is not in this table. **Zero** hits for `claude`, `codex`,
`cursor`, `copilot`, `aider`, `ollama`, `huggingface`, `openai`, `kube`, `docker`,
`serviceaccount`, `terraform` or `ed25519` across the entire 34,674-line corpus.
`target-full.txt` ends with 126 curated entries in 13 headed sections covering
in-pod Kubernetes service-account tokens, kubeconfigs, Terraform state, cloud CLI
credentials, agent transcripts and RAG stores. Those are not in the coverage table
because the reference corpus has nothing to compare them against — which is the
point of carrying them.

---

## 9. Wordlist size

```
  strategy                                                                  payloads         new    unique
  --------------------------------------------------------------------------------------------------------
  raw_file (verbatim)                                                            147      (+147)       147
  plain | target=target-full.txt, traversal=off                               15,796   (+15,796)    14,899
  plain | target=target-hot.txt                                                7,857    (+6,738)     4,918
  plain | target=target-hot.txt, traversal=traversal-min.txt, suffix=suff…    34,047   (+30,936)    30,936
  plain | traversal=traversal-full.txt                                         7,254    (+7,110)     6,851
  plain | prefix=prefix-full.txt                                              15,093   (+14,725)    14,696
  dot_noise | target=target-core.txt+target-encoded.txt                        1,197      (+983)       963
  double_slash | target=target-core.txt+target-encoded.txt                     1,197      (+952)       951
  backtrack | target=target-core.txt+target-encoded.txt                        1,197      (+988)       988
  matrix_param | target=target-core.txt+target-encoded.txt                     1,197      (+988)       988
  url_encode:1 | target=target-core.txt+target-encoded.txt                     1,197      (+797)       764
  url_encode:1 > hex_case_upper | target=target-core.txt+target-encoded.t…     1,197      (+798)       798
  url_encode:2 | target=target-core.txt+target-encoded.txt                     1,197      (+798)       798
  url_encode:3 | target=target-core.txt+target-encoded.txt                     1,197      (+798)       798
  overlong_utf8 | target=target-core.txt+target-encoded.txt                    1,197    (+1,011)       995
  overlong_utf8(+dots) | target=target-core.txt+target-encoded.txt             1,197    (+1,023)     1,023
  fullwidth | target=target-core.txt+target-encoded.txt                        1,197    (+1,040)     1,040
  path_case_upper | target=target-core.txt+target-encoded.txt                  1,197    (+1,036)     1,036
  url_encode:1(charset=".") | target=target-core.txt+target-encoded.txt        1,197      (+949)       949
  url_encode:1(charset="/\\") | target=target-core.txt+target-encoded.txt      1,197      (+750)       700
  selective_first | target=target-core.txt+target-encoded.txt                  1,197      (+966)       903
  selective_last | target=target-core.txt+target-encoded.txt                   1,197      (+954)       954
  selective_alternating | target=target-core.txt+target-encoded.txt            1,197      (+903)       903
  base64 | target=target-core.txt+target-encoded.txt                           1,197    (+1,014)       672
  base64 > url_encode:1(charset="+/=") | target=target-core.txt+target-en…     1,197      (+697)       697
  trailing_space | target=target-hot.txt, traversal=traversal-min.txt          2,619    (+2,578)     2,578
  padding:2048 | target=target-padding.txt, traversal=traversal-min.txt, …         9        (+9)         9
  total unique                                                                95,484
```

**95,484 payloads**, under `warn_above: 250000` and well under
`max_payloads: 500000`. No tuning was forced, but the shape of the config *is* the
tuning, and every choice in it was made on a measurement:

* **One repeat rung, not four.** Root clamping makes extra rungs redundant (§3).
  `[3,6,10,16]` would have cost 4× for nothing.
* **Big files are never crossed with each other.** `target-full.txt` (15,796) ×
  `traversal-full.txt` (185) is 2.92M **per strategy** before a prefix is
  involved; with `prefix-full.txt` (42) it is 123M. The measurement that licenses
  splitting them is §4's asymmetry: of the 14,610 distinct resolved targets in the
  corpus, 14,587 appear as a bare absolute path and only 578 ever appear as
  anything else, while the nine respelling classes between them ask for 32 pairs.
  So each big file gets exactly one block, paired with small ones.
* **Rewrite strategies run against `target-core.txt ∪ target-encoded.txt`** — 133
  lines, 1,197 payloads each. `target-encoded.txt` is *derived*, not curated: it is
  the targets the corpus itself writes with a respelled separator, computed by
  `classesOf()`, stored in literal spelling so the strategy supplies the encoding
  rather than double-encoding it. Measured: pointing all 21 rewrite blocks at
  `target-hot.txt` instead takes the wordlist to **202,166 payloads**, +106,682 for
  the same pairs.
* **Long padding prefixes dropped.** 16 harvested prefixes over 48 bytes were
  `AAAA…/` and `./././…` length attacks. `padding:N` generates those from one
  integer, so carrying them as literal lines would multiply every payload's length
  for no new coverage.
* **`trailing_dot` is not in the list, on evidence.** Re-measured: added back
  against `target-hot.txt`, it produces 2,619 payloads for `(+0)` new and `0`
  unique. The harvest found a literal `.` suffix in the reference lists, block 3
  already crosses it with every hot target, and an appended dot lands in exactly
  the same place. The technique is covered; the second route to it is not.

The `unique` column is the one that answers "can I delete this?", because it is
computed against the union of all the others and so does not depend on order. No
entry in the list reads 0 there.

---

## 10. Test suite

```
$ bun test
bun test v1.3.14 (0d9b296a)

 310 pass
 0 fail
 826 expect() calls
Ran 310 tests across 10 files. [16.69s]
```

`bun run typecheck` (`tsc --noEmit`) is clean. Re-running
`scripts/harvest-wordlists.ts` produces byte-identical template files, so the
figures in this document and the files in `templates/` cannot be out of step with
each other.

---

## Historical note: figures this revision corrects

This file previously carried a v1 body with a re-measured addendum bolted on top,
and several of its figures had gone stale or were wrong when written. The
comparison is kept only where someone holding the old numbers would otherwise be
misled.

| claim in the previous revision | measured now |
| --- | --- |
| `raw-full.txt` 708, later 398 | **147** |
| routed to raw 805, later 459 | **202** |
| `target-full.txt` 15,772 / 15,794 | **15,796** |
| payloads 93,280 / 95,337 | **95,484** |
| `suffix-full.txt` 12 | 12 — but a naive `^#` filter reports 11, because `#.png` is a payload |
| `target-encoded.txt` 90 / 92 | **94** — and `grep` without `-a` reports *nothing*, because 28 lines hold a literal NUL |
| 16 of the raw entries are round-trip failures | **0**; all 202 are caught by the shape rule before reassembly |
| 19 long prefixes dropped | **16** |
| "50 primitives' worth" of exotic encodings | **34** (18 `%uXXXX`, 16 `%%NN`) |
| closing the two gaps costs **+64,000**, a 69% larger wordlist | **+59,376 (62%)** for a dedicated block, or **+180,120 (2.9×)** for the one-word change to the prefix block |
| configuration C leaves `partial-dots` at **1/3 (33%)** | **0/3 (0%)** — with every primitive not spelled in literal bytes removed, and also with only the dot-respelling ones removed |
| the charset strategies raise `partial-dots` "from 3 to 52 targets" | from **41** to 52; the 3 was the *reference* count, not pt's |
| 14,587 of 14,608 distinct targets appear **only** as bare absolute paths | 14,587 of **14,610** appear as a bare absolute path; **14,032** appear only that way, and 578 ask for more. The same overstatement is still in `pt-full.yml`'s comments. |
| `bun test` → 143 pass, **1 fail** (`warn_above: 150000`) | **310 pass, 0 fail**; that disagreement between seed and test was resolved |

Two things in the previous revision were not merely stale but wrong as written:
the round-trip check was credited with catching 16 entries it does not catch, and
the cost of closing the two gaps was understated for the change the text actually
described. Both are corrected above with the command that produced the new figure.
