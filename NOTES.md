# Architecture retrospective, after v2

The first version of this file was written after the strategy-union refactor and
listed eleven things I would change. This version records what happened when they
were built: nine of the eleven are now in the code, two recommendations turned out
to be wrong in ways worth writing down, and the list of what is still open is
shorter and more specific.

The headline from v1 stands unchanged: the union-not-product decision is correct
and the implementation confirmed it — 185,786 payloads for ten strategies against
~19.2M for the equivalent cross-product, with linear growth.

---

## What v2 built

### §1 Slots replaced the four fixed dimensions — **done**

`prefix` / `traversal` / `target` / `suffix` pretended to be a uniform
cross-product of four things and was not: only `traversal` had a repeat count,
only `target` had no empty member, only `target` got the leading-separator strip,
and three of the four had an `include_payloads_without_*` boolean the fourth could
not have. Four special cases, four branches.

They are now an ordered list of slots, each carrying `name`, `files`, `optional`,
`repeat`, `transform` and `strip_leading_separator`. Three config keys and one
whole validation rule disappeared, and the things v1 could not say at all are
ordinary configs: two traversal positions with different separators, a slot
between target and suffix, more than one suffix position.

The prediction that this would cost something was right, and it was worth paying.
The leading-slash strip stopped being "the target rule" and became a slot
property — which is also what let the separator-identity rule below be expressed
at all.

One thing slots made *better* than expected: `slot=` with nothing after it in a
per-strategy override means "no files", so `templates/empty.txt` — a real empty
file on disk whose entire job was to say "this dimension off" — is no longer
needed.

### §2 `do_not_transform` became a slot property plus a per-line escape — **done**

`transform: false` lives on the slot, and a leading `!` on a line flips that one
line. Gone with it: the path-resolution subtlety (`./templates/x.txt` and
`templates/x.txt` being the same file and different strings), the validation rule
that existed only to catch a misspelled entry, and the action at a distance.

The one part of §2 I did **not** build is the richer-than-boolean protection it
asked for ("literal under encoding, but noise insertion is fine"). `padding:N`
still prepends material to a protected payload and `trailing_dot` still refuses
to extend one, and that judgement is still baked into `strategy.ts`. It is now at
least visible, because it is documented against the stage signatures — but it is
not configurable. See *still open*.

### §3 `role` became the slot's name, and provenance landed — **done**

`Segment.role` is gone; `Segment.slot` is the name the user gave the slot. The one
place that genuinely needed a role — `trailing_dot` has to land on the target, not
after a `%00.png` — is now derived: the **anchor slot** is the last *required*
slot, which is the one slot every payload is guaranteed to contain. Nothing is
hard-coded to the word "target" any more.

Provenance (`Segment.origin = { file, line }`) is the feature v1 called "the
highest-value thing I did not build", and it was. It is what makes the per-input
half of §6 possible at all.

The **separator inventory** v1 also wanted — offsets recorded once at load time so
positional stages are a one-pass lookup — is still not built. It is a performance
idea, not a correctness one, and the profile does not justify it yet.

### §4 Inline stage arguments and real signatures — **done**

Charset moved from the pipeline to the stage: `url_encode:1(charset="./\\") >
base64 > url_encode:1(charset="+/=")` is now expressible, and a charset that
differs from the default becomes part of the stage's *name*, so a report cannot
print two different `url_encode:1` entries as though they were one hypothesis.
(That last part was not in v1's list and turned out to matter: `pt-full.yml` has
two such entries.)

`producesEscapes` is gone. Every stage declares `accepts` and `produces` over
`path | escapes | opaque | text`, with `path`, `escapes` and `opaque` all
subtypes of `text` and nothing else subsuming anything. The parser type-checks the
pipeline against the signatures, so one rule replaced one bespoke check and caught
the latent class v1 predicted:

```
hex_case_upper             escapes required, got path      rejected
base64 > dot_noise         path required, got opaque       rejected   <- v1 ran this
base64 > overlong_utf8     path required, got opaque       rejected   <- and this
base64 > path_case_upper   path required, got opaque       rejected   <- and this
base64 > url_encode:1      text accepts opaque             allowed
```

v1 named `base64 > dot_noise` as the example. Two more fell out of the same rule
for free: `overlong_utf8` and `path_case_upper` were also rewriting base64 blobs.
`path_case_upper` is the worse of the two, because uppercasing a blob corrupts it
silently rather than merely pointlessly.

The lattice needed one thing v1's sketch did not have: a `preserve` output, for
`padding:N` and `trailing_*`, which add material without respelling anything and
therefore hand their input's kind straight through. Without it,
`url_encode:1 > trailing_dot > hex_case_upper` would have been rejected for no
reason.

### §5 `:` means intensity, always — **done**

`dot_noise`, `double_slash`, `backtrack`, `matrix_param`, `selective_first`,
`selective_last`, `selective_alternating`, `hex_case_upper`, `hex_case_lower`,
`path_case_upper`. `url_encode:1|2|3` and `padding:N` kept their colons, because
those genuinely are one technique turned up or down. Every old name produces a
migration error naming its replacement.

v1's list stopped at the `noise:*` and `selective:*` families. `hex_case:upper`
and `path_case:upper` were the same mistake — a case is not an intensity — so they
were renamed too.

### §6 Order-independent contribution, per strategy *and* per input, rendered — **done**

Three things:

**The order-independent column.** `unique` is the number of payloads no other
strategy produces, computed against the union of all the others. v1 proposed "one
extra pass per strategy", which at ten strategies and 185k payloads would have
been ten extra full runs. It is not needed: track, per payload, whether every
producer so far was the same strategy or more than one, and the same number falls
out of the single pass for free. One `Int32Array` of payload count, no extra
traversal.

**Per-input attribution.** With provenance, the same two numbers are available for
every line of every slot file, and the `unique` column is exact: a payload counts
against a line only when *every* combination that produces it uses that line. The
trick is the same collapse — per payload, per slot, store the line id or a
conflict marker. A redundant line also gets a **witness**: the other route to the
same bytes, named.

```
file:line              value               payloads    unique
target-encoded.txt:46  /etc/passwd                0         0   <- 'dot_noise' already covers it (from '/etc/passwd')
```

**Visual output.** Horizontal bars scaled to the `unique` column, so a redundant
line or strategy is obvious without reading numbers. Bars and colour only when
both stdout and stderr are terminals; piped, the same figures come out as plain
aligned text. Status to stderr, payloads to stdout and the output file, as before.

### §7 Memory: fingerprints and streaming — **done, and v1 was wrong about why**

Built as described: the generator keeps a 128-bit fingerprint per payload in a
flat `Uint32Array` and streams each freshly-seen payload to disk through a 256 KB
buffer. The generator's shape did not change — v1 was right that the architecture
already permitted it.

What v1 was wrong about is where the 353 MB went. It attributed the figure to the
in-memory list. Measured, the list is about 20 MB of that:

```
retained heap after generating 185,785 payloads
  collectingStore (v1's behaviour)   44.2 MB
  fingerprintStore + streaming       23.3 MB
```

The other ~300 MB of peak RSS was allocation churn and the GC headroom V8 keeps
for it, plus two one-off copies v1 made at the end: `Array.from(set)` and
`payloads.join("\n")`, the second of which materialises the entire output file as
a single string. Removing the list and the two copies, and trimming the
per-payload allocations in `assemble`, `joinSegments` and the segment stages, gives:

| payloads | v1 peak RSS | v2 peak RSS |
| --- | --- | --- |
| 185,786 | 353 MB | 164 MB |
| 501,968 | 585 MB | 219 MB |
| 1,220,599 | 1,191 MB | 323 MB |

That is 2.2× on the default config and 3.7× at 1.2M payloads — **not** the order
of magnitude v1 promised, because v1 had misdiagnosed the cause. What did change by
roughly an order of magnitude is the **slope**: v1 grew at ~0.81 KB per payload,
v2 at ~0.15 KB, of which 20 bytes is the fingerprint table. Net of the 79 MB that
Node plus the bundle costs before pt does anything, and with V8's nursery capped
so GC headroom is held constant, 1.2M payloads cost 1,002 MB in v1 and 136 MB in
v2 — 7.4×.

The honest summary: holding the payload list was never the expensive part. It was
the *growing* part, and it is gone.

### §8 The raw ratio is a headline — **done**

```
raw ratio  0.15%  -- 147 verbatim entries against 95,337 generated payloads
  147 of them (100.00%) are reachable ONLY verbatim, which is a raw ratio of 0.15%
  against the generated part; the rest some strategy also derives.
```

Two figures rather than one, because the gross count over-states the hole: some
verbatim entries are shapes a strategy reaches anyway. The second number is the
part of the real world the generative model genuinely cannot express.

That block read `0.42% -- 398 entries` and `386 of them (96.98%)` until the
leading-separator strip stopped being greedy. The two figures have now converged,
which is the most useful thing the headline has done: the passthrough is smaller
*and* every line left in it is irreducible, so the gap between the two numbers is
no longer hiding shapes that were merely inexpressible.

### §9 Strategies are always scalar strings — **done, grudgingly, and see below**

The `string | mapping` union is gone from `config.ts`, and so is every consumer's
branch on the entry's type. Charset rides inside the stage. The per-strategy slot
overrides the mapping form also carried now ride after a `|`:

```yml
- "plain | target=./templates/target-full.txt, traversal="
- "padding:2048 | target=./templates/php.txt, traversal.repeat=3"
```

This is the second place v1's recommendation was wrong, and this one is a genuine
regression in config readability. See *what v1 got wrong* below.

### §11 The default no longer warns on a clean first run — **already done**

`limits.warn_above` is 200,000 and the default config generates 185,786.

---

## New in v2, not in v1's list

### The separator-identity strip rule

v1 listed the conditional leading-slash strip under "what I would not change" —
"there is no sane reason to want the other behaviour". That was wrong, and
measurably so. The rule stripped the target's leading separator whenever
*anything* preceded it, but the strip exists only to avoid a **doubled**
separator, and two separators are only doubled when they spell the *same*
separator.

```
../     + /etc/passwd   ->  ../../../etc/passwd       same sep      -> strip
..%2f   + /etc/passwd   ->  ..%2f..%2fetc/passwd      same sep      -> strip
..\     + /etc/passwd   ->  ..\..\..\/etc/passwd      DIFFERENT     -> keep
(none)  + /etc/passwd   ->  /etc/passwd               nothing       -> keep
```

The rule is now `strip_leading_separator: when_same_separator` (the default for
every slot), with a decode-aware equivalence table so the encoded spellings
collapse onto their literal while the two identities stay apart:

```
"/"  ==  %2f  ==  %252f  ==  %25252f  ==  %25%2f  ==  %c0%af  ==  %ef%bc%8f
"\"  ==  %5c  ==  %255c  ==  %25255c  ==  %25%5c  ==  %c1%9c  ==  %ef%bc%bc
```

Both halves of that table earn their place, measured over the 11,536 reference
entries in which something precedes a separator-initial target:

| case | entries | what breaks without it |
| --- | --- | --- |
| literal `/` before `/` | 10,666 | nothing |
| **encoded** `/`-class before `/` | **524** | regress to `..%2f..%2f/etc/passwd` |
| `\`-class before `/` | **294** | v1's output: `..\..\..\etc/passwd` |
| nothing separator-like before `/` | **52** | v1's output: `%00etc/passwd` |

Collapse the table to one class and 346 entries break; drop the encoded rows and
524 break.

The decomposer needed a matching change, and it is the more interesting half. Its
step matcher let a traversal step's separator run absorb whatever separators
followed, so `..\..\..\/etc/passwd` parsed as `..\ | ..\ | ..\/` — a clean
repetition that breaks at its last step, which is exactly the signature that
routes an entry to the verbatim passthrough. With a second parse whose runs stop
at a change of separator identity, the chain is three identical `..\` steps and
the `/` belongs to the target, where the new strip rule keeps it. **310 of the 708
entries that v1 had to route to `raw-full.txt` now decompose**, and the
passthrough fell to 398 lines.

`reassemble` in the decomposer no longer reimplements the strip rule either: it
calls `assemble`. The round-trip self-check and the generator cannot drift.

### The same rule was still wrong about HOW MANY

The section above fixed *which* separators are doubled and left *how many* alone:
the strip looped, removing every equivalent leading separator the target had. So
all three of `/etc/passwd`, `//etc/passwd` and `///etc/passwd` collapsed onto one
payload after a `../`, and the **doubled junction** — a technique in its own right,
against a filter that counts separators or collapses them only after checking —
was unreachable at any target spelling whatsoever. It was the largest single
expressive gap left: **251 of `raw-full.txt`'s 398 lines**, 63% of the passthrough,
were `../../..//etc/passwd` and nothing else wrong with them.

The strip now takes exactly one separator: the preceding slot supplies one, the
target gives up one, and the rest is the author's. No schema change — the extra
separator was always in the target's own text. `when_preceded`, v1's rule, was made
non-greedy too; leaving it greedy would have had the two rules quietly disagreeing
about what a second separator means.

Two things this measured that the plan for it did not predict:

**1. The round-trip self-check was not the thing standing in the way.** The
reasoning was that since the decomposer rebuilds every candidate through the real
`assemble`, a looser `assemble` would make those entries round-trip and they would
decompose on their own. They did not: re-running the harvest produced
byte-identical templates. `breaksAtTail` rejects the chain `../ | ../ | ..//`
*before* any reassembly happens, because the decomposer's step matcher is greedy in
exactly the same way the strip was. A self-check cannot rescue a parse that was
never offered to it. So `reflowTail` now hands trailing separators back to the
target when the tail is the established step plus nothing but separator tokens and
every earlier step is identical — narrow on purpose, so `..%25%5c` ×12 then
`..%255c` (a different token) and a period-2 chain of odd length (which would
reflow into a monolithic depth-1 primitive) both still go to `raw_file`.

**2. The four UNC targets were not standalone.** The risk check said the only
targets with more than one leading separator are UNC paths (`//localhost/C$/…`,
`\\::1\C$\…`) that appear with nothing in front of them, so nothing would be
stripped either way. They are in `target-hot.txt`, which two blocks of
`pt-full.yml` pair with a traversal, so 72 payloads did change shape — and changed
for the better: `../../../localhost/C$/…` had been quietly destroying the `//` that
makes a UNC path a UNC path, and it now survives as `../../..//localhost/C$/…`.
Payload count was identical before and after, and coverage did not move.

Measured, after the change: `raw-full.txt` 398 → **147**, routed-to-raw 459 → 202,
decomposed 34,066 → **34,323**, `target-full.txt` 15,794 → 15,796 (the two new
lines are `//etc/passwd` and `//etc/passwd%00index.html`), `traversal-full.txt`
unchanged at 185 — no new monolithic primitives — and `(target, class)` coverage
unchanged at 21,130 of 21,132.

### `pt add`

A way to grow a corpus without hand-editing files: `--slot`/`--value` pairs,
`--raw`, and `--decompose`, which splits a whole payload across slots. Idempotent,
append-only, comment headers preserved, and `--decompose` accepts a split only
when it rebuilds the payload byte for byte through the real `assemble` — otherwise
the payload goes to `raw_file` with the reason printed.

It reuses the harvest's decomposer rather than a second copy, which is why
`scripts/lib/payloads.ts` moved to `src/core/payloads.ts`. That module was
previously described as "tooling, not product code"; it is product code now, and
being pure made the move a one-line import change.

### Two classes the catalog could not spell, and now can

`COVERAGE.md` §4 recorded two technique classes that fell out of the corpus and
that pt could reach only because `traversal-full.txt` happened to contain
primitives already written that way: **`percent-u`** (`%u2215`, `%u005c` — the
non-standard Microsoft/IIS escape) and **`nested-percent`** (`%%32%66`, `%%35%63` —
a `%` kept literal with the *hex digits* percent-encoded, so `%25` never appears).
A pre-encoded primitive respells its own separator and nothing else; a strategy
respells the separators inside the target too, which is a different payload.

`utf16_escape` and `double_percent` are those two techniques as strategies. 36 of
the passthrough's former 398 lines were in these two classes, 18 each — and all 36
turn out to have been doubled junctions (`..%u2215..%u2215..%u2215/etc/passwd`), so
the non-greedy strip decomposed every one of them into a pre-encoded primitive plus
a `//`-target before these stages were enabled anywhere. The two findings are
genuinely independent: what the stages buy is the *target's* separators respelled
as well, for any target in the file, which no pre-encoded primitive reaches. Both
are `path -> escapes`, like
`overlong_utf8` and `fullwidth`, so `base64 > utf16_escape` was rejected by the
§4 signature system on the day they were written, with no new code in the parser —
which is the most convincing argument for the signatures the lattice has produced
so far: the rule was written for stages that did not exist yet, and it held.

`utf16_escape` carries one argument, `codepoint=`, because U+2044 FRACTION SLASH is
the same hypothesis as U+2215 DIVISION SLASH at a different codepoint. It is in the
stage's *name* when it is not the default, so a report cannot print two of them as
though they were one hypothesis — the §4 property that was not in v1's list and
keeps turning out to matter. Both strategies ship **commented out**: they are
hypotheses worth a line in the catalog, not worth a block of everyone's wordlist.

---

## What v1 got wrong

Three things, all found by building them.

**1. §7's diagnosis.** The 353 MB was not the payload list. See §7 above: the list
was ~20 MB and the rest was allocation churn, GC headroom and two end-of-run
copies. The fix v1 proposed was still the right fix — it removes the part that
*grows* — but the order-of-magnitude claim was arithmetic on a wrong premise, and
the delivered figure on the same config is 2.2×.

**2. §9's conclusion, in practice.** v1 argued that once inline stage arguments
landed, "the mapping form loses most of its purpose and the whole asymmetry can go
away". That is true of `charset` and false of everything else the mapping carried.
Per-strategy slot overrides are not decoration: `pt-full.yml` is almost entirely
made of them, because a 15,794-entry target file must not be inherited by a
strategy that wants three targets. Compressed into a scalar string they become

```yml
- "plain | target=./templates/target-hot.txt, traversal=./templates/traversal-min.txt, suffix=./templates/suffix-full.txt"
```

which is a 124-character line that YAML cannot wrap, cannot comment inside, and
cannot share with an anchor — all three of which the mapping form allowed, and the
last of which `pt-full.yml` actually used: the `&enc` / `*enc` alias for a
two-file target union is now written out verbatim 19 times. The union branching is genuinely gone
from `config.ts` and the parsing code is simpler; the config got worse. v1's own
sentence — "readability of the config wins" — was the right call, and the
conclusion that followed it was not.

If I were choosing again I would keep one scalar-string form *and* allow a mapping
whose only keys are slot overrides, and accept the branch. The branch is four
lines; the readability is every line of `pt-full.yml`.

**3. §10's second bullet.** "The conditional leading-slash strip as a *rule*
rather than a config flag. There is no sane reason to want the other behaviour."
There was: 346 real corpus entries wanted it, and the rule as written destroyed
them. §1 had already quietly contradicted this bullet by making the strip a slot
property, and §1 was right. The rule is still a rule in the sense that matters —
the default is `when_same_separator` and it is a no-op wherever it is not needed —
but it is now stateable, and it had to be, because it was wrong.

---

## What v1 got right and v2 kept

Unchanged, and still load-bearing:

* The segment array surviving until the final join. Every interesting bug in this
  domain comes from flattening too early, and provenance would have been
  impossible without it.
* Per-segment protection rather than per-payload. Per-payload would mean nothing
  is ever rewritten, since almost every payload contains a traversal.
* Run-collapsing base64. The padding-truncation bug is silent and brutal.
* Strategies as the outermost loop, with first-wins dedupe. Deterministic,
  diffable, and the cheapest payloads land first.
* Keeping `src/core/` free of Effect, IO and Node. This is why the strategy tests
  are a table of pure input/output pairs, why the §7 store could be swapped
  without touching the generator, and why moving the decomposer into `core/` was a
  one-line change.
* What the DSL should NOT become: conditionals, loops, user-defined stages. Stage
  arguments and signatures made the grammar richer in exactly the direction that
  keeps each entry one sentence-long hypothesis. They do not let anyone rebuild
  the cross-product by hand, which is still the thing to avoid.

---

## Closed since this list was written

Two entries that were on it, and what closing them cost.

**The doubled junction is expressible.** It was the single largest expressive gap:
251 of `raw-full.txt`'s 398 lines, none of them internally inconsistent. The strip
now takes exactly one separator, and the fix needed no schema change and no new
slot property — the extra separator was always sitting in the target's own text.
What it *did* need was a matching narrowing of the decomposer's greedy step
matcher, which the plan for it had missed; see *The same rule was still wrong about
HOW MANY* above, because the reason the plan missed it is the interesting part.

**`percent-u` and `nested-percent` are in the catalog.** `utf16_escape` and
`double_percent`, both commented out by default. They cost 0 payloads until someone
uncomments them, and they cost the parser nothing at all: the §4 signatures rejected
`base64 > utf16_escape` before either stage existed.

**`COVERAGE.md` is regenerated rather than patched.** It was a v1 measurement run
with a v2 addendum bolted on top, and the patching had started to go wrong rather
than merely stale — the round-trip self-check was credited with catching 16 entries
it catches none of, and the cost of closing the two open pairs, for the one-line
change the text described, was understated 2.8×. It is now one document measured in one run, with the commands that produce
every figure, a dated-artifact caveat that says what it is measured against, and a
closing table of the figures the previous revision got wrong. Two of those
corrections are about counting the template files rather than about pt:
`target-encoded.txt` contains literal NUL bytes, so `grep` without `-a` reports
nothing at all, and `#.png` is a payload, so an `^#` comment filter undercounts
`suffix-full.txt`.

---

## Still open

Smaller and more specific than v1's list.

**0. The passthrough's remaining 147 lines are one more shape, and it is the
mirror image of the one just closed.** 96 of them are a chain whose LAST step drops
the noise the others carry — `.././ | .././ | ../`, where the final `/.` is simply
absent — and 31 are a last step whose separator run is a different token in the
other direction. `reflowTail` hands back separators the tail swallowed; this shape
needs the chain allowed to stop one step EARLY, with `../etc/passwd` as the target.
The remaining 20 are chains whose head has period 2 and odd length, which reflow
into a monolithic depth-1 primitive and should stay in `raw_file` on purpose. So
roughly 127 of 147 look recoverable, by a change of the same kind, and the measured
risk of the last one — 72 payloads changed shape, zero coverage movement — is the
argument for trying it rather than assuming it is safe.

**1. Protection is still a boolean for a question with three answers.** `transform:
false` means "no stage may rewrite these bytes", and the judgements about which
stages *add* rather than rewrite (`padding:N` may, `trailing_dot` may not) are
hard-coded in `strategy.ts`. With stage signatures in place the shape of the fix is
now obvious and was not before: let a slot name the stage *kinds* it admits, e.g.
`transform: [structural]` for "literal under encoding, but prefix padding is
fine". Nobody has asked for it; the hook is ready if they do.

**2. The separator inventory.** Every respelling stage re-scans text for `/` and
`\`, and `selective_*` does it twice. A segment that recorded its separator offsets
once at load time would make positional stages a one-pass lookup. Still a
performance idea with no profile behind it.

**3. The per-input report's `payloads` column is order-dependent and the `unique`
column is not, and the report does not say which lines are *mutually* redundant.**
Two identical lines in one slot both show `unique: 0`, which is correct and
slightly unhelpful: deleting either is free, deleting both is not. Printing the
equivalence classes rather than the individual zeroes would be strictly better.

**4. Attribution costs a `payloads × slots` `Int32Array`.** That is why it is
`--dry-run` only. For the 1.2M-payload configs that §7 now makes practical it is
20 MB, which is affordable; for a 20M-payload config it is not. A sampled or
per-slot-restricted mode would fix it, and nothing needs it yet.

(Item 5, `COVERAGE.md` being a dated v1 record patched by an addendum, is closed —
see *Closed since this list was written* above.)
